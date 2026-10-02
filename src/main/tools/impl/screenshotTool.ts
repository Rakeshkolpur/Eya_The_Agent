import { promises as fs } from 'node:fs';
import type { BrowserCapture } from '@main/browser/BrowserAutomationService';
import { BrowserUnavailableError } from '@main/browser/errors';
import { customScreenshotName, defaultScreenshotName, labelledScreenshotName, withCounter } from '@main/browser/screenshotImage';
import { permissionRequest } from '@main/permissions/PermissionManager';
import { ScreenCaptureError } from '@main/screen/screenCapture';
import type { ScreenCapture } from '@main/screen/screenCapture';
import { checkItemName, resolveChildPath, resolveFolder } from '@main/security/pathPolicy';
import type { KnownFolders } from '@main/security/pathPolicy';
import { verifyFileExists } from '../verify';
import type { Verification } from '../verify';
import type { Tool, ToolArgs, ToolResult } from '../types';
import { unavailable } from './browserTools';

/**
 * "Take a screenshot": a picture of what is live on the user's screen — whatever application they are in, a named
 * application's window, or just the web page in their browser — saved as a new image on their Desktop.
 *
 * It asks first. A screen can show anything (messages, banking, another app's private content), so the tool refuses to
 * capture until it has been called again with confirm: true after the user said yes — enforced here, not left to a prompt.
 *
 * The picture goes straight to a file. It is never shown to the AI model — only where it was saved, which application or
 * page it was, and its size. It never overwrites anything (a taken name gets " (2)"), and the name is checked like any
 * other file name Eya creates.
 */
export interface ScreenshotToolDeps {
  /** The web page open in the user's own browser (through the extension). */
  readonly capture?: BrowserCapture;
  /** The screen, or any application's window. */
  readonly screen?: ScreenCapture;
  readonly folders: KnownFolders;
  /** Creates a NEW file, failing (code EEXIST) if the name is taken. Defaults to a real exclusive write. */
  readonly writeNew?: (path: string, bytes: Buffer) => Promise<void>;
  readonly now?: () => Date;
  readonly verify?: (path: string) => Promise<Verification>;
}

type Target = 'screen' | 'window' | 'page';

interface Picture {
  readonly bytes: Buffer;
  readonly mime: 'image/png' | 'image/jpeg';
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly defaultName: (when: Date) => string;
  /** What to tell the model about what was captured (never the pixels). */
  readonly about: Readonly<Record<string, unknown>>;
}

const MAX_NAME_ATTEMPTS = 50;

async function writeNewFile(path: string, bytes: Buffer): Promise<void> {
  await fs.writeFile(path, bytes, { flag: 'wx' });
}

function fail(summary: string, error: string, data?: Record<string, unknown>): ToolResult {
  return { ok: false, summary, error, ...(data !== undefined ? { data } : {}) };
}

