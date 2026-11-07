import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { rootLogger } from '@main/logging/logger';
import type {
  ActOnPageResult,
  AdsMode,
  AdsState,
  AttachFileRequest,
  AttachFileResult,
  BrowserAdHelper,
  BrowserAutomationService,
  BrowserCapture,
  BrowserChatLive,
  BrowserFileAttach,
  BrowserItemClicker,
  BrowserItemLister,
  BrowserKeyPress,
  BrowserTabControl,
  ChatMediaResult,
  ChatReadResult,
  ChatWatchResult,
  ClickGate,
  FillOptions,
  LiveChatMessage,
  FindOnPageResult,
  OpenWebsiteOptions,
  PageItem,
  ReadPageResult,
  ScreenshotImage,
  ScrollDirection,
} from '@main/browser/BrowserAutomationService';
import { decodeImageDataUrl } from '@main/browser/screenshotImage';
import { redactUrl } from '@main/browser/redactUrl';
import type { BrowserName } from './protocol';
import { withExtras } from '@main/browser/pageSnapshot';
import { BrowserNavigationError, BrowserUnavailableError, CommunicationAccessError } from '@main/browser/errors';
import { appNameForHost } from '@main/privacy/communicationAccess';
import type { ActionEffects, BrowserTabInfo, DownloadInfo } from '@main/browser/pageEffects';
import { challengeMessage, isBlockingChallenge } from '@main/browser/challenges';
import type { BrowserEnvironment, PageSnapshot } from '@main/browser/pageSnapshot';
import { searchEngineUrls } from '@main/browser/searchEngines';
import { cleanSearchHits } from '@main/browser/webSearchResults';
import type { RawSearchHit, WebSearchHit } from '@main/browser/webSearchResults';
import { BridgeError } from './ChromeBridge';
import { classifyNavigationError, describeHttpStatus, describeRedirect } from '@main/browser/navigationErrors';
import { chooseClickTarget, findFillTarget, findListItem, findInPage, navigationNames, normalizePageState, readChunk, splitNear, stateToSnapshot } from './pageState';
import type { PageElement, PageState } from './pageState';
import { diffStates } from './stateDiff';

const log = rootLogger.child('chrome.browser');

