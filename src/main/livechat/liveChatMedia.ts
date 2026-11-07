import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { docxText } from '@main/tools/impl/docx';
import type { BrowserAutomationService, BrowserChatLive } from '@main/browser/BrowserAutomationService';
import { rootLogger } from '@main/logging/logger';
import type { ToolArgs, ToolResult } from '@main/tools/types';
import type { LiveChatMedia, MediaSaved } from './LiveChatController';
import { acceptableMedia, freePath, isInsideFolder, MAX_MEDIA_BYTES, pictureFileName, safeFileName, sniffImage } from './media';

/**
 * Taking the pictures and documents the other person sends in a live chat into the person's Downloads folder, and reading them. Everything that decides what is taken and
 * where it may go is in media.ts; this does the work with the browser and the disk, and says in a plain sentence why a file was not taken:
 *   - a picture is taken from what the page holds (its own bytes) and written to Downloads under a new name, never over a file that is there;
 *   - a document is downloaded by the browser itself, by pressing the document's own download button — and only if the name the page shows is a picture or an ordinary document
 *     (never a program, a script, an archive or a shortcut);
 *   - whatever the browser saved is checked afterwards: it must be in the Downloads folder (so a browser set to save somewhere else gets nothing opened), be a type that is taken, and
 *     not be too big. A file that fails those checks is left exactly where the browser put it, unopened, and said so.
 * Nothing is ever opened, run, changed, moved, deleted or sent on.
 */

const log = rootLogger.child('livechat.media');

export interface MediaFiles {
  exists(path: string): boolean;
  write(path: string, bytes: Uint8Array): void;
  /** The size of a file, or null when it is not there. */
  size(path: string): number | null;
  ensureFolder(path: string): void;
  /** The first words of a plain-text, CSV or Word file, read without any AI (null for any other kind of file, or one that cannot be read). */
  excerpt?(path: string): string | null;
}

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.log', '.json', '.rtf']);
const EXCERPT_CHARS = 700;

function readExcerpt(path: string): string | null {
  try {
    const ext = extname(path).toLowerCase();
    if (ext === '.docx') {
      const text = docxText(readFileSync(path));
      return text === null || text.trim() === '' ? null : `the first words are: ${text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS)}`;
    }
    if (!TEXT_EXTENSIONS.has(ext)) return null;
    const text = readFileSync(path, 'utf8').replace(/\s+/g, ' ').trim();
    return text === '' ? null : `the first words are: ${text.slice(0, EXCERPT_CHARS)}`;
  } catch {
    return null;
  }
}

export const realMediaFiles: MediaFiles = {
  exists: (p) => existsSync(p),
  write: (p, bytes) => writeFileSync(p, bytes, { flag: 'wx' }),
  size: (p) => {
    try {
      return statSync(p).size;
    } catch {
      return null;
    }
  },
  ensureFolder: (p) => mkdirSync(p, { recursive: true }),
  excerpt: readExcerpt,
};

export interface MediaWiring {
  readonly service: BrowserAutomationService & Partial<BrowserChatLive>;
  /** The Downloads folder: the ONLY place a file from a chat may be. */
  readonly downloadsDir: string;
  /** The tools, for reading a saved file (analyze_document). */
  readonly tools: { invoke(name: string, args: ToolArgs): Promise<ToolResult> };
  readonly files?: MediaFiles;
  readonly now?: () => Date;
}

const PICTURE_QUESTION = 'In one or two short sentences, say what this picture shows: the kind of picture (a photo, a screenshot, a scanned page), the main things or people in it, and any text you can read in it. Do not guess anyone\'s name.';
const DOCUMENT_QUESTION = 'In one or two short sentences, say what this document is and what it is about: who it seems to be from or for, what it states or asks for, and any dates or amounts in it. Be brief.';

