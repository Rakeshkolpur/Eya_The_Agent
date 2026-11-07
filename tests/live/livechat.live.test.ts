/**
 * The Live Chat Companion with the REAL extension in a REAL Chrome, over the real bridge and Eya's real tools — against a WhatsApp-SHAPED page (wa.localhost:
 * the open chat is `#main`, messages are rows with the page's own `data-id`, "true_…" sent by the account and "false_…" received):
 *
 *   find_chat → the extension's watcher in the page → a message arrives → the page says so (an event with no content) → the controller reads the open chat →
 *   a reply is drafted → approve (typed in the box, not sent) / send (fill_on_page + click_on_page behind the Send gate) → verify_sent
 *
 * Opt-in: EYA_LIVE_BROWSER=1 npx vitest run tests/live/livechat.live.test.ts
 * NOT covered: the real WhatsApp Web (its page may be built differently from this mock: see the report), a real second person, a real AI model (the replies are
 * scripted here), a real signed-in profile.
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
import { ChatSession } from '../../src/main/chat/chatSession';
import { LiveChatController } from '../../src/main/livechat/LiveChatController';
import type { LiveChatDeps } from '../../src/main/livechat/LiveChatController';
import { LiveChatStore } from '../../src/main/livechat/LiveChatStore';
import { createChatActions, createChatWatcher } from '../../src/main/livechat/liveChatWiring';
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
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser, userCloseTab, userEval, userOpenTab, waitFor } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const BRIDGE_PORT = 47860;
const DEBUG_PORT = 9360;
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
const forbiddenIsolatedBrowser = new Proxy(
  {},
  { get: (_t, prop) => (prop === 'close' ? async () => undefined : () => Promise.reject(new Error(`Eya's separate browser window must not be used (${String(prop)})`))) },
) as BrowserAutomationService;

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('live chat: real extension, real Chrome, a WhatsApp-shaped page', () => {
  let site: { server: Server; port: number };
  let bridge: ChromeBridge;
  let world: BrowserWorldTracker;
  let browser: TestBrowser;
  let ext: { dir: string; cleanup: () => void };
  let stopSync: () => void;
  let store: CommunicationAccessStore;
  let policy: CommunicationPolicy;
  let manager: BrowserSessionManager;
  let session: ChatSession;
  let tools: Tool[];
  let controller: LiveChatController;
  const ai = new FakeAI();
  const io = new MemoryIo();
  const files = new Map<string, string>();
  const alerts: string[] = [];
  const notes: Array<{ op: string; category?: string; counts?: Readonly<Record<string, number>> }> = [];

  const pageUrl = () => `http://${HOST}:${site.port}/walive.html`;
  const call = (name: string, args: ToolArgs = {}): Promise<ToolResult> => {
    const tool = tools.find((t) => t.schema.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.execute(args);
  };
  const inPage = (expression: string) => userEval(DEBUG_PORT, HOST, expression);
  const view = () => controller.view();

  beforeAll(async () => {
    site = await startTestSite(0);
    ext = prepareExtensionCopy(BRIDGE_PORT);
    store = new CommunicationAccessStore('memory', { read: (p) => files.get(p) ?? null, write: (p, t) => void files.set(p, t) }, ['whatsapp']);
    store.load();
    store.set({ enabled: true, apps: {} });
    policy = new CommunicationPolicy(() => store.get(), [WHATSAPPISH]);

    bridge = new ChromeBridge({ secrets: new MemorySecrets(), port: BRIDGE_PORT });
    if (!(await bridge.start())) throw new Error(`port ${BRIDGE_PORT} is busy`);
    world = new BrowserWorldTracker();
    world.attach(bridge);
    stopSync = startPolicySync({ bridge, blockRules: () => policy.blockRules(), onPolicyChange: (l) => store.onChange(l) });
    bridge.openPairingWindow();

    browser = await startTestBrowser({ kind: 'chrome', extensionDir: ext.dir, debugPort: DEBUG_PORT });
    await waitFor(() => bridge.isConnected('chrome'), 45_000, 'the extension to connect and pair');

    const launcher: BrowserLauncher = { installed: async () => ['chrome'], running: async () => ['chrome'], launch: async () => false };
    manager = new BrowserSessionManager({ bridge, world, isolated: forbiddenIsolatedBrowser, launcher, mode: 'user_browser', policy });
    session = new ChatSession();
    const folders: KnownFolders = { home: 'C:\\x', downloads: 'C:\\x', desktop: 'C:\\x', documents: 'C:\\x', pictures: 'C:\\x', videos: 'C:\\x', music: 'C:\\x', temp: 'C:\\x' };
    tools = [
      ...createBrowserTools(manager, undefined, { tabs: manager, session: manager, chatGate: createChatSendGate(session, policy) }),
      ...createChatTools({ service: manager, policy, session, folders }),
    ];
    controller = makeController();
  }, 120_000);

  /** A live chat over the real bridge and tools. `extra` changes what a test needs (a short silence, say); `file` keeps a second controller's saved state apart. */
  const makeController = (extra: Partial<LiveChatDeps> = {}, file = 'live-chat.json'): LiveChatController => {
    const app = policy.apps().find((a) => a.id === 'whatsapp') as CommunicationApp;
    return new LiveChatController({
      store: new LiveChatStore(file, io),
      ai,
      watcher: createChatWatcher(bridge, manager),
      chat: createChatActions({ tools: { invoke: (name, args) => call(name, args) }, service: manager, session }),
      permits: () => null,
      allowed: () => (policy.allowed(app) ? null : 'Chats are switched off for WhatsApp in Eya.'),
      alert: (m) => alerts.push(m),
      diagnose: (e) => notes.push(e),
      reconcileMs: 0, // events are the only way new messages are noticed in this test
      ...extra,
    });
  };

  afterAll(async () => {
    await controller?.stop().catch(() => undefined);
    controller?.dispose();
    stopSync?.();
    browser?.kill();
    await bridge?.stop();
    site?.server.close();
    await sleep(500);
    browser?.cleanup();
    ext?.cleanup();
  }, 30_000);

  const drafted = async (text: string): Promise<number> => {
    const before = ai.calls;
    const started = Date.now();
    await inPage(`window.__receive(${JSON.stringify(text)})`);
    await waitFor(() => view().draft !== null && ai.calls > before && view().draft?.status !== 'stale' && (view().state === 'WAITING_FOR_APPROVAL'), 10_000, 'a reply to be drafted');
    return Date.now() - started;
  };

  it('the extension offers the live chat (chat_watch and chat_read)', () => {
    const caps = bridge.info().browsers['chrome']?.capabilities ?? [];
    expect(caps).toContain('chat_watch');
    expect(caps).toContain('chat_read');
  });

  it('start: Eya opens the chat, confirms it from the page, starts the watcher in it, and answers nothing that was already there', async () => {
    const opened = await call('open_website', { url: pageUrl() });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    await waitFor(async () => (await inPage('document.title')) === 'WhatsApp (mock for the live chat)', 10_000, 'the page to load');
    const res = await controller.start('Rahul Sharma');
    expect(res.view.state, res.message).toBe('ACTIVE');
    expect(res.view).toMatchObject({ chat: 'Rahul Sharma', verified: true, monitoring: 'event', mode: 'draft' });
    expect(await inPage('document.getElementById("chat-title").textContent')).toBe('Rahul Sharma');
    expect(ai.calls).toBe(0);
    // the one message that was already in the chat is old: not answered
    expect(view().recent.map((m) => m.text)).toEqual(['See you tomorrow']);
    expect(view().recent[0]?.handled).toBe(true);
  }, 90_000);

  it('a new incoming message reaches Eya as an event, is read from the open chat, and ONE draft is made — with nothing sent', async () => {
    ai.say('Yes, call me whenever you are free.');
    const ms = await drafted('Can we talk today?');
    console.log(`[live chat] incoming message → draft ready in ${ms} ms (model scripted: no model time in this number)`);
    expect(ai.calls).toBe(1);
    expect(view().draft).toMatchObject({ text: 'Yes, call me whenever you are free.', status: 'ready' });
    expect(ai.requests[0]).toContain('Them: Can we talk today?');
    expect(ai.requests[0]).not.toContain('Rahul Sharma');
    expect(await inPage('window.__sent.length')).toBe(0);
  }, 60_000);

  it('changes that are not new messages (typing marks, presence) make no event worth a draft', async () => {
    const before = ai.calls;
    for (let i = 0; i < 5; i += 1) await inPage('window.__noise()');
    await sleep(1500);
    expect(ai.calls).toBe(before);
    expect(view().state).toBe('WAITING_FOR_APPROVAL');
  }, 30_000);

  it('Draft mode: Approve types the reply into the page’s own message box and sends NOTHING; the person presses Send themself and Eya sees it', async () => {
    const res = await controller.handle({ kind: 'approve' });
    expect(res.ok, res.message).toBe(true);
    expect(await inPage('document.getElementById("msg").value')).toBe('Yes, call me whenever you are free.');
    expect(await inPage('window.__sent.length')).toBe(0);
    expect(view().draft?.status).toBe('in_box');
    await inPage('document.getElementById("send").click()'); // the PERSON presses Send
    await waitFor(() => view().draft?.status === 'sent', 10_000, 'Eya to see the person’s own send');
    await waitFor(async () => (await inPage('window.__sent.length')) === 1, 5000, 'the page to accept the message');
    expect(view().replies).toBe(1);
  }, 60_000);

  it('Assisted mode: the draft waits; Send sends exactly ONE message through the Send gate, and it is checked against the page', async () => {
    await controller.handle({ kind: 'set_mode', mode: 'assisted' });
    ai.say('Great, speak after lunch then.');
    await drafted('Good, call me after lunch');
    expect(await inPage('window.__sent.length')).toBe(1); // nothing new has gone
    const res = await controller.handle({ kind: 'send' });
    expect(res.ok, res.message).toBe(true);
    expect(res.message).toMatch(/Sent\./);
    await waitFor(async () => (await inPage('window.__sent.length')) === 2, 5000, 'the page to accept the message');
    expect(await inPage('window.__sent[1].text')).toBe('Great, speak after lunch then.');
    expect(view()).toMatchObject({ replies: 2, state: 'ACTIVE', draft: { status: 'sent' } });
    // pressing Send again sends nothing
    const again = await controller.handle({ kind: 'send' });
    expect(again.ok).toBe(false);
    await sleep(800);
    expect(await inPage('window.__sent.length')).toBe(2);
  }, 90_000);

  it('the conversation continues in the same session, with the earlier messages as context', async () => {
    const id = view().sessionId;
    ai.say('Okay, noted.');
    await drafted('Also bring the file tomorrow');
    expect(view().sessionId).toBe(id);
    const last = ai.requests[ai.requests.length - 1] as string;
    expect(last).toContain('Them: Can we talk today?');
    expect(last).toContain('Me: Great, speak after lunch then.');
    expect(last).toContain('Them: Also bring the file tomorrow');
    await controller.handle({ kind: 'discard' });
  }, 60_000);

  it('a message that arrives while a draft is waiting makes that draft stale; the old one is never the one sent', async () => {
    ai.say('First draft.');
    await drafted('Are you there?');
    ai.say('Second draft after the new message.');
    await inPage('window.__receive("Hello?? please reply")');
    await waitFor(() => view().draft?.text === 'Second draft after the new message.', 10_000, 'the draft to be written again');
    const sentBefore = (await inPage('window.__sent.length')) as number;
    expect(sentBefore).toBe(2);
    await controller.handle({ kind: 'discard' });
  }, 60_000);

  it('the person opening ANOTHER chat pauses it: nothing is drafted for that chat, nothing is sent', async () => {
    const before = ai.calls;
    await inPage('openChat(2)'); // the person opens Priya Singh's chat (the page's own function, as a click on her row would)
    await waitFor(() => view().state === 'PAUSED', 10_000, 'the live chat to pause');
    expect(view()).toMatchObject({ pause: 'chat_switched', monitoring: 'off' });
    await inPage('window.__receive("Hi, are you free?")');
    await sleep(1500);
    expect(ai.calls).toBe(before);
    expect(await inPage('window.__sent.length')).toBe(2);
  }, 60_000);

  it('Resume: back in the chosen chat it carries on, and answers what arrived meanwhile — once, and not what was already dealt with', async () => {
    await inPage('window.__receive("Please send me the document", 1)'); // arrives in Rahul Sharma's chat while the live chat is paused (his chat is not the one showing)
    await inPage('openChat(1)'); // the person goes back to Rahul Sharma
    const before = ai.calls;
    ai.say('Sure, I will send it.');
    const res = await controller.handle({ kind: 'resume' });
    expect(res.ok, res.message).toBe(true);
    await waitFor(() => view().draft?.text === 'Sure, I will send it.', 8000, 'the reply to the message that arrived while paused');
    expect(ai.calls).toBe(before + 1); // the earlier messages (already answered or discarded) were NOT drafted again
    expect(ai.requests[ai.requests.length - 1]).toContain('Them: Please send me the document');
    expect(view()).toMatchObject({ state: 'WAITING_FOR_APPROVAL', monitoring: 'event' });
    await controller.handle({ kind: 'discard' });
  }, 60_000);

  it('Stop: the watcher in the page is switched off and a later message does nothing', async () => {
    const res = await controller.handle({ kind: 'stop' });
    expect(res.ok).toBe(true);
    expect(view().state).toBe('STOPPED');
    const before = ai.calls;
    await inPage('window.__receive("Anyone there?")');
    await sleep(2000);
    expect(ai.calls).toBe(before);
    expect(await inPage('window.__sent.length')).toBe(2);
  }, 60_000);

  it('Communication Access switched off while it runs: the extension itself stops the watcher — no event reaches Eya — and nothing more is read', async () => {
    store.set({ enabled: true, apps: {} });
    const again = await controller.start('Rahul Sharma');
    expect(again.view.state, again.message).toBe('ACTIVE');
    let events = 0;
    const off = bridge.onBrowserEvent((e) => {
      if (e.name === 'chat_changed') events += 1;
    });
    // while Chats are ON an event does arrive (so the silence below means something)
    ai.say('Yes?');
    await inPage('window.__receive("Are you free now?")');
    await waitFor(() => events > 0, 8000, 'a chat event while Chats are on');
    await waitFor(() => view().state === 'WAITING_FOR_APPROVAL', 8000, 'the draft');
    await controller.handle({ kind: 'discard' });
    // the person switches Chats off: Eya's policy reaches the extension, which refuses the page's next event and tells the watcher to stop
    store.set({ enabled: false, apps: {} });
    await sleep(1500);
    const seen = events;
    const calls = ai.calls;
    await inPage('window.__receive("Hello, anyone there?")');
    await sleep(2500);
    expect(events).toBe(seen); // not one more event came out of the page
    expect(ai.calls).toBe(calls);
    off();
    // Eya's own side agrees: paused, and Resume is refused while Chats are off
    await controller.pause('access_off', 'Chats were switched off in Eya, so the live chat is paused.');
    expect(view().state).toBe('PAUSED');
    const resumed = await controller.handle({ kind: 'resume' });
    expect(resumed.ok).toBe(false);
    store.set({ enabled: true, apps: {} });
    await controller.handle({ kind: 'stop' });
  }, 90_000);

  // ------------------------------------------------------------------------- "a message had already come but it said no reply for minutes"
  it('AUTOMATIC replies, set up in one step: a new message gets a reply by itself — exactly one each time, within the limits the person set', async () => {
    const before = (await inPage('window.__sent.length')) as number;
    const started = await controller.start('Rahul Sharma');
    expect(started.view.state, started.message).toBe('ACTIVE');
    const on = await controller.handle({ kind: 'enable_auto', confirmedAware: true, maxReplies: 2, maxMinutes: 10, minGapSeconds: 5, introduce: false });
    expect(on.ok, on.message).toBe(true);
    expect(view()).toMatchObject({ mode: 'auto', auto: { maxReplies: 2, repliesSent: 0 } });

    ai.say('Good morning to you too!');
    const first = Date.now();
    await inPage('window.__receive("Good morning")');
    await waitFor(async () => (await inPage('window.__sent.length')) === before + 1, 10_000, 'the first automatic reply');
    console.log('[live chat] auto-reply: message → reply in the chat in ' + (Date.now() - first) + ' ms (model scripted)');
    expect(await inPage('window.__sent[' + before + '].text')).toBe('Good morning to you too!');
    await waitFor(() => view().replies >= 1 && view().state === 'ACTIVE', 8000, 'the send to be checked');
    expect(view().auto?.repliesSent).toBe(1);
    expect(ai.requests[ai.requests.length - 1]).toContain('Them: Good morning');

    ai.say('I am fine, thanks!');
    await sleep(5300); // the gap the person set
    await inPage('window.__receive("How are you?")');
    await waitFor(async () => (await inPage('window.__sent.length')) === before + 2, 10_000, 'the second automatic reply');
    expect(await inPage('window.__sent[' + (before + 1) + '].text')).toBe('I am fine, thanks!');

    // the limit was two: the third message waits for the person, and nothing more goes by itself
    await waitFor(() => view().mode === 'assisted' && view().auto === null, 8000, 'automatic replies to end at their limit');
    ai.say('A third reply.');
    await sleep(5300);
    await inPage('window.__receive("And your family?")');
    await waitFor(() => view().draft?.text === 'A third reply.' && view().state === 'WAITING_FOR_APPROVAL', 10_000, 'the third reply to wait for the person');
    await sleep(1000);
    expect(await inPage('window.__sent.length')).toBe(before + 2);
    await controller.handle({ kind: 'stop' });
  }, 120_000);

  it('BY DEFAULT (the person is watching) a reply that agrees to something goes out as the message comes in — and nothing is held back', async () => {
    const before = (await inPage('window.__sent.length')) as number;
    expect((await controller.start('Rahul Sharma')).view.state).toBe('ACTIVE');
    await controller.handle({ kind: 'enable_auto', confirmedAware: true, maxReplies: 5, maxMinutes: 10, minGapSeconds: 5, introduce: false });
    ai.say('Yes, I will come tomorrow.', { commitment: true, confidence: 'medium' });
    await inPage('window.__receive("Will you come tomorrow?")');
    await waitFor(async () => (await inPage('window.__sent.length')) === before + 1, 10_000, 'the reply to go out by itself');
    expect(await inPage('window.__sent[' + before + '].text')).toBe('Yes, I will come tomorrow.');
    expect(view()).toMatchObject({ mode: 'auto', auto: { holdBack: false } });
    await controller.handle({ kind: 'stop' });
  }, 60_000);

  it('WHEN ASKED TO HOLD BACK, a reply that promises something is NOT sent by itself, even in automatic mode: auto-reply stops and the person decides', async () => {
    const before = (await inPage('window.__sent.length')) as number;
    expect((await controller.start('Rahul Sharma')).view.state).toBe('ACTIVE');
    await controller.handle({ kind: 'enable_auto', confirmedAware: true, maxReplies: 5, maxMinutes: 10, minGapSeconds: 5, introduce: false, holdBack: true });
    ai.say('Yes, I will come tomorrow at 5', { commitment: true });
    await inPage('window.__receive("Will you come tomorrow?")');
    await waitFor(() => view().draft?.text === 'Yes, I will come tomorrow at 5' && view().state === 'WAITING_FOR_APPROVAL', 10_000, 'the draft to wait for the person');
    expect(view()).toMatchObject({ mode: 'assisted', auto: null });
    await sleep(1000);
    expect(await inPage('window.__sent.length')).toBe(before);
    await controller.handle({ kind: 'discard' });
    await controller.handle({ kind: 'stop' });
  }, 60_000);

  it('the FIRST message, when the person asked for it: nothing is written before automatic replies are on; then exactly one goes into the chat, and her answer is replied to after it', async () => {
    const before = (await inPage('window.__sent.length')) as number;
    const started = await controller.start('Rahul Sharma', undefined, 'she is my close friend, make her happy', true);
    expect(started.view.state, started.message).toBe('ACTIVE');
    expect(started.view.purpose).toMatch(/make her happy/);
    const calls = ai.calls;
    await sleep(1500);
    expect(ai.calls).toBe(calls); // Draft mode: nothing is written by itself
    expect(await inPage('window.__sent.length')).toBe(before);

    const opening = 'Hi! Just thinking of you, hope your day is going well. How are you?';
    ai.say(opening);
    const began = Date.now();
    const on = await controller.handle({ kind: 'enable_auto', confirmedAware: true, maxReplies: 3, maxMinutes: 10, minGapSeconds: 5 });
    expect(on.ok, on.message).toBe(true);
    await waitFor(async () => (await inPage('window.__sent.length')) === before + 1, 10_000, 'the first message to appear in the chat');
    console.log('[live chat] automatic replies on → first message in the chat in ' + (Date.now() - began) + ' ms (model scripted)');
    expect(await inPage('window.__sent[' + before + '].text')).toBe(opening);
    await waitFor(() => view().replies >= 1 && view().state === 'ACTIVE', 8000, 'the send to be checked');
    expect(ai.requests[ai.requests.length - 1]).toMatch(/make her happy/);
    expect(ai.requests[ai.requests.length - 1]).toMatch(/Write the first message/);
    await sleep(2500); // nothing more goes by itself, and the first message is not written again
    expect(await inPage('window.__sent.length')).toBe(before + 1);
    expect(ai.calls).toBe(calls + 1);

    // her answer is replied to after it, by the normal path
    ai.say('Aww, that is so kind of you!');
    await sleep(5300); // the gap the person set
    await inPage('window.__receive("I am good! How are you?")');
    await waitFor(async () => (await inPage('window.__sent.length')) === before + 2, 10_000, 'the reply to her answer');
    expect(await inPage('window.__sent[' + (before + 1) + '].text')).toBe('Aww, that is so kind of you!');
    expect(ai.requests[ai.requests.length - 1]).toContain('Eya: ' + opening); // (as Eya, the account's own lines she sent are hers: "Eya:")
    await controller.handle({ kind: 'stop' });
  }, 120_000);

  it('the connection to Eya dropping while a message arrives (the extension reconnects by itself): the live chat carries on, and answers the message once', async () => {
    expect((await controller.start('Rahul Sharma')).view.state).toBe('ACTIVE');
    // a real drop: the socket between the extension and Eya closes (as when the extension's worker restarts), while Eya stays up
    const conns = (bridge as unknown as { conns: Map<string, { ws: { terminate(): void } }> }).conns;
    ai.say('Sorry, I was away.');
    const calls = ai.calls;
    conns.get('chrome')?.ws.terminate();
    await waitFor(() => view().state === 'PAUSED' || view().state === 'WAITING_FOR_APPROVAL', 15_000, 'the live chat to notice the connection is gone');
    await inPage('window.__receive("Are you there? (sent while the connection was down)")');
    const back = Date.now();
    await waitFor(() => view().state === 'WAITING_FOR_APPROVAL', 60_000, 'the live chat to carry on by itself and draft the reply');
    console.log('[live chat] connection dropped → message answered with a draft in ' + (Date.now() - back) + ' ms after it arrived');
    expect(ai.calls).toBe(calls + 1); // answered once, not twice
    expect(view().draft?.text).toBe('Sorry, I was away.');
    expect(view().monitoring).toBe('event');
    expect(view().pause).toBeNull();
    // and a message after that is noticed by the page's own event again
    await controller.handle({ kind: 'discard' });
    ai.say('Yes?');
    await drafted('Hello again');
    await controller.handle({ kind: 'stop' });
  }, 150_000);

  it('with the WhatsApp tab in the BACKGROUND (another tab in front), a new message is still noticed at once', async () => {
    expect((await controller.start('Rahul Sharma')).view.state).toBe('ACTIVE');
    await userOpenTab(DEBUG_PORT, 'http://other.localhost:' + site.port + '/index.html');
    await sleep(1500);
    expect(await inPage('document.visibilityState')).toBe('hidden'); // (the test means nothing if the tab is still showing)
    ai.say('Yes, I can talk.');
    const ms = await drafted('Can we talk now?');
    console.log('[live chat] WhatsApp tab hidden: message → draft in ' + ms + ' ms (model scripted)');
    expect(ms).toBeLessThan(4000);
    await controller.handle({ kind: 'discard' });
    await controller.handle({ kind: 'stop' });
    await userCloseTab(DEBUG_PORT, 'other.localhost');
  }, 90_000);

  // ------------------------------------------------- the first real run: a chat with a number nobody has written to yet
  it('a NEW chat with only the page’s own notices in it (nothing written yet) is an empty chat, not an unreadable page: it starts, and the first message that comes is drafted', async () => {
    const res = await controller.start('Kiran Rao');
    expect(res.view.state, res.message).toBe('ACTIVE');
    expect(res.view).toMatchObject({ chat: 'Kiran Rao', verified: true });
    expect(view().recent).toEqual([]);
    ai.say('Hi, nice to hear from you!');
    await drafted('Hello! Who is this?');
    expect(view().draft?.text).toBe('Hi, nice to hear from you!');
    await controller.handle({ kind: 'discard' });
    await controller.handle({ kind: 'stop' });
  }, 90_000);

  it('a page whose messages cannot be told apart by side IS said to be unreadable — with counts and the page\'s masked shape, never a word of the chat — and nothing is watched', async () => {
    await inPage('window.__layout = "blind"; openChat(1)');
    const res = await controller.start('Rahul Sharma');
    expect(res.view).toMatchObject({ state: 'FAILED', pause: 'unreadable' });
    expect(res.view.error).toMatch(/cannot read reliably/);
    expect(res.view.error).toMatch(/I understood \d+ message rows by bubbles; the page shows \d+ rows in all and \d+ message marks\. I could not tell which side \d+ of them were on\./);
    expect(res.view.error).toMatch(/How the page is built: main=#aaaa; how=bubbles; counts=/);
    expect(res.view.error).not.toMatch(/See you tomorrow|Rahul|Sharma/);
    expect(res.view.error).not.toMatch(/2026|98765|99887|70000|98765|09:00|10:02/); // (nothing real from the page: the shape is masked — every letter is A or a, every digit 9)
    expect(res.view.error).toMatch(/pre=\[99:99, 99\/99\/9999\]/);
    await inPage('window.__layout = "ids"; openChat(1)');
  }, 60_000);

  // ------------------------------------------------- what the real page showed in the second real run
  it('a page whose message ids are not of the known shape (but whose bubbles say who wrote them) is READ: the sides come from the page\'s own marks, and a new message is drafted for', async () => {
    await inPage('window.__layout = "plain"; openChat(1)');
    const res = await controller.start('Rahul Sharma');
    expect(res.view.state, res.message).toBe('ACTIVE');
    // the sides were read from the page's own marks: what Eya and the person sent in this chat are 'out', what Rahul wrote is 'in'
    const sentTexts = (await inPage('window.__sent.map((m) => m.text)')) as string[];
    const before = view().recent;
    expect(before.length).toBeGreaterThan(0);
    for (const m of before) expect(m.dir === 'out', `${m.dir}: ${m.text.slice(0, 30)}`).toBe(sentTexts.includes(m.text));
    expect(before.some((m) => m.dir === 'out')).toBe(true);
    ai.say('See you!');
    await drafted('Are we meeting?');
    expect(view().recent[view().recent.length - 1]).toMatchObject({ dir: 'in', text: 'Are we meeting?' });
    expect(view().draft?.text).toBe('See you!');
    await controller.handle({ kind: 'discard' });
    await controller.handle({ kind: 'stop' });
    await inPage('window.__layout = "ids"; openChat(1)');
  }, 90_000);

  // ------------------------------------------------- the page as the third real run showed it: plain ids, nothing about direction in any id or class, one picture
  for (const layout of ['modern', 'modern-noticks'] as const) {
    it(`the page built as the real one is today (${layout === 'modern' ? 'with delivery ticks' : 'without ticks: only where each message is drawn tells its side'}): it is READ — a picture whose side is not in its words does not make it unreadable — and the next message is answered`, async () => {
      await inPage(`window.__layout = "${layout}"; openChat(1)`);
      await inPage('window.__receiveImage(1)');
      await inPage('window.__receiveImage(1, true)'); // (drawn in the middle: no id, class, tick, sender or position says whose it is)
      await inPage('window.__sendImageOut()');
      notes.length = 0;
      const res = await controller.start('Rahul Sharma');
      expect(res.view.state, res.message).toBe('ACTIVE');
      // every message has the side the page shows it on: what was sent from here is 'out', what Rahul wrote is 'in' — also where the sender's name is not the header's ("Rahul S.")
      const sentTexts = (await inPage('window.__sent.map((m) => m.text)')) as string[];
      const recent = view().recent;
      expect(recent.length).toBeGreaterThan(2);
      for (const m of recent.filter((x) => x.kind === 'text')) expect(m.dir === 'out', `${m.dir}: ${m.text.slice(0, 30)}`).toBe(sentTexts.includes(m.text));
      expect(recent.some((m) => m.kind === 'image' && m.dir === 'out')).toBe(true);
      expect(recent.some((m) => m.kind === 'image' && m.dir === 'in')).toBe(true);
      // how the sides were told is written down, as counts
      const ok = notes.find((n) => n.category === 'start_ok');
      expect(ok?.counts).toBeDefined();
      expect(ok?.counts?.['id'] ?? 0).toBe(0); // (no direction in any id)
      expect(ok?.counts?.['geo'] ?? 0).toBeGreaterThan(0);
      if (layout === 'modern') expect(ok?.counts?.['ticks'] ?? 0).toBeGreaterThan(0);
      expect(ok?.counts?.['dflt'] ?? 0).toBeGreaterThanOrEqual(1); // (the picture whose side could not be told was read as received, and counted as such: the page is still read; the chat keeps the pictures of the earlier layout test)
      expect(ok?.counts?.['conflicts'] ?? 0).toBeGreaterThan(0); // (the sender's name disagrees with the header: the layout was believed)
      ai.say('Sure, I will look at it.');
      await drafted('Can you check this?');
      expect(view().recent[view().recent.length - 1]).toMatchObject({ dir: 'in', text: 'Can you check this?' });
      expect(view().draft?.text).toBe('Sure, I will look at it.');
      await controller.handle({ kind: 'discard' });
      await controller.handle({ kind: 'stop' });
      await inPage('window.__layout = "ids"; openChat(1)');
    }, 90_000);
  }

  it('a chat that has unread messages (its row starts with "12 unread messages") is found by its name, not by that text', async () => {
    const res = await controller.start('Priya Singh');
    expect(res.view.state, res.message).toBe('ACTIVE');
    expect(res.view).toMatchObject({ chat: 'Priya Singh', verified: true });
    await controller.handle({ kind: 'stop' });
  }, 60_000);

  it('a number: the chat that is already open and shows exactly that number is the one — no searching, no "several chats fit"', async () => {
    await inPage('openChat(5)'); // the person opened the chat of an unsaved contact: the page names it by its number
    const res = await controller.start('+91 70000 11122');
    expect(res.view.state, res.message).toBe('ACTIVE');
    expect(res.view.verified).toBe(true);
    expect(res.view.chat).toMatch(/1122$/); // (a number is shown with all but its last four digits hidden)
    expect(res.view.chat ?? '').not.toMatch(/70000/);
    await controller.handle({ kind: 'stop' });
  }, 60_000);

  it('a number that is not open yet: the page\'s own search finds the chat — and the rows of the conversation ("end-to-end encrypted") and the unread badge are never offered as chats', async () => {
    await inPage('openChat(2)'); // another chat is open, with its own notices around it
    const res = await controller.start('+91 98765 08501');
    // (a chat found only by the digits of its number is a likely match until the person confirms it: either way it is the right chat, offered by its name)
    expect(['ACTIVE', 'WAITING_FOR_USER']).toContain(res.view.state);
    const offered = [res.view.chat ?? '', res.view.confirmChat ?? '', ...res.view.choices.map((c) => c.label)].join(' | ');
    expect(offered).not.toMatch(/unread|encrypted/i);
    expect(offered).toMatch(/Kiran Rao/);
    await controller.handle({ kind: 'stop' });
  }, 60_000);

  // ------------------------------------------------- "introduce yourself, ask what they want, tell me what they say, and wait until I pause it"
  it('INTRODUCES herself in the chat, takes down what Rahul wants passed on, and — when the person only looks at another chat and comes back — carries on by herself', async () => {
    await inPage('window.__unrecognised = false; openChat(1)');
    const before = (await inPage('window.__sent.length')) as number;
    const intro = 'Hi! I am Eya, an assistant 😊 What do you want? I will pass it on.';
    ai.say(intro);
    const res = await controller.start('Rahul Sharma', undefined, 'a close friend, be lively', undefined, true);
    expect(res.message, res.message).toMatch(/Automatic replies are ON/);
    await waitFor(async () => (await inPage('window.__sent.length')) === before + 1, 15_000, 'the introduction to appear in the chat');
    expect(await inPage('window.__sent[' + before + '].text')).toBe(intro);
    expect(ai.requests[ai.requests.length - 1]).toMatch(/I am Eya, an assistant/);
    expect(view().auto).toMatchObject({ maxReplies: null, until: null }); // no limit: it waits until the person pauses or stops it

    // she asks for something for the person: Eya answers, and takes it down
    ai.say('Sure, I will tell him!', { for_owner: 'Rahul asks you to call him' });
    await sleep(10_500); // (the gap between two replies)
    await inPage('window.__receive("Please ask him to call me")');
    await waitFor(async () => (await inPage('window.__sent.length')) === before + 2, 20_000, 'the reply');
    expect(view().forYou.map((n) => n.text)).toEqual(['Rahul asks you to call him']);
    expect(alerts.some((a) => /has something for you/.test(a))).toBe(true);

    // the person looks at another chat: it waits; when they are back in this one it carries on by itself
    await waitFor(() => view().replies >= 2 && view().state === 'ACTIVE', 15_000, 'the reply to be checked in the chat (before the person looks away)');
    await inPage('openChat(2)');
    await waitFor(() => view().state === 'PAUSED' && view().pause === 'chat_switched', 12_000, 'the live chat to wait while another chat is open');
    await inPage('openChat(1)');
    await waitFor(() => view().state === 'ACTIVE' && view().pause === null, 25_000, 'the live chat to carry on by itself');
    ai.say('Welcome back!');
    await sleep(10_500);
    await inPage('window.__receive("Hello again")');
    await waitFor(async () => (await inPage('window.__sent.length')) === before + 3, 20_000, 'the reply after coming back');
    expect(await inPage('window.__sent[' + (before + 2) + '].text')).toBe('Welcome back!');
    await controller.handle({ kind: 'stop' });
  }, 240_000);

  // ------------------------------------------------- "when the other person takes time to answer the chat must not just be gone: keep them engaged"
  it('a QUIET chat is checked on once, through the real extension (a friendly line goes into the chat); a "yes" to it is answered; it ends only after a second silence', async () => {
    await inPage('window.__unrecognised = false; openChat(1)');
    const before = (await inPage('window.__sent.length')) as number;
    // (12 seconds stand in for the fifteen minutes — longer than the ten seconds that are kept between two automatic replies)
    const quick = makeController({ idleStopMs: 12_000 }, 'live-chat-quiet.json');
    try {
      const intro = 'Hi! I am Eya, Rakesh\'s assistant 😊 What do you need?';
      const check = 'Still around? Anything you want me to tell Rakesh? 😊';
      ai.say(intro);
      ai.say(check);
      const started = Date.now();
      const res = await quick.start('Rahul Sharma', undefined, undefined, undefined, true);
      expect(res.message, res.message).toMatch(/Automatic replies are ON/);
      await waitFor(async () => (await inPage('window.__sent.length')) === before + 1, 15_000, 'the introduction');
      // nobody writes: after the silence, ONE check-in goes into the chat
      await waitFor(async () => (await inPage('window.__sent.length')) === before + 2, 40_000, 'the check-in to appear in the chat');
      console.log(`[live chat] quiet chat → one check-in in the chat after ${Date.now() - started} ms (12 s silence stands for 5 min; model scripted)`);
      expect(await inPage('window.__sent[' + (before + 1) + '].text')).toBe(check);
      await waitFor(() => quick.view().state === 'ACTIVE', 15_000, 'the check-in to be checked in the chat'); // (the check on the page comes right after Send)
      expect(ai.requests[ai.requests.length - 1]).toMatch(/The other person has gone quiet/);
      // they answer the question with one word: that is answered, it is not mistaken for the closing "ok" of a chat
      ai.say('Great, tell me and I will pass it on.');
      await inPage('window.__receive("yes")');
      await waitFor(async () => (await inPage('window.__sent.length')) === before + 3, 30_000, 'the answer to "yes"');
      expect(await inPage('window.__sent[' + (before + 2) + '].text')).toBe('Great, tell me and I will pass it on.');
      // ...and now it is quiet again: a new silence gets its own check-in, and a silence after THAT ends it, saying so
      ai.say('No rush! Whenever you are ready.');
      await waitFor(async () => (await inPage('window.__sent.length')) === before + 4, 40_000, 'a second check-in after a new silence');
      await waitFor(() => quick.view().state === 'STOPPED', 40_000, 'the chat to end after a silence that followed the check-in');
      expect(quick.view().notice).toMatch(/even after I checked in/);
      expect(await inPage('window.__sent.length')).toBe(before + 4); // (nothing more went into the chat)
    } finally {
      await quick.stop().catch(() => undefined);
      quick.dispose();
    }
  }, 240_000);
});
