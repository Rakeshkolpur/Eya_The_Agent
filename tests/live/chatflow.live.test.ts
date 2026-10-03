/**
 * The whole "send a file in a chat app" flow with the REAL extension in a REAL Chrome, through Eya's real tools — against two
 * mock chat apps that are built nothing alike (a WhatsApp-style page on chat.localhost and a Telegram-style page on
 * tele.localhost), to show nothing here is written for one app:
 *
 *   find_chat → (ask which one) → attach_file (asks, then attaches the real bytes, in pieces) → Send → verify_sent
 *
 * Opt-in: EYA_LIVE_BROWSER=1 npx vitest run tests/live/chatflow.live.test.ts
 * Not covered: the real WhatsApp, Telegram or Instagram, a real signed-in profile, a real phone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChromeBridge } from '../../src/main/chrome/ChromeBridge';
import type { SecretStore } from '../../src/main/chrome/ChromeBridge';
import { BrowserWorldTracker } from '../../src/main/chrome/browserWorld';
import { BrowserSessionManager } from '../../src/main/browser/BrowserSessionManager';
import type { BrowserLauncher } from '../../src/main/browser/BrowserSessionManager';
import type { BrowserAutomationService } from '../../src/main/browser/BrowserAutomationService';
import type { BrowserName } from '../../src/main/chrome/protocol';
import { ChatSession } from '../../src/main/chat/chatSession';
import { CommunicationPolicy } from '../../src/main/privacy/communicationAccess';
import type { CommunicationApp } from '../../src/main/privacy/communicationAccess';
import { CommunicationAccessStore } from '../../src/main/privacy/communicationAccessStore';
import { startPolicySync } from '../../src/main/privacy/policySync';
import type { KnownFolders } from '../../src/main/security/pathPolicy';
import { createArchiveTools } from '../../src/main/tools/impl/archiveTools';
import { createBrowserTools } from '../../src/main/tools/impl/browserTools';
import { createChatSendGate, createChatTools } from '../../src/main/tools/impl/chatTools';
import type { Tool, ToolArgs, ToolResult } from '../../src/main/tools/types';
import { startTestSite } from '../fixtures/chrome-test-site/server.mjs';
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser, userEval, waitFor } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const BRIDGE_PORT = 47837;
const DEBUG_PORT = 9346;

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

const WHATSAPPISH: CommunicationApp = { id: 'mockchat', name: 'MockChat', hosts: [{ host: 'chat.localhost' }], processes: [], titleHints: [] };
const TELEGRAMISH: CommunicationApp = { id: 'telemock', name: 'TeleMock', hosts: [{ host: 'tele.localhost' }], processes: [], titleHints: [] };

const forbiddenIsolatedBrowser = new Proxy(
  {},
  { get: (_t, prop) => (prop === 'close' ? async () => undefined : () => Promise.reject(new Error(`Eya's separate browser window must not be used (${String(prop)})`))) },
) as BrowserAutomationService;

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('send a file in a chat app: real extension, real Chrome, two differently built chat apps', () => {
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
  let work = '';
  let folders: KnownFolders;
  const files = new Map<string, string>();

  const chatUrl = () => `http://chat.localhost:${site.port}/chat.html`;
  const teleUrl = () => `http://tele.localhost:${site.port}/telechat.html`;
  const call = (name: string, args: ToolArgs = {}): Promise<ToolResult> => {
    const tool = tools.find((t) => t.schema.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.execute(args);
  };
  const inPage = (tab: 'chat.localhost' | 'tele.localhost', expression: string) => userEval(DEBUG_PORT, tab, expression);
  const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

  beforeAll(async () => {
    site = await startTestSite(0);
    ext = prepareExtensionCopy(BRIDGE_PORT);

    // Files must be under the user's home to be allowed (the temp folder is inside AppData, which is protected).
    const home = process.env['USERPROFILE'] ?? '';
    work = mkdtempSync(join(home, 'eya-chat-live-'));
    folders = { home, downloads: join(home, 'Downloads'), desktop: join(home, 'Desktop'), documents: join(home, 'Documents'), pictures: join(home, 'Pictures'), videos: join(home, 'Videos'), music: join(home, 'Music'), temp: join(work, 'temp') };

    store = new CommunicationAccessStore('memory', { read: (p) => files.get(p) ?? null, write: (p, t) => void files.set(p, t) }, ['mockchat', 'telemock']);
    store.load();
    store.set({ enabled: true, apps: {} }); // the user has switched Communication Access on
    policy = new CommunicationPolicy(() => store.get(), [WHATSAPPISH, TELEGRAMISH]);

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
    tools = [
      ...createBrowserTools(manager, undefined, { tabs: manager, session: manager, chatGate: createChatSendGate(session, policy) }),
      ...createChatTools({ service: manager, policy, session, folders }),
      ...createArchiveTools(folders),
    ];
  }, 120_000);

  afterAll(async () => {
    stopSync?.();
    browser?.kill();
    await bridge?.stop();
    site?.server.close();
    await sleep(500);
    browser?.cleanup();
    ext?.cleanup();
    if (work !== '') rmSync(work, { recursive: true, force: true });
  }, 30_000);

  // ----------------------------------------------------------------------------------- the WhatsApp-style app
  describe('a WhatsApp-style app (chat.localhost)', () => {
    const report = () => join(work, 'report.pdf');

    it('opens the app, then finds a chat by a first name two people share: it asks which, and has touched nothing', async () => {
      writeFileSync(report(), Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(7 * 1024 * 1024 + 123, 0x5a), Buffer.from('\n%%EOF')])); // over two 3 MB parts
      const opened = await call('open_website', { url: chatUrl() });
      expect(opened.ok, JSON.stringify(opened)).toBe(true);
      await waitFor(async () => (await inPage('chat.localhost', 'document.title')) === 'MockChat Web', 10_000, 'the chat app to load');

      const r = await call('find_chat', { query: 'Rahul' });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.data?.['status']).toBe('ambiguous');
      expect((r.data?.['candidates'] as Array<{ label: string }>).map((c) => c.label)).toEqual(['Rahul Sharma', 'Rahul Verma']);
      // What the model was told contains no preview text, no other contacts, no numbers.
      const told = JSON.stringify(r);
      for (const secret of ['See you tomorrow', 'Priya', 'Mum', 'Amit', 'Meera', '98765', '10:42']) expect(told).not.toContain(secret);
      expect(await inPage('chat.localhost', 'document.getElementById("chat-title").textContent')).toBe('Select a chat');
    }, 90_000);

    it('after the user picks one, that chat — and only that chat — is opened', async () => {
      const r = await call('find_chat', { choice: 2 });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.data).toMatchObject({ status: 'opened', chat: 'Rahul Verma', headerChecked: true });
      expect(await inPage('chat.localhost', 'document.getElementById("chat-title").textContent')).toBe('Rahul Verma');
    }, 60_000);

    it('a number is found through the app\'s own search ("ending 70432" is one person)', async () => {
      const r = await call('find_chat', { query: 'the number ending 70432' });
      expect(r.data).toMatchObject({ status: 'opened', chat: 'Priya Singh' });
      expect(await inPage('chat.localhost', 'document.getElementById("chat-title").textContent')).toBe('Priya Singh');
    }, 60_000);

    it('attaching asks first, naming the person and the file, and attaches nothing until the user says yes', async () => {
      await call('find_chat', { query: 'Rahul Sharma' });
      const q = await call('attach_file', { path: report() });
      expect(q.ok).toBe(false);
      expect(q.summary).toBe('needs confirmation');
      expect(q.data?.['question']).toBe('Found Rahul Sharma, number ending in 432. Send the file "report.pdf" to this chat?');
      expect(await inPage('chat.localhost', 'window.__picked === undefined')).toBe(true);
    }, 60_000);

    it('this app has no file picker until its attach menu is opened: it says so; after the menu is opened it works', async () => {
      const early = await call('attach_file', { path: report(), confirm: true });
      expect(early.ok).toBe(false);
      expect(early.summary).toBe('no file picker yet');
      expect(early.error).toMatch(/attach menu/);
      expect(early.error).toMatch(/Do not click Document or Photos/);

      const menu = await call('click_on_page', { text: 'Attach' });
      expect(menu.ok, JSON.stringify(menu)).toBe(true);
      const done = await call('attach_file', { path: report(), confirm: true });
      expect(done.ok, JSON.stringify(done)).toBe(true);
      expect(done.data).toMatchObject({ status: 'attached_not_sent', file: 'report.pdf', chat: 'Rahul Sharma' });
    }, 120_000);

    it('the page received EXACTLY the bytes of the real file, across several parts', async () => {
      const got = (await inPage(
        'chat.localhost',
        `(async () => { const f = document.getElementById('doc-input').files[0]; const buf = await f.arrayBuffer(); const h = await crypto.subtle.digest('SHA-256', buf); return JSON.stringify({ name: f.name, size: f.size, type: f.type, sha: Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('') }); })()`,
      )) as string;
      const info = JSON.parse(got) as { name: string; size: number; type: string; sha: string };
      expect(info).toMatchObject({ name: 'report.pdf', type: 'application/pdf', size: readFileSync(report()).length });
      expect(info.sha).toBe(sha(report()));
    }, 60_000);

    it('nothing has been sent yet: the app shows its preview and is waiting', async () => {
      expect(await inPage('chat.localhost', 'JSON.stringify(window.__sent)')).toBe('[]');
      expect(await inPage('chat.localhost', 'document.getElementById("preview").hidden')).toBe(false);
    });

    it('the Send click goes ahead without asking again (the user already said yes to exactly this), and verify_sent confirms from the app\'s own mark', async () => {
      const sent = await call('click_on_page', { text: 'Send' });
      expect(sent.ok, JSON.stringify(sent)).toBe(true);
      const v = await call('verify_sent', {});
      expect(v.ok, JSON.stringify(v)).toBe(true);
      expect(v.data).toMatchObject({ status: 'sent', file: 'report.pdf' });
      expect(await inPage('chat.localhost', 'JSON.stringify(window.__sent)')).toContain('report.pdf');
    }, 60_000);

    it('a typed message is a different send: it asks (naming who) before anything goes', async () => {
      const typed = await call('fill_on_page', { label: 'Type a message', value: 'On my way' });
      expect(typed.ok, JSON.stringify(typed)).toBe(true);
      const q = await call('click_on_page', { text: 'Send' });
      expect(q.ok).toBe(false);
      expect(q.summary).toBe('needs confirmation');
      expect(q.data?.['question']).toBe('Found Rahul Sharma, number ending in 432. Send this message to this chat?');
      expect(await inPage('chat.localhost', 'window.__sent.length')).toBe(1); // still just the file
      const yes = await call('click_on_page', { text: 'Send', confirm: true });
      expect(yes.ok).toBe(true);
      const v = await call('verify_sent', { text: 'On my way' });
      expect(v.data).toMatchObject({ status: 'sent' });
    }, 60_000);

    it('a send the app reports as failed is reported as failed — never as done', async () => {
      writeFileSync(join(work, 'fail-this.pdf'), 'x'.repeat(2000));
      await call('click_on_page', { text: 'Attach' });
      const done = await call('attach_file', { path: join(work, 'fail-this.pdf'), confirm: true });
      expect(done.ok, JSON.stringify(done)).toBe(true);
      await call('click_on_page', { text: 'Send' });
      const v = await call('verify_sent', {});
      expect(v.ok).toBe(false);
      expect(v.data).toMatchObject({ status: 'failed' });
    }, 90_000);

    it('a FOLDER is zipped (a copy), and the zip is what goes — Hello 2, the example from real use', async () => {
      const folder = join(work, 'Hello 2');
      mkdirSync(join(folder, 'inner'), { recursive: true });
      writeFileSync(join(folder, 'one.txt'), 'first');
      writeFileSync(join(folder, 'inner', 'two.txt'), 'second');
      const refused = await call('attach_file', { path: folder, confirm: true });
      expect(refused.summary).toBe('that is a folder');
      const zipped = await call('zip_folder', { path: folder });
      expect(zipped.ok, JSON.stringify(zipped)).toBe(true);
      expect(zipped.data).toMatchObject({ name: 'Hello 2.zip', files: 2, verified: true });
      const zip = zipped.data?.['path'] as string;
      expect(existsSync(zip)).toBe(true);

      await call('find_chat', { query: 'Mum' });
      await call('click_on_page', { text: 'Attach' });
      const done = await call('attach_file', { path: zip, confirm: true });
      expect(done.ok, JSON.stringify(done)).toBe(true);
      expect(await inPage('chat.localhost', 'window.__picked.name')).toBe('Hello 2.zip');
      await call('click_on_page', { text: 'Send' });
      expect((await call('verify_sent', {})).data).toMatchObject({ status: 'sent', file: 'Hello 2.zip' });
      expect(readFileSync(join(folder, 'one.txt'), 'utf8')).toBe('first'); // the original is untouched
    }, 120_000);
  });

  // ------------------------------------------------------------------------------------ the Telegram-style app
  describe('a Telegram-style app built completely differently (tele.localhost)', () => {
    it('finds a chat by name, opens it, and the same tools work on this other page', async () => {
      const opened = await call('open_website', { url: teleUrl() });
      expect(opened.ok, JSON.stringify(opened)).toBe(true);
      await waitFor(async () => (await inPage('tele.localhost', 'document.title')) === 'TeleMock', 10_000, 'the page to load');
      const r = await call('find_chat', { query: 'Uber' });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.data).toMatchObject({ status: 'opened', chat: 'Uber', app: 'TeleMock' });
      expect(await inPage('tele.localhost', 'document.getElementById("who").textContent')).toBe('Uber');
      expect(JSON.stringify(r)).not.toContain('Your ride receipt');
    }, 90_000);

    it('its file pickers already exist, so no menu is needed; a document goes to the "anything" picker', async () => {
      const doc = join(work, 'invoice.pdf');
      writeFileSync(doc, Buffer.alloc(5000, 0x31));
      const q = await call('attach_file', { path: doc });
      expect(q.data?.['question']).toBe('Found Uber, number ending in 999. Send the file "invoice.pdf" to this chat?');
      const done = await call('attach_file', { path: doc, confirm: true });
      expect(done.ok, JSON.stringify(done)).toBe(true);
      expect(await inPage('tele.localhost', 'JSON.stringify(window.__picked)')).toContain('"via":"any"');
      // This app's preview is not marked up as a dialog, yet the file name on the page confirmed it.
      expect(done.data?.['shownAs']).toBe('name_visible');
    }, 90_000);

    it('the preview\'s own SEND asks no second time, goes, and the delivery mark in the app\'s title text confirms it', async () => {
      // This app has two send controls: the message box\'s "Send message" and the preview\'s "SEND". The file goes with the preview\'s.
      const sent = await call('click_on_page', { text: 'SEND' });
      expect(sent.ok, JSON.stringify(sent)).toBe(true);
      const v = await call('verify_sent', {});
      expect(v.ok, JSON.stringify(v)).toBe(true);
      expect(v.data).toMatchObject({ status: 'sent', mark: 'delivered' });
      expect(await inPage('tele.localhost', 'JSON.stringify(window.__sent)')).toContain('invoice.pdf');
    }, 60_000);

    it('a photo goes to the picker made for photos, unless asked to send it as a document', async () => {
      const photo = join(work, 'holiday.jpg');
      writeFileSync(photo, Buffer.alloc(3000, 0x77));
      expect((await call('attach_file', { path: photo, confirm: true })).ok).toBe(true);
      expect(await inPage('tele.localhost', 'window.__picked.via')).toBe('media');
      await call('click_on_page', { text: 'CANCEL' });
      expect((await call('attach_file', { path: photo, confirm: true, as: 'document' })).ok).toBe(true);
      expect(await inPage('tele.localhost', 'window.__picked.via')).toBe('any');
      await call('click_on_page', { text: 'CANCEL' });
    }, 90_000);

    it('a message here asks before sending as well', async () => {
      await call('fill_on_page', { label: 'Write a message...', value: 'ride was great' });
      const q = await call('click_on_page', { text: 'Send message' });
      expect(q.ok).toBe(false);
      expect(q.data?.['question']).toBe('Found Uber, number ending in 999. Send this message to this chat?');
      expect(await inPage('tele.localhost', 'window.__sent.length')).toBe(1);
    }, 60_000);
  });

  // ---------------------------------------------------------------------------------------- when it is switched off
  describe('Communication Access switched OFF', () => {
    it('the same tools refuse, and the page is left exactly as it was', async () => {
      const before = await inPage('tele.localhost', 'JSON.stringify({ sent: window.__sent.length, who: document.getElementById("who").textContent })');
      store.set({ enabled: false, apps: {} });
      session.clear();
      await waitFor(async () => (await manager.inspectPage().then(() => false, () => true)) === true, 10_000, 'it to be refused');
      for (const [name, args] of [
        ['find_chat', { query: 'Priya' }],
        ['attach_file', { path: join(work, 'invoice.pdf'), confirm: true }],
        ['verify_sent', { text: 'ride was great' }],
        ['inspect_page', {}],
        ['click_on_page', { text: 'Send message', confirm: true }],
      ] as const) {
        const r = await call(name, args);
        expect(r.ok, name).toBe(false);
        expect(r.summary, name).toBe('communication access is off');
      }
      expect(await inPage('tele.localhost', 'JSON.stringify({ sent: window.__sent.length, who: document.getElementById("who").textContent })')).toBe(before);
      store.set({ enabled: true, apps: {} });
    }, 90_000);
  });
});
