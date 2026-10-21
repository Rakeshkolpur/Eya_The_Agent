import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileIndex } from '../src/main/local/FileIndex';
import { LocalCommands } from '../src/main/local/LocalCommands';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';

let root: string;
let folders: KnownFolders;
let index: FileIndex;
let calls: Array<{ name: string; args: ToolArgs }>;
let answers: Record<string, ToolResult | (() => ToolResult)>;

const ok = (data: Record<string, unknown> = {}): ToolResult => ({ ok: true, summary: 'ok', data });

function put(rel: string, modified = new Date('2026-05-01T12:00:00Z')): string {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x');
  utimesSync(path, modified, modified);
  return path;
}

async function commands(extra: { clipboard?: string; now?: Date; built?: boolean; exists?: (p: string) => Promise<boolean> } = {}): Promise<LocalCommands> {
  index = new FileIndex({ roots: [root], watch: null, rescanEveryMs: 0 });
  if (extra.built !== false) await index.build();
  return new LocalCommands({
    tools: {
      invoke: async (name, args) => {
        calls.push({ name, args });
        const answer = answers[name];
        if (answer === undefined) return ok();
        return typeof answer === 'function' ? answer() : answer;
      },
    },
    index,
    folders,
    ...(extra.clipboard !== undefined ? { clipboardText: () => extra.clipboard ?? '' } : {}),
    ...(extra.now !== undefined ? { now: () => extra.now as Date } : {}),
    ...(extra.exists !== undefined ? { exists: extra.exists } : {}),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eya-local-'));
  folders = {
    home: root,
    desktop: join(root, 'Desktop'),
    documents: join(root, 'Documents'),
    downloads: join(root, 'Downloads'),
    pictures: join(root, 'Pictures'),
    videos: join(root, 'Videos'),
    music: join(root, 'Music'),
    temp: root,
  };
  calls = [];
  answers = {};
});
afterEach(() => {
  index?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('websites', () => {
  it('opens a site (in Chrome, unless a browser is named) and says so', async () => {
    const local = await commands();
    const done = await local.tryHandle('open youtube');
    expect(calls).toEqual([{ name: 'open_url', args: { url: 'https://www.youtube.com/' } }]);
    expect(done).toMatchObject({ spoken: 'Opening YouTube.', ok: true, intent: 'open_site', urls: ['https://www.youtube.com/'] });
  });

  it('names no browser to the tool unless the user did — then it is Chrome — and says which one when the user chose', async () => {
    const local = await commands();
    await local.tryHandle('open youtube');
    expect(calls[0]?.args).not.toHaveProperty('browser');
  });

  it('opens in the browser the user named, and says so', async () => {
    const local = await commands();
    const done = await local.tryHandle('open youtube in Edge');
    expect(calls).toEqual([{ name: 'open_url', args: { url: 'https://www.youtube.com/', browser: 'edge' } }]);
    expect(done).toMatchObject({ spoken: 'Opening YouTube in Edge.', ok: true, intent: 'open_site' });
    calls.length = 0;
    const search = await local.tryHandle('search amazon for phone cases on firefox');
    expect(calls[0]).toEqual({ name: 'open_url', args: { url: 'https://www.amazon.com/s?k=phone%20cases', browser: 'firefox' } });
    expect(search?.spoken).toBe('Searching Amazon for phone cases in Firefox.');
  });

  it('a browser it cannot start by name goes to the model instead of opening in Chrome', async () => {
    const local = await commands();
    expect(await local.tryHandle('open youtube in brave')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('searches a site', async () => {
    const local = await commands();
    const done = await local.tryHandle('search amazon for phone cases');
    expect(calls[0]).toEqual({ name: 'open_url', args: { url: 'https://www.amazon.com/s?k=phone%20cases' } });
    expect(done?.spoken).toBe('Searching Amazon for phone cases.');
  });

  it('says plainly when the browser would not open', async () => {
    answers['open_url'] = { ok: false, summary: 'could not open', error: 'I could not open the browser.' };
    const local = await commands();
    const done = await local.tryHandle('open github');
    expect(done).toMatchObject({ ok: false, spoken: "I couldn't open GitHub." });
    expect(done?.urls).toBeUndefined();
  });

  it('does not take what it does not know', async () => {
    const local = await commands();
    expect(await local.tryHandle('what is the weather like')).toBeNull();
    expect(await local.tryHandle('open the door')).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('folders', () => {
  it('opens a usual folder', async () => {
    const local = await commands();
    const done = await local.tryHandle('open my downloads folder');
    expect(calls).toEqual([{ name: 'open_folder', args: { folder: 'downloads' } }]);
    expect(done).toMatchObject({ spoken: 'Opening Downloads.', ok: true });
    expect(done?.refs).toEqual([{ kind: 'folder', value: folders.downloads }]);
  });

  it('opens a folder by its name, using the index', async () => {
    put('Documents/Cases/readme.txt');
    const local = await commands();
    const done = await local.tryHandle('open the cases folder');
    expect(calls).toEqual([{ name: 'open_folder', args: { folder: join(root, 'Documents', 'Cases') } }]);
    expect(done?.spoken).toBe('Opening the Cases folder.');
  });

  it('leaves a folder it cannot find, or two equally good ones, to the model', async () => {
    put('A/Cases/x.txt');
    put('B/Cases/y.txt');
    const local = await commands();
    expect(await local.tryHandle('open the nowhere folder')).toBeNull();
    // same name, same depth: which one is for the user to say
    expect(await local.tryHandle('open the cases folder')).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('finding files', () => {
  it('names a single match and where it is', async () => {
    put('Documents/Resume 2025.pdf');
    const local = await commands();
    const done = await local.tryHandle('find my resume');
    expect(calls).toEqual([]); // answered from memory: no tool, no disk search
    expect(done).toMatchObject({ spoken: 'I found Resume 2025.pdf in Documents.', ok: true, intent: 'find_file' });
    expect(done?.refs).toEqual([{ kind: 'file', value: join(root, 'Documents', 'Resume 2025.pdf'), meta: { index: 0, name: 'Resume 2025.pdf' } }]);
  });

  it('names the first few of several, newest first for "latest"', async () => {
    put('Downloads/a_old.pdf', new Date('2025-01-01T00:00:00Z'));
    put('Downloads/b_mid.pdf', new Date('2025-06-01T00:00:00Z'));
    put('Documents/c_new.pdf', new Date('2026-01-01T00:00:00Z'));
    put('Documents/d_newest.pdf', new Date('2026-06-01T00:00:00Z'));
    const local = await commands();
    const done = await local.tryHandle('show me my latest pdf');
    // asked for a pdf, so every answer is one: the type is left off; they are in two folders, so each says where
    expect(done?.spoken).toBe('I found 4 files, starting with d newest in Documents, c new in Documents, and b mid in Downloads. Say which one to open.');
    expect(done?.refs.map((r) => (r.meta as { index: number }).index)).toEqual([0, 1, 2, 3]);
  });

  it('says a shared folder once, and keeps the type when the files are of different types', async () => {
    put('Downloads/a_old.pdf', new Date('2025-01-01T00:00:00Z'));
    put('Downloads/b_mid.pdf', new Date('2025-06-01T00:00:00Z'));
    put('Downloads/c_new.pdf', new Date('2026-01-01T00:00:00Z'));
    const same = await (await commands()).tryHandle('show me my latest pdf');
    expect(same?.spoken).toBe('I found 3 files, starting with c new, b mid, and a old, all in Downloads.');

    put('Downloads/notes_one.txt', new Date('2026-02-01T00:00:00Z'));
    put('Downloads/notes_two.docx', new Date('2026-03-01T00:00:00Z'));
    index.stop();
    const mixed = await (await commands()).tryHandle('find my notes');
    expect(mixed?.spoken).toBe('I found 2 files, starting with notes two.docx and notes one.txt, all in Downloads.');
  });

  it('keeps what is read aloud short: long digit strings and very long names', async () => {
    put('Downloads/scan 206300325622026 1.pdf');
    const scan = await (await commands()).tryHandle('find my scan');
    expect(scan?.spoken).toBe('I found scan a number 1.pdf in Downloads.');
    expect(scan?.refs[0]?.value).toBe(join(root, 'Downloads', 'scan 206300325622026 1.pdf')); // the real name is still what "open it" uses

    put('Downloads/report alpha beta gamma delta epsilon zeta eta theta iota.pdf');
    index.stop();
    const long = await (await commands()).tryHandle('find my report');
    expect(long?.spoken).toBe('I found report alpha beta gamma delta epsilon in Downloads.');

    put('Downloads/Screenshot - causelist - 2026.png');
    index.stop();
    const shot = await (await commands()).tryHandle('find my screenshot');
    expect(shot?.spoken).toBe('I found Screenshot causelist 2026.png in Downloads.'); // the lone dashes are not read out
  });

  it('limits a search to a folder, a type and a day', async () => {
    put('Downloads/invoice.pdf');
    put('Documents/invoice.pdf');
    put('Downloads/invoice.docx');
    const here = await (await commands()).tryHandle('find the invoice pdf in downloads');
    expect(here?.spoken).toBe('I found invoice.pdf in Downloads.');

    put('Pictures/today.jpg', new Date('2026-10-08T09:00:00'));
    put('Pictures/older.jpg', new Date('2026-09-01T09:00:00'));
    index.stop();
    const day = await commands({ now: new Date('2026-10-08T15:00:00') });
    expect((await day.tryHandle('find my photos from today'))?.spoken).toBe('I found today.jpg in Pictures.');
  });

  it('hands over to the full search when it finds nothing, or is not ready, or is out of date', async () => {
    put('Documents/something.txt');
    const local = await commands();
    expect(await local.tryHandle('find my passport')).toBeNull();

    index.stop();
    const notReady = await commands({ built: false });
    expect(await notReady.tryHandle('find my something')).toBeNull();

    index.stop();
    const stale = await commands({ exists: async () => false });
    expect(await stale.tryHandle('find my something')).toBeNull(); // the file went away after the index was read
    expect(calls).toEqual([]);
  });
});

describe('opening files', () => {
  it('opens the one file that matches', async () => {
    const path = put('Documents/Invoice March.pdf');
    const local = await commands();
    const done = await local.tryHandle('open the invoice pdf');
    expect(calls).toEqual([{ name: 'open_file', args: { path } }]);
    expect(done).toMatchObject({ spoken: 'Opening Invoice March.pdf.', ok: true, intent: 'open_file' });
  });

  it('opens the newest when asked for "the latest"', async () => {
    put('Downloads/old.pdf', new Date('2025-01-01T00:00:00Z'));
    const newest = put('Downloads/new.pdf', new Date('2026-06-01T00:00:00Z'));
    const local = await commands();
    await local.tryHandle('open the latest pdf in downloads');
    expect(calls).toEqual([{ name: 'open_file', args: { path: newest } }]);
  });

  it('opens the clearly better match, and asks when several fit equally', async () => {
    const exact = put('Documents/budget.xlsx');
    put('Documents/budget backup final.xlsx');
    const local = await commands();
    await local.tryHandle('open the budget spreadsheet');
    expect(calls).toEqual([{ name: 'open_file', args: { path: exact } }]);

    calls = [];
    put('Documents/Taxes/report.pdf');
    put('Downloads/report.pdf');
    index.stop();
    const again = await commands();
    const asked = await again.tryHandle('open the report pdf');
    expect(calls).toEqual([]); // nothing was guessed
    expect(asked?.spoken).toMatch(/^I found 2 files that fit: report in (Downloads|Taxes) or report in (Downloads|Taxes)\. Which one\?$/);
    expect(asked?.refs).toHaveLength(2); // so "the first one" can be understood next
  });

  it('says why when Windows could not open it, and hands over when the file is gone', async () => {
    put('Documents/locked.pdf');
    answers['open_file'] = { ok: false, summary: 'could not open', error: 'Windows could not open that file.' };
    const local = await commands();
    expect(await local.tryHandle('open the locked pdf')).toMatchObject({ ok: false, spoken: 'Windows could not open that file.' });

    answers['open_file'] = { ok: false, summary: 'not found', error: 'That file does not exist.' };
    expect(await local.tryHandle('open the locked pdf')).toBeNull();
  });
});

describe('downloads', () => {
  it('downloads a link it was given, on the user\'s own say-so', async () => {
    answers['download_file'] = ok({ name: 'report.pdf', path: join(folders.downloads, 'report.pdf'), sizeBytes: 10 });
    const local = await commands();
    const done = await local.tryHandle('download https://example.com/report.pdf');
    expect(calls).toEqual([{ name: 'download_file', args: { url: 'https://example.com/report.pdf', confirm: true } }]);
    expect(done).toMatchObject({ spoken: 'Downloaded report.pdf to your Downloads folder.', ok: true, tools: ['download_file'] });
    expect(done?.refs).toHaveLength(1);
  });

  it('says a long download carries on, and why one failed', async () => {
    answers['download_file'] = ok({ name: 'big_file.zip', path: join(folders.downloads, 'big_file.zip'), inProgress: true });
    const local = await commands();
    expect((await local.tryHandle('download https://example.com/big_file.zip'))?.spoken).toBe(
      'Downloading big file.zip. It will be in your Downloads folder when it finishes.',
    );
    answers['download_file'] = { ok: false, summary: 'program refused', error: "I don't download programs or scripts." };
    expect(await local.tryHandle('download https://example.com/x.zip')).toMatchObject({ ok: false, spoken: "I don't download programs or scripts." });
  });

  it('downloads what was copied, but only if it is a web address', async () => {
    answers['download_file'] = ok({ name: 'a.pdf', path: join(folders.downloads, 'a.pdf') });
    const copied = await commands({ clipboard: ' https://example.com/a.pdf\n' });
    expect(await copied.tryHandle('download this')).toMatchObject({ ok: true });
    expect(calls[0]).toEqual({ name: 'download_file', args: { url: 'https://example.com/a.pdf', confirm: true } });

    calls = [];
    index.stop();
    const notALink = await commands({ clipboard: 'remember to buy milk' });
    expect(await notALink.tryHandle('download this')).toBeNull();
    index.stop();
    const noClipboard = await commands();
    expect(await noClipboard.tryHandle('download this')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('never downloads from always-on listening', async () => {
    const local = await commands();
    expect(await local.tryHandle('download https://example.com/report.pdf', { live: true })).toBeNull();
    expect(calls).toEqual([]);
    // the same room can still open a site
    expect(await local.tryHandle('open youtube', { live: true })).not.toBeNull();
  });
});

describe('when something goes wrong', () => {
  it('passes the request on instead of failing it', async () => {
    const local = new LocalCommands({
      tools: {
        invoke: async () => {
          throw new Error('registry exploded');
        },
      },
      index: { ready: true, search: () => ({ files: [], total: 0 }), searchFolders: () => [] },
      folders,
    });
    expect(await local.tryHandle('open youtube')).toBeNull();
  });
});
