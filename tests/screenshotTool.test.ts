import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserCapture, ScreenshotImage } from '../src/main/browser/BrowserAutomationService';
import { BrowserUnavailableError } from '../src/main/browser/errors';
import { ScreenCaptureError } from '../src/main/screen/screenCapture';
import type { ScreenCapture, ScreenPicture } from '../src/main/screen/screenCapture';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import { createScreenshotTool } from '../src/main/tools/impl/screenshotTool';
import type { ScreenshotToolDeps } from '../src/main/tools/impl/screenshotTool';
import { fakePng } from './screenshotFixtures';

// os.tmpdir() sits under AppData, which the path policy blocks everywhere, so the fake home lives under the repo folder.
let home: string;
let desktop: string;
let folders: KnownFolders;

beforeEach(() => {
  home = mkdtempSync(join(process.cwd(), '.eya-shot-test-'));
  desktop = join(home, 'Desktop');
  mkdirSync(desktop);
  folders = { home, desktop, documents: join(home, 'Documents'), downloads: join(home, 'Downloads'), pictures: join(home, 'Pictures'), videos: join(home, 'Videos'), music: join(home, 'Music'), temp: join(home, 'Temp') };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const WHEN = new Date(2026, 9, 2, 21, 5, 7);

function pageImage(over: Partial<ScreenshotImage> = {}): ScreenshotImage {
  return { bytes: fakePng(1280, 720), mime: 'image/png', width: 1280, height: 720, url: 'https://tshc.gov.in/', title: 'High Court for the State of Telangana', environment: 'your_browser', browser: 'chrome', ...over };
}

function screenPicture(over: Partial<ScreenPicture> = {}): ScreenPicture {
  return { bytes: fakePng(1920, 1080, 300), mime: 'image/png', width: 1920, height: 1080, kind: 'screen', label: '', ...over };
}

interface Spy {
  calls: string[];
  tool: ReturnType<typeof createScreenshotTool>;
}

type RigOptions = {
  page?: () => Promise<ScreenshotImage>;
  screen?: () => Promise<ScreenPicture>;
  window?: (t: string) => Promise<ScreenPicture>;
  omit?: 'page' | 'screen';
} & Partial<Pick<ScreenshotToolDeps, 'writeNew' | 'verify' | 'folders'>>;

/** A tool wired to stand-ins for the screen and the browser page; every capture is logged so "nothing was captured" can be proved. */
function rig(opts: RigOptions = {}): Spy {
  const calls: string[] = [];
  const capture: BrowserCapture = {
    screenshot: async () => {
      calls.push('page');
      return (opts.page ?? (async () => pageImage()))();
    },
  };
  const screen: ScreenCapture = {
    screen: async () => {
      calls.push('screen');
      return (opts.screen ?? (async () => screenPicture()))();
    },
    window: async (title) => {
      calls.push(`window:${title}`);
      return (opts.window ?? (async (t) => screenPicture({ kind: 'window', label: `${t} - Something`, width: 800, height: 600 })))(title);
    },
  };
  const tool = createScreenshotTool({
    ...(opts.omit === 'page' ? {} : { capture }),
    ...(opts.omit === 'screen' ? {} : { screen }),
    folders: opts.folders ?? folders,
    now: () => WHEN,
    ...(opts.writeNew !== undefined ? { writeNew: opts.writeNew } : {}),
    ...(opts.verify !== undefined ? { verify: opts.verify } : {}),
  });
  return { calls, tool };
}

const yes = { confirm: true } as const;

describe('take_screenshot asks before it captures', () => {
  it('a bare request captures NOTHING and hands back the question to ask — in code, not left to a prompt', async () => {
    const { tool, calls } = rig();
    const r = await tool.execute({});
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('needs confirmation');
    expect(calls).toEqual([]);
    expect(readdirSync(desktop)).toEqual([]);
    expect(r.error).toContain("Can I take a screenshot of what's on your screen right now and save it on your Desktop?");
    expect(r.error).toMatch(/call take_screenshot again with the same arguments and confirm: true/);
    expect(r.error).toMatch(/If they say no, do not take it/);
    expect(r.data).toMatchObject({ status: 'permission_required', action: 'take_screenshot', options: ['yes', 'no'] });
  });

  it('the question is about the thing that would be captured', async () => {
    const { tool } = rig();
    expect((await tool.execute({ target: 'window', window: 'Claude' })).error).toContain('Can I take a screenshot of your Claude window and save it on your Desktop?');
    expect((await tool.execute({ target: 'page' })).error).toContain('Can I take a screenshot of the web page you have open and save it on your Desktop?');
    expect((await tool.execute({ window: 'Notepad' })).error).toContain('your Notepad window'); // naming a window means target window
  });

  it('only a real boolean true counts as a yes — not the word, not a number, not a look-alike', async () => {
    for (const confirm of ['yes', 'true', 1, 'confirm', null, false]) {
      const { tool, calls } = rig();
      const r = await tool.execute({ confirm: confirm as never });
      expect(r.summary, String(confirm)).toBe('needs confirmation');
      expect(calls).toEqual([]);
    }
    expect(readdirSync(desktop)).toEqual([]);
  });

  it('once the user has said yes, the same call goes through', async () => {
    const { tool, calls } = rig();
    expect((await tool.execute({})).summary).toBe('needs confirmation');
    const r = await tool.execute(yes);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['screen']);
  });

  it('is told, in its description, to ask first — and when their own words already are the yes', () => {
    const { tool } = rig();
    expect(tool.schema.description).toMatch(/ASKS FIRST/);
    expect(tool.schema.description).toMatch(/confirm: true/);
    expect(tool.schema.description).toMatch(/already says exactly what to capture/);
    expect(tool.schema.description).toMatch(/whatever application they are in/);
    expect(tool.schema.description).toMatch(/never describe what is in it/);
    expect(tool.schema.args['confirm']).toBeDefined();
    expect(tool.schema.args['target']?.enum).toEqual(['screen', 'window', 'page']);
  });
});

describe('what is live on the screen, in any application', () => {
  it('saves the whole screen on the Desktop, named by the time', async () => {
    const pic = screenPicture();
    const { tool, calls } = rig({ screen: async () => pic });
    const r = await tool.execute(yes);
    expect(calls).toEqual(['screen']);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('saved a screenshot to your Desktop as "Screenshot 2026-10-02 21.05.07.png"');
    expect(r.data).toMatchObject({
      fileName: 'Screenshot 2026-10-02 21.05.07.png',
      folder: 'Desktop',
      path: join(desktop, 'Screenshot 2026-10-02 21.05.07.png'),
      bytes: pic.bytes.length,
      width: 1920,
      height: 1080,
      format: 'PNG',
      target: 'screen',
      verified: true,
    });
    expect(readFileSync(join(desktop, 'Screenshot 2026-10-02 21.05.07.png')).equals(pic.bytes)).toBe(true);
  });

  it('is the default when no target is named', async () => {
    const { tool, calls } = rig();
    await tool.execute({ confirm: true });
    await tool.execute({ confirm: true, target: 'screen' });
    expect(calls).toEqual(['screen', 'screen']);
  });

  it('captures one named application window — the Claude app, say — and puts its title in the file name', async () => {
    const { tool, calls } = rig({ window: async () => screenPicture({ kind: 'window', label: 'Claude', width: 1400, height: 900 }) });
    const r = await tool.execute({ confirm: true, target: 'window', window: 'Claude' });
    expect(calls).toEqual(['window:Claude']);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ fileName: 'Screenshot - Claude - 2026-10-02 21.05.07.png', target: 'window', window: 'Claude', width: 1400, height: 900 });
  });

  it('a window title with characters Windows does not allow in a file name still saves, with a safe name', async () => {
    const { tool } = rig({ window: async () => screenPicture({ kind: 'window', label: 'Q3: report <draft>/final?.docx - Word' }) });
    const r = await tool.execute({ confirm: true, window: 'report' });
    expect(r.ok).toBe(true);
    expect(String(r.data?.['fileName'])).toBe('Screenshot - Q3 report draft final .docx - Word - 2026-10-02 21.05.07.png');
    expect(String(r.data?.['fileName'])).not.toMatch(/[<>:"/\\|?*]/);
  });

  it('naming a window without a target means the window; a target window with no name asks which one', async () => {
    const { tool, calls } = rig();
    expect((await tool.execute({ confirm: true, window: 'Notepad' })).data).toMatchObject({ target: 'window' });
    const noName = await tool.execute({ confirm: true, target: 'window' });
    expect(noName.ok).toBe(false);
    expect(noName.summary).toBe('which window?');
    expect(calls).toEqual(['window:Notepad']);
  });

  it('a window that is not there, or cannot be captured, says so plainly and saves nothing', async () => {
    const { tool } = rig({
      window: async () => {
        throw new ScreenCaptureError('No open window has "Zzz" in its title. Ask the user which application they mean.');
      },
    });
    const r = await tool.execute({ confirm: true, window: 'Zzz' });
    expect(r).toMatchObject({ ok: false, summary: 'could not take the screenshot' });
    expect(r.error).toMatch(/Ask the user which application/);
    expect(readdirSync(desktop)).toEqual([]);
  });

  it('when Windows refuses the capture, it passes the reason on and saves nothing', async () => {
    const { tool } = rig({
      screen: async () => {
        throw new Error('Windows would not let Eya capture the screen right now.');
      },
    });
    const r = await tool.execute(yes);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/would not let Eya capture/);
    expect(readdirSync(desktop)).toEqual([]);
  });

  it('never shows the picture to the model: only where it went, what it was, and how big', async () => {
    const pic = screenPicture({ bytes: fakePng(10, 10, 5000) });
    const { tool } = rig({ screen: async () => pic });
    const r = await tool.execute(yes);
    const everything = JSON.stringify(r);
    expect(everything).not.toContain(pic.bytes.toString('base64').slice(0, 40));
    expect(everything).not.toContain('data:image');
    expect(typeof r.data?.['bytes']).toBe('number');
  });

  it('says it is not available when the app has no way to capture the screen, rather than asking a pointless question', async () => {
    const { tool } = rig({ omit: 'screen' });
    const r = await tool.execute({});
    expect(r).toMatchObject({ ok: false, summary: 'not available' });
    expect(r.data).toBeUndefined();
  });
});

