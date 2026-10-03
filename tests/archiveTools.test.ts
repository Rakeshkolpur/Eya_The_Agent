import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { createArchiveTools, firstProtected, listFolderScript, parseFolderListing, parseZipResult, zipScript } from '../src/main/tools/impl/archiveTools';
import type { ArchiveDeps, FolderListing } from '../src/main/tools/impl/archiveTools';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import type { Tool } from '../src/main/tools/types';

const HOME = 'C:\\Users\\Test';
const folders: KnownFolders = {
  home: HOME,
  downloads: `${HOME}\\Downloads`,
  desktop: `${HOME}\\Desktop`,
  documents: `${HOME}\\Documents`,
  pictures: `${HOME}\\Pictures`,
  videos: `${HOME}\\Videos`,
  music: `${HOME}\\Music`,
  temp: `${HOME}\\AppData\\Local\\Temp`,
};

function rig(listing: FolderListing | null, over: Partial<ArchiveDeps> = {}) {
  const log: string[] = [];
  const taken = new Set<string>();
  const deps: ArchiveDeps = {
    readEntries: async () => null,
    listFolder: async (f) => (log.push(`list:${f}`), listing),
    zip: async (f, d) => (log.push(`zip:${f}->${d}`), { entries: listing?.count ?? 0, bytes: 5000 }),
    exists: async (p) => taken.has(p),
    remove: async (p) => void log.push(`remove:${p}`),
    ...over,
  };
  const tool = createArchiveTools(folders, deps).find((x) => x.schema.name === 'zip_folder') as Tool;
  return { tool, log, taken };
}

const FOLDER = `${HOME}\\Desktop\\Hello 2`;
const two: FolderListing = { count: 2, bytes: 2048, files: ['a.txt', 'notes\\b.txt'] };

describe('zip_folder', () => {
  it('makes a .zip copy in the temp folder, checks every file went in, and reports its path — the folder is untouched', async () => {
    const { tool, log } = rig(two);
    const r = await tool.execute({ path: FOLDER });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ name: 'Hello 2.zip', files: 2, sizeBytes: 5000, verified: true });
    expect(r.data?.['path']).toBe(`${HOME}\\AppData\\Local\\Temp\\Eya-send\\Hello 2.zip`);
    expect(String(r.data?.['note'])).toMatch(/COPY.*untouched/);
    expect(log).toEqual([`list:${FOLDER}`, `zip:${FOLDER}->${HOME}\\AppData\\Local\\Temp\\Eya-send\\Hello 2.zip`]);
    expect(log.some((l) => l.startsWith('remove:'))).toBe(false);
  });

  it('never overwrites an earlier zip: it takes the next free name', async () => {
    const { tool, taken } = rig(two);
    taken.add(`${HOME}\\AppData\\Local\\Temp\\Eya-send\\Hello 2.zip`);
    taken.add(`${HOME}\\AppData\\Local\\Temp\\Eya-send\\Hello 2 (2).zip`);
    const r = await tool.execute({ path: FOLDER });
    expect(r.data?.['name']).toBe('Hello 2 (3).zip');
  });

  it('refuses something that is not a folder, an empty folder, and one too big', async () => {
    expect((await rig(null).tool.execute({ path: FOLDER })).summary).toBe('not a folder');
    expect((await rig({ count: 0, bytes: 0, files: [] }).tool.execute({ path: FOLDER })).summary).toBe('empty folder');
    const big = await rig({ count: 3, bytes: 300 * 1024 * 1024, files: ['x'] }).tool.execute({ path: FOLDER });
    expect(big.summary).toBe('too big');
  });

  it('refuses a folder holding keys or secrets, naming the first one, and zips nothing', async () => {
    const r = rig({ count: 3, bytes: 100, files: ['ok.txt', 'keys\\id_rsa', '.env'] });
    const out = await r.tool.execute({ path: FOLDER });
    expect(out.ok).toBe(false);
    expect(out.summary).toBe('holds protected files');
    expect(out.error).toContain('id_rsa');
    expect(r.log.some((l) => l.startsWith('zip:'))).toBe(false);
    expect(firstProtected(['.ssh\\config'])).toBe('.ssh\\config');
    expect(firstProtected(['docs\\secrets.json', 'a.txt'])).toBe('docs\\secrets.json');
    expect(firstProtected(['a.txt', 'b\\c.pdf'])).toBeNull();
  });

  it('refuses protected locations before even looking inside', async () => {
    const { tool, log } = rig(two);
    for (const path of [`${HOME}\\.ssh`, `${HOME}\\AppData\\Roaming`, 'C:\\Windows\\System32', 'C:\\Users\\Someone Else\\Documents']) {
      const r = await tool.execute({ path });
      expect(r.ok, path).toBe(false);
      expect(r.summary, path).toBe('not allowed');
    }
    expect(log).toEqual([]);
  });

  it('throws away a zip that is missing files rather than send part of a folder', async () => {
    const r = rig(two, { zip: async () => ({ entries: 1, bytes: 100 }) });
    const out = await r.tool.execute({ path: FOLDER });
    expect(out.ok).toBe(false);
    expect(out.summary).toBe('the zip is incomplete');
    expect(r.log.some((l) => l.startsWith('remove:'))).toBe(true);
  });

  it('throws away a zip that comes out too big for a chat app', async () => {
    const r = rig(two, { zip: async () => ({ entries: 2, bytes: 150 * 1024 * 1024 }) });
    const out = await r.tool.execute({ path: FOLDER });
    expect(out.summary).toBe('too big');
    expect(r.log.some((l) => l.startsWith('remove:'))).toBe(true);
  });

  it('reports a failure plainly instead of crashing', async () => {
    const r = rig(two, { zip: async () => Promise.reject(new Error('disk full')) });
    const out = await r.tool.execute({ path: FOLDER });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('disk full');
  });

  it('needs a path', async () => {
    expect((await rig(two).tool.execute({})).ok).toBe(false);
  });
});

