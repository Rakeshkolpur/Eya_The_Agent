import { promises as fsp } from 'node:fs';
import type { PendingSignal } from '@shared/tasks';
import { basename, dirname, extname, resolve } from 'node:path';
import { rootLogger } from '@main/logging/logger';
import type { TurnRef } from '@main/context/ConversationContext';
import type { KnownFolders } from '@main/security/pathPolicy';
import { resolveWhen } from '@main/tools/dateQuery';
import type { ToolArgs, ToolResult } from '@main/tools/types';
import type { IndexHit, IndexQuery, IndexResult, IndexedFolder } from './FileIndex';
import { parseLocalIntent } from './localIntents';
import type { FileQuery, LocalIntent } from './localIntents';

const log = rootLogger.child('local');

/** What a fast-path command did, in the shape the agent needs to speak it, remember it and note it in the history. */
export interface LocalCommandResult {
  readonly spoken: string;
  readonly ok: boolean;
  /** The kind of command, for the log and the conversation record. */
  readonly intent: string;
  readonly tools: readonly string[];
  readonly urls?: readonly string[];
  /** The files or folder involved, so "open the second one" and "copy it to Desktop" can refer back to them. */
  readonly refs: readonly TurnRef[];
  /** Set when this did not simply finish (the page is slow, a sign-in is needed): the task is kept and carried on by itself. */
  readonly pending?: PendingSignal;
}

export interface LocalCommandsDeps {
  readonly tools: { invoke(name: string, args: ToolArgs): Promise<ToolResult> };
  readonly index: {
    readonly ready: boolean;
    search(query: IndexQuery): IndexResult;
    searchFolders(tokens: readonly string[], limit?: number): readonly (IndexedFolder & { readonly score: number })[];
  };
  readonly folders: KnownFolders;
  /** The text on the clipboard, for "download this". Optional: without it that request goes to the model. */
  readonly clipboardText?: () => string;
  readonly now?: () => Date;
  /** Whether a file is still there (the index can be a moment out of date). */
  readonly exists?: (path: string) => Promise<boolean>;
}

const SPEAK_FILES = 3;

const FOLDER_LABELS: Readonly<Record<string, string>> = {
  downloads: 'Downloads',
  desktop: 'Desktop',
  documents: 'Documents',
  pictures: 'Pictures',
  videos: 'Videos',
  music: 'Music',
  home: 'your user folder',
};

const MAX_NAME_WORDS = 6;

/**
 * A file name as it should be read aloud: no underscores (the speech cleaner would glue the words together), no long digit runs (read
 * out digit by digit, a 15-digit scan name took about eight seconds to say), no stray dashes between words, and no more than a handful
 * of words (the full path is kept for "open the second one"; the ear only needs enough to tell the files apart).
 */
function speakable(name: string): string {
  const words = name
    .replace(/_+/g, ' ')
    .replace(/\d{6,}/g, 'a number')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)); // a lone "-" or "&" says nothing
  return words.slice(0, MAX_NAME_WORDS).join(' ');
}

export class LocalCommands {
  private readonly now: () => Date;
  private readonly exists: (path: string) => Promise<boolean>;

  constructor(private readonly deps: LocalCommandsDeps) {
    this.now = deps.now ?? (() => new Date());
    this.exists = deps.exists ?? ((path) => fsp.access(path).then(() => true, () => false));
  }

  /**
   * Carries the request out if it is an everyday command this layer knows, or returns null so the model takes it as before.
   * `live` is always-on listening, where anything heard in the room could be taken for a command: nothing that fetches from
   * the internet is done from there.
   */
  async tryHandle(text: string, options: { readonly live?: boolean } = {}): Promise<LocalCommandResult | null> {
    const intent = parseLocalIntent(text);
    if (intent === null) return null;
    if (options.live === true && intent.kind === 'download') return null;
    const started = Date.now();
    try {
      const result = await this.run(intent);
      log.info('local command', { kind: intent.kind, handled: result !== null, ok: result?.ok, ms: Date.now() - started });
      return result;
    } catch (err) {
      // A failure here must never stop Eya answering: let the model have it.
      log.warn('local command failed; passing it on', { kind: intent.kind, err: String(err) });
      return null;
    }
  }

  private run(intent: LocalIntent): Promise<LocalCommandResult | null> {
    switch (intent.kind) {
      case 'open_site':
        return this.openUrl(intent.url, intent.label, `Opening ${intent.label}.`, 'open_site', intent.browser);
      case 'search':
        return this.openUrl(intent.url, intent.site.label, `Searching ${intent.site.label} for ${intent.query}.`, 'search_site', intent.browser);
      case 'open_folder':
        return this.openKnownFolder(intent.folder);
      case 'open_named_folder':
        return this.openNamedFolder(intent.tokens);
      case 'file':
        return intent.action === 'open' ? this.openFile(intent) : this.findFiles(intent);
      case 'download':
        return this.download(intent.url);
    }
  }

