import { promises as fsp, watch as fsWatch } from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { rootLogger } from '@main/logging/logger';
import { isBlockedDirName, isBlockedFileName, isExecutablePath, isSystemDirName } from '@main/security/pathPolicy';

const log = rootLogger.child('fileindex');

/**
 * A name index of the user's own folders, kept in memory.
 *
 * Asking Windows' search index costs a fresh PowerShell every time (about 350-500 ms before it has looked at anything), so a
 * spoken "find my resume" was slower than the question deserved. This is built once in the background, kept current by the file
 * system's own change notifications, and searched in about a millisecond.
 *
 * It holds NAMES, sizes and dates only (never contents), and only what the assistant is allowed to look at anyway: the same
 * folders the Files screen lists, minus secrets, program internals and programs themselves. When it finds nothing the caller
 * falls back to the slower whole-PC search, so being incomplete only ever costs time, never a wrong "no such file".
 */

export interface IndexedFile {
  readonly path: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly modifiedMs: number;
}

export interface IndexedFolder {
  readonly path: string;
  readonly name: string;
  readonly modifiedMs: number;
}

interface FileEntry extends IndexedFile {
  /** The name, lower-cased with accents removed: what a search is compared against. */
  readonly key: string;
  readonly ext: string;
}

interface FolderEntry extends IndexedFolder {
  readonly key: string;
}

export interface IndexQuery {
  /** Every one of these must appear in the name. */
  readonly tokens: readonly string[];
  /** Any one of these (no dot) counts; undefined means any type. */
  readonly extensions?: readonly string[];
  /** Only inside this folder (and below it). */
  readonly folder?: string;
  readonly sort?: 'best' | 'newest' | 'name';
  readonly limit: number;
  readonly modifiedFrom?: Date;
  readonly modifiedTo?: Date;
}

export interface IndexHit extends IndexedFile {
  /** How well the name matches (higher is better); equal scores are a genuine tie. */
  readonly score: number;
}

export interface IndexResult {
  readonly files: readonly IndexHit[];
  /** How many files matched in all, of which `files` is the first few. */
  readonly total: number;
}

export interface IndexStatus {
  readonly ready: boolean;
  readonly files: number;
  readonly folders: number;
  /** The folder list was cut short at the limit, so a miss does not prove a file is absent. */
  readonly truncated: boolean;
  readonly lastBuildMs: number;
}

/** What the index needs from the file system; real by default, replaceable in tests. */
export interface IndexFs {
  readdir(dir: string): Promise<Dirent[]>;
  stat(path: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean; isDirectory(): boolean }>;
}

export interface Watcher {
  close(): void;
}

export interface FileIndexOptions {
  readonly roots: readonly string[];
  readonly maxFiles?: number;
  readonly maxDepth?: number;
  readonly fs?: IndexFs;
  /** Starts a recursive watch on a root; `onChange` gets the changed path relative to it. Undefined to not watch. */
  readonly watch?: ((root: string, onChange: (relative: string) => void) => Watcher) | null;
  /** How long to wait after a change before reading it, so a burst of changes is one update. */
  readonly settleMs?: number;
  /** A full re-read every so often, in case a change notification was missed. 0 turns it off. */
  readonly rescanEveryMs?: number;
}

const DEFAULT_MAX_FILES = 100_000;
const DEFAULT_MAX_DEPTH = 10;
const STAT_BATCH = 64;
const SLICE_MS = 8;
const DEFAULT_SETTLE_MS = 400;
const DEFAULT_RESCAN_MS = 30 * 60_000;
const MAX_DIRTY_BEFORE_RESCAN = 300;

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '$recycle.bin']);

const realFs: IndexFs = {
  readdir: (dir) => fsp.readdir(dir, { withFileTypes: true }),
  stat: (path) => fsp.stat(path),
};

function realWatch(root: string, onChange: (relative: string) => void): Watcher {
  const watcher = fsWatch(root, { recursive: true, persistent: false }, (_event, filename) => {
    if (typeof filename === 'string' && filename.length > 0) onChange(filename);
  });
  // A watch can die when its folder is removed or becomes unreadable; the periodic re-read keeps the index right regardless.
  watcher.on('error', () => watcher.close());
  return watcher;
}