/** What the service needs from the bridge — small on purpose, so tests can stand in for the real thing. */
export interface BridgeLike {
  isConnected(): boolean;
  /** What the connected extension can do. Optional: without it every ability is assumed. */
  capabilities?(): readonly string[];
  request<T = unknown>(op: string, args?: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<T>;
}

interface ActionReply {
  readonly performed: { readonly ok: boolean; readonly reason?: string; readonly detail?: string; readonly options: readonly string[]; readonly moved?: boolean };
  readonly tabId: number | null;
  readonly state: PageState;
  readonly settled: boolean;
  readonly stillBusy: boolean;
  readonly newTab: { readonly tabId: number } | null;
  readonly download: DownloadInfo | null;
  readonly reuse: 'focused' | 'navigated' | null;
  /** For an open: where it was asked to go, where it ended up, what the site answered, and whether the page came up blank. */
  readonly navigation: { readonly requested: string; readonly final: string; readonly status: number | null; readonly blank: boolean } | null;
}

/** The address as a person says it: the host (and port, when it is not the usual one). */
function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

/** The reader's counts (rows it understood, rows it did not, bubble marks it saw): numbers only. Nothing from the chat can get through here. */
function readDiagnostics(raw: unknown): { readonly diagnostics?: { readonly rows: number; readonly otherRows: number; readonly messageLike: number; readonly how?: string; readonly unknownSide?: number; readonly sides?: Readonly<Record<string, number>>; readonly shape?: string } } {
  const d = asRecord(raw);
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.trunc(v), 100_000) : null);
  const rows = n(d['rows']);
  const otherRows = n(d['otherRows']);
  const messageLike = n(d['messageLike']);
  if (rows === null || otherRows === null) return {};
  const how = typeof d['how'] === 'string' && /^[a-z]{2,12}$/.test(d['how']) ? d['how'] : undefined;
  const unknownSide = n(d['unknownSide']);
  // (how many messages' sides were told by each means: counts under fixed names)
  const rawSides = asRecord(d['sides']);
  const sides: Record<string, number> = {};
  for (const key of ['id', 'cls', 'ticks', 'geo', 'author', 'dflt', 'conflicts']) {
    const v = n(rawSides[key]);
    if (v !== null) sides[key] = v;
  }
  // (the page's shape, masked by the extension — letters, digits and words of the chat are A a 9 — and kept to the characters such a description uses)
  const shape = typeof d['shape'] === 'string' ? d['shape'].replace(/[^A-Za-z0-9 _.:;,@#()[\]{}<>|=+/-]/g, '').slice(0, 600) : undefined;
  return { diagnostics: { rows, otherRows, messageLike: messageLike ?? 0, ...(how !== undefined ? { how } : {}), ...(unknownSide !== null ? { unknownSide } : {}), ...(Object.keys(sides).length > 0 ? { sides } : {}), ...(shape !== undefined && shape !== '' ? { shape } : {}) } };
}

function parseDownload(raw: unknown): DownloadInfo | null {
  const d = asRecord(raw);
  if (typeof d['filename'] !== 'string') return null;
  const state = d['state'] === 'complete' || d['state'] === 'interrupted' ? d['state'] : 'in_progress';
  return {
    path: d['filename'],
    name: d['filename'] === '' ? '' : basename(d['filename'].replace(/\\/g, '/')),
    state,
    bytes: typeof d['bytes'] === 'number' ? d['bytes'] : -1,
    ...(typeof d['mime'] === 'string' && d['mime'] !== '' ? { mime: d['mime'] } : {}),
    ...(typeof d['error'] === 'string' ? { error: d['error'] } : {}),
  };
}

function parseReply(raw: unknown): ActionReply {
  const r = asRecord(raw);
  const p = asRecord(r['performed']);
  const newTab = asRecord(r['newTab']);
  return {
    performed: {
      ok: p['ok'] !== false,
      ...(typeof p['reason'] === 'string' ? { reason: p['reason'] } : {}),
      ...(typeof p['detail'] === 'string' ? { detail: p['detail'] } : {}),
      ...(typeof p['moved'] === 'boolean' ? { moved: p['moved'] } : {}),
      options: Array.isArray(p['options']) ? p['options'].filter((o): o is string => typeof o === 'string').slice(0, 25) : [],
    },
    tabId: typeof r['tabId'] === 'number' ? r['tabId'] : null,
    state: normalizePageState(r['state']),
    settled: r['settled'] !== false,
    stillBusy: r['stillBusy'] === true,
    newTab: typeof newTab['tabId'] === 'number' ? { tabId: newTab['tabId'] } : null,
    download: parseDownload(r['download']),
    reuse: r['reuse'] === 'focused' || r['reuse'] === 'navigated' ? r['reuse'] : null,
    navigation: ((n) => (typeof n['requested'] === 'string' ? { requested: n['requested'], final: typeof n['final'] === 'string' ? n['final'] : '', status: typeof n['status'] === 'number' ? n['status'] : null, blank: n['blank'] === true } : null))(asRecord(r['navigation'])),
  };
}

/**
 * Eya's hands in the user's own, already-signed-in browser, through the Eya
 * Browser Bridge extension. Nothing here assumes a page's shape: every action
 * is look → choose something that really is there → act → look again, and what
 * the model is shown afterwards is that second look, not a prediction.
 */
export interface PageAgentServiceOptions {
  /** Which browser this is, stamped on every snapshot. */
  readonly environment?: BrowserEnvironment;
  /** What to say when the browser cannot be reached at all. */
  readonly unavailableMessage?: string;
  /** Which browser's extension this talks to, stamped on the tabs it lists. */
  readonly browserName?: BrowserName;
  /**
   * Whether this address is a single-page app such as a chat, where an action is followed by a short settle and no wait for a download
   * (a chat page never goes quiet, and nothing in it downloads). The extension does this when it is told `quick`; an older one ignores it.
   */
  readonly quickFor?: (url: string) => boolean;
}

// A page can be sent only so much in one message; base64 makes a part a third bigger again.
const ATTACH_CHUNK_BYTES = 3 * 1024 * 1024;
/** How many screenfuls a click looks down the page for a button that is not showing (a menu or list that fills in as it is scrolled). */
const MAX_FIND_SCROLLS = 6;
const ITEM_ROLES: ReadonlySet<string> = new Set(['link', 'button', 'menuitem', 'tab', 'option', 'clickable']);
/** A tick box is listed too (with whether it is ticked), but only to be read: it is never one of the rows a chat is chosen from. */
const READABLE_ROLES: ReadonlySet<string> = new Set([...ITEM_ROLES, 'checkbox']);

const DEFAULT_UNAVAILABLE =
  'Eya has lost her connection to your browser. Make sure the browser is open with the Eya Browser Bridge extension turned on (or ask Eya to "connect my browser").';

const OLD_FOR_CHAT = {
  ok: false,
  reason: 'extension_old',
  message: 'The Eya extension in this browser is from before it could watch a chat: reload it once on the extensions page (the circular arrow on its card), then start the live chat again.',
} as const;

/** An extension that has the live chat but not the reader for the page as WhatsApp shows it today (see 'chat_read_sides' in the extension): it would call a readable page unreadable. */
const NEEDS_NEWER_READER = {
  ok: false,
  reason: 'extension_old',
  message:
    'The Eya extension in this browser is older than this live chat needs: it cannot tell which side of the chat a message is on the way WhatsApp draws it today, so it calls the page unreadable. Reload it once on the extensions page (chrome://extensions or edge://extensions, the circular arrow on the Eya Browser Bridge card; it is then version 0.11.6), then start the live chat again.',
} as const;

/** An extension that has the live chat but reads a document's bubble as a plain text message (see 'chat_documents' in the extension): a PDF would never be taken. */
const NEEDS_DOCUMENT_READER = {
  ok: false,
  reason: 'extension_old',
  message:
    'The Eya extension in this browser is older than this live chat needs: it reads a document someone sends as an ordinary text message, so it can never download or read it. Reload it once on the extensions page (chrome://extensions or edge://extensions, the circular arrow on the Eya Browser Bridge card; it is then version 0.11.6), then start the live chat again.',
} as const;

/** An extension that cannot take a picture or a document out of a chat (see 'chat_media' in the extension): the live chat goes on, it just does not look at files. */
const MEDIA_NEEDS_NEWER = {
  ok: false,
  reason: 'extension_old',
  message: 'The Eya extension in this browser is older than looking at pictures and documents needs: reload it once on the extensions page (the circular arrow on its card; it is then version 0.11.6).',
} as const;

/** The most a picture's bytes may be when they come across from the page (the link carries 8 MB a message, and base64 is a third bigger). */
const MAX_PICTURE_BYTES = 5 * 1024 * 1024;

export class ChromeBrowserService implements BrowserAutomationService, BrowserTabControl, BrowserCapture, BrowserItemLister, BrowserItemClicker, BrowserKeyPress, BrowserFileAttach, BrowserAdHelper, BrowserChatLive {
  private readonly environment: BrowserEnvironment;
  private readonly unavailableMessage: string;
  private readonly browserName: BrowserName | undefined;
  private readonly quickFor: (url: string) => boolean;
  /** The site menu bar the model was last shown, so an identical one is not listed again on the next page. */
  private lastNavigation = new Set<string>();

  constructor(
    private readonly bridge: BridgeLike,
    options: PageAgentServiceOptions = {},
  ) {
    this.environment = options.environment ?? 'your_browser';
    this.unavailableMessage = options.unavailableMessage ?? DEFAULT_UNAVAILABLE;
    this.browserName = options.browserName;
    this.quickFor = options.quickFor ?? (() => false);
  }

  private async call<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    try {
      return await this.bridge.request<T>(op, args, timeoutMs);
    } catch (err) {
      if (err instanceof BridgeError && (err.code === 'not_connected' || err.code === 'disconnected')) {
        throw new BrowserUnavailableError(this.unavailableMessage);
      }
      // The extension refused to touch a chat app's tab because Communication Access is off ("communication_access_off: <host>").
      if (err instanceof BridgeError && err.code === 'extension_error') {
        const refused = /communication_access_off:\s*([^\s]+)/.exec(err.message);
        if (refused !== null) throw new CommunicationAccessError(appNameForHost(refused[1] as string));
      }
      throw err;
    }
  }

  private snapshot(state: PageState, notes: readonly string[] = []): PageSnapshot {
    const snap = stateToSnapshot(state, { environment: this.environment, notes, previousNavigation: this.lastNavigation });
    const nav = navigationNames(state);
    if (nav.length > 0) this.lastNavigation = new Set(nav);
    return snap;
  }

  /** A fresh look at the page Eya is on (or, if none yet, the tab the user is looking at). */
  private async look(): Promise<{ tabId: number | null; state: PageState }> {
    const raw = asRecord(await this.call('observe', {}));
    return { tabId: typeof raw['tabId'] === 'number' ? raw['tabId'] : null, state: normalizePageState(raw['state']) };
  }

  private blockedByChallenge(state: PageState): ActOnPageResult | null {
    // Eya stops at a CAPTCHA / bot check / verification-code prompt: no clicking around it, no trying to get past it.
    if (state.challenge !== null && isBlockingChallenge(state.challenge.kind)) {
      return { ok: false, reason: 'needs_user', message: challengeMessage(state.challenge.kind), snapshot: this.snapshot(state) };
    }
    return null;
  }

  private effectsOf(before: PageState, reply: ActionReply): ActionEffects {
    return {
      changes: diffStates(before, reply.state),
      settled: reply.settled,
      ...(reply.stillBusy ? { stillBusy: true } : {}),
      ...(reply.newTab !== null ? { newTab: { url: reply.state.url, title: reply.state.title } } : {}),
      ...(reply.download !== null ? { download: reply.download } : {}),
    };
  }

  private okResult(before: PageState, reply: ActionReply): ActOnPageResult {
    const notes: string[] = [];
    if (reply.newTab !== null) notes.push('That opened a new tab, and Eya moved to it.');
    if (!reply.settled) notes.push(reply.stillBusy ? 'A loading indicator was still showing when Eya looked — if something seems missing, look again in a moment.' : 'The page had not finished loading when Eya looked — if something seems missing, look again.');
    return { ok: true, snapshot: this.snapshot(reply.state, notes), effects: this.effectsOf(before, reply) };
  }

  private failureResult(reply: ActionReply): ActOnPageResult {
    const snapshot = this.snapshot(reply.state);
    const reason = reply.performed.reason ?? 'failed';
    const detail = reply.performed.detail ?? 'The page would not let that happen.';
    if (reason === 'sensitive_field' || reason === 'file_input') return { ok: false, reason: 'needs_user', message: detail, snapshot };
    if (reason === 'no_such_option' && reply.performed.options.length > 0) {
      return { ok: false, reason: 'could_not', message: `${detail} The choices are: ${reply.performed.options.join(', ')}.`, snapshot };
    }
    return { ok: false, reason: 'could_not', message: detail, snapshot };
  }

  async openWebsite(url: string, options?: OpenWebsiteOptions): Promise<PageSnapshot> {
    const reply = parseReply(await this.call('open_url', { url, ...(this.quickFor(url) ? { quick: true } : {}), ...(options?.fresh === true ? { fresh: true } : {}) }, 60_000));
    const notes: string[] = [];
    if (reply.reuse === 'focused') notes.push('You already had a tab open on this site, so Eya switched to it instead of opening another (it was left as it was).');
    if (reply.reuse === 'navigated') notes.push('Eya reused the tab she opened earlier for this site.');
    // A browser error page ("this site can't be reached") is not the page that was asked for: say what happened, never carry on as if it opened.
    if (reply.state.url.startsWith('chrome-error:') || reply.state.url.startsWith('edge-error:')) {
      throw new BrowserNavigationError(classifyNavigationError(new Error('ERR_CONNECTION_TIMED_OUT'), url), url);
    }
    // The same, when the extension could not read the page because it is the browser's own error page (it says so): the address was never reached.
    if (reply.state.notes.some((n) => /showing its own error page/i.test(n))) {
      throw new BrowserNavigationError(
        {
          kind: 'other',
          retryable: true,
          message: `${hostLabel(url)} could not be reached: the browser showed its own "can't be reached" page (the address may be wrong, the site down, or there is no connection).`,
          next: 'Check the address; I can try once more.',
        },
        url,
      );
    }
    // What really happened to the address: where it ended up (a redirect, possibly to another site), and what the site answered.
    const redirect = describeRedirect(url, reply.state.url);
    if (redirect !== null) notes.push(redirect);
    const answered = describeHttpStatus(reply.navigation?.status, reply.state.url);
    if (answered !== null) notes.push(answered.message + (answered.next !== undefined ? ` ${answered.next}` : ''));
    if (reply.navigation?.blank === true) notes.push('The page came up blank: nothing is on it yet. It may need longer, or the site may not allow automated visits. Look again before deciding anything.');
    if (!reply.settled) notes.push(reply.stillBusy ? 'A loading indicator was still showing when Eya looked — look again in a moment if something seems missing.' : 'The page had not finished loading when Eya looked — look again if something seems missing.');
    return this.snapshot(reply.state, notes);
  }

  async inspectPage(): Promise<PageSnapshot> {
    return this.snapshot((await this.look()).state);
  }

  async findOnPage(query: string): Promise<FindOnPageResult> {
    const { state } = await this.look();
    const found = findInPage(state, query);
    return { url: state.url, title: state.title, query, matches: found.matches, textMatches: found.textMatches, totalControls: found.totalControls };
  }

  async readPage(offset = 0): Promise<ReadPageResult> {
    const { state } = await this.look();
    const chunk = readChunk(state, offset);
    return {
      url: state.url,
      title: state.title,
      text: chunk.text,
      offset: chunk.offset,
      nextOffset: chunk.nextOffset,
      totalChars: chunk.totalChars,
      ...(chunk.offset === 0 && state.tables.length > 0 ? { tables: state.tables } : {}),
    };
  }

  async clickOnPage(text: string, gate?: ClickGate): Promise<ActOnPageResult> {
    let scrolls = 0;
    for (let attempt = 0; ; attempt++) {
      const { tabId, state } = await this.look();
      const blocked = this.blockedByChallenge(state);
      if (blocked !== null) return blocked;

      // An extension from before 0.10.0 shows only the first of several identical buttons and cannot say which item one belongs to: naming an
      // item to it would quietly click the first, so say so instead.
      if (splitNear(text).near !== '' && this.bridge.capabilities !== undefined && !this.bridge.capabilities().includes('item_context')) {
        return {
          ok: false,
          reason: 'could_not',
          message:
            'The Eya browser extension is out of date, so it cannot tell which item a repeated button (every dish\'s ADD, every product\'s Add to cart) belongs to, and would click the first. ' +
            'Ask the user to reload it once (open chrome://extensions or edge://extensions and press reload on Eya Browser Bridge; it is then version 0.11.6). ' +
            'If this page has only one such button, click it without naming an item.',
          snapshot: this.snapshot(state),
        };
      }
      const choice = chooseClickTarget(state, text);
      if (choice.kind === 'ambiguous') return { ok: false, reason: 'ambiguous', name: choice.name, options: choice.options, snapshot: this.snapshot(state) };
      if (choice.kind === 'none') {
        // Not showing: a menu or a list that fills in as it is scrolled keeps the rest further down, so look further down before giving up.
        // (Not in a chat app: its lists are the app's own and scrolling them is not looking for a button.)
        if (scrolls < MAX_FIND_SCROLLS && !state.restricted && !state.scroll.atBottom && !this.quickFor(state.url)) {
          scrolls += 1;
          const moved = parseReply(await this.call('scroll', { ...(tabId !== null ? { tabId } : {}), direction: 'down' }, 30_000));
          if (moved.performed.ok && moved.performed.moved !== false) {
            attempt = -1; // (a look after scrolling is a fresh start, not a retry of a stale element)
            continue;
          }
        }
        return { ok: false, reason: 'not_found', snapshot: this.snapshot(state) };
      }
      const el: PageElement = choice.element;

      const why = gate?.({ name: el.name, role: el.role }) ?? null;
      if (why !== null) return { ok: false, reason: 'needs_confirmation', why, target: el.name, snapshot: this.snapshot(state) };

      const quick = this.quickFor(state.url) ? { quick: true } : {};
      const reply = parseReply(await this.call('click', { ...(tabId !== null ? { tabId } : {}), id: el.id, name: el.name, ...quick }, 90_000));
      if (reply.performed.ok) return this.okResult(state, reply);
      // The page moved under us between looking and clicking: look again once and re-choose.
      if (reply.performed.reason === 'stale_element' && attempt === 0) {
        log.info('element went stale; re-observing', { text });
        continue;
      }
      return this.failureResult(reply);
    }
  }

  /**
   * Opens one row of a list by its first line, found in the page as it is at this moment (see BrowserItemClicker). The element's CURRENT name goes
   * with the click, so a row that has only changed its preview, time or unread count is still the row that was meant.
   */
  async clickItem(want: { readonly primary?: string; readonly name?: string; readonly region?: string; readonly role?: string }, gate?: ClickGate): Promise<ActOnPageResult> {
    for (let attempt = 0; ; attempt++) {
      const { tabId, state } = await this.look();
      const blocked = this.blockedByChallenge(state);
      if (blocked !== null) return blocked;
      const choice = findListItem(state, want);
      if (choice.kind === 'none') return { ok: false, reason: 'not_found', snapshot: this.snapshot(state) };
      const el = choice.element;
      const why = gate?.({ name: el.name, role: el.role }) ?? null;
      if (why !== null) return { ok: false, reason: 'needs_confirmation', why, target: el.name, snapshot: this.snapshot(state) };
      const quick = this.quickFor(state.url) ? { quick: true } : {};
      const reply = parseReply(await this.call('click', { ...(tabId !== null ? { tabId } : {}), id: el.id, name: el.name, ...quick }, 90_000));
      if (reply.performed.ok) return this.okResult(state, reply);
      // The page moved between looking and clicking: look again (the row is found again by its first line) rather than give up or click by old words.
      if (reply.performed.reason === 'stale_element' && attempt < 2) continue;
      return this.failureResult(reply);
    }
  }

  async fillOnPage(label: string, value: string, options: FillOptions = {}): Promise<ActOnPageResult> {
    for (let attempt = 0; ; attempt++) {
      const { tabId, state } = await this.look();
      const blocked = this.blockedByChallenge(state);
      if (blocked !== null) return blocked;

      const el = findFillTarget(state, label);
      if (el === null) return { ok: false, reason: 'not_found', snapshot: this.snapshot(state) };
      // A one-time code the user said out loud may be typed into a one-time-code field; a password or card number never is.
      const codeOk = options.allowCode === true && el.oneTimeCode === true;
      if (el.sensitive === true && !codeOk) {
        return {
          ok: false,
          reason: 'needs_user',
          message:
            el.oneTimeCode === true
              ? 'That is a verification-code field. Ask the user to say the code out loud (or type it themselves). Eya never types a password or a card number.'
              : 'That is a password or card field. Eya never types those — please enter it yourself.',
          snapshot: this.snapshot(state),
        };
      }

      const quick = this.quickFor(state.url) ? { quick: true } : {};
      const reply = parseReply(
        await this.call('fill', { ...(tabId !== null ? { tabId } : {}), id: el.id, name: el.name, value, submit: options.submit === true, ...(codeOk ? { allowCode: true } : {}), ...quick }, 90_000),
      );
      if (reply.performed.ok) {
        const done = this.okResult(state, reply);
        return codeOk && el.sensitive === true && done.ok ? { ...done, codeEntered: true } : done;
      }
      // An extension from before 0.8.0 refuses every code field, whatever was said: say what to do about that, not "the user has to".
      if (codeOk && reply.performed.reason === 'sensitive_field') {
        return {
          ok: false,
          reason: 'needs_user',
          message: 'The Eya browser extension is out of date, so it cannot type a code yet. Reload it once in chrome://extensions (or edge://extensions) to get version 0.8.0; until then the user has to type the code themselves.',
          snapshot: this.snapshot(reply.state),
        };
      }
      if (reply.performed.reason === 'stale_element' && attempt === 0) continue;
      return this.failureResult(reply);
    }
  }

  /** Presses the page's own Skip / close buttons on adverts, once or keeping watch (the extension 0.7.0 does the pressing). */
  async ads(mode: AdsMode, options: { readonly keepPlaying?: boolean; readonly play?: boolean } = {}): Promise<AdsState> {
    let reply: { readonly state?: AdsState };
    try {
      reply = await this.call<{ readonly state?: AdsState }>('ads', { mode, ...(options.keepPlaying === true ? { keepPlaying: true } : {}), ...(options.play === true ? { play: true } : {}) }, 20_000);
    } catch (err) {
      if (err instanceof BridgeError && /unknown request/i.test(err.message)) {
        throw new Error('The Eya browser extension is out of date, so it cannot skip adverts yet. Reload it once in chrome://extensions (or edge://extensions) to get version 0.7.0.');
      }
      throw err;
    }
    if (reply.state === undefined || reply.state === null) throw new Error('This page did not answer (it may be a browser page the extension is not allowed to read).');
    return reply.state;
  }

  /** What can be clicked on the page right now, for Eya's own code to choose from (a chat list, say). Not shown to the model. */
  async listItems(): Promise<PageItem[]> {
    const { state } = await this.look();
    return state.elements
      .filter((e) => e.hidden !== true && e.name !== '' && READABLE_ROLES.has(e.role))
      .map((e) => ({
        name: e.name,
        ...(e.primary !== undefined ? { primary: e.primary } : {}),
        role: e.role,
        ...(e.region !== undefined ? { region: e.region } : {}),
        ...(e.role === 'checkbox' && e.checked !== undefined ? { checked: e.checked } : {}),
      }));
  }

  /**
   * Presses Escape (and only Escape): it closes the open chat or popup. An extension from before this existed says so, and the caller carries on another way.
   */
  async pressEscape(): Promise<{ readonly ok: true; readonly snapshot: PageSnapshot } | { readonly ok: false; readonly message: string }> {
    try {
      const { tabId } = await this.look();
      const reply = parseReply(await this.call('press_key', { ...(tabId !== null ? { tabId } : {}), key: 'Escape' }, 30_000));
      if (!reply.performed.ok) return { ok: false, message: reply.performed.detail ?? 'The page would not take the key.' };
      return { ok: true, snapshot: this.snapshot(reply.state) };
    } catch (err) {
      if (err instanceof BridgeError && err.code === 'extension_error' && /unknown request/i.test(err.message)) {
        return { ok: false, message: 'The Eya extension in this browser is from before it could press a key: it needs reloading once on the extensions page.' };
      }
      throw err;
    }
  }

  /**
   * Live chat: starts, stops or asks about the watcher in the open chat (the extension's `chat_watch`). The watcher's events carry no content; the chat is read
   * with chatRead. An extension from before this existed says so, and the caller reports it instead of pretending to watch.
   */
  async chatWatch(mode: 'start' | 'stop' | 'status', tabId?: number): Promise<ChatWatchResult> {
    // (an extension that says what it can do, and cannot read a page by its bubbles: it would call a readable page unreadable — an extension that says nothing is taken as it is)
    if (mode === 'start' && this.bridge.capabilities !== undefined && !this.bridge.capabilities().includes('chat_read_sides')) return NEEDS_NEWER_READER;
    if (mode === 'start' && this.bridge.capabilities !== undefined && !this.bridge.capabilities().includes('chat_documents')) return NEEDS_DOCUMENT_READER;
    try {
      const raw = asRecord(await this.call('chat_watch', { mode, ...(tabId !== undefined ? { tabId } : {}) }, 30_000));
      return {
        ok: true,
        watching: raw['watching'] === true,
        tabId: typeof raw['tabId'] === 'number' ? raw['tabId'] : null,
        ...(this.browserName !== undefined ? { browser: this.browserName } : {}),
        ...(typeof raw['hasMain'] === 'boolean' ? { hasMain: raw['hasMain'] } : {}),
        ...(typeof raw['rows'] === 'number' ? { rows: raw['rows'] } : {}),
        ...(typeof raw['title'] === 'string' ? { title: raw['title'].slice(0, 120) } : {}),
      };
    } catch (err) {
      if (err instanceof BridgeError && err.code === 'extension_error' && /unknown request/i.test(err.message)) return OLD_FOR_CHAT;
      throw err;
    }
  }

  /** Live chat: the last messages of the chat that is OPEN (only that chat), as the page shows them. */
  async chatRead(max = 30, tabId?: number): Promise<ChatReadResult> {
    if (this.bridge.capabilities !== undefined && !this.bridge.capabilities().includes('chat_read_sides')) return NEEDS_NEWER_READER;
    if (this.bridge.capabilities !== undefined && !this.bridge.capabilities().includes('chat_documents')) return NEEDS_DOCUMENT_READER;
    try {
      const raw = asRecord(await this.call('chat_read', { max, ...(tabId !== undefined ? { tabId } : {}) }, 30_000));
      const kinds = new Set(['text', 'deleted', 'sticker', 'audio', 'video', 'image', 'document', 'other']);
      const messages: LiveChatMessage[] = [];
      for (const item of Array.isArray(raw['messages']) ? raw['messages'].slice(-60) : []) {
        const m = asRecord(item);
        if (typeof m['id'] !== 'string' || m['id'] === '' || (m['dir'] !== 'in' && m['dir'] !== 'out')) continue;
        const kind = typeof m['kind'] === 'string' && kinds.has(m['kind']) ? (m['kind'] as LiveChatMessage['kind']) : 'other';
        messages.push({ id: m['id'].slice(0, 200), dir: m['dir'], kind, text: typeof m['text'] === 'string' ? m['text'].slice(0, 1200) : '', at: typeof m['at'] === 'string' ? m['at'].slice(0, 40) : '' });
      }
      return {
        ok: true,
        tabId: typeof raw['tabId'] === 'number' ? raw['tabId'] : null,
        ...(this.browserName !== undefined ? { browser: this.browserName } : {}),
        hasMain: raw['hasMain'] === true,
        title: typeof raw['title'] === 'string' ? raw['title'].slice(0, 120) : '',
        messages,
        reliable: raw['reliable'] !== false,
        ...readDiagnostics(raw['diagnostics']),
      };
    } catch (err) {
      if (err instanceof BridgeError && err.code === 'extension_error' && /unknown request/i.test(err.message)) return OLD_FOR_CHAT;
      throw err;
    }
  }

  /**
   * Live chat: takes a picture or a document out of the open chat — only one the OTHER person sent (the extension refuses any other). `look` reads what the message offers
   * and presses nothing; `download` presses a document's own download control and waits for the browser's download. What comes back is checked here: a picture's bytes are
   * decoded and capped, a document's name is a plain name, a download is the browser's own report. Nothing here writes a file: where a file goes is media.ts's decision.
   */
  async chatMedia(messageId: string, step: 'look' | 'download', tabId?: number): Promise<ChatMediaResult> {
    if (this.bridge.capabilities !== undefined && !this.bridge.capabilities().includes('chat_media')) return MEDIA_NEEDS_NEWER;
    const refuse = (reason: 'not_found' | 'not_incoming' | 'not_media' | 'not_loaded' | 'too_big' | 'no_control' | 'failed', message: string): ChatMediaResult => ({ ok: false, reason, message });
    const said = (why: unknown): ChatMediaResult => {
      switch (why) {
        case 'no_chat':
        case 'not_found':
          return refuse('not_found', 'That message is not on the page any more.');
        case 'not_incoming':
          return refuse('not_incoming', 'That message was not sent by the other person.');
        case 'not_media':
          return refuse('not_media', 'That message is not a picture or a document.');
        case 'not_loaded':
          return refuse('not_loaded', 'The picture has not finished loading on the page.');
        case 'too_big':
          return refuse('too_big', 'The picture is too big for me to take.');
        case 'no_control':
          return refuse('no_control', 'I could not find the download button on that document.');
        default:
          return refuse('failed', 'The page would not give me that file.');
      }
    };
    try {
      if (step === 'download') {
        const reply = parseReply(await this.call('chat_media', { id: messageId, phase: 'click', ...(tabId !== undefined ? { tabId } : {}) }, 60_000));
        if (!reply.performed.ok) return said(reply.performed.reason);
        return { ok: true, via: 'download', download: reply.download };
      }
      const raw = asRecord(await this.call('chat_media', { id: messageId, phase: 'look', maxBytes: MAX_PICTURE_BYTES, ...(tabId !== undefined ? { tabId } : {}) }, 30_000));
      if (raw['ok'] === false) return said(raw['reason']);
      if (raw['via'] === 'bytes' && typeof raw['data'] === 'string') {
        const data = Buffer.from(raw['data'], 'base64');
        if (data.length === 0) return said('not_loaded');
        if (data.length > MAX_PICTURE_BYTES) return said('too_big');
        return { ok: true, via: 'bytes', mime: typeof raw['mime'] === 'string' ? raw['mime'].slice(0, 60) : 'image/jpeg', data: new Uint8Array(data) };
      }
      if (raw['via'] === 'document') {
        // (a file name as a plain name: no folders, no control characters, not long)
        // eslint-disable-next-line no-control-regex
        const name = typeof raw['name'] === 'string' ? basename(raw['name'].replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').slice(0, 160) : '';
        // (the page's own icon names — "document-pdf", "download" — so that a bubble with no download control can be told, afterwards, what it did show; never a word of the chat)
        const icons = Array.isArray(raw['icons']) ? raw['icons'].filter((i): i is string => typeof i === 'string' && /^[A-Za-z0-9_-]{1,30}$/.test(i)).slice(0, 8) : [];
        return { ok: true, via: 'document', name, hasControl: raw['hasControl'] === true, icons };
      }
      return said('failed');
    } catch (err) {
      if (err instanceof BridgeError && err.code === 'extension_error' && /unknown request/i.test(err.message)) return MEDIA_NEEDS_NEWER;
      throw err;
    }
  }

  /**
   * Hands a file to the open page's own file picker, in parts. The page then shows its own preview and waits — nothing is
   * sent by this. Reasons it cannot: no picker is on the page yet (the app's attach menu has to be opened first), the
   * picker does not take this kind of file, or the extension is from before this existed.
   */
  async attachFile(request: AttachFileRequest): Promise<AttachFileResult> {
    const id = randomUUID().replace(/-/g, '').slice(0, 16);
    let tabId: number | null = null;
    const step = async (args: Record<string, unknown>): Promise<ActionReply> =>
      parseReply(await this.call('attach_file', { ...args, id, ...(tabId !== null ? { tabId } : {}) }, 90_000));
    try {
      // Is there a file picker at all? Asked first, so a big file is not sent across just to be turned away.
      const probe = await step({ phase: 'probe' });
      if (!probe.performed.ok) {
        return { ok: false, reason: probe.performed.reason === 'no_file_input' ? 'no_file_input' : 'failed', message: probe.performed.detail ?? 'The page has no file picker.' };
      }
      tabId = probe.tabId;
      const begin = await step({ phase: 'begin', name: request.name, mime: request.mime, size: request.size });
      if (!begin.performed.ok) return { ok: false, reason: 'failed', message: begin.performed.detail ?? 'The page would not start taking the file.' };
      tabId = begin.tabId;
      for (let offset = 0; offset < request.size; offset += ATTACH_CHUNK_BYTES) {
        const bytes = await request.read(offset, Math.min(ATTACH_CHUNK_BYTES, request.size - offset));
        const part = await step({ phase: 'chunk', data: bytes.toString('base64') });
        if (!part.performed.ok) return { ok: false, reason: 'failed', message: part.performed.detail ?? 'The page stopped taking the file part-way.' };
      }
      // Handing a file to a chat app's picker is a chat page's own business: a short settle, no waiting to see whether a download started.
      const done = await step({ phase: 'commit', prefer: request.prefer ?? 'auto', quick: true });
      const snapshot = this.snapshot(done.state);
      if (done.performed.ok) return { ok: true, snapshot };
      const reason = done.performed.reason === 'no_file_input' || done.performed.reason === 'type_not_accepted' ? done.performed.reason : 'failed';
      return { ok: false, reason, message: done.performed.detail ?? 'The page would not take the file.', snapshot };
    } catch (err) {
      if (err instanceof BridgeError && err.code === 'extension_error' && /unknown request/i.test(err.message)) {
        return {
          ok: false,
          reason: 'failed',
          message:
            'The Eya extension in this browser is from before it could attach files. Ask the user to reload it once: open the browser\'s extensions page and click the circular reload arrow on "Eya Browser Bridge".',
        };
      }
      throw err;
    }
  }

  async goBack(): Promise<ActOnPageResult> {
    return this.navigateHistory('back');
  }

  async goForward(): Promise<ActOnPageResult> {
    return this.navigateHistory('forward');
  }

  async reload(): Promise<ActOnPageResult> {
    return this.navigateHistory('reload');
  }

  private async navigateHistory(op: 'back' | 'forward' | 'reload'): Promise<ActOnPageResult> {
    const { state: before } = await this.look();
    const reply = parseReply(await this.call(op, {}, 60_000));
    if (!reply.performed.ok) return this.failureResult(reply);
    return this.okResult(before, reply);
  }

  async scroll(direction: ScrollDirection, amount?: number): Promise<ActOnPageResult> {
    const { tabId, state: before } = await this.look();
    const reply = parseReply(await this.call('scroll', { ...(tabId !== null ? { tabId } : {}), direction, ...(amount !== undefined ? { amount } : {}) }, 30_000));
    if (!reply.performed.ok) return this.failureResult(reply);
    const result = this.okResult(before, reply);
    if (result.ok && reply.performed.moved === false) {
      // Said plainly, because "nothing happened" on a scroll means the page has no more in that direction.
      return { ...result, snapshot: withExtras(result.snapshot, { notes: ['The page did not move — it is already at the very ' + (direction === 'up' || direction === 'top' ? 'top.' : 'bottom.')] }) };
    }
    return result;
  }

  async searchWeb(query: string): Promise<WebSearchHit[]> {
    let lastError: unknown;
    for (const engine of searchEngineUrls()) {
      try {
        const raw = asRecord(await this.call('search_page', { url: engine.url(query), engine: engine.name }, 45_000));
        const hits = cleanSearchHits(Array.isArray(raw['hits']) ? (raw['hits'] as RawSearchHit[]) : []);
        log.info('browser web search (your browser)', { engine: engine.name, hits: hits.length });
        if (hits.length > 0) return hits;
      } catch (err) {
        lastError = err;
        log.warn('browser web search failed (your browser)', { engine: engine.name, err: String(err) });
      }
    }
    if (lastError !== undefined) throw lastError instanceof Error ? lastError : new Error(String(lastError));
    return [];
  }

  /**
   * A picture of the page showing in the browser right now (the tab in front, or the one Eya is on in her own window).
   * Only what is visible — the browser gives an extension no way to capture the whole scroll length without a permission
   * this one declines. The image is validated, never interpreted, and never leaves this machine.
   */
  async screenshot(): Promise<ScreenshotImage> {
    let raw: Record<string, unknown>;
    try {
      raw = asRecord(await this.call('screenshot', {}, 30_000));
    } catch (err) {
      // An extension from before screenshots existed does not know the request.
      if (err instanceof BridgeError && err.code === 'extension_error' && /unknown request/i.test(err.message)) {
        throw new Error(
          "The Eya extension in this browser is from before screenshots existed. Ask the user to reload it once: open the browser's extensions page and click the circular reload arrow on \"Eya Browser Bridge\".",
        );
      }
      throw err;
    }
    const image = decodeImageDataUrl(raw['dataUrl']);
    if (image === null) throw new Error('The browser did not return a usable picture of the page.');
    return {
      ...image,
      url: typeof raw['url'] === 'string' ? redactUrl(raw['url']) : '',
      title: typeof raw['title'] === 'string' ? raw['title'].slice(0, 200) : '',
      environment: this.environment,
      ...(this.browserName !== undefined ? { browser: this.browserName } : {}),
    };
  }

  async listTabs(): Promise<BrowserTabInfo[]> {
    const raw = asRecord(await this.call('list_tabs', {}));
    const tabs = Array.isArray(raw['tabs']) ? raw['tabs'] : [];
    return tabs.flatMap((t): BrowserTabInfo[] => {
      const r = asRecord(t);
      if (typeof r['tabId'] !== 'number') return [];
      return [
        {
          ...(this.browserName !== undefined ? { browser: this.browserName } : {}),
          ...(typeof r['windowId'] === 'number' ? { windowId: r['windowId'] } : {}),
          ...(r['pinned'] === true ? { pinned: true } : {}),
          ...(r['loading'] === true ? { loading: true } : {}),
          tabId: r['tabId'],
          title: typeof r['title'] === 'string' ? r['title'] : '',
          url: typeof r['url'] === 'string' ? r['url'] : '',
          active: r['active'] === true,
          openedByEya: r['openedByEya'] === true,
          workingHere: r['workingHere'] === true,
        },
      ];
    });
  }

  async switchToTab(tabId: number): Promise<PageSnapshot> {
    const reply = parseReply(await this.call('focus_tab', { tabId }));
    return this.snapshot(reply.state);
  }

  async closeTab(tabId: number, options: { readonly allowUserTab?: boolean } = {}): Promise<{ readonly closed: boolean; readonly remainingTabs: number }> {
    const r = asRecord(await this.call('close_tab', { tabId, allowUserTab: options.allowUserTab === true }));
    return { closed: r['closed'] === true, remainingTabs: (await this.listTabs()).length };
  }

  /** Eya does not own the user's browser, so there is nothing for her to close. */
  async close(): Promise<void> {
    // intentionally empty
  }
}
