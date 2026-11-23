/**
 * "Open everything in Eya Browser", and a live chat that stays where it started — in a REAL Chromium page, through the real services:
 *
 *   BrowserSessionManager (the one switch) → EmbeddedBrowserService → EmbeddedPageHost → the page script (eya-chrome-extension/injected.js, run inside the page with no extension)
 *
 * The pages are real (a Chrome started for the test, driven over its debugging protocol by tests/live/cdpEmbedded.ts instead of Electron's WebContentsView); the WhatsApp-shaped
 * mock is wa.localhost/walive.html. With the switch OFF the same requests go through the real extension to the same Chrome. What this proves: where things open, that WhatsApp's
 * live chat (watching, noticing a message, replying, deleting) works inside Eya Browser with no extension at all, that another request opens in a tab of its own, and that the
 * user's Chrome going away does not touch a chat that is in Eya Browser.
 *
 * Opt-in: EYA_LIVE_BROWSER=1 npx vitest run tests/live/eyabrowser.live.test.ts
 * NOT covered: Electron's own layer (WebContentsView, the window), the real WhatsApp Web, a real model (the replies are scripted).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { ChromeBridge } from '../../src/main/chrome/ChromeBridge';
import type { SecretStore } from '../../src/main/chrome/ChromeBridge';
import { BrowserWorldTracker } from '../../src/main/chrome/browserWorld';
import { BrowserSessionManager } from '../../src/main/browser/BrowserSessionManager';
import type { BrowserLauncher, ManagedBridge } from '../../src/main/browser/BrowserSessionManager';
import { EmbeddedBrowserService } from '../../src/main/browser/EmbeddedBrowserService';
import type { BrowserName } from '../../src/main/chrome/protocol';
import { ChatSession } from '../../src/main/chat/chatSession';
import { LiveChatController } from '../../src/main/livechat/LiveChatController';
import { LiveChatStore } from '../../src/main/livechat/LiveChatStore';
import { createChatActions, createChatWatcher } from '../../src/main/livechat/liveChatWiring';
import type { WatcherBridge } from '../../src/main/livechat/liveChatWiring';
import { CommunicationPolicy } from '../../src/main/privacy/communicationAccess';
import type { CommunicationApp } from '../../src/main/privacy/communicationAccess';
import { CommunicationAccessStore } from '../../src/main/privacy/communicationAccessStore';
import { startPolicySync } from '../../src/main/privacy/policySync';
import type { KnownFolders } from '../../src/main/security/pathPolicy';
import { createBrowserTools } from '../../src/main/tools/impl/browserTools';
import { createChatSendGate, createChatTools } from '../../src/main/tools/impl/chatTools';
import type { Tool, ToolArgs, ToolResult } from '../../src/main/tools/types';
import { startTestSite } from '../fixtures/chrome-test-site/server.mjs';
import { FakeAI, MemoryIo } from '../liveChatFixtures';
import { CdpEnv } from './cdpEmbedded';
import type { CdpTab } from './cdpEmbedded';
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser, userCloseTab, userEval, waitFor } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const BRIDGE_PORT = 47866;
const DEBUG_PORT = 9366;
const HOST = 'wa.localhost';

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

const WHATSAPPISH: CommunicationApp = { id: 'whatsapp', name: 'WhatsApp', hosts: [{ host: HOST }], processes: [], titleHints: [] };
/** Operations that would mean the user's own browser (the extension) was used for something. */
const PAGE_OPS = ['open_url', 'observe', 'click', 'fill', 'scroll', 'press_key', 'attach_file', 'chat_watch', 'chat_read', 'chat_media', 'chat_delete'];

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('Eya Browser: one switch, WhatsApp inside it, a live chat that stays where it started', () => {
  let site: { server: Server; port: number };
  let bridge: ChromeBridge;
  let world: BrowserWorldTracker;
  let browser: TestBrowser;
  let ext: { dir: string; cleanup: () => void };
  let stopSync: () => void;
  let policy: CommunicationPolicy;
  let manager: BrowserSessionManager;
  let eya: EmbeddedBrowserService;
  let env: CdpEnv;
  let session: ChatSession;
  let tools: Tool[];
  let controller: LiveChatController;
  let pref: 'eya' | 'mine' = 'mine';
  /** What the user's own browser (the extension) was asked to do. */
  const asked: string[] = [];
  /** What the live chat said TO the person (together: what comes in, and what she would reply). */
  const heard: Array<{ spoken: string; kind?: string }> = [];
  const ai = new FakeAI();
  const io = new MemoryIo();
  const files = new Map<string, string>();

  const pageUrl = () => `http://${HOST}:${site.port}/walive.html`;
  const otherUrl = () => `http://other.localhost:${site.port}/index.html`;
  const call = (name: string, args: ToolArgs = {}): Promise<ToolResult> => {
    const tool = tools.find((t) => t.schema.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.execute(args);
  };
  /** The WhatsApp-shaped page in Eya Browser (the first tab it opened), or in the user's own browser. */
  const inEya = (expression: string): Promise<unknown> => (env.tabs[0] as CdpTab).run(expression);
  const inUser = (expression: string): Promise<unknown> => userEval(DEBUG_PORT, HOST, expression);
  const view = () => controller.view();

  beforeAll(async () => {
    site = await startTestSite(0);
    ext = prepareExtensionCopy(BRIDGE_PORT);
    const store = new CommunicationAccessStore('memory', { read: (p) => files.get(p) ?? null, write: (p, t) => void files.set(p, t) }, ['whatsapp']);
    store.load();
    store.set({ enabled: true, apps: {} });
    policy = new CommunicationPolicy(() => store.get(), [WHATSAPPISH]);

    bridge = new ChromeBridge({ secrets: new MemorySecrets(), port: BRIDGE_PORT });
    if (!(await bridge.start())) throw new Error(`port ${BRIDGE_PORT} is busy`);
    world = new BrowserWorldTracker();
    world.attach(bridge);
    stopSync = startPolicySync({ bridge, blockRules: () => policy.blockRules(), onPolicyChange: (l) => store.onChange(l) });
    bridge.openPairingWindow();
    // (the switches the app sets for her own pages — main.ts — so a hidden page is not slowed down; EYA_TEST_THROTTLED=1 leaves them off, to see what they are for)
    const unthrottled = process.env['EYA_TEST_THROTTLED'] === '1' ? [] : ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'];
    browser = await startTestBrowser({ kind: 'chrome', extensionDir: ext.dir, debugPort: DEBUG_PORT, extraArgs: unthrottled });
    await waitFor(() => bridge.isConnected('chrome'), 45_000, 'the extension to connect and pair');

    // (the user's own browser is asked through this: what it was asked is recorded, so a test can say it was NOT used)
    const managedBridge = new Proxy(bridge, {
      get(target, prop) {
        if (prop === 'forBrowser') {
          return (b: BrowserName) => {
            const link = target.forBrowser(b);
            return { ...link, isConnected: () => link.isConnected(), ...(link.capabilities !== undefined ? { capabilities: () => link.capabilities?.() ?? [] } : {}), request: (op: string, args?: Readonly<Record<string, unknown>>, t?: number) => (asked.push(op), link.request(op, args, t)) };
          };
        }
        const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as ManagedBridge;

    env = new CdpEnv(DEBUG_PORT);
    const isChat = (url: string): boolean => policy.appForUrl(url) != null;
    eya = new EmbeddedBrowserService({ env, navTimeoutMs: 10_000, blankWaitMs: 1500, quickFor: isChat, protect: isChat });
    const launcher: BrowserLauncher = { installed: async () => ['chrome'], running: async () => ['chrome'], launch: async () => false };
    manager = new BrowserSessionManager({ bridge: managedBridge, world, isolated: eya, mode: 'smart', preference: () => pref, words: () => '', launcher, policy });
    session = new ChatSession();
    const folders: KnownFolders = { home: 'C:\\x', downloads: 'C:\\x', desktop: 'C:\\x', documents: 'C:\\x', pictures: 'C:\\x', videos: 'C:\\x', music: 'C:\\x', temp: 'C:\\x' };
    tools = [
      ...createBrowserTools(manager, undefined, { tabs: manager, session: manager, chatGate: createChatSendGate(session, policy) }),
      ...createChatTools({ service: manager, policy, session, folders }),
    ];
    // What the live chat hears: the user's Chrome (through the extension) or Eya Browser (from the page itself) — as in the app.
    const liveBridge: WatcherBridge = {
      onBrowserEvent: (l) => {
        const a = bridge.onBrowserEvent(l);
        const b = eya.host.onBrowserEvent((e) => l({ browser: 'other', name: e.name, data: e.data }));
        return () => {
          a();
          b();
        };
      },
      onConnectionChange: (l) => bridge.onConnectionChange(l),
    };
    const app = policy.apps().find((a) => a.id === 'whatsapp') as CommunicationApp;
    const watcher = createChatWatcher(liveBridge, manager);
    controller = new LiveChatController({
      store: new LiveChatStore('live-chat.json', io),
      ai,
      watcher,
      chat: createChatActions({ tools: { invoke: (name, args) => call(name, args) }, service: manager, session, tab: () => watcher.tab(), home: () => watcher.home() }),
      permits: () => null,
      allowed: () => (policy.allowed(app) ? null : 'Chats are switched off for WhatsApp in Eya.'),
      alert: () => undefined,
      reconcileMs: 0, // events are the only way new messages are noticed in this test
      say: (spoken, _shown, kind) => heard.push({ spoken, ...(kind !== undefined ? { kind } : {}) }),
      dictateUndoMs: 700, // (a short moment for "wait" / "no, send this": the real timers run here)
    });
  }, 120_000);

  afterAll(async () => {
    await controller?.stop().catch(() => undefined);
    controller?.dispose();
    await eya?.close().catch(() => undefined);
    stopSync?.();
    browser?.kill();
    await bridge?.stop().catch(() => undefined);
    site?.server.close();
    await sleep(500);
    browser?.cleanup();
    ext?.cleanup();
  }, 30_000);

  const drafted = async (inPage: (e: string) => Promise<unknown>, text: string): Promise<number> => {
    const before = ai.calls;
    const started = Date.now();
    await inPage(`window.__receive(${JSON.stringify(text)})`);
    await waitFor(() => view().draft !== null && ai.calls > before && view().draft?.status !== 'stale' && view().state === 'WAITING_FOR_APPROVAL', 10_000, 'a reply to be drafted');
    return Date.now() - started;
  };

  it('OFF: everything opens directly in the user\'s own browser, through the extension; a live chat runs there', async () => {
    pref = 'mine';
    manager.preferenceChanged();
    asked.length = 0;
    const opened = await call('open_website', { url: pageUrl() });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    expect(opened.data?.['environment']).toBe('your_browser');
    expect(asked).toContain('open_url');
    expect(env.tabs).toHaveLength(0); // (Eya Browser was not used at all)
    await waitFor(async () => /WhatsApp/.test(String(await inUser('document.title'))), 10_000, 'the page to load');
    const started = await controller.start('Rahul Sharma', 'assisted');
    expect(started.view.state, started.message).toBe('ACTIVE');
    expect(asked).toContain('chat_watch');
    ai.say('Sure, call me.');
    await drafted(inUser, 'Can we talk?');
    const before = (await inUser('window.__sent.length')) as number;
    expect((await controller.handle({ kind: 'send' })).ok).toBe(true);
    await waitFor(async () => (await inUser('window.__sent.length')) === before + 1, 8000, 'the reply to reach the page');
    await controller.handle({ kind: 'stop' });
    await userCloseTab(DEBUG_PORT, HOST);
    await sleep(500);
  }, 150_000);

  it('ON: WhatsApp opens in Eya Browser — not in the user\'s browser — and the live chat runs inside it with no extension: a message is noticed at once and answered', async () => {
    pref = 'eya';
    manager.preferenceChanged();
    asked.length = 0;
    const opened = await call('open_website', { url: pageUrl() });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    expect(opened.data?.['environment']).toBe('eya_browser');
    expect(env.tabs).toHaveLength(1);
    await waitFor(async () => /WhatsApp/.test(String(await inEya('document.title'))), 10_000, 'the page to load');
    const started = await controller.start('Rahul Sharma', 'assisted');
    expect(started.view.state, started.message).toBe('ACTIVE');
    expect(started.view).toMatchObject({ chat: 'Rahul Sharma', verified: true });
    ai.say('Yes, call me whenever you are free.');
    const ms = await drafted(inEya, 'Can we talk today?'); // (no periodic check in this test: only the page's own announcement can have brought it)
    console.log('[eya browser] incoming message → draft ready in ' + ms + ' ms (model scripted)');
    expect(ms).toBeLessThan(5000);
    const sentBefore = (await inEya('window.__sent.length')) as number;
    const t9 = Date.now();
    const sent = await controller.handle({ kind: 'send' });
    console.log('[eya browser] send (chat in front) took ' + (Date.now() - t9) + ' ms');
    expect(sent.ok, sent.message).toBe(true);
    await waitFor(async () => (await inEya('window.__sent.length')) === sentBefore + 1, 8000, 'the reply to reach the page');
    expect(await inEya('window.__sent[window.__sent.length - 1].text')).toBe('Yes, call me whenever you are free.');
    expect(view().state).toBe('ACTIVE');
    // the user's own browser was not asked to do anything for any of this
    expect(asked.filter((op) => PAGE_OPS.includes(op))).toEqual([]);
  }, 150_000);

  it('ON: deleting a message works inside Eya Browser, for everyone or only for the person', async () => {
    const last = async (): Promise<string> => String(await inEya("[...document.querySelectorAll('#thread [data-id]')].map((e) => e.getAttribute('data-id')).filter((i) => /^true_/.test(i)).pop()"));
    const sendOne = async (text: string): Promise<string> => {
      const before = (await inEya('window.__sent.length')) as number;
      expect((await controller.handle({ kind: 'relay', text })).ok).toBe(true);
      await waitFor(async () => (await inEya('window.__sent.length')) === before + 1, 8000, 'the message to be sent');
      await sleep(600);
      return last();
    };
    const first = await sendOne('Delete this one for everyone');
    const everyone = await controller.handle({ kind: 'delete_message', id: first, scope: 'everyone' });
    expect(everyone.ok, everyone.message).toBe(true);
    expect(await inEya('window.__deleted[window.__deleted.length - 1]')).toMatchObject({ scope: 'everyone', text: 'Delete this one for everyone' });
    const second = await sendOne('Delete this one only for me');
    const mine = await controller.handle({ kind: 'delete_message', id: second, scope: 'me' });
    expect(mine.ok, mine.message).toBe(true);
    expect(await inEya('window.__deleted[window.__deleted.length - 1]')).toMatchObject({ scope: 'me', text: 'Delete this one only for me' });
    expect(view().state).toBe('ACTIVE');
  }, 150_000);

  it('ON: TOGETHER — what comes in is told at once; dictated words go out word for word in the real page; "no, send this" replaces the first; "wait" stops one', async () => {
    expect((await controller.handle({ kind: 'set_together', on: true })).ok).toBe(true);
    heard.length = 0;
    ai.say('Yes, call me whenever you are free.');
    await drafted(inEya, 'Are you coming today?');
    expect(heard.some((h) => h.kind === 'together' && h.spoken === 'Rahul Sharma says: Are you coming today?')).toBe(true);
    expect(heard.some((h) => h.kind === 'together' && /^I'd reply: Yes, call me whenever you are free\./.test(h.spoken))).toBe(true);
    // "send this: …", then "no, send this: …" within the moment: only the second reaches the page, exactly as said (not "Rakesh says: …")
    const before = (await inEya('window.__sent.length')) as number;
    expect((await controller.handle({ kind: 'dictate', text: 'I will come at 5', send: true })).ok).toBe(true);
    expect((await controller.handle({ kind: 'dictate', text: 'I will come at 6', send: true })).ok).toBe(true);
    await waitFor(async () => (await inEya('window.__sent.length')) === before + 1, 8000, 'the dictated message to reach the page');
    await sleep(1500);
    expect(await inEya('window.__sent.length')).toBe(before + 1);
    expect(await inEya('window.__sent[window.__sent.length - 1].text')).toBe('I will come at 6');
    await waitFor(() => view().state === 'ACTIVE', 8000, 'the chat to be ready again');
    // "wait" within the moment: nothing is sent
    expect((await controller.handle({ kind: 'dictate', text: 'never mind this one', send: true })).ok).toBe(true);
    const held = await controller.handle({ kind: 'hold' });
    expect(held.ok, held.message).toBe(true);
    await sleep(1800);
    expect(await inEya('window.__sent.length')).toBe(before + 1);
    expect((await controller.handle({ kind: 'release' })).ok).toBe(true);
    expect((await controller.handle({ kind: 'set_together', on: false })).ok).toBe(true);
    expect(view().state).toBe('ACTIVE');
    expect(asked.filter((op) => PAGE_OPS.includes(op))).toEqual([]);
  }, 150_000);

  it('ON: WhatsApp shows its QR code — Eya says so out loud, waits, and carries on by herself when it is scanned', async () => {
    expect((await controller.handle({ kind: 'stop' })).ok).toBe(true);
    await sleep(500);
    heard.length = 0;
    await inEya('window.__qr(true)'); // (the phone is not linked yet: the page shows only its QR code)
    const started = await controller.handle({ kind: 'start', name: 'Rahul Sharma', mode: 'assisted' });
    expect(started.ok, started.message).toBe(true);
    expect(view().state).toBe('WAITING_FOR_USER');
    expect(started.message).toMatch(/QR code/);
    expect(heard.filter((h) => h.kind === 'live').map((h) => h.spoken)).toEqual([expect.stringMatching(/wait: I have opened WhatsApp here and it is asking for the QR code/)]);
    await sleep(4000); // (still not scanned: still waiting, and nothing was said a second time)
    expect(view().state).toBe('WAITING_FOR_USER');
    expect(heard.filter((h) => h.kind === 'live')).toHaveLength(1);
    await inEya('window.__qr(false)'); // (the person scans it)
    await waitFor(() => view().state === 'ACTIVE', 20_000, 'the live chat to carry on by itself after the scan');
    expect(view()).toMatchObject({ chat: 'Rahul Sharma', verified: true });
    expect(heard.filter((h) => h.kind === 'live').map((h) => h.spoken)[1]).toMatch(/WhatsApp is connected\. I am opening the chat now\./);
    expect(asked.filter((op) => PAGE_OPS.includes(op))).toEqual([]);
  }, 150_000);

  it('ON: another request (a different site) opens in a tab of its own — the chat\'s tab is not touched, not reloaded, and the chat goes on answering; opening WhatsApp again shows it as it is', async () => {
    const chatTab = env.tabs[0] as CdpTab;
    const loadsBefore = chatTab.loads.length;
    const t0 = Date.now();
    const other = await call('open_website', { url: otherUrl() });
    console.log('[eya browser] opening another site took ' + (Date.now() - t0) + ' ms');
    expect(other.ok, JSON.stringify(other)).toBe(true);
    expect(env.tabs).toHaveLength(2);
    expect(chatTab.loads.length).toBe(loadsBefore); // (the chat's page was not navigated away)
    expect(await inEya('document.title')).toMatch(/WhatsApp/);
    // the chat keeps working while the other page is the one in front
    const sentBefore = (await inEya('window.__sent.length')) as number;
    ai.say('On my way, ten minutes.');
    console.log('[eya browser] with another tab in front: message → draft in ' + (await drafted(inEya, 'Where are you now?')) + ' ms');
    const t1 = Date.now();
    const sent = await controller.handle({ kind: 'send' });
    expect(sent.ok, sent.message).toBe(true);
    const took = Date.now() - t1;
    console.log('[eya browser] send took ' + took + ' ms');
    expect(took).toBeLessThan(3000); // (it used to take eight seconds after a message had been deleted)
    await waitFor(async () => (await inEya('window.__sent.length')) === sentBefore + 1, 8000, 'the reply to reach the page');
    expect(view().state).toBe('ACTIVE');
    // opening WhatsApp again: its tab is shown as it is
    const t2 = Date.now();
    const again = await call('open_website', { url: pageUrl() });
    console.log('[eya browser] opening WhatsApp again took ' + (Date.now() - t2) + ' ms');
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(env.tabs).toHaveLength(2);
    expect(chatTab.loads.length).toBe(loadsBefore);
  }, 150_000);

  it('ON: the user\'s Chrome going away (the extension disconnects) does not touch a chat that is in Eya Browser: it is never paused and the next message is answered', async () => {
    await bridge.stop();
    await sleep(1500);
    expect(view().state).toBe('ACTIVE');
    expect(view().pause).toBeNull();
    const sentBefore = (await inEya('window.__sent.length')) as number;
    ai.say('Okay, see you then.');
    await drafted(inEya, 'Can you bring the file when you come?');
    expect((await controller.handle({ kind: 'send' })).ok).toBe(true);
    await waitFor(async () => (await inEya('window.__sent.length')) === sentBefore + 1, 8000, 'the reply to reach the page');
    expect(view().state).toBe('ACTIVE');
    await controller.handle({ kind: 'stop' });
  }, 150_000);
});
