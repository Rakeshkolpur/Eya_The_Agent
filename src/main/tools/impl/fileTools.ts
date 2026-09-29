import { promises as fs } from 'node:fs';
import { extname, join } from 'node:path';
import {
  checkPath,
  isBlockedDirName,
  isBlockedFileName,
  resolveFolder,
} from '@main/security/pathPolicy';
import type { KnownFolders } from '@main/security/pathPolicy';
import { WHEN_VALUES, parseDateOnly, resolveWhen } from '../dateQuery';
import type { WhenValue } from '../dateQuery';
import type { Tool, ToolArgs, ToolResult } from '../types';

const MAX_DEPTH = 4;
const MAX_VISITED = 20_000;
const SEARCH_BUDGET_MS = 4000;
const MAX_MATCHES_KEPT = 500;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', '.git']);

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.tsv', '.json', '.log', '.xml', '.html', '.htm', '.yml', '.yaml',
  '.ini', '.cfg', '.toml', '.rtf', '.tex', '.sql', '.js', '.ts', '.tsx', '.jsx', '.py', '.java',
  '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.css', '.bat', '.ps1', '.sh',
]);
const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_READ_CHARS = 24_000;

export interface FoundFile {
  readonly path: string;
  readonly name: string;
  readonly sizeKB: number;
  readonly modified: string;
}

export interface FindOptions {
  readonly tokens: readonly string[];
  /** Any one of these (case-insensitive, no dot) counts as a match; undefined means any extension. */
  readonly extensions: readonly string[] | undefined;
  readonly sort: 'newest' | 'name';
  readonly limit: number;
  readonly minSizeKB?: number;
  readonly maxSizeKB?: number;
  /** Matched against last-modified time: [from, to). */
  readonly modifiedFrom?: Date;
  readonly modifiedTo?: Date;
}

/** Natural type names a person actually says, mapped to the extensions that mean. */
export const FILE_TYPE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  pdf: ['pdf'],
  word: ['doc', 'docx'],
  excel: ['xls', 'xlsx'],
  powerpoint: ['ppt', 'pptx'],
  image: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'svg'],
  video: ['mp4', 'mov', 'avi', 'mkv', 'webm'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'],
  text: ['txt', 'md', 'rtf'],
  document: ['doc', 'docx', 'pdf', 'txt', 'rtf', 'odt'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz'],
};
export const FILE_TYPE_NAMES: readonly string[] = Object.keys(FILE_TYPE_EXTENSIONS);

interface Walk {
  readonly files: FoundFile[];
  readonly truncated: boolean;
}

/** Breadth-first walk, bounded in depth, files visited and time. */
export async function findFiles(roots: readonly string[], opts: FindOptions, now = Date.now): Promise<Walk> {
  const deadline = now() + SEARCH_BUDGET_MS;
  const matches: FoundFile[] = [];
  let visited = 0;
  let truncated = false;
  const queue: { dir: string; depth: number }[] = roots.map((dir) => ({ dir, depth: 0 }));

  walk: while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    let entries;
    try {
      entries = await fs.readdir(next.dir, { withFileTypes: true });
    } catch {
      continue; // unreadable folder: skip it
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_VISITED || now() > deadline || matches.length >= MAX_MATCHES_KEPT) {
        truncated = true;
        break walk;
      }
      const lower = entry.name.toLowerCase();
      if (entry.isDirectory()) {
        if (next.depth + 1 > MAX_DEPTH) continue;
        if (SKIP_DIRS.has(lower) || isBlockedDirName(entry.name) || entry.name.startsWith('.')) continue;
        queue.push({ dir: join(next.dir, entry.name), depth: next.depth + 1 });
        continue;
      }
      if (!entry.isFile() || isBlockedFileName(entry.name)) continue;
      if (opts.extensions !== undefined && !opts.extensions.includes(extname(lower).replace(/^\./, ''))) continue;
      if (!opts.tokens.every((t) => lower.includes(t))) continue;
      const full = join(next.dir, entry.name);
      try {
        const stat = await fs.stat(full);
        const sizeKB = stat.size / 1024;
        if (opts.minSizeKB !== undefined && sizeKB < opts.minSizeKB) continue;
        if (opts.maxSizeKB !== undefined && sizeKB > opts.maxSizeKB) continue;
        if (opts.modifiedFrom !== undefined && stat.mtime < opts.modifiedFrom) continue;
        if (opts.modifiedTo !== undefined && stat.mtime >= opts.modifiedTo) continue;
        matches.push({
          path: full,
          name: entry.name,
          sizeKB: Math.max(1, Math.round(sizeKB)),
          modified: stat.mtime.toISOString(),
        });
      } catch {
        // Vanished or unreadable between listing and stat.
      }
    }
  }

  matches.sort(
    opts.sort === 'name'
      ? (a, b) => a.name.localeCompare(b.name)
      : (a, b) => b.modified.localeCompare(a.modified),
  );
  return { files: matches.slice(0, opts.limit), truncated };
}

