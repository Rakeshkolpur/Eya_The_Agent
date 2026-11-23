/**
 * Live test of Communication Access with the REAL extension in a REAL Chrome, talking to the real bridge.
 *
 * A mock chat app ("MockChat Web", tests/fixtures/chrome-test-site/chat.html) is served on chat.localhost and registered
 * as an extra chat app, so the real catalogue (WhatsApp, Telegram…) is untouched. The checks that matter most go straight
 * to the extension, around Eya's own desktop-side checks, to prove the browser side refuses on its own:
 *
 *   OFF  → the extension refuses to read, click in, type into or photograph the chat tab, and reports no title
 *   ON   → the same calls work (pushed to the extension by the policy sync, as the app does it)
 *   OFF again → refused again, on the very next call
 *   other sites are never affected
 *
 * Opt-in: EYA_LIVE_BROWSER=1 npx vitest run tests/live/communication.live.test.ts
 * Not covered: the real WhatsApp / Telegram / Instagram sites and a real signed-in profile.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { ChromeBridge } from '../../src/main/chrome/ChromeBridge';
import type { SecretStore } from '../../src/main/chrome/ChromeBridge';
import { ChromeBrowserService } from '../../src/main/chrome/ChromeBrowserService';
import { BrowserWorldTracker } from '../../src/main/chrome/browserWorld';
import { BrowserSessionManager } from '../../src/main/browser/BrowserSessionManager';
import type { BrowserLauncher } from '../../src/main/browser/BrowserSessionManager';
import type { BrowserAutomationService } from '../../src/main/browser/BrowserAutomationService';
import { CommunicationAccessError } from '../../src/main/browser/errors';
import type { BrowserName } from '../../src/main/chrome/protocol';
import { CommunicationPolicy } from '../../src/main/privacy/communicationAccess';
import type { CommunicationApp } from '../../src/main/privacy/communicationAccess';
import { CommunicationAccessStore } from '../../src/main/privacy/communicationAccessStore';
import { startPolicySync } from '../../src/main/privacy/policySync';
import { startTestSite } from '../fixtures/chrome-test-site/server.mjs';
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser, userEval, waitFor } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const BRIDGE_PORT = 47836;
const DEBUG_PORT = 9344;

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

const MOCK_CHAT: CommunicationApp = { id: 'mockchat', name: 'MockChat', hosts: [{ host: 'chat.localhost' }], processes: [], titleHints: [] };

const forbiddenIsolatedBrowser = new Proxy(
  {},
  { get: (_t, prop) => (prop === 'close' ? async () => undefined : () => Promise.reject(new Error(`Eya's separate browser window must not be used (${String(prop)})`))) },
) as BrowserAutomationService;

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('Communication Access: the real extension refuses chat apps until it is switched on', () => {
  let site: { server: Server; port: number };
  let chatUrl = '';
  let plainUrl = '';
  let bridge: ChromeBridge;
  let world: BrowserWorldTracker;
  let browser: TestBrowser;
  let ext: { dir: string; cleanup: () => void };
  let stopSync: () => void;
  let store: CommunicationAccessStore;
  let policy: CommunicationPolicy;
  let manager: BrowserSessionManager;
  /** Straight to the extension, around every desktop-side check. */
  let direct: ChromeBrowserService;
  const files = new Map<string, string>();

  beforeAll(async () => {
    site = await startTestSite(0);
    chatUrl = `http://chat.localhost:${site.port}/chat.html`;
    plainUrl = `http://127.0.0.1:${site.port}/orders.html`;
    ext = prepareExtensionCopy(BRIDGE_PORT);

    store = new CommunicationAccessStore('memory', { read: (p) => files.get(p) ?? null, write: (p, t) => void files.set(p, t) }, ['mockchat']);
    store.load();
    policy = new CommunicationPolicy(() => store.get(), [MOCK_CHAT]);

    bridge = new ChromeBridge({ secrets: new MemorySecrets(), port: BRIDGE_PORT });
    if (!(await bridge.start())) throw new Error(`port ${BRIDGE_PORT} is busy`);
    world = new BrowserWorldTracker();
    world.attach(bridge);
    stopSync = startPolicySync({ bridge, blockRules: () => policy.blockRules(), onPolicyChange: (l) => store.onChange(l) });
    bridge.openPairingWindow();

    browser = await startTestBrowser({ kind: 'chrome', extensionDir: ext.dir, debugPort: DEBUG_PORT });
    await waitFor(() => bridge.isConnected('chrome'), 45_000, 'the extension to connect and pair');

    direct = new ChromeBrowserService(bridge.forBrowser('chrome'), { browserName: 'chrome' });
    const launcher: BrowserLauncher = { installed: async () => ['chrome'], running: async () => ['chrome'], launch: async () => false };
    manager = new BrowserSessionManager({ bridge, world, isolated: forbiddenIsolatedBrowser, launcher, mode: 'user_browser', policy });
  }, 120_000);

  afterAll(async () => {
    stopSync?.();
    browser?.kill();
    await bridge?.stop();
    site?.server.close();
    await sleep(500);
    browser?.cleanup();
    ext?.cleanup();
  }, 30_000);

  async function refusedByExtension(run: () => Promise<unknown>): Promise<CommunicationAccessError> {
    try {
      await run();
    } catch (e) {
      expect(e).toBeInstanceOf(CommunicationAccessError);
      return e as CommunicationAccessError;
    }
    throw new Error('the extension did not refuse');
  }

  /** Does the extension, asked directly, show the chat's contents right now? */
  const extensionAllows = async () => JSON.stringify(await direct.inspectPage()).includes('Rahul Sharma');
  const extensionBlocks = async () => !(await extensionAllows());
  const chatTitleInBrowser = () => userEval(DEBUG_PORT, undefined, 'document.title');

  it('the extension itself reports it understands the policy request', async () => {
    expect(bridge.handshakeOf('chrome')?.capabilities).toContain('policy');
  });

  it('OFF (the default): opening the chat for the user works, and what Eya gets back is only that it is open', async () => {
    expect(store.get().enabled).toBe(false);
    const s = await manager.openWebsite(chatUrl);
    expect(s.title).toBe('MockChat');
    expect(s.buttons).toEqual([]);
    expect(s.links).toEqual([]);
    expect(JSON.stringify(s)).not.toMatch(/Rahul|Priya|Mum/);
    // The page really is open and showing its contacts — Eya just did not read them.
    await waitFor(async () => (await chatTitleInBrowser()) === 'MockChat Web', 10_000, 'the chat page to load');
  }, 60_000);

  /** What the extension lets through when asked to look at the chat: nothing from the page. */
  function assertNothingFromChat(x: unknown): void {
    const json = JSON.stringify(x);
    for (const private_ of ['Rahul', 'Priya', 'Mum', 'Amit', 'Meera', '98765', 'Type a message', 'Search or start']) expect(json).not.toContain(private_);
  }

  it('OFF: the EXTENSION declines to read, click in, type into or photograph the chat — with Eya\'s own checks out of the way', async () => {
    // The policy sync may still be in flight just after connecting; the extension blocks by default meanwhile, so this is safe either way.
    const looked = await direct.inspectPage(); // a read of a chat tab comes back as an empty "restricted" page, like a protected browser page
    assertNothingFromChat(looked);
    expect(looked.title).toBe('');
    expect(looked.notes?.join(' ')).toMatch(/Communication Access/);
    // Acting by name finds nothing to act on (the read above was empty), so nothing is clicked or typed.
    for (const act of [() => direct.clickOnPage('Rahul Sharma'), () => direct.fillOnPage('Type a message', 'hello')]) {
      const outcome = await act().then(
        (r) => r as { ok: boolean },
        (e: unknown) => e,
      );
      if (!(outcome instanceof CommunicationAccessError)) expect((outcome as { ok: boolean }).ok).toBe(false);
    }
    // Scrolling and photographing go straight to the page or the screen, and are refused outright, naming the host.
    const err = await refusedByExtension(() => direct.scroll('down'));
    expect(err.app).toBe('chat.localhost'); // the extension names the host; Eya's own layer names the app
    await refusedByExtension(() => direct.screenshot());
    // Even an action aimed at a known element id is refused by the extension, with no help from the read step.
    for (const [op, args] of [
      ['click', { id: 'e1.0', name: 'Rahul Sharma' }],
      ['fill', { id: 'e1.1', name: 'Type a message', value: 'hello' }],
    ] as const) {
      await expect(bridge.forBrowser('chrome').request(op, args), op).rejects.toThrow(/communication_access_off/);
    }
    // Looking things up on the page either is refused or finds nothing — never a contact.
    for (const look of [() => direct.findOnPage('conversation'), () => direct.readPage()]) {
      const outcome = await look().then(
        (r) => r as unknown,
        (e: unknown) => e,
      );
      if (outcome instanceof CommunicationAccessError) continue;
      assertNothingFromChat(outcome);
    }
  }, 60_000);

  it('OFF: the page was never touched by any of those attempts', async () => {
    expect(await userEval(DEBUG_PORT, undefined, 'document.getElementById("search").value')).toBe('');
    expect(await userEval(DEBUG_PORT, undefined, 'document.getElementById("composer").hidden')).toBe(true);
    expect(await userEval(DEBUG_PORT, undefined, 'document.getElementById("chat-title").textContent')).toBe('Select a chat');
  });

  it('OFF: the tab list never reports the chat tab\'s title or address query', async () => {
    const raw = await direct.listTabs();
    const tab = raw.find((t) => t.url.includes('chat.localhost'));
    expect(tab).toBeDefined();
    expect(tab?.title).toBe('');
    const viaEya = await manager.listTabs('chrome');
    expect(viaEya.find((t) => t.url.includes('chat.localhost'))?.title).toBe('MockChat');
  });

  it('OFF: Eya\'s own layer refuses too (so it never even asks the extension)', async () => {
    const err = await manager.inspectPage().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CommunicationAccessError);
    expect((err as CommunicationAccessError).app).toBe('MockChat');
  });

  it('OFF: other sites are not affected', async () => {
    const page = await manager.openWebsite(plainUrl);
    expect(page.title).toBe('Orders');
    await expect(manager.inspectPage()).resolves.toMatchObject({ title: 'Orders' });
    await expect(direct.inspectPage()).resolves.toMatchObject({ title: 'Orders' });
  }, 60_000);

  it('ON: the user switches it on; the policy reaches the extension, and the same calls now work', async () => {
    store.set({ enabled: true, apps: {} });
    await manager.openWebsite(chatUrl); // brings the chat tab to the front
    await waitFor(extensionAllows, 10_000, 'the extension to take the new policy');
    const seen = await manager.inspectPage();
    expect(seen.title).toBe('MockChat Web');
    expect(JSON.stringify(seen)).toContain('Rahul Sharma'); // the contacts are visible now, because the user allowed it
    // And the tab LIST still shows only the app, never the contact's name.
    expect((await manager.listTabs('chrome')).find((t) => t.url.includes('chat.localhost'))?.title).toBe('MockChat');
  }, 60_000);

  it('ON: she can act in it like any page (this opens a chat and types in it)', async () => {
    const opened = await manager.clickOnPage('Priya Singh');
    expect(opened.ok).toBe(true);
    expect(await userEval(DEBUG_PORT, undefined, 'document.getElementById("chat-title").textContent')).toBe('Priya Singh');
    await manager.fillOnPage('Type a message', 'hello Priya');
    expect(await userEval(DEBUG_PORT, undefined, 'document.getElementById("msg").value')).toBe('hello Priya');
  }, 60_000);

  it('OFF again: it takes effect on the very next call, in both layers', async () => {
    store.set({ enabled: false, apps: {} });
    await waitFor(extensionBlocks, 10_000, 'the extension to take the policy back');
    await refusedByExtension(() => direct.scroll('down'));
    await expect(bridge.forBrowser('chrome').request('click', { id: 'e1.0', name: 'Send' })).rejects.toThrow(/communication_access_off/);
    await expect(manager.clickOnPage('Send')).rejects.toBeInstanceOf(CommunicationAccessError);
    expect(await userEval(DEBUG_PORT, undefined, 'document.getElementById("msg").value')).toBe('hello Priya'); // untouched
  }, 60_000);

  it('one app excluded while the master switch is ON: that app only', async () => {
    store.set({ enabled: true, apps: { mockchat: false } });
    await waitFor(extensionBlocks, 10_000, 'the extension to take the policy');
    await expect(manager.inspectPage()).rejects.toBeInstanceOf(CommunicationAccessError);
    store.set({ enabled: true, apps: {} });
    await waitFor(extensionAllows, 10_000, 'the extension to allow it again');
  }, 60_000);
});
