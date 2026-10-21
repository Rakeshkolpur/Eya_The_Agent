import { promises as fs } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { FileEntryView, FileKind, FilesListing, FilesView } from '@shared/ipcContract';
import { checkReadablePath, isBlockedDirName, isBlockedFileName, isExecutablePath, isSystemDirName } from '@main/security/pathPolicy';
import type { KnownFolders } from '@main/security/pathPolicy';

/** What counts as a document, and as a picture, for the Documents and Images tabs. */
export const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'md']);
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'svg', 'heic']);

const SKIPPED_DIRS = new Set(['node_modules', '__pycache__', '$recycle.bin']);
const JUNK_FILES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);
const LIMIT = { recent: 60, documents: 100, images: 100, folders: 24, browse: 400 } as const;

export function extOf(name: string): string {
  return extname(name).replace(/^\./, '').toLowerCase();
}

export function kindOf(name: string, isDirectory: boolean): FileKind {
  if (isDirectory) return 'folder';
  const ext = extOf(name);
  return DOCUMENT_EXTENSIONS.has(ext) ? 'document' : IMAGE_EXTENSIONS.has(ext) ? 'image' : 'other';
}

/** Hidden files, Office lock files, thumbnails databases and half-downloaded files: never worth listing. */
export function isJunkName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('.') || lower.startsWith('~$') || JUNK_FILES.has(lower) || /\.(tmp|temp|crdownload|part|partial)$/.test(lower);
}

function skipDirectory(name: string): boolean {
  return isJunkName(name) || SKIPPED_DIRS.has(name.toLowerCase()) || isBlockedDirName(name) || isSystemDirName(name);
}

function listable(name: string): boolean {
  return !isJunkName(name) && !isBlockedFileName(name) && !isExecutablePath(name);
}

interface Found {
  readonly path: string;
  readonly name: string;
  readonly isDirectory: boolean;
}

export interface BrowserOptions {
  /** How many directory entries to look at in all before stopping. */
  readonly maxVisited?: number;
  /** How many files to examine (size and date) in all. */
  readonly maxStats?: number;
  /** How long a scan may take. */
  readonly timeBudgetMs?: number;
}

/**
 * The lists on the Files screen. It only LOOKS at the user's own folders (names, sizes, dates — never what is inside a file), in a
 * bounded way: a cap on entries visited, files examined and time, so a huge folder tree can never freeze the screen. It does not follow
 * shortcuts or junctions, and it leaves out hidden and temporary files, anything that would run a program, secrets, and Windows internals.
 */
export class FileBrowser {
  constructor(
    private readonly folders: KnownFolders,
    private readonly options: BrowserOptions = {},
  ) {}

  // -------------------------------------------------------------------------------------------- the four tabs
  async list(view: FilesView): Promise<FilesListing> {
    const f = this.folders;
    switch (view) {
      case 'recent':
        return this.scanned('Recent', [f.desktop, f.documents, f.downloads, f.pictures], 2, () => true, LIMIT.recent);
      case 'documents':
        return this.scanned('Documents', [f.documents, f.desktop, f.downloads], 3, (ext) => DOCUMENT_EXTENSIONS.has(ext), LIMIT.documents);
      case 'images':
        return this.scanned('Images', [f.pictures, f.desktop, f.downloads], 3, (ext) => IMAGE_EXTENSIONS.has(ext), LIMIT.images);
      case 'folders':
        return this.foldersTab();
    }
  }

  private async scanned(title: string, roots: readonly string[], depth: number, accept: (ext: string) => boolean, limit: number): Promise<FilesListing> {
    const { found, truncated } = await this.walk(roots, depth, accept);
    const examined = await this.examine(found, this.options.maxStats ?? 3000);
    const items = examined.entries.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
    return { title, folder: null, parent: null, items: items.slice(0, limit), truncated: truncated || examined.truncated || items.length > limit };
  }

  /** Your usual folders, then the folders you have been working in lately. */
  private async foldersTab(): Promise<FilesListing> {
    const f = this.folders;
    const pinned = await this.examine(
      [f.desktop, f.documents, f.downloads, f.pictures, f.videos, f.music].map((p) => ({ path: p, name: basename(p), isDirectory: true })),
      50,
    );
    const seen = new Set(pinned.entries.map((e) => e.path.toLowerCase()));
    const lately: Found[] = [];
    for (const root of [f.documents, f.desktop, f.downloads, f.pictures]) {
      for (const entry of await this.readFolder(root)) if (entry.isDirectory) lately.push(entry);
    }
    const recent = await this.examine(lately.filter((l) => !seen.has(resolve(l.path).toLowerCase())), 200);
    const newest = recent.entries.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
    return {
      title: 'Folders',
      folder: null,
      parent: null,
      items: [...pinned.entries, ...newest.slice(0, LIMIT.folders)],
      truncated: newest.length > LIMIT.folders,
    };
  }

