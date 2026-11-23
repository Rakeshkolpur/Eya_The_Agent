import type { BridgeBrowserEvent, BridgeConnectionEvent } from './ChromeBridge';
import { BROWSER_NAMES } from './protocol';
import type { BrowserName, WireTab } from './protocol';

/**
 * Eya's picture of what is open in the user's real browsers, kept current from the extension's live events (and
 * refreshed by every handshake). Chrome and Edge are tracked independently and never merged: each has its own
 * windows, tabs, front tab and last time it was in use.
 */
export interface BrowserTabState {
  readonly browser: BrowserName;
  readonly windowId: number;
  readonly tabId: number;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
  readonly pinned: boolean;
  readonly loading: boolean;
  readonly lastObservedAt: number;
}

export interface BrowserState {
  readonly browser: BrowserName;
  readonly connected: boolean;
  readonly extensionVersion?: string;
  readonly browserVersion?: string;
  readonly tabs: readonly BrowserTabState[];
  readonly windowCount: number;
  /** The window currently in front (undefined when the browser is in the background). */
  readonly focusedWindowId?: number;
  /** The tab the user is looking at in the front window. */
  readonly activeTabId?: number;
  /** When this browser was last in use (window focus or tab switch). */
  readonly lastUsedAt: number;
  readonly lastDownloadAt?: number;
}

/** Something the user did in the browser (not Eya): a tab switch, a page moving, a tab opening or closing. */
export interface UserActivity {
  readonly browser: BrowserName;
  readonly kind: string;
  readonly tabId?: number;
  readonly at: number;
}

interface MutableState {
  browser: BrowserName;
  connected: boolean;
  extensionVersion?: string;
  browserVersion?: string;
  tabs: Map<number, BrowserTabState>;
  windows: Set<number>;
  focusedWindowId?: number;
  activeTabId?: number;
  lastUsedAt: number;
  lastDownloadAt?: number;
}

