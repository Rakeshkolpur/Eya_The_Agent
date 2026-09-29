import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  checkItemName,
  checkPath,
  isKnownFolderRoot,
  resolveChildPath,
  resolveFolder,
} from '@main/security/pathPolicy';
import type { KnownFolders } from '@main/security/pathPolicy';
import { permissionRequest } from '@main/permissions/PermissionManager';
import { verifyAbsent, verifyFileExists, verifyFolderExists } from '../verify';
import type { Tool, ToolArgs, ToolResult } from '../types';

/**
 * File-mutating tools: create/copy/move/rename/delete. Every one of them
 * resolves and re-validates paths through the same pathPolicy as the
 * read-only tools (home-folder boundary, blocked names, no traversal), then
 * verifies the filesystem actually changed before reporting success.
 *
 * Anything destructive or that would silently overwrite something follows one
 * rule: the first call, without `confirm: true`, does nothing and returns a
 * plain-language question (as a normal tool result, not a special channel).
 * The model is told in its tool description to relay that question, then only
 * pass `confirm: true` on a later call once the user has clearly agreed in
 * this same conversation. This needs no new plumbing in the agent loop or the
 * Live bridge — it is an ordinary tool result flowing through the exact same
 * path every other tool result already takes.
 */

function stringArg(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function boolArg(args: ToolArgs, key: string): boolean {
  return args[key] === true;
}

async function statOrNull(path: string) {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

/** fs.rename across drives throws EXDEV; fall back to copy-then-delete for a real move. */
async function moveFile(source: string, destination: string): Promise<void> {
  try {
    await fs.rename(source, destination);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.copyFile(source, destination);
    await fs.unlink(source);
  }
}

/** Bounded recursive file count, just for an honest "this contains N files" in a delete confirmation. */
async function countFilesUnder(dir: string, limit = 5000): Promise<{ count: number; truncated: boolean }> {
  let count = 0;
  const queue = [dir];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    let entries;
    try {
      entries = await fs.readdir(next, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push(join(next, entry.name));
      else count += 1;
      if (count >= limit) return { count, truncated: true };
    }
  }
  return { count, truncated: false };
}

export function createFileOpsTools(folders: KnownFolders): Tool[] {
  const createFolder: Tool = {
    schema: {
      name: 'create_folder',
      status: 'Creating the folder…',
      description:
        'Create a new folder. Give the parent as a special folder name (desktop, downloads, documents, pictures, ' +
        'videos, music, home) or a full path, and the new folder\'s bare name (never a path). ' +
        'If it already exists, this succeeds without changing anything.',
      args: {
        parentFolder: {
          type: 'string',
          required: true,
          description: 'desktop, downloads, documents, pictures, videos, music, home, or a full path inside the user folder.',
        },
        name: { type: 'string', required: true, description: 'The new folder\'s name, e.g. "Cases". Never a path.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const parentArg = stringArg(args, 'parentFolder');
      const name = stringArg(args, 'name');
      if (parentArg === undefined || name === undefined) {
        return { ok: false, summary: 'missing arguments', error: 'A parent folder and a name are required.' };
      }
      const resolvedParent = resolveFolder(parentArg, folders);
      if (resolvedParent === null) {
        return { ok: false, summary: 'unknown folder', error: `I don't know a folder called "${parentArg}".` };
      }
      const check = resolveChildPath(resolvedParent, name, folders);
      if (!check.ok) return { ok: false, summary: 'not allowed', error: check.reason };

      const existing = await statOrNull(check.path);
      if (existing !== null) {
        if (!existing.isDirectory()) {
          return { ok: false, summary: 'name taken', error: 'A file with that name already exists there.' };
        }
        return { ok: true, summary: 'already existed', data: { path: check.path, created: false } };
      }
      try {
        await fs.mkdir(check.path, { recursive: false });
      } catch (err) {
        return { ok: false, summary: 'could not create', error: `I could not create that folder: ${String(err)}` };
      }
      const verification = await verifyFolderExists(check.path);
      return {
        ok: verification.verified,
        summary: verification.verified ? 'created the folder' : 'creation not verified',
        data: { path: check.path, created: true, verification },
        ...(verification.verified ? {} : { error: `The folder was created but ${verification.evidence}.` }),
      };
    },
  };

  const copyFile: Tool = {
    schema: {
      name: 'copy_file',
      status: 'Copying the file…',
      description:
        'Copy a file to a folder, keeping its original name. DESTRUCTIVE ONLY WHEN OVERWRITING: if a file with the ' +
        'same name is already there, the first call (without confirm) does not copy anything and instead returns a ' +
        'question to ask the user. Call again with confirm=true only after the user has clearly agreed in this ' +
        'conversation to replace it.',
      args: {
        sourcePath: { type: 'string', required: true, description: 'Full path to the file to copy (from a previous tool result).' },
        destinationFolder: {
          type: 'string',
          required: true,
          description: 'desktop, downloads, documents, pictures, videos, music, home, or a full path inside the user folder.',
        },
        confirm: { type: 'boolean', description: 'Set true only after the user has approved replacing an existing file.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const sourcePath = stringArg(args, 'sourcePath');
      const destArg = stringArg(args, 'destinationFolder');
      if (sourcePath === undefined || destArg === undefined) {
        return { ok: false, summary: 'missing arguments', error: 'A source file and destination folder are required.' };
      }
      const sourceCheck = checkPath(sourcePath, folders);
      if (!sourceCheck.ok) return { ok: false, summary: 'not allowed', error: sourceCheck.reason };
      const sourceStat = await statOrNull(sourceCheck.path);
      if (sourceStat === null) return { ok: false, summary: 'not found', error: 'That file does not exist.' };
      if (!sourceStat.isFile()) return { ok: false, summary: 'not a file', error: 'That is a folder, not a file.' };

      const resolvedDest = resolveFolder(destArg, folders);
      if (resolvedDest === null) return { ok: false, summary: 'unknown folder', error: `I don't know a folder called "${destArg}".` };
      const destDirCheck = checkPath(resolvedDest, folders);
      if (!destDirCheck.ok) return { ok: false, summary: 'not allowed', error: destDirCheck.reason };
      const destStat = await statOrNull(destDirCheck.path);
      if (destStat === null || !destStat.isDirectory()) {
        return { ok: false, summary: 'destination missing', error: 'That destination folder does not exist.' };
      }

      const name = basename(sourceCheck.path);
      const destPathCheck = checkPath(join(destDirCheck.path, name), folders);
      if (!destPathCheck.ok) return { ok: false, summary: 'not allowed', error: destPathCheck.reason };

      const conflict = await statOrNull(destPathCheck.path);
      if (conflict !== null && !boolArg(args, 'confirm')) {
        return {
          ok: false,
          summary: 'needs confirmation',
          error: `A file named "${name}" already exists there. Should I replace it?`,
          data: permissionRequest('overwrite_file', name, `This would replace the existing "${name}" in that folder.`),
        };
      }

      try {
        await fs.copyFile(sourceCheck.path, destPathCheck.path);
      } catch (err) {
        return { ok: false, summary: 'copy failed', error: `I could not copy that file: ${String(err)}` };
      }
      const verification = await verifyFileExists(destPathCheck.path);
      return {
        ok: verification.verified,
        summary: verification.verified ? 'copied the file' : 'copy not verified',
        data: { path: destPathCheck.path, sourcePath: sourceCheck.path, replaced: conflict !== null, verification },
        ...(verification.verified ? {} : { error: `The copy did not verify: ${verification.evidence}.` }),
      };
    },
  };

  const moveFileTool: Tool = {
    schema: {
      name: 'move_file',
      status: 'Moving the file…',
      description:
        'Move a file to a different folder, keeping its name. DESTRUCTIVE ONLY WHEN OVERWRITING: if a file with the ' +
        'same name is already there, the first call (without confirm) does not move anything and instead returns a ' +
        'question to ask the user. Call again with confirm=true only after the user has clearly agreed to replace it.',
      args: {
        sourcePath: { type: 'string', required: true, description: 'Full path to the file to move (from a previous tool result).' },
        destinationFolder: {
          type: 'string',
          required: true,
          description: 'desktop, downloads, documents, pictures, videos, music, home, or a full path inside the user folder.',
        },
        confirm: { type: 'boolean', description: 'Set true only after the user has approved replacing an existing file.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const sourcePath = stringArg(args, 'sourcePath');
      const destArg = stringArg(args, 'destinationFolder');
      if (sourcePath === undefined || destArg === undefined) {
        return { ok: false, summary: 'missing arguments', error: 'A source file and destination folder are required.' };
      }
      const sourceCheck = checkPath(sourcePath, folders);
      if (!sourceCheck.ok) return { ok: false, summary: 'not allowed', error: sourceCheck.reason };
      const sourceStat = await statOrNull(sourceCheck.path);
      if (sourceStat === null) return { ok: false, summary: 'not found', error: 'That file does not exist.' };
      if (!sourceStat.isFile()) return { ok: false, summary: 'not a file', error: 'That is a folder, not a file.' };

      const resolvedDest = resolveFolder(destArg, folders);
      if (resolvedDest === null) return { ok: false, summary: 'unknown folder', error: `I don't know a folder called "${destArg}".` };
      const destDirCheck = checkPath(resolvedDest, folders);
      if (!destDirCheck.ok) return { ok: false, summary: 'not allowed', error: destDirCheck.reason };
      const destStat = await statOrNull(destDirCheck.path);
      if (destStat === null || !destStat.isDirectory()) {
        return { ok: false, summary: 'destination missing', error: 'That destination folder does not exist.' };
      }

      const name = basename(sourceCheck.path);
      const destPathCheck = checkPath(join(destDirCheck.path, name), folders);
      if (!destPathCheck.ok) return { ok: false, summary: 'not allowed', error: destPathCheck.reason };

      if (destPathCheck.path === sourceCheck.path) {
        return { ok: true, summary: 'already there', data: { path: sourceCheck.path, moved: false } };
      }

      const conflict = await statOrNull(destPathCheck.path);
      if (conflict !== null && !boolArg(args, 'confirm')) {
        return {
          ok: false,
          summary: 'needs confirmation',
          error: `A file named "${name}" already exists there. Should I replace it?`,
          data: permissionRequest('overwrite_file', name, `This would replace the existing "${name}" in that folder.`),
        };
      }

      try {
        await moveFile(sourceCheck.path, destPathCheck.path);
      } catch (err) {
        return { ok: false, summary: 'move failed', error: `I could not move that file: ${String(err)}` };
      }
      const [existsNow, goneFromOld] = await Promise.all([
        verifyFileExists(destPathCheck.path),
        verifyAbsent(sourceCheck.path),
      ]);
      const verified = existsNow.verified && goneFromOld.verified;
      return {
        ok: verified,
        summary: verified ? 'moved the file' : 'move not verified',
        data: {
          path: destPathCheck.path,
          previousPath: sourceCheck.path,
          replaced: conflict !== null,
          verification: { destination: existsNow, source: goneFromOld },
        },
        ...(verified ? {} : { error: 'The move did not fully verify.' }),
      };
    },
  };

  const renameFile: Tool = {
    schema: {
      name: 'rename_file',
      status: 'Renaming the file…',
      description:
        'Rename a file in place (it stays in the same folder). DESTRUCTIVE ONLY WHEN OVERWRITING: if a file with the ' +
        'new name already exists there, the first call (without confirm) does nothing and returns a question to ask ' +
        'the user. Call again with confirm=true only after the user has clearly agreed to replace it.',
      args: {
        path: { type: 'string', required: true, description: 'Full path to the file to rename (from a previous tool result).' },
        newName: { type: 'string', required: true, description: 'The new file name, including its extension. Never a path.' },
        confirm: { type: 'boolean', description: 'Set true only after the user has approved replacing an existing file.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const path = stringArg(args, 'path');
      const newName = stringArg(args, 'newName');
      if (path === undefined || newName === undefined) {
        return { ok: false, summary: 'missing arguments', error: 'A file and a new name are required.' };
      }
      const sourceCheck = checkPath(path, folders);
      if (!sourceCheck.ok) return { ok: false, summary: 'not allowed', error: sourceCheck.reason };
      const sourceStat = await statOrNull(sourceCheck.path);
      if (sourceStat === null) return { ok: false, summary: 'not found', error: 'That file does not exist.' };
      if (!sourceStat.isFile()) return { ok: false, summary: 'not a file', error: 'That is a folder, not a file.' };

      const nameCheck = checkItemName(newName);
      if (!nameCheck.ok) return { ok: false, summary: 'bad name', error: nameCheck.reason };
      const destPathCheck = checkPath(join(dirname(sourceCheck.path), nameCheck.name), folders);
      if (!destPathCheck.ok) return { ok: false, summary: 'not allowed', error: destPathCheck.reason };

      // Windows paths are case-insensitive: a rename that only changes case still
      // resolves the "old" path to the same file afterwards, so it must not be
      // treated as a delete-then-create when deciding what to verify.
      const caseOnlyRename = destPathCheck.path.toLowerCase() === sourceCheck.path.toLowerCase();

      if (!caseOnlyRename) {
        const conflict = await statOrNull(destPathCheck.path);
        if (conflict !== null && !boolArg(args, 'confirm')) {
          return {
            ok: false,
            summary: 'needs confirmation',
            error: `A file named "${nameCheck.name}" already exists there. Should I replace it?`,
            data: permissionRequest('overwrite_file', nameCheck.name, `This would replace the existing "${nameCheck.name}".`),
          };
        }
      }

      try {
        await fs.rename(sourceCheck.path, destPathCheck.path);
      } catch (err) {
        return { ok: false, summary: 'rename failed', error: `I could not rename that file: ${String(err)}` };
      }
      const existsNow = await verifyFileExists(destPathCheck.path);
      const goneFromOld = caseOnlyRename ? { verified: true, evidence: 'same file, only the case changed' } : await verifyAbsent(sourceCheck.path);
      const verified = existsNow.verified && goneFromOld.verified;
      return {
        ok: verified,
        summary: verified ? 'renamed the file' : 'rename not verified',
        data: { path: destPathCheck.path, previousPath: sourceCheck.path, verification: { destination: existsNow, source: goneFromOld } },
        ...(verified ? {} : { error: 'The rename did not fully verify.' }),
      };
    },
  };

  const deleteFile: Tool = {
    schema: {
      name: 'delete_file',
      status: 'Deleting the file…',
      requiresConfirmation: true,
      description:
        'Permanently delete a file. ALWAYS requires confirmation: the first call (without confirm) deletes nothing ' +
        'and instead returns a question to ask the user. Call again with confirm=true only after the user has ' +
        'clearly said yes to deleting it in this conversation. Never set confirm=true on the first call.',
      args: {
        path: { type: 'string', required: true, description: 'Full path to the file to delete (from a previous tool result).' },
        confirm: { type: 'boolean', description: 'Set true only after the user has explicitly said yes to deleting this file.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const path = stringArg(args, 'path');
      if (path === undefined) return { ok: false, summary: 'no path', error: 'A path is required.' };
      const check = checkPath(path, folders);
      if (!check.ok) return { ok: false, summary: 'not allowed', error: check.reason };
      const stat = await statOrNull(check.path);
      if (stat === null) return { ok: false, summary: 'not found', error: 'That file does not exist.' };
      if (!stat.isFile()) return { ok: false, summary: 'not a file', error: 'That is a folder; use delete_folder.' };

      const name = basename(check.path);
      if (!boolArg(args, 'confirm')) {
        return {
          ok: false,
          summary: 'needs confirmation',
          error: `Do you want me to permanently delete "${name}"?`,
          data: permissionRequest('delete_file', name, 'This permanently removes the file. It cannot be undone.'),
        };
      }

      try {
        await fs.unlink(check.path);
      } catch (err) {
        return { ok: false, summary: 'delete failed', error: `I could not delete that file: ${String(err)}` };
      }
      const verification = await verifyAbsent(check.path);
      return {
        ok: verification.verified,
        summary: verification.verified ? 'deleted the file' : 'deletion not verified',
        data: { path: check.path, verification },
        ...(verification.verified ? {} : { error: `The file may not have been deleted: ${verification.evidence}.` }),
      };
    },
  };

  const deleteFolder: Tool = {
    schema: {
      name: 'delete_folder',
      status: 'Deleting the folder…',
      requiresConfirmation: true,
      description:
        'Permanently delete a folder and everything inside it. ALWAYS requires confirmation: the first call ' +
        '(without confirm) deletes nothing and instead returns how many files it contains and a question to ask the ' +
        'user. Call again with confirm=true only after the user has clearly said yes in this conversation. This is ' +
        'more dangerous than delete_file, so be especially sure the user means it. Never set confirm=true on the first call.',
      args: {
        path: { type: 'string', required: true, description: 'Full path to the folder to delete (from a previous tool result).' },
        confirm: { type: 'boolean', description: 'Set true only after the user has explicitly said yes to deleting this folder.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const path = stringArg(args, 'path');
      if (path === undefined) return { ok: false, summary: 'no path', error: 'A path is required.' };
      const check = checkPath(path, folders);
      if (!check.ok) return { ok: false, summary: 'not allowed', error: check.reason };
      if (isKnownFolderRoot(check.path, folders)) {
        return { ok: false, summary: 'refused', error: 'That is one of your main folders, so I will not delete it.' };
      }
      const stat = await statOrNull(check.path);
      if (stat === null) return { ok: false, summary: 'not found', error: 'That folder does not exist.' };
      if (!stat.isDirectory()) return { ok: false, summary: 'not a folder', error: 'That is a file; use delete_file.' };

      const name = basename(check.path);
      if (!boolArg(args, 'confirm')) {
        const { count, truncated } = await countFilesUnder(check.path);
        const countText = `${count}${truncated ? '+' : ''} file${count === 1 && !truncated ? '' : 's'}`;
        return {
          ok: false,
          summary: 'needs confirmation',
          error: `"${name}" contains ${countText}. Do you want me to permanently delete the whole folder?`,
          data: {
            ...permissionRequest('delete_folder', name, `This permanently removes the folder and ${countText} inside it. It cannot be undone.`),
            fileCount: count,
            fileCountTruncated: truncated,
          },
        };
      }

      try {
        await fs.rm(check.path, { recursive: true, force: false });
      } catch (err) {
        return { ok: false, summary: 'delete failed', error: `I could not delete that folder: ${String(err)}` };
      }
      const verification = await verifyAbsent(check.path);
      return {
        ok: verification.verified,
        summary: verification.verified ? 'deleted the folder' : 'deletion not verified',
        data: { path: check.path, verification },
        ...(verification.verified ? {} : { error: `The folder may not have been deleted: ${verification.evidence}.` }),
      };
    },
  };

  return [createFolder, copyFile, moveFileTool, renameFile, deleteFile, deleteFolder];
}
