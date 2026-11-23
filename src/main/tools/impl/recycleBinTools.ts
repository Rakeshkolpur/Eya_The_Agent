import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { checkPath } from '@main/security/pathPolicy';
import type { KnownFolders } from '@main/security/pathPolicy';
import { permissionRequest } from '@main/permissions/PermissionManager';
import { WHEN_VALUES, parseDateOnly, resolveWhen } from '../dateQuery';
import type { WhenValue } from '../dateQuery';
import type { Tool, ToolArgs, ToolResult } from '../types';

const execFileAsync = promisify(execFile);

/**
 * Real Windows Recycle Bin state, not an Eya-only list: everything here reads
 * or changes the actual system Recycle Bin (via the Shell's own COM view and
 * `SHQueryRecycleBin`), so it stays true after a restart, matches what File
 * Explorer shows, and sees things the user deleted themselves outside Eya too.
 *
 * Restoring an item, and permanently deleting one, both work by moving/deleting
 * the item's real underlying file directly (its `rawPath`, e.g.
 * `C:\$Recycle.Bin\<SID>\$R...`) rather than automating the right-click
 * "Restore"/"Delete" menu (`InvokeVerb`) — verified live that a Shell verb
 * click pops a real confirmation dialog and hangs a non-interactive call
 * waiting for it. Moving/deleting the underlying file directly needs no
 * dialog and was verified live for both files and folders.
 */
export interface RecycleBinEntry {
  readonly name: string;
  readonly originalFolder: string;
  readonly originalPath: string;
  /** ISO 8601. */
  readonly deletedAt: string;
  readonly sizeBytes: number;
  readonly isFolder: boolean;
  /** Internal only: never shown to the user or spoken. */
  readonly rawPath: string;
}

export interface RecycleBinDeps {
  listItems(): Promise<readonly RecycleBinEntry[]>;
  countAndSize(): Promise<{ count: number; totalBytes: number }>;
  restoreItem(entry: RecycleBinEntry): Promise<void>;
  permanentlyDeleteItem(entry: RecycleBinEntry): Promise<void>;
  emptyBin(): Promise<void>;
}

async function powershell(script: string): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

// GetDetailsOf()'s own date strings carry invisible bidi-direction marks and
// are locale-formatted, so they are not safely parseable; the extended
// properties give a real, clean System.DateTime and a plain path instead.
// item.Name is also unreliable for a FILE specifically: Explorer's "hide
// extensions for known file types" setting affects this COM property too, so
// a plain text file recycled as "report.pdf" can come back as .Name =
// "report" with no extension at all (verified live — this silently broke
// name matching against "report.pdf" until caught). System.FileName always
// includes the real extension; folders have no extension to hide either way.
const LIST_SCRIPT = `
$shell = New-Object -ComObject Shell.Application
$bin = $shell.Namespace(10)
$result = @(foreach ($item in $bin.Items()) {
  [PSCustomObject]@{
    Name = $item.ExtendedProperty("System.FileName")
    OriginalFolder = $item.ExtendedProperty("System.Recycle.DeletedFrom")
    DeletedAt = ([DateTime]$item.ExtendedProperty("System.Recycle.DateDeleted")).ToString("o")
    SizeBytes = $item.Size
    IsFolder = $item.IsFolder
    RawPath = $item.Path
  }
})
if ($result.Count -eq 0) { "[]" } else { ConvertTo-Json -InputObject $result -Compress }
`;

function parseListOutput(stdout: string): RecycleBinEntry[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    const name = String(r['Name'] ?? '');
    const originalFolder = String(r['OriginalFolder'] ?? '');
    return {
      name,
      originalFolder,
      originalPath: join(originalFolder, name),
      deletedAt: String(r['DeletedAt'] ?? ''),
      sizeBytes: Number(r['SizeBytes']) || 0,
      isFolder: r['IsFolder'] === true,
      rawPath: String(r['RawPath'] ?? ''),
    };
  });
}