function stringArg(args: ToolArgs, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** What the user is asked, in plain words, before anything is captured. */
function questionFor(target: Target, windowTitle: string | undefined): string {
  if (target === 'window') return `Can I take a screenshot of your ${windowTitle ?? 'application'} window and save it on your Desktop?`;
  if (target === 'page') return 'Can I take a screenshot of the web page you have open and save it on your Desktop?';
  return "Can I take a screenshot of what's on your screen right now and save it on your Desktop?";
}

export function createScreenshotTool(deps: ScreenshotToolDeps): Tool {
  const writeNew = deps.writeNew ?? writeNewFile;
  const verify = deps.verify ?? verifyFileExists;
  const now = deps.now ?? (() => new Date());

  async function take(target: Target, windowTitle: string | undefined): Promise<Picture> {
    if (target === 'page') {
      const image = await (deps.capture as BrowserCapture).screenshot();
      return {
        bytes: image.bytes,
        mime: image.mime,
        width: image.width,
        height: image.height,
        defaultName: (when) => defaultScreenshotName(image.url, when, image.mime),
        about: {
          target: 'page',
          page: { url: image.url, title: image.title },
          ...(image.browser !== undefined ? { browser: image.browser } : {}),
          environment: image.environment,
          capturedPart: 'what was visible in the browser window',
          ...(image.environment === 'eya_browser' ? { note: "This is Eya's own separate browser window, not the user's own browser." } : {}),
        },
      };
    }
    const shot = target === 'window' ? await (deps.screen as ScreenCapture).window(windowTitle ?? '') : await (deps.screen as ScreenCapture).screen();
    return {
      bytes: shot.bytes,
      mime: shot.mime,
      width: shot.width,
      height: shot.height,
      defaultName: (when) => labelledScreenshotName(shot.label, when, shot.mime),
      about:
        shot.kind === 'window'
          ? { target: 'window', window: shot.label, capturedPart: 'that application window' }
          : { target: 'screen', capturedPart: 'everything showing on the screen the user is on' },
    };
  }

  return {
    schema: {
      name: 'take_screenshot',
      status: 'Taking a screenshot…',
      description:
        'Take a screenshot of what is live on the user\'s screen RIGHT NOW and save it as an image on their Desktop — whatever application they are in ' +
        '(a browser, the Claude app, a document, anything), or one named application window, or just the web page in their browser. ' +
        'It ASKS FIRST: the first call captures nothing and hands back a question; ask the user it plainly and only after a clear yes call again with ' +
        'confirm: true. If the user\'s own request already says exactly what to capture ("take a screenshot of Notepad"), that is their yes and you may pass ' +
        'confirm: true straight away; for a bare "take a screenshot", always ask first. target "screen" (the default) is everything showing on the screen ' +
        'they are on; target "window" with window set to part of an application\'s title captures just that application; target "page" is only the web page ' +
        'in their browser. You never see the picture — only where it was saved — so never describe what is in it. Tell the user the file name and that it is on their Desktop.',
      args: {
        target: {
          type: 'string',
          enum: ['screen', 'window', 'page'],
          description: 'screen = everything live on their screen (default); window = one application window named in "window"; page = just the web page in their browser.',
        },
        window: { type: 'string', description: 'For target window: part of the application window\'s title, e.g. "Notepad" or "Claude".' },
        name: {
          type: 'string',
          description: 'A name for the image, without a folder or extension, if the user asked for one. Leave out to use the time (and the window or site name).',
        },
        confirm: { type: 'boolean', description: 'Set true ONLY after the user has clearly said yes to this exact screenshot when asked, or their own request already said exactly what to capture.' },
      },
    },
    async execute(args: ToolArgs): Promise<ToolResult> {
      const windowTitle = stringArg(args, 'window');
      const requested = args['target'];
      const target: Target = requested === 'page' ? 'page' : requested === 'window' || (requested === undefined && windowTitle !== undefined) ? 'window' : 'screen';

      if (target === 'window' && windowTitle === undefined) {
        return fail('which window?', 'Say which application window to capture (part of its title, for example "Notepad"), or ask the user — or use target screen for the whole screen.');
      }
      if (target === 'page' && deps.capture === undefined) return fail('not available', 'Capturing a web page is not available here. Use target screen to capture what is on the screen.');
      if (target !== 'page' && deps.screen === undefined) return fail('not available', 'Capturing the screen is not available here.');

      // Ask first: nothing is captured until the user has said yes.
      if (args['confirm'] !== true) {
        const question = questionFor(target, windowTitle);
        const what = target === 'window' ? (windowTitle as string) : target === 'page' ? 'the open web page' : 'the screen';
        return {
          ok: false,
          summary: 'needs confirmation',
          error:
            `Nothing was captured yet. Ask the user this, plainly: "${question}" Only if they clearly say yes, call take_screenshot again with the same arguments and confirm: true. ` +
            'If they say no, do not take it.',
          data: permissionRequest('take_screenshot', what, `A screenshot can show anything that is on screen, so Eya asks before taking one. ${question}`, ['yes', 'no']),
        };
      }

      let picture: Picture;
      try {
        picture = await take(target, windowTitle);
      } catch (err) {
        if (err instanceof BrowserUnavailableError) return unavailable(err);
        if (err instanceof ScreenCaptureError) return fail('could not take the screenshot', err.message);
        return fail('could not take the screenshot', err instanceof Error ? err.message : String(err));
      }

      const when = now();
      const named = stringArg(args, 'name');
      let baseName: string;
      if (named !== undefined) {
        baseName = customScreenshotName(named, picture.mime);
        const nameCheck = checkItemName(baseName);
        if (!nameCheck.ok) return fail('that name will not work', `A screenshot cannot be called that: ${nameCheck.reason}. Ask the user for a plain name, or leave the name out.`);
      } else {
        baseName = picture.defaultName(when);
      }

      const desktop = resolveFolder('desktop', deps.folders);
      if (desktop === null) return fail('no Desktop', 'Eya could not find the Desktop folder to save the screenshot in.');

      let savedAs: string | null = null;
      let savedPath = '';
      for (let n = 1; n <= MAX_NAME_ATTEMPTS && savedAs === null; n++) {
        const candidate = n === 1 ? baseName : withCounter(baseName, n);
        const location = resolveChildPath(desktop, candidate, deps.folders);
        if (!location.ok) return fail('could not save it there', `The screenshot could not be saved to the Desktop: ${location.reason}.`);
        try {
          await writeNew(location.path, picture.bytes);
          savedAs = candidate;
          savedPath = location.path;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue; // never overwrite: try the next free name
          return fail('could not save the screenshot', `Writing the image to the Desktop failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (savedAs === null) return fail('could not save the screenshot', 'Too many screenshots with that name are already on the Desktop. Ask the user for a different name.');

      const check = await verify(savedPath);
      if (!check.verified) return fail('the screenshot did not save', `The image was written but is not there afterwards (${check.evidence}). Do not tell the user it was saved.`);

      return {
        ok: true,
        summary: `saved a screenshot to your Desktop as "${savedAs}"`,
        data: {
          path: savedPath,
          fileName: savedAs,
          folder: 'Desktop',
          bytes: picture.bytes.length,
          ...(picture.width !== undefined && picture.height !== undefined ? { width: picture.width, height: picture.height } : {}),
          format: picture.mime === 'image/png' ? 'PNG' : 'JPEG',
          ...picture.about,
          verified: true,
        },
      };
    },
  };
}
