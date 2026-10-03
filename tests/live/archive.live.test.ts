/**
 * Live test of zip_folder with real Windows PowerShell and a real folder: nested files, a name with an apostrophe and a
 * dollar sign, and non-Latin file names. Opt-in: EYA_LIVE_WINDOWS=1 npx vitest run tests/live/archive.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchiveTools } from '../../src/main/tools/impl/archiveTools';
import type { KnownFolders } from '../../src/main/security/pathPolicy';
import type { Tool } from '../../src/main/tools/types';

const live = process.env['EYA_LIVE_WINDOWS'] === '1' && process.platform === 'win32';

describe.skipIf(!live)('zip_folder: a real folder, zipped by Windows, read back', () => {
  let root = '';
  let folders: KnownFolders;
  let tool: Tool;
  const src = () => join(root, "Hello 2's $copy");

  beforeAll(() => {
    // The folder must sit under the user's home to be allowed; use a throw-away folder inside it.
    const home = process.env['USERPROFILE'] ?? '';
    root = mkdtempSync(join(home, 'eya-zip-live-'));
    folders = { home, downloads: join(home, 'Downloads'), desktop: join(home, 'Desktop'), documents: join(home, 'Documents'), pictures: join(home, 'Pictures'), videos: join(home, 'Videos'), music: join(home, 'Music'), temp: join(root, 'temp') };
    mkdirSync(join(src(), 'sub folder'), { recursive: true });
    writeFileSync(join(src(), 'a.txt'), 'alpha');
    writeFileSync(join(src(), 'sub folder', 'b.txt'), 'beta beta');
    writeFileSync(join(src(), 'రిపోర్ట్.txt'), 'telugu name');
    writeFileSync(join(src(), 'sub folder', 'big.bin'), Buffer.alloc(200_000, 7));
    tool = createArchiveTools(folders).find((x) => x.schema.name === 'zip_folder') as Tool;
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('zips, verifies the count, and the zip really unpacks to the same files', async () => {
    const r = await tool.execute({ path: src() });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.data).toMatchObject({ files: 4, verified: true });
    const zip = r.data?.['path'] as string;
    expect(existsSync(zip)).toBe(true);
    expect(statSync(zip).size).toBe(r.data?.['sizeBytes']);

    const out = join(root, 'unpacked');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${out}' -Force`]);
    const inner = join(out, "Hello 2's $copy");
    expect(readFileSync(join(inner, 'a.txt'), 'utf8')).toBe('alpha');
    expect(readFileSync(join(inner, 'sub folder', 'b.txt'), 'utf8')).toBe('beta beta');
    expect(readFileSync(join(inner, 'రిపోర్ట్.txt'), 'utf8')).toBe('telugu name');
    expect(statSync(join(inner, 'sub folder', 'big.bin')).size).toBe(200_000);
  }, 120_000);

  it('the original folder is untouched, and a second zip does not overwrite the first', async () => {
    expect(readFileSync(join(src(), 'a.txt'), 'utf8')).toBe('alpha');
    const second = await tool.execute({ path: src() });
    expect(second.ok).toBe(true);
    expect(String(second.data?.['name'])).toMatch(/\(2\)\.zip$/);
  }, 120_000);

  it('find_folder finds a real folder by the words in its name, a level down, with the real file system', async () => {
    const finder = createArchiveTools(folders).find((x) => x.schema.name === 'find_folder') as Tool;
    const r = await finder.execute({ query: 'sub folder', location: src() });
    expect((r.data?.['folders'] as Array<{ path: string }>).map((f) => f.path)).toEqual([join(src(), 'sub folder')]);
    const home = await finder.execute({ query: 'eya-zip-live', location: 'home' });
    expect((home.data?.['folders'] as Array<{ path: string }>).some((f) => f.path === root)).toBe(true);
    expect((await finder.execute({ query: 'definitely not here', location: root })).data?.['folders']).toEqual([]);
  }, 60_000);

  it('says so for a file or a missing folder, and refuses a folder with a secrets file in it', async () => {
    expect((await tool.execute({ path: join(src(), 'a.txt') })).summary).toBe('not a folder');
    expect((await tool.execute({ path: join(root, 'nope') })).summary).toBe('not a folder');
    const risky = join(root, 'risky');
    mkdirSync(risky);
    writeFileSync(join(risky, '.env'), 'KEY=1');
    writeFileSync(join(risky, 'ok.txt'), 'ok');
    expect((await tool.execute({ path: risky })).summary).toBe('holds protected files');
  }, 120_000);
});
