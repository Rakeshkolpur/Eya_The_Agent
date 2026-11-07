import { rootLogger } from '@main/logging/logger';
// The very same page script the Eya Browser Bridge extension injects. Bundled as text so there is one implementation of "look at a page / click /
// type" for the user's own browser and for Eya Browser, not two that drift apart.
import pageAgentSource from '../../../eya-chrome-extension/injected.js?raw';
import { BrowserNavigationError } from './errors';
import { classifyNavigationError, describeHttpStatus } from './navigationErrors';
import { redactUrl } from './redactUrl';

const log = rootLogger.child('browser.embedded');

const NAV_TIMEOUT_MS = 20_000;
const AGENT_FUNCTION = pageAgentSource.replace(/^\s*export\s+async\s+function/m, 'async function');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A button that says it saves a file gets time for the save to start; any other step only gets a glance (a download starts at once). */
const DOWNLOADISH = /download|save|export|pdf|invoice|receipt|bill|statement|certificate|csv|excel|print|get (?:the )?file|डाउनलोड/i;
const DIALOG_NOTE_MS = 12_000;
const GLANCE_MS = 500;
const PATIENT_MS = 2600;

/** What happens in a tab, as the embedded browser reports it. */
export type TabEvent =
  | { readonly type: 'navigated' }
  | { readonly type: 'loading'; readonly loading: boolean }
  | { readonly type: 'title' }
  /** The main page could not be loaded (the browser's own words, e.g. "ERR_NAME_NOT_RESOLVED"). */
  | { readonly type: 'failed'; readonly description: string; readonly url: string }
  | { readonly type: 'crashed' }
  | { readonly type: 'closed' }
  /** What the site answered for the main page (200, 403, 503…). */
  | { readonly type: 'status'; readonly code: number }
  /** A native alert/confirm/prompt that was dismissed. */
  | { readonly type: 'dialog'; readonly message: string }
  /** The page asked for a new window (target=_blank, window.open): it is a new tab of this browser. */
  | { readonly type: 'opened'; readonly tab: EmbeddedTab }
  | { readonly type: 'download'; readonly done: Promise<RawDownload> };

export interface RawDownload {
  downloadId: number;
  filename: string;
  state: 'complete' | 'interrupted' | 'in_progress';
  bytes: number;
  mime?: string;
  error?: string;
}

/** One tab of Eya Browser: the part of a real browser page the host needs. The Electron one wraps a WebContentsView; tests use a fake. */
export interface EmbeddedTab {
  url(): string;
  title(): string;
  /** Loads an address. Resolves once the page's document is ready (not every picture), rejects with the browser's own error text. */
  load(url: string, timeoutMs: number): Promise<void>;
  /** Runs a script in the page and returns its result. */
  run(code: string): Promise<unknown>;
  stop(): void;
  reload(): void;
  /** Goes back/forward one page; false when there is nowhere to go. */
  back(): boolean;
  forward(): boolean;
  screenshot(): Promise<Buffer>;
  focus(): void;
  close(): void;
  isClosed(): boolean;
  onEvent(listener: (e: TabEvent) => void): void;
}

/** Where the tabs live: the Eya window (the Browser page's view) or nowhere (a throwaway browser for look-ups). */
export interface EmbeddedEnvironment {
  /** A new tab (shown in the Browser page when it is the current one). */
  createTab(): EmbeddedTab;
  /** A tab that is never shown, for reading a results page. */
  createHiddenTab(): EmbeddedTab;
  /** Makes this tab the one the Browser page shows (null: none). */
  show(tab: EmbeddedTab | null): void;
  /** Where on the Eya window the browser is drawn (null: the Browser page is not open, so it is out of sight). */
  setBounds(bounds: ViewBounds | null): void;
  /** The Eya window should come to the front on the Browser page. */
  reveal(): void;
}

export interface ViewBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface EmbeddedHostOptions {
  readonly env: EmbeddedEnvironment;
  /** How long opening a page may take before it counts as timed out (tests make it short). */
  readonly navTimeoutMs?: number;
  /** How long a page that is still blank gets to build itself before it is reported blank (tests make it short). */
  readonly blankWaitMs?: number;
}

