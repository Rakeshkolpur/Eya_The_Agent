import { describe, it, expect, beforeEach } from 'vitest';
import { BrowserWorldTracker } from '../src/main/chrome/browserWorld';
import type { UserActivity } from '../src/main/chrome/browserWorld';
import type { BridgeBrowserEvent, BridgeConnectionEvent } from '../src/main/chrome/ChromeBridge';
import type { BrowserName, WireHello, WireTab } from '../src/main/chrome/protocol';

let clock = 1000;
let world: BrowserWorldTracker;

const tab = (tabId: number, url: string, over: Partial<WireTab> = {}): WireTab => ({ tabId, windowId: 1, title: `T${tabId}`, url, active: false, pinned: false, loading: false, ...over });

function helloFor(browser: BrowserName, tabs: WireTab[], extra: Partial<WireHello> = {}): WireHello {
  return {
    t: 'hello',
    ext: 'x',
    protocolVersion: 2,
    extensionVersion: '0.2.0',
    browser,
    browserVersion: '154',
    capabilities: [],
    tabs,
    windows: [{ windowId: 1, focused: false, tabCount: tabs.length }],
    ...extra,
  };
}

const connect = (browser: BrowserName, tabs: WireTab[], extra: Partial<WireHello> = {}) =>
  world.onConnection({ browser, connected: true, hello: helloFor(browser, tabs, extra) } satisfies BridgeConnectionEvent);

const event = (browser: BrowserName, name: string, data: Record<string, unknown> = {}) => world.onEvent({ browser, name, data } satisfies BridgeBrowserEvent);

beforeEach(() => {
  clock = 1000;
  world = new BrowserWorldTracker(() => clock);
});

describe('handshake and independent state per browser', () => {
  it('starts each browser\'s picture from its handshake, and never merges Chrome and Edge', () => {
    connect('chrome', [tab(1, 'https://mail.example/', { active: true }), tab(2, 'https://docs.example/')], { activeTabId: 1, windows: [{ windowId: 1, focused: true, tabCount: 2 }] });
    connect('edge', [tab(1, 'https://news.example/'), tab(2, 'https://shop.example/'), tab(3, 'https://bank.example/')]);
    expect(world.state('chrome')).toMatchObject({ connected: true, tabs: expect.any(Array), activeTabId: 1, focusedWindowId: 1, extensionVersion: '0.2.0' });
    expect(world.tabsOf('chrome')).toHaveLength(2);
    expect(world.tabsOf('edge')).toHaveLength(3);
    // the same tab number in two browsers is two different tabs
    expect(world.tabsOf('chrome').find((t) => t.tabId === 1)?.url).toBe('https://mail.example/');
    expect(world.tabsOf('edge').find((t) => t.tabId === 1)?.url).toBe('https://news.example/');
  });

  it('a disconnect marks the browser gone but a new handshake replaces its picture wholesale', () => {
    connect('chrome', [tab(1, 'https://a.example/')]);
    world.onConnection({ browser: 'chrome', connected: false });
    expect(world.state('chrome')?.connected).toBe(false);
    expect(world.activeBrowser()).toBeNull();
    connect('chrome', [tab(7, 'https://b.example/')]);
    expect(world.tabsOf('chrome').map((t) => t.tabId)).toEqual([7]);
  });
});

describe('live events keep the picture current', () => {
  beforeEach(() => connect('chrome', [tab(1, 'https://a.example/', { active: true })], { activeTabId: 1 }));

  it('tabs opening, changing and closing', () => {
    event('chrome', 'tab_created', { tab: tab(2, 'https://b.example/') });
    expect(world.tabsOf('chrome')).toHaveLength(2);
    event('chrome', 'tab_updated', { tab: tab(2, 'https://b.example/page', { title: 'Page' }) });
    expect(world.tabsOf('chrome').find((t) => t.tabId === 2)).toMatchObject({ url: 'https://b.example/page', title: 'Page' });
    event('chrome', 'tab_removed', { tabId: 2, windowId: 1 });
    expect(world.tabsOf('chrome').map((t) => t.tabId)).toEqual([1]);
  });

  it('switching tabs moves which is in front, within its window only', () => {
    event('chrome', 'tab_created', { tab: tab(2, 'https://b.example/') });
    event('chrome', 'window_focused', { windowId: 1 });
    event('chrome', 'tab_activated', { tabId: 2, windowId: 1 });
    expect(world.state('chrome')?.activeTabId).toBe(2);
    expect(world.tabsOf('chrome').find((t) => t.tabId === 1)?.active).toBe(false);
    expect(world.tabsOf('chrome').find((t) => t.tabId === 2)?.active).toBe(true);
  });

  it('loading state follows navigation events', () => {
    event('chrome', 'navigation_started', { tabId: 1 });
    expect(world.tabsOf('chrome')[0]?.loading).toBe(true);
    event('chrome', 'navigation_completed', { tabId: 1 });
    expect(world.tabsOf('chrome')[0]?.loading).toBe(false);
  });

  it('a closed window takes its tabs with it; the browser losing focus clears the front window', () => {
    event('chrome', 'tab_created', { tab: tab(5, 'https://c.example/', { windowId: 2 }) });
    event('chrome', 'window_focused', { windowId: 2 });
    expect(world.state('chrome')?.focusedWindowId).toBe(2);
    event('chrome', 'window_focused', { windowId: -1 });
    expect(world.state('chrome')?.focusedWindowId).toBeUndefined();
    event('chrome', 'window_removed', { windowId: 2 });
    expect(world.tabsOf('chrome').map((t) => t.tabId)).toEqual([1]);
  });

  it('records a download, and shrugs off junk events', () => {
    event('chrome', 'download_created', { id: 3 });
    expect(world.state('chrome')?.lastDownloadAt).toBe(1000);
    event('chrome', 'tab_created', { tab: 'junk' });
    event('chrome', 'tab_removed', { tabId: 'x' });
    event('chrome', 'something_new', {});
    expect(world.tabsOf('chrome')).toHaveLength(1);
  });
});

