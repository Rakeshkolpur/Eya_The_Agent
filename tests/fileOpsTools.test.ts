import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileOpsTools } from '../src/main/tools/impl/fileOpsTools';
import type { RecycleDeps } from '../src/main/tools/impl/fileOpsTools';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import type { Tool, ToolArgs } from '../src/main/tools/types';

let home = '';
let folders: KnownFolders;
let tools: Record<string, Tool>;
let recycledFiles: string[] = [];
let recycledFolders: string[] = [];

/**
 * Recycling for real (the Windows Shell Recycle Bin) is exercised live, not
 * in this fast unit suite — this fake just needs to (a) actually make the
 * path disappear, so `verifyAbsent` sees what a real recycle would produce,
 * and (b) record that the *recycle* path was taken, as opposed to the
 * permanent-delete path, which calls fs.unlink/fs.rm directly and never
 * touches this at all.
 */
const fakeRecycle: RecycleDeps = {
  recycleFile: async (path) => {
    recycledFiles.push(path);
    await unlink(path);
  },
  recycleFolder: async (path) => {
    recycledFolders.push(path);
    await rm(path, { recursive: true, force: true });
  },
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function call(name: string, args: ToolArgs) {
  const tool = tools[name];
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  return tool.execute(args);
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'eya-fileops-'));
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
  await mkdir(folders.downloads, { recursive: true });
  tools = Object.fromEntries(createFileOpsTools(folders, fakeRecycle).map((t) => [t.schema.name, t]));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('create_folder', () => {
  it('creates a folder under a special folder given by name', async () => {
    const result = await call('create_folder', { parentFolder: 'desktop', name: 'Cases' });
    expect(result.ok).toBe(true);
    expect(await exists(join(folders.desktop, 'Cases'))).toBe(true);
  });

  it('is idempotent: creating the same folder again succeeds without complaint', async () => {
    const result = await call('create_folder', { parentFolder: 'desktop', name: 'Cases' });
    expect(result.ok).toBe(true);
    expect(result.data?.['created']).toBe(false);
  });

  it('refuses a name that is actually a path', async () => {
    const result = await call('create_folder', { parentFolder: 'desktop', name: '../../evil' });
    expect(result.ok).toBe(false);
  });

  it('refuses when a file already occupies that name', async () => {
    await writeFile(join(folders.desktop, 'taken.txt'), 'x');
    const result = await call('create_folder', { parentFolder: 'desktop', name: 'taken.txt' });
    expect(result.ok).toBe(false);
  });

  it('refuses a parent folder outside the user folder', async () => {
    const result = await call('create_folder', { parentFolder: 'C:\\Windows', name: 'Cases' });
    expect(result.ok).toBe(false);
  });
});

describe('copy_file', () => {
  it('copies a file to a destination folder', async () => {
    await writeFile(join(folders.downloads, 'report.pdf'), 'hello');
    const result = await call('copy_file', {
      sourcePath: join(folders.downloads, 'report.pdf'),
      destinationFolder: 'desktop',
    });
    expect(result.ok).toBe(true);
    expect(await exists(join(folders.desktop, 'report.pdf'))).toBe(true);
    expect(await exists(join(folders.downloads, 'report.pdf'))).toBe(true); // source untouched
  });

  it('asks for confirmation before overwriting, and does not copy until confirmed', async () => {
    await writeFile(join(folders.downloads, 'dup.pdf'), 'source');
    await writeFile(join(folders.desktop, 'dup.pdf'), 'already here');

    const first = await call('copy_file', { sourcePath: join(folders.downloads, 'dup.pdf'), destinationFolder: 'desktop' });
    expect(first.ok).toBe(false);
    expect(first.data?.['status']).toBe('permission_required');
    expect(first.data?.['action']).toBe('overwrite_file');
    // Not actually overwritten yet.
    expect(await stat(join(folders.desktop, 'dup.pdf')).then((s) => s.size)).toBe('already here'.length);

    const confirmed = await call('copy_file', {
      sourcePath: join(folders.downloads, 'dup.pdf'),
      destinationFolder: 'desktop',
      confirm: true,
    });
    expect(confirmed.ok).toBe(true);
    expect(await stat(join(folders.desktop, 'dup.pdf')).then((s) => s.size)).toBe('source'.length);
  });

  it('fails cleanly when the source does not exist', async () => {
    const result = await call('copy_file', { sourcePath: join(folders.downloads, 'nope.pdf'), destinationFolder: 'desktop' });
    expect(result.ok).toBe(false);
  });
});