/** What happens in the browser, for the Browser page. */
export type HostEvent =
  | { readonly type: 'page'; readonly url: string; readonly title: string; readonly loading: boolean }
  | { readonly type: 'problem'; readonly kind: string; readonly message: string }
  | { readonly type: 'tabs' }
  | { readonly type: 'closed' };

interface DownloadRecord {
  readonly at: number;
  readonly done: Promise<RawDownload>;
}

type Args = Readonly<Record<string, unknown>>;

/**
 * Eya Browser: Eya's own browser, drawn inside the Eya window by the Chromium that is already part of Eya (nothing else to install). It speaks
 * the same request language as the Eya Browser Bridge extension (open_url, observe, click, fill, back, list_tabs, focus_tab…), so ONE service
 * on top works the same in Eya Browser and in the user's own browser, and it is handed exactly the same page script. Tabs live in a profile of
 * their own that keeps its sign-ins between tasks.
 */
export class EmbeddedPageHost {
  private tabs = new Map<number, EmbeddedTab>();
  private readonly ids = new WeakMap<EmbeddedTab, number>();
  private current: EmbeddedTab | null = null;
  private nextId = 1;
  private readonly navigatedAt = new WeakMap<EmbeddedTab, number>();
  private readonly statusOf = new WeakMap<EmbeddedTab, number>();
  private readonly loadingOf = new WeakMap<EmbeddedTab, boolean>();
  private readonly failureOf = new WeakMap<EmbeddedTab, { readonly description: string; readonly at: number }>();
  // Requests being handled right now: a page that opens a window while none is (the user clicked) is followed at once.
  private inflight = 0;
  private readonly opened: Array<{ tab: EmbeddedTab; at: number }> = [];
  private readonly downloads: DownloadRecord[] = [];
  private readonly listeners = new Set<(e: HostEvent) => void>();
  // A native alert()/confirm()/prompt() is dismissed (never accepted: a confirm's OK could do something irreversible) and reported in the looks
  // that follow (a few seconds), since the step that caused it often looks at the page more than once.
  private lastNativeDialog: { readonly text: string; readonly at: number } | null = null;
  private lastUrl: string | null = null;

  constructor(private readonly options: EmbeddedHostOptions) {}

  isConnected(): boolean {
    return true; // it is part of Eya
  }

