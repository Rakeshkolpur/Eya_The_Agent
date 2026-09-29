import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';

export interface KnownFolders {
  readonly home: string;
  readonly desktop: string;
  readonly documents: string;
  readonly downloads: string;
  readonly pictures: string;
  readonly videos: string;
  readonly music: string;
  readonly temp: string;
}

export type FolderName = keyof KnownFolders;

export const FOLDER_NAMES: readonly FolderName[] = [
  'downloads',
  'desktop',
  'documents',
  'pictures',
  'videos',
  'music',
  'temp',
  'home',
];

// Directories that hold credentials or app internals, never user documents.
const BLOCKED_DIRS = new Set(['.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', 'appdata']);

// Files that are secrets whatever folder they sit in. Notably this includes
// the .env holding the Gemini key, so the assistant can never read it back.
const BLOCKED_FILES: readonly RegExp[] = [
  /^\.env(\..*)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.(pem|pfx|p12|key|kdbx|ppk)$/i,
  /^\.(npmrc|netrc|pypirc)$/i,
  /^credentials(\.json)?$/i,
  /^secrets?\./i,
];

// Opening one of these runs code rather than showing a document.
const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.msix', '.scr', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.hta', '.lnk', '.reg', '.jar', '.cpl', '.dll', '.appx',
]);

export type PathCheck =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

export function isExecutablePath(path: string): boolean {
  return EXECUTABLE_EXTENSIONS.has(extname(path).toLowerCase());
}

export function isBlockedFileName(name: string): boolean {
  return BLOCKED_FILES.some((re) => re.test(name));
}

export function isBlockedDirName(name: string): boolean {
  return BLOCKED_DIRS.has(name.toLowerCase());
}

/** Turns "downloads" (or an absolute path) into a real folder path. */
export function resolveFolder(input: string, folders: KnownFolders): string | null {
  const key = input.trim().toLowerCase();
  if ((FOLDER_NAMES as readonly string[]).includes(key)) return folders[key as FolderName];
  if (isAbsolute(input.trim())) return resolve(input.trim());
  return null;
}

const RESERVED_WINDOWS_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export type NameCheck = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly reason: string };

/**
 * A bare file or folder name a tool was given (e.g. "Cases", "Case_List.pdf"),
 * never a path. This is the guard against "../" traversal snuck in through a
 * name argument rather than a path one: no separators of either kind are
 * allowed, so the result can only ever land inside the folder it was told to.
 */
export function checkItemName(input: string): NameCheck {
  const name = input.trim();
  if (name.length === 0) return { ok: false, reason: 'that name is empty' };
  if (name === '.' || name === '..') return { ok: false, reason: 'that is not a valid name' };
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    return { ok: false, reason: 'a name cannot contain a path' };
  }
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\x00-\x1f]/.test(name)) return { ok: false, reason: 'that name has characters Windows does not allow' };
  // A trailing space is already gone by the time we get here (the trim above
  // is a deliberate, harmless normalization, same as every other string arg
  // in this codebase); Windows itself also silently drops one, so there is
  // nothing meaningful left to reject there. A trailing dot is different: it
  // survives the trim and Windows genuinely refuses to create such a name.
  if (name.endsWith('.')) return { ok: false, reason: 'that name cannot end with a dot' };
  const stem = name.split('.')[0]?.toLowerCase() ?? '';
  if (RESERVED_WINDOWS_NAMES.has(stem)) return { ok: false, reason: 'that name is reserved by Windows' };
  if (name.length > 200) return { ok: false, reason: 'that name is too long' };
  return { ok: true, name };
}

/** Combines a resolved parent folder with a bare item name, then re-checks the result. */
export function resolveChildPath(parent: string, name: string, folders: KnownFolders): PathCheck {
  const nameCheck = checkItemName(name);
  if (!nameCheck.ok) return { ok: false, reason: nameCheck.reason };
  const parentCheck = checkPath(parent, folders);
  if (!parentCheck.ok) return parentCheck;
  return checkPath(resolve(parentCheck.path, nameCheck.name), folders);
}

/** Desktop, Downloads, home itself, etc. — never a valid target to delete, whatever else checks out. */
export function isKnownFolderRoot(path: string, folders: KnownFolders): boolean {
  const full = resolve(path);
  return FOLDER_NAMES.some((name) => resolve(folders[name]) === full);
}

/**
 * Everything the assistant may read or open must sit inside the user's home
 * folder and not be a secret. Paths are resolved first, so "..\" tricks
 * are compared on where they actually land.
 */
export function checkPath(target: string, folders: KnownFolders): PathCheck {
  if (target.trim().length === 0) return { ok: false, reason: 'empty path' };
  const full = resolve(target.trim());
  const home = resolve(folders.home);
  const rel = relative(home, full);
  // On Windows `relative` returns an absolute path when the drives differ.
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, reason: 'that path is outside your user folder' };
  }
  const segments = rel.split(sep).filter((s) => s.length > 0);
  for (const segment of segments.slice(0, -1)) {
    if (isBlockedDirName(segment)) return { ok: false, reason: 'that folder is protected' };
  }
  const last = basename(full);
  if (isBlockedDirName(last) || isBlockedFileName(last)) {
    return { ok: false, reason: 'that file is protected' };
  }
  return { ok: true, path: full };
}