  // -------------------------------------------------------------------------- web

  private async openUrl(url: string, label: string, success: string, intent: string, browser?: string): Promise<LocalCommandResult> {
    // No browser named: open_url uses Chrome.
    const result = await this.deps.tools.invoke('open_url', { url, ...(browser !== undefined ? { browser } : {}) });
    const where = browser === 'edge' ? 'Edge' : browser === 'firefox' ? 'Firefox' : browser === 'chrome' ? 'Chrome' : '';
    return {
      spoken: result.ok ? (where === '' ? success : success.replace(/\.$/, ` in ${where}.`)) : `I couldn't open ${label}.`,
      ok: result.ok,
      intent,
      tools: ['open_url'],
      ...(result.ok ? { urls: [url] } : {}),
      refs: [],
    };
  }

  private async download(url: string | null): Promise<LocalCommandResult | null> {
    let address = url;
    if (address === null) {
      // "download this": the link the user just copied. Only a web address on the clipboard counts; anything else is for the model.
      const copied = this.deps.clipboardText?.().trim() ?? '';
      if (!/^https?:\/\/\S+$/i.test(copied)) return null;
      address = copied;
    }
    // The user said or pasted the address, or copied it and said "download this": that is their yes.
    const result = await this.deps.tools.invoke('download_file', { url: address, confirm: true });
    const data = result.data ?? {};
    const name = typeof data['name'] === 'string' ? speakable(data['name']) : 'the file';
    const path = typeof data['path'] === 'string' ? data['path'] : undefined;
    const refs: TurnRef[] = path === undefined ? [] : [{ kind: 'file', value: path, meta: { index: 0, name: basename(path) } }];
    if (!result.ok) {
      return { spoken: result.error ?? "I couldn't download that.", ok: false, intent: 'download', tools: ['download_file'], refs };
    }
    const spoken = data['inProgress'] === true
      ? `Downloading ${name}. It will be in your Downloads folder when it finishes.`
      : `Downloaded ${name} to your Downloads folder.`;
    return { spoken, ok: true, intent: 'download', tools: ['download_file'], refs };
  }

  // ------------------------------------------------------------------------ folders

  private async openKnownFolder(folder: keyof KnownFolders): Promise<LocalCommandResult> {
    const result = await this.deps.tools.invoke('open_folder', { folder });
    const label = FOLDER_LABELS[folder] ?? folder;
    const path = this.deps.folders[folder];
    return {
      spoken: result.ok ? `Opening ${label}.` : `I couldn't open ${label}.`,
      ok: result.ok,
      intent: 'open_folder',
      tools: ['open_folder'],
      refs: result.ok ? [{ kind: 'folder', value: path }] : [],
    };
  }

  private async openNamedFolder(tokens: readonly string[]): Promise<LocalCommandResult | null> {
    if (!this.deps.index.ready) return null;
    const found = this.deps.index.searchFolders(tokens, 3);
    const best = found[0];
    if (best === undefined) return null;
    // Two equally good folders of that name: which one is the user's to say.
    if (found[1] !== undefined && found[1].score === best.score && best.score >= 10) return null;
    const result = await this.deps.tools.invoke('open_folder', { folder: best.path });
    return {
      spoken: result.ok ? `Opening the ${speakable(best.name)} folder.` : `I couldn't open the ${speakable(best.name)} folder.`,
      ok: result.ok,
      intent: 'open_folder',
      tools: ['open_folder'],
      refs: result.ok ? [{ kind: 'folder', value: best.path }] : [],
    };
  }

  // -------------------------------------------------------------------------- files

  private queryFor(q: FileQuery): IndexQuery {
    const range = q.when === undefined ? undefined : resolveWhen(q.when, this.now());
    return {
      tokens: q.tokens,
      ...(q.extensions !== undefined ? { extensions: q.extensions } : {}),
      ...(q.folder !== undefined ? { folder: this.deps.folders[q.folder] } : {}),
      sort: q.newest ? 'newest' : 'best',
      limit: q.limit,
      ...(range !== undefined ? { modifiedFrom: range.from, modifiedTo: range.to } : {}),
    };
  }

  /** The matches that are still on disk. An empty list means "ask the full search", never "there is no such file". */
  private async liveHits(q: FileQuery): Promise<{ hits: IndexHit[]; total: number } | null> {
    if (!this.deps.index.ready) return null;
    const result = this.deps.index.search(this.queryFor(q));
    const hits: IndexHit[] = [];
    for (const hit of result.files) if (await this.exists(hit.path)) hits.push(hit);
    return hits.length === 0 ? null : { hits, total: result.total };
  }

  private whereIs(path: string): string {
    const dir = dirname(path);
    for (const key of ['downloads', 'desktop', 'documents', 'pictures', 'videos', 'music'] as const) {
      if (resolve(this.deps.folders[key]).toLowerCase() === resolve(dir).toLowerCase()) return FOLDER_LABELS[key] ?? key;
    }
    return basename(dir);
  }

