/**
 * Pictures and documents in a live chat, with the REAL extension in a REAL Chrome, over the real bridge, against a WhatsApp-SHAPED page (wa.localhost): a picture the page holds
 * as a blob, a document whose download button starts a real browser download into a throwaway folder, a program that is never downloaded, a picture that has not loaded.
 *
 *   a message arrives → the extension finds the bubble by the same id the reader gives it → a picture's own bytes (or a document's download, pressed once) → checked → written
 *   to / found in the Downloads folder (a throwaway one here) → "read" (the document reader is scripted) → the reply is drafted from what was found, and Rakesh is told
 *
 * Opt-in: EYA_LIVE_BROWSER=1 npx vitest run tests/live/livechatmedia.live.test.ts
 * NOT covered: the real WhatsApp Web (its picture and document bubbles may be built differently from this mock — the first real attempt will say, in the diagnostics, what the page
 * offered), Chrome's own "this site is downloading multiple files" protection against several automatic downloads in a row in one tab (see the last test), a real model reading the files.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { LiveChatStore } from '../../src/main/livechat/LiveChatStore';
import { createChatMedia } from '../../src/main/livechat/liveChatMedia';
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
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser, userEval, waitFor } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const BRIDGE_PORT = 47862;
const DEBUG_PORT = 9362;
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

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('live chat media: real extension, real Chrome, a WhatsApp-shaped page', () => {
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
  const said: Array<{ spoken: string; shown: string }> = [];
  const reads: string[] = [];

  const pageUrl = () => `http://${HOST}:${site.port}/walive.html`;
  const call = (name: string, args: ToolArgs = {}): Promise<ToolResult> => {
    const tool = tools.find((t) => t.schema.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.execute(args);
  };
  const inPage = (expression: string) => userEval(DEBUG_PORT, HOST, expression);
  const view = () => controller.view();
  const inDownloads = (): string[] => readdirSync(browser.downloads).filter((n) => !n.endsWith('.crdownload') && !n.endsWith('.tmp'));

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
    const folders: KnownFolders = { home: 'C:\\x', downloads: browser.downloads, desktop: 'C:\\x', documents: 'C:\\x', pictures: 'C:\\x', videos: 'C:\\x', music: 'C:\\x', temp: 'C:\\x' };
    tools = [
      ...createBrowserTools(manager, undefined, { tabs: manager, session: manager, chatGate: createChatSendGate(session, policy) }),
      ...createChatTools({ service: manager, policy, session, folders }),
    ];
    const app = policy.apps().find((a) => a.id === 'whatsapp') as CommunicationApp;
    controller = new LiveChatController({
      store: new LiveChatStore('live-chat.json', io),
      ai,
      watcher: createChatWatcher(bridge, manager),
      chat: createChatActions({ tools: { invoke: (name, args) => call(name, args) }, service: manager, session }),
      permits: () => null,
      allowed: () => (policy.allowed(app) ? null : 'Chats are switched off for WhatsApp in Eya.'),
      alert: () => undefined,
      say: (spoken, shown) => said.push({ spoken, shown }),
      // (the real wiring over the real browser and a real folder — the throwaway downloads folder of this test browser; only the document READER is scripted)
      media: createChatMedia({
        service: manager,
        downloadsDir: browser.downloads,
        tools: {
          invoke: async (_name, args): Promise<ToolResult> => {
            reads.push(String(args['path']));
            return { ok: true, summary: 'read', data: { answer: /\.png$/i.test(String(args['path'])) ? 'A plain coloured square.' : 'A mock contract between two people.' } };
          },
        },
      }),
      reconcileMs: 0,
      idleStopMs: 0,
    });
  }, 120_000);

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

  /** A file arrives from "the other person": the reply is drafted once Eya has looked at it. */
  const arrives = async (hook: string, reply: string): Promise<void> => {
    const before = ai.calls;
    ai.say(reply);
    await inPage(hook);
    await waitFor(() => ai.calls > before && view().draft !== null && view().draft?.status !== 'stale' && view().state === 'WAITING_FOR_APPROVAL', 25_000, 'a reply to be drafted');
  };
  const discard = async (): Promise<void> => {
    await controller.handle({ kind: 'discard' });
    await waitFor(() => view().state === 'ACTIVE', 5_000, 'back to watching');
  };

  it('the extension offers taking a file out of a chat (chat_media)', () => {
    expect(bridge.info().browsers['chrome']?.capabilities ?? []).toContain('chat_media');
    expect(bridge.info().browsers['chrome']?.capabilities ?? []).toContain('chat_documents');
  });

  it('start: the chat is open on the page as the modern layout shows it', async () => {
    const opened = await call('open_website', { url: pageUrl() });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    await waitFor(async () => (await inPage('document.title')) === 'WhatsApp (mock for the live chat)', 10_000, 'the page to load');
    await inPage('window.__layout = "modern"; openChat(1)');
    const res = await controller.start('Rahul Sharma');
    expect(res.view.state, res.message).toBe('ACTIVE');
  }, 90_000);

  it('a PICTURE the page holds: its own bytes are saved in Downloads under a new name, read, and the reply is written from what was found', async () => {
    await arrives('window.__receivePicture(1)', 'aww nice pic! what is it for?');
    const png = inDownloads().filter((n) => /^WhatsApp picture .*\.png$/.test(n));
    expect(png, `Downloads has: ${inDownloads().join(', ')}`).toHaveLength(1);
    const bytes = readFileSync(join(browser.downloads, png[0] as string));
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(bytes.length).toBeGreaterThan(50);
    expect(reads).toEqual([join(browser.downloads, png[0] as string)]);
    expect(ai.requests.at(-1) ?? '').toMatch(/Them: \[picture they sent — it shows or says: A plain coloured square\.\]/);
    expect(view().draft?.text).toBe('aww nice pic! what is it for?');
    expect(said.at(-1)?.spoken).toMatch(/^Rahul Sharma sent a picture\. It is saved in your Downloads folder\. It shows: A plain coloured square\. Tell me what to answer/);
    expect(view().recent.find((m) => m.kind === 'image')?.text).toMatch(/^WhatsApp picture .*\.png \(saved in Downloads\)$/);
    await discard();
  }, 90_000);

  it('a DOCUMENT: its own download button is pressed once, the browser saves it in Downloads, it is read, and the reply is written from what was found', async () => {
    const before = await inPage('window.__downloadsPressed.length');
    // (the real page's shape: the file name is selectable words with its size line beneath it — a bubble with words in it. Before 0.11.6 such a bubble was read as a TEXT message, and a PDF was never taken.)
    await arrives('window.__receiveDocument("contract.pdf", null, { words: true })', 'got the contract! why did you send it?');
    expect(await inPage('window.__downloadsPressed')).toEqual(['contract.pdf']);
    expect(Number(before)).toBe(0);
    expect(existsSync(join(browser.downloads, 'contract.pdf'))).toBe(true);
    expect(readFileSync(join(browser.downloads, 'contract.pdf'), 'utf8')).toBe('%PDF-1.4 mock of contract.pdf');
    expect(ai.requests.at(-1) ?? '').toMatch(/Them: \[document "contract\.pdf" they sent — it shows or says: A mock contract between two people\.\]/);
    expect(said.at(-1)?.spoken).toMatch(/Rahul Sharma sent a document called contract\.pdf\. It is saved in your Downloads folder\. It says: A mock contract between two people\./);
    await discard();
  }, 90_000);

  it('a PROGRAM is never downloaded: its button is not pressed, nothing lands in Downloads, the reply says it could not be opened', async () => {
    const filesBefore = inDownloads().sort();
    await arrives('window.__receiveDocument("setup.exe")', 'thanks for sending, what is it?');
    expect(await inPage('window.__downloadsPressed')).toEqual(['contract.pdf']); // (no new press)
    expect(inDownloads().sort()).toEqual(filesBefore);
    expect(ai.requests.at(-1) ?? '').toMatch(/\[document they sent — I could not open it\]|\[document "[^"]*" they sent — I could not open it\]/);
    expect(said.at(-1)?.spoken).toMatch(/sent a document, but I could not open it: It is a file of a type I do not take \(setup\.exe\)/);
    await discard();
  }, 90_000);

  it('a picture that has not loaded on the page yet is not a picture to take: nothing is written, and the reply asks what it is', async () => {
    const filesBefore = inDownloads().sort();
    await arrives('window.__receivePicture(1, false)', 'thanks, what is it?');
    expect(inDownloads().sort()).toEqual(filesBefore);
    expect(ai.requests.at(-1) ?? '').toMatch(/\[picture they sent — I could not open it\]/);
    await discard();
  }, 90_000);

  it('a message the account itself sent is never taken from: the extension refuses', async () => {
    await inPage('window.__sendImageOut()');
    await sleep(600);
    const read = await manager.chatRead(30);
    expect(read.ok).toBe(true);
    const mine = read.ok ? [...read.messages].reverse().find((m) => m.dir === 'out' && m.kind === 'image') : undefined;
    expect(mine, 'the account\'s own picture is in the chat').toBeDefined();
    const taken = await manager.chatMedia((mine as { id: string }).id, 'look');
    expect(taken).toMatchObject({ ok: false, reason: 'not_incoming' });
  }, 60_000);

  it('a message that is not on the page, or not a picture or document, is refused', async () => {
    expect(await manager.chatMedia('wa_does_not_exist', 'look')).toMatchObject({ ok: false, reason: 'not_found' });
    const read = await manager.chatRead(30);
    const text = read.ok ? read.messages.find((m) => m.dir === 'in' && m.kind === 'text') : undefined;
    expect(text).toBeDefined();
    expect(await manager.chatMedia((text as { id: string }).id, 'look')).toMatchObject({ ok: false, reason: 'not_media' });
  }, 60_000);

  it('(information) a SECOND document in the same tab with nobody touching the page: whether the browser allows it is Chrome\'s own protection against automatic downloads', async () => {
    const before = inDownloads().length;
    await arrives('window.__receiveDocument("second.pdf")', 'and this one? what is it?');
    const landed = existsSync(join(browser.downloads, 'second.pdf'));
    console.log(`[live chat media] a second automatic download in the same tab: ${landed ? 'LANDED in Downloads' : 'did NOT land (Chrome blocked or did not start it); Eya said: ' + (said.at(-1)?.spoken ?? '').slice(0, 160)}; Downloads had ${before} files before`);
    // either way the live chat goes on and a reply is waiting
    expect(view().state).toBe('WAITING_FOR_APPROVAL');
    await discard();
  }, 90_000);

  it('the real shapes of a document bubble: with its file name as words in it it is a DOCUMENT and not a text message; with a download arrow that has no name, the document\'s own button is found', async () => {
    await controller.handle({ kind: 'pause' }); // (the live chat would take both documents itself, and Chrome allows one automatic download per tab: here they are only looked at)
    await inPage('window.__receiveDocument("words.pdf", null, { words: true })');
    await inPage('window.__receiveDocument("bare.pdf", null, { words: true, bare: true })');
    await sleep(700);
    const read = await manager.chatRead(40);
    expect(read.ok).toBe(true);
    const incoming = read.ok ? read.messages.filter((x) => x.dir === 'in') : [];
    const words = incoming.find((x) => /words\.pdf/.test(x.text));
    const bare = incoming.find((x) => /bare\.pdf/.test(x.text));
    expect(words?.kind, 'a document with its name as words in the bubble is a document').toBe('document');
    expect(bare?.kind).toBe('document');
    expect(await manager.chatMedia((words as { id: string }).id, 'look')).toMatchObject({ ok: true, via: 'document', name: 'words.pdf', hasControl: true });
    // (no download arrow with a name: the button the document's own icon sits in is the control — and the page's icon names are reported, for the day the real page differs)
    const looked = await manager.chatMedia((bare as { id: string }).id, 'look');
    expect(looked).toMatchObject({ ok: true, via: 'document', name: 'bare.pdf', hasControl: true });
    expect(looked.ok && looked.via === 'document' ? looked.icons : []).toContain('document-pdf');
    // an ordinary text message that merely MENTIONS a file name is still text (no icon, no download control)
    await inPage('window.__receive("please read report.pdf tonight")');
    await sleep(700);
    const again = await manager.chatRead(40);
    const mention = again.ok ? again.messages.find((x) => x.dir === 'in' && /report\.pdf/.test(x.text)) : undefined;
    expect(mention?.kind, 'words that merely name a file are still a text message').toBe('text');
  }, 60_000);
});
