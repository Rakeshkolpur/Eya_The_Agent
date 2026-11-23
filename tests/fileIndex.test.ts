import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileIndex, normalizeForMatch } from '../src/main/local/FileIndex';
import type { Watcher } from '../src/main/local/FileIndex';

let root: string;
const indexes: FileIndex[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eya-index-'));
});
afterEach(() => {
  for (const i of indexes.splice(0)) i.stop();
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, text = 'x', modified?: Date): string {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  if (modified !== undefined) utimesSync(path, modified, modified);
  return path;
}

async function built(options: Partial<ConstructorParameters<typeof FileIndex>[0]> = {}): Promise<FileIndex> {
  const index = new FileIndex({ roots: [root], watch: null, rescanEveryMs: 0, ...options });
  indexes.push(index);
  await index.build();
  return index;
}

const names = (hits: { name: string }[] | readonly { name: string }[]): string[] => hits.map((h) => h.name);

describe('FileIndex search', () => {
  it('finds files by every word in the name, ignoring case and accents', async () => {
    put('Documents/Résumé 2025.pdf');
    put('Documents/Invoice March.pdf');
    put('Documents/invoice-april.PDF');
    const index = await built();
    expect(names(index.search({ tokens: ['resume'], limit: 10 }).files)).toEqual(['Résumé 2025.pdf']);
    expect(index.search({ tokens: ['invoice'], limit: 10 }).total).toBe(2);
    expect(index.search({ tokens: ['invoice', 'april'], limit: 10 }).total).toBe(1);
    expect(index.search({ tokens: ['nothing'], limit: 10 }).total).toBe(0);
    expect(normalizeForMatch('Résumé')).toBe('resume');
  });

  it('filters by type, folder and date', async () => {
    put('a/report.pdf', 'x', new Date('2026-01-10T12:00:00Z'));
    put('a/report.docx', 'x', new Date('2026-02-10T12:00:00Z'));
    put('b/report.pdf', 'x', new Date('2026-03-10T12:00:00Z'));
    const index = await built();
    expect(index.search({ tokens: ['report'], extensions: ['pdf'], limit: 10 }).total).toBe(2);
    expect(index.search({ tokens: ['report'], extensions: ['.docx', 'xlsx'], limit: 10 }).total).toBe(1);
    expect(index.search({ tokens: ['report'], folder: join(root, 'b'), limit: 10 }).total).toBe(1);
    // a folder filter means that folder and below, never a folder whose name merely starts the same
    mkdirSync(join(root, 'bb'));
    put('bb/report.pdf');
    await index.build();
    expect(index.search({ tokens: ['report'], folder: join(root, 'b'), limit: 10 }).total).toBe(1);
    const feb = index.search({ tokens: [], modifiedFrom: new Date('2026-02-01T00:00:00Z'), modifiedTo: new Date('2026-03-01T00:00:00Z'), limit: 10 });
    expect(names(feb.files)).toEqual(['report.docx']);
  });

  it('puts the newest first, or the best name match first', async () => {
    put('old.pdf', 'x', new Date('2025-01-01T00:00:00Z'));
    put('mid.pdf', 'x', new Date('2025-06-01T00:00:00Z'));
    put('new.pdf', 'x', new Date('2026-01-01T00:00:00Z'));
    const index = await built();
    expect(names(index.search({ tokens: [], extensions: ['pdf'], limit: 10 }).files)).toEqual(['new.pdf', 'mid.pdf', 'old.pdf']);
    expect(names(index.search({ tokens: [], extensions: ['pdf'], sort: 'name', limit: 10 }).files)).toEqual(['mid.pdf', 'new.pdf', 'old.pdf']);

    put('x/resume.pdf', 'x', new Date('2025-01-01T00:00:00Z')); // exact name, but old
    put('x/resume backup final copy.pdf', 'x', new Date('2026-06-01T00:00:00Z')); // newer, longer name
    put('x/resumed.pdf', 'x', new Date('2026-07-01T00:00:00Z')); // only contains the word inside another
    await index.build();
    const best = index.search({ tokens: ['resume'], limit: 10 }).files;
    expect(best[0]?.name).toBe('resume.pdf');
    expect(best[0]?.score).toBeGreaterThan(best[1]?.score ?? 0);
    expect(names(best)).toEqual(['resume.pdf', 'resume backup final copy.pdf', 'resumed.pdf']);
    // two equally good matches really are a tie (so a caller can tell "clearly the one" from "several")
    put('y/budget.xlsx');
    put('z/budget.xlsx');
    await index.build();
    const tie = index.search({ tokens: ['budget'], limit: 10 }).files;
    expect(tie[0]?.score).toBe(tie[1]?.score);
  });

  it('limits what it returns but reports how many matched', async () => {
    for (let i = 0; i < 12; i += 1) put(`many/file ${i}.txt`);
    const index = await built();
    const result = index.search({ tokens: ['file'], limit: 5 });
    expect(result.files).toHaveLength(5);
    expect(result.total).toBe(12);
  });
});

describe('FileIndex scope', () => {
  it('stays out of secrets, programs, junk and protected folders', async () => {
    put('ok/notes.txt');
    put('ok/.env');
    put('ok/id_rsa');
    put('ok/server.pem');
    put('ok/setup.exe');
    put('ok/run.ps1');
    put('ok/~$notes.docx');
    put('ok/desktop.ini');
    put('ok/app.asar'); // Electron opens (and keeps open) an archive it is merely asked about
    put('node_modules/pkg/index.txt');
    put('.git/config.txt');
    put('.hidden/secret.txt');
    put('AppData/Local/thing.txt');
    put('.ssh/known.txt');
    put('Windows/system.txt');
    const index = await built();
    expect(names(index.search({ tokens: [], limit: 50 }).files)).toEqual(['notes.txt']);
  });

  it('does not follow a junction out of its folders', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'eya-outside-'));
    try {
      writeFileSync(join(outside, 'private.txt'), 'x');
      put('real/visible.txt');
      try {
        symlinkSync(outside, join(root, 'link'), 'junction');
      } catch {
        return; // cannot make a junction here: nothing to test
      }
      const index = await built();
      expect(names(index.search({ tokens: [], limit: 50 }).files)).toEqual(['visible.txt']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('stops at its limit and says so', async () => {
    for (let i = 0; i < 30; i += 1) put(`f${i}.txt`);
    const index = await built({ maxFiles: 10 });
    expect(index.status().files).toBeLessThanOrEqual(10);
    expect(index.status().truncated).toBe(true);
  });

  it('does not read a root inside another root twice', async () => {
    put('inner/once.txt');
    const index = await built({ roots: [root, join(root, 'inner')] });
    expect(index.search({ tokens: ['once'], limit: 10 }).total).toBe(1);
  });

  it('copes with a root that does not exist', async () => {
    const index = await built({ roots: [join(root, 'nope')] });
    expect(index.status().ready).toBe(true);
    expect(index.status().files).toBe(0);
  });
});

describe('FileIndex folders', () => {
  it('finds a folder by name, exact names first and nearer the top first', async () => {
    mkdirSync(join(root, 'Cases'), { recursive: true });
    mkdirSync(join(root, 'Old', 'Archive', 'Cases'), { recursive: true });
    mkdirSync(join(root, 'Cases Backup'), { recursive: true });
    const index = await built();
    const found = index.searchFolders(['cases']);
    expect(found[0]?.path).toBe(join(root, 'Cases'));
    expect(found.map((f) => f.name)).toContain('Cases Backup');
    expect(found[0]?.score).toBeGreaterThan(found[found.length - 1]?.score ?? 99);
    expect(index.searchFolders([])).toEqual([]);
    expect(index.searchFolders(['zzz'])).toEqual([]);
  });
});

describe('FileIndex staying current', () => {
  function fakeWatch(): { watch: (r: string, cb: (rel: string) => void) => Watcher; fire: (rel: string) => void; closed: () => number } {
    let callback: ((rel: string) => void) | null = null;
    let closed = 0;
    return {
      watch: (_r, cb) => {
        callback = cb;
        return { close: () => void (closed += 1) };
      },
      fire: (rel) => callback?.(rel),
      closed: () => closed,
    };
  }
  const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

  it('notices a new, changed and removed file', async () => {
    put('keep.txt');
    const w = fakeWatch();
    const index = await built({ watch: w.watch, settleMs: 5 });
    expect(index.search({ tokens: ['fresh'], limit: 5 }).total).toBe(0);

    put('sub/fresh.txt');
    w.fire(join('sub', 'fresh.txt'));
    await settle();
    expect(names(index.search({ tokens: ['fresh'], limit: 5 }).files)).toEqual(['fresh.txt']);

    rmSync(join(root, 'sub', 'fresh.txt'));
    w.fire(join('sub', 'fresh.txt'));
    await settle();
    expect(index.search({ tokens: ['fresh'], limit: 5 }).total).toBe(0);
    expect(index.search({ tokens: ['keep'], limit: 5 }).total).toBe(1);
  });

  it('drops everything under a folder that is deleted, and reads a folder that arrives', async () => {
    put('tree/a.txt');
    put('tree/deep/b.txt');
    const w = fakeWatch();
    const index = await built({ watch: w.watch, settleMs: 5 });
    expect(index.search({ tokens: [], limit: 10 }).total).toBe(2);

    rmSync(join(root, 'tree'), { recursive: true });
    w.fire('tree');
    await settle();
    expect(index.search({ tokens: [], limit: 10 }).total).toBe(0);
    expect(index.searchFolders(['tree'])).toEqual([]);

    put('arrived/one.txt');
    put('arrived/inner/two.txt');
    w.fire('arrived');
    await settle(120);
    expect(index.search({ tokens: [], limit: 10 }).total).toBe(2);
    expect(index.searchFolders(['inner'])).toHaveLength(1);
  });

  it('ignores changes inside folders it stays out of', async () => {
    const w = fakeWatch();
    const index = await built({ watch: w.watch, settleMs: 5 });
    put('node_modules/pkg/x.txt');
    put('.git/y.txt');
    w.fire(join('node_modules', 'pkg', 'x.txt'));
    w.fire(join('.git', 'y.txt'));
    await settle();
    expect(index.status().files).toBe(0);
  });

  it('can be brought up to date by reading again', async () => {
    const index = await built();
    put('late.txt');
    expect(index.search({ tokens: ['late'], limit: 5 }).total).toBe(0);
    await index.build();
    expect(index.search({ tokens: ['late'], limit: 5 }).total).toBe(1);
  });

  it('closes its watchers when stopped', async () => {
    const w = fakeWatch();
    const index = await built({ watch: w.watch });
    index.stop();
    expect(w.closed()).toBe(1);
  });
});

describe('FileIndex readiness', () => {
  it('says when it is ready, and gives up waiting if it never is', async () => {
    const index = new FileIndex({ roots: [root], watch: null, rescanEveryMs: 0 });
    indexes.push(index);
    expect(index.ready).toBe(false);
    expect(await index.whenReady(20)).toBe(false);
    const waiting = index.whenReady(2000);
    await index.build();
    expect(await waiting).toBe(true);
    expect(index.ready).toBe(true);
  });

  it('starts in the background after a delay', async () => {
    put('a.txt');
    const index = new FileIndex({ roots: [root], watch: null, rescanEveryMs: 0 });
    indexes.push(index);
    index.start(10);
    expect(index.ready).toBe(false);
    expect(await index.whenReady(3000)).toBe(true);
    expect(index.status().files).toBe(1);
  });
});

describe('FileIndex speed', () => {
  it('searches thousands of names in a few milliseconds', async () => {
    for (let d = 0; d < 20; d += 1) for (let f = 0; f < 250; f += 1) put(`d${d}/file ${f} ${f % 7 === 0 ? 'invoice' : 'misc'}.pdf`);
    const index = await built();
    expect(index.status().files).toBe(5000);
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) index.search({ tokens: ['invoice'], extensions: ['pdf'], limit: 5 });
    const each = (performance.now() - started) / 20;
    expect(each).toBeLessThan(25); // generous: it measures ~1 ms; this only catches it turning into a disk read
  }, 60_000);
});
