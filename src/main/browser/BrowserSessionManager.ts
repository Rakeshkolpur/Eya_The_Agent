import { rootLogger } from '@main/logging/logger';
import { ChromeBrowserService } from '@main/chrome/ChromeBrowserService';
import type { BridgeInfo, BrowserLink } from '@main/chrome/ChromeBridge';
import type { BrowserWorldTracker } from '@main/chrome/browserWorld';
import type { BrowserName } from '@main/chrome/protocol';
import type {
  ActOnPageResult,
  BrowserAutomationService,
  BrowserTabControl,
  ClickGate,
  FillOptions,
  FindOnPageResult,
  OpenWebsiteOptions,
  ReadPageResult,
  ScrollDirection,
} from './BrowserAutomationService';
import { selectBrowser } from './browserSelection';
import type { Selection } from './browserSelection';
import { BrowserUnavailableError } from './errors';
import { pageFingerprint } from './loopGuard';
import type { BrowserTabInfo } from './pageEffects';
import { withExtras } from './pageSnapshot';
import type { BrowserEnvironment, PageSnapshot } from './pageSnapshot';
import type { WebSearchHit } from './webSearchResults';

const log = rootLogger.child('browser.session');

/**
 * Which browser Eya works in:
 *  - `user_browser` (the default): ONLY the user's own, already-signed-in Chrome or Edge, through the Eya Browser Bridge
 *    extension. If no browser is connected she says so and says what to do; she never quietly starts a separate one.
 *  - `eya_browser`: only Eya's own separate, signed-out window (an explicit choice, e.g. for testing).
 *  - `auto`: the user's browser when connected, otherwise Eya's own window, with a note saying so. Opt-in.
 */
export type BrowserMode = 'user_browser' | 'eya_browser' | 'auto';

export function parseBrowserMode(raw: string | undefined): BrowserMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'eya_browser' || v === 'auto') return v;
  return 'user_browser'; // includes the older name "user_chrome"
}

export type UserBrowser = BrowserAutomationService & BrowserTabControl;

/** What the manager needs from the bridge — small, so tests can stand in for it. */
export interface ManagedBridge {
  connectedBrowsers(): BrowserName[];
  isConnected(browser?: BrowserName): boolean;
  forBrowser(browser: BrowserName): BrowserLink;
  waitForConnection(browser: BrowserName, ms: number): Promise<boolean>;
  waitingToPair(): BrowserName[];
  info(): BridgeInfo;
}

/** Starting and finding the user's NORMAL browsers (their own profile) — never a separate automation profile. */
export interface BrowserLauncher {
  installed(): Promise<BrowserName[]>;
  /** Browsers that currently have a process running. */
  running(): Promise<BrowserName[]>;
  /** Opens the address in the user's normal browser (a new tab if it is already running). False if it could not be started. */
  launch(browser: BrowserName, url: string): Promise<boolean>;
}

export interface SessionManagerDeps {
  readonly bridge: ManagedBridge;
  readonly world: BrowserWorldTracker;
  /** Eya's own separate, signed-out window. Used only when explicitly asked for. */
  readonly isolated: BrowserAutomationService;
  /** A throwaway, invisible browser for web-search lookups when no user browser is available (never a window the user sees). */
  readonly lookup?: BrowserAutomationService;
  readonly launcher: BrowserLauncher;
  readonly mode: BrowserMode;
  readonly preferred?: BrowserName | null;
  /** How long to wait for a freshly started browser's extension to connect. */
  readonly launchWaitMs?: number;
  /** How long to wait for an already-running browser's extension to wake up and connect before concluding it is absent. */
  readonly runningWaitMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly createService?: (link: BrowserLink, browser: BrowserName) => UserBrowser;
}

