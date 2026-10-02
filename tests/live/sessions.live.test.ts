/**
 * Live test of the whole browser-session architecture, with REAL Chrome and REAL Edge running at the same time, the
 * real extension in both, one real bridge, and a local site that has a real cookie session.
 *
 * It checks the point of the design: Eya works inside the browser the user is already using — their tabs, their
 * sign-in — and never quietly opens a separate browser. The "user" is simulated by driving the browsers' debugging
 * ports directly (see liveSupport.ts): signing in, opening and closing tabs happen WITHOUT going through Eya.
 *
 *   A  already signed in, the page left open        → Eya uses that browser and that session; no second sign-in
 *   B  several tabs, one is the signed-in site       → Eya finds and focuses the right one, doesn't navigate it away
 *   C  browser open, the site's tab closed           → a NEW TAB in the same browser; the session still applies
 *   D  signed in in only one of two browsers         → the right browser is chosen for each site
 *   E  signed out; the user signs in during the task → Eya waits, then carries on with the original request
 *   +  the user changes the page mid-task            → Eya notices and reads the real page
 *   +  no browser open                               → the user's normal browser is started and used
 *   +  live tab state, scroll / reload / forward / closing tabs, nothing secret reaches Eya
 *
 * Opt-in: EYA_LIVE_BROWSER=1 npx vitest run tests/live/sessions.live.test.ts   (needs both Chrome and Edge installed)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { ChromeBridge } from '../../src/main/chrome/ChromeBridge';
import type { SecretStore } from '../../src/main/chrome/ChromeBridge';
import { BrowserWorldTracker } from '../../src/main/chrome/browserWorld';
import { BrowserSessionManager } from '../../src/main/browser/BrowserSessionManager';
import type { BrowserLauncher } from '../../src/main/browser/BrowserSessionManager';
import type { BrowserAutomationService } from '../../src/main/browser/BrowserAutomationService';
import type { BrowserName } from '../../src/main/chrome/protocol';
import { startTestSite } from '../fixtures/chrome-test-site/server.mjs';
import { SESSION_COOKIE_VALUE } from '../fixtures/chrome-test-site/auth.mjs';
import {
  findBrowserExe,
  prepareExtensionCopy,
  sleep,
  startTestBrowser,
  userCloseTab,
  userEval,
  userNavigate,
  userOpenTab,
  userTabUrls,
  waitFor,
} from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const bothInstalled = findBrowserExe('chrome') !== undefined && findBrowserExe('edge') !== undefined;

const BRIDGE_PORT_A = 47831;
const BRIDGE_PORT_B = 47832;
const CHROME_DEBUG = 9341;
const EDGE_DEBUG = 9342;
const LAUNCHED_DEBUG = 9343;
const PASSWORD_THE_USER_TYPES = 'hunter2-the-users-own-password';

class MemorySecrets implements SecretStore {
  hashes = new Map<BrowserName, string>();
  loadHash(b: BrowserName) {
    return this.hashes.get(b) ?? null;
  }
  saveHash(b: BrowserName, h: string) {
    this.hashes.set(b, h);
  }
  clear(b?: BrowserName) {
    if (b === undefined) this.hashes.clear();
    else this.hashes.delete(b);
  }
}

/** A stand-in for Eya's own separate browser window that fails the test the moment anything uses it. */
const forbiddenIsolatedBrowser = new Proxy(
  {},
  {
    get: (_t, prop) => (prop === 'close' ? async () => undefined : () => Promise.reject(new Error(`Eya's separate browser window must not be used (${String(prop)})`))),
  },
) as BrowserAutomationService;

