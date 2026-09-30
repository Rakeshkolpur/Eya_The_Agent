import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOpenTools, parseWebUrl } from '../src/main/tools/impl/openTools';
import type { OpenDeps } from '../src/main/tools/impl/openTools';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import type { Tool } from '../src/main/tools/types';

let home = '';
let folders: KnownFolders;
let openedPaths: string[];
let openedUrls: string[];
let browserLaunches: Array<{ browser: string; url: string }>;
let pathFailure = '';
let browserWorks = true;
let tools: Record<string, Tool>;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'eya-open-'));
  folders = {
    home,
    desktop: join(home, 'Desktop'),
    documents: join(home, 'Documents'),
    downloads: join(home, 'Downloads'),
    pictures: join(home, 'Pictures'),
    videos: join(home, 'Videos'),
    music: join(home, 'Music'),
    temp: join(home, 'AppData', 'Local', 'Temp'),
  };
  await mkdir(folders.downloads, { recursive: true });
  await writeFile(join(folders.downloads, 'letter.pdf'), 'x');
  await writeFile(join(folders.downloads, 'setup.exe'), 'x');
  await writeFile(join(folders.downloads, 'run.ps1'), 'x');
  await writeFile(join(folders.downloads, 'shortcut.lnk'), 'x');

  const deps: OpenDeps = {
    opener: {
      openPath: async (p) => {
        openedPaths.push(p);
        return pathFailure;
      },
      openExternal: async (u) => {
        openedUrls.push(u);
      },
    },
    launchBrowser: async (browser, url) => {
      browserLaunches.push({ browser, url });
      return browserWorks;
    },
  };
  tools = Object.fromEntries(createOpenTools(folders, deps).map((t) => [t.schema.name, t]));
});

beforeEach(() => {
  openedPaths = [];
  openedUrls = [];
  browserLaunches = [];
  pathFailure = '';
  browserWorks = true;
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

const run = (name: string, args: Record<string, string>) => {
  const tool = tools[name];
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.execute(args);
};

describe('open_file', () => {
  it('opens a document', async () => {
    const path = join(folders.downloads, 'letter.pdf');
    const result = await run('open_file', { path });
    expect(result.ok).toBe(true);
    expect(openedPaths).toEqual([path]);
  });

  it('will not run programs or scripts', async () => {
    for (const name of ['setup.exe', 'run.ps1', 'shortcut.lnk']) {
      const result = await run('open_file', { path: join(folders.downloads, name) });
      expect(result.ok, name).toBe(false);
      expect(result.error).toMatch(/confirmation/);
    }
    expect(openedPaths).toEqual([]);
  });

  it('refuses paths outside the user folder and secrets', async () => {
    expect((await run('open_file', { path: 'C:\\Windows\\notepad.exe' })).ok).toBe(false);
    expect((await run('open_file', { path: join(folders.downloads, '.env') })).ok).toBe(false);
    expect(openedPaths).toEqual([]);
  });

  it('reports a missing file, and points folders to open_folder', async () => {
    const missing = await run('open_file', { path: join(folders.downloads, 'ghost.pdf') });
    expect(missing.error).toMatch(/does not exist/);
    const folder = await run('open_file', { path: folders.downloads });
    expect(folder.error).toMatch(/open_folder/);
  });

  it('surfaces a failure from Windows', async () => {
    pathFailure = 'no association';
    expect((await run('open_file', { path: join(folders.downloads, 'letter.pdf') })).ok).toBe(false);
  });

  it('can open a file outside the user folder, as long as it is not a protected location', async () => {
    // Not under the OS tmpdir: on this machine that sits under AppData,
    // which is (correctly) blocked everywhere. A throwaway folder next to
    // the repo stands in for "some other accessible drive" instead.
    const other = join(process.cwd(), 'eya-test-outside-home-tmp');
    await mkdir(other, { recursive: true });
    try {
      const path = join(other, 'movie.mp4');
      await writeFile(path, 'x');
      const result = await run('open_file', { path });
      expect(result.ok).toBe(true);
      expect(openedPaths).toEqual([path]);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe('open_folder', () => {
  it('opens a known folder by name', async () => {
    const result = await run('open_folder', { folder: 'Downloads' });
    expect(result.ok).toBe(true);
    expect(openedPaths).toEqual([folders.downloads]);
  });

  it('rejects unknown names, files and Windows internals', async () => {
    expect((await run('open_folder', { folder: 'the moon' })).ok).toBe(false);
    expect((await run('open_folder', { folder: join(folders.downloads, 'letter.pdf') })).error).toMatch(/not a folder/);
    expect((await run('open_folder', { folder: 'C:\\Windows' })).ok).toBe(false);
    expect(openedPaths).toEqual([]);
  });

  it('can open a folder outside the user folder, as long as it is not a protected location', async () => {
    const other = join(process.cwd(), 'eya-test-outside-home-tmp');
    await mkdir(other, { recursive: true });
    try {
      const result = await run('open_folder', { folder: other });
      expect(result.ok).toBe(true);
      expect(openedPaths).toEqual([other]);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe('open_url', () => {
  it('opens an https page in the default browser', async () => {
    const result = await run('open_url', { url: 'https://www.google.com/search?q=FileQuik' });
    expect(result.ok).toBe(true);
    expect(openedUrls).toEqual(['https://www.google.com/search?q=FileQuik']);
    expect(result.data?.['browser']).toBe('default');
  });

  it('refuses anything that is not an ordinary web address', async () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///C:/Windows/win.ini',
      'ftp://example.com/x',
      'https://user:pass@example.com/',
      'not a url',
      `https://example.com/${'a'.repeat(3000)}`,
    ]) {
      const result = await run('open_url', { url });
      expect(result.ok, url.slice(0, 30)).toBe(false);
    }
    expect(openedUrls).toEqual([]);
    expect(browserLaunches).toEqual([]);
  });

  it('uses the named browser when it can be found', async () => {
    const result = await run('open_url', { url: 'https://example.com/', browser: 'chrome' });
    expect(result.ok).toBe(true);
    expect(browserLaunches).toEqual([{ browser: 'chrome', url: 'https://example.com/' }]);
    expect(openedUrls).toEqual([]);
    expect(result.data?.['browser']).toBe('chrome');
  });

  it('falls back to the default browser when the named one is missing', async () => {
    browserWorks = false;
    const result = await run('open_url', { url: 'https://example.com/', browser: 'firefox' });
    expect(result.ok).toBe(true);
    expect(openedUrls).toEqual(['https://example.com/']);
    expect(result.data?.['browser']).toBe('default');
    // The reply must not claim Firefox was used.
    expect(result.data?.['note']).toMatch(/firefox is not installed/);
  });

  it('adds no note when the default browser was asked for', async () => {
    const result = await run('open_url', { url: 'https://example.com/' });
    expect(result.data).not.toHaveProperty('note');
  });
});

describe('parseWebUrl', () => {
  it('normalizes valid URLs and rejects the rest', () => {
    expect(parseWebUrl('https://Example.com/a b')?.href).toBe('https://example.com/a%20b');
    expect(parseWebUrl('http://localhost:3000')?.protocol).toBe('http:');
    expect(parseWebUrl('data:text/html,hi')).toBeNull();
  });
});