export interface BrowserOverview {
  readonly mode: BrowserMode;
  readonly browsers: ReadonlyArray<{
    readonly browser: BrowserName;
    readonly connected: boolean;
    readonly paired: boolean;
    readonly extensionVersion?: string;
    readonly tabs?: number;
    readonly inUse?: boolean;
  }>;
  /** Browsers whose extension is running but has not been paired yet. */
  readonly waitingToPair: readonly BrowserName[];
  readonly pairingOpen: boolean;
  readonly workingIn: 'your_browser' | 'eya_browser' | null;
  readonly workingBrowser?: BrowserName;
}

export interface WaitForUserResult {
  readonly changed: boolean;
  readonly snapshot: PageSnapshot;
  /** What was in the way before (a sign-in page, a CAPTCHA…) and is no longer there. */
  readonly cleared?: string;
}

type Pinned = { readonly kind: 'user'; readonly browser: BrowserName } | { readonly kind: 'isolated' } | null;

const NAME: Record<BrowserName, string> = { chrome: 'Chrome', edge: 'Edge', other: 'browser' };
const nameList = (bs: readonly BrowserName[]) => bs.map((b) => NAME[b]).join(' and ');

const EYA_WINDOW_NOTE =
  "This was opened in Eya's own separate browser window — NOT the user's signed-in browser, so nothing there is signed in. " +
  'Only use it when the user has said that is fine.';

function needsPairing(browsers: readonly BrowserName[]): BrowserUnavailableError {
  return new BrowserUnavailableError(
    `The Eya Browser Bridge extension in the user's ${nameList(browsers)} is running but is not connected to Eya yet. ` +
      'Ask the user whether to connect it, and if they say yes call connect_chrome — that links it once, and from then on it connects by itself. ' +
      'Nothing was opened in any other browser.',
    { needsPairing: browsers, why: 'needs_pairing' },
  );
}

/**
 * The one place that decides where a browser task happens, and the only thing the browser tools talk to.
 *
 * It keeps a live picture of the user's real browsers (from the extension's events) and:
 *   - opens a site by REUSING a tab the user already has on it, else a new tab in the SAME browser, else — if no browser
 *     is open — by starting their NORMAL browser (never a separate profile) and waiting for its extension;
 *   - picks between Chrome and Edge by where the site's session already is, not at random;
 *   - never silently substitutes a different browser: if the user's one is gone mid-task, it stops and says so;
 *   - notices when the user changed something themselves, and says so instead of carrying on from a stale picture;
 *   - can wait, then carry on by itself, while the user signs in or completes a check.
 */
