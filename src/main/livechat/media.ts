import { basename, extname, isAbsolute, relative, resolve } from 'node:path';

/**
 * Pictures and documents the other person sends in a live chat. Eya may take them into the person's Downloads folder — and only there — and read them, so that she can say
 * what she received and ask why it was sent. This is the policy for that, pure and tested on its own: which files are taken at all, where they may go, what they are called,
 * how big they may be. What is never done here: a file that is a program, a script, an archive, a shortcut or an installer is never taken (and never opened), a file is
 * never written outside Downloads, and an existing file is never overwritten.
 */

/** Bigger than this is neither taken nor read. */
export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
/** How many pictures or documents are looked at after one burst of messages (the rest are said to be skipped). */
export const MAX_MEDIA_PER_LOOK = 3;

const IMAGES: ReadonlySet<string> = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const DOCUMENTS: ReadonlySet<string> = new Set(['.pdf', '.doc', '.docx', '.txt', '.rtf', '.csv', '.xls', '.xlsx', '.ppt', '.pptx', '.odt']);

/** What kind of file this name is, if it is one Eya takes at all: a picture or an ordinary document. Anything else (a program, a script, an archive, a shortcut) is null. */
export function acceptableMedia(fileName: string): 'image' | 'document' | null {
  const ext = extname(fileName.trim()).toLowerCase();
  if (IMAGES.has(ext)) return 'image';
  if (DOCUMENTS.has(ext)) return 'document';
  return null;
}

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** A name that is safe to write on Windows: no folders, no odd characters, no trailing dots or spaces, no reserved device names, not too long. */
export function safeFileName(name: string): string {
  const base = basename(name.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  let clean = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  if (clean === '' || RESERVED.test(clean)) clean = `file${clean !== '' ? `_${clean}` : ''}`;
  if (clean.length > 120) {
    const ext = extname(clean);
    clean = `${clean.slice(0, 120 - ext.length)}${ext}`;
  }
  return clean;
}

/** Is `path` inside `folder` (or the folder itself's child at any depth)? Compared as Windows compares paths: case-insensitively, after `..` is resolved. */
export function isInsideFolder(path: string, folder: string): boolean {
  if (path === '' || folder === '') return false;
  const rel = relative(resolve(folder).toLowerCase(), resolve(path).toLowerCase());
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** The extension a picture really is, from its first bytes (a mime type or a name can say anything). Null: not a picture Eya takes. */
export function sniffImage(bytes: Uint8Array): '.jpg' | '.png' | '.gif' | '.webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return '.png';
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return '.gif';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return '.webp';
  return null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "WhatsApp picture 2026-11-06 at 07.41.22.jpg": what a picture taken from the chat is called in Downloads. */
export function pictureFileName(ext: string, at: Date): string {
  return `WhatsApp picture ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} at ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}${ext}`;
}

/** A path in `folder` for this name that does not exist yet ("name (2).ext"): an existing file is never overwritten. */
export function freePath(folder: string, name: string, exists: (path: string) => boolean): string {
  const clean = safeFileName(name);
  const ext = extname(clean);
  const stem = ext === '' ? clean : clean.slice(0, -ext.length);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = resolve(folder, n === 1 ? clean : `${stem} (${n})${ext}`);
    if (!exists(candidate)) return candidate;
  }
  return resolve(folder, `${stem} (${Date.now()})${ext}`);
}

/** What a model said about a file, as one short line: no line breaks, no markdown marks, no more than `max` characters. It stays the other person's content: shown as data only. */
export function summaryLine(answer: string, max = 300): string {
  return answer
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
