import { promises as fs } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { FileActionResult, FileEntryView, FilesListing } from '@shared/ipcContract';
import type { ActivityInput } from '@main/memory/activityLog';
import { looksSensitive } from '@main/memory/normalize';
import { checkReadablePath, isExecutablePath } from '@main/security/pathPolicy';
import type { KnownFolders } from '@main/security/pathPolicy';
import type { ToolArgs, ToolResult } from '@main/tools/types';
import { extOf, IMAGE_EXTENSIONS, kindOf } from './fileBrowser';
import type { FileBrowser } from './fileBrowser';

const MAX_QUERY = 100;
const MAX_QUESTION = 300;
const MAX_THUMBNAILS = 24;
const SEARCH_LIMIT = 40;
const DEFAULT_QUESTION = 'Summarize the key points.';

export interface FilesDeps {
  readonly folders: KnownFolders;
  readonly browser: FileBrowser;
  /** Eya's own tools (find_file, open_file, open_folder, analyze_document): every action here goes through them, so their rules apply. */
  invoke(name: string, args: ToolArgs): Promise<ToolResult>;
  /** Shows a file in File Explorer, selected. */
  reveal(path: string): void;
  /** A small picture of an image file, as a data URL, or null. */
  thumbnail(path: string): Promise<string | null>;
  readonly activity?: { record(input: ActivityInput): void };
}

/** Gemini likes markdown; the answer is shown as plain text and read aloud, so the asterisks, backticks and heading marks come out. */
export function plainText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/__(.+?)__/gs, '$1')
    .replace(/(^|[\s(])\*(?=\S)([^*\n]+?)\*(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/`+/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[*-]\s+/gm, '• ')
    .trim();
}

/** A file's name as part of a history line — unless it looks like it should not be written down. */
export function fileLabel(verb: string, name: string): string {
  const shown = name.length > 48 ? `${name.slice(0, 47)}…` : name;
  return looksSensitive(name) || /\d{6,}/.test(name) ? `${verb} a file` : `${verb} "${shown}"`;
}

/**
 * What the Files screen can do. Listing is local and looks only at names, sizes and dates; opening, searching and reading go through
 * Eya's ordinary tools, so a file Eya may not touch (a secret, Windows' own files, another account's folder) is refused here exactly as
 * it is when she is asked in words. Asking about a file is the one thing that sends anything away (the file goes to Gemini to be
 * read), and it only happens when the user presses the button that says so.
 */
export class FilesService {
  constructor(private readonly deps: FilesDeps) {}

  list(view: Parameters<FileBrowser['list']>[0]): Promise<FilesListing> {
    return this.deps.browser.list(view);
  }

  browse(path: string): Promise<FilesListing> {
    return this.deps.browser.browse(path);
  }

  /** Searches the whole PC by name with Eya's own find_file (Windows' file index first). */
  async search(query: string): Promise<FilesListing> {
    const q = query.trim().slice(0, MAX_QUERY);
    const none = (error: string): FilesListing => ({ title: 'Search', folder: null, parent: null, items: [], truncated: false, error });
    if (q === '') return none('Type a file name to look for.');
    const result = await this.deps.invoke('find_file', { query: q, limit: SEARCH_LIMIT });
    if (!result.ok) return none(result.error ?? 'The search did not work. Try again.');
    const found = Array.isArray(result.data?.['files']) ? (result.data?.['files'] as unknown[]) : [];
    const items: FileEntryView[] = [];
    for (const raw of found) {
      const f = raw as { path?: unknown; modified?: unknown; sizeKB?: unknown };
      if (typeof f.path !== 'string' || !checkReadablePath(f.path, this.deps.folders).ok || isExecutablePath(f.path)) continue;
      const name = basename(f.path);
      // find_file reports size in whole kilobytes (0 for anything small), so the exact size comes from the file itself.
      const stat = await fs.stat(f.path).catch(() => null);
      items.push({
        path: f.path,
        name,
        kind: kindOf(name, false),
        ext: extOf(name),
        size: stat?.size ?? (typeof f.sizeKB === 'number' ? f.sizeKB * 1024 : 0),
        modified: stat?.mtime.toISOString() ?? (typeof f.modified === 'string' ? f.modified : new Date(0).toISOString()),
        where: this.deps.browser.friendly(dirname(f.path)),
      });
    }
    return { title: `Results for “${q}”`, folder: null, parent: null, items, truncated: result.data?.['truncated'] === true };
  }

  async open(path: string): Promise<FileActionResult> {
    const check = checkReadablePath(path, this.deps.folders);
    if (!check.ok) return { ok: false, message: `I can't open that: ${check.reason}.` };
    const isFolder = await fs.stat(check.path).then((s) => s.isDirectory(), () => null);
    if (isFolder === null) return { ok: false, message: 'That is gone: it may have been moved or deleted.' };
    const result = isFolder ? await this.deps.invoke('open_folder', { folder: check.path }) : await this.deps.invoke('open_file', { path: check.path });
    this.note(isFolder ? 'open_folder' : 'open_file', fileLabel('Opened', basename(check.path)), result.ok);
    return result.ok ? { ok: true, message: `Opened ${basename(check.path)}.` } : { ok: false, message: result.error ?? 'Windows could not open that.' };
  }

  async reveal(path: string): Promise<FileActionResult> {
    const check = checkReadablePath(path, this.deps.folders);
    if (!check.ok) return { ok: false, message: `I can't show that: ${check.reason}.` };
    if ((await fs.stat(check.path).catch(() => null)) === null) return { ok: false, message: 'That is gone: it may have been moved or deleted.' };
    this.deps.reveal(check.path);
    return { ok: true, message: 'Showing it in File Explorer.' };
  }

  /** Has Gemini read the file and answer. The user pressed the button that says the file is sent. */
  async ask(path: string, question: string): Promise<FileActionResult> {
    const q = question.trim().slice(0, MAX_QUESTION) || DEFAULT_QUESTION;
    const check = checkReadablePath(path, this.deps.folders);
    if (!check.ok) return { ok: false, message: `I can't read that: ${check.reason}.` };
    const result = await this.deps.invoke('analyze_document', { path: check.path, question: q });
    this.note('analyze_document', fileLabel('Asked about', basename(check.path)), result.ok);
    const answer = result.data?.['answer'];
    if (!result.ok || typeof answer !== 'string') return { ok: false, message: result.error ?? 'I could not get anything from that file.' };
    return { ok: true, message: 'Done.', answer: plainText(answer) };
  }

  /** Small pictures for image files (at most a screenful at a time), by path. Anything else, or anything not allowed, is skipped. */
  async thumbnails(paths: readonly string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const path of paths.slice(0, MAX_THUMBNAILS)) {
      if (typeof path !== 'string' || !IMAGE_EXTENSIONS.has(extOf(path)) || !checkReadablePath(path, this.deps.folders).ok) continue;
      const url = await this.deps.thumbnail(path).catch(() => null);
      if (url !== null) out[path] = url;
    }
    return out;
  }

  /** The history keeps a label only: no request, so it cannot be "repeated", and never what was asked or answered. */
  private note(tool: string, label: string, ok: boolean): void {
    try {
      this.deps.activity?.record({ request: '', label, tools: [tool], ok });
    } catch {
      // The history is a convenience.
    }
  }
}