export class BrowserSessionManager implements BrowserAutomationService, BrowserTabControl {
  private pinned: Pinned = null;
  private readonly services = new Map<BrowserName, UserBrowser>();
  private readonly lastActionAt = new Map<BrowserName, number>();
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: SessionManagerDeps) {
    this.sleepFn = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
  }

  // -------------------------------------------------------------- bookkeeping
  /** Which kind of browser the current task is in (null before anything has been opened). */
  currentEnvironment(): BrowserEnvironment | null {
    if (this.pinned === null) return null;
    return this.pinned.kind === 'user' ? 'your_browser' : 'eya_browser';
  }

  pinnedBrowser(): BrowserName | null {
    return this.pinned?.kind === 'user' ? this.pinned.browser : null;
  }

  private service(browser: BrowserName): UserBrowser {
    let s = this.services.get(browser);
    if (s === undefined) {
      const link = this.deps.bridge.forBrowser(browser);
      s =
        this.deps.createService?.(link, browser) ??
        new ChromeBrowserService(link, {
          environment: 'your_browser',
          browserName: browser,
          unavailableMessage: `Eya has lost her connection to the user's ${NAME[browser]} (it may have been closed). Ask them to check it is open with the Eya Browser Bridge extension on.`,
        });
      this.services.set(browser, s);
    }
    return s;
  }

  private stamp(snapshot: PageSnapshot, env: BrowserEnvironment, notes: readonly string[] = []): PageSnapshot {
    return withExtras(snapshot, { environment: env, notes });
  }

  private stampResult(result: ActOnPageResult, env: BrowserEnvironment, notes: readonly string[] = []): ActOnPageResult {
    return { ...result, snapshot: this.stamp(result.snapshot, env, notes) };
  }

  /** What the user (not Eya) has done in this browser since Eya's last step. */
  private userNotes(browser: BrowserName): string[] {
    const since = this.lastActionAt.get(browser) ?? 0;
    if (since === 0) return [];
    const done = this.deps.world.userActivitySince(browser, since);
    if (done.length === 0) return [];
    const kinds = [...new Set(done.map((a) => a.kind.replace(/^tab_/, '').replace('_', ' ')))].join(', ');
    return [`The user changed something in the browser since Eya's last step (${kinds}), so the page was re-read before acting rather than trusting the old picture.`];
  }

  private touched(browser: BrowserName): void {
    this.lastActionAt.set(browser, this.now() + 600); // a little after: the events caused by Eya's own step trail in
  }

  // ---------------------------------------------------------------- selection
  private selectFor(url?: string): Selection | null {
    const connected = this.deps.bridge.connectedBrowsers();
    const tabsOnSite = url === undefined ? [] : this.deps.world.tabsOnSite(url).map((t) => ({ browser: t.browser, url: t.url, active: t.active }));
    return selectBrowser({
      connected,
      tabsOnSite,
      taskBrowser: this.pinnedBrowser(),
      activeBrowser: this.deps.world.activeBrowser(),
      preferred: this.deps.preferred ?? null,
      ...(url !== undefined ? { url } : {}),
    });
  }

  private notConnectedError(): BrowserUnavailableError {
    const waiting = this.deps.bridge.waitingToPair();
    if (waiting.length > 0) return needsPairing(waiting);
    return new BrowserUnavailableError(
      "None of the user's browsers is connected to Eya. Call connect_chrome (it helps the user add or connect the Eya Browser Bridge extension), then try again. " +
        'Nothing was opened in any other browser.',
      { why: 'not_connected' },
    );
  }

  private async waitForAny(candidates: readonly BrowserName[], ms: number): Promise<BrowserName | null> {
    if (candidates.length === 0) return null;
    return new Promise<BrowserName | null>((resolve) => {
      let remaining = candidates.length;
      for (const b of candidates) {
        void this.deps.bridge.waitForConnection(b, ms).then((ok) => {
          if (ok) resolve(b);
          else if (--remaining === 0) resolve(null);
        });
      }
    });
  }

  /**
   * Where a new site should open. A connected browser (preferring the one that already has the site); failing that, the
   * user's normal browser is started or woken — and only if its extension still does not answer does this give up, out loud.
   */
  private async resolveForOpen(url: string): Promise<{ browser: BrowserName; startedBrowser: boolean }> {
    const sel = this.selectFor(url);
    if (sel !== null) {
      log.info('browser chosen', { browser: sel.browser, reason: sel.reason });
      return { browser: sel.browser, startedBrowser: false };
    }

    const waiting = this.deps.bridge.waitingToPair();
    if (waiting.length > 0) throw needsPairing(waiting);

    const [installed, running] = await Promise.all([this.deps.launcher.installed(), this.deps.launcher.running()]);
    const pick = (list: readonly BrowserName[]): BrowserName | undefined =>
      this.deps.preferred != null && list.includes(this.deps.preferred) ? this.deps.preferred : (['chrome', 'edge', 'other'] as const).find((b) => list.includes(b));

    // A browser that is already open: its extension may just be waking up (it sleeps between alarms).
    if (running.length > 0) {
      const woke = await this.waitForAny(running, this.deps.runningWaitMs ?? 8000);
      if (woke !== null) return { browser: woke, startedBrowser: false };
      const stillWaiting = this.deps.bridge.waitingToPair();
      if (stillWaiting.length > 0) throw needsPairing(stillWaiting);
    }

    const target = pick(running.length > 0 ? running : installed);
    if (target === undefined) {
      throw new BrowserUnavailableError('Neither Chrome nor Edge could be found on this PC, so there is no browser of the user\'s to work in.', { why: 'no_browser' });
    }
    // Open the page in the user's NORMAL browser (their own profile; a new tab if it is already open), then wait for the extension.
    const opened = await this.deps.launcher.launch(target, url);
    if (!opened) {
      throw new BrowserUnavailableError(`Could not start the user's ${NAME[target]}.`, { why: 'no_browser' });
    }
    log.info('started the user browser', { browser: target, alreadyRunning: running.includes(target) });
    const connected = await this.deps.bridge.waitForConnection(target, this.deps.launchWaitMs ?? 25_000);
    if (connected) return { browser: target, startedBrowser: !running.includes(target) };

    const knocking = this.deps.bridge.waitingToPair();
    if (knocking.length > 0) throw needsPairing(knocking);
    throw new BrowserUnavailableError(
      `I opened the page in the user's ${NAME[target]}, but the Eya Browser Bridge extension in it did not answer — it is probably not installed there or is switched off. ` +
        `Tell the user: open the browser's extensions page, turn on Developer mode, and make sure "Eya Browser Bridge" is added and switched on (say "connect my browser"; if the extension is not in the browser at all, ask Eya to show them its folder).` +
        'Nothing was opened in any other browser, and a separate Eya browser window is only used if the user says that is fine.',
      { why: 'no_extension' },
    );
  }

  /** Continuing a task: stay where it started. */
  private forWork(): { svc: BrowserAutomationService; env: BrowserEnvironment; browser?: BrowserName } {
    const pinned = this.pinned;
    if (pinned?.kind === 'isolated') return { svc: this.deps.isolated, env: 'eya_browser' };
    if (pinned?.kind === 'user') {
      if (!this.deps.bridge.isConnected(pinned.browser)) {
        throw new BrowserUnavailableError(
          `Eya lost her connection to the user's ${NAME[pinned.browser]} partway through, so she stopped instead of carrying on in a different browser behind their back. ` +
            'Ask the user to check their browser is open (or say "connect my browser"), then start again.',
          { why: 'lost_connection' },
        );
      }
      return { svc: this.service(pinned.browser), env: 'your_browser', browser: pinned.browser };
    }
    if (this.deps.mode === 'eya_browser') {
      this.pinned = { kind: 'isolated' };
      return { svc: this.deps.isolated, env: 'eya_browser' };
    }
    const sel = this.selectFor();
    if (sel === null) {
      if (this.deps.mode === 'auto') {
        this.pinned = { kind: 'isolated' };
        return { svc: this.deps.isolated, env: 'eya_browser' };
      }
      throw this.notConnectedError();
    }
    this.pinned = { kind: 'user', browser: sel.browser };
    log.info('browser chosen', { browser: sel.browser, reason: sel.reason });
    return { svc: this.service(sel.browser), env: 'your_browser', browser: sel.browser };
  }

  // -------------------------------------------------------------- the service
  async openWebsite(url: string, options?: OpenWebsiteOptions): Promise<PageSnapshot> {
    if (options?.isolated === true || this.deps.mode === 'eya_browser') {
      const snapshot = await this.deps.isolated.openWebsite(url);
      this.pinned = { kind: 'isolated' };
      return this.stamp(snapshot, 'eya_browser', [EYA_WINDOW_NOTE]);
    }

    let browser: BrowserName;
    let startedBrowser = false;
    try {
      ({ browser, startedBrowser } = await this.resolveForOpen(url));
    } catch (err) {
      // Legacy opt-in mode only: the older behaviour of using Eya's own window when the user's browser is not there.
      if (this.deps.mode === 'auto' && err instanceof BrowserUnavailableError) {
        const snapshot = await this.deps.isolated.openWebsite(url);
        this.pinned = { kind: 'isolated' };
        return this.stamp(snapshot, 'eya_browser', [EYA_WINDOW_NOTE]);
      }
      throw err;
    }
    const notes = this.userNotes(browser);
    const snapshot = await this.service(browser).openWebsite(url);
    this.pinned = { kind: 'user', browser };
    this.touched(browser);
    return this.stamp(snapshot, 'your_browser', [
      `Opened in the user's ${NAME[browser]}.`,
      ...(startedBrowser ? [`${NAME[browser]} was not running, so Eya started it (their normal profile) and opened the page there.`] : []),
      ...notes,
    ]);
  }

  async inspectPage(): Promise<PageSnapshot> {
    const { svc, env, browser } = this.forWork();
    const notes = browser !== undefined ? this.userNotes(browser) : [];
    const snapshot = await svc.inspectPage();
    if (browser !== undefined) this.touched(browser);
    return this.stamp(snapshot, env, notes);
  }

  async findOnPage(query: string): Promise<FindOnPageResult> {
    return this.forWork().svc.findOnPage(query);
  }

  async readPage(offset?: number): Promise<ReadPageResult> {
    return this.forWork().svc.readPage(offset);
  }

  private async act(run: (svc: BrowserAutomationService) => Promise<ActOnPageResult>): Promise<ActOnPageResult> {
    const { svc, env, browser } = this.forWork();
    const notes = browser !== undefined ? this.userNotes(browser) : [];
    const result = await run(svc);
    if (browser !== undefined) this.touched(browser);
    return this.stampResult(result, env, notes);
  }

  clickOnPage(text: string, gate?: ClickGate): Promise<ActOnPageResult> {
    return this.act((svc) => svc.clickOnPage(text, gate));
  }
  fillOnPage(label: string, value: string, options?: FillOptions): Promise<ActOnPageResult> {
    return this.act((svc) => svc.fillOnPage(label, value, options));
  }
  goBack(): Promise<ActOnPageResult> {
    return this.act((svc) => svc.goBack());
  }
  goForward(): Promise<ActOnPageResult> {
    return this.act((svc) => svc.goForward());
  }
  reload(): Promise<ActOnPageResult> {
    return this.act((svc) => svc.reload());
  }
  scroll(direction: ScrollDirection, amount?: number): Promise<ActOnPageResult> {
    return this.act((svc) => svc.scroll(direction, amount));
  }

  async searchWeb(query: string): Promise<WebSearchHit[]> {
    if (this.deps.mode === 'eya_browser') return (this.deps.lookup ?? this.deps.isolated).searchWeb(query);
    const sel = this.selectFor();
    if (sel !== null) {
      try {
        return await this.service(sel.browser).searchWeb(query);
      } catch (err) {
        log.warn('search in the user browser failed', { browser: sel.browser, err: String(err) });
        if (this.deps.lookup === undefined) throw err;
      }
    }
    // No user browser to read a results page in: an invisible throwaway lookup — it never shows a window and never
    // stands in for the user's browser (a results page needs no sign-in).
    if (this.deps.lookup !== undefined) return this.deps.lookup.searchWeb(query);
    throw this.notConnectedError();
  }

  // --------------------------------------------------------------------- tabs
  private browsersToQuery(browser?: BrowserName): BrowserName[] {
    const connected = this.deps.bridge.connectedBrowsers();
    if (browser !== undefined) {
      if (!connected.includes(browser)) throw new BrowserUnavailableError(`The user's ${NAME[browser]} is not connected to Eya.`, { why: 'not_connected' });
      return [browser];
    }
    if (connected.length === 0) throw this.notConnectedError();
    return connected;
  }

  async listTabs(browser?: BrowserName): Promise<BrowserTabInfo[]> {
    const lists = await Promise.all(this.browsersToQuery(browser).map((b) => this.service(b).listTabs()));
    return lists.flat();
  }

  private browserForTab(tabId: number, browser?: BrowserName): BrowserName {
    if (browser !== undefined) return this.browsersToQuery(browser)[0] as BrowserName;
    const connected = this.browsersToQuery();
    if (connected.length === 1) return connected[0] as BrowserName;
    const holders = connected.filter((b) => this.deps.world.tabsOf(b).some((t) => t.tabId === tabId));
    if (holders.length === 1) return holders[0] as BrowserName;
    throw new Error(`More than one browser is connected and tab ${tabId} could belong to either: say which browser (${nameList(connected)}) it is in.`);
  }

  async switchToTab(tabId: number, browser?: BrowserName): Promise<PageSnapshot> {
    const target = this.browserForTab(tabId, browser);
    const snapshot = await this.service(target).switchToTab(tabId);
    this.pinned = { kind: 'user', browser: target };
    this.touched(target);
    return this.stamp(snapshot, 'your_browser', [`Switched to a tab in the user's ${NAME[target]}.`]);
  }

  async closeTab(
    tabId: number,
    options: { readonly browser?: BrowserName; readonly allowUserTab?: boolean } = {},
  ): Promise<{ readonly closed: boolean; readonly remainingTabs: number }> {
    const target = this.browserForTab(tabId, options.browser);
    return this.service(target).closeTab(tabId, { ...(options.allowUserTab !== undefined ? { allowUserTab: options.allowUserTab } : {}) });
  }

  // ------------------------------------------------------- status and waiting
  describe(): BrowserOverview {
    const info = this.deps.bridge.info();
    const active = this.deps.world.activeBrowser();
    const browsers = (['chrome', 'edge', 'other'] as const).flatMap((b) => {
      const link = info.browsers[b];
      if (link === undefined) return [];
      const state = this.deps.world.state(b);
      return [
        {
          browser: b,
          connected: link.connected,
          paired: link.paired,
          ...(link.extensionVersion !== undefined ? { extensionVersion: link.extensionVersion } : {}),
          ...(link.connected && state !== undefined ? { tabs: state.tabs.length, inUse: active === b } : {}),
        },
      ];
    });
    const working = this.currentEnvironment();
    const workingBrowser = this.pinnedBrowser();
    return {
      mode: this.deps.mode,
      browsers,
      waitingToPair: info.waitingToPair,
      pairingOpen: info.pairingOpen,
      workingIn: working,
      ...(workingBrowser !== null ? { workingBrowser } : {}),
    };
  }

  /**
   * Waits — up to `timeoutMs` — for the page the user is dealing with to change (they sign in, finish a check, close a
   * popup), then reports the page as it now is so the original task can simply continue. Woken early by the user's own
   * activity in the browser; otherwise it looks every second and a half.
   */
  async waitForUserChange(timeoutMs = 30_000): Promise<WaitForUserResult> {
    const { svc, env, browser } = this.forWork();
    const start = await svc.inspectPage();
    const fingerprint = pageFingerprint(start);
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      await this.sleepOrUserActivity(browser, Math.min(1500, Math.max(50, deadline - this.now())));
      const current = await svc.inspectPage();
      const kindBefore = start.challenge?.kind;
      const kindNow = current.challenge?.kind;
      const changed = current.url !== start.url || kindBefore !== kindNow || pageFingerprint(current) !== fingerprint;
      if (!changed) continue;
      await this.sleepFn(500); // let a sign-in finish redirecting
      const settled = await svc.inspectPage();
      if (browser !== undefined) this.touched(browser);
      return {
        changed: true,
        snapshot: this.stamp(settled, env),
        ...(kindBefore !== undefined && settled.challenge?.kind !== kindBefore ? { cleared: kindBefore } : {}),
      };
    }
    if (browser !== undefined) this.touched(browser);
    return { changed: false, snapshot: this.stamp(start, env) };
  }

  private async sleepOrUserActivity(browser: BrowserName | undefined, ms: number): Promise<void> {
    if (browser === undefined) return this.sleepFn(ms);
    await new Promise<void>((resolve) => {
      const off = this.deps.world.onUserActivity((a) => {
        if (a.browser !== browser) return;
        off();
        resolve();
      });
      void this.sleepFn(ms).then(() => {
        off();
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    await this.deps.isolated.close();
    await this.deps.lookup?.close();
    for (const s of this.services.values()) await s.close();
  }
}