describe('move_file', () => {
  it('moves a file, removing it from the source', async () => {
    await writeFile(join(folders.downloads, 'move-me.txt'), 'x');
    const result = await call('move_file', { sourcePath: join(folders.downloads, 'move-me.txt'), destinationFolder: 'desktop' });
    expect(result.ok).toBe(true);
    expect(await exists(join(folders.desktop, 'move-me.txt'))).toBe(true);
    expect(await exists(join(folders.downloads, 'move-me.txt'))).toBe(false);
  });

  it('asks for confirmation before overwriting, and leaves both files alone until confirmed', async () => {
    await writeFile(join(folders.downloads, 'clash.txt'), 'new');
    await writeFile(join(folders.desktop, 'clash.txt'), 'old');

    const first = await call('move_file', { sourcePath: join(folders.downloads, 'clash.txt'), destinationFolder: 'desktop' });
    expect(first.ok).toBe(false);
    expect(first.data?.['status']).toBe('permission_required');
    expect(await exists(join(folders.downloads, 'clash.txt'))).toBe(true); // source untouched

    const confirmed = await call('move_file', {
      sourcePath: join(folders.downloads, 'clash.txt'),
      destinationFolder: 'desktop',
      confirm: true,
    });
    expect(confirmed.ok).toBe(true);
    expect(await exists(join(folders.downloads, 'clash.txt'))).toBe(false);
    expect(await stat(join(folders.desktop, 'clash.txt')).then((s) => s.size)).toBe('new'.length);
  });
});

describe('rename_file', () => {
  it('renames a file in place', async () => {
    await writeFile(join(folders.desktop, 'old-name.txt'), 'x');
    const result = await call('rename_file', { path: join(folders.desktop, 'old-name.txt'), newName: 'new-name.txt' });
    expect(result.ok).toBe(true);
    expect(await exists(join(folders.desktop, 'new-name.txt'))).toBe(true);
    expect(await exists(join(folders.desktop, 'old-name.txt'))).toBe(false);
  });

  it('asks for confirmation before overwriting another file', async () => {
    await writeFile(join(folders.desktop, 'a.txt'), 'a');
    await writeFile(join(folders.desktop, 'b.txt'), 'b');
    const first = await call('rename_file', { path: join(folders.desktop, 'a.txt'), newName: 'b.txt' });
    expect(first.ok).toBe(false);
    expect(first.data?.['status']).toBe('permission_required');
    expect(await exists(join(folders.desktop, 'a.txt'))).toBe(true);

    const confirmed = await call('rename_file', { path: join(folders.desktop, 'a.txt'), newName: 'b.txt', confirm: true });
    expect(confirmed.ok).toBe(true);
    expect(await exists(join(folders.desktop, 'a.txt'))).toBe(false);
  });

  it('rejects an unsafe new name', async () => {
    await writeFile(join(folders.desktop, 'c.txt'), 'x');
    const result = await call('rename_file', { path: join(folders.desktop, 'c.txt'), newName: '../../escape.txt' });
    expect(result.ok).toBe(false);
    expect(await exists(join(folders.desktop, 'c.txt'))).toBe(true);
  });
});

