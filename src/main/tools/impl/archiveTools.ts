import { execFile } from 'node:child_process';
import { access, readdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { KnownFolders } from '@main/security/pathPolicy';
import { normalizeText } from '@main/chat/contactMatch';
import { checkReadablePath, isBlockedDirName, isBlockedFileName, isSystemDirName, resolveFolder } from '@main/security/pathPolicy';
import type { Tool, ToolResult } from '../types';

const execFileAsync = promisify(execFile);

/**
 * A chat app cannot take a folder, only files. This makes a .zip COPY of a folder (the folder itself is not touched) in a
 * temporary folder, checks that every file really went in, and hands back its path to be attached. It refuses a folder that
 * holds anything protected (keys, passwords files, .env…), and one too big for a chat app.
 */

const MAX_SOURCE_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_BYTES = 100 * 1024 * 1024;
const MAX_LISTED = 5000;

export interface FolderListing {
  readonly files: readonly string[];
  readonly count: number;
  readonly bytes: number;
}

export interface FolderEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

export interface ArchiveDeps {
  /** The entries of one folder (names only), or null if it cannot be read. */
  readEntries(folder: string): Promise<readonly FolderEntry[] | null>;
  /** What is inside (relative paths, capped), or null when it is not a folder. */
  listFolder(folder: string): Promise<FolderListing | null>;
  /** Makes the .zip and reads it back: how many files it holds and its size. */
  zip(folder: string, destination: string): Promise<{ readonly entries: number; readonly bytes: number }>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const UTF8 = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;';

export function listFolderScript(folder: string): string {
  return (
    `${UTF8}$ErrorActionPreference='Stop';$root=${psQuote(folder)};` +
    `if(-not (Test-Path -LiteralPath $root -PathType Container)){'NOTFOLDER';exit};` +
    `$items=@(Get-ChildItem -LiteralPath $root -Recurse -Force -File -ErrorAction SilentlyContinue);` +
    `$sum=0;foreach($i in $items){$sum+=$i.Length};` +
    `'COUNT='+$items.Count;'BYTES='+[long]$sum;` +
    `$items|Select-Object -First ${MAX_LISTED}|ForEach-Object{$_.FullName.Substring($root.TrimEnd('\\').Length).TrimStart('\\')}`
  );
}

export function parseFolderListing(out: string): FolderListing | null {
  const lines = out.split(/\r?\n/).map((l) => l.trimEnd());
  if (lines[0]?.trim() === 'NOTFOLDER') return null;
  const count = Number(/^COUNT=(\d+)$/.exec(lines[0] ?? '')?.[1]);
  const bytes = Number(/^BYTES=(\d+)$/.exec(lines[1] ?? '')?.[1]);
  if (!Number.isFinite(count) || !Number.isFinite(bytes)) return null;
  return { count, bytes, files: lines.slice(2).filter((l) => l !== '') };
}

export function zipScript(folder: string, destination: string): string {
  return (
    `${UTF8}$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression.FileSystem;` +
    `$src=${psQuote(folder)};$dst=${psQuote(destination)};` +
    `[void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($dst));` +
    `[System.IO.Compression.ZipFile]::CreateFromDirectory($src,$dst,[System.IO.Compression.CompressionLevel]::Optimal,$true);` +
    `$z=[System.IO.Compression.ZipFile]::OpenRead($dst);try{$n=@($z.Entries|Where-Object{$_.Name -ne ''}).Count}finally{$z.Dispose()};` +
    `'ZIP entries='+$n+' bytes='+(Get-Item -LiteralPath $dst).Length`
  );
}

export function parseZipResult(out: string): { readonly entries: number; readonly bytes: number } | null {
  const m = /ZIP entries=(\d+) bytes=(\d+)/.exec(out);
  return m === null ? null : { entries: Number(m[1]), bytes: Number(m[2]) };
}

async function runPowerShell(script: string): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
}

export const defaultArchiveDeps: ArchiveDeps = {
  async readEntries(folder) {
    try {
      return (await readdir(folder, { withFileTypes: true })).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch {
      return null;
    }
  },
  async listFolder(folder) {
    return parseFolderListing(await runPowerShell(listFolderScript(folder)));
  },
  async zip(folder, destination) {
    const result = parseZipResult(await runPowerShell(zipScript(folder, destination)));
    if (result === null) throw new Error('Windows did not report what went into the zip.');
    return result;
  },
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  async remove(path) {
    await unlink(path).catch(() => undefined);
  },
};

/** The first protected thing in the listing (a secrets file, a key, a credentials folder), or null. */
export function firstProtected(files: readonly string[]): string | null {
  for (const rel of files) {
    const parts = rel.split(/[\\/]/).filter(Boolean);
    const last = parts[parts.length - 1] ?? '';
    if (isBlockedFileName(last) || parts.slice(0, -1).some((p) => isBlockedDirName(p))) return rel;
  }
  return null;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '__pycache__']);
const MAX_FOLDER_RESULTS = 8;
const MAX_VISITED = 4000;

/** Folders whose name has every word of the query, looked for a few levels down the places people keep things. */
export async function searchFolders(
  query: string,
  roots: readonly string[],
  deps: Pick<ArchiveDeps, 'readEntries'>,
  maxDepth = 3,
): Promise<Array<{ readonly name: string; readonly path: string; readonly inside: string }>> {
  const words = normalizeText(query).split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const found: Array<{ name: string; path: string; inside: string; rank: number }> = [];
  const seen = new Set<string>();
  let visited = 0;
  const wanted = words.join(' ');
  for (const root of roots) {
    let level: string[] = [root];
    for (let depth = 0; depth < maxDepth && level.length > 0; depth += 1) {
      const next: string[] = [];
      for (const dir of level) {
        if (visited++ > MAX_VISITED) break;
        for (const entry of (await deps.readEntries(dir)) ?? []) {
          if (!entry.isDirectory || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name) || isBlockedDirName(entry.name) || isSystemDirName(entry.name)) continue;
          const path = join(dir, entry.name);
          if (seen.has(path.toLowerCase())) continue;
          seen.add(path.toLowerCase());
          const name = normalizeText(entry.name);
          if (words.every((w) => name.includes(w))) found.push({ name: entry.name, path, inside: dir, rank: name === wanted ? 0 : 1 + depth });
          next.push(path);
        }
      }
      level = next;
    }
  }
  found.sort((a, b) => a.rank - b.rank || a.path.length - b.path.length);
  return found.slice(0, MAX_FOLDER_RESULTS).map(({ name, path, inside }) => ({ name, path, inside }));
}

