import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileOpsTools } from '../src/main/tools/impl/fileOpsTools';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import type { Tool, ToolArgs } from '../src/main/tools/types';

let home = '';
let folders: KnownFolders;
let tools: Record<string, Tool>;

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
  tools = Object.fromEntries(createFileOpsTools(folders).map((t) => [t.schema.name, t]));
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
  it('never deletes on the first call: it asks first', async () => {
    await writeFile(join(folders.desktop, 'doomed.txt'), 'x');
    const result = await call('delete_file', { path: join(folders.desktop, 'doomed.txt') });
    expect(result.ok).toBe(false);
    expect(result.data?.['status']).toBe('permission_required');
    expect(result.data?.['action']).toBe('delete_file');
    expect(await exists(join(folders.desktop, 'doomed.txt'))).toBe(true);
  });

  it('deletes only once confirm is true, and verifies it is really gone', async () => {
    await writeFile(join(folders.desktop, 'doomed2.txt'), 'x');
    const confirmed = await call('delete_file', { path: join(folders.desktop, 'doomed2.txt'), confirm: true });
    expect(confirmed.ok).toBe(true);
    expect(await exists(join(folders.desktop, 'doomed2.txt'))).toBe(false);
  });

  it('refuses a folder', async () => {
    await mkdir(join(folders.desktop, 'a-folder'), { recursive: true });
    const result = await call('delete_file', { path: join(folders.desktop, 'a-folder'), confirm: true });
    expect(result.ok).toBe(false);
  });
});

describe('delete_folder', () => {
  it('reports how many files it contains before deleting anything', async () => {
    const dir = join(folders.desktop, 'ToDelete');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'one.txt'), 'x');
    await writeFile(join(dir, 'sub', 'two.txt'), 'x');

    const first = await call('delete_folder', { path: dir });
    expect(first.ok).toBe(false);
    expect(first.data?.['status']).toBe('permission_required');
    expect(first.data?.['fileCount']).toBe(2);
    expect(await exists(dir)).toBe(true);

    const confirmed = await call('delete_folder', { path: dir, confirm: true });
    expect(confirmed.ok).toBe(true);
    expect(await exists(dir)).toBe(false);
  });

  it('refuses to delete a known special folder itself', async () => {
    const result = await call('delete_folder', { path: folders.desktop, confirm: true });
    expect(result.ok).toBe(false);
    expect(await exists(folders.desktop)).toBe(true);
  });

  it('refuses a file', async () => {
    await writeFile(join(folders.desktop, 'not-a-folder.txt'), 'x');
    const result = await call('delete_folder', { path: join(folders.desktop, 'not-a-folder.txt'), confirm: true });
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
      ['delete_file', { path: outside, confirm: true }],
      ['delete_folder', { path: outside, confirm: true }],
    ] as const) {
      const result = await call(name, args);
      expect(result.ok, name).toBe(false);
    }
  });
});
