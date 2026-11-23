import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecycleBinTools, defaultRecycleBinDeps } from '../src/main/tools/impl/recycleBinTools';
import type { RecycleBinDeps, RecycleBinEntry } from '../src/main/tools/impl/recycleBinTools';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import type { Tool, ToolArgs } from '../src/main/tools/types';

let home = '';
let binDir = ''; // stands in for $Recycle.Bin: restoreItem/permanentlyDeleteItem are real fs ops either way
let folders: KnownFolders;
let entries: RecycleBinEntry[] = [];
let emptied = false;
let tools: Record<string, Tool>;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function call(name: string, args: ToolArgs = {}) {
  const tool = tools[name];
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  return tool.execute(args);
}

/** A recycled item: a real file under `binDir` (standing in for $Recycle.Bin) plus its metadata. */
async function recycle(name: string, opts: { folder?: string; daysAgo?: number; isFolder?: boolean } = {}): Promise<RecycleBinEntry> {
  const originalFolder = opts.folder ?? folders.desktop;
  const rawPath = join(binDir, `$R${Math.random().toString(36).slice(2)}${opts.isFolder ? '' : '.txt'}`);
  if (opts.isFolder === true) {
    await mkdir(join(rawPath, 'sub'), { recursive: true });
    await writeFile(join(rawPath, 'sub', 'inner.txt'), 'x');
  } else {
    await writeFile(rawPath, 'x');
  }
  const deletedAt = new Date(Date.now() - (opts.daysAgo ?? 0) * 86_400_000).toISOString();
  const entry: RecycleBinEntry = {
    name,
    originalFolder,
    originalPath: join(originalFolder, name),
    deletedAt,
    sizeBytes: 1,
    isFolder: opts.isFolder ?? false,
    rawPath,
  };
  entries.push(entry);
  return entry;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'eya-recyclebin-'));
  binDir = await mkdtemp(join(tmpdir(), 'eya-recyclebin-storage-'));
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
  await mkdir(folders.desktop, { recursive: true });
  entries = [];
  emptied = false;
  const deps: RecycleBinDeps = {
    listItems: async () => entries,
    countAndSize: async () => ({ count: entries.length, totalBytes: entries.reduce((s, e) => s + e.sizeBytes, 0) }),
    restoreItem: defaultRecycleBinDeps.restoreItem, // real fs.rename — safe, exercised against real tmpdir files
    permanentlyDeleteItem: defaultRecycleBinDeps.permanentlyDeleteItem, // real fs.unlink/rm
    emptyBin: async () => {
      emptied = true;
      entries = [];
    },
  };
  tools = Object.fromEntries(createRecycleBinTools(folders, deps).map((t) => [t.schema.name, t]));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(binDir, { recursive: true, force: true });
});

describe('get_recycle_bin_count', () => {
  it('reports how many items and their approximate total size', async () => {
    await recycle('a.txt');
    await recycle('b.txt');
    const result = await call('get_recycle_bin_count');
    expect(result.ok).toBe(true);
    expect(result.data?.['count']).toBe(2);
  });
});

describe('get_recycle_bin_items', () => {
  it('lists items newest-deleted first', async () => {
    await recycle('old.txt', { daysAgo: 3 });
    await recycle('new.txt', { daysAgo: 0 });
    const result = await call('get_recycle_bin_items');
    const names = (result.data?.['items'] as Array<{ name: string }>).map((i) => i.name);
    expect(names).toEqual(['new.txt', 'old.txt']);
  });

  it('says plainly when the bin is empty', async () => {
    const result = await call('get_recycle_bin_items');
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('the Recycle Bin is empty');
  });
});

describe('find_recycle_bin_item', () => {
  it('filters by name', async () => {
    await recycle('CauseList.pdf');
    await recycle('Petition.pdf');
    const result = await call('find_recycle_bin_item', { query: 'cause' });
    const names = (result.data?.['items'] as Array<{ name: string }>).map((i) => i.name);
    expect(names).toEqual(['CauseList.pdf']);
  });

  it('filters by when it was deleted', async () => {
    await recycle('yesterday.txt', { daysAgo: 1 });
    await recycle('today.txt', { daysAgo: 0 });
    const result = await call('find_recycle_bin_item', { when: 'yesterday' });
    const names = (result.data?.['items'] as Array<{ name: string }>).map((i) => i.name);
    expect(names).toEqual(['yesterday.txt']);
  });

  it('rejects an unrecognized time range', async () => {
    const result = await call('find_recycle_bin_item', { when: 'next tuesday' });
    expect(result.ok).toBe(false);
  });
});