  private refsFor(hits: readonly IndexHit[]): TurnRef[] {
    return hits.map((h, index) => ({ kind: 'file' as const, value: h.path, meta: { index, name: h.name } }));
  }

  private async findFiles(q: FileQuery): Promise<LocalCommandResult | null> {
    const found = await this.liveHits(q);
    if (found === null) return null;
    const { hits, total } = found;
    const first = hits[0];
    if (first === undefined) return null;
    let spoken: string;
    if (total === 1) {
      spoken = `I found ${speakable(first.name)} in ${this.whereIs(first.path)}.`;
    } else {
      const { list, folder } = this.listAloud(hits.slice(0, SPEAK_FILES), 'and');
      spoken = `I found ${total} files, starting with ${list}${folder !== null ? `, all in ${folder}` : ''}.`;
      if (total > Math.min(hits.length, SPEAK_FILES)) spoken += ' Say which one to open.';
    }
    return { spoken, ok: true, intent: 'find_file', tools: ['find_file'], refs: this.refsFor(hits) };
  }

  /**
   * Several files as one phrase the ear can follow quickly: where each is only when they are not all in the same folder (then the
   * folder is said once), and the file type only when they are not all the same type (asked for "a pdf", every answer is one).
   */
  private listAloud(files: readonly IndexHit[], joiner: 'and' | 'or'): { readonly list: string; readonly folder: string | null } {
    const places = files.map((f) => this.whereIs(f.path));
    const sameFolder = files.length > 1 && places.every((p) => p === places[0]);
    const types = files.map((f) => extname(f.name).toLowerCase());
    const sameType = files.length > 1 && types[0] !== '' && types.every((t) => t === types[0]);
    const items = files.map((f, i) => {
      const name = speakable(sameType ? basename(f.name, extname(f.name)) : f.name);
      return sameFolder ? name : `${name} in ${places[i]}`;
    });
    const last = items[items.length - 1] ?? '';
    const list = items.length <= 1 ? last : items.length === 2 ? `${items[0]} ${joiner} ${last}` : `${items.slice(0, -1).join(', ')}, ${joiner} ${last}`;
    return { list, folder: sameFolder ? (places[0] ?? null) : null };
  }

  /**
   * The file words like "the latest pdf" or "my resume" mean, for something that sends it (a chat), found the same way "open the latest
   * pdf" finds one: from the in-memory index, and only when one file is clearly the one. Several equally good matches are named so the
   * user can be more exact; nothing found (or an index that is not ready) is null, and the model's own search takes over.
   */
  async locateFile(words: string): Promise<{ readonly kind: 'one'; readonly path: string; readonly name: string } | { readonly kind: 'several'; readonly names: readonly string[]; readonly total: number } | null> {
    const intent = parseLocalIntent(`find my ${words.trim().replace(/^(?:the|my|a|an)\s+/i, '')}`);
    if (intent === null || intent.kind !== 'file') return null;
    const found = await this.liveHits(intent);
    const top = found?.hits[0];
    if (found === null || top === undefined) return null;
    const second = found.hits[1];
    if (intent.newest || second === undefined || top.score > second.score) return { kind: 'one', path: top.path, name: top.name };
    return { kind: 'several', names: found.hits.slice(0, SPEAK_FILES).map((h) => h.name), total: found.total };
  }

  private async openFile(q: FileQuery): Promise<LocalCommandResult | null> {
    const found = await this.liveHits(q);
    if (found === null) return null;
    const { hits } = found;
    const top = hits[0];
    if (top === undefined) return null;
    const second = hits[1];
    // Clearly the one: it is the only match, or "the latest" / no name was given (so the newest is meant), or it matches the
    // words better than anything else does. Several equally good matches are asked about, never guessed.
    const decisive = q.newest || second === undefined || top.score > second.score;
    if (!decisive) {
      const { list, folder } = this.listAloud(hits.slice(0, SPEAK_FILES), 'or');
      return {
        spoken: `I found ${found.total} files that fit: ${list}${folder !== null ? `, all in ${folder}` : ''}. Which one?`,
        ok: true,
        intent: 'find_file',
        tools: ['find_file'],
        refs: this.refsFor(hits),
      };
    }
    const result = await this.deps.tools.invoke('open_file', { path: top.path });
    if (!result.ok && /does not exist|not found/i.test(`${result.summary} ${result.error ?? ''}`)) return null; // the index was behind: search properly
    return {
      spoken: result.ok ? `Opening ${speakable(top.name)}.` : (result.error ?? `I couldn't open ${speakable(top.name)}.`),
      ok: result.ok,
      intent: 'open_file',
      tools: ['open_file'],
      refs: result.ok ? [{ kind: 'file', value: top.path, meta: { index: 0, name: top.name } }] : [],
    };
  }
}