describe('which browser is in use', () => {
  it('the one with a window in front wins; failing that, the one used most recently', () => {
    connect('chrome', [tab(1, 'https://a.example/')]);
    connect('edge', [tab(1, 'https://b.example/')]);
    clock = 2000;
    event('edge', 'window_focused', { windowId: 1 });
    expect(world.activeBrowser()).toBe('edge');
    clock = 3000;
    event('chrome', 'window_focused', { windowId: 1 });
    expect(world.activeBrowser()).toBe('chrome');
    event('chrome', 'window_focused', { windowId: -1 }); // chrome goes to the background…
    event('edge', 'window_focused', { windowId: -1 });
    expect(world.activeBrowser()).toBe('chrome'); // …neither is in front, so the one touched last
  });

  it('a browser that is not connected is never "the active one"', () => {
    connect('chrome', [tab(1, 'https://a.example/')]);
    event('chrome', 'window_focused', { windowId: 1 });
    world.onConnection({ browser: 'chrome', connected: false });
    expect(world.activeBrowser()).toBeNull();
  });
});

describe('finding a site that is already open', () => {
  it('matches by site (www and path ignored), across all connected browsers only', () => {
    connect('chrome', [tab(1, 'https://www.shop.example/cart'), tab(2, 'https://other.example/')]);
    connect('edge', [tab(1, 'https://shop.example/'), tab(2, 'https://shop.example.evil.com/')]);
    const found = world.tabsOnSite('https://shop.example/orders');
    expect(found.map((t) => `${t.browser}:${t.tabId}`).sort()).toEqual(['chrome:1', 'edge:1']);
    expect(world.tabsOnSite('not a url')).toEqual([]);
    world.onConnection({ browser: 'edge', connected: false });
    expect(world.tabsOnSite('https://shop.example/').map((t) => t.browser)).toEqual(['chrome']);
  });
});

describe('telling the user\'s actions from Eya\'s own', () => {
  beforeEach(() => connect('chrome', [tab(1, 'https://a.example/', { active: true })]));

  it('records what the user did, not what Eya did', () => {
    event('chrome', 'tab_activated', { tabId: 1, windowId: 1, byEya: true });
    event('chrome', 'tab_updated', { tab: tab(1, 'https://a.example/next'), byEya: true });
    expect(world.userActivitySince('chrome', 0)).toEqual([]);
    clock = 2000;
    event('chrome', 'tab_updated', { tab: tab(1, 'https://a.example/by-the-user') });
    clock = 3000;
    event('chrome', 'tab_created', { tab: tab(9, 'https://z.example/') });
    expect(world.userActivitySince('chrome', 0).map((a) => a.kind)).toEqual(['tab_updated', 'tab_created']);
    expect(world.userActivitySince('chrome', 2500).map((a) => a.kind)).toEqual(['tab_created']);
    expect(world.userActivitySince('edge', 0)).toEqual([]);
  });

  it('a page merely finishing loading is not something the user did, and a repeated identical update is not a change', () => {
    event('chrome', 'tab_updated', { tab: tab(1, 'https://a.example/', { title: 'T1' }) });
    expect(world.userActivitySince('chrome', 0)).toEqual([]);
  });

  it('tells listeners as it happens', () => {
    const seen: UserActivity[] = [];
    const off = world.onUserActivity((a) => seen.push(a));
    event('chrome', 'tab_activated', { tabId: 1, windowId: 1 });
    off();
    event('chrome', 'tab_activated', { tabId: 1, windowId: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ browser: 'chrome', kind: 'tab_activated', tabId: 1 });
  });
});

describe('the summary the model sees', () => {
  it('names connected browsers, tab counts and the site in front — hosts only, never titles or query strings', () => {
    connect('chrome', [tab(1, 'https://mail.example/inbox?token=SECRET', { active: true, title: 'Private subject' }), tab(2, 'https://docs.example/')], {
      activeTabId: 1,
      windows: [{ windowId: 1, focused: true, tabCount: 2 }],
    });
    connect('edge', [tab(1, 'https://news.example/')]);
    const s = world.summary();
    expect(s).toContain('Chrome (the one in use): 2 tabs, in front: mail.example');
    expect(s).toContain('Edge: 1 tab');
    expect(s).not.toContain('Private subject');
    expect(s).not.toContain('SECRET');
  });

  it('is empty when nothing is connected', () => {
    expect(world.summary()).toBe('');
  });
});