describe.skipIf(!live || !bothInstalled)('browser sessions: the user\'s own Chrome and Edge, their tabs, their sign-in', () => {
  let site: { server: Server; port: number };
  let base = ''; // http://127.0.0.1:<port>   — Chrome's world
  let localhostBase = ''; // http://localhost:<port> — a different "website" as far as a browser's cookies are concerned
  let bridge: ChromeBridge;
  let world: BrowserWorldTracker;
  let manager: BrowserSessionManager;
  let chrome: TestBrowser;
  let edge: TestBrowser;
  let ext: { dir: string; cleanup: () => void };
  const seen: string[] = []; // everything Eya was ever shown, for the "no secrets" check
  const launched: Array<[string, string]> = [];
  const extras: Array<() => void> = [];

  const note = <T>(x: T): T => {
    seen.push(JSON.stringify(x));
    return x;
  };

  beforeAll(async () => {
    site = await startTestSite(0);
    base = `http://127.0.0.1:${site.port}`;
    localhostBase = `http://localhost:${site.port}`;
    ext = prepareExtensionCopy(BRIDGE_PORT_A);

    bridge = new ChromeBridge({ secrets: new MemorySecrets(), port: BRIDGE_PORT_A });
    if (!(await bridge.start())) throw new Error(`port ${BRIDGE_PORT_A} is busy`);
    world = new BrowserWorldTracker();
    world.attach(bridge);
    bridge.openPairingWindow(); // both browsers pair in this one window

    chrome = await startTestBrowser({ kind: 'chrome', extensionDir: ext.dir, debugPort: CHROME_DEBUG });
    edge = await startTestBrowser({ kind: 'edge', extensionDir: ext.dir, debugPort: EDGE_DEBUG });
    await waitFor(() => bridge.connectedBrowsers().length === 2, 60_000, 'both browsers\' extensions to connect');

    const noLauncher: BrowserLauncher = {
      installed: async () => ['chrome', 'edge'],
      running: async () => ['chrome', 'edge'],
      launch: async (browser, url) => {
        launched.push([browser, url]);
        return false;
      },
    };
    manager = new BrowserSessionManager({ bridge, world, isolated: forbiddenIsolatedBrowser, launcher: noLauncher, mode: 'user_browser' });
  }, 180_000);

  afterAll(async () => {
    for (const fn of extras.splice(0).reverse()) fn();
    chrome?.kill();
    edge?.kill();
    await bridge?.stop();
    site?.server.close();
    await sleep(800);
    chrome?.cleanup();
    edge?.cleanup();
    ext?.cleanup();
  }, 60_000);

  it('both browsers connect at once; each handshake says who it is, its version, what it can do and what is open', async () => {
    expect(bridge.connectedBrowsers()).toEqual(['chrome', 'edge']);
    const c = bridge.handshakeOf('chrome');
    const e = bridge.handshakeOf('edge');
    expect(c).toMatchObject({ browser: 'chrome', protocolVersion: 2, extensionVersion: '0.2.0' });
    expect(e).toMatchObject({ browser: 'edge', protocolVersion: 2, extensionVersion: '0.2.0' });
    expect(c?.browserVersion).toMatch(/^\d+\./);
    expect(c?.capabilities).toEqual(expect.arrayContaining(['observe', 'click', 'scroll', 'events', 'close_tab']));
    expect(world.state('chrome')?.connected).toBe(true);
    expect(world.state('edge')?.connected).toBe(true);
    const overview = manager.describe();
    expect(overview.browsers.map((b) => `${b.browser}:${b.connected}`)).toEqual(['chrome:true', 'edge:true']);
    expect(overview.mode).toBe('user_browser');
  });

  it('live state: a tab the user opens or closes in one browser shows up in Eya\'s picture of THAT browser, within moments', async () => {
    const before = world.tabsOf('edge').length;
    await userOpenTab(EDGE_DEBUG, `${localhostBase}/orders.html`);
    await waitFor(() => world.tabsOf('edge').length === before + 1, 8000, 'the new Edge tab to be noticed');
    // the browser announces a new tab a moment before it knows the address; the update follows
    await waitFor(() => world.tabsOf('edge').some((t) => t.url.includes('/orders.html')), 8000, 'the new tab\'s address to arrive');
    await userCloseTab(EDGE_DEBUG, '/orders.html');
    await waitFor(() => world.tabsOf('edge').length === before, 8000, 'the closed Edge tab to be noticed');
    expect(world.tabsOf('chrome').length).toBeGreaterThanOrEqual(1); // Chrome's picture is its own
  }, 60_000);

  it('E: signed out — opening the site shows the sign-in page, Eya waits while the USER signs in themselves, then carries on with the original request', async () => {
    await userOpenTab(CHROME_DEBUG, `${base}/`); // the user is in Chrome
    await waitFor(() => world.activeBrowser() === 'chrome', 8000, 'Chrome to count as the browser in use');

    const login = note(await manager.openWebsite(`${base}/auth/account`));
    expect(login.title).toBe('Sign in');
    expect(login.challenge?.kind).toBe('login');
    expect(login.environment).toBe('your_browser');
    expect(login.notes?.join(' ')).toContain("Opened in the user's Chrome.");

    // Eya is now waiting; meanwhile the person types their own password into the page — nothing goes through Eya.
    const waiting = manager.waitForUserChange(25_000);
    await sleep(1200);
    await userEval(
      CHROME_DEBUG,
      '/auth/login',
      `document.querySelector('[name=u]').value = 'asha'; document.querySelector('[name=p]').value = ${JSON.stringify(PASSWORD_THE_USER_TYPES)}; document.forms[0].submit(); true`,
    );
    const done = note(await waiting);
    expect(done.changed).toBe(true);
    expect(done.cleared).toBe('login');
    expect(done.snapshot.title).toBe('My account');
    expect(done.snapshot.visibleText).toContain('Welcome back, Asha');

    // …and the ORIGINAL task simply continues from where the user left it — nobody repeats the request.
    const statement = note(await manager.clickOnPage('View statement'));
    expect(statement.ok).toBe(true);
    expect(statement.snapshot.title).toBe('Statement');
    expect(statement.snapshot.visibleText).toContain('Balance: 1,234');
    expect(manager.pinnedBrowser()).toBe('chrome');
  }, 120_000);

  it('A + D: Chrome holds the session and Edge only unrelated tabs — Eya uses Chrome\'s existing session; no second sign-in, Edge untouched', async () => {
    await userNavigate(EDGE_DEBUG, `${localhostBase}/portal/`); // the user has an unrelated site open in Edge
    await waitFor(() => world.tabsOf('edge').some((t) => t.url.includes('/portal')), 8000, 'Edge to show its tab');
    const edgeBefore = await userTabUrls(EDGE_DEBUG);
    const chromeTabsBefore = world.tabsOf('chrome').length;

    const page = note(await manager.openWebsite(`${base}/auth/account`));
    expect(page.title).toBe('My account');
    expect(page.visibleText).toContain('Welcome back, Asha');
    expect(page.challenge).toBeUndefined();
    expect(page.environment).toBe('your_browser');
    expect(page.notes?.join(' ')).toContain("Opened in the user's Chrome.");
    expect(await userTabUrls(EDGE_DEBUG)).toEqual(edgeBefore);
    expect(world.tabsOf('chrome').length).toBeLessThanOrEqual(chromeTabsBefore + 0); // reused a tab, did not add one
  }, 90_000);

  it('B: with several tabs open, Eya finds the right existing one, focuses it, and leaves the user\'s tabs where they were', async () => {
    await userOpenTab(CHROME_DEBUG, 'data:text/html,<title>Unrelated news</title><h1>News</h1>'); // an unrelated tab
    await userOpenTab(CHROME_DEBUG, `${base}/auth/dashboard`); // the user's own signed-in tab
    await userOpenTab(CHROME_DEBUG, 'data:text/html,<title>Unrelated weather</title><h1>Weather</h1>'); // another unrelated one
    await waitFor(() => world.tabsOf('chrome').some((t) => t.url.endsWith('/auth/dashboard')), 8000, 'the dashboard tab to show');
    const before = (await userTabUrls(CHROME_DEBUG)).slice().sort();

    const page = note(await manager.openWebsite(`${base}/auth/dashboard`));
    expect(page.title).toBe('Dashboard');
    expect(page.visibleText).toContain('Dashboard for Asha');
    expect(page.notes?.join(' ')).toMatch(/already had a tab open/);
    expect((await userTabUrls(CHROME_DEBUG)).slice().sort()).toEqual(before); // nothing opened, nothing navigated away
    const tabs = await manager.listTabs('chrome');
    expect(tabs.find((t) => t.workingHere)?.url).toContain('/auth/dashboard');
    expect(tabs.find((t) => t.workingHere)?.openedByEya).toBe(false); // it is the USER's own tab that is being used
  }, 90_000);

  it('C: the browser is open but the site\'s tab is closed — a NEW TAB in the same browser, and the existing session still applies', async () => {
    // the user closes every tab of this site (the browser keeps running with its other tabs)
    for (let i = 0; i < 12; i += 1) {
      try {
        await userCloseTab(CHROME_DEBUG, `127.0.0.1:${site.port}`);
      } catch {
        break;
      }
    }
    await waitFor(() => !world.tabsOf('chrome').some((t) => t.url.includes(`127.0.0.1:${site.port}`)), 10_000, 'the site\'s tabs to be gone');
    const chromeBefore = world.tabsOf('chrome').length;
    expect(chromeBefore).toBeGreaterThanOrEqual(1); // Chrome is still running with other tabs

    const page = note(await manager.openWebsite(`${base}/auth/dashboard`));
    expect(page.title).toBe('Dashboard');
    expect(page.visibleText).toContain('Dashboard for Asha');
    expect(page.challenge).toBeUndefined(); // the browser's own session applied — no sign-in page
    expect(world.tabsOf('chrome').length).toBe(chromeBefore + 1);
    expect(manager.pinnedBrowser()).toBe('chrome');
  }, 90_000);

  it('D: a different site is signed in in Edge only — Eya picks Edge for it and Chrome for the other, never the wrong one', async () => {
    await userNavigate(EDGE_DEBUG, `${localhostBase}/auth/quick-login`, '/portal'); // the user signs in to the localhost site, in Edge
    await waitFor(() => world.tabsOf('edge').some((t) => t.url.includes('/auth/account')), 8000, 'Edge to land on the account page');
    const chromeUrlsBefore = (await userTabUrls(CHROME_DEBUG)).slice().sort();

    const inEdge = note(await manager.openWebsite(`${localhostBase}/auth/statement`));
    expect(inEdge.title).toBe('Statement');
    expect(inEdge.visibleText).toContain('Balance: 1,234');
    expect(inEdge.notes?.join(' ')).toContain("Opened in the user's Edge.");
    expect(manager.pinnedBrowser()).toBe('edge');
    expect((await userTabUrls(CHROME_DEBUG)).slice().sort()).toEqual(chromeUrlsBefore); // Chrome untouched

    const inChrome = note(await manager.openWebsite(`${base}/auth/account`));
    expect(inChrome.notes?.join(' ')).toContain("Opened in the user's Chrome.");
    expect(inChrome.visibleText).toContain('Welcome back, Asha');
    expect(manager.pinnedBrowser()).toBe('chrome');
  }, 120_000);

  it('the user changes the page mid-task: Eya notices, and reads the real page rather than trusting her old picture', async () => {
    await manager.openWebsite(`${base}/auth/dashboard`);
    await sleep(1200);
    await userNavigate(CHROME_DEBUG, `${base}/auth/statement`, '/auth/dashboard'); // the user clicks away themselves
    await sleep(700);
    const now = note(await manager.inspectPage());
    expect(now.title).toBe('Statement');
    expect(now.notes?.join(' ')).toMatch(/The user changed something in the browser since Eya's last step/);
  }, 60_000);

  it('scroll, reload, back and forward all work in the real browser, and say plainly when the page has no further to go', async () => {
    await manager.openWebsite(`${base}/long.html`);
    const down = await manager.scroll('down');
    expect(down.ok).toBe(true);
    expect(down.ok && down.snapshot.scroll?.y).toBeGreaterThan(0);
    const bottom = await manager.scroll('bottom');
    expect(bottom.ok && bottom.snapshot.scroll?.atBottom).toBe(true);
    const more = await manager.scroll('down');
    expect(more.ok && more.snapshot.notes?.join(' ')).toMatch(/already at the very bottom/);
    const top = await manager.scroll('top');
    expect(top.ok && top.snapshot.scroll?.y).toBe(0);

    expect((await manager.reload()).ok).toBe(true);
    await manager.clickOnPage('Orders at the bottom');
    const back = await manager.goBack();
    expect(back.ok && back.snapshot.title).toBe('Long page');
    const forward = await manager.goForward();
    expect(forward.ok && forward.snapshot.title).toBe('Orders');
  }, 120_000);

  it('closing tabs: one Eya opened closes; one the user opened is refused unless the user agreed', async () => {
    await userOpenTab(CHROME_DEBUG, `${base}/orders.html`);
    await waitFor(() => world.tabsOf('chrome').some((t) => t.url.endsWith('/orders.html')), 8000, 'the user\'s tab');
    // The tab list is asked of the browser itself, a moment after the event: wait for it rather than assume the two agree.
    let users: Awaited<ReturnType<typeof manager.listTabs>>[number] | undefined;
    await waitFor(
      async () => {
        users = (await manager.listTabs('chrome')).find((t) => t.url.endsWith('/orders.html') && !t.openedByEya);
        return users !== undefined;
      },
      8000,
      "the user's tab in Eya's tab list",
    );
    expect(users).toBeDefined();
    await expect(manager.closeTab(users!.tabId, { browser: 'chrome' })).rejects.toThrow(/opened by you/);
    const closed = await manager.closeTab(users!.tabId, { browser: 'chrome', allowUserTab: true });
    expect(closed.closed).toBe(true);
    await waitFor(() => !world.tabsOf('chrome').some((t) => t.tabId === users!.tabId), 8000, 'the tab to be gone from the picture');
  }, 60_000);

  it('Chrome tab numbers and Edge tab numbers are different things: switching names the browser when it could be either', async () => {
    const chromeTab = world.tabsOf('chrome')[0];
    const edgeTab = world.tabsOf('edge')[0];
    expect(chromeTab && edgeTab).toBeTruthy();
    const snap = note(await manager.switchToTab(edgeTab!.tabId, 'edge'));
    expect(snap.environment).toBe('your_browser');
    expect(manager.pinnedBrowser()).toBe('edge');
    const shared = [...world.tabsOf('chrome')].map((t) => t.tabId).find((id) => world.tabsOf('edge').some((t) => t.tabId === id));
    if (shared !== undefined) await expect(manager.switchToTab(shared)).rejects.toThrow(/say which browser/);
  }, 60_000);

  it('nothing secret ever reached Eya: not the session cookie, not the password the user typed', () => {
    const everything = seen.join('\n');
    expect(seen.length).toBeGreaterThan(5);
    expect(everything).not.toContain(SESSION_COOKIE_VALUE);
    expect(everything).not.toContain(PASSWORD_THE_USER_TYPES);
    expect(everything.toLowerCase()).not.toContain('document.cookie');
  });

  it('with NO browser running, the user\'s normal browser is started with the address and used — not a separate automation browser', async () => {
    const portB = BRIDGE_PORT_B;
    const extB = prepareExtensionCopy(portB);
    extras.push(extB.cleanup);
    const bridgeB = new ChromeBridge({ secrets: new MemorySecrets(), port: portB });
    expect(await bridgeB.start()).toBe(true);
    extras.push(() => void bridgeB.stop());
    const worldB = new BrowserWorldTracker();
    worldB.attach(bridgeB);
    bridgeB.openPairingWindow(); // as if it had been paired before

    let started: TestBrowser | null = null;
    const startedUrls: Array<[string, string]> = [];
    const launcher: BrowserLauncher = {
      installed: async () => ['chrome'],
      running: async () => [],
      launch: async (browser, url) => {
        startedUrls.push([browser, url]);
        started = await startTestBrowser({ kind: 'chrome', extensionDir: extB.dir, debugPort: LAUNCHED_DEBUG, url });
        extras.push(() => {
          started?.kill();
          setTimeout(() => started?.cleanup(), 800);
        });
        return true;
      },
    };
    const managerB = new BrowserSessionManager({ bridge: bridgeB, world: worldB, isolated: forbiddenIsolatedBrowser, launcher, mode: 'user_browser', launchWaitMs: 60_000 });
    const page = note(await managerB.openWebsite(`${base}/portal/`));
    expect(startedUrls).toEqual([['chrome', `${base}/portal/`]]);
    expect(page.title).toBe('Welcome to the State Portal');
    expect(page.environment).toBe('your_browser');
    expect(page.notes?.join(' ')).toMatch(/Chrome was not running, so Eya started it/);
    expect(bridgeB.connectedBrowsers()).toEqual(['chrome']);
  }, 180_000);

  it('and when nothing at all can be found, it says so — and the separate window is still never touched', async () => {
    const bridgeC = new ChromeBridge({ secrets: new MemorySecrets(), port: 47833 });
    expect(await bridgeC.start()).toBe(true);
    extras.push(() => void bridgeC.stop());
    const worldC = new BrowserWorldTracker();
    worldC.attach(bridgeC);
    const managerC = new BrowserSessionManager({
      bridge: bridgeC,
      world: worldC,
      isolated: forbiddenIsolatedBrowser,
      launcher: { installed: async () => [], running: async () => [], launch: async () => false },
      mode: 'user_browser',
    });
    await expect(managerC.openWebsite(`${base}/`)).rejects.toThrow(/Neither Chrome nor Edge could be found/);
  }, 30_000);
});