// The exact Win32 API the Recycle Bin's own count/size come from
// (shell32.dll's SHQueryRecycleBin) — faster than enumerating every item's
// extended properties just to answer "how many".
const COUNT_SCRIPT = `
Add-Type -TypeDefinition '
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct EyaSHQUERYRBINFO { public int cbSize; public long i64Size; public long i64NumItems; }
public class EyaRecycleQuery {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern int SHQueryRecycleBin(string pszRootPath, ref EyaSHQUERYRBINFO pSHQueryRBInfo);
}
';
$info = New-Object EyaSHQUERYRBINFO;
$info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][EyaSHQUERYRBINFO]);
[void][EyaRecycleQuery]::SHQueryRecycleBin($null, [ref]$info);
"$($info.i64NumItems)|$($info.i64Size)"
`;

const EMPTY_SCRIPT = `
Add-Type -TypeDefinition '
using System;
using System.Runtime.InteropServices;
public class EyaRecycleEmpty {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern int SHEmptyRecycleBin(IntPtr hwnd, string pszRootPath, uint dwFlags);
}
';
[void][EyaRecycleEmpty]::SHEmptyRecycleBin([IntPtr]::Zero, $null, 7)
`;

async function moveAcrossOrRename(source: string, destination: string): Promise<void> {
  try {
    await fs.rename(source, destination);
  } catch (err) {
    // $Recycle.Bin lives on the same volume as the item's original location
    // (Windows keeps one per drive precisely so restore is a same-volume
    // move), so this should not happen in practice; kept as a safety net.
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.cp(source, destination, { recursive: true });
    await fs.rm(source, { recursive: true, force: true });
  }
}

export const defaultRecycleBinDeps: RecycleBinDeps = {
  listItems: async () => parseListOutput(await powershell(LIST_SCRIPT)),
  countAndSize: async () => {
    const out = (await powershell(COUNT_SCRIPT)).trim();
    const [count, size] = out.split('|');
    return { count: Number(count) || 0, totalBytes: Number(size) || 0 };
  },
  restoreItem: (entry) => moveAcrossOrRename(entry.rawPath, entry.originalPath),
  permanentlyDeleteItem: async (entry) => {
    if (entry.isFolder) await fs.rm(entry.rawPath, { recursive: true, force: true });
    else await fs.unlink(entry.rawPath);
  },
  emptyBin: async () => {
    await powershell(EMPTY_SCRIPT);
  },
};

function stringArg(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function boolArg(args: ToolArgs, key: string): boolean {
  return args[key] === true;
}

/** Shared with find_file's own date args, applied here to deletedAt instead of last-modified. */
function resolveDateFilter(args: ToolArgs): { from?: Date; to?: Date } | { error: string } {
  const whenArg = stringArg(args, 'when');
  const onDateArg = stringArg(args, 'onDate');
  const fromDateArg = stringArg(args, 'fromDate');
  const toDateArg = stringArg(args, 'toDate');
  if (whenArg !== undefined) {
    if (!(WHEN_VALUES as readonly string[]).includes(whenArg)) return { error: `I don't understand the time range "${whenArg}".` };
    const range = resolveWhen(whenArg as WhenValue, new Date());
    return { from: range.from, to: range.to };
  }
  if (onDateArg !== undefined) {
    const day = parseDateOnly(onDateArg);
    if (day === null) return { error: `"${onDateArg}" isn't a date I understand (use YYYY-MM-DD).` };
    return { from: day, to: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1) };
  }
  const result: { from?: Date; to?: Date } = {};
  if (fromDateArg !== undefined) {
    const day = parseDateOnly(fromDateArg);
    if (day === null) return { error: `"${fromDateArg}" isn't a date I understand (use YYYY-MM-DD).` };
    result.from = day;
  }
  if (toDateArg !== undefined) {
    const day = parseDateOnly(toDateArg);
    if (day === null) return { error: `"${toDateArg}" isn't a date I understand (use YYYY-MM-DD).` };
    result.to = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  }
  return result;
}

function stripExtension(name: string): string {
  return name.replace(/\.[^./\\]+$/, '');
}

/**
 * Matches with or without whichever side happens to have an extension.
 * Windows' Recycle Bin can report a file's display name without its
 * extension (an Explorer display setting, "hide extensions for known file
 * types", that leaks into this COM property too) even though the tool's own
 * listing already asks for the with-extension name specifically — this is a
 * second, independent safety net against exactly that class of mismatch,
 * verified live to matter: a file recycled as "EyaRestoreTest.txt" came back
 * unmatched against that same query before this was added.
 */
