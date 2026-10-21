import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extOf, FileBrowser, isJunkName, kindOf } from '../src/main/files/fileBrowser';
import { FilesService, fileLabel, plainText } from '../src/main/files/filesService';
import type { FilesDeps } from '../src/main/files/filesService';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';
import type { ActivityInput } from '../src/main/memory/activityLog';

const dirs: string[] = [];
let root = '';
let folders: KnownFolders;

/** Makes a file whose "last changed" time is `agoMin` minutes before `now`. */
const NOW = Date.parse('2026-10-08T12:00:00Z');
function put(path: string, agoMin = 0, content = 'x'): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  const t = new Date(NOW - agoMin * 60_000);
  utimesSync(path, t, t);
  return path;
}
function folder(path: string, agoMin = 0): string {
  mkdirSync(path, { recursive: true });
  const t = new Date(NOW - agoMin * 60_000);
  utimesSync(path, t, t);
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eya-files-'));
  dirs.push(root);
  const home = join(root, 'me');
  folders = {
    home,
    desktop: folder(join(home, 'Desktop')),
    documents: folder(join(home, 'Documents')),
    downloads: folder(join(home, 'Downloads')),
    pictures: folder(join(home, 'Pictures')),
    videos: folder(join(home, 'Videos')),
    music: folder(join(home, 'Music')),
    temp: join(home, 'AppData', 'Local', 'Temp'),
  };
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const names = (l: { items: ReadonlyArray<{ name: string }> }): string[] => l.items.map((i) => i.name);

describe('what a name is', () => {
  it('knows documents, pictures, folders and the rest, whatever the capitals', () => {
    expect(kindOf('Contract.PDF', false)).toBe('document');
    expect(kindOf('notes.txt', false)).toBe('document');
    expect(kindOf('profile.JPG', false)).toBe('image');
    expect(kindOf('movie.mp4', false)).toBe('other');
    expect(kindOf('Court Documents', true)).toBe('folder');
    expect(extOf('a.b.TAR.gz')).toBe('gz');
    expect(extOf('README')).toBe('');
  });

  it('never lists hidden, temporary, lock or half-downloaded files', () => {
    for (const junk of ['.env', '.hidden', 'desktop.ini', 'Thumbs.db', '~$report.docx', 'a.tmp', 'video.crdownload', 'x.part']) expect(isJunkName(junk), junk).toBe(true);
    for (const fine of ['report.docx', 'notes.txt', 'photo.jpg', 'tmp-report.pdf']) expect(isJunkName(fine), fine).toBe(false);
  });
});

describe('the Recent tab', () => {
  it('lists files from your usual folders newest first, saying where each one is', async () => {
    put(join(folders.documents, 'Contract.pdf'), 120);
    put(join(folders.downloads, 'Cause List.pdf'), 5);
    put(join(folders.desktop, 'Notes.txt'), 60);
    put(join(folders.pictures, 'profile.jpg'), 30);
    put(join(folders.documents, 'Court Documents', 'Case Notes.docx'), 10);
    const listing = await new FileBrowser(folders).list('recent');
    expect(names(listing)).toEqual(['Cause List.pdf', 'Case Notes.docx', 'profile.jpg', 'Notes.txt', 'Contract.pdf']);
    expect(listing.items.map((i) => i.where)).toEqual(['Downloads', 'Court Documents', 'Pictures', 'Desktop', 'Documents']);
    expect(listing.items[0]).toMatchObject({ kind: 'document', ext: 'pdf', size: 1 });
    expect(listing.items[2]?.kind).toBe('image');
    expect(listing.truncated).toBe(false);
    expect(listing.error).toBeUndefined();
  });

  it('leaves out junk, programs and shortcuts, secrets, and the insides of protected and system folders', async () => {
    put(join(folders.documents, 'real.docx'), 1);
    for (const hidden of ['desktop.ini', '~$real.docx', '.hidden', 'x.tmp', 'run.exe', 'setup.msi', 'link.lnk', 'script.ps1', 'secrets.txt', 'credentials.json']) put(join(folders.documents, hidden), 2);
    put(join(folders.documents, '.ssh', 'notes.txt'), 3);
    put(join(folders.documents, 'AppData', 'x.txt'), 3);
    put(join(folders.documents, 'Windows', 'y.txt'), 3);
    put(join(folders.documents, 'node_modules', 'z.txt'), 3);
    expect(names(await new FileBrowser(folders).list('recent'))).toEqual(['real.docx']);
  });

  it('looks into folders up to two levels below each place; the Documents tab looks three', async () => {
    put(join(folders.documents, 'a', 'b', 'two-down.pdf'), 2);
    put(join(folders.documents, 'a', 'b', 'c', 'three-down.pdf'), 1);
    expect(names(await new FileBrowser(folders).list('recent'))).toEqual(['two-down.pdf']);
    expect(names(await new FileBrowser(folders).list('documents'))).toEqual(['three-down.pdf', 'two-down.pdf']);
  });

  it('shows at most sixty, and says there were more', async () => {
    for (let i = 0; i < 70; i += 1) put(join(folders.downloads, `file-${String(i).padStart(2, '0')}.txt`), i);
    const listing = await new FileBrowser(folders).list('recent');
    expect(listing.items).toHaveLength(60);
    expect(listing.truncated).toBe(true);
    expect(listing.items[0]?.name).toBe('file-00.txt'); // the newest
  });

  it('does not follow a junction (a link to somewhere else) and so cannot be led out of your folders or round in circles', async () => {
    const outside = folder(join(root, 'elsewhere'));
    put(join(outside, 'private.txt'), 1);
    symlinkSync(outside, join(folders.documents, 'My Elsewhere'), 'junction');
    symlinkSync(folders.documents, join(folders.documents, 'Loop'), 'junction');
    put(join(folders.documents, 'ok.txt'), 2);
    expect(names(await new FileBrowser(folders).list('recent'))).toEqual(['ok.txt']);
  });

  it('stops looking when it has seen enough entries, and says so', async () => {
    for (let i = 0; i < 50; i += 1) put(join(folders.documents, `f${i}.txt`), i);
    const listing = await new FileBrowser(folders, { maxVisited: 10 }).list('recent');
    expect(listing.truncated).toBe(true);
    expect(listing.items.length).toBeLessThan(50);
  });

  it('copes with folders that do not exist', async () => {
    rmSync(folders.pictures, { recursive: true });
    put(join(folders.documents, 'a.txt'), 1);
    expect(names(await new FileBrowser(folders).list('recent'))).toEqual(['a.txt']);
  });
});

describe('the Documents and Images tabs', () => {
  it('Documents holds only documents, from Documents, Desktop and Downloads', async () => {
    put(join(folders.documents, 'a.pdf'), 3);
    put(join(folders.desktop, 'b.docx'), 2);
    put(join(folders.downloads, 'c.xlsx'), 1);
    put(join(folders.downloads, 'd.jpg'), 0);
    put(join(folders.pictures, 'e.pdf'), 0); // not a documents place
    expect(names(await new FileBrowser(folders).list('documents'))).toEqual(['c.xlsx', 'b.docx', 'a.pdf']);
  });

  it('Images holds only pictures, from Pictures, Desktop and Downloads', async () => {
    put(join(folders.pictures, 'a.PNG'), 3);
    put(join(folders.desktop, 'b.jpeg'), 2);
    put(join(folders.downloads, 'c.webp'), 1);
    put(join(folders.documents, 'd.png'), 0);
    put(join(folders.downloads, 'e.pdf'), 0);
    const listing = await new FileBrowser(folders).list('images');
    expect(names(listing)).toEqual(['c.webp', 'b.jpeg', 'a.PNG']);
    expect(listing.items.every((i) => i.kind === 'image')).toBe(true);
  });
});

describe('the Folders tab', () => {
  it('lists your usual folders first, then the folders you have been working in lately (newest first)', async () => {
    folder(join(folders.documents, 'Court Documents'), 5);
    folder(join(folders.documents, 'Old Stuff'), 500);
    folder(join(folders.downloads, 'Invoices'), 50);
    folder(join(folders.documents, '.hiddenfolder'), 1);
    folder(join(folders.documents, 'node_modules'), 1);
    const listing = await new FileBrowser(folders).list('folders');
    expect(names(listing)).toEqual(['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music', 'Court Documents', 'Invoices', 'Old Stuff']);
    expect(listing.items.every((i) => i.kind === 'folder')).toBe(true);
    expect(listing.items[6]?.where).toBe('Documents');
  });

  it('does not list a usual folder twice, and skips ones that do not exist', async () => {
    rmSync(folders.videos, { recursive: true });
    const same = { ...folders, desktop: folders.documents };
    const listing = await new FileBrowser(same).list('folders');
    expect(names(listing).filter((n) => n === 'Documents')).toHaveLength(2); // the same folder under two usual names is shown by what it IS, once per name
    expect(names(listing)).not.toContain('Videos');
  });
});

describe('browsing one folder', () => {
  it('shows folders first and then files, each by name, and a way up', async () => {
    folder(join(folders.documents, 'zeta'), 1);
    folder(join(folders.documents, 'Alpha'), 1);
    put(join(folders.documents, 'b.txt'), 1);
    put(join(folders.documents, 'A.pdf'), 1);
    put(join(folders.documents, 'run.exe'), 1);
    put(join(folders.documents, '.hidden'), 1);
    const listing = await new FileBrowser(folders).browse(folders.documents);
    expect(names(listing)).toEqual(['Alpha', 'zeta', 'A.pdf', 'b.txt']);
    expect(listing).toMatchObject({ title: 'Documents', folder: folders.documents, parent: folders.home });
  });

  it('goes into subfolders, and a way up leads back', async () => {
    put(join(folders.documents, 'Cases', 'one.pdf'), 1);
    const listing = await new FileBrowser(folders).browse(join(folders.documents, 'Cases'));
    expect(listing).toMatchObject({ title: 'Cases', parent: folders.documents });
    expect(names(listing)).toEqual(['one.pdf']);
  });

  it('refuses places Eya may not look: protected folders, other drives\' system folders, and nonsense', async () => {
    const b = new FileBrowser(folders);
    expect((await b.browse(join(folders.home, '.ssh'))).error).toContain('protected');
    expect((await b.browse(join(folders.home, 'AppData'))).error).toContain('protected');
    expect((await b.browse('')).error).toContain("can't show that folder");
    expect((await b.browse('C:\\Windows\\System32')).error).toBeDefined();
  });

  it('says plainly when a folder has gone', async () => {
    const listing = await new FileBrowser(folders).browse(join(folders.documents, 'vanished'));
    expect(listing.items).toEqual([]);
    expect(listing.error).toContain('could not be read');
  });

  it('shows at most four hundred entries, and says there were more', async () => {
    for (let i = 0; i < 410; i += 1) put(join(folders.downloads, `f${String(i).padStart(3, '0')}.txt`), 1);
    const listing = await new FileBrowser(folders).browse(folders.downloads);
    expect(listing.items).toHaveLength(400);
    expect(listing.truncated).toBe(true);
  });
});

// ============================================================================================ the actions
class Rig {
  calls: Array<{ name: string; args: ToolArgs }> = [];
  revealed: string[] = [];
  noted: ActivityInput[] = [];
  responder: (name: string, args: ToolArgs) => ToolResult = () => ({ ok: true, summary: 'ok' });
  service: FilesService;
  constructor(over: Partial<FilesDeps> = {}) {
    this.service = new FilesService({
      folders,
      browser: new FileBrowser(folders),
      invoke: async (name, args) => {
        this.calls.push({ name, args });
        return this.responder(name, args);
      },
      reveal: (p) => void this.revealed.push(p),
      thumbnail: async (p) => `data:image/png;base64,${Buffer.from(p).toString('base64').slice(0, 8)}`,
      activity: { record: (i) => void this.noted.push(i) },
      ...over,
    });
  }
}

describe('searching', () => {
  it('uses Eya\'s own find_file and shows what it found', async () => {
    const hit = put(join(folders.documents, 'Cause List 2026.pdf'), 5);
    const r = new Rig();
    // find_file reports whole kilobytes (0 for a small file); the list shows the file's real size and date.
    r.responder = () => ({ ok: true, summary: 'found', data: { files: [{ path: hit, name: 'Cause List 2026.pdf', sizeKB: 0, modified: '2026-10-08T11:55:00.000Z' }], truncated: true } });
    const listing = await r.service.search('  cause list ');
    expect(r.calls).toEqual([{ name: 'find_file', args: { query: 'cause list', limit: 40 } }]);
    expect(listing.title).toBe('Results for “cause list”');
    expect(listing.items).toEqual([{ path: hit, name: 'Cause List 2026.pdf', kind: 'document', ext: 'pdf', size: 1, modified: new Date(NOW - 5 * 60_000).toISOString(), where: 'Documents' }]);
    expect(listing.truncated).toBe(true);
  });

  it('drops results Eya may not touch or that would run a program', async () => {
    const ok = put(join(folders.documents, 'a.txt'), 1);
    const r = new Rig();
    r.responder = () => ({
      ok: true,
      summary: 'found',
      data: { files: [{ path: ok, modified: 'x' }, { path: join(folders.home, '.ssh', 'id_rsa'), modified: 'x' }, { path: join(folders.documents, 'setup.exe'), modified: 'x' }, { nope: 1 }, 'junk'] },
    });
    expect(names(await r.service.search('a'))).toEqual(['a.txt']);
  });

  it('asks for something to look for, and passes a failed search on in plain words', async () => {
    const r = new Rig();
    expect((await r.service.search('   ')).error).toContain('Type a file name');
    expect(r.calls).toEqual([]);
    r.responder = () => ({ ok: false, summary: 'failed', error: 'The index is not available.' });
    expect((await r.service.search('x')).error).toBe('The index is not available.');
  });
});

describe('opening and showing', () => {
  it('opens a file with open_file and a folder with open_folder, and notes it in the history by name only', async () => {
    const file = put(join(folders.documents, 'Contract.pdf'), 1);
    const r = new Rig();
    expect(await r.service.open(file)).toEqual({ ok: true, message: 'Opened Contract.pdf.' });
    expect(await r.service.open(folders.documents)).toEqual({ ok: true, message: 'Opened Documents.' });
    expect(r.calls).toEqual([
      { name: 'open_file', args: { path: file } },
      { name: 'open_folder', args: { folder: folders.documents } },
    ]);
    expect(r.noted).toEqual([
      { request: '', label: 'Opened "Contract.pdf"', tools: ['open_file'], ok: true },
      { request: '', label: 'Opened "Documents"', tools: ['open_folder'], ok: true },
    ]);
  });

  it('refuses what Eya may not open WITHOUT calling any tool, and says so when it is gone or Windows fails', async () => {
    const r = new Rig();
    const protectedFile = put(join(folders.home, '.ssh', 'id_rsa'), 1);
    expect((await r.service.open(protectedFile)).ok).toBe(false);
    expect((await r.service.open('C:\\Windows\\System32\\cmd.exe')).ok).toBe(false);
    expect((await r.service.open(join(folders.documents, 'gone.txt'))).message).toContain('gone');
    expect(r.calls).toEqual([]);
    const file = put(join(folders.documents, 'a.txt'), 1);
    r.responder = () => ({ ok: false, summary: 'could not open', error: 'Windows could not open that file.' });
    expect(await r.service.open(file)).toEqual({ ok: false, message: 'Windows could not open that file.' });
    expect(r.noted.at(-1)).toMatchObject({ ok: false });
  });

  it('shows a file in File Explorer, but not one that is protected or gone', async () => {
    const file = put(join(folders.documents, 'a.txt'), 1);
    const r = new Rig();
    expect((await r.service.reveal(file)).ok).toBe(true);
    expect(r.revealed).toEqual([file]);
    expect((await r.service.reveal(join(folders.home, '.ssh', 'id_rsa'))).ok).toBe(false);
    expect((await r.service.reveal(join(folders.documents, 'gone.txt'))).message).toContain('gone');
    expect(r.revealed).toEqual([file]);
  });
});

describe('asking Eya about a file', () => {
  it('has the file read through analyze_document, and returns the answer — never recording the question', async () => {
    const file = put(join(folders.documents, 'Contract.pdf'), 1);
    const r = new Rig();
    r.responder = () => ({ ok: true, summary: 'read it', data: { file: 'Contract.pdf', answer: 'It is a two-page rental agreement.' } });
    expect(await r.service.ask(file, 'What is the monthly rent?')).toEqual({ ok: true, message: 'Done.', answer: 'It is a two-page rental agreement.' });
    expect(r.calls).toEqual([{ name: 'analyze_document', args: { path: file, question: 'What is the monthly rent?' } }]);
    expect(JSON.stringify(r.noted)).not.toContain('rent');
    expect(r.noted).toEqual([{ request: '', label: 'Asked about "Contract.pdf"', tools: ['analyze_document'], ok: true }]);
  });

  it('summarizes when no question is given, and keeps questions short', async () => {
    const file = put(join(folders.documents, 'a.pdf'), 1);
    const r = new Rig();
    r.responder = () => ({ ok: true, summary: 'ok', data: { answer: 'x' } });
    await r.service.ask(file, '   ');
    await r.service.ask(file, 'q'.repeat(900));
    expect(r.calls[0]?.args['question']).toBe('Summarize the key points.');
    expect(String(r.calls[1]?.args['question'])).toHaveLength(300);
  });

  it('refuses a protected file without sending anything, and passes the tool\'s own reason on (a Word file, no key…)', async () => {
    const r = new Rig();
    expect((await r.service.ask(join(folders.home, '.ssh', 'id_rsa'), 'what')).ok).toBe(false);
    expect(r.calls).toEqual([]);
    const doc = put(join(folders.documents, 'a.docx'), 1);
    r.responder = () => ({ ok: false, summary: 'unsupported', error: 'Word and Excel files are not supported yet.' });
    expect(await r.service.ask(doc, 'what')).toEqual({ ok: false, message: 'Word and Excel files are not supported yet.' });
  });

  it('writes a file whose name looks private into the history as just "a file"', () => {
    expect(fileLabel('Opened', 'Contract.pdf')).toBe('Opened "Contract.pdf"');
    expect(fileLabel('Opened', 'my password list.txt')).toBe('Opened a file');
    expect(fileLabel('Asked about', 'invoice 9876543210.pdf')).toBe('Asked about a file');
    expect(fileLabel('Opened', 'x'.repeat(80) + '.pdf')).toMatch(/^Opened "x{47}…"$/);
  });
});

describe('an answer read from a file', () => {
  it('comes back as plain text: no asterisks, backticks or heading marks, bullets as bullets', () => {
    expect(plainText('The hearing is on **12 November 2026** in **Court Hall 4**.')).toBe('The hearing is on 12 November 2026 in Court Hall 4.');
    expect(plainText('## Summary\n* first point\n- second `point`\n')).toBe('Summary\n• first point\n• second point');
    expect(plainText('It is *very* important, and 2 * 3 stays.')).toBe('It is very important, and 2 * 3 stays.');
    expect(plainText('  nothing to change  ')).toBe('nothing to change');
  });

  it('is what the screen is given', async () => {
    const file = put(join(folders.documents, 'a.txt'), 1);
    const r = new Rig();
    r.responder = () => ({ ok: true, summary: 'ok', data: { answer: 'The total is **4,250 rupees**.' } });
    expect((await r.service.ask(file, 'total?')).answer).toBe('The total is 4,250 rupees.');
  });
});

describe('pictures for image files', () => {
  it('are made only for pictures Eya may read, a screenful at a time, skipping failures', async () => {
    const good = put(join(folders.pictures, 'a.png'), 1);
    const doc = put(join(folders.documents, 'b.pdf'), 1);
    const secret = put(join(folders.home, '.ssh', 'k.png'), 1);
    const made: string[] = [];
    const r = new Rig({
      thumbnail: async (p) => {
        made.push(p);
        if (p.endsWith('bad.png')) throw new Error('no thumbnail');
        return 'data:image/png;base64,AAAA';
      },
    });
    const out = await r.service.thumbnails([good, doc, secret, join(folders.pictures, 'bad.png'), 5 as unknown as string]);
    expect(out).toEqual({ [good]: 'data:image/png;base64,AAAA' });
    expect(made).toEqual([good, join(folders.pictures, 'bad.png')]);
    const many = Array.from({ length: 40 }, (_, i) => put(join(folders.pictures, `p${i}.png`), 1));
    expect(Object.keys(await r.service.thumbnails(many))).toHaveLength(24);
  });
});
