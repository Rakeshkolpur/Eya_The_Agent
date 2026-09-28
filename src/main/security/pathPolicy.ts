import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';

export interface KnownFolders {
  readonly home: string;
  readonly desktop: string;
  readonly documents: string;
  readonly downloads: string;
  readonly pictures: string;
  readonly videos: string;
  readonly music: string;
}

export type FolderName = keyof KnownFolders;

export const FOLDER_NAMES: readonly FolderName[] = [
  'downloads',
  'desktop',
  'documents',
  'pictures',
  'videos',
  'music',
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