function stringArg(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function createFileTools(folders: KnownFolders): Tool[] {
  const findFile: Tool = {
    schema: {
      name: 'find_file',
      status: 'Searching your files…',
      description:
        'Find files on this PC by name, type, size, date or recency. Searches Downloads, Desktop and Documents unless ' +
        'a folder is given. Results are newest first by default, so "latest PDF" is extension "pdf" with no query. ' +
        'For "files from yesterday/this week/last month" etc, use "when". For a specific day or range, use ' +
        'onDate/fromDate/toDate (YYYY-MM-DD) computed from today\'s date. Returns full paths. If several results ' +
        'come back and the user meant one specific file, list the actual names and ask which one rather than guessing.',
      args: {
        query: {
          type: 'string',
          description: 'Words that must all appear in the file name (case-insensitive). Optional.',
        },
        extension: { type: 'string', description: 'File type without the dot, e.g. "pdf" or "docx". Optional.' },
        fileType: {
          type: 'string',
          enum: FILE_TYPE_NAMES,
          description: 'A natural file category instead of a specific extension, e.g. "image" or "word". Optional.',
        },
        folder: {
          type: 'string',
          description: 'downloads, desktop, documents, pictures, videos, music, home, or a full path inside the user folder. Optional.',
        },
        when: {
          type: 'string',
          enum: WHEN_VALUES,
          description: 'A relative time word for when the file was last modified. Optional.',
        },
        onDate: { type: 'string', description: 'A specific day, YYYY-MM-DD, matched against when the file was last modified. Optional.' },
        fromDate: { type: 'string', description: 'Start of a date range (inclusive), YYYY-MM-DD. Optional.' },
        toDate: { type: 'string', description: 'End of a date range (inclusive), YYYY-MM-DD. Optional.' },
        minSizeMB: { type: 'number', description: 'Only files at least this many megabytes. Optional.' },
        maxSizeMB: { type: 'number', description: 'Only files at most this many megabytes. Optional.' },
        sort: { type: 'string', enum: ['newest', 'name'], description: 'Default newest.' },
        limit: { type: 'number', description: `How many results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
      },
    },
    async execute(args): Promise<ToolResult> {
      const query = stringArg(args, 'query');
      const extensionArg = stringArg(args, 'extension')?.replace(/^\./, '').toLowerCase();
      const fileTypeArg = stringArg(args, 'fileType');
      const folderArg = stringArg(args, 'folder');
      const sortArg = stringArg(args, 'sort');
      const limitArg = typeof args['limit'] === 'number' ? args['limit'] : DEFAULT_LIMIT;
      const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limitArg)));

      let extensions: readonly string[] | undefined;
      if (extensionArg !== undefined) extensions = [extensionArg];
      else if (fileTypeArg !== undefined) {
        const set = FILE_TYPE_EXTENSIONS[fileTypeArg];
        if (set === undefined) return { ok: false, summary: 'unknown file type', error: `I don't know the file type "${fileTypeArg}".` };
        extensions = set;
      }

      let modifiedFrom: Date | undefined;
      let modifiedTo: Date | undefined;
      const whenArg = stringArg(args, 'when');
      const onDateArg = stringArg(args, 'onDate');
      const fromDateArg = stringArg(args, 'fromDate');
      const toDateArg = stringArg(args, 'toDate');
      if (whenArg !== undefined) {
        if (!(WHEN_VALUES as readonly string[]).includes(whenArg)) {
          return { ok: false, summary: 'unknown time range', error: `I don't understand the time range "${whenArg}".` };
        }
        const range = resolveWhen(whenArg as WhenValue, new Date());
        modifiedFrom = range.from;
        modifiedTo = range.to;
      } else if (onDateArg !== undefined) {
        const day = parseDateOnly(onDateArg);
        if (day === null) return { ok: false, summary: 'bad date', error: `"${onDateArg}" isn't a date I understand (use YYYY-MM-DD).` };
        modifiedFrom = day;
        modifiedTo = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
      } else {
        if (fromDateArg !== undefined) {
          const day = parseDateOnly(fromDateArg);
          if (day === null) return { ok: false, summary: 'bad date', error: `"${fromDateArg}" isn't a date I understand (use YYYY-MM-DD).` };
          modifiedFrom = day;
        }
        if (toDateArg !== undefined) {
          const day = parseDateOnly(toDateArg);
          if (day === null) return { ok: false, summary: 'bad date', error: `"${toDateArg}" isn't a date I understand (use YYYY-MM-DD).` };
          modifiedTo = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1); // inclusive end of that day
        }
      }

      const minSizeMB = typeof args['minSizeMB'] === 'number' ? args['minSizeMB'] : undefined;
      const maxSizeMB = typeof args['maxSizeMB'] === 'number' ? args['maxSizeMB'] : undefined;

      let roots: string[];
      if (folderArg === undefined) {
        roots = [folders.downloads, folders.desktop, folders.documents];
      } else {
        const resolved = resolveFolder(folderArg, folders);
        if (resolved === null) {
          return { ok: false, summary: 'unknown folder', error: `I don't know a folder called "${folderArg}".` };
        }
        const check = checkPath(resolved, folders);
        if (!check.ok) return { ok: false, summary: 'not allowed', error: check.reason };
        roots = [check.path];
      }

      const { files, truncated } = await findFiles(roots, {
        tokens: (query ?? '').toLowerCase().split(/\s+/).filter((t) => t.length > 0),
        extensions,
        sort: sortArg === 'name' ? 'name' : 'newest',
        limit,
        ...(minSizeMB !== undefined ? { minSizeKB: minSizeMB * 1024 } : {}),
        ...(maxSizeMB !== undefined ? { maxSizeKB: maxSizeMB * 1024 } : {}),
        ...(modifiedFrom !== undefined ? { modifiedFrom } : {}),
        ...(modifiedTo !== undefined ? { modifiedTo } : {}),
      });
      return {
        ok: true,
        summary: files.length === 0 ? 'no matching files' : `found ${files.length} file${files.length === 1 ? '' : 's'}`,
        data: { files, truncated, searched: roots },
      };
    },
  };

  const readFile: Tool = {
    schema: {
      name: 'read_file',
      status: 'Reading the file…',
      description:
        'Read a plain-text file (txt, md, csv, json, log, code, etc). For PDFs and images use analyze_document instead.',
      args: { path: { type: 'string', required: true, description: 'Full path to the file.' } },
    },
    async execute(args): Promise<ToolResult> {
      const path = stringArg(args, 'path');
      if (path === undefined) return { ok: false, summary: 'no path', error: 'A path is required.' };
      const check = checkPath(path, folders);
      if (!check.ok) return { ok: false, summary: 'not allowed', error: check.reason };
      if (!TEXT_EXTENSIONS.has(extname(check.path).toLowerCase())) {
        return {
          ok: false,
          summary: 'not a text file',
          error: 'That is not a plain-text file. PDFs and images can be read with analyze_document.',
        };
      }
      try {
        const stat = await fs.stat(check.path);
        if (!stat.isFile()) return { ok: false, summary: 'not a file', error: 'That is not a file.' };
        if (stat.size > MAX_READ_BYTES) {
          return { ok: false, summary: 'too large', error: 'That file is too large to read.' };
        }
        const text = await fs.readFile(check.path, 'utf8');
        const truncated = text.length > MAX_READ_CHARS;
        return {
          ok: true,
          summary: 'read the file',
          data: { path: check.path, content: text.slice(0, MAX_READ_CHARS), truncated },
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return {
          ok: false,
          summary: 'could not read',
          error: code === 'ENOENT' ? 'That file does not exist.' : 'I could not read that file.',
        };
      }
    },
  };

  return [findFile, readFile];
}