  // ---------------------------------------------------------------------------------------- one folder at a time
  async browse(dir: string): Promise<FilesListing> {
    const check = checkReadablePath(dir, this.folders);
    if (!check.ok) return this.empty('Folder', `I can't show that folder: ${check.reason}.`);
    let entries: Found[];
    try {
      entries = await this.readFolder(check.path, true);
    } catch {
      return this.empty(this.friendly(check.path), 'That folder could not be read. It may have moved or been deleted.');
    }
    const examined = await this.examine(entries.slice(0, LIMIT.browse), LIMIT.browse);
    const items = examined.entries.sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const up = dirname(check.path);
    const parent = up !== check.path && checkReadablePath(up, this.folders).ok ? up : null;
    return { title: this.friendly(check.path), folder: check.path, parent, items, truncated: entries.length > LIMIT.browse || examined.truncated };
  }

  // ------------------------------------------------------------------------------------------------- helpers
  /** The entries of one folder that are worth listing (folders and ordinary files). */
  private async readFolder(dir: string, withFiles = false): Promise<Found[]> {
    const read = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (read === null) {
      if (withFiles) throw new Error('unreadable');
      return [];
    }
    const out: Found[] = [];
    for (const e of read) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!skipDirectory(e.name)) out.push({ path: join(dir, e.name), name: e.name, isDirectory: true });
      } else if (withFiles && e.isFile() && listable(e.name)) {
        out.push({ path: join(dir, e.name), name: e.name, isDirectory: false });
      }
    }
    return out;
  }

  /** Walks the roots breadth-first, to the given depth, collecting the files `accept` likes. */
  private async walk(roots: readonly string[], depth: number, accept: (ext: string) => boolean): Promise<{ found: Found[]; truncated: boolean }> {
    const maxVisited = this.options.maxVisited ?? 20_000;
    const deadline = Date.now() + (this.options.timeBudgetMs ?? 2_500);
    const queue: Array<{ dir: string; depth: number }> = roots.map((dir) => ({ dir, depth: 0 }));
    const visitedDirs = new Set<string>();
    const found: Found[] = [];
    let visited = 0;
    let truncated = false;
    scan: while (queue.length > 0) {
      if (visited > maxVisited || Date.now() > deadline) {
        truncated = true;
        break;
      }
      const next = queue.shift();
      if (next === undefined) break;
      const key = resolve(next.dir).toLowerCase();
      if (visitedDirs.has(key)) continue;
      visitedDirs.add(key);
      const read: Dirent[] | null = await fs.readdir(next.dir, { withFileTypes: true }).catch(() => null);
      if (read === null) continue;
      for (const e of read) {
        visited += 1;
        // Counted entry by entry, so one enormous folder cannot run past the limit before it is noticed.
        if (visited > maxVisited) {
          truncated = true;
          break scan;
        }
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (next.depth < depth && !skipDirectory(e.name)) queue.push({ dir: join(next.dir, e.name), depth: next.depth + 1 });
        } else if (e.isFile() && listable(e.name) && accept(extOf(e.name))) {
          found.push({ path: join(next.dir, e.name), name: e.name, isDirectory: false });
        }
      }
    }
    return { found, truncated };
  }

  /** Size and date for each (in small batches): the part of a listing that costs a trip to the disk per item. */
  private async examine(items: readonly Found[], cap: number): Promise<{ entries: FileEntryView[]; truncated: boolean }> {
    const take = items.slice(0, cap);
    const entries: FileEntryView[] = [];
    for (let i = 0; i < take.length; i += 40) {
      const batch = await Promise.all(
        take.slice(i, i + 40).map(async (item) => {
          const stat: Stats | null = await fs.stat(item.path).catch(() => null);
          if (stat === null || stat.isDirectory() !== item.isDirectory) return null;
          return this.view(item, stat);
        }),
      );
      for (const e of batch) if (e !== null) entries.push(e);
    }
    return { entries, truncated: items.length > cap };
  }

  private view(item: Found, stat: Stats): FileEntryView {
    return {
      path: item.path,
      name: item.name,
      kind: kindOf(item.name, item.isDirectory),
      ext: item.isDirectory ? '' : extOf(item.name),
      size: item.isDirectory ? 0 : stat.size,
      modified: stat.mtime.toISOString(),
      where: this.friendly(dirname(item.path)),
    };
  }

  /** "Documents", "Downloads"… for the usual folders; any other folder by its own name. */
  friendly(path: string): string {
    const key = resolve(path).toLowerCase();
    const known: Array<[string, string]> = [
      [this.folders.desktop, 'Desktop'],
      [this.folders.documents, 'Documents'],
      [this.folders.downloads, 'Downloads'],
      [this.folders.pictures, 'Pictures'],
      [this.folders.videos, 'Videos'],
      [this.folders.music, 'Music'],
      [this.folders.home, 'Home'],
    ];
    for (const [folder, label] of known) if (resolve(folder).toLowerCase() === key) return label;
    return basename(path) || path;
  }

  private empty(title: string, error: string): FilesListing {
    return { title, folder: null, parent: null, items: [], truncated: false, error };
  }
}