/** Reads the tab fields of an event payload defensively — a page title can be anything. */
function tabFrom(browser: BrowserName, raw: unknown, now: number): BrowserTabState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as Record<string, unknown>;
  if (typeof t['tabId'] !== 'number' || typeof t['windowId'] !== 'number') return null;
  return {
    browser,
    tabId: t['tabId'],
    windowId: t['windowId'],
    url: typeof t['url'] === 'string' ? t['url'].slice(0, 300) : '',
    title: typeof t['title'] === 'string' ? t['title'].slice(0, 120) : '',
    active: t['active'] === true,
    pinned: t['pinned'] === true,
    loading: t['loading'] === true,
    lastObservedAt: now,
  };
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export class BrowserWorldTracker {
  private readonly states = new Map<BrowserName, MutableState>();
  private readonly userListeners = new Set<(a: UserActivity) => void>();
  private readonly activity: UserActivity[] = [];
  private readonly offs: Array<() => void> = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** Follow a bridge: handshakes, disconnects and live events all keep the picture current. */
  attach(bridge: {
    onConnectionChange(l: (e: BridgeConnectionEvent) => void): () => void;
    onBrowserEvent(l: (e: BridgeBrowserEvent) => void): () => void;
  }): void {
    this.offs.push(bridge.onConnectionChange((e) => this.onConnection(e)));
    this.offs.push(bridge.onBrowserEvent((e) => this.onEvent(e)));
  }

  detach(): void {
    for (const off of this.offs.splice(0)) off();
  }

  private stateFor(browser: BrowserName): MutableState {
    let s = this.states.get(browser);
    if (s === undefined) {
      s = { browser, connected: false, tabs: new Map(), windows: new Set(), lastUsedAt: 0 };
      this.states.set(browser, s);
    }
    return s;
  }

  // ------------------------------------------------------------------ input
  onConnection(e: BridgeConnectionEvent): void {
    const s = this.stateFor(e.browser);
    s.connected = e.connected;
    if (!e.connected) return;
    const at = this.now();
    const hello = e.hello;
    if (hello === undefined) return;
    s.extensionVersion = hello.extensionVersion;
    s.browserVersion = hello.browserVersion;
    s.tabs = new Map(hello.tabs.map((t: WireTab) => [t.tabId, { ...t, browser: e.browser, lastObservedAt: at }]));
    s.windows = new Set(hello.windows.map((w) => w.windowId));
    const focused = hello.windows.find((w) => w.focused);
    if (focused !== undefined) {
      s.focusedWindowId = focused.windowId;
      s.lastUsedAt = Math.max(s.lastUsedAt, at);
    } else delete s.focusedWindowId;
    if (hello.activeTabId !== undefined) s.activeTabId = hello.activeTabId;
  }

  onEvent(e: BridgeBrowserEvent): void {
    const s = this.stateFor(e.browser);
    const at = this.now();
    const byEya = e.data['byEya'] === true;
    const note = (kind: string, tabId?: number) => {
      if (byEya) return;
      const a: UserActivity = { browser: e.browser, kind, ...(tabId !== undefined ? { tabId } : {}), at };
      this.activity.push(a);
      while (this.activity.length > 100) this.activity.shift();
      for (const l of this.userListeners) l(a);
    };

    switch (e.name) {
      case 'tab_created': {
        const tab = tabFrom(e.browser, e.data['tab'], at);
        if (tab === null) return;
        s.tabs.set(tab.tabId, tab);
        s.windows.add(tab.windowId);
        note('tab_created', tab.tabId);
        break;
      }
      case 'tab_updated': {
        const tab = tabFrom(e.browser, e.data['tab'], at);
        if (tab === null) return;
        const before = s.tabs.get(tab.tabId);
        s.tabs.set(tab.tabId, tab);
        if (before !== undefined && (before.url !== tab.url || before.title !== tab.title)) note('tab_updated', tab.tabId);
        break;
      }
      case 'tab_removed': {
        const tabId = e.data['tabId'];
        if (typeof tabId !== 'number') return;
        s.tabs.delete(tabId);
        if (s.activeTabId === tabId) delete s.activeTabId;
        note('tab_removed', tabId);
        break;
      }
      case 'tab_activated': {
        const tabId = e.data['tabId'];
        const windowId = e.data['windowId'];
        if (typeof tabId !== 'number' || typeof windowId !== 'number') return;
        for (const [id, t] of s.tabs) if (t.windowId === windowId) s.tabs.set(id, { ...t, active: id === tabId });
        if (s.focusedWindowId === windowId || s.focusedWindowId === undefined) s.activeTabId = tabId;
        s.lastUsedAt = at;
        note('tab_activated', tabId);
        break;
      }
      case 'navigation_started':
      case 'navigation_completed': {
        const tabId = e.data['tabId'];
        if (typeof tabId !== 'number') return;
        const t = s.tabs.get(tabId);
        if (t !== undefined) s.tabs.set(tabId, { ...t, loading: e.name === 'navigation_started', lastObservedAt: at });
        break;
      }
      case 'window_focused': {
        const windowId = e.data['windowId'];
        if (typeof windowId !== 'number') return;
        if (windowId < 0) {
          delete s.focusedWindowId; // the browser went to the background
        } else {
          s.focusedWindowId = windowId;
          s.lastUsedAt = at;
          const front = [...s.tabs.values()].find((t) => t.windowId === windowId && t.active);
          if (front !== undefined) s.activeTabId = front.tabId;
        }
        break;
      }
      case 'window_created': {
        const windowId = e.data['windowId'];
        if (typeof windowId === 'number') s.windows.add(windowId);
        break;
      }
      case 'window_removed': {
        const windowId = e.data['windowId'];
        if (typeof windowId !== 'number') return;
        s.windows.delete(windowId);
        for (const [id, t] of s.tabs) if (t.windowId === windowId) s.tabs.delete(id);
        break;
      }
      case 'download_created':
      case 'download_changed':
        s.lastDownloadAt = at;
        break;
      default:
        break;
    }
  }

  // ----------------------------------------------------------------- output
  state(browser: BrowserName): BrowserState | undefined {
    const s = this.states.get(browser);
    if (s === undefined) return undefined;
    return {
      browser,
      connected: s.connected,
      ...(s.extensionVersion !== undefined ? { extensionVersion: s.extensionVersion } : {}),
      ...(s.browserVersion !== undefined ? { browserVersion: s.browserVersion } : {}),
      tabs: [...s.tabs.values()],
      windowCount: s.windows.size,
      ...(s.focusedWindowId !== undefined ? { focusedWindowId: s.focusedWindowId } : {}),
      ...(s.activeTabId !== undefined ? { activeTabId: s.activeTabId } : {}),
      lastUsedAt: s.lastUsedAt,
      ...(s.lastDownloadAt !== undefined ? { lastDownloadAt: s.lastDownloadAt } : {}),
    };
  }

  tabsOf(browser: BrowserName): readonly BrowserTabState[] {
    return this.state(browser)?.tabs ?? [];
  }

  /** The connected browser the user touched most recently (a window brought forward, a tab switched). */
  activeBrowser(): BrowserName | null {
    let best: { browser: BrowserName; at: number } | null = null;
    for (const b of BROWSER_NAMES) {
      const s = this.states.get(b);
      if (s === undefined || !s.connected) continue;
      const at = s.focusedWindowId !== undefined ? Number.MAX_SAFE_INTEGER : s.lastUsedAt;
      if (best === null || at > best.at) best = { browser: b, at };
    }
    return best?.browser ?? null;
  }

  /** Open tabs (in any connected browser) on the same site as this address. The front tab of the front browser first. */
  tabsOnSite(url: string): BrowserTabState[] {
    const host = hostOf(url);
    if (host === '') return [];
    return BROWSER_NAMES.flatMap((b) => (this.states.get(b)?.connected === true ? [...this.tabsOf(b)] : [])).filter((t) => hostOf(t.url) === host);
  }

  /** What the user (not Eya) has done in this browser since `since` — so a plan is never carried on from a stale picture. */
  userActivitySince(browser: BrowserName, since: number): UserActivity[] {
    return this.activity.filter((a) => a.browser === browser && a.at > since);
  }

  onUserActivity(listener: (a: UserActivity) => void): () => void {
    this.userListeners.add(listener);
    return () => this.userListeners.delete(listener);
  }

  /** A short, privacy-conscious description for the model: which browsers are connected, how many tabs, the site in front. */
  summary(): string {
    const lines: string[] = [];
    const active = this.activeBrowser();
    for (const b of BROWSER_NAMES) {
      const s = this.state(b);
      if (s === undefined || !s.connected) continue;
      const front = s.tabs.find((t) => t.tabId === s.activeTabId);
      const host = front !== undefined ? hostOf(front.url) : '';
      lines.push(
        `${b === 'edge' ? 'Edge' : b === 'chrome' ? 'Chrome' : 'Browser'}${b === active ? ' (the one in use)' : ''}: ${s.tabs.length} tab${s.tabs.length === 1 ? '' : 's'}${host !== '' ? `, in front: ${host}` : ''}`,
      );
    }
    return lines.length > 0 ? `The user's own browser(s), connected to Eya: ${lines.join('; ')}.` : '';
  }
}
