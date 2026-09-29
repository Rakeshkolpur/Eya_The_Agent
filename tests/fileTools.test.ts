import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileTools } from '../src/main/tools/impl/fileTools';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import type { FoundFile } from '../src/main/tools/impl/fileTools';

let home = '';
let folders: KnownFolders;
let find: (args: Record<string, string | number | boolean>) => ReturnType<ReturnType<typeof createFileTools>[number]['execute']>;
let read: typeof find;

const daysAgo = (n: number): Date => new Date(Date.now() - n * 86_400_000);

async function put(rel: string, content: string, modified?: Date): Promise<void> {
  const full = join(home, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
  if (modified !== undefined) await utimes(full, modified, modified);
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'eya-files-'));
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
  await put('Downloads/report_final.pdf', 'pdf', daysAgo(10));
  await put('Downloads/invoice march.pdf', 'pdf', daysAgo(1));
  await put('Downloads/notes.txt', 'buy milk\nand eggs', daysAgo(3));
  await put('Desktop/resume.docx', 'docx', daysAgo(5));
  await put('Documents/a/b/c/d/e/toodeep.pdf', 'deep', daysAgo(2));
  await put('Documents/a/b/shallow.pdf', 'shallow', daysAgo(4));
  await put('Downloads/node_modules/pkg/hidden.pdf', 'no', daysAgo(0));
  await put('Downloads/.env', 'KEY=secret', daysAgo(0));
  await put('Documents/secrets.txt', 'hunter2', daysAgo(0));
  await put('Documents/big.txt', 'x'.repeat(30_000), daysAgo(6));
  // Isolated from the three default search roots (downloads/desktop/documents),
  // so these don't shift the exact-match assertions above; each test below
  // reaches them with an explicit `folder`.
  await put('Pictures/photo.jpg', 'jpg-bytes', daysAgo(1));
  await put('Videos/dated/today.pdf', 'today', daysAgo(0));
  await put('Videos/dated/yesterday.pdf', 'yesterday', daysAgo(1));
  await put('Videos/dated/last-week.pdf', 'old', daysAgo(10));
  await put('Videos/sized/big.pdf', 'x'.repeat(3 * 1024 * 1024), daysAgo(1));
  await put('Videos/sized/small.pdf', 'tiny', daysAgo(1));

  const [findTool, readTool] = createFileTools(folders);
  if (findTool === undefined || readTool === undefined) throw new Error('tools missing');
  find = (args) => findTool.execute(args);
  read = (args) => readTool.execute(args);
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

const names = (files: unknown): string[] => (files as FoundFile[]).map((f) => f.name);

describe('find_file', () => {
  it('returns the newest matches first', async () => {
    const result = await find({ extension: 'pdf' });
    expect(result.ok).toBe(true);
    expect(names(result.data?.['files'])).toEqual(['invoice march.pdf', 'shallow.pdf', 'report_final.pdf']);
  });

  it('matches every word of the query, in any order', async () => {
    expect(names((await find({ query: 'final report' })).data?.['files'])).toEqual(['report_final.pdf']);
    expect(names((await find({ query: 'march invoice', extension: '.PDF' })).data?.['files'])).toEqual(['invoice march.pdf']);
  });

  it('with no filters lists the newest files across the default folders', async () => {
    const result = await find({ limit: 2 });
    // invoice is 1 day old, notes 3 days, shallow 4 days.
    expect(names(result.data?.['files'])).toEqual(['invoice march.pdf', 'notes.txt']);
  });

  it('never surfaces secrets, dependency folders or things too deep', async () => {
    const all = names((await find({ limit: 25 })).data?.['files']);
    expect(all).not.toContain('.env');
    expect(all).not.toContain('secrets.txt');
    expect(all).not.toContain('hidden.pdf');
    expect(all).not.toContain('toodeep.pdf');
  });

  it('can be limited to one folder, and sorted by name', async () => {
    const desktop = await find({ folder: 'desktop' });
    expect(names(desktop.data?.['files'])).toEqual(['resume.docx']);
    const sorted = await find({ extension: 'pdf', sort: 'name' });
    expect(names(sorted.data?.['files'])).toEqual(['invoice march.pdf', 'report_final.pdf', 'shallow.pdf']);
  });

  it('reports each file with a path, size and date', async () => {
    const file = ((await find({ query: 'notes' })).data?.['files'] as FoundFile[])[0];
    expect(file?.path).toBe(join(home, 'Downloads', 'notes.txt'));
    expect(file?.sizeKB).toBeGreaterThanOrEqual(1);
    expect(Number.isNaN(Date.parse(file?.modified ?? ''))).toBe(false);
  });

  it('says so plainly when nothing matches', async () => {
    const result = await find({ query: 'zzz-nothing-like-this' });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('no matching files');
  });

  it('refuses unknown or outside folders', async () => {
    expect((await find({ folder: 'my secret stash' })).ok).toBe(false);
    const outside = await find({ folder: 'C:\\Windows' });
    expect(outside.ok).toBe(false);
    expect(outside.error).toMatch(/outside/);
  });

  it('respects the limit and clamps silly values', async () => {
    expect(((await find({ extension: 'pdf', limit: 1 })).data?.['files'] as unknown[]).length).toBe(1);
    expect(((await find({ extension: 'pdf', limit: -5 })).data?.['files'] as unknown[]).length).toBe(1);
  });
});