  // ------------------------------------------------------------------ events
  onEvent(listener: (e: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HostEvent): void {
    for (const l of this.listeners) l(event);
  }

  private emitPage(tab: EmbeddedTab, loading: boolean): void {
    if (tab !== this.current) return;
    this.emit({ type: 'page', url: redactUrl(tab.url()), title: tab.title().slice(0, 160), loading });
  }

  /** Where the browser is drawn on the Eya window (null when the Browser page is not open). */
  setViewBounds(bounds: ViewBounds | null): void {
    this.options.env.setBounds(bounds);
  }

  /** The current tab changed (or none): the Browser page shows that one. */
  private setCurrent(tab: EmbeddedTab | null): void {
    this.current = tab;
    this.options.env.show(tab);
    this.emit({ type: 'tabs' });
    if (tab !== null) this.emitPage(tab, false);
  }

  // ------------------------------------------------------------------- tabs
  private adopt(tab: EmbeddedTab, isNew: boolean): number {
    const existing = this.ids.get(tab);
    if (existing !== undefined) return existing;
    const id = this.nextId++;
    this.ids.set(tab, id);
    this.tabs.set(id, tab);
    if (isNew) this.opened.push({ tab, at: Date.now() });
    tab.onEvent((e) => {
      switch (e.type) {
        case 'navigated':
          this.navigatedAt.set(tab, Date.now());
          this.loadingOf.set(tab, true);
          this.emitPage(tab, true);
          break;
        case 'loading':
          this.loadingOf.set(tab, e.loading);
          this.emitPage(tab, e.loading);
          break;
        case 'title':
          this.emitPage(tab, this.loadingOf.get(tab) === true);
          break;
        case 'status':
          this.statusOf.set(tab, e.code);
          break;
        case 'dialog':
          this.lastNativeDialog = { text: e.message, at: Date.now() };
          log.info('native browser dialog auto-dismissed', { message: e.message });
          break;
        case 'failed':
          this.failureOf.set(tab, { description: e.description, at: Date.now() });
          if (tab === this.current) {
            const problem = classifyNavigationError(new Error(e.description), e.url);
            if (problem.kind !== 'aborted') this.emit({ type: 'problem', kind: problem.kind, message: problem.message });
          }
          break;
        case 'crashed':
          log.warn('a page crashed');
          if (tab === this.current) this.emit({ type: 'problem', kind: 'crashed', message: 'The page crashed. Eya will open it again the next time it needs it.' });
          break;
        case 'download':
          this.downloads.push({ at: Date.now(), done: e.done });
          break;
        case 'opened':
          // A page's own new window is a new tab of this browser; Eya follows it after the action that opened it (see afterAction).
          this.adopt(e.tab, true);
          if (this.inflight === 0) this.setCurrent(e.tab);
          else this.emit({ type: 'tabs' });
          break;
        case 'closed':
          this.tabs.delete(id);
          if (this.current === tab) this.setCurrent([...this.tabs.values()].filter((t) => !t.isClosed()).at(-1) ?? null);
          else this.emit({ type: 'tabs' });
          break;
      }
    });
    return id;
  }

  private async ensurePage(): Promise<EmbeddedTab> {
    if (this.current !== null && !this.current.isClosed()) return this.current;
    const existing = [...this.tabs.values()].find((t) => !t.isClosed());
    if (existing !== undefined) {
      this.setCurrent(existing);
      return existing;
    }
    const tab = this.options.env.createTab();
    this.adopt(tab, false);
    this.setCurrent(tab);
    return tab;
  }

  private pageFor(tabId: unknown): EmbeddedTab {
    if (typeof tabId === 'number') {
      const t = this.tabs.get(tabId);
      if (t !== undefined && !t.isClosed()) return t;
    }
    if (this.current === null || this.current.isClosed()) throw new Error('There is no browser tab to look at. Open a website first.');
    return this.current;
  }

  async close(): Promise<void> {
    const open = [...this.tabs.values()];
    this.tabs = new Map();
    this.current = null;
    for (const t of open) t.close();
    this.options.env.show(null);
  }

  // -------------------------------------------------------------------- page
  /** Runs one command of the shared page script inside a page. */
  private async agent(tab: EmbeddedTab, command: string, params: Args = {}): Promise<unknown> {
    return tab.run(`(${AGENT_FUNCTION})(${JSON.stringify(command)}, ${JSON.stringify(params)})`);
  }

  private navigatedSince(tab: EmbeddedTab, since: number): boolean {
    return (this.navigatedAt.get(tab) ?? 0) >= since;
  }

  private async observe(tab: EmbeddedTab): Promise<Record<string, unknown>> {
    let state: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 3 && state === null; attempt++) {
      try {
        state = (await this.agent(tab, 'observe')) as Record<string, unknown>;
      } catch (err) {
        // The page was replaced under us (a navigation finished): wait a moment for the new one and look again.
        if (attempt === 2) throw err;
        await sleep(300);
      }
    }
    const result: Record<string, unknown> = { ...(state ?? {}) };
    const note = this.lastNativeDialog;
    if (note !== null && Date.now() - note.at < DIALOG_NOTE_MS) {
      const dialogs = Array.isArray(result['dialogs']) ? (result['dialogs'] as unknown[]) : [];
      result['dialogs'] = [`(a browser popup appeared and was dismissed: "${note.text}")`, ...dialogs];
    }
    return result;
  }

