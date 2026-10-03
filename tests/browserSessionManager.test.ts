import { describe, it, expect } from 'vitest';
import { BrowserSessionManager, parseBrowserMode } from '../src/main/browser/BrowserSessionManager';
import type { BrowserLauncher, BrowserMode, ManagedBridge, UserBrowser } from '../src/main/browser/BrowserSessionManager';
import type { BrowserAutomationService, BrowserCapture, BrowserFileAttach, BrowserItemLister, ScreenshotImage } from '../src/main/browser/BrowserAutomationService';
import { BrowserUnavailableError, CommunicationAccessError } from '../src/main/browser/errors';
import { COMMUNICATION_OFF, CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { CommunicationSettings } from '../src/main/privacy/communicationAccess';
import type { PageSnapshot } from '../src/main/browser/pageSnapshot';
import type { BridgeInfo } from '../src/main/chrome/ChromeBridge';
import { BrowserWorldTracker } from '../src/main/chrome/browserWorld';
import type { BrowserName, WireTab } from '../src/main/chrome/protocol';

const ORDER: readonly BrowserName[] = ['chrome', 'edge', 'other'];

function snap(title: string, over: Partial<PageSnapshot> = {}): PageSnapshot {
  return { url: `https://${title.toLowerCase().replace(/\W+/g, '-')}.example/`, title, headings: [], links: [], buttons: [], inputs: [], dialogs: [], truncated: false, ...over };
}

class FakeBridge implements ManagedBridge {
  connected = new Set<BrowserName>();
  knocking: BrowserName[] = [];
  /** A browser whose extension connects as soon as it is waited for (it woke up, or was just started). */
  connectsOnWait = new Set<BrowserName>();
  waited: Array<{ browser: BrowserName; ms: number }> = [];
  connectedBrowsers() {
    return ORDER.filter((b) => this.connected.has(b));
  }
  isConnected(b?: BrowserName) {
    return b === undefined ? this.connected.size > 0 : this.connected.has(b);
  }
  forBrowser(browser: BrowserName) {
    return { isConnected: () => this.connected.has(browser), request: async () => Promise.reject(new Error('the fake services never use the link')) };
  }
  async waitForConnection(browser: BrowserName, ms: number) {
    this.waited.push({ browser, ms });
    if (this.connected.has(browser)) return true;
    if (this.connectsOnWait.has(browser)) {
      this.connected.add(browser);
      return true;
    }
    return false;
  }
  /** Browsers paired with Eya in an earlier session (whether or not they are connected right now). */
  paired = new Set<BrowserName>();
  /** Knocking extensions that were refused for being an older version than this Eya needs. */
  outdatedList: BrowserName[] = [];
  waitingToPair() {
    return this.knocking.filter((b) => !this.connected.has(b));
  }
  outdated() {
    return this.outdatedList.filter((b) => this.knocking.includes(b) && !this.connected.has(b));
  }
  info(): BridgeInfo {
    const isPaired = (b: BrowserName) => this.connected.has(b) || this.paired.has(b);
    const browsers: BridgeInfo['browsers'] = Object.fromEntries(
      ORDER.filter((b) => this.connected.has(b) || this.knocking.includes(b) || this.paired.has(b)).map((b) => [b, { connected: this.connected.has(b), paired: isPaired(b) }]),
    );
    return { listening: true, pairingOpen: false, anyConnected: this.connected.size > 0, browsers, waitingToPair: this.waitingToPair(), outdated: this.outdated() };
  }
}

interface Rig {
  manager: BrowserSessionManager;
  bridge: FakeBridge;
  world: BrowserWorldTracker;
  calls: string[];
  launched: Array<[string, string]>;
  clock: { now: number };
  inspectQueue: Map<BrowserName, PageSnapshot[]>;
  setTabs(browser: BrowserName, tabs: Array<Pick<WireTab, 'tabId' | 'url'> & Partial<WireTab>>, front?: boolean): void;
}

function rig(
  opts: {
    mode?: BrowserMode;
    connected?: BrowserName[];
    installed?: BrowserName[];
    running?: BrowserName[];
    preferred?: BrowserName | null;
    knocking?: BrowserName[];
    /** Of the knocking ones, the extensions refused as an older version (they need a reload). */
    outdated?: BrowserName[];
    /** Browsers paired with Eya before (not necessarily connected now). */
    paired?: BrowserName[];
    startedBrowserConnects?: boolean;
    withLookup?: boolean;
    launchOk?: boolean;
    sleep?: (ms: number) => Promise<void>;
    /** The Communication Access policy (chat apps are only touched when the user switched it on). */
    policy?: CommunicationPolicy;
    /** The address the picture itself reports once taken. */
    shotUrl?: string;
  } = {},
): Rig {
  const calls: string[] = [];
  const launched: Array<[string, string]> = [];
  const clock = { now: 1_000_000 };
  const bridge = new FakeBridge();
  for (const b of opts.connected ?? []) bridge.connected.add(b);
  bridge.knocking = opts.knocking ?? [];
  bridge.outdatedList = opts.outdated ?? [];
  for (const b of opts.paired ?? []) bridge.paired.add(b);
  const world = new BrowserWorldTracker(() => clock.now);
  const inspectQueue = new Map<BrowserName, PageSnapshot[]>();

  const shot = (environment: 'your_browser' | 'eya_browser', browser?: BrowserName): ScreenshotImage => ({ bytes: Buffer.from('png'), mime: 'image/png', url: opts.shotUrl ?? 'https://x.example/', title: browser ?? 'eya', environment, ...(browser !== undefined ? { browser } : {}) });

  const userService = (browser: BrowserName): UserBrowser & BrowserCapture & BrowserItemLister & BrowserFileAttach => ({
    openWebsite: async (url) => (calls.push(`${browser}:open:${url}`), snap(`${browser} page`, { url })),
    inspectPage: async () => {
      calls.push(`${browser}:inspect`);
      const q = inspectQueue.get(browser);
      return q !== undefined && q.length > 0 ? (q.length > 1 ? (q.shift() as PageSnapshot) : (q[0] as PageSnapshot)) : snap(`${browser} page`);
    },
    findOnPage: async (query) => (calls.push(`${browser}:find`), { url: '', title: browser, query, matches: [], textMatches: [], totalControls: 0 }),
    readPage: async () => (calls.push(`${browser}:read`), { url: '', title: browser, text: '', offset: 0, nextOffset: null, totalChars: 0 }),
    clickOnPage: async (text) => (calls.push(`${browser}:click:${text}`), { ok: true as const, snapshot: snap(`${browser} page`) }),
    fillOnPage: async () => (calls.push(`${browser}:fill`), { ok: true as const, snapshot: snap(`${browser} page`) }),
    goBack: async () => (calls.push(`${browser}:back`), { ok: true as const, snapshot: snap(`${browser} page`) }),
    goForward: async () => (calls.push(`${browser}:forward`), { ok: true as const, snapshot: snap(`${browser} page`) }),
    reload: async () => (calls.push(`${browser}:reload`), { ok: true as const, snapshot: snap(`${browser} page`) }),
    scroll: async (d) => (calls.push(`${browser}:scroll:${d}`), { ok: true as const, snapshot: snap(`${browser} page`) }),
    searchWeb: async () => (calls.push(`${browser}:search`), []),
    screenshot: async () => (calls.push(`${browser}:screenshot`), shot('your_browser', browser)),
    close: async () => undefined,
    listItems: async () => (calls.push(`${browser}:items`), [{ name: 'Rahul Sharma ok', primary: 'Rahul Sharma', role: 'clickable' }]),
    attachFile: async (request) => (calls.push(`${browser}:attach:${request.name}`), { ok: true as const, snapshot: snap(`${browser} page`, { url: opts.shotUrl ?? 'https://x.example/' }) }),
    listTabs: async () => (calls.push(`${browser}:tabs`), world.tabsOf(browser).map((t) => ({ browser, tabId: t.tabId, title: t.title, url: t.url, active: t.active, openedByEya: false, workingHere: false }))),
    switchToTab: async (id) => (calls.push(`${browser}:switch:${id}`), snap(`${browser} tab ${id}`)),
    closeTab: async (id, o) => (calls.push(`${browser}:close:${id}:${String(o?.allowUserTab)}`), { closed: true, remainingTabs: 1 }),
  });

  const spy = (name: string): BrowserAutomationService => {
    const ok = (key: string) => async () => (calls.push(name + ":" + key), { ok: true as const, snapshot: snap(name + " page") });
    return {
      openWebsite: async () => (calls.push(name + ":openWebsite"), snap(name + " page")),
      inspectPage: async () => (calls.push(name + ":inspectPage"), snap(name + " page")),
      findOnPage: async (query) => (calls.push(name + ":findOnPage"), { url: "", title: name, query, matches: [], textMatches: [], totalControls: 0 }),
      readPage: async () => (calls.push(name + ":readPage"), { url: "", title: name, text: "", offset: 0, nextOffset: null, totalChars: 0 }),
      clickOnPage: ok("clickOnPage"),
      fillOnPage: ok("fillOnPage"),
      goBack: ok("goBack"),
      goForward: ok("goForward"),
      reload: ok("reload"),
      scroll: ok("scroll"),
      searchWeb: async () => (calls.push(name + ":searchWeb"), []),
      screenshot: async () => (calls.push(name + ":screenshot"), shot('eya_browser')),
      close: async () => undefined,
    } as BrowserAutomationService & BrowserCapture;
  };

  const launcher: BrowserLauncher = {
    installed: async () => opts.installed ?? [],
    running: async () => opts.running ?? [],
    launch: async (browser, url) => {
      launched.push([browser, url]);
      if (opts.launchOk === false) return false;
      if (opts.startedBrowserConnects === true) bridge.connectsOnWait.add(browser);
      return true;
    },
  };

  const manager = new BrowserSessionManager({
    bridge,
    world,
    isolated: spy('isolated'),
    ...(opts.withLookup === true ? { lookup: spy('lookup') } : {}),
    launcher,
    mode: opts.mode ?? 'user_browser',
    preferred: opts.preferred ?? null,
    sleep: opts.sleep ?? (async (ms) => void (clock.now += ms)),
    now: () => clock.now,
    createService: (_link, browser) => userService(browser),
    ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
  });

  return {
    manager,
    bridge,
    world,
    calls,
    launched,
    clock,
    inspectQueue,
    setTabs: (browser, tabs, front = false) =>
      world.onConnection({
        browser,
        connected: true,
        hello: {
          t: 'hello',
          ext: 'x',
          protocolVersion: 2,
          extensionVersion: '0.2.0',
          browser,
          browserVersion: '154',
          capabilities: [],
          tabs: tabs.map((t) => ({ windowId: 1, title: `T${t.tabId}`, active: false, pinned: false, loading: false, ...t })),
          windows: [{ windowId: 1, focused: front, tabCount: tabs.length }],
        },
      }),
  };
}

async function caught(p: Promise<unknown>): Promise<BrowserUnavailableError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BrowserUnavailableError);
    return e as BrowserUnavailableError;
  }
  throw new Error('expected it to fail');
}