export function createArchiveTools(folders: KnownFolders, deps: ArchiveDeps = defaultArchiveDeps): Tool[] {
  const findFolder: Tool = {
    schema: {
      name: 'find_folder',
      status: 'Looking for that folder…',
      description:
        'Find a FOLDER by its name (find_file only finds files): "the folder Hello 2 on my desktop", "my Photos 2024 folder". Give the words of its name, and the place if the user named one ' +
        '(desktop, downloads, documents, pictures, videos, music, home, or a full path); with no place it looks in the usual ones (Desktop, Documents, Downloads, Pictures, Videos, Music) and a few levels down. ' +
        'Returns full paths. If more than one comes back, say where each one is and ask which; never pick for the user.',
      args: {
        query: { type: 'string', required: true, description: 'The words in the name of the folder.' },
        location: { type: 'string', description: 'desktop, downloads, documents, pictures, videos, music, home, or a full path. Only if the user said where.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
      if (query === '') return { ok: false, summary: 'no name', error: 'The name of the folder to look for is required.' };
      const where = typeof args['location'] === 'string' ? args['location'].trim() : '';
      let roots: string[];
      if (where !== '') {
        const root = resolveFolder(where, folders);
        const checked = root === null ? null : checkReadablePath(root, folders);
        if (root === null || checked === null || !checked.ok) return { ok: false, summary: 'unknown place', error: `I don't know where "${where}" is. Use desktop, downloads, documents, pictures, videos, music, home, or a full path.` };
        roots = [checked.path];
      } else {
        roots = [folders.desktop, folders.documents, folders.downloads, folders.pictures, folders.videos, folders.music];
      }
      try {
        const results = await searchFolders(query, roots, deps);
        if (results.length === 0) return { ok: true, summary: `no folder called "${query}"`, data: { folders: [], hint: 'No folder with that name there. Ask the user where it is, or for another word from its name.' } };
        return { ok: true, summary: `found ${results.length} folder${results.length === 1 ? '' : 's'}`, data: { folders: results } };
      } catch (err) {
        return { ok: false, summary: 'could not look', error: `I could not look for that folder: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };


  const zipFolder: Tool = {
    schema: {
      name: 'zip_folder',
      status: 'Zipping the folder…',
      description:
        'Make a .zip copy of a FOLDER so it can be sent in a chat app (which only takes files). The folder itself is not changed or moved: a new .zip is made in a temporary folder, ' +
        'checked to hold every file, and its path returned — pass that path to attach_file. Tell the user you are sending a zipped copy. Refuses a folder with keys, passwords or other ' +
        'protected files in it, an empty one, and one too big for a chat app (about 100 MB zipped).',
      args: { path: { type: 'string', required: true, description: 'The full path of the folder.' } },
    },
    async execute(args): Promise<ToolResult> {
      const raw = typeof args['path'] === 'string' ? args['path'].trim() : '';
      if (raw === '') return { ok: false, summary: 'no folder', error: 'The path of the folder to zip is required.' };
      const checked = checkReadablePath(raw, folders);
      if (!checked.ok) return { ok: false, summary: 'not allowed', error: `I won't zip that: ${checked.reason}.` };
      const folder = checked.path;
      const name = basename(folder);
      try {
        const listing = await deps.listFolder(folder);
        if (listing === null) return { ok: false, summary: 'not a folder', error: `"${name}" is not a folder I can find. For a single file, attach it directly.` };
        if (listing.count === 0) return { ok: false, summary: 'empty folder', error: `The folder "${name}" has no files in it, so there is nothing to send.` };
        if (listing.bytes > MAX_SOURCE_BYTES) {
          return { ok: false, summary: 'too big', error: `"${name}" holds about ${Math.round(listing.bytes / 1048576)} MB, too much for a chat app. Ask the user to pick a smaller folder or send part of it.` };
        }
        const blocked = firstProtected(listing.files);
        if (blocked !== null) {
          return { ok: false, summary: 'holds protected files', error: `I won't zip "${name}" because it holds something protected (${blocked}). Ask the user to move that out, or send other files.` };
        }

        const dir = join(folders.temp, 'Eya-send');
        let destination = join(dir, `${name}.zip`);
        for (let n = 2; (await deps.exists(destination)) && n < 100; n += 1) destination = join(dir, `${name} (${n}).zip`);

        const made = await deps.zip(folder, destination);
        if (made.entries !== listing.count) {
          await deps.remove(destination);
          return { ok: false, summary: 'the zip is incomplete', error: `The zip held ${made.entries} files but the folder has ${listing.count}, so I threw it away rather than send part of it.` };
        }
        if (made.bytes <= 0 || made.bytes > MAX_ZIP_BYTES) {
          await deps.remove(destination);
          return { ok: false, summary: 'too big', error: `Zipped, "${name}" is ${Math.round(made.bytes / 1048576)} MB, too much for a chat app (about 100 MB).` };
        }
        return {
          ok: true,
          summary: `zipped ${name} (${made.entries} file${made.entries === 1 ? '' : 's'})`,
          data: {
            path: destination,
            name: basename(destination),
            files: made.entries,
            sizeBytes: made.bytes,
            verified: true,
            note: `A zipped COPY in a temporary folder; "${name}" itself is untouched. Next: attach_file with this path.`,
          },
        };
      } catch (err) {
        return { ok: false, summary: 'could not zip', error: `I could not zip that folder: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
  return [findFolder, zipFolder];
}