export function createChatMedia(deps: MediaWiring): LiveChatMedia {
  const files = deps.files ?? realMediaFiles;
  const now = deps.now ?? ((): Date => new Date());
  const no = (say: string): MediaSaved => ({ ok: false, say });

  return {
    async save(messageId, kind): Promise<MediaSaved> {
      const live = deps.service.chatMedia;
      if (typeof live !== 'function') return no('This browser connection cannot take files out of a chat.');
      const take = (step: 'look' | 'download') => live.call(deps.service, messageId, step);

      // ------------------------------------------------------------------------------------------------ a picture: its own bytes, written to Downloads
      if (kind === 'image') {
        const got = await take('look');
        if (!got.ok) return no(got.message);
        if (got.via !== 'bytes') return no('The picture was not there to take.');
        if (got.data.length > MAX_MEDIA_BYTES) return no('The picture is too big for me to take.');
        const ext = sniffImage(got.data);
        if (ext === null) return no('What the page gave me is not a picture I can take.');
        files.ensureFolder(deps.downloadsDir);
        const path = freePath(deps.downloadsDir, pictureFileName(ext, now()), (p) => files.exists(p));
        if (!isInsideFolder(path, deps.downloadsDir)) return no('I could not find a safe place for it in your Downloads folder.');
        try {
          files.write(path, got.data);
        } catch {
          return no('I could not save it in your Downloads folder.');
        }
        return { ok: true, path, name: basename(path) };
      }

      // ------------------------------------------------------------------------------------------ a document: the browser's own download, checked afterwards
      const look = await take('look');
      if (!look.ok) return no(look.message);
      if (look.via !== 'document') return no('That is not a document I can take.');
      // (the type is judged by the name the page shows BEFORE anything is downloaded; a page that shows no name is judged by the file the browser saves)
      if (look.name !== '' && acceptableMedia(look.name) === null) return no(`It is a file of a type I do not take (${basename(look.name)}): I only take pictures and ordinary documents, so I did not download it.`);
      if (!look.hasControl) {
        const icons = look.icons ?? [];
        // (in the log, and in what the person is told: the page's icon names, so the next fix knows what WhatsApp actually draws there)
        log.warn('a document had no download control', { icons });
        return no(`I could not find the download button on that document${icons.length > 0 ? ` (the page showed: ${icons.join(', ')})` : ''}.`);
      }
      const got = await take('download');
      if (!got.ok) return no(got.message);
      if (got.via !== 'download' || got.download === null) return no('The download did not start.');
      const d = got.download;
      if (d.state !== 'complete' || d.path === '') return no('The download did not finish.');
      if (!isInsideFolder(d.path, deps.downloadsDir)) return no('Your browser saved it somewhere other than your Downloads folder, so I did not open it.');
      if (acceptableMedia(d.path) === null) return no(`The browser saved it as ${basename(d.path)}, a type I do not open. It is in your Downloads folder and I did not open it.`);
      const size = files.size(d.path);
      if (size === null) return no('I could not find the downloaded file.');
      if (size > MAX_MEDIA_BYTES) return no(`It is bigger than I read (${Math.round(size / (1024 * 1024))} MB). It is in your Downloads folder.`);
      return { ok: true, path: d.path, name: safeFileName(basename(d.path)) };
    },

    async read(path, kind): Promise<string | null> {
      // (only a file that is in Downloads is read: the tool's own path rules apply on top of this)
      if (!isInsideFolder(path, deps.downloadsDir)) return null;
      const out = await deps.tools.invoke('analyze_document', { path, question: kind === 'image' ? PICTURE_QUESTION : DOCUMENT_QUESTION });
      if (out.ok) {
        const answer = out.data?.['answer'];
        if (typeof answer === 'string' && answer.trim() !== '') return answer;
      }
      // The AI that reads files could not (its allowance for today is used up, say). A plain text, CSV or Word file can still be read right here, so the other person is not told
      // "I can't open it" about a file that was opened: what it starts with is what the reply goes on.
      return kind === 'document' ? (files.excerpt?.(path) ?? null) : null;
    },
  };
}