describe('the PowerShell it runs', () => {
  it('quotes a path safely (an apostrophe or a dollar sign cannot become code)', () => {
    const script = zipScript("C:\\Users\\Test\\Desktop\\Rahul's $(calc) folder", "C:\\Temp\\Rahul's.zip");
    expect(script).toContain("'C:\\Users\\Test\\Desktop\\Rahul''s $(calc) folder'");
    expect(script).toContain("'C:\\Temp\\Rahul''s.zip'");
    expect(listFolderScript("C:\\a'b")).toContain("'C:\\a''b'");
  });

  it('reads the listing and the zip result it prints', () => {
    expect(parseFolderListing('COUNT=2\r\nBYTES=2048\r\na.txt\r\nnotes\\b.txt\r\n')).toEqual({ count: 2, bytes: 2048, files: ['a.txt', 'notes\\b.txt'] });
    expect(parseFolderListing('NOTFOLDER\r\n')).toBeNull();
    expect(parseFolderListing('garbage')).toBeNull();
    expect(parseZipResult('ZIP entries=3 bytes=1234\r\n')).toEqual({ entries: 3, bytes: 1234 });
    expect(parseZipResult('nothing')).toBeNull();
  });
});

describe('find_folder: a folder by its name', () => {
  const at = (...parts: string[]) => join(...parts);
  // A pretend disk: folder -> its entries.
  const tree: Record<string, Array<{ name: string; isDirectory: boolean }>> = {
    [folders.desktop]: [
      { name: 'Hello 2', isDirectory: true },
      { name: 'Hello 2 backup', isDirectory: true },
      { name: 'notes.txt', isDirectory: false },
      { name: 'node_modules', isDirectory: true },
      { name: '.hidden', isDirectory: true },
    ],
    [at(folders.desktop, 'Hello 2')]: [{ name: 'inner', isDirectory: true }],
    [folders.documents]: [{ name: 'Projects', isDirectory: true }, { name: 'AppData', isDirectory: true }],
    [at(folders.documents, 'Projects')]: [{ name: 'Hello 2', isDirectory: true }, { name: 'Taxes 2024', isDirectory: true }],
    [folders.downloads]: [],
    [folders.pictures]: [{ name: 'Holiday Photos', isDirectory: true }],
    [folders.videos]: [],
    [folders.music]: [],
  };
  const tool = (): Tool =>
    createArchiveTools(folders, {
      readEntries: async (f) => tree[f] ?? null,
      listFolder: async () => null,
      zip: async () => ({ entries: 0, bytes: 0 }),
      exists: async () => false,
      remove: async () => undefined,
    }).find((x) => x.schema.name === 'find_folder') as Tool;

  it('finds it where the user said, and puts the exact name first', async () => {
    const r = await tool().execute({ query: 'hello 2', location: 'desktop' });
    expect(r.ok).toBe(true);
    const found = r.data?.['folders'] as Array<{ name: string; path: string }>;
    expect(found.map((f) => f.name)).toEqual(['Hello 2', 'Hello 2 backup']);
    expect(found[0]?.path).toBe(at(folders.desktop, 'Hello 2'));
  });

  it('with no place named, looks in the usual ones and returns every match — it is for the user to choose', async () => {
    const r = await tool().execute({ query: 'Hello 2' });
    const found = r.data?.['folders'] as Array<{ name: string; path: string }>;
    expect(found.map((f) => f.path)).toEqual([at(folders.desktop, 'Hello 2'), at(folders.documents, 'Projects', 'Hello 2'), at(folders.desktop, 'Hello 2 backup')]);
  });

  it('goes a few levels down, but skips hidden, protected and bulky folders', async () => {
    const r = await tool().execute({ query: 'taxes' });
    expect((r.data?.['folders'] as Array<{ name: string }>).map((f) => f.name)).toEqual(['Taxes 2024']);
    expect((await tool().execute({ query: 'node_modules' })).data?.['folders']).toEqual([]);
    expect((await tool().execute({ query: 'hidden' })).data?.['folders']).toEqual([]);
    expect((await tool().execute({ query: 'AppData' })).data?.['folders']).toEqual([]);
  });

  it('says so when there is none, and does not invent one', async () => {
    const r = await tool().execute({ query: 'Zorro' });
    expect(r.ok).toBe(true);
    expect(r.data?.['folders']).toEqual([]);
    expect(String(r.data?.['hint'])).toMatch(/Ask the user/);
  });

  it('refuses a place it does not know or may not look in, and needs a name', async () => {
    expect((await tool().execute({ query: 'x', location: 'the moon' })).summary).toBe('unknown place');
    expect((await tool().execute({ query: 'x', location: at(HOME, '.ssh') })).summary).toBe('unknown place');
    expect((await tool().execute({})).ok).toBe(false);
  });
});
