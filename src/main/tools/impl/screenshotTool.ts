import { promises as fs } from 'node:fs';
import type { BrowserCapture } from '@main/browser/BrowserAutomationService';
import { BrowserUnavailableError } from '@main/browser/errors';
import { customScreenshotName, defaultScreenshotName, withCounter } from '@main/browser/screenshotImage';
import { checkItemName, resolveChildPath, resolveFolder } from '@main/security/pathPolicy';
import type { KnownFolders } from '@main/security/pathPolicy';
import { verifyFileExists } from '../verify';
import type { Verification } from '../verify';
import type { Tool, ToolArgs, ToolResult } from '../types';
import { unavailable } from './browserTools';

/**
 * "Take a screenshot": a picture of the web page the user is looking at, saved as a new image on their Desktop.
 *
 * The picture goes straight from the browser to a file. It is never shown to the AI model — only where it was saved,
 * the page's address and title, and its size. It never overwrites anything (a taken name gets " (2)"), and the name is
 * checked like any other file name Eya creates.
 */
export interface ScreenshotToolDeps {
  readonly capture: BrowserCapture;
  readonly folders: KnownFolders;
  /** Creates a NEW file, failing (code EEXIST) if the name is taken. Defaults to a real exclusive write. */
  readonly writeNew?: (path: string, bytes: Buffer) => Promise<void>;
  readonly now?: () => Date;
  readonly verify?: (path: string) => Promise<Verification>;
}

const MAX_NAME_ATTEMPTS = 50;

async function writeNewFile(path: string, bytes: Buffer): Promise<void> {
  await fs.writeFile(path, bytes, { flag: 'wx' });
}

function fail(summary: string, error: string, data?: Record<string, unknown>): ToolResult {
  return { ok: false, summary, error, ...(data !== undefined ? { data } : {}) };
}

export function createScreenshotTool(deps: ScreenshotToolDeps): Tool {
  const writeNew = deps.writeNew ?? writeNewFile;
  const verify = deps.verify ?? verifyFileExists;
  const now = deps.now ?? (() => new Date());

  return {
    schema: {
      name: 'take_screenshot',
      status: 'Taking a screenshot…',
      description:
        'Take a screenshot of the web page the user is looking at (the tab in front in their own browser — it does not have to be a page you opened) and ' +
        'save it as an image file on their Desktop. Use it whenever the user asks to take, capture or save a screenshot / picture of a page, ' +
        '"this page" or a site you just opened. It captures what is visible in the browser window right now, not the whole length of a long page: ' +
        'to capture a further part, use scroll_page and then call this again. It needs a web page open in a connected browser; if there is none, the ' +
        'result says why. You do not see the picture — only where it was saved — so never describe what is in it. Tell the user the file name and that it is on their Desktop.',
      args: {
        name: {
          type: 'string',
          description: 'A name for the image, without a folder or extension, if the user asked for one. Leave out to use the site name and the time.',
        },
      },
    },
    async execute(args: ToolArgs): Promise<ToolResult> {
      let image;
      try {
        image = await deps.capture.screenshot();
      } catch (err) {
        if (err instanceof BrowserUnavailableError) return unavailable(err);
        return fail('could not take the screenshot', err instanceof Error ? err.message : String(err));
      }

      const when = now();
      const requested = typeof args['name'] === 'string' && args['name'].trim().length > 0 ? args['name'] : undefined;
      let baseName: string;
      if (requested !== undefined) {
        baseName = customScreenshotName(requested, image.mime);
        const nameCheck = checkItemName(baseName);
        if (!nameCheck.ok) return fail('that name will not work', `A screenshot cannot be called that: ${nameCheck.reason}. Ask the user for a plain name, or leave the name out.`);
      } else {
        baseName = defaultScreenshotName(image.url, when, image.mime);
      }

      const desktop = resolveFolder('desktop', deps.folders);
      if (desktop === null) return fail('no Desktop', 'Eya could not find the Desktop folder to save the screenshot in.');

      let savedAs: string | null = null;
      let savedPath = '';
      for (let n = 1; n <= MAX_NAME_ATTEMPTS && savedAs === null; n++) {
        const candidate = n === 1 ? baseName : withCounter(baseName, n);
        const target = resolveChildPath(desktop, candidate, deps.folders);
        if (!target.ok) return fail('could not save it there', `The screenshot could not be saved to the Desktop: ${target.reason}.`);
        try {
          await writeNew(target.path, image.bytes);
          savedAs = candidate;
          savedPath = target.path;
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
          bytes: image.bytes.length,
          ...(image.width !== undefined && image.height !== undefined ? { width: image.width, height: image.height } : {}),
          format: image.mime === 'image/png' ? 'PNG' : 'JPEG',
          page: { url: image.url, title: image.title },
          ...(image.browser !== undefined ? { browser: image.browser } : {}),
          environment: image.environment,
          capturedPart: 'what was visible in the window',
          verified: true,
          ...(image.environment === 'eya_browser' ? { note: "This is Eya's own separate browser window, not the user's own browser." } : {}),
        },
      };
    },
  };
}