describe('delete_file', () => {
  it('never deletes on the first call: it asks which kind of delete, not just permanent', async () => {
    await writeFile(join(folders.desktop, 'doomed.txt'), 'x');
    const result = await call('delete_file', { path: join(folders.desktop, 'doomed.txt') });
    expect(result.ok).toBe(false);
    expect(result.data?.['status']).toBe('permission_required');
    expect(result.data?.['action']).toBe('delete_file');
    expect(result.data?.['options']).toEqual(['recycle', 'permanent']);
    expect(result.error).toMatch(/Recycle Bin/);
    expect(result.error).toMatch(/permanently/);
    expect(await exists(join(folders.desktop, 'doomed.txt'))).toBe(true);
  });

  it('mode: recycle sends it to the Recycle Bin mechanism, not a permanent delete', async () => {
    await writeFile(join(folders.desktop, 'recycle-me.txt'), 'x');
    recycledFiles = [];
    const result = await call('delete_file', { path: join(folders.desktop, 'recycle-me.txt'), mode: 'recycle' });
    expect(result.ok).toBe(true);
    expect(result.data?.['mode']).toBe('recycle');
    expect(result.summary).toMatch(/Recycle Bin/);
    expect(await exists(join(folders.desktop, 'recycle-me.txt'))).toBe(false);
    expect(recycledFiles).toEqual([join(folders.desktop, 'recycle-me.txt')]);
  });

  it('mode: permanent deletes outright, verifies it is really gone, and never touches the recycle mechanism', async () => {
    await writeFile(join(folders.desktop, 'doomed2.txt'), 'x');
    recycledFiles = [];
    const confirmed = await call('delete_file', { path: join(folders.desktop, 'doomed2.txt'), mode: 'permanent' });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.data?.['mode']).toBe('permanent');
    expect(confirmed.summary).toMatch(/permanently/);
    expect(await exists(join(folders.desktop, 'doomed2.txt'))).toBe(false);
    expect(recycledFiles).toEqual([]);
  });

  it('reports honestly if the recycle mechanism itself fails', async () => {
    await writeFile(join(folders.desktop, 'stuck.txt'), 'x');
    const failing: RecycleDeps = { ...fakeRecycle, recycleFile: async () => { throw new Error('shell refused'); } };
    const failingTools = Object.fromEntries(createFileOpsTools(folders, failing).map((t) => [t.schema.name, t]));
    const result = await failingTools['delete_file']!.execute({ path: join(folders.desktop, 'stuck.txt'), mode: 'recycle' });
    expect(result.ok).toBe(false);
    expect(await exists(join(folders.desktop, 'stuck.txt'))).toBe(true);
  });

  it('refuses a folder', async () => {
    await mkdir(join(folders.desktop, 'a-folder'), { recursive: true });
    const result = await call('delete_file', { path: join(folders.desktop, 'a-folder'), mode: 'permanent' });
    expect(result.ok).toBe(false);
  });

  it('an unrecognized mode value is treated the same as no mode: it asks again', async () => {
    await writeFile(join(folders.desktop, 'confused.txt'), 'x');
    const result = await call('delete_file', { path: join(folders.desktop, 'confused.txt'), mode: 'delete it now' });
    expect(result.ok).toBe(false);
    expect(result.data?.['status']).toBe('permission_required');
    expect(await exists(join(folders.desktop, 'confused.txt'))).toBe(true);
  });
});

describe('delete_folder', () => {
  it('reports how many files it contains and offers both kinds of delete before deleting anything', async () => {
    const dir = join(folders.desktop, 'ToDelete');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'one.txt'), 'x');
    await writeFile(join(dir, 'sub', 'two.txt'), 'x');

    const first = await call('delete_folder', { path: dir });
    expect(first.ok).toBe(false);
    expect(first.data?.['status']).toBe('permission_required');
    expect(first.data?.['options']).toEqual(['recycle', 'permanent']);
    expect(first.data?.['fileCount']).toBe(2);
    expect(await exists(dir)).toBe(true);

    const confirmed = await call('delete_folder', { path: dir, mode: 'permanent' });
    expect(confirmed.ok).toBe(true);
    expect(await exists(dir)).toBe(false);
  });

  it('mode: recycle sends the whole folder to the Recycle Bin mechanism', async () => {
    const dir = join(folders.desktop, 'ToRecycle');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'x');
    recycledFolders = [];

    const result = await call('delete_folder', { path: dir, mode: 'recycle' });
    expect(result.ok).toBe(true);
    expect(result.data?.['mode']).toBe('recycle');
    expect(await exists(dir)).toBe(false);
    expect(recycledFolders).toEqual([dir]);
  });

  it('refuses to delete a known special folder itself', async () => {
    const result = await call('delete_folder', { path: folders.desktop, mode: 'permanent' });
    expect(result.ok).toBe(false);
    expect(await exists(folders.desktop)).toBe(true);
  });

  it('refuses a file', async () => {
    await writeFile(join(folders.desktop, 'not-a-folder.txt'), 'x');
    const result = await call('delete_folder', { path: join(folders.desktop, 'not-a-folder.txt'), mode: 'permanent' });
    expect(result.ok).toBe(false);
  });
});

describe('path safety', () => {
  it('every tool refuses a path outside the user folder', async () => {
    const outside = 'C:\\Windows\\System32\\config\\SAM';
    for (const [name, args] of [
      ['copy_file', { sourcePath: outside, destinationFolder: 'desktop' }],
      ['move_file', { sourcePath: outside, destinationFolder: 'desktop' }],
      ['rename_file', { path: outside, newName: 'x.txt' }],
      ['delete_file', { path: outside, mode: 'permanent' }],
      ['delete_folder', { path: outside, mode: 'permanent' }],
    ] as const) {
      const result = await call(name, args);
      expect(result.ok, name).toBe(false);
    }
  });
});
