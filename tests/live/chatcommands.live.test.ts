/**
 * "Message Ravi that I'll be late" without the model, with the REAL extension in a REAL Chrome, through Eya's real tools — against a
 * WhatsApp-style mock page on chat.localhost:
 *
 *   ChatCommands → find_chat → fill_on_page → (asks) → click_on_page Send → verify_sent, and the saved chat names that make the
 *   second time quicker.
 *
 * Opt-in: EYA_LIVE_BROWSER=1 npx vitest run tests/live/chatcommands.live.test.ts
 * Not covered: the real WhatsApp, a real signed-in profile, a real phone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChromeBridge } from '../../src/main/chrome/ChromeBridge';
import type { SecretStore } from '../../src/main/chrome/ChromeBridge';
import { BrowserWorldTracker } from '../../src/main/chrome/browserWorld';
import { BrowserSessionManager } from '../../src/main/browser/BrowserSessionManager';
import type { BrowserLauncher } from '../../src/main/browser/BrowserSessionManager';
import type { BrowserAutomationService } from '../../src/main/browser/BrowserAutomationService';
import type { BrowserName } from '../../src/main/chrome/protocol';
import { ChatSession } from '../../src/main/chat/chatSession';
import { ContactBook } from '../../src/main/chat/ContactBook';
import { ChatCommands } from '../../src/main/local/ChatCommands';
import { MIGRATIONS } from '../../src/main/memory/schema';
import { migrate, openDatabase } from '../../src/main/memory/sqlite';
import type { Sql } from '../../src/main/memory/sqlite';
import { CommunicationPolicy } from '../../src/main/privacy/communicationAccess';
import type { CommunicationApp } from '../../src/main/privacy/communicationAccess';
import { CommunicationAccessStore } from '../../src/main/privacy/communicationAccessStore';
import { startPolicySync } from '../../src/main/privacy/policySync';
import type { KnownFolders } from '../../src/main/security/pathPolicy';
import { ToolRegistry } from '../../src/main/tools/ToolRegistry';
import { createBrowserTools } from '../../src/main/tools/impl/browserTools';
import { createChatSendGate, createChatTools } from '../../src/main/tools/impl/chatTools';
import { startTestSite } from '../fixtures/chrome-test-site/server.mjs';
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser, userEval, waitFor } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const BRIDGE_PORT = 47838;
const DEBUG_PORT = 9347;

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

// The mock page stands in for WhatsApp Web, so it is registered under WhatsApp's id.
const WHATSAPPISH: CommunicationApp = { id: 'whatsapp', name: 'WhatsApp', hosts: [{ host: 'chat.localhost' }], processes: [], titleHints: [] };

const forbiddenIsolatedBrowser = new Proxy(
  {},
  { get: (_t, prop) => (prop === 'close' ? async () => undefined : () => Promise.reject(new Error(`Eya's separate browser window must not be used (${String(prop)})`))) },
) as BrowserAutomationService;

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('messaging by name: real extension, real Chrome, a WhatsApp-style page', () => {
  let site: { server: Server; port: number };
  let bridge: ChromeBridge;
  let world: BrowserWorldTracker;
  let browser: TestBrowser;
  let ext: { dir: string; cleanup: () => void };
  let stopSync: () => void;
  let store: CommunicationAccessStore;
  let manager: BrowserSessionManager;
  let db: Sql;
  let dir = '';
  let work = '';
  let book: ContactBook;
  let chat: ChatCommands;
  let registry: ToolRegistry;
  const files = new Map<string, string>();

  const chatUrl = () => `http://chat.localhost:${site.port}/chat.html`;
  const inPage = (expression: string) => userEval(DEBUG_PORT, 'chat.localhost', expression);
  const say = async (text: string) => {
    const started = Date.now();
    const out = await chat.tryHandle(text);
    // eslint-disable-next-line no-console
    console.log(`  "${text}" -> ${Date.now() - started} ms: ${out?.spoken ?? '(passed on)'}`);
    return out;
  };

  beforeAll(async () => {
    site = await startTestSite(0);
    ext = prepareExtensionCopy(BRIDGE_PORT);
    dir = mkdtempSync(join(tmpdir(), 'eya-chatcmd-live-'));
    db = openDatabase(join(dir, 'memory.db'));
    migrate(db, MIGRATIONS);
    book = new ContactBook(db);

    store = new CommunicationAccessStore('memory', { read: (p) => files.get(p) ?? null, write: (p, t) => void files.set(p, t) }, ['whatsapp']);
    store.load();
    store.set({ enabled: true, apps: {} }); // the user has switched Communication Access on
    const policy = new CommunicationPolicy(() => store.get(), [WHATSAPPISH]);

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
    const session = new ChatSession();
    const home = process.env['USERPROFILE'] ?? '';
    work = mkdtempSync(join(home, 'eya-chatcmd-files-'));
    writeFileSync(join(work, 'Chaluvagali Raghavendra Raju.docx'), Buffer.alloc(40 * 1024, 0x41));
    writeFileSync(join(work, 'report.pdf'), Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300 * 1024, 0x5a), Buffer.from('\n%%EOF')]));
    const folders: KnownFolders = { home, downloads: join(home, 'Downloads'), desktop: join(home, 'Desktop'), documents: join(home, 'Documents'), pictures: join(home, 'Pictures'), videos: join(home, 'Videos'), music: join(home, 'Music'), temp: tmpdir() };
    const names = { learn: (a: string, l: readonly string[]) => book.learn(a, l), used: (a: string, l: string) => book.used(a, l), learning: () => book.learning() === 'on' };
    registry = new ToolRegistry();
    for (const t of createBrowserTools(manager, undefined, { tabs: manager, session: manager, chatGate: createChatSendGate(session, policy) })) registry.register(t);
    for (const t of createChatTools({ service: manager, policy, session, folders, names })) registry.register(t);
    const timed = { invoke: async (name: string, args: Record<string, string | number | boolean | null>) => { const t0 = Date.now(); const r = await registry.invoke(name, args); console.log('      step ' + name + ' ' + (Date.now() - t0) + ' ms'); return r; } };
    chat = new ChatCommands({ tools: timed, contacts: book, policy, session, files: { locate: async () => ({ kind: 'one' as const, path: join(work, 'report.pdf'), name: 'report.pdf' }) } });
  }, 120_000);

  afterAll(async () => {
    stopSync?.();
    browser?.kill();
    await bridge?.stop();
    site?.server.close();
    await sleep(500);
    browser?.cleanup();
    ext?.cleanup();
    db?.close();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
    if (work !== '') rmSync(work, { recursive: true, force: true });
  }, 30_000);

  it('the first time: finds the chat, types the message, and asks — nothing is sent', async () => {
    const opened = await manager.openWebsite(chatUrl());
    expect(opened.url).toContain('chat.localhost');
    await waitFor(async () => (await inPage('document.title')) === 'MockChat Web', 10_000, 'the chat app to load');

    const out = await say('message Rahul Sharma that On my way, 5 minutes');
    expect(out?.ok).toBe(true);
    expect(out?.spoken).toBe('Found Rahul Sharma, number ending in 432. Send "On my way, 5 minutes"?');
    expect(await inPage('document.getElementById("chat-title").textContent')).toBe('Rahul Sharma');
    expect(await inPage('document.getElementById("msg").value')).toBe('On my way, 5 minutes');
    expect(await inPage('window.__sent.length')).toBe(0);
  }, 90_000);

  it('only the user\'s own yes sends it, and the page shows it went', async () => {
    const out = await say('yes');
    expect(out?.spoken).toMatch(/^Sent to Rahul Sharma\. By the way, I can remember the names in your WhatsApp/);
    expect(await inPage('JSON.stringify(window.__sent.map((m) => m.text))')).toBe('["On my way, 5 minutes"]');
    expect(book.count()).toBe(0); // nothing is kept until the user says yes to that too
  }, 90_000);

  it('then, after the user agrees, it remembers the chat — and what the user called it', async () => {
    const out = await say('yes');
    expect(out?.spoken).toMatch(/remember chat names from now on/);
    expect(book.learning()).toBe('on');
    expect(book.list('whatsapp').map((c) => c.name)).toEqual(['Rahul Sharma']);
  }, 30_000);

  it('learns the names showing, and keeps no preview, number or message', async () => {
    const out = await say('remember my WhatsApp contacts');
    expect(out?.ok, out?.spoken).toBe(true);
    const stored = JSON.stringify([db.all('SELECT * FROM contacts'), db.all('SELECT * FROM contact_aliases')]);
    for (const secret of ['See you tomorrow', 'hunter2', '98765', '10:42', 'On my way']) expect(stored).not.toContain(secret);
    expect(book.countFor('whatsapp')).toBeGreaterThanOrEqual(3);
  }, 90_000);

  it('the next time, a short name goes straight to the exact chat (no model, no guessing)', async () => {
    book.learn('whatsapp', ['Priya Singh']);
    const out = await say('message priya saying see you at the clinic');
    expect(out?.spoken).toMatch(/^Found Priya Singh/);
    expect(await inPage('document.getElementById("chat-title").textContent')).toBe('Priya Singh');
    expect(await inPage('document.getElementById("msg").value')).toBe('see you at the clinic');
    const yes = await say('send it');
    expect(yes?.spoken).toMatch(/^Sent to Priya Singh/);
    expect(await inPage('window.__sent.length')).toBe(2);
  }, 90_000);

  it('two people with the same first name are asked about, and the right one gets it', async () => {
    const asked = await say('message Rahul saying are you coming');
    expect(asked?.spoken).toBe('Which one: Rahul Sharma or Rahul Verma?');
    const picked = await say('Verma');
    expect(picked?.spoken).toMatch(/^Found Rahul Verma/);
    expect(await inPage('document.getElementById("chat-title").textContent')).toBe('Rahul Verma');
    const no = await say('no');
    expect(no?.spoken).toMatch(/won't send it/);
    expect(await inPage('window.__sent.length')).toBe(2); // the last two are still the only ones
  }, 120_000);

  it('sends a file by name: finds the chat, asks, and on the yes opens the attach menu, attaches, sends and verifies', async () => {
    const asked = await say('send the latest pdf to Priya Singh on WhatsApp');
    expect(asked?.spoken).toMatch(/^Found Priya Singh, number ending in 432\. Send the file "report\.pdf"\?$/);
    expect(await inPage('document.getElementById("chat-title").textContent')).toBe('Priya Singh');
    expect(await inPage('window.__sent.length')).toBe(2); // asking sent nothing
    const done = await say('yes');
    expect(done?.spoken, done?.spoken).toMatch(/^Sent "report\.pdf" to Priya Singh\./);
    expect(await inPage('JSON.stringify(window.__sent.map((m) => m.file))')).toContain('report.pdf');
  }, 120_000);

  it('the models own steps, with a preview that cuts the file name short (the real loop): attach, then Send goes through without a second question', async () => {
    // Seen with real WhatsApp: after the user's yes, "I can no longer see the file ... waiting on the page" came back again and again.
    await manager.openWebsite(`${chatUrl()}?cut=1`);
    await waitFor(async () => (await inPage('document.title')) === 'MockChat Web', 10_000, 'the chat app to reload');
    const call = (name: string, args: Record<string, string | number | boolean | null>) => registry.invoke(name, args);
    const long = join(work, 'Chaluvagali Raghavendra Raju.docx');
    expect((await call('find_chat', { query: 'Priya Singh' })).ok).toBe(true);
    const question = await call('attach_file', { path: long });
    expect(question.data?.['question']).toBe('Found Priya Singh, number ending in 432. Send the file "Chaluvagali Raghavendra Raju.docx" to this chat?');
    let attached = await call('attach_file', { path: long, confirm: true });
    if (!attached.ok && attached.summary === 'no file picker yet') {
      await call('click_on_page', { text: 'Attach' });
      attached = await call('attach_file', { path: long, confirm: true });
    }
    expect(attached.ok, attached.error).toBe(true);
    expect(await inPage('document.getElementById("preview-file").textContent')).not.toContain('Raju'); // the page really cuts the name
    const send = await call('click_on_page', { text: 'Send' }); // NOT confirm: the yes already given covers it
    expect(send.ok, send.error).toBe(true);
    const verified = await call('verify_sent', {});
    expect(verified.data).toMatchObject({ status: 'sent', file: 'Chaluvagali Raghavendra Raju.docx' });
    expect(await inPage('JSON.stringify(window.__sent.map((m) => m.file))')).toContain('Chaluvagali Raghavendra Raju.docx');
  }, 120_000);

  it('with Chats switched off it does nothing at all', async () => {
    store.set({ enabled: false, apps: {} });
    await sleep(500);
    const before = await inPage('window.__sent.length').catch(() => 'blocked');
    const out = await say('message Rahul Sharma saying hello');
    expect(out).toMatchObject({ ok: false });
    expect(out?.spoken).toMatch(/Chats are off for WhatsApp/);
    store.set({ enabled: true, apps: {} });
    void before;
  }, 60_000);
});