describe('find_file: fileType', () => {
  it('maps a natural type name to its extensions', async () => {
    const result = await find({ folder: 'pictures', fileType: 'image' });
    expect(names(result.data?.['files'])).toEqual(['photo.jpg']);
  });

  it('rejects an unknown type rather than silently matching everything', async () => {
    const result = await find({ fileType: 'nonsense-type' });
    expect(result.ok).toBe(false);
  });

  it('a specific extension still takes precedence over fileType if both are given', async () => {
    const result = await find({ folder: 'pictures', extension: 'jpg', fileType: 'pdf' });
    expect(names(result.data?.['files'])).toEqual(['photo.jpg']);
  });
});

describe('find_file: when / date range', () => {
  const dated = () => join(folders.videos, 'dated');

  it('"when: today" only returns files modified today', async () => {
    const result = await find({ folder: dated(), when: 'today' });
    expect(names(result.data?.['files'])).toEqual(['today.pdf']);
  });

  it('"when: yesterday" only returns files modified yesterday', async () => {
    const result = await find({ folder: dated(), when: 'yesterday' });
    expect(names(result.data?.['files'])).toEqual(['yesterday.pdf']);
  });

  it('rejects an unrecognized "when" value', async () => {
    expect((await find({ when: 'next tuesday' })).ok).toBe(false);
  });

  it('onDate matches a specific day', async () => {
    const isoYesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const result = await find({ folder: dated(), onDate: isoYesterday });
    expect(names(result.data?.['files'])).toEqual(['yesterday.pdf']);
  });

  it('fromDate/toDate cover an inclusive range', async () => {
    const from = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const result = await find({ folder: dated(), fromDate: from, toDate: to });
    expect(names(result.data?.['files']).sort()).toEqual(['today.pdf', 'yesterday.pdf']);
  });

  it('rejects a malformed date rather than ignoring it', async () => {
    expect((await find({ onDate: '20th September' })).ok).toBe(false);
    expect((await find({ fromDate: 'not-a-date' })).ok).toBe(false);
  });
});

describe('find_file: size filters', () => {
  const sized = () => join(folders.videos, 'sized');

  it('minSizeMB excludes smaller files', async () => {
    const result = await find({ folder: sized(), minSizeMB: 1 });
    expect(names(result.data?.['files'])).toEqual(['big.pdf']);
  });

  it('maxSizeMB excludes larger files', async () => {
    const result = await find({ folder: sized(), maxSizeMB: 0.01 });
    expect(names(result.data?.['files'])).toEqual(['small.pdf']);
  });
});

describe('read_file', () => {
  it('reads a text file', async () => {
    const result = await read({ path: join(home, 'Downloads', 'notes.txt') });
    expect(result.ok).toBe(true);
    expect(result.data?.['content']).toBe('buy milk\nand eggs');
    expect(result.data?.['truncated']).toBe(false);
  });

  it('truncates very long files and says so', async () => {
    const result = await read({ path: join(home, 'Documents', 'big.txt') });
    expect(result.ok).toBe(true);
    expect((result.data?.['content'] as string).length).toBe(24_000);
    expect(result.data?.['truncated']).toBe(true);
  });

  it('points to analyze_document for PDFs instead of dumping bytes', async () => {
    const result = await read({ path: join(home, 'Downloads', 'report_final.pdf') });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/analyze_document/);
  });

  it('refuses secrets and anything outside the home folder', async () => {
    expect((await read({ path: join(home, 'Downloads', '.env') })).ok).toBe(false);
    expect((await read({ path: join(home, 'Documents', 'secrets.txt') })).ok).toBe(false);
    expect((await read({ path: 'C:\\Windows\\win.ini' })).ok).toBe(false);
  });

  it('handles a missing file and a folder', async () => {
    const missing = await read({ path: join(home, 'Downloads', 'ghost.txt') });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/does not exist/);
    await fs.mkdir(join(home, 'Downloads', 'folder.txt'), { recursive: true });
    expect((await read({ path: join(home, 'Downloads', 'folder.txt') })).ok).toBe(false);
  });
});