function namesMatch(name: string, query: string): boolean {
  if (name.includes(query) || query.includes(name)) return true;
  const nameNoExt = stripExtension(name);
  const queryNoExt = stripExtension(query);
  return nameNoExt.includes(queryNoExt) || queryNoExt.includes(nameNoExt);
}

function matchEntries(entries: readonly RecycleBinEntry[], args: ToolArgs): { entries: RecycleBinEntry[] } | { error: string } {
  const query = stringArg(args, 'query')?.toLowerCase();
  const filter = resolveDateFilter(args);
  if ('error' in filter) return filter;
  const matches = entries.filter((e) => {
    if (query !== undefined && !namesMatch(e.name.toLowerCase(), query)) return false;
    const deletedAt = new Date(e.deletedAt);
    if (filter.from !== undefined && deletedAt < filter.from) return false;
    if (filter.to !== undefined && deletedAt >= filter.to) return false;
    return true;
  });
  matches.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  return { entries: matches };
}

const summarizeEntry = (e: RecycleBinEntry) => ({
  name: e.name,
  originalFolder: e.originalFolder,
  deletedAt: e.deletedAt,
  sizeKB: Math.max(1, Math.round(e.sizeBytes / 1024)),
  isFolder: e.isFolder,
});

export function createRecycleBinTools(folders: KnownFolders, deps: RecycleBinDeps = defaultRecycleBinDeps): Tool[] {
  const dateArgs = {
    when: { type: 'string' as const, enum: WHEN_VALUES, description: 'A relative time the item was deleted, e.g. "yesterday". Optional.' },
    onDate: { type: 'string' as const, description: 'A specific day it was deleted, YYYY-MM-DD. Optional.' },
    fromDate: { type: 'string' as const, description: 'Start of a deleted-date range (inclusive), YYYY-MM-DD. Optional.' },
    toDate: { type: 'string' as const, description: 'End of a deleted-date range (inclusive), YYYY-MM-DD. Optional.' },
  };

  const getRecycleBinCount: Tool = {
    schema: {
      name: 'get_recycle_bin_count',
      status: 'Checking the Recycle Bin…',
      description: 'How many items are in the Windows Recycle Bin right now, and their total size.',
      args: {},
    },
    async execute(): Promise<ToolResult> {
      const { count, totalBytes } = await deps.countAndSize();
      return { ok: true, summary: `${count} item${count === 1 ? '' : 's'}`, data: { count, totalMB: Math.round(totalBytes / 1024 / 1024) } };
    },
  };

  const getRecycleBinItems: Tool = {
    schema: {
      name: 'get_recycle_bin_items',
      status: 'Checking the Recycle Bin…',
      description: 'List what is actually in the Windows Recycle Bin, newest deleted first.',
      args: { limit: { type: 'number', description: 'How many to return (default 25, max 100).' } },
    },
    async execute(args): Promise<ToolResult> {
      const limitArg = typeof args['limit'] === 'number' ? args['limit'] : 25;
      const limit = Math.max(1, Math.min(100, Math.floor(limitArg)));
      const entries = await deps.listItems();
      const sorted = [...entries].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)).slice(0, limit);
      return {
        ok: true,
        summary: sorted.length === 0 ? 'the Recycle Bin is empty' : `${entries.length} item${entries.length === 1 ? '' : 's'}`,
        data: { items: sorted.map(summarizeEntry), total: entries.length },
      };
    },
  };

  const findRecycleBinItem: Tool = {
    schema: {
      name: 'find_recycle_bin_item',
      status: 'Searching the Recycle Bin…',
      description:
        'Find items in the Recycle Bin by name and/or when they were deleted (e.g. "the file I deleted yesterday"). ' +
        'If more than one plausible match comes back for something the user wants to act on, list the actual names ' +
        'and ask which one rather than guessing.',
      args: { query: { type: 'string', description: 'Words that must appear in the name. Optional.' }, ...dateArgs },
    },
    async execute(args): Promise<ToolResult> {
      const entries = await deps.listItems();
      const result = matchEntries(entries, args);
      if ('error' in result) return { ok: false, summary: 'bad filter', error: result.error };
      return {
        ok: true,
        summary: result.entries.length === 0 ? 'no matching items' : `found ${result.entries.length}`,
        data: { items: result.entries.map(summarizeEntry) },
      };
    },
  };

  async function resolveOne(args: ToolArgs): Promise<{ entry: RecycleBinEntry } | { result: ToolResult }> {
    const name = stringArg(args, 'name');
    if (name === undefined) return { result: { ok: false, summary: 'no name', error: 'A file or folder name is required.' } };
    const entries = await deps.listItems();
    const result = matchEntries(entries, { ...args, query: name });
    if ('error' in result) return { result: { ok: false, summary: 'bad filter', error: result.error } };
    if (result.entries.length === 0) {
      return { result: { ok: false, summary: 'not found', error: `I don't see anything named "${name}" in the Recycle Bin.` } };
    }
    if (result.entries.length > 1) {
      return {
        result: {
          ok: false,
          summary: 'ambiguous',
          error: `I found ${result.entries.length} items matching "${name}" in the Recycle Bin: ${result.entries.map((e) => e.name).join(', ')}. Which one?`,
          data: { items: result.entries.map(summarizeEntry) },
        },
      };
    }
    const entry = result.entries[0];
    if (entry === undefined) return { result: { ok: false, summary: 'not found', error: `I don't see anything named "${name}" in the Recycle Bin.` } };
    return { entry };
  }

  const restoreRecycleBinItem: Tool = {
    schema: {
      name: 'restore_recycle_bin_item',
      status: 'Restoring…',
      description:
        'Restore one item from the Recycle Bin back to where it was, by name (optionally narrowed by when it was ' +
        'deleted). Refuses if the name matches more than one item, or if the original location is outside the user folder.',
      args: { name: { type: 'string', required: true, description: 'The file or folder name to restore.' }, ...dateArgs },
    },
    async execute(args): Promise<ToolResult> {
      const resolved = await resolveOne(args);
      if ('result' in resolved) return resolved.result;
      const { entry } = resolved;
      const destCheck = checkPath(entry.originalPath, folders);
      if (!destCheck.ok) {
        return { ok: false, summary: 'not allowed', error: `I can't restore that: its original location ${destCheck.reason}.` };
      }
      const destDirCheck = checkPath(dirname(entry.originalPath), folders);
      if (!destDirCheck.ok) return { ok: false, summary: 'not allowed', error: destDirCheck.reason };
      const destDirIsFolder = await fs.stat(destDirCheck.path).then((s) => s.isDirectory(), () => false);
      if (!destDirIsFolder) {
        return { ok: false, summary: 'folder missing', error: "The folder it came from no longer exists, so I can't restore it there." };
      }
      const conflict = await fs.stat(destCheck.path).then(() => true, () => false);
      if (conflict) {
        return {
          ok: false,
          summary: 'name taken',
          error: `Something named "${entry.name}" already exists at that location, so I can't restore it there without overwriting it.`,
        };
      }
      try {
        await deps.restoreItem(entry);
      } catch (err) {
        return { ok: false, summary: 'restore failed', error: `I could not restore that: ${String(err)}` };
      }
      const [backAtOriginal, goneFromBin] = await Promise.all([
        fs.stat(destCheck.path).then(() => true, () => false),
        fs.stat(entry.rawPath).then(() => false, () => true),
      ]);
      const verified = backAtOriginal && goneFromBin;
      return {
        ok: verified,
        summary: verified ? 'restored' : 'restore not verified',
        data: { path: destCheck.path, verification: { verified, backAtOriginal, goneFromBin } },
        ...(verified ? {} : { error: 'The restore did not fully verify.' }),
      };
    },
  };

  const restoreAllRecycleBinItems: Tool = {
    schema: {
      name: 'restore_all_recycle_bin_items',
      status: 'Restoring everything…',
      description: 'Restore every item currently in the Recycle Bin back to where it came from. Skips (and reports) any that cannot be restored, rather than failing everything.',
      args: {},
    },
    async execute(): Promise<ToolResult> {
      const entries = await deps.listItems();
      let restored = 0;
      const skipped: string[] = [];
      for (const entry of entries) {
        const destCheck = checkPath(entry.originalPath, folders);
        if (!destCheck.ok) {
          skipped.push(entry.name);
          continue;
        }
        const conflict = await fs.stat(destCheck.path).then(() => true, () => false);
        if (conflict) {
          skipped.push(entry.name);
          continue;
        }
        try {
          await deps.restoreItem(entry);
          const ok = await fs.stat(destCheck.path).then(() => true, () => false);
          if (ok) restored += 1;
          else skipped.push(entry.name);
        } catch {
          skipped.push(entry.name);
        }
      }
      return {
        ok: skipped.length === 0,
        summary: `restored ${restored} of ${entries.length}`,
        data: { restored, total: entries.length, skipped },
        ...(skipped.length > 0 ? { error: `${skipped.length} item(s) could not be restored: ${skipped.join(', ')}.` } : {}),
      };
    },
  };

  const permanentlyDeleteRecycleBinItem: Tool = {
    schema: {
      name: 'permanently_delete_recycle_bin_item',
      status: 'Permanently deleting…',
      description: 'Permanently delete one item that is already in the Recycle Bin, by name. It cannot be recovered afterward. Only call this once the user has clearly asked for a permanent removal of that specific item.',
      args: { name: { type: 'string', required: true, description: 'The file or folder name to remove for good.' }, ...dateArgs },
    },
    async execute(args): Promise<ToolResult> {
      const resolved = await resolveOne(args);
      if ('result' in resolved) return resolved.result;
      const { entry } = resolved;
      try {
        await deps.permanentlyDeleteItem(entry);
      } catch (err) {
        return { ok: false, summary: 'delete failed', error: `I could not delete that: ${String(err)}` };
      }
      const gone = await fs.stat(entry.rawPath).then(() => false, () => true);
      return {
        ok: gone,
        summary: gone ? 'permanently deleted' : 'deletion not verified',
        data: { name: entry.name, verification: { verified: gone } },
        ...(gone ? {} : { error: 'That item may still be in the Recycle Bin.' }),
      };
    },
  };

  const emptyRecycleBin: Tool = {
    schema: {
      name: 'empty_recycle_bin',
      status: 'Emptying the Recycle Bin…',
      requiresConfirmation: true,
      description:
        'Permanently and irreversibly remove everything in the Recycle Bin. ALWAYS ask first: the first call ' +
        '(without confirm) empties nothing and instead reports how many items and how much space, plus exactly that ' +
        'question to ask. Only call again with confirm=true once the user has clearly said yes. Never set confirm=true on the first call.',
      args: { confirm: { type: 'boolean', description: 'Set true only after the user has explicitly said yes to emptying it.' } },
    },
    async execute(args): Promise<ToolResult> {
      const { count, totalBytes } = await deps.countAndSize();
      if (!boolArg(args, 'confirm')) {
        if (count === 0) return { ok: true, summary: 'already empty' };
        const mb = Math.max(1, Math.round(totalBytes / 1024 / 1024));
        return {
          ok: false,
          summary: 'needs confirmation',
          error: `The Recycle Bin has ${count} item${count === 1 ? '' : 's'}, about ${mb} MB. Do you want me to permanently empty it? This cannot be undone.`,
          data: permissionRequest('empty_recycle_bin', 'the Recycle Bin', 'This permanently removes everything in it. It cannot be undone.'),
        };
      }
      try {
        await deps.emptyBin();
      } catch (err) {
        return { ok: false, summary: 'empty failed', error: `I could not empty the Recycle Bin: ${String(err)}` };
      }
      const after = await deps.countAndSize();
      const verified = after.count === 0;
      return {
        ok: verified,
        summary: verified ? 'emptied the Recycle Bin' : 'not fully emptied',
        data: { remaining: after.count, verification: { verified } },
        ...(verified ? {} : { error: `${after.count} item(s) are still there.` }),
      };
    },
  };

  return [
    getRecycleBinCount,
    getRecycleBinItems,
    findRecycleBinItem,
    restoreRecycleBinItem,
    restoreAllRecycleBinItems,
    permanentlyDeleteRecycleBinItem,
    emptyRecycleBin,
  ];
}