  /** Wait until the page has finished loading AND stopped changing (the page script's own notion of quiet). */
  private async settle(tab: EmbeddedTab, since: number): Promise<{ settled: boolean; busy?: boolean }> {
    await sleep(180); // a click that navigates starts a moment later
    if (this.navigatedSince(tab, since)) await this.untilLoaded(tab, 15_000);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = (await this.agent(tab, 'waitQuiet')) as { settled?: boolean; busy?: boolean };
        return { settled: r?.settled !== false, ...(r?.busy ? { busy: true } : {}) };
      } catch {
        await this.untilLoaded(tab, 12_000);
      }
    }
    return { settled: false };
  }

  /** Waits (up to `ms`) for a page that is loading to be ready to look at. */
  private async untilLoaded(tab: EmbeddedTab, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    for (;;) {
      try {
        const state = await tab.run('document.readyState');
        if (state === 'interactive' || state === 'complete') return;
      } catch {
        // the page is being replaced: try again
      }
      if (Date.now() >= deadline) return;
      await sleep(120);
    }
  }

  private async awaitDownload(since: number, waitMs: number): Promise<RawDownload | null> {
    const start = Date.now();
    let found = this.downloads.find((d) => d.at >= since);
    while (found === undefined && Date.now() - start < waitMs) {
      await sleep(100);
      found = this.downloads.find((d) => d.at >= since);
    }
    if (found === undefined) return null;
    return Promise.race([found.done, sleep(25_000).then((): RawDownload => ({ downloadId: 0, filename: '', state: 'in_progress', bytes: -1 }))]);
  }

  /** Everything every action replies with: how it went, and the page as it is now. */
  private async reply(tab: EmbeddedTab, performed: unknown, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return { performed, tabId: this.ids.get(tab) ?? null, state: await this.observe(tab), settled: true, ...extra };
  }

  /** After an action: wait for the page to settle, follow a tab it opened, wait for a download it started, look again. */
  private async afterAction(tab: EmbeddedTab, performed: unknown, startedAt: number, downloadWaitMs = 0): Promise<Record<string, unknown>> {
    const settle = await this.settle(tab, startedAt);
    let active = tab;
    let newTab: { tabId: number; from: number } | null = null;
    for (const entry of [...this.opened].reverse()) {
      if (entry.at < startedAt || entry.tab === tab || entry.tab.isClosed()) continue;
      await this.untilLoaded(entry.tab, 12_000);
      await this.settle(entry.tab, startedAt);
      this.setCurrent(entry.tab);
      active = entry.tab;
      newTab = { tabId: this.ids.get(entry.tab) ?? 0, from: this.ids.get(tab) ?? 0 };
      break;
    }
    const download = await this.awaitDownload(startedAt, downloadWaitMs);
    return this.reply(active, performed, {
      settled: settle.settled,
      ...(settle.busy ? { stillBusy: true } : {}),
      ...(newTab !== null ? { newTab } : {}),
      ...(download !== null ? { download } : {}),
    });
  }

  private async act(tab: EmbeddedTab, perform: () => Promise<unknown>, downloadWaitMs = 0): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    let performed: unknown;
    try {
      performed = await perform();
    } catch (err) {
      // A click that starts a navigation can tear the page down before its result comes back.
      await sleep(120);
      if (!this.navigatedSince(tab, startedAt)) throw err;
      performed = { ok: true, navigated: true };
    }
    if ((performed as { ok?: boolean } | undefined)?.ok === false) return this.reply(tab, performed);
    return this.afterAction(tab, performed, startedAt, downloadWaitMs);
  }

  /**
   * Opens an address in the browser and says what really happened. A hiccup (a timeout, a server error, a page that was replaced, a crash) gets
   * one more try; anything that will fail the same way again (a name that does not exist, a refused connection, a redirect loop) does not.
   * The error that comes out says what went wrong in words, never the browser's code.
   */
  private async navigate(url: string): Promise<{ tab: EmbeddedTab; status: number | null }> {
    let tab = await this.ensurePage();
    const startedAt = Date.now();
    const timeout = this.options.navTimeoutMs ?? NAV_TIMEOUT_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        this.statusOf.delete(tab);
        const attemptAt = Date.now();
        await tab.load(url, timeout);
        // (the browser may report the page ready and the failure in either order: the failure wins)
        const failure = this.failureOf.get(tab);
        if (failure !== undefined && failure.at >= attemptAt) throw new Error(failure.description);
        const status = this.statusOf.get(tab) ?? null;
        const problem = describeHttpStatus(status, url);
        if (problem !== null && problem.retryable && attempt === 0) {
          log.info('site answered with an error; trying once more', { status });
          await sleep(1500);
          continue;
        }
        return { tab, status };
      } catch (err) {
        const problem = classifyNavigationError(err, url);
        log.info('a page did not open cleanly', { kind: problem.kind, why: (err instanceof Error ? err.message : String(err)).slice(0, 140) });
        // Another navigation replaced this one (a redirect the site made itself), or the address was a file that downloads instead of a page:
        // it only failed if nothing ended up open and nothing is being saved.
        if (problem.kind === 'aborted' && !tab.isClosed()) {
          await sleep(300);
          const now = tab.url();
          // (the browser's own error page is not a page that was opened)
          if ((now !== '' && now !== 'about:blank' && !now.startsWith('chrome-error:')) || this.downloads.some((d) => d.at >= startedAt)) return { tab, status: this.statusOf.get(tab) ?? null };
        }
        if (attempt === 0 && problem.retryable) {
          log.info('navigation failed; trying once more', { kind: problem.kind });
          if (problem.kind === 'crashed' || tab.isClosed()) {
            this.setCurrent(null);
            tab = await this.ensurePage();
          } else {
            tab.stop();
            await sleep(1500);
          }
          continue;
        }
        tab.stop();
        this.emit({ type: 'problem', kind: problem.kind, message: problem.message });
        throw new BrowserNavigationError(problem, url);
      }
    }
  }

  /** A page that is blank a moment after it opened may only be building itself: give it a little longer. True if it stayed blank. */
  private async waitForContent(tab: EmbeddedTab): Promise<boolean> {
    const probe = async (): Promise<number> => {
      try {
        return Number(
          await tab.run(
            "(document.body ? document.body.innerText.trim().length : 0) + document.querySelectorAll('a, button, input, select, textarea, [role=\"button\"]').length * 20",
          ),
        );
      } catch {
        return 1000;
      }
    };
    const deadline = Date.now() + (this.options.blankWaitMs ?? 6000);
    while (Date.now() < deadline) {
      if ((await probe()) >= 20) return false;
      await sleep(600);
    }
    return (await probe()) < 20;
  }

  // ------------------------------------------------------------------ requests
  async request<T = unknown>(op: string, args: Args = {}, _timeoutMs?: number): Promise<T> {
    void _timeoutMs;
    this.inflight++;
    try {
      return (await this.dispatch(op, args)) as T;
    } finally {
      this.inflight--;
    }
  }

  private async dispatch(op: string, args: Args): Promise<unknown> {
    switch (op) {
      case 'ping':
        return { browser: 'other', version: 'eya-browser' };

      case 'open_url': {
        const url = String(args['url'] ?? '');
        const startedAt = Date.now();
        const { tab, status } = await this.navigate(url);
        const settle = await this.settle(tab, startedAt);
        const download = this.downloads.some((d) => d.at >= startedAt) ? await this.awaitDownload(startedAt, PATIENT_MS) : null;
        const blank = download !== null ? false : await this.waitForContent(tab);
        this.lastUrl = url;
        return this.reply(tab, { ok: true, opened: true }, {
          ...(download !== null ? { download } : {}),
          settled: settle.settled,
          ...(settle.busy ? { stillBusy: true } : {}),
          reuse: null,
          navigation: { requested: redactUrl(url), final: redactUrl(tab.url()), status, blank },
        });
      }

      case 'observe': {
        const tab = this.pageFor(args['tabId']);
        return { tabId: this.ids.get(tab) ?? null, state: await this.observe(tab) };
      }

      case 'click': {
        const tab = this.pageFor(args['tabId']);
        return this.act(tab, () => this.agent(tab, 'click', { id: args['id'], expectName: args['name'] }), DOWNLOADISH.test(String(args['name'] ?? '')) ? PATIENT_MS : GLANCE_MS);
      }

      case 'fill': {
        const tab = this.pageFor(args['tabId']);
        return this.act(tab, async () => {
          const filled = (await this.agent(tab, 'fill', { id: args['id'], expectName: args['name'], value: args['value'], allowCode: args['allowCode'] === true })) as { ok?: boolean };
          if (filled?.ok && args['submit'] === true) {
            const pressed = (await this.agent(tab, 'press', { id: args['id'], expectName: args['name'] })) as { ok?: boolean };
            return { ...filled, submitted: pressed?.ok === true };
          }
          return filled;
        }, args['submit'] === true ? GLANCE_MS : 0);
      }

      case 'back':
      case 'forward': {
        const tab = this.pageFor(args['tabId']);
        const startedAt = Date.now();
        const moved = op === 'back' ? tab.back() : tab.forward();
        if (!moved) return this.reply(tab, { ok: false, reason: 'no_history', detail: `There is nothing to go ${op === 'back' ? 'back' : 'forward'} to in this tab.` });
        await sleep(150);
        return this.afterAction(tab, { ok: true }, startedAt);
      }

      case 'reload': {
        const tab = this.pageFor(args['tabId']);
        const startedAt = Date.now();
        tab.reload();
        await sleep(150);
        return this.afterAction(tab, { ok: true }, startedAt);
      }

      case 'scroll': {
        const tab = this.pageFor(args['tabId']);
        return this.act(tab, () => this.agent(tab, 'scroll', { direction: args['direction'], amount: args['amount'] }));
      }

      case 'list_tabs': {
        const open = [...this.tabs.entries()].filter(([, t]) => !t.isClosed());
        return {
          tabs: open.map(([tabId, t]) => ({
            tabId,
            title: t.title().slice(0, 90),
            url: redactUrl(t.url()),
            active: t === this.current,
            openedByEya: true,
            workingHere: t === this.current,
          })),
        };
      }

      case 'focus_tab': {
        const tab = this.pageFor(args['tabId']);
        this.setCurrent(tab);
        return this.reply(tab, { ok: true });
      }

      case 'ads': {
        // The page script's own helper (the one the user's browser runs through the extension): it presses a video's Skip button, closes overlay adverts,
        // and starts a video the browser left waiting. Without it Eya Browser could neither skip an advert nor tell whether a song had started.
        const tab = this.pageFor(args['tabId']);
        const state = await this.agent(tab, 'ads', {
          mode: args['mode'],
          ...(args['keepPlaying'] === true ? { keepPlaying: true } : {}),
          ...(args['play'] === true ? { play: true } : {}),
        });
        return { state };
      }

      case 'stop_loading': {
        const tab = this.pageFor(args['tabId']);
        tab.stop();
        this.emitPage(tab, false);
        return { ok: true };
      }

      case 'new_tab': {
        const tab = this.options.env.createTab();
        const id = this.adopt(tab, false);
        this.setCurrent(tab);
        return { ok: true, tabId: id };
      }

      case 'show_window': {
        const tab = await this.ensurePage();
        this.options.env.reveal();
        tab.focus();
        return { ok: true, url: redactUrl(tab.url()) };
      }

      case 'screenshot': {
        const tab = this.pageFor(args['tabId']);
        const png = await tab.screenshot();
        return {
          tabId: this.ids.get(tab) ?? null,
          url: redactUrl(tab.url()),
          title: tab.title().slice(0, 200),
          dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        };
      }

      case 'search_page': {
        // A results page is read in a tab nobody sees, and closed again.
        const tab = this.options.env.createHiddenTab();
        try {
          const lookup = async (): Promise<unknown> => {
            await tab.load(String(args['url'] ?? ''), this.options.navTimeoutMs ?? NAV_TIMEOUT_MS);
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                await this.agent(tab, 'waitQuiet', { minMs: 200, timeoutMs: 3000 });
                return (await this.agent(tab, 'extractSearch', { engine: args['engine'] })) ?? [];
              } catch {
                await sleep(500);
              }
            }
            return [];
          };
          const hits = await Promise.race([lookup().catch(() => []), sleep(30_000).then(() => [])]);
          return { hits };
        } finally {
          tab.close();
        }
      }

      default:
        throw new Error(`Unknown request: ${op}`);
    }
  }

  /** The address that was last opened on purpose (so a crashed page can be put back where it was). */
  lastOpened(): string | null {
    return this.lastUrl;
  }
}