describe('modes', () => {
  it('the user\'s own browser is the default, and the older name still means the same', () => {
    expect(parseBrowserMode(undefined)).toBe('user_browser');
    expect(parseBrowserMode('')).toBe('user_browser');
    expect(parseBrowserMode('user_chrome')).toBe('user_browser');
    expect(parseBrowserMode('nonsense')).toBe('user_browser');
    expect(parseBrowserMode(' eya_browser ')).toBe('eya_browser');
    expect(parseBrowserMode('AUTO')).toBe('auto');
  });
});

describe('opening a site: always the user\'s own browser', () => {
  it('Test A/B/D: with Chrome and Edge both open it goes to the one that already has the site (and its session), not to the other', async () => {
    const r = rig({ connected: ['chrome', 'edge'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://news.example/' }, { tabId: 2, url: 'https://weather.example/' }]);
    r.setTabs('edge', [{ tabId: 1, url: 'https://other.example/' }, { tabId: 2, url: 'https://mysite.example/dashboard' }, { tabId: 3, url: 'https://x.example/' }]);
    const s = await r.manager.openWebsite('https://mysite.example/');
    expect(r.calls).toEqual(['edge:open:https://mysite.example/']);
    expect(s.environment).toBe('your_browser');
    expect(s.notes).toContain("Opened in the user's Edge.");
    expect(r.manager.pinnedBrowser()).toBe('edge');
    expect(r.launched).toEqual([]);
    expect(r.calls.some((c) => c.startsWith('isolated'))).toBe(false);
  });

  it('Test C: the browser is open but the site is not: a new tab in the SAME browser (the one in use), nothing else started', async () => {
    const r = rig({ connected: ['chrome', 'edge'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://news.example/' }]);
    r.setTabs('edge', [{ tabId: 1, url: 'https://x.example/', active: true }], true);
    await r.manager.openWebsite('https://brandnew.example/');
    expect(r.calls).toEqual(['edge:open:https://brandnew.example/']); // Edge is the one the user is in
    expect(r.launched).toEqual([]);
  });

  it('keeps a task in the browser it began in, then picks afresh for the next site', async () => {
    const r = rig({ connected: ['chrome', 'edge'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://a.example/' }]);
    r.setTabs('edge', [{ tabId: 1, url: 'https://b.example/' }]);
    await r.manager.openWebsite('https://a.example/');
    await r.manager.inspectPage();
    await r.manager.clickOnPage('Go');
    expect(r.calls).toEqual(['chrome:open:https://a.example/', 'chrome:inspect', 'chrome:click:Go']);
    r.calls.length = 0;
    await r.manager.openWebsite('https://b.example/');
    expect(r.calls).toEqual(['edge:open:https://b.example/']);
    expect(r.manager.pinnedBrowser()).toBe('edge');
  });

  it('no browser connected, but an extension is running and waiting to be paired: stops and says so — opens nothing anywhere', async () => {
    const r = rig({ knocking: ['chrome'], installed: ['chrome', 'edge'], running: ['chrome'] });
    const err = await caught(r.manager.openWebsite('https://a.example/'));
    expect(err.detail).toMatchObject({ why: 'needs_pairing', needsPairing: ['chrome'] });
    expect(err.message).toMatch(/connect_chrome/);
    expect(r.launched).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  it('a browser is running and its extension is just waking up: waits for it instead of launching anything', async () => {
    const r = rig({ running: ['chrome'], installed: ['chrome'] });
    r.bridge.connectsOnWait.add('chrome');
    const s = await r.manager.openWebsite('https://a.example/');
    expect(r.launched).toEqual([]);
    expect(r.calls).toEqual(['chrome:open:https://a.example/']);
    expect(s.notes?.join(' ')).not.toMatch(/started/);
  });

  it('no browser running at all: starts the user\'s NORMAL browser with the address (no profile, no automation), then works in it', async () => {
    const r = rig({ installed: ['chrome', 'edge'], startedBrowserConnects: true });
    const s = await r.manager.openWebsite('https://a.example/');
    expect(r.launched).toEqual([['chrome', 'https://a.example/']]);
    expect(r.calls).toEqual(['chrome:open:https://a.example/']);
    expect(s.environment).toBe('your_browser');
    expect(s.notes?.join(' ')).toMatch(/Chrome was not running, so Eya started it/);
    expect(r.calls.some((c) => c.startsWith('isolated'))).toBe(false);
  });

  it('uses the user\'s preferred browser when it has to start one, and only one that is installed', async () => {
    const edgeFirst = rig({ installed: ['chrome', 'edge'], preferred: 'edge', startedBrowserConnects: true });
    await edgeFirst.manager.openWebsite('https://a.example/');
    expect(edgeFirst.launched[0]?.[0]).toBe('edge');
    const onlyEdge = rig({ installed: ['edge'], preferred: 'chrome', startedBrowserConnects: true });
    await onlyEdge.manager.openWebsite('https://a.example/');
    expect(onlyEdge.launched[0]?.[0]).toBe('edge');
  });

  it('a running browser whose extension never answers: opens the page in it (new tab) and then says exactly what is wrong — never another browser', async () => {
    const r = rig({ running: ['edge'], installed: ['chrome', 'edge'] });
    const err = await caught(r.manager.openWebsite('https://a.example/'));
    expect(err.detail.why).toBe('no_extension');
    expect(err.message).toMatch(/Eya Browser Bridge extension/);
    expect(err.message).toMatch(/Developer mode/);
    expect(r.launched).toEqual([['edge', 'https://a.example/']]); // the page itself still opened, in THEIR browser
    expect(r.calls.some((c) => c.startsWith('isolated') || c.startsWith('lookup'))).toBe(false);
  });

  it('says so when no supported browser is installed, or one will not start', async () => {
    expect((await caught(rig({}).manager.openWebsite('https://a.example/'))).detail.why).toBe('no_browser');
    expect((await caught(rig({ installed: ['chrome'], launchOk: false }).manager.openWebsite('https://a.example/'))).detail.why).toBe('no_browser');
  });
});

describe('Eya\'s own separate window is never a silent substitute', () => {
  it('it opens only when explicitly asked for, says it is signed out, and the rest of that task stays there', async () => {
    const r = rig({ connected: ['chrome'] });
    const s = await r.manager.openWebsite('https://a.example/', { isolated: true });
    expect(r.calls).toEqual(['isolated:openWebsite']);
    expect(s.environment).toBe('eya_browser');
    expect(s.notes?.join(' ')).toMatch(/NOT the user's signed-in browser/);
    expect(r.manager.currentEnvironment()).toBe('eya_browser');
    r.calls.length = 0;
    await r.manager.clickOnPage('Go');
    expect(r.calls).toEqual(['isolated:clickOnPage']);
  });

  it('eya_browser mode is the explicit "only the separate window" choice', async () => {
    const r = rig({ mode: 'eya_browser', connected: ['chrome'] });
    expect((await r.manager.openWebsite('https://a.example/')).environment).toBe('eya_browser');
    expect(r.launched).toEqual([]);
  });

  it('legacy auto mode: the older fallback still exists as an opt-in, and still says what it did', async () => {
    const r = rig({ mode: 'auto', installed: [] });
    const s = await r.manager.openWebsite('https://a.example/');
    expect(s.environment).toBe('eya_browser');
    expect(s.notes?.join(' ')).toMatch(/NOT the user's signed-in browser/);
    const withBrowser = rig({ mode: 'auto', connected: ['edge'] });
    expect((await withBrowser.manager.openWebsite('https://a.example/')).environment).toBe('your_browser');
  });

  it('the default mode NEVER falls back, however things fail', async () => {
    for (const setup of [{}, { knocking: ['chrome' as const] }, { installed: ['chrome' as const] }, { running: ['edge' as const], installed: ['edge' as const] }]) {
      const r = rig(setup);
      await caught(r.manager.openWebsite('https://a.example/'));
      expect(r.calls.some((c) => c.startsWith('isolated')), JSON.stringify(setup)).toBe(false);
    }
  });
});

describe('losing the browser mid-task', () => {
  it('stops with a plain message instead of carrying on in a different browser, and resumes when it is back', async () => {
    const r = rig({ connected: ['chrome', 'edge'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://a.example/' }]);
    await r.manager.openWebsite('https://a.example/');
    r.bridge.connected.delete('chrome');
    for (const act of [() => r.manager.inspectPage(), () => r.manager.clickOnPage('x'), () => r.manager.fillOnPage('a', 'b'), () => r.manager.goBack(), () => r.manager.scroll('down')]) {
      const err = await caught(act());
      expect(err.detail.why).toBe('lost_connection');
      expect(err.message).toMatch(/instead of carrying on in a different browser/);
    }
    expect(r.calls).toEqual(['chrome:open:https://a.example/']); // Edge was connected the whole time and was never touched
    r.bridge.connected.add('chrome');
    expect((await r.manager.inspectPage()).environment).toBe('your_browser');
  });
});

describe('working without having opened anything first', () => {
  it('looks at what the user is looking at: the browser in use', async () => {
    const r = rig({ connected: ['chrome', 'edge'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://a.example/' }]);
    r.setTabs('edge', [{ tabId: 1, url: 'https://b.example/', active: true }], true);
    await r.manager.inspectPage();
    expect(r.calls).toEqual(['edge:inspect']);
  });

  it('with nothing connected it explains, rather than opening anything', async () => {
    const r = rig({ knocking: ['edge'] });
    const err = await caught(r.manager.inspectPage());
    expect(err.detail).toMatchObject({ why: 'needs_pairing', needsPairing: ['edge'] });
    expect((await caught(rig({}).manager.inspectPage())).detail.why).toBe('not_connected');
  });
});

describe('noticing what the user did themselves', () => {
  it('says so when the user changed something since Eya\'s last step — but not for Eya\'s own moves', async () => {
    const r = rig({ connected: ['chrome'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://a.example/', active: true }], true);
    await r.manager.openWebsite('https://a.example/');
    r.clock.now += 2000;
    r.world.onEvent({ browser: 'chrome', name: 'tab_updated', data: { tab: { tabId: 1, windowId: 1, url: 'https://a.example/by-eya', title: 'x' }, byEya: true } });
    expect((await r.manager.inspectPage()).notes ?? []).toEqual([]);

    r.clock.now += 2000;
    r.world.onEvent({ browser: 'chrome', name: 'tab_updated', data: { tab: { tabId: 1, windowId: 1, url: 'https://a.example/clicked-by-user', title: 'y' } } });
    const noted = await r.manager.inspectPage();
    expect(noted.notes?.join(' ')).toMatch(/The user changed something in the browser since Eya's last step/);
    r.clock.now += 2000;
    expect((await r.manager.inspectPage()).notes ?? []).toEqual([]); // said once
  });

  it('also on actions: the result of a click carries the note', async () => {
    const r = rig({ connected: ['chrome'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://a.example/' }]);
    await r.manager.openWebsite('https://a.example/');
    r.clock.now += 3000;
    r.world.onEvent({ browser: 'chrome', name: 'tab_activated', data: { tabId: 1, windowId: 1 } });
    const click = await r.manager.clickOnPage('Go');
    expect(click.snapshot.notes?.join(' ')).toMatch(/user changed something/);
  });
});

describe('web search lookups', () => {
  it('use the user\'s browser when there is one; a failure there falls back to the invisible lookup', async () => {
    const r = rig({ connected: ['chrome'], withLookup: true });
    await r.manager.searchWeb('q');
    expect(r.calls).toEqual(['chrome:search']);
  });

  it('with no browser connected they use the invisible lookup — never Eya\'s visible window, never launching a browser', async () => {
    const r = rig({ withLookup: true, installed: ['chrome'] });
    await r.manager.searchWeb('q');
    expect(r.calls).toEqual(['lookup:searchWeb']);
    expect(r.launched).toEqual([]);
  });

  it('and with no lookup available either, say there is no browser rather than opening one', async () => {
    const r = rig({});
    await caught(r.manager.searchWeb('q'));
    expect(r.calls).toEqual([]);
  });
});

describe('tabs across both browsers', () => {
  it('lists every connected browser\'s tabs with the browser each is in', async () => {
    const r = rig({ connected: ['chrome', 'edge'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://a.example/' }]);
    r.setTabs('edge', [{ tabId: 1, url: 'https://b.example/' }, { tabId: 2, url: 'https://c.example/' }]);
    const tabs = await r.manager.listTabs();
    expect(tabs.map((t) => `${t.browser}:${t.tabId}`)).toEqual(['chrome:1', 'edge:1', 'edge:2']);
    expect((await r.manager.listTabs('edge')).map((t) => t.browser)).toEqual(['edge', 'edge']);
    await caught(rig({ connected: ['chrome'] }).manager.listTabs('edge'));
  });

  it('switching needs the browser when the tab number could be in either, and then works in that browser', async () => {
    const r = rig({ connected: ['chrome', 'edge'] });
    r.setTabs('chrome', [{ tabId: 7, url: 'https://a.example/' }]);
    r.setTabs('edge', [{ tabId: 7, url: 'https://b.example/' }, { tabId: 9, url: 'https://c.example/' }]);
    await expect(r.manager.switchToTab(7)).rejects.toThrow(/say which browser/);
    const s = await r.manager.switchToTab(7, 'edge');
    expect(r.calls).toContain('edge:switch:7');
    expect(s.environment).toBe('your_browser');
    expect(r.manager.pinnedBrowser()).toBe('edge');
    await r.manager.switchToTab(9); // only Edge has tab 9: no need to ask
    expect(r.calls).toContain('edge:switch:9');
  });

  it('closing passes along whether the user agreed to closing one of theirs', async () => {
    const r = rig({ connected: ['chrome'] });
    r.setTabs('chrome', [{ tabId: 3, url: 'https://a.example/' }]);
    await r.manager.closeTab(3);
    await r.manager.closeTab(3, { allowUserTab: true });
    expect(r.calls).toEqual(['chrome:close:3:undefined', 'chrome:close:3:true']);
  });
});

describe('describing the situation', () => {
  it('says which browsers are connected, which is in use, what is waiting to pair and where Eya is working', async () => {
    const r = rig({ connected: ['chrome'], knocking: ['edge'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://a.example/', active: true }, { tabId: 2, url: 'https://b.example/' }], true);
    await r.manager.openWebsite('https://a.example/');
    const d = r.manager.describe();
    expect(d.mode).toBe('user_browser');
    expect(d.browsers).toEqual([
      { browser: 'chrome', connected: true, paired: true, tabs: 2, inUse: true },
      { browser: 'edge', connected: false, paired: false },
    ]);
    expect(d.waitingToPair).toEqual(['edge']);
    expect(d.workingIn).toBe('your_browser');
    expect(d.workingBrowser).toBe('chrome');
  });
});

describe('waiting while the user signs in, then carrying on', () => {
  const login = snap('Sign in', { url: 'https://x.example/login', challenge: { kind: 'login', hint: 'sign in' } });
  const account = snap('My account', { url: 'https://x.example/account' });

  it('returns the page as it now is once the sign-in page is gone, saying what was cleared', async () => {
    const r = rig({ connected: ['chrome'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://x.example/login' }]);
    await r.manager.openWebsite('https://x.example/login');
    r.inspectQueue.set('chrome', [login, login, login, account]);
    const result = await r.manager.waitForUserChange(30_000);
    expect(result.changed).toBe(true);
    expect(result.cleared).toBe('login');
    expect(result.snapshot.title).toBe('My account');
    expect(result.snapshot.environment).toBe('your_browser');
  });

  it("is woken by the user's own activity in the browser instead of sleeping out the whole interval", async () => {
    // The only sleep that ever finishes is the half-second settle; the polling interval would take forever.
    const r = rig({ connected: ['chrome'], sleep: (ms) => (ms === 500 ? Promise.resolve() : new Promise<void>(() => undefined)) });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://x.example/login' }]);
    await r.manager.openWebsite('https://x.example/login');
    r.inspectQueue.set('chrome', [login, account]);
    const waiting = r.manager.waitForUserChange(30_000);
    await new Promise((resolve) => setTimeout(resolve, 20)); // let it start looking and start listening
    r.world.onEvent({ browser: 'chrome', name: 'tab_updated', data: { tab: { tabId: 1, windowId: 1, url: 'https://x.example/account', title: 'My account' } } });
    const result = await waiting;
    expect(result.changed).toBe(true);
    expect(result.snapshot.title).toBe('My account');
  });

  it('gives up after the time allowed and says nothing changed', async () => {
    const r = rig({ connected: ['chrome'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://x.example/login' }]);
    await r.manager.openWebsite('https://x.example/login');
    r.inspectQueue.set('chrome', [login]);
    const result = await r.manager.waitForUserChange(5000);
    expect(result.changed).toBe(false);
    expect(result.snapshot.challenge?.kind).toBe('login');
  });

  it('notices a page that simply moved on (no sign-in wall involved)', async () => {
    const r = rig({ connected: ['chrome'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://x.example/' }]);
    await r.manager.openWebsite('https://x.example/');
    r.inspectQueue.set('chrome', [snap('Before'), snap('After')]);
    const result = await r.manager.waitForUserChange(10_000);
    expect(result.changed).toBe(true);
    expect(result.cleared).toBeUndefined();
  });
});

describe('closing', () => {
  it('closes the separate windows it owns', async () => {
    const closed: string[] = [];
    const r = rig({ connected: ['chrome'] });
    void r;
    const manager = new BrowserSessionManager({
      bridge: r.bridge,
      world: r.world,
      isolated: { close: async () => void closed.push('isolated') } as unknown as BrowserAutomationService,
      lookup: { close: async () => void closed.push('lookup') } as unknown as BrowserAutomationService,
      launcher: { installed: async () => [], running: async () => [], launch: async () => false },
      mode: 'user_browser',
    });
    await manager.close();
    expect(closed.sort()).toEqual(['isolated', 'lookup']);
  });
});

describe('an extension that needs a reload (installed, on, but the old version)', () => {
  it('says so precisely — reload it, do not install it again — instead of the vague "not connected"', async () => {
    const r = rig({ knocking: ['edge'], outdated: ['edge'], running: ['edge'], installed: ['edge'] });
    const err = await caught(r.manager.openWebsite('https://tshc.gov.in/'));
    expect(err.detail.why).toBe('needs_reload');
    expect(err.detail.needsPairing).toEqual(['edge']);
    expect(err.message).toMatch(/OLD version/);
    expect(err.message).toMatch(/edge:\/\/extensions/);
    expect(err.message).toMatch(/reload/i);
    expect(err.message).toMatch(/Do not tell them to install it again/);
    expect(r.launched).toEqual([]);
    expect(r.calls.some((c) => c.startsWith('isolated'))).toBe(false); // and never a separate window
  });

  it('a plain not-yet-paired extension is still reported as needing pairing, not a reload', async () => {
    const r = rig({ knocking: ['chrome'], running: ['chrome'], installed: ['chrome'] });
    const err = await caught(r.manager.openWebsite('https://x.example/'));
    expect(err.detail.why).toBe('needs_pairing');
  });

  it('another of the user\'s own browsers that is already set up carries on: Edge is outdated, Chrome is paired and closed -> Chrome is started and used, and the result says so', async () => {
    const r = rig({ knocking: ['edge'], outdated: ['edge'], paired: ['chrome'], running: ['edge'], installed: ['chrome', 'edge'], startedBrowserConnects: true });
    const snapshot = await r.manager.openWebsite('https://tshc.gov.in/');
    expect(r.launched).toEqual([['chrome', 'https://tshc.gov.in/']]);
    expect(r.calls).toContain('chrome:open:https://tshc.gov.in/');
    expect(r.calls.some((c) => c.startsWith('edge:'))).toBe(false);
    expect(r.calls.some((c) => c.startsWith('isolated'))).toBe(false);
    const notes = (snapshot.notes ?? []).join(' ');
    expect(notes).toMatch(/Edge is the old version and needs a reload/);
    expect(notes).toMatch(/opened in the user's Chrome instead/);
    expect(snapshot.environment).toBe('your_browser');
    expect(r.manager.pinnedBrowser()).toBe('chrome');
  });

  it('the same for an Edge that merely is not paired yet: a paired Chrome is used, and the note says "not connected yet"', async () => {
    const r = rig({ knocking: ['edge'], paired: ['chrome'], installed: ['chrome', 'edge'], running: ['edge'], startedBrowserConnects: true });
    const snapshot = await r.manager.openWebsite('https://x.example/');
    expect((snapshot.notes ?? []).join(' ')).toMatch(/Edge is not connected yet/);
    expect(r.launched.map((l) => l[0])).toEqual(['chrome']);
  });

  it('if the other browser does not come up either, it stops with the precise reload message — still no separate window', async () => {
    const r = rig({ knocking: ['edge'], outdated: ['edge'], paired: ['chrome'], installed: ['chrome', 'edge'], running: ['edge'], startedBrowserConnects: false });
    const err = await caught(r.manager.openWebsite('https://x.example/'));
    expect(err.detail.why).toBe('needs_reload');
    expect(r.calls.some((c) => c.startsWith('isolated'))).toBe(false);
  });

  it('never switches to a browser that is not installed, or that is not paired', async () => {
    const notInstalled = rig({ knocking: ['edge'], outdated: ['edge'], paired: ['chrome'], installed: ['edge'], running: ['edge'], startedBrowserConnects: true });
    expect((await caught(notInstalled.manager.openWebsite('https://x.example/'))).detail.why).toBe('needs_reload');
    expect(notInstalled.launched).toEqual([]);

    const notPaired = rig({ knocking: ['edge'], outdated: ['edge'], installed: ['chrome', 'edge'], running: ['edge'], startedBrowserConnects: true });
    expect((await caught(notPaired.manager.openWebsite('https://x.example/'))).detail.why).toBe('needs_reload');
    expect(notPaired.launched).toEqual([]);
  });

  it('a connected browser is always used as before — the fallback only exists for when none is', async () => {
    const r = rig({ connected: ['chrome'], knocking: ['edge'], outdated: ['edge'], paired: ['chrome'], installed: ['chrome', 'edge'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://x.example/' }]);
    const snapshot = await r.manager.openWebsite('https://x.example/');
    expect(r.launched).toEqual([]);
    expect((snapshot.notes ?? []).join(' ')).not.toMatch(/instead/);
  });

  it('describe() lists which extensions need a reload', () => {
    const r = rig({ knocking: ['edge'], outdated: ['edge'] });
    expect(r.manager.describe()).toMatchObject({ waitingToPair: ['edge'], outdated: ['edge'] });
  });

  it('continuing work with nothing connected and an outdated extension also says needs-reload', async () => {
    const r = rig({ knocking: ['edge'], outdated: ['edge'] });
    const err = await caught(r.manager.inspectPage());
    expect(err.detail.why).toBe('needs_reload');
  });
});

describe('taking a screenshot of the page that is open', () => {
  it('photographs the tab in front in the connected browser, even though Eya never opened a page', async () => {
    const r = rig({ connected: ['chrome'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://user-opened.example/' }]);
    const image = await r.manager.screenshot();
    expect(r.calls).toEqual(['chrome:screenshot']);
    expect(image).toMatchObject({ browser: 'chrome', environment: 'your_browser' });
  });

  it('with Chrome and Edge both connected, it is the browser the user is in (the focused window), not a guess', async () => {
    const r = rig({ connected: ['chrome', 'edge'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://a.example/' }], false);
    r.setTabs('edge', [{ tabId: 1, url: 'https://b.example/' }], true);
    expect((await r.manager.screenshot()).browser).toBe('edge');
    expect(r.calls).toEqual(['edge:screenshot']);
  });

  it('when only one browser is connected it is that one, whichever the user last touched', async () => {
    const r = rig({ connected: ['edge'] });
    r.setTabs('edge', [{ tabId: 1, url: 'https://b.example/' }]);
    expect((await r.manager.screenshot()).browser).toBe('edge');
  });

  it('after Eya opened a site, the picture is of that browser', async () => {
    const r = rig({ connected: ['chrome', 'edge'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://tshc.gov.in/' }], true);
    r.setTabs('edge', [{ tabId: 1, url: 'https://other.example/' }], false);
    await r.manager.openWebsite('https://tshc.gov.in/');
    r.calls.length = 0;
    expect((await r.manager.screenshot()).browser).toBe('chrome');
  });

  it('with no browser connected it says why — the same reasons as everything else — and never reaches for another window', async () => {
    const r = rig({ knocking: ['edge'], outdated: ['edge'] });
    const err = await caught(r.manager.screenshot());
    expect(err.detail.why).toBe('needs_reload');
    const none = rig();
    expect((await caught(none.manager.screenshot())).detail.why).toBe('not_connected');
    expect(r.calls.concat(none.calls)).toEqual([]);
  });

  it('if the task is in Eya\'s own separate window (the user agreed to that), that window is the one photographed', async () => {
    const r = rig({ connected: ['chrome'] });
    await r.manager.openWebsite('https://x.example/', { isolated: true });
    r.calls.length = 0;
    const image = await r.manager.screenshot();
    expect(r.calls).toEqual(['isolated:screenshot']);
    expect(image.environment).toBe('eya_browser');
  });

  it('mode eya_browser photographs Eya\'s own window, as every other action does in that mode', async () => {
    const r = rig({ mode: 'eya_browser' });
    expect((await r.manager.screenshot()).environment).toBe('eya_browser');
  });

  it('a connection that cannot take pictures says so instead of failing strangely', async () => {
    const r = rig({ connected: ['chrome'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://x.example/' }]);
    const bare = new BrowserSessionManager({
      bridge: r.bridge,
      world: r.world,
      isolated: { close: async () => undefined } as unknown as BrowserAutomationService,
      launcher: { installed: async () => [], running: async () => [], launch: async () => false },
      mode: 'user_browser',
      createService: () => ({ close: async () => undefined }) as unknown as UserBrowser,
    });
    await expect(bare.screenshot()).rejects.toThrow(/not available/);
  });
});

describe('Communication Access: chat apps are neither read nor acted in unless the user switched it on', () => {
  const WA = 'https://web.whatsapp.com/';
  const ON: CommunicationSettings = { enabled: true, apps: {} };
  const policyOf = (s: CommunicationSettings) => new CommunicationPolicy(() => s);

  /** A task already in Chrome, with the chat in front. */
  async function inChat(policy: CommunicationPolicy, opts: { shotUrl?: string } = {}) {
    const r = rig({ connected: ['chrome'], policy, ...(opts.shotUrl !== undefined ? { shotUrl: opts.shotUrl } : {}) });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://x.example/', active: true }], true);
    await r.manager.openWebsite('https://x.example/'); // pins the task to Chrome
    r.setTabs('chrome', [{ tabId: 1, url: WA, active: true, title: 'Rahul Sharma' }], true);
    r.inspectQueue.set('chrome', [snap('chat', { url: WA, title: 'Rahul Sharma', buttons: ['Send'] })]);
    return r;
  }

  async function refused(p: Promise<unknown>): Promise<CommunicationAccessError> {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(CommunicationAccessError);
      expect(e).toBeInstanceOf(BrowserUnavailableError); // so every existing catch site still handles it
      return e as CommunicationAccessError;
    }
    throw new Error('expected it to be refused');
  }

  it('OFF: nothing is read, clicked or typed in a chat, and the page is never even asked', async () => {
    const r = await inChat(policyOf(COMMUNICATION_OFF));
    r.calls.length = 0;
    const err = await refused(r.manager.inspectPage());
    expect(err.app).toBe('WhatsApp');
    expect(err.detail.why).toBe('communication_access_off');
    await refused(r.manager.findOnPage('Rahul'));
    await refused(r.manager.readPage());
    await refused(r.manager.clickOnPage('Send'));
    await refused(r.manager.fillOnPage('Type a message', 'hello'));
    await refused(r.manager.scroll('down'));
    await refused(r.manager.goBack());
    await refused(r.manager.reload());
    await refused(r.manager.waitForUserChange(50));
    expect(r.calls).toEqual([]); // not one call reached the browser
  });

  it('OFF: opening the chat for the user is fine, but what comes back is only that it is open', async () => {
    const r = rig({ connected: ['chrome'], policy: policyOf(COMMUNICATION_OFF) });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://x.example/', active: true }], true);
    const s = await r.manager.openWebsite(WA);
    expect(s.url).toBe('https://web.whatsapp.com');
    expect(s.title).toBe('WhatsApp');
    expect(s.buttons).toEqual([]);
    expect(s.links).toEqual([]);
    expect(s.inputs).toEqual([]);
    expect(s.notes?.join(' ')).toMatch(/Communication Access is OFF/i);
  });

  it('OFF: a page that turns out to be a chat after a click is redacted, and the next step is refused', async () => {
    const r = rig({ connected: ['chrome'], policy: policyOf(COMMUNICATION_OFF) });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://x.example/', active: true }], true);
    await r.manager.openWebsite('https://x.example/');
    const svc = (r.manager as unknown as { service(b: BrowserName): UserBrowser }).service('chrome');
    svc.clickOnPage = async () => ({ ok: true as const, snapshot: snap('chat', { url: WA, title: 'Rahul Sharma', buttons: ['Call'] }) });
    const result = await r.manager.clickOnPage('Open WhatsApp');
    expect(result.snapshot.title).toBe('WhatsApp');
    expect(result.snapshot.buttons).toEqual([]);
    r.setTabs('chrome', [{ tabId: 1, url: WA, active: true }], true);
    await refused(r.manager.inspectPage());
  });

  it('OFF: the list of tabs says which app it is, never the contact name or the conversation address', async () => {
    const r = await inChat(policyOf(COMMUNICATION_OFF));
    r.setTabs('chrome', [{ tabId: 1, url: `${WA}send?phone=919876543210`, active: true, title: '(2) Rahul Sharma' }, { tabId: 2, url: 'https://news.example/a', title: 'Headlines' }], true);
    const tabs = await r.manager.listTabs();
    expect(tabs.find((t) => t.tabId === 1)).toMatchObject({ title: 'WhatsApp', url: 'https://web.whatsapp.com' });
    expect(JSON.stringify(tabs)).not.toMatch(/Rahul|919876543210/);
    expect(tabs.find((t) => t.tabId === 2)).toMatchObject({ title: 'Headlines', url: 'https://news.example/a' });
  });

  it('ON: the tab list still shows only the app (a contact name is private even when access is on)', async () => {
    const r = await inChat(policyOf(ON));
    r.setTabs('chrome', [{ tabId: 1, url: `${WA}send?phone=919876543210`, active: true, title: '(2) Rahul Sharma' }], true);
    const tabs = await r.manager.listTabs();
    expect(JSON.stringify(tabs)).not.toMatch(/Rahul|919876543210/);
  });

  it('ON: the chat is read and acted in like any other page', async () => {
    const r = await inChat(policyOf(ON));
    r.calls.length = 0;
    const s = await r.manager.inspectPage();
    expect(s.title).toBe('Rahul Sharma');
    await r.manager.clickOnPage('Send');
    expect(r.calls).toEqual(['chrome:inspect', 'chrome:click:Send']);
  });

  it('turning it OFF mid-task takes effect on the very next step', async () => {
    let current: CommunicationSettings = ON;
    const r = await inChat(new CommunicationPolicy(() => current));
    await r.manager.inspectPage();
    current = COMMUNICATION_OFF;
    r.calls.length = 0;
    await refused(r.manager.clickOnPage('Send'));
    expect(r.calls).toEqual([]);
  });

  it('only an excluded app is refused when the master switch is on', async () => {
    const r = rig({ connected: ['chrome'], policy: policyOf({ enabled: true, apps: { instagram: false } }) });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://x.example/', active: true }], true);
    await r.manager.openWebsite('https://x.example/');
    r.setTabs('chrome', [{ tabId: 1, url: 'https://www.instagram.com/direct/inbox/', active: true }], true);
    expect((await refused(r.manager.inspectPage())).app).toBe('Instagram');
    r.setTabs('chrome', [{ tabId: 1, url: WA, active: true }], true);
    await expect(r.manager.inspectPage()).resolves.toBeDefined();
  });

  it('other sites are never affected, whatever the setting', async () => {
    const r = rig({ connected: ['chrome'], policy: policyOf(COMMUNICATION_OFF) });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://tshc.gov.in/', active: true }], true);
    await r.manager.openWebsite('https://tshc.gov.in/');
    await expect(r.manager.inspectPage()).resolves.toBeDefined();
    await expect(r.manager.screenshot()).resolves.toBeDefined();
  });

  it('OFF: no picture is taken of a chat (no request is even made), and one that turns out to be a chat is dropped', async () => {
    const r = await inChat(policyOf(COMMUNICATION_OFF));
    r.calls.length = 0;
    await refused(r.manager.screenshot());
    expect(r.calls).toEqual([]);

    const late = rig({ connected: ['chrome'], policy: policyOf(COMMUNICATION_OFF), shotUrl: WA });
    late.setTabs('chrome', [{ tabId: 1, url: 'https://x.example/', active: true }], true); // looked harmless when asked
    await refused(late.manager.screenshot());
  });

  it('ON: the picture is taken', async () => {
    const r = await inChat(policyOf(ON), { shotUrl: WA });
    await expect(r.manager.screenshot()).resolves.toMatchObject({ browser: 'chrome' });
  });

  it('without a policy at all (older callers) nothing changes', async () => {
    const r = rig({ connected: ['chrome'] });
    r.setTabs('chrome', [{ tabId: 1, url: WA, active: true }], true);
    await r.manager.openWebsite(WA);
    await expect(r.manager.inspectPage()).resolves.toBeDefined();
  });
});

describe('listing the page and attaching a file go through the same Communication Access check as everything else', () => {
  const WA = 'https://web.whatsapp.com/';
  const policyOf = (s: CommunicationSettings) => new CommunicationPolicy(() => s);
  const request = { name: 'report.pdf', mime: 'application/pdf', size: 3, read: async () => Buffer.from('abc') };

  async function inChat(settings: CommunicationSettings) {
    const r = rig({ connected: ['chrome'], policy: policyOf(settings) });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://x.example/', active: true }], true);
    await r.manager.openWebsite('https://x.example/'); // pins the task to Chrome
    r.setTabs('chrome', [{ tabId: 1, url: WA, active: true }], true);
    r.calls.length = 0;
    return r;
  }

  it('OFF: neither is done, and nothing reaches the browser', async () => {
    const r = await inChat(COMMUNICATION_OFF);
    await expect(r.manager.listItems()).rejects.toBeInstanceOf(CommunicationAccessError);
    await expect(r.manager.attachFile(request)).rejects.toBeInstanceOf(CommunicationAccessError);
    expect(r.calls).toEqual([]);
  });

  it('ON: the page is listed, and a file is attached (and the page that comes back is stamped as the user\'s browser)', async () => {
    const r = await inChat({ enabled: true, apps: {} });
    expect(await r.manager.listItems()).toEqual([{ name: 'Rahul Sharma ok', primary: 'Rahul Sharma', role: 'clickable' }]);
    const attached = await r.manager.attachFile(request);
    expect(attached.ok).toBe(true);
    expect(attached.ok && attached.snapshot.environment).toBe('your_browser');
    expect(r.calls).toEqual(['chrome:items', 'chrome:attach:report.pdf']);
  });

  it('with no policy (older callers) nothing changes', async () => {
    const r = rig({ connected: ['chrome'] });
    r.setTabs('chrome', [{ tabId: 1, url: WA, active: true }], true);
    await r.manager.openWebsite(WA);
    await expect(r.manager.listItems()).resolves.toHaveLength(1);
  });

  it('a window of Eya\'s own (not the user\'s browser) cannot attach files, and says so', async () => {
    const r = rig({ mode: 'eya_browser' });
    const result = await r.manager.attachFile(request);
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
  });
});

describe('opening a site in the browser the user NAMED', () => {
  it('uses that browser even when the other one holds the session, and never the other', async () => {
    const r = rig({ connected: ['chrome', 'edge'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://mysite.example/dashboard', active: true }], true);
    r.setTabs('edge', [{ tabId: 1, url: 'https://other.example/' }]);
    const s = await r.manager.openWebsite('https://mysite.example/', { browser: 'edge' });
    expect(r.calls).toEqual(['edge:open:https://mysite.example/']);
    expect(s.notes).toContain("Opened in the user's Edge.");
    expect(r.manager.pinnedBrowser()).toBe('edge');
    expect(r.launched).toEqual([]);
  });

  it('starts it if it is installed but not running, and uses it once its extension connects', async () => {
    const r = rig({ connected: ['chrome'], installed: ['chrome', 'edge'], running: ['chrome'], startedBrowserConnects: true });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://x.example/', active: true }], true);
    await r.manager.openWebsite('https://web.whatsapp.com/', { browser: 'edge' });
    expect(r.launched).toEqual([['edge', 'https://web.whatsapp.com/']]);
    expect(r.calls).toEqual(['edge:open:https://web.whatsapp.com/']);
  });

  it('wakes it if it is running and its extension is just asleep', async () => {
    const r = rig({ connected: ['chrome'], installed: ['chrome', 'edge'], running: ['chrome', 'edge'] });
    r.bridge.connectsOnWait.add('edge');
    await r.manager.openWebsite('https://web.whatsapp.com/', { browser: 'edge' });
    expect(r.launched).toEqual([]);
    expect(r.calls).toEqual(['edge:open:https://web.whatsapp.com/']);
  });

  it('says so when that browser is not on the PC, and opens nothing anywhere else', async () => {
    const r = rig({ connected: ['chrome'], installed: ['chrome'], running: ['chrome'] });
    const err = await caught(r.manager.openWebsite('https://x.example/', { browser: 'edge' }));
    expect(err.detail.why).toBe('no_browser');
    expect(err.message).toMatch(/Edge could not be found/);
    expect(r.calls).toEqual([]);
    expect(r.launched).toEqual([]);
  });

  it('says its extension needs pairing (or a reload) rather than quietly using the other browser', async () => {
    const r = rig({ connected: ['chrome'], knocking: ['edge'], installed: ['chrome', 'edge'], running: ['chrome', 'edge'] });
    const err = await caught(r.manager.openWebsite('https://x.example/', { browser: 'edge' }));
    expect(err.detail.why).toBe('needs_pairing');
    const old = rig({ connected: ['chrome'], knocking: ['edge'], outdated: ['edge'], installed: ['chrome', 'edge'], running: ['chrome', 'edge'] });
    expect((await caught(old.manager.openWebsite('https://x.example/', { browser: 'edge' }))).detail.why).toBe('needs_reload');
    expect(r.calls.concat(old.calls)).toEqual([]);
  });

  it('even in auto mode, a named browser that is unavailable is not swapped for Eya\'s own window', async () => {
    const r = rig({ mode: 'auto', connected: [], installed: ['chrome'], running: [] });
    await caught(r.manager.openWebsite('https://x.example/', { browser: 'edge' }));
    expect(r.calls.some((c) => c.startsWith('isolated'))).toBe(false);
  });

  it('without a named browser, nothing changes: the one that already has the site', async () => {
    const r = rig({ connected: ['chrome', 'edge'] });
    r.setTabs('chrome', [{ tabId: 1, url: 'https://news.example/' }]);
    r.setTabs('edge', [{ tabId: 1, url: 'https://mysite.example/dashboard' }]);
    await r.manager.openWebsite('https://mysite.example/');
    expect(r.calls).toEqual(['edge:open:https://mysite.example/']);
  });
});
