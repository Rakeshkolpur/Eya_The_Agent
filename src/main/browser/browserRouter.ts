import { rootLogger } from '@main/logging/logger';
import type {
  ActOnPageResult,
  BrowserAutomationService,
  BrowserTabControl,
  ClickGate,
  FillOptions,
  FindOnPageResult,
  ReadPageResult,
} from './BrowserAutomationService';
import { BrowserUnavailableError } from './errors';
import type { BrowserTabInfo } from './pageEffects';
import { withExtras } from './pageSnapshot';
import type { BrowserEnvironment, PageSnapshot } from './pageSnapshot';
import type { WebSearchHit } from './webSearchResults';

const log = rootLogger.child('browser.router');

/**
 * Which browser Eya works in:
 *  - `auto` (default): the user's own signed-in browser whenever it is
 *    connected, otherwise Eya's own separate window — and every result says
 *    which one it was, so it is never a silent swap.
 *  - `user_chrome`: only the user's own browser; if it is not connected, stop
 *    and say so.
 *  - `eya_browser`: only Eya's own automation window.
 */
export type BrowserMode = 'auto' | 'user_chrome' | 'eya_browser';

export function parseBrowserMode(raw: string | undefined): BrowserMode {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'user_chrome' || v === 'eya_browser' ? v : 'auto';
}

export type UserBrowser = BrowserAutomationService & BrowserTabControl;

export interface RouterDeps {
  readonly user: UserBrowser;
  readonly eya: BrowserAutomationService;
  readonly isUserBrowserConnected: () => boolean;
  readonly mode: BrowserMode;
}

const NOT_CONNECTED =
  "Your own browser isn't connected to Eya right now. Ask the user to open their browser with the Eya Browser Bridge extension on, or to say \"connect my browser\".";
const LOST_CONNECTION =
  "Eya lost her connection to the user's own browser partway through, so she stopped instead of carrying on in a different browser behind their back. " +
  'Ask the user to check their browser is open (or say "connect my browser"), then start again.';
const EYA_WINDOW_NOTE =
  "This was opened in Eya's own separate browser window — NOT the user's signed-in browser, so nothing there is signed in. " +
  'If the task needs their accounts, ask them to say "connect my browser".';

/**
 * Puts the right browser behind one set of tools. An environment is chosen
 * when a website is opened and then kept for the rest of that task: if the
 * user's own browser drops out in the middle, the task stops with an honest
 * message rather than carrying on in a different browser.
 */
export class SwitchingBrowserService implements BrowserAutomationService, BrowserTabControl {
  private pinned: BrowserEnvironment | null = null;

  constructor(private readonly deps: RouterDeps) {}

  /** Which browser the current task is in (null before anything has been opened). */
  currentEnvironment(): BrowserEnvironment | null {
    return this.pinned;
  }

  private stamp(snapshot: PageSnapshot, env: BrowserEnvironment, notes: readonly string[] = []): PageSnapshot {
    return withExtras(snapshot, { environment: env, notes });
  }

  private stampResult(result: ActOnPageResult, env: BrowserEnvironment): ActOnPageResult {
    return { ...result, snapshot: this.stamp(result.snapshot, env) };
  }

  /** A new website starts a new task, so the environment is chosen afresh. */
  private forOpen(): { svc: BrowserAutomationService; env: BrowserEnvironment; note: string | null } {
    const connected = this.deps.isUserBrowserConnected();
    switch (this.deps.mode) {
      case 'user_chrome':
        if (!connected) throw new BrowserUnavailableError(NOT_CONNECTED);
        return { svc: this.deps.user, env: 'your_browser', note: null };
      case 'eya_browser':
        return { svc: this.deps.eya, env: 'eya_browser', note: null };
      default:
        return connected
          ? { svc: this.deps.user, env: 'your_browser', note: null }
          : { svc: this.deps.eya, env: 'eya_browser', note: EYA_WINDOW_NOTE };
    }
  }

  /** Continuing a task: stay where it started. */
  private forWork(): { svc: BrowserAutomationService; env: BrowserEnvironment } {
    const connected = this.deps.isUserBrowserConnected();
    let env = this.pinned;
    if (env === null) {
      env = this.deps.mode === 'eya_browser' ? 'eya_browser' : this.deps.mode === 'user_chrome' || connected ? 'your_browser' : 'eya_browser';
      this.pinned = env;
    }
    if (env === 'your_browser') {
      if (!connected) throw new BrowserUnavailableError(this.deps.mode === 'user_chrome' ? NOT_CONNECTED : LOST_CONNECTION);
      return { svc: this.deps.user, env };
    }
    return { svc: this.deps.eya, env };
  }

  async openWebsite(url: string): Promise<PageSnapshot> {
    const { svc, env, note } = this.forOpen();
    const snapshot = await svc.openWebsite(url);
    this.pinned = env;
    return this.stamp(snapshot, env, note !== null ? [note] : []);
  }

  async inspectPage(): Promise<PageSnapshot> {
    const { svc, env } = this.forWork();
    return this.stamp(await svc.inspectPage(), env);
  }

  async findOnPage(query: string): Promise<FindOnPageResult> {
    return this.forWork().svc.findOnPage(query);
  }

  async readPage(offset?: number): Promise<ReadPageResult> {
    return this.forWork().svc.readPage(offset);
  }

  async clickOnPage(text: string, gate?: ClickGate): Promise<ActOnPageResult> {
    const { svc, env } = this.forWork();
    return this.stampResult(await svc.clickOnPage(text, gate), env);
  }

  async fillOnPage(label: string, value: string, options?: FillOptions): Promise<ActOnPageResult> {
    const { svc, env } = this.forWork();
    return this.stampResult(await svc.fillOnPage(label, value, options), env);
  }

  async goBack(): Promise<ActOnPageResult> {
    const { svc, env } = this.forWork();
    return this.stampResult(await svc.goBack(), env);
  }

  async searchWeb(query: string): Promise<WebSearchHit[]> {
    const connected = this.deps.isUserBrowserConnected();
    switch (this.deps.mode) {
      case 'user_chrome':
        return this.deps.user.searchWeb(query);
      case 'eya_browser':
        return this.deps.eya.searchWeb(query);
      default:
        if (!connected) return this.deps.eya.searchWeb(query);
        try {
          return await this.deps.user.searchWeb(query);
        } catch (err) {
          // A search results page needs no sign-in, so falling back here is not a change of environment for the task.
          log.warn('search in the user browser failed; using Eya\'s own window for the lookup', { err: String(err) });
          return this.deps.eya.searchWeb(query);
        }
    }
  }

  private requireUserBrowser(): UserBrowser {
    if (!this.deps.isUserBrowserConnected()) {
      throw new BrowserUnavailableError(`${NOT_CONNECTED} (Listing and switching tabs only works in the user's own browser.)`);
    }
    return this.deps.user;
  }

  async listTabs(): Promise<BrowserTabInfo[]> {
    return this.requireUserBrowser().listTabs();
  }

  async switchToTab(tabId: number): Promise<PageSnapshot> {
    const snapshot = await this.requireUserBrowser().switchToTab(tabId);
    this.pinned = 'your_browser';
    return this.stamp(snapshot, 'your_browser');
  }

  async close(): Promise<void> {
    await this.deps.eya.close();
    await this.deps.user.close();
  }
}