describe('the web page in the browser', () => {
  it('target page saves what the browser shows, named after the site, and says which browser', async () => {
    const img = pageImage();
    const { tool, calls } = rig({ page: async () => img });
    const r = await tool.execute({ confirm: true, target: 'page' });
    expect(calls).toEqual(['page']);
    expect(r.summary).toBe('saved a screenshot to your Desktop as "Screenshot - tshc.gov.in - 2026-10-02 21.05.07.png"');
    expect(r.data).toMatchObject({ target: 'page', browser: 'chrome', environment: 'your_browser', page: { url: 'https://tshc.gov.in/', title: 'High Court for the State of Telangana' }, width: 1280, height: 720 });
    expect(readFileSync(join(desktop, readdirSync(desktop)[0] as string)).equals(img.bytes)).toBe(true);
  });

  it('says plainly when the picture is of Eya\'s own separate window, not the user\'s browser', async () => {
    const { tool } = rig({ page: async () => pageImage({ environment: 'eya_browser' }) });
    const r = await tool.execute({ confirm: true, target: 'page' });
    expect(String(r.data?.['note'])).toMatch(/Eya's own separate browser window/);
  });

  it('when no browser is reachable: says why (the same reasons as every browser tool) and saves nothing', async () => {
    const { tool } = rig({
      page: async () => {
        throw new BrowserUnavailableError("The Eya Browser Bridge extension in the user's Edge is installed and running, but it is the OLD version.", { why: 'needs_reload', needsPairing: ['edge'] });
      },
    });
    const r = await tool.execute({ confirm: true, target: 'page' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('extension needs a reload');
    expect(r.data).toMatchObject({ browserUnavailable: true, why: 'needs_reload' });
    expect(readdirSync(desktop)).toEqual([]);
  });

  it('says it is not available when there is no browser connection to take it through', async () => {
    const { tool } = rig({ omit: 'page' });
    const r = await tool.execute({ target: 'page' });
    expect(r).toMatchObject({ ok: false, summary: 'not available' });
    expect(r.error).toMatch(/target screen/);
  });
});

describe('saving, for every kind of screenshot', () => {
  it('uses the name the user asked for, with the right extension', async () => {
    const { tool } = rig();
    const r = await tool.execute({ ...yes, name: 'Cause list 21295' });
    expect(r.data?.['fileName']).toBe('Cause list 21295.png');
    expect(readdirSync(desktop)).toEqual(['Cause list 21295.png']);
    const again = await tool.execute({ ...yes, name: 'Cause list 21295.png' });
    expect(again.data?.['fileName']).toBe('Cause list 21295 (2).png');
  });

  it('never overwrites a file that is already there', async () => {
    const existing = join(desktop, 'Screenshot 2026-10-02 21.05.07.png');
    writeFileSync(existing, 'precious');
    const { tool } = rig();
    const a = await tool.execute(yes);
    const b = await tool.execute(yes);
    expect(a.data?.['fileName']).toBe('Screenshot 2026-10-02 21.05.07 (2).png');
    expect(b.data?.['fileName']).toBe('Screenshot 2026-10-02 21.05.07 (3).png');
    expect(readFileSync(existing, 'utf8')).toBe('precious');
  });

  it('refuses a name that tries to leave the Desktop or that Windows would reject', async () => {
    for (const name of ['..\\..\\evil', '../evil', 'C:\\Windows\\x', 'a/b', 'what?', 'con']) {
      const { tool } = rig();
      const r = await tool.execute({ ...yes, name });
      expect(r.ok, name).toBe(false);
      expect(r.summary, name).toBe('that name will not work');
    }
    expect(readdirSync(desktop)).toEqual([]);
  });

  it('saves a JPEG with a .jpg extension when the browser sent one', async () => {
    const { tool } = rig({ page: async () => pageImage({ mime: 'image/jpeg' }) });
    const r = await tool.execute({ confirm: true, target: 'page' });
    expect(r.data?.['fileName']).toMatch(/\.jpg$/);
    expect(r.data?.['format']).toBe('JPEG');
  });

  it('does not claim success when the file is not there afterwards', async () => {
    const { tool } = rig({ verify: async () => ({ verified: false, evidence: 'the file does not exist afterwards' }) });
    const r = await tool.execute(yes);
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('the screenshot did not save');
    expect(r.error).toMatch(/Do not tell the user it was saved/);
  });

  it('reports a write failure honestly', async () => {
    const { tool } = rig({
      writeNew: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    });
    const r = await tool.execute(yes);
    expect(r).toMatchObject({ ok: false, summary: 'could not save the screenshot' });
    expect(r.error).toMatch(/permission denied/);
  });

  it('gives up with a clear message rather than looping when every numbered name is taken', async () => {
    const { tool } = rig({
      writeNew: async () => {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      },
    });
    const r = await tool.execute(yes);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Too many screenshots/);
  });

  it('saves nothing when the Desktop folder it was given is not a usable place', async () => {
    for (const bad of ['', 'relative\\path', join(home, '..', 'elsewhere')]) {
      const { tool } = rig({ folders: { ...folders, desktop: bad } });
      const r = await tool.execute(yes);
      expect(r.ok, bad).toBe(false);
      expect(r.summary, bad).toBe('could not save it there');
    }
    expect(readdirSync(desktop)).toEqual([]);
  });
});