/** Lower-case, accents removed: "Résumé" and "resume" are the same word to someone speaking. */
export function normalizeForMatch(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function wordsOf(key: string): string[] {
  return key.split(/[^a-z0-9]+/).filter((w) => w.length > 0);
}

function skippedDir(name: string): boolean {
  const lower = name.toLowerCase();
  return SKIP_DIR_NAMES.has(lower) || name.startsWith('.') || isBlockedDirName(name) || isSystemDirName(name);
}

function skippedFile(name: string): boolean {
  // An ".asar" is an app's packed code. Electron treats the path as a folder, so merely reading its details opens the archive and keeps
  // it open until Eya exits (which blocks deleting or rebuilding that app); nobody asks for one by name anyway.
  return name.startsWith('~$') || isBlockedFileName(name) || isExecutablePath(name) || /^(desktop\.ini|thumbs\.db)$/i.test(name) || /\.asar$/i.test(name);
}

/** Whether any folder on the way to `relativePath` is one the index stays out of. */
function insideSkippedDir(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/).filter((p) => p.length > 0);
  return parts.slice(0, -1).some(skippedDir);
}

export class FileIndex {
  private files = new Map<string, FileEntry>();
  private folders = new Map<string, FolderEntry>();
  private readonly roots: string[];
  private readonly maxFiles: number;
  private readonly maxDepth: number;
  private readonly fs: IndexFs;
  private readonly watchFn: ((root: string, onChange: (relative: string) => void) => Watcher) | null;
  private readonly settleMs: number;
  private readonly rescanEveryMs: number;
  private readonly watchers: Watcher[] = [];
  private readonly dirty = new Set<string>();
  private settleTimer: NodeJS.Timeout | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private scanning: Promise<void> | null = null;
  private rescanWanted = false;
  private builtOnce = false;
  private truncated = false;
  private lastBuildMs = 0;
  private stopped = false;
  private waiters: Array<() => void> = [];

  constructor(options: FileIndexOptions) {
    // A root inside another root would be read twice.
    const resolved = [...new Set(options.roots.map((r) => resolve(r)))];
    this.roots = resolved.filter((r) => !resolved.some((other) => other !== r && r.toLowerCase().startsWith(other.toLowerCase() + sep)));
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.fs = options.fs ?? realFs;
    this.watchFn = options.watch === undefined ? realWatch : options.watch;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.rescanEveryMs = options.rescanEveryMs ?? DEFAULT_RESCAN_MS;
  }