describe('restore_recycle_bin_item', () => {
  it('finds an entry even if its reported name is missing the extension the user actually said', async () => {
    // This was a real bug: Explorer's "hide extensions for known file types"
    // setting leaked into the Shell property the listing used to read,
    // reporting e.g. "EyaRestoreTest" for a file actually named
    // "EyaRestoreTest.txt" — silently breaking lookup against the full name
    // the user and the model both use. Fixed at the source (System.FileName
    // instead of .Name); this is the belt-and-braces check on the matching
    // logic itself, independent of which field the listing ends up using.
    entries.push({
      name: 'EyaRestoreTest', // note: no ".txt", exactly as seen live
      originalFolder: folders.desktop,
      originalPath: join(folders.desktop, 'EyaRestoreTest.txt'),
      deletedAt: new Date().toISOString(),
      sizeBytes: 1,
      isFolder: false,
      rawPath: join(binDir, 'raw-no-ext-test'),
    });
    await writeFile(join(binDir, 'raw-no-ext-test'), 'x');
    const result = await call('restore_recycle_bin_item', { name: 'EyaRestoreTest.txt' });
    expect(result.ok).toBe(true);
    expect(await exists(join(folders.desktop, 'EyaRestoreTest.txt'))).toBe(true);
  });

  it('moves the item back to its original location and verifies it', async () => {
    await recycle('report.pdf');
    const result = await call('restore_recycle_bin_item', { name: 'report.pdf' });
    expect(result.ok).toBe(true);
    expect(await exists(join(folders.desktop, 'report.pdf'))).toBe(true);
  });

  it('says plainly when nothing matches', async () => {
    const result = await call('restore_recycle_bin_item', { name: 'nope.pdf' });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('not found');
  });

  it('asks which one when the name matches more than one item, rather than guessing', async () => {
    await recycle('CauseList.pdf', { daysAgo: 1 });
    await recycle('CauseList.pdf', { daysAgo: 0 });
    const result = await call('restore_recycle_bin_item', { name: 'causelist' });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('ambiguous');
  });

  it('narrows an otherwise-ambiguous name using a date filter', async () => {
    await recycle('CauseList.pdf', { daysAgo: 1 });
    await recycle('CauseList.pdf', { daysAgo: 0 });
    const result = await call('restore_recycle_bin_item', { name: 'causelist', when: 'today' });
    expect(result.ok).toBe(true);
  });

  it('refuses to restore something whose original location is outside the user folder', async () => {
    await recycle('system-thing.dll', { folder: 'C:\\Windows\\System32' });
    const result = await call('restore_recycle_bin_item', { name: 'system-thing.dll' });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('not allowed');
  });

  it('refuses to overwrite something already at the original location', async () => {
    await writeFile(join(folders.desktop, 'clash.txt'), 'already here');
    await recycle('clash.txt');
    const result = await call('restore_recycle_bin_item', { name: 'clash.txt' });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('name taken');
  });

  it('restores a folder, contents and all', async () => {
    await recycle('OldCases', { isFolder: true });
    const result = await call('restore_recycle_bin_item', { name: 'OldCases' });
    expect(result.ok).toBe(true);
    expect(await exists(join(folders.desktop, 'OldCases', 'sub', 'inner.txt'))).toBe(true);
  });
});

describe('restore_all_recycle_bin_items', () => {
  it('restores everything it can, and reports what it could not', async () => {
    await recycle('ok1.txt');
    await recycle('ok2.txt');
    await recycle('blocked.dll', { folder: 'C:\\Windows\\System32' });
    const result = await call('restore_all_recycle_bin_items');
    expect(result.data?.['restored']).toBe(2);
    expect(result.data?.['skipped']).toEqual(['blocked.dll']);
    expect(await exists(join(folders.desktop, 'ok1.txt'))).toBe(true);
    expect(await exists(join(folders.desktop, 'ok2.txt'))).toBe(true);
  });
});

describe('permanently_delete_recycle_bin_item', () => {
  it('removes the underlying stored item and verifies it is gone', async () => {
    const entry = await recycle('doomed.txt');
    const result = await call('permanently_delete_recycle_bin_item', { name: 'doomed.txt' });
    expect(result.ok).toBe(true);
    expect(await exists(entry.rawPath)).toBe(false);
  });

  it('asks which one when ambiguous, same as restore', async () => {
    await recycle('dup.txt', { daysAgo: 1 });
    await recycle('dup.txt', { daysAgo: 0 });
    const result = await call('permanently_delete_recycle_bin_item', { name: 'dup.txt' });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('ambiguous');
  });
});

describe('empty_recycle_bin', () => {
  it('never empties on the first call: it asks first, reporting count and size', async () => {
    await recycle('a.txt');
    await recycle('b.txt');
    const result = await call('empty_recycle_bin');
    expect(result.ok).toBe(false);
    expect(result.data?.['status']).toBe('permission_required');
    expect(result.error).toMatch(/2 items/);
    expect(emptied).toBe(false);
  });

  it('empties only once confirm is true, and verifies it afterward', async () => {
    await recycle('a.txt');
    const result = await call('empty_recycle_bin', { confirm: true });
    expect(result.ok).toBe(true);
    expect(emptied).toBe(true);
  });

  it('says it is already empty rather than asking to confirm emptying nothing', async () => {
    const result = await call('empty_recycle_bin');
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('already empty');
  });
});
