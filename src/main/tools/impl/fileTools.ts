import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  checkReadablePath,
  isBlockedDirName,
  isBlockedFileName,
  isSystemDirName,
  resolveFolder,
} from '@main/security/pathPolicy';
import type { KnownFolders } from '@main/security/pathPolicy';
import { WHEN_VALUES, parseDateOnly, resolveWhen } from '../dateQuery';
import type { WhenValue } from '../dateQuery';
import type { Tool, ToolArgs, ToolResult } from '../types';

const execFileAsync = promisify(execFile);

const MAX_DEPTH = 4;
const MAX_VISITED = 20_000;
const SEARCH_BUDGET_MS = 4000;
const MAX_MATCHES_KEPT = 500;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

// The default (no folder given) search now covers the whole accessible PC,
// not just Downloads/Desktop/Documents, so the fallback deep walk (used once
// the fast index search below finds nothing) is given a larger budget than
// the tight, single-folder walk above.
const FALLBACK_MAX_DEPTH = 6;
const FALLBACK_MAX_VISITED = 60_000;
const FALLBACK_SEARCH_BUDGET_MS = 8000;
const INDEX_TOP_N = 200;

const SKIP_DIRS = new Set(['node_modules', '.git']);

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

export interface WalkLimits {
  readonly maxDepth?: number;
  readonly maxVisited?: number;
  readonly budgetMs?: number;
  /** Absolute directories never to descend into (e.g. another user's profile root). */
  readonly excludeDirs?: readonly string[];
}

