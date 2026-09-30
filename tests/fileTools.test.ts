import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileTools } from '../src/main/tools/impl/fileTools';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import type { FileSearchDeps, FoundFile } from '../src/main/tools/impl/fileTools';

let home = '';
let folders: KnownFolders;
let find: (args: Record<string, string | number | boolean>) => ReturnType<ReturnType<typeof createFileTools>[number]['execute']>;
let read: typeof find;

// The whole-PC default now falls back to a real filesystem walk across every
// connected drive when nothing turns up in the (real, OS-shelled-out) search
// index — a fake with an empty drive list keeps these tests hermetic, only
// ever touching this suite's own tmpdir, never the machine's real C:\ or the
// developer's real files. Tests that specifically exercise the index tier or
// multiple drives inject their own.
const noExtraDrives: FileSearchDeps = { queryIndex: async () => [], listDrives: async () => [] };

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
  await put('Documents/a/b/c/d/e/f/g/toodeep.pdf', 'deep', daysAgo(2));
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

  const [findTool, readTool] = createFileTools(folders, noExtraDrives);
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
    const result = await find({ folder: 'downloads', extension: 'pdf' });
    expect(result.ok).toBe(true);
    expect(names(result.data?.['files'])).toEqual(['invoice march.pdf', 'report_final.pdf']);
  });

  it('matches every word of the query, in any order', async () => {
    expect(names((await find({ query: 'final report' })).data?.['files'])).toEqual(['report_final.pdf']);
    expect(names((await find({ query: 'march invoice', extension: '.PDF' })).data?.['files'])).toEqual(['invoice march.pdf']);
  });

  it('reaches the whole user folder by default, not just Downloads/Desktop/Documents, while still excluding secrets, dependency folders and things too deep', async () => {
    const all = names((await find({ limit: 25 })).data?.['files']);
    // Pictures and Videos: unreachable under the old three-folder default.
    expect(all).toContain('photo.jpg');
    expect(all).toContain('today.pdf');
    expect(all).not.toContain('.env');
    expect(all).not.toContain('secrets.txt');
    expect(all).not.toContain('hidden.pdf');
    expect(all).not.toContain('toodeep.pdf');
  });

  it('can be limited to one folder', async () => {
    const desktop = await find({ folder: 'desktop' });
    expect(names(desktop.data?.['files'])).toEqual(['resume.docx']);
  });

  it('sorts by name when asked', async () => {
    const sorted = await find({ folder: 'downloads', extension: 'pdf', sort: 'name' });
    expect(names(sorted.data?.['files'])).toEqual(['invoice march.pdf', 'report_final.pdf']);
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

  it('refuses unknown folders and Windows/program internals', async () => {
    expect((await find({ folder: 'my secret stash' })).ok).toBe(false);
    // A named folder can now be anywhere on the PC (read-only), but Windows'
    // own internals are still refused, just with a more specific reason than
    // plain "outside your folder" now that outside-home is otherwise allowed.
    const outside = await find({ folder: 'C:\\Windows' });
    expect(outside.ok).toBe(false);
    expect(outside.error).toMatch(/protected/);
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

describe('find_file: whole-PC default scope', () => {
  it('merges an index hit with a match found on another connected drive, rather than stopping at the first one found', async () => {
    // A real bug, caught live: a query that the index answered from the
    // indexed (home) drive alone silently never checked a second connected
    // drive that also genuinely had a match — the index result was trusted
    // and the search stopped there. The two must now come back together.
    const otherDrive = await mkdtemp(join(tmpdir(), 'eya-other-drive-'));
    try {
      await writeFile(join(otherDrive, 'Makthal Writ 3826.pdf'), 'x');
      const search: FileSearchDeps = {
        queryIndex: async () => [join(home, 'Desktop', 'resume.docx')], // stands in for "the index already found one"
        listDrives: async () => [otherDrive],
      };
      const [findTool] = createFileTools(folders, search);
      const result = await findTool!.execute({ query: 'writ', limit: 25 });
      const found = names(result.data?.['files']);
      expect(found).toContain('resume.docx');
      expect(found).toContain('Makthal Writ 3826.pdf');
    } finally {
      await rm(otherDrive, { recursive: true, force: true });
    }
  });

  it('falls back to a real filesystem walk when the index finds nothing', async () => {
    const [findTool] = createFileTools(folders, noExtraDrives);
    const result = await findTool!.execute({ query: 'notes' });
    expect(names(result.data?.['files'])).toEqual(['notes.txt']);
  });

  it('falls back to the walk when the index throws, rather than failing the whole search', async () => {
    const search: FileSearchDeps = {
      queryIndex: async () => {
        throw new Error('Windows Search service is not running');
      },
      listDrives: async () => [],
    };
    const [findTool] = createFileTools(folders, search);
    const result = await findTool!.execute({ query: 'notes' });
    expect(result.ok).toBe(true);
    expect(names(result.data?.['files'])).toEqual(['notes.txt']);
  });

  it('also searches every other accessible drive, not just the user folder', async () => {
    const otherDrive = await mkdtemp(join(tmpdir(), 'eya-other-drive-'));
    try {
      await mkdir(join(otherDrive, 'Media'), { recursive: true });
      await writeFile(join(otherDrive, 'Media', 'ConCity.mp4'), 'video-bytes');
      const search: FileSearchDeps = { queryIndex: async () => [], listDrives: async () => [otherDrive] };
      const [findTool] = createFileTools(folders, search);
      const result = await findTool!.execute({ query: 'con city', fileType: 'video' });
      expect(names(result.data?.['files'])).toEqual(['ConCity.mp4']);
    } finally {
      await rm(otherDrive, { recursive: true, force: true });
    }
  });

  it("stays out of another account's own profile and Windows/program internals while walking a drive, but still finds ordinary top-level content there", async () => {
    const driveRoot = await mkdtemp(join(tmpdir(), 'eya-drive-root-'));
    const home2 = join(driveRoot, 'Users', 'TestUser');
    const folders2: KnownFolders = {
      home: home2,
      desktop: join(home2, 'Desktop'),
      documents: join(home2, 'Documents'),
      downloads: join(home2, 'Downloads'),
      pictures: join(home2, 'Pictures'),
      videos: join(home2, 'Videos'),
      music: join(home2, 'Music'),
      temp: join(home2, 'AppData', 'Local', 'Temp'),
    };
    try {
      await mkdir(join(home2, 'Desktop'), { recursive: true });
      await writeFile(join(home2, 'Desktop', 'legit-home-file.txt'), 'home file');
      await mkdir(join(driveRoot, 'Users', 'OtherUser'), { recursive: true });
      await writeFile(join(driveRoot, 'Users', 'OtherUser', 'legit-secret.txt'), 'private');
      await mkdir(join(driveRoot, 'Windows'), { recursive: true });
      await writeFile(join(driveRoot, 'Windows', 'legit-system.txt'), 'system');
      await mkdir(join(driveRoot, 'TopLevel'), { recursive: true });
      await writeFile(join(driveRoot, 'TopLevel', 'legit-drive-file.txt'), 'drive file');

      const search: FileSearchDeps = { queryIndex: async () => [], listDrives: async () => [driveRoot] };
      const [findTool] = createFileTools(folders2, search);
      const found = names((await findTool!.execute({ query: 'legit' })).data?.['files']);
      expect(found).toContain('legit-drive-file.txt');
      expect(found).toContain('legit-home-file.txt');
      expect(found).not.toContain('legit-secret.txt');
      expect(found).not.toContain('legit-system.txt');
    } finally {
      await rm(driveRoot, { recursive: true, force: true });
    }
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

  it('refuses secrets and Windows/program internals, wherever they are', async () => {
    expect((await read({ path: join(home, 'Downloads', '.env') })).ok).toBe(false);
    expect((await read({ path: join(home, 'Documents', 'secrets.txt') })).ok).toBe(false);
    expect((await read({ path: 'C:\\Windows\\win.ini' })).ok).toBe(false);
  });

  it('can read an ordinary text file outside the home folder too', async () => {
    // Not under the OS tmpdir for this one: on this machine that sits under
    // AppData, which is (correctly) blocked everywhere, home-relative or not.
    // A throwaway folder next to the repo avoids that collision.
    const otherDrive = join(process.cwd(), 'eya-test-outside-home-tmp');
    await mkdir(otherDrive, { recursive: true });
    try {
      await writeFile(join(otherDrive, 'notes-elsewhere.txt'), 'hello from elsewhere');
      const result = await read({ path: join(otherDrive, 'notes-elsewhere.txt') });
      expect(result.ok).toBe(true);
      expect(result.data?.['content']).toBe('hello from elsewhere');
    } finally {
      await rm(otherDrive, { recursive: true, force: true });
    }
  });

  it('handles a missing file and a folder', async () => {
    const missing = await read({ path: join(home, 'Downloads', 'ghost.txt') });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/does not exist/);
    await fs.mkdir(join(home, 'Downloads', 'folder.txt'), { recursive: true });
    expect((await read({ path: join(home, 'Downloads', 'folder.txt') })).ok).toBe(false);
  });
});