  /** Builds the index in the background, after `delayMs` so it does not compete with the app starting up. */
  start(delayMs = 0): void {
    if (this.stopped || this.startTimer !== null || this.builtOnce || this.scanning !== null) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.build();
    }, delayMs);
    this.startTimer.unref?.();
  }

  /** Reads every root now and resolves when the index is usable. Safe to call again: it just reads again. */
  async build(): Promise<void> {
    if (this.stopped) return;
    if (this.scanning !== null) {
      this.rescanWanted = true;
      return this.scanning;
    }
    this.scanning = this.scanAll()
      .catch((err) => log.warn('file index build failed', { err: String(err) }))
      .finally(() => {
        this.scanning = null;
        if (this.rescanWanted && !this.stopped) {
          this.rescanWanted = false;
          void this.build();
        }
      });
    return this.scanning;
  }

  status(): IndexStatus {
    return { ready: this.builtOnce, files: this.files.size, folders: this.folders.size, truncated: this.truncated, lastBuildMs: this.lastBuildMs };
  }

  get ready(): boolean {
    return this.builtOnce;
  }

  /** Resolves true once the first build is done, or false after `timeoutMs`. */
  whenReady(timeoutMs: number): Promise<boolean> {
    if (this.builtOnce) return Promise.resolve(true);
    return new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolvePromise(false);
      }, timeoutMs);
      timer.unref?.();
      const done = (): void => {
        clearTimeout(timer);
        resolvePromise(true);
      };
      this.waiters.push(done);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    if (this.rescanTimer !== null) clearInterval(this.rescanTimer);
    for (const w of this.watchers.splice(0)) {
      try {
        w.close();
      } catch {
        // already closed
      }
    }
    this.files.clear();
    this.folders.clear();
    this.dirty.clear();
    this.waiters.forEach((w) => w());
    this.waiters = [];
  }

  /** Files whose names match. All of it is in memory: this does not touch the disk. */
  search(query: IndexQuery): IndexResult {
    const tokens = query.tokens.map(normalizeForMatch).filter((t) => t.length > 0);
    const extensions = query.extensions?.map((e) => e.replace(/^\./, '').toLowerCase());
    const prefix = query.folder === undefined ? undefined : resolve(query.folder).toLowerCase() + sep;
    const from = query.modifiedFrom?.getTime();
    const to = query.modifiedTo?.getTime();
    const joined = tokens.join(' ');
    const hits: IndexHit[] = [];
    for (const e of this.files.values()) {
      if (extensions !== undefined && !extensions.includes(e.ext)) continue;
      if (from !== undefined && e.modifiedMs < from) continue;
      if (to !== undefined && e.modifiedMs >= to) continue;
      let ok = true;
      for (const t of tokens) {
        if (!e.key.includes(t)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (prefix !== undefined && !e.path.toLowerCase().startsWith(prefix)) continue;
      hits.push({ path: e.path, name: e.name, sizeBytes: e.sizeBytes, modifiedMs: e.modifiedMs, score: tokens.length === 0 ? 0 : scoreName(e.key, tokens, joined) });
    }
    const sort = query.sort ?? (tokens.length === 0 ? 'newest' : 'best');
    if (sort === 'name') hits.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'newest') hits.sort((a, b) => b.modifiedMs - a.modifiedMs);
    else hits.sort((a, b) => b.score - a.score || b.modifiedMs - a.modifiedMs);
    return { files: hits.slice(0, Math.max(1, query.limit)), total: hits.length };
  }

  /** Folders whose names match, best first (an exact name, then one that starts with it, nearer the top first). */
  searchFolders(tokens: readonly string[], limit = 5): readonly (IndexedFolder & { readonly score: number })[] {
    const wanted = tokens.map(normalizeForMatch).filter((t) => t.length > 0);
    if (wanted.length === 0) return [];
    const joined = wanted.join(' ');
    const found: Array<IndexedFolder & { score: number; depth: number }> = [];
    for (const f of this.folders.values()) {
      if (!wanted.every((t) => f.key.includes(t))) continue;
      const stem = wordsOf(f.key).join(' ');
      const score = (stem === joined ? 10 : f.key.startsWith(wanted[0] ?? '') ? 4 : 0) + wanted.filter((t) => wordsOf(f.key).includes(t)).length * 2;
      found.push({ path: f.path, name: f.name, modifiedMs: f.modifiedMs, score, depth: f.path.split(sep).length });
    }
    found.sort((a, b) => b.score - a.score || a.depth - b.depth || b.modifiedMs - a.modifiedMs);
    return found.slice(0, limit).map(({ depth: _depth, ...rest }) => rest);
  }

  // ---------------------------------------------------------------- reading the disk

  private async scanAll(): Promise<void> {
    const started = Date.now();
    const files = new Map<string, FileEntry>();
    const folders = new Map<string, FolderEntry>();
    this.truncated = false;
    for (const root of this.roots) {
      if (this.stopped) return;
      await this.scanTree(root, 0, files, folders);
    }
    if (this.stopped) return;
    this.files = files;
    this.folders = folders;
    this.lastBuildMs = Date.now() - started;
    const firstTime = !this.builtOnce;
    this.builtOnce = true;
    log.info('file index built', { files: files.size, folders: folders.size, ms: this.lastBuildMs, truncated: this.truncated });
    if (firstTime) {
      this.startWatching();
      this.waiters.splice(0).forEach((w) => w());
    }
  }

  /** Reads one folder tree into the given maps, breadth first, giving the rest of the app a turn every few milliseconds. */
  private async scanTree(start: string, depth: number, files: Map<string, FileEntry>, folders: Map<string, FolderEntry>): Promise<void> {
    const queue: Array<{ dir: string; depth: number }> = [{ dir: start, depth }];
    let sliceStart = Date.now();
    const maybeYield = async (): Promise<void> => {
      if (Date.now() - sliceStart >= SLICE_MS) {
        await new Promise<void>((r) => setImmediate(r));
        sliceStart = Date.now();
      }
    };
    while (queue.length > 0 && !this.stopped) {
      const next = queue.shift();
      if (next === undefined) break;
      let entries: Dirent[];
      try {
        entries = await this.fs.readdir(next.dir);
      } catch {
        continue; // unreadable: skip it
      }
      const pending: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (next.depth + 1 > this.maxDepth || skippedDir(entry.name)) continue;
          const path = join(next.dir, entry.name);
          queue.push({ dir: path, depth: next.depth + 1 });
          folders.set(path.toLowerCase(), { path, name: entry.name, key: normalizeForMatch(entry.name), modifiedMs: 0 });
        } else if (entry.isFile() && !skippedFile(entry.name)) {
          if (files.size + pending.length >= this.maxFiles) {
            this.truncated = true;
            break;
          }
          pending.push(entry.name);
        }
      }
      for (let i = 0; i < pending.length; i += STAT_BATCH) {
        const batch = pending.slice(i, i + STAT_BATCH);
        await Promise.all(
          batch.map(async (name) => {
            const path = join(next.dir, name);
            try {
              const s = await this.fs.stat(path);
              if (s.isFile()) files.set(path.toLowerCase(), makeFileEntry(path, name, s.size, s.mtimeMs));
            } catch {
              // gone between listing and reading
            }
          }),
        );
        await maybeYield();
      }
      await maybeYield();
    }
  }

  // ------------------------------------------------------------ staying current

  private startWatching(): void {
    if (this.stopped) return;
    if (this.watchFn !== null) {
      for (const root of this.roots) {
        try {
          this.watchers.push(this.watchFn(root, (relative) => this.noteChange(root, relative)));
        } catch (err) {
          // A folder that is not there (no Videos folder, say) is ordinary; anything else is worth a line. Either way the periodic
          // re-read still keeps the index right.
          const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
          (missing ? log.debug : log.warn).call(log, 'could not watch a folder; relying on periodic re-reads', { err: String(err) });
        }
      }
    }
    if (this.rescanEveryMs > 0) {
      this.rescanTimer = setInterval(() => void this.build(), this.rescanEveryMs);
      this.rescanTimer.unref?.();
    }
  }

  private noteChange(root: string, relative: string): void {
    if (this.stopped || insideSkippedDir(relative)) return;
    this.dirty.add(join(root, relative));
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      void this.applyChanges();
    }, this.settleMs);
    this.settleTimer.unref?.();
  }

  private async applyChanges(): Promise<void> {
    const paths = [...this.dirty];
    this.dirty.clear();
    if (paths.length > MAX_DIRTY_BEFORE_RESCAN) {
      void this.build(); // a mass change (a folder copied in or cleared out) is cheaper to re-read than to patch
      return;
    }
    for (const path of paths) {
      if (this.stopped) return;
      await this.refreshPath(path);
    }
  }

  /** Brings the index in line with what is on disk at `path` right now. */
  async refreshPath(path: string): Promise<void> {
    const key = path.toLowerCase();
    const name = basename(path);
    let stat;
    try {
      stat = await this.fs.stat(path);
    } catch {
      this.forget(key);
      return;
    }
    if (stat.isDirectory()) {
      if (skippedDir(name)) return;
      this.folders.set(key, { path, name, key: normalizeForMatch(name), modifiedMs: stat.mtimeMs });
      // A folder that has just appeared (copied or moved in) arrives with its contents; read them.
      const files = new Map<string, FileEntry>();
      const folders = new Map<string, FolderEntry>();
      await this.scanTree(path, 0, files, folders);
      for (const [k, v] of files) if (this.files.size < this.maxFiles) this.files.set(k, v);
      for (const [k, v] of folders) this.folders.set(k, v);
      return;
    }
    const root = this.roots.find((r) => key.startsWith(r.toLowerCase() + sep));
    // Only what sits under one of the roots, and not inside a folder the index stays out of (judged below the root: the root's own
    // path may well pass through a folder with such a name, and that is fine).
    if (root !== undefined && stat.isFile() && !skippedFile(name) && !insideSkippedDir(path.slice(root.length + 1))) {
      if (this.files.size >= this.maxFiles && !this.files.has(key)) return;
      this.files.set(key, makeFileEntry(path, name, stat.size, stat.mtimeMs));
    } else {
      this.forget(key);
    }
  }

  /** Removes a file, or a folder and everything under it. */
  private forget(key: string): void {
    this.files.delete(key);
    if (this.folders.delete(key)) {
      const under = key + sep;
      for (const k of [...this.files.keys()]) if (k.startsWith(under)) this.files.delete(k);
      for (const k of [...this.folders.keys()]) if (k.startsWith(under)) this.folders.delete(k);
    }
  }

  /** Used by tests: the folder a path sits in. */
  static folderOf(path: string): string {
    return dirname(path);
  }
}

function makeFileEntry(path: string, name: string, sizeBytes: number, modifiedMs: number): FileEntry {
  return { path, name, key: normalizeForMatch(name), ext: extname(name).replace(/^\./, '').toLowerCase(), sizeBytes, modifiedMs };
}

/**
 * How well a file name matches what was asked for. The name being exactly the words asked for beats the words appearing whole,
 * which beats them appearing inside longer words; ties are left as ties so a caller can tell "clearly the one" from "several".
 */
function scoreName(key: string, tokens: readonly string[], joined: string): number {
  const dot = key.lastIndexOf('.');
  const stem = dot > 0 ? key.slice(0, dot) : key;
  const words = wordsOf(stem);
  let score = 0;
  if (words.join(' ') === joined) score += 8;
  for (const t of tokens) {
    if (words.includes(t)) score += 2;
    else if (words.some((w) => w.startsWith(t))) score += 1;
  }
  return score;
}
