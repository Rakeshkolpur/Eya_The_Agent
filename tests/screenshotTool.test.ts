import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserCapture, ScreenshotImage } from '../src/main/browser/BrowserAutomationService';
import { BrowserUnavailableError } from '../src/main/browser/errors';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import { createScreenshotTool } from '../src/main/tools/impl/screenshotTool';
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

function image(over: Partial<ScreenshotImage> = {}): ScreenshotImage {
  return { bytes: fakePng(1280, 720), mime: 'image/png', width: 1280, height: 720, url: 'https://tshc.gov.in/', title: 'High Court for the State of Telangana', environment: 'your_browser', browser: 'chrome', ...over };
}

function tool(capture: BrowserCapture | (() => Promise<ScreenshotImage>), extra: Partial<Parameters<typeof createScreenshotTool>[0]> = {}) {
  const cap: BrowserCapture = typeof capture === 'function' ? { screenshot: capture } : capture;
  return createScreenshotTool({ capture: cap, folders, now: () => WHEN, ...extra });
}

describe('take_screenshot', () => {
  it('saves a new image on the Desktop, named after the site and the time, and says where', async () => {
    const img = image();
    const r = await tool(async () => img).execute({});
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('saved a screenshot to your Desktop as "Screenshot - tshc.gov.in - 2026-10-02 21.05.07.png"');
    expect(r.data).toMatchObject({
      fileName: 'Screenshot - tshc.gov.in - 2026-10-02 21.05.07.png',
      folder: 'Desktop',
      path: join(desktop, 'Screenshot - tshc.gov.in - 2026-10-02 21.05.07.png'),
      bytes: img.bytes.length,
      width: 1280,
      height: 720,
      format: 'PNG',
      browser: 'chrome',
      environment: 'your_browser',
      verified: true,
      page: { url: 'https://tshc.gov.in/', title: 'High Court for the State of Telangana' },
    });
    expect(readdirSync(desktop)).toEqual(['Screenshot - tshc.gov.in - 2026-10-02 21.05.07.png']);
    expect(readFileSync(join(desktop, readdirSync(desktop)[0] as string)).equals(img.bytes)).toBe(true);
  });

  it('never shows the picture to the model: only where it went and how big it is', async () => {
    const img = image({ bytes: fakePng(10, 10, 5000) });
    const r = await tool(async () => img).execute({});
    const everything = JSON.stringify(r);
    expect(everything).not.toContain(img.bytes.toString('base64').slice(0, 40));
    expect(everything).not.toContain('data:image');
    expect(typeof r.data?.['bytes']).toBe('number');
  });

  it('uses the name the user asked for, with the right extension', async () => {
    const r = await tool(async () => image()).execute({ name: 'Cause list 21295' });
    expect(r.ok).toBe(true);
    expect(r.data?.['fileName']).toBe('Cause list 21295.png');
    expect(readdirSync(desktop)).toEqual(['Cause list 21295.png']);
    const again = await tool(async () => image()).execute({ name: 'Cause list 21295.png' });
    expect(again.data?.['fileName']).toBe('Cause list 21295 (2).png');
  });

  it('never overwrites a file that is already there', async () => {
    const existing = join(desktop, 'Screenshot - tshc.gov.in - 2026-10-02 21.05.07.png');
    writeFileSync(existing, 'precious');
    const a = await tool(async () => image()).execute({});
    const b = await tool(async () => image()).execute({});
    expect(a.data?.['fileName']).toBe('Screenshot - tshc.gov.in - 2026-10-02 21.05.07 (2).png');
    expect(b.data?.['fileName']).toBe('Screenshot - tshc.gov.in - 2026-10-02 21.05.07 (3).png');
    expect(readFileSync(existing, 'utf8')).toBe('precious');
  });

  it('refuses a name that tries to leave the Desktop or that Windows would reject', async () => {
    for (const name of ['..\\..\\evil', '../evil', 'C:\\Windows\\x', 'a/b', 'what?', 'con']) {
      const r = await tool(async () => image()).execute({ name });
      expect(r.ok, name).toBe(false);
      expect(r.summary, name).toBe('that name will not work');
    }
    expect(readdirSync(desktop)).toEqual([]);
  });

  it('saves a JPEG with a .jpg extension when that is what the browser sent', async () => {
    const r = await tool(async () => image({ mime: 'image/jpeg' })).execute({});
    expect(r.data?.['fileName']).toMatch(/\.jpg$/);
    expect(r.data?.['format']).toBe('JPEG');
  });

  it('says plainly when the picture is of Eya\'s own separate window, not the user\'s browser', async () => {
    const r = await tool(async () => image({ environment: 'eya_browser' })).execute({});
    expect(r.ok).toBe(true);
    expect(String(r.data?.['note'])).toMatch(/Eya's own separate browser window/);
  });

  it('when no browser is reachable: says why (the same reasons as every browser tool) and saves nothing', async () => {
    const r = await tool(async () => {
      throw new BrowserUnavailableError('The Eya Browser Bridge extension in the user\'s Edge is installed and running, but it is the OLD version.', { why: 'needs_reload', needsPairing: ['edge'] });
    }).execute({});
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('extension needs a reload');
    expect(r.data).toMatchObject({ browserUnavailable: true, why: 'needs_reload' });
    expect(readdirSync(desktop)).toEqual([]);

    const none = await tool(async () => {
      throw new BrowserUnavailableError('None of the user\'s browsers is connected to Eya.', { why: 'not_connected' });
    }).execute({});
    expect(none).toMatchObject({ ok: false, summary: 'browser not connected', data: { why: 'not_connected' } });
  });

  it('passes on a plain reason when the page cannot be captured (a browser page, a private window), saving nothing', async () => {
    const r = await tool(async () => {
      throw new Error('That is a browser page (not a website), and the browser does not let any extension take a picture of it.');
    }).execute({});
    expect(r).toMatchObject({ ok: false, summary: 'could not take the screenshot' });
    expect(r.error).toMatch(/browser page/);
    expect(readdirSync(desktop)).toEqual([]);
  });

  it('does not claim success when the file is not there afterwards', async () => {
    const r = await tool(async () => image(), { verify: async () => ({ verified: false, evidence: 'the file does not exist afterwards' }) }).execute({});
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('the screenshot did not save');
    expect(r.error).toMatch(/Do not tell the user it was saved/);
  });

  it('reports a write failure honestly', async () => {
    const r = await tool(async () => image(), {
      writeNew: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    }).execute({});
    expect(r).toMatchObject({ ok: false, summary: 'could not save the screenshot' });
    expect(r.error).toMatch(/permission denied/);
  });

  it('gives up with a clear message rather than looping when every numbered name is taken', async () => {
    const r = await tool(async () => image(), {
      writeNew: async () => {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      },
    }).execute({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Too many screenshots/);
  });

  it('saves nothing when the Desktop folder it was given is not a usable place', async () => {
    for (const bad of ['', 'relative\path', join(home, '..', 'elsewhere')]) {
      const r = await createScreenshotTool({ capture: { screenshot: async () => image() }, folders: { ...folders, desktop: bad }, now: () => WHEN }).execute({});
      expect(r.ok, bad).toBe(false);
      expect(r.summary, bad).toBe('could not save it there');
    }
    expect(readdirSync(desktop)).toEqual([]);
  });

  it('is described to the model as photographing the page in front, saving to the Desktop, and never showing the picture', () => {
    const t = tool(async () => image());
    expect(t.schema.name).toBe('take_screenshot');
    expect(t.schema.description).toMatch(/Desktop/);
    expect(t.schema.description).toMatch(/does not have to be a page you opened/);
    expect(t.schema.description).toMatch(/do not see the picture/);
    expect(t.schema.args['name']).toBeDefined();
    expect(t.schema.requiresConfirmation).toBeUndefined();
  });
});