/** Breadth-first walk, bounded in depth, files visited and time. */
export async function findFiles(
  roots: readonly string[],
  opts: FindOptions,
  now = Date.now,
  limits: WalkLimits = {},
): Promise<Walk> {
  const maxDepth = limits.maxDepth ?? MAX_DEPTH;
  const maxVisited = limits.maxVisited ?? MAX_VISITED;
  const deadline = now() + (limits.budgetMs ?? SEARCH_BUDGET_MS);
  const excludeDirs = new Set((limits.excludeDirs ?? []).map((d) => resolve(d)));
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
      if (visited > maxVisited || now() > deadline || matches.length >= MAX_MATCHES_KEPT) {
        truncated = true;
        break walk;
      }
      const lower = entry.name.toLowerCase();
      if (entry.isDirectory()) {
        if (next.depth + 1 > maxDepth) continue;
        if (SKIP_DIRS.has(lower) || isBlockedDirName(entry.name) || isSystemDirName(entry.name) || entry.name.startsWith('.')) continue;
        const childPath = join(next.dir, entry.name);
        if (excludeDirs.has(resolve(childPath))) continue;
        queue.push({ dir: childPath, depth: next.depth + 1 });
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

/** Turns a list of candidate paths (from the index or a walk) into checked, filtered, sorted results. */
async function finalizeCandidates(
  paths: readonly string[],
  opts: FindOptions,
  folders: KnownFolders,
): Promise<FoundFile[]> {
  const seen = new Set<string>();
  const matches: FoundFile[] = [];
  for (const raw of paths) {
    const check = checkReadablePath(raw, folders);
    if (!check.ok) continue;
    if (seen.has(check.path.toLowerCase())) continue;
    seen.add(check.path.toLowerCase());
    try {
      const stat = await fs.stat(check.path);
      if (!stat.isFile()) continue;
      if (isBlockedFileName(check.path.split(/[\\/]/).pop() ?? '')) continue;
      const sizeKB = stat.size / 1024;
      if (opts.minSizeKB !== undefined && sizeKB < opts.minSizeKB) continue;
      if (opts.maxSizeKB !== undefined && sizeKB > opts.maxSizeKB) continue;
      if (opts.modifiedFrom !== undefined && stat.mtime < opts.modifiedFrom) continue;
      if (opts.modifiedTo !== undefined && stat.mtime >= opts.modifiedTo) continue;
      matches.push({
        path: check.path,
        name: check.path.split(/[\\/]/).pop() ?? check.path,
        sizeKB: Math.max(1, Math.round(sizeKB)),
        modified: stat.mtime.toISOString(),
      });
    } catch {
      // Vanished, or the index is stale about it.
    }
  }
  matches.sort(
    opts.sort === 'name'
      ? (a, b) => a.name.localeCompare(b.name)
      : (a, b) => b.modified.localeCompare(a.modified),
  );
  return matches.slice(0, opts.limit);
}

/** Combines already-filtered result sets (index hits, a home walk, a drives walk), dropping duplicates. */
function mergeFound(sets: readonly (readonly FoundFile[])[], opts: FindOptions): FoundFile[] {
  const seen = new Set<string>();
  const merged: FoundFile[] = [];
  for (const set of sets) {
    for (const f of set) {
      const key = f.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(f);
    }
  }
  merged.sort(
    opts.sort === 'name'
      ? (x, y) => x.name.localeCompare(y.name)
      : (x, y) => y.modified.localeCompare(x.modified),
  );
  return merged.slice(0, opts.limit);
}

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** Which drive letters actually exist and are reachable right now — discovered live, never hard-coded. */
async function listAccessibleDrives(): Promise<string[]> {
  const roots = await Promise.all(
    DRIVE_LETTERS.map(async (letter) => {
      const root = `${letter}:\\`;
      try {
        await fs.access(root);
        return root;
      } catch {
        return null;
      }
    }),
  );
  return roots.filter((r): r is string => r !== null);
}

/** Escapes a token for a Windows Search (Jet/ACE-style) LIKE pattern: '%_[' and the quote itself. */
function escapeLikeToken(token: string): string {
  return token.replace(/'/g, "''").replace(/\[/g, '[[]').replace(/%/g, '[%]').replace(/_/g, '[_]');
}

/**
 * Queries the Windows Search index (the same one Explorer's own search box
 * uses) for a fast, whole-PC-by-default name match, via the `Search.CollatorDSO`
 * OLE DB provider — there is no other way to reach it from Node. Only covers
 * whatever locations the user has indexed (by default the user profile, not
 * other drives), which is exactly why callers fall back to a real filesystem
 * walk when this finds nothing.
 */
export interface FileSearchDeps {
  queryIndex(tokens: readonly string[], extensions: readonly string[] | undefined): Promise<string[]>;
  listDrives(): Promise<readonly string[]>;
}

async function queryWindowsSearchIndex(
  tokens: readonly string[],
  extensions: readonly string[] | undefined,
): Promise<string[]> {
  const conditions = tokens.map((t) => `System.FileName LIKE '%${escapeLikeToken(t)}%'`);
  if (extensions !== undefined && extensions.length > 0) {
    conditions.push(`(${extensions.map((e) => `System.FileName LIKE '%.${escapeLikeToken(e)}'`).join(' OR ')})`);
  }
  if (conditions.length === 0) return [];
  const query =
    `SELECT TOP ${INDEX_TOP_N} System.ItemPathDisplay FROM SystemIndex WHERE ${conditions.join(' AND ')} ` +
    `ORDER BY System.DateModified DESC`;
  const script = `
$ErrorActionPreference = 'Stop'
$conn = New-Object -ComObject ADODB.Connection
$conn.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
$rs = New-Object -ComObject ADODB.Recordset
$rs.Open("${query.replace(/"/g, '""')}", $conn)
$paths = New-Object System.Collections.Generic.List[string]
while (-not $rs.EOF) {
  $paths.Add([string]$rs.Fields.Item("System.ItemPathDisplay").Value)
  $rs.MoveNext()
}
$rs.Close()
$conn.Close()
if ($paths.Count -eq 0) { "[]" } else { ConvertTo-Json -InputObject $paths -Compress }
`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed: unknown = JSON.parse(stdout.trim() || '[]');
  if (!Array.isArray(parsed)) return typeof parsed === 'string' ? [parsed] : [];
  return parsed.filter((p): p is string => typeof p === 'string');
}

export const defaultFileSearchDeps: FileSearchDeps = {
  queryIndex: queryWindowsSearchIndex,
  listDrives: listAccessibleDrives,
};

function stringArg(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function createFileTools(folders: KnownFolders, search: FileSearchDeps = defaultFileSearchDeps): Tool[] {
  const findFile: Tool = {
    schema: {
      name: 'find_file',
      status: 'Searching your files…',
      description:
        'Find files on this PC by name, type, size, date or recency. Unless a folder is given, this searches your ' +
        'ENTIRE accessible computer — your whole user folder plus every connected drive — never just Downloads, ' +
        'Desktop or Documents; do not assume those three unless the user says so. It uses Windows\' own file index ' +
        'first (instant), automatically falling back to a deeper search if that finds nothing, so a plain call may ' +
        'take a little longer when a match is hard to find, especially on a drive that is not indexed. Results are ' +
        'newest first by default, so "latest PDF" is extension "pdf" with no query. For "files from yesterday/this ' +
        'week/last month" etc, use "when". For a specific day or range, use onDate/fromDate/toDate (YYYY-MM-DD) ' +
        'computed from today\'s date. Returns full paths. If several results come back and the user meant one ' +
        'specific file, say the actual file names AND, if they are in different folders, where each one is, then ask which one rather than guessing.',
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
          description:
            'downloads, desktop, documents, pictures, videos, music, home, or a full path anywhere on the PC. ' +
            'Only set this when the user actually names a location; otherwise leave it out and the whole PC is searched.',
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
      const tokens = (query ?? '').toLowerCase().split(/\s+/).filter((t) => t.length > 0);
      const findOpts: FindOptions = {
        tokens,
        extensions,
        sort: sortArg === 'name' ? 'name' : 'newest',
        limit,
        ...(minSizeMB !== undefined ? { minSizeKB: minSizeMB * 1024 } : {}),
        ...(maxSizeMB !== undefined ? { maxSizeKB: maxSizeMB * 1024 } : {}),
        ...(modifiedFrom !== undefined ? { modifiedFrom } : {}),
        ...(modifiedTo !== undefined ? { modifiedTo } : {}),
      };

      // An explicit folder: search just that, wherever it is (read-only, so
      // it need not be inside the user's own home folder).
      if (folderArg !== undefined) {
        const resolved = resolveFolder(folderArg, folders);
        if (resolved === null) {
          return { ok: false, summary: 'unknown folder', error: `I don't know a folder called "${folderArg}".` };
        }
        const check = checkReadablePath(resolved, folders);
        if (!check.ok) return { ok: false, summary: 'not allowed', error: check.reason };
        const { files, truncated } = await findFiles([check.path], findOpts);
        return {
          ok: true,
          summary: files.length === 0 ? 'no matching files' : `found ${files.length} file${files.length === 1 ? '' : 's'}`,
          data: { files, truncated, searched: [check.path] },
        };
      }

      // No folder named: search the whole accessible PC, every time — not
      // "stop as soon as something turns up somewhere". Two things always
      // run at once: Windows' own file index (fast; normally only covers the
      // user's own profile, not other drives) and a real walk of every OTHER
      // connected drive (which is almost never indexed). If the index came
      // back with nothing at all, the profile isn't just skipped on the
      // assumption the index covered it — the home folder gets a real walk
      // too, concurrently. Every walk stays out of Windows/program internals
      // and other accounts' own folders.
      const excludeDirs = [dirname(resolve(folders.home))]; // the "Users"-equivalent folder: other accounts, never this one's own home
      const fallbackLimits: WalkLimits = {
        maxDepth: FALLBACK_MAX_DEPTH,
        maxVisited: FALLBACK_MAX_VISITED,
        budgetMs: FALLBACK_SEARCH_BUDGET_MS,
      };
      const [indexHits, drives] = await Promise.all([
        tokens.length > 0 || extensions !== undefined ? search.queryIndex(tokens, extensions).catch(() => []) : Promise.resolve([]),
        search.listDrives(),
      ]);
      const [indexFiles, driveWalk] = await Promise.all([
        finalizeCandidates(indexHits, findOpts, folders),
        drives.length > 0
          ? findFiles(drives, findOpts, undefined, { ...fallbackLimits, excludeDirs })
          : Promise.resolve({ files: [], truncated: false }),
      ]);
      // The index found nothing for the home/profile location — it may be
      // stale, disabled, or the file just isn't indexed yet — so check home
      // directly too, rather than silently trusting an empty index result.
      const walkedHome = indexFiles.length === 0;
      const homeWalk = walkedHome
        ? await findFiles([folders.home], findOpts, undefined, fallbackLimits)
        : { files: [] as FoundFile[], truncated: false };

      const files = mergeFound([indexFiles, homeWalk.files, driveWalk.files], findOpts);
      const truncated = homeWalk.truncated || driveWalk.truncated || indexHits.length >= INDEX_TOP_N;
      const searched = ['the Windows file index', ...(walkedHome ? [folders.home] : []), ...drives];
      return {
        ok: true,
        summary: files.length === 0 ? 'no matching files' : `found ${files.length} file${files.length === 1 ? '' : 's'}`,
        data: { files, truncated, searched },
      };
    },
  };

  const readFile: Tool = {
    schema: {
      name: 'read_file',
      status: 'Reading the file…',
      description:
        'Read a plain-text file (txt, md, csv, json, log, code, etc), anywhere on the PC. For PDFs and images use analyze_document instead.',
      args: { path: { type: 'string', required: true, description: 'Full path to the file.' } },
    },
    async execute(args): Promise<ToolResult> {
      const path = stringArg(args, 'path');
      if (path === undefined) return { ok: false, summary: 'no path', error: 'A path is required.' };
      const check = checkReadablePath(path, folders);
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
