import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatSession } from '../src/main/chat/chatSession';
import { ContactBook } from '../src/main/chat/ContactBook';
import { ChatCommands } from '../src/main/local/ChatCommands';
import type { FileLocation } from '../src/main/local/ChatCommands';
import { MIGRATIONS } from '../src/main/memory/schema';
import { migrate, openDatabase } from '../src/main/memory/sqlite';
import type { Sql } from '../src/main/memory/sqlite';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { CommunicationSettings } from '../src/main/privacy/communicationAccess';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { createBrowserTools } from '../src/main/tools/impl/browserTools';
import { createChatSendGate, createChatTools } from '../src/main/tools/impl/chatTools';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';
import { FakeChatApp, FakeDisk } from './chatFixtures';
import type { Behaviour } from './chatFixtures';

const HOME = 'C:\\Users\\Test';
const folders: KnownFolders = { home: HOME, downloads: `${HOME}\\Downloads`, desktop: `${HOME}\\Desktop`, documents: `${HOME}\\Documents`, pictures: `${HOME}\\Pictures`, videos: `${HOME}\\Videos`, music: `${HOME}\\Music`, temp: HOME };
const ON: CommunicationSettings = { enabled: true, apps: {} };
const OFF: CommunicationSettings = { enabled: false, apps: {} };

let dir: string;
let db: Sql;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eya-chatcmd-'));
  db = openDatabase(join(dir, 'memory.db'));
  migrate(db, MIGRATIONS);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Rig {
  readonly app: FakeChatApp;
  readonly book: ContactBook;
  readonly chat: ChatCommands;
  readonly session: ChatSession;
  readonly invoked: string[];
  clock: number;
  settings: CommunicationSettings;
}

const PDF = `${HOME}\\Desktop\\report.pdf`;
const REPORT: FileLocation = { kind: 'one', path: PDF, name: 'report.pdf' };

function rig(
  opts: { learning?: 'on' | 'off'; behaviour?: Behaviour; settings?: CommunicationSettings; fail?: readonly string[]; noBrowser?: readonly string[]; located?: FileLocation | null; oldExtension?: boolean } = {},
): Rig {
  const app = new FakeChatApp();
  if (opts.behaviour !== undefined) app.behaviour = opts.behaviour;
  const state = { clock: 1_000_000, settings: opts.settings ?? ON };
  const policy = new CommunicationPolicy(() => state.settings);
  const session = new ChatSession(() => state.clock);
  const book = new ContactBook(db);
  if (opts.learning !== undefined) book.setLearning(opts.learning);
  const tools = new ToolRegistry();
  const names = { learn: (a: string, l: readonly string[]) => book.learn(a, l), used: (a: string, l: string) => book.used(a, l), learning: () => book.learning() === 'on' };
  const disk = new FakeDisk({ [PDF]: { isFile: true, isDirectory: false, size: 10, content: Buffer.from('0123456789') } });
  for (const t of createChatTools({ service: app, policy, session, folders, files: disk, sleep: async () => undefined, names })) tools.register(t);
  for (const t of createBrowserTools(app, undefined, { chatGate: createChatSendGate(session, policy) })) tools.register(t);
  const invoked: string[] = [];
  const located = opts.located === undefined ? REPORT : opts.located;
  const chat = new ChatCommands({
    tools: {
      invoke: async (name: string, args: ToolArgs): Promise<ToolResult> => {
        invoked.push(name);
        if (opts.fail?.includes(name) === true) return { ok: false, summary: 'failed', error: `${name} failed` };
        // What the real tools say when none of the user's browsers is connected: wording written for the MODEL, not to be read out.
        if (opts.noBrowser?.includes(name) === true) {
          return { ok: false, summary: 'browser not connected', error: "None of the user's browsers is connected to Eya. Call connect_chrome, then try again.", data: { browserUnavailable: true, why: 'not_connected' } };
        }
        return tools.invoke(name, args);
      },
    },
    contacts: book,
    policy,
    session,
    files: { locate: async () => located },
    extensionIsOld: () => opts.oldExtension === true,
    now: () => state.clock,
    sleep: async () => undefined,
  });
  return Object.assign(state, { app, book, chat, session, invoked }) as unknown as Rig;
}

const say = (r: Rig, text: string, live = false) => r.chat.tryHandle(text, live ? { live: true } : {});

describe('sending a file by name', () => {
  it('finds the file and the chat, asks who and what, and attaches nothing until the yes', async () => {
    const r = rig();
    const out = await say(r, 'send the latest pdf to Priya Singh on WhatsApp');
    expect(out?.spoken).toBe('Found Priya Singh. Send the file "report.pdf"?');
    expect(r.app.attached).toBeNull();
    expect(r.app.thread).toEqual([]);
    expect(r.invoked).toEqual(['find_chat']); // not even the attach menu has been touched
  });

  it('on a clear yes: attaches, presses Send, checks it went, and says so', async () => {
    const r = rig();
    await say(r, 'send the latest pdf to Priya Singh on WhatsApp');
    const out = await say(r, 'yes');
    expect(out?.spoken).toMatch(/^Sent "report\.pdf" to Priya Singh\./);
    expect(out?.ok).toBe(true);
    expect(r.app.attached?.name).toBe('report.pdf');
    expect(r.app.thread.map((m) => m.file)).toEqual(['report.pdf']);
    expect(r.invoked).toEqual(['find_chat', 'attach_file', 'click_on_page', 'verify_sent']);
  });

  it('a chat app that keeps its file picker hidden has its attach menu opened first', async () => {
    const r = rig({ behaviour: 'no_picker' });
    await say(r, 'send the latest pdf to Priya Singh on WhatsApp');
    r.app.behaviour = 'normal';
    r.app.pickerExists = false;
    const out = await say(r, 'yes');
    expect(out?.ok, out?.spoken).toBe(true);
    expect(r.invoked).toEqual(['find_chat', 'attach_file', 'click_on_page', 'attach_file', 'click_on_page', 'verify_sent']);
  });

  it('a no sends nothing and attaches nothing', async () => {
    const r = rig();
    await say(r, 'send the latest pdf to Priya Singh on WhatsApp');
    const out = await say(r, 'no');
    expect(out?.spoken).toMatch(/won't send it\. Nothing was attached/);
    expect(r.app.attached).toBeNull();
    expect(r.invoked).toEqual(['find_chat']);
  });

  it('two chats with that name are asked about first, and the file is remembered through the question', async () => {
    const r = rig();
    const asked = await say(r, 'send the latest pdf to Rahul on WhatsApp');
    expect(asked?.spoken).toBe('Which one: Rahul Sharma or Rahul Verma?');
    const picked = await say(r, 'Verma');
    expect(picked?.spoken).toBe('Found Rahul Verma. Send the file "report.pdf"?');
    expect((await say(r, 'yes'))?.spoken).toMatch(/^Sent "report\.pdf" to Rahul Verma/);
  });

  it('says it did not go when the app shows a failure — never "sent"', async () => {
    const r = rig({ behaviour: 'fails' });
    await say(r, 'send the latest pdf to Priya Singh on WhatsApp');
    const out = await say(r, 'yes');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toMatch(/failed to send to Priya Singh/);
    expect(out?.spoken).not.toMatch(/^Sent/);
  });

  it('says when the file never reached the chat, instead of pressing Send on nothing', async () => {
    const r = rig({ behaviour: 'never_shows' });
    await say(r, 'send the latest pdf to Priya Singh on WhatsApp');
    const out = await say(r, 'yes');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toMatch(/couldn't put "report\.pdf" on the chat with Priya Singh, so nothing was sent/);
    expect(r.invoked).not.toContain('verify_sent');
  });

  it('several files that fit are named, and nothing is opened or sent', async () => {
    const r = rig({ located: { kind: 'several', names: ['report a.pdf', 'report b.pdf'], total: 2 } });
    const out = await say(r, 'send my report to Priya Singh on WhatsApp');
    expect(out?.spoken).toBe("I found 2 files that fit: report a.pdf or report b.pdf. Say the exact file name and I'll send it.");
    expect(r.invoked).toEqual([]);
  });

  it('leaves it to the model when the file is not in the quick index, or no app was named for a name Eya does not know', async () => {
    const none = rig({ located: null });
    expect(await say(none, 'send the latest pdf to Priya Singh on WhatsApp')).toBeNull();
    const unknown = rig();
    expect(await say(unknown, 'send the latest pdf to my boss')).toBeNull(); // could be an e-mail: not a chat request
    expect(unknown.invoked).toEqual([]);
  });

  it('a request that names a browser ("... on WhatsApp in Edge") is left to the model, which opens the page in that browser — the fast path would use Chrome', async () => {
    const r = rig();
    expect(await say(r, 'send the latest pdf to Priya Singh on WhatsApp in Edge')).toBeNull();
    expect(r.invoked).toEqual([]);
  });

  it('"send it to Uber" sends the file that was just found, by whoever found it', async () => {
    const r = rig({ learning: 'on' });
    const withContext = new ChatCommands({
      tools: { invoke: (name, args) => r.chat['deps'].tools.invoke(name, args) },
      contacts: r.book,
      policy: new CommunicationPolicy(() => ON),
      session: r.session,
      lastFile: () => ({ path: PDF, name: 'report.pdf' }),
      chatAppOpen: () => true,
      sleep: async () => undefined,
    });
    const asked = await withContext.tryHandle('Priya chat is there na? Send for Priya Singh.');
    expect(asked?.spoken).toBe('Found Priya Singh. Send the file "report.pdf"?');
    expect(r.app.attached).toBeNull();
    const sent = await withContext.tryHandle('yes');
    expect(sent?.spoken).toMatch(/^Sent "report\.pdf" to Priya Singh/);
  });

  it('"send it" with nothing found yet, or with no chat in sight, is left to the model', async () => {
    const r = rig();
    const none = new ChatCommands({ tools: { invoke: (name, args) => r.chat['deps'].tools.invoke(name, args) }, contacts: r.book, policy: new CommunicationPolicy(() => ON), session: r.session, lastFile: () => null, chatAppOpen: () => true, sleep: async () => undefined });
    expect(await none.tryHandle('send it to Uber')).toBeNull();
    const noChat = new ChatCommands({ tools: { invoke: (name, args) => r.chat['deps'].tools.invoke(name, args) }, contacts: r.book, policy: new CommunicationPolicy(() => ON), session: r.session, lastFile: () => ({ path: PDF, name: 'report.pdf' }), chatAppOpen: () => false, sleep: async () => undefined });
    expect(await noChat.tryHandle('send it to my boss')).toBeNull(); // could be an e-mail
    expect(r.invoked).toEqual([]);
  });

  it('a name Eya knows is enough without saying the app', async () => {
    const r = rig({ learning: 'on' });
    r.book.learn('whatsapp', ['Priya Singh']);
    const out = await say(r, 'send the latest pdf to priya');
    expect(out?.spoken).toBe('Found Priya Singh. Send the file "report.pdf"?');
  });

  it('with Chats off, and never from always-on listening', async () => {
    const off = rig({ settings: OFF });
    expect((await say(off, 'send the latest pdf to Priya Singh on WhatsApp'))?.spoken).toMatch(/Chats are off/);
    const live = rig();
    expect(await say(live, 'send the latest pdf to Priya Singh on WhatsApp', true)).toBeNull();
    expect(live.invoked).toEqual([]);
  });
});

describe('asking to remember names after a send done another way', () => {
  it('becomes the question waiting for a yes, once; the yes turns remembering on and keeps the chat', async () => {
    const r = rig();
    const words = r.chat.offerConsent('whatsapp', 'Priya Singh');
    expect(words).toMatch(/remember the names in your WhatsApp/);
    expect(r.chat.offerConsent('whatsapp', 'Priya Singh')).toBeNull(); // already asked: not twice
    const yes = await say(r, 'yes');
    expect(yes?.spoken).toMatch(/remember chat names from now on/);
    expect(r.book.learning()).toBe('on');
    expect(r.book.list('whatsapp').map((c) => c.name)).toEqual(['Priya Singh']);
  });

  it('is not needed once the user has answered (either way)', () => {
    expect(rig({ learning: 'on' }).chat.offerConsent('whatsapp', 'Priya Singh')).toBeNull();
    expect(rig({ learning: 'off' }).chat.offerConsent('whatsapp', 'Priya Singh')).toBeNull();
    expect(rig().chat.offerConsent('someotherapp', 'X')).toBeNull();
  });
});

describe('an older browser extension', () => {
  it('is mentioned once, after a send that went through — never on a question, never again', async () => {
    const r = rig({ learning: 'on', oldExtension: true });
    const asked = await say(r, 'message Priya Singh that hi');
    expect(asked?.spoken).toBe('Found Priya Singh. Send "hi"?'); // a question is left exactly as it is
    const sent = await say(r, 'yes');
    expect(sent?.spoken).toMatch(/^Sent to Priya Singh\./);
    expect(sent?.spoken).toMatch(/older Eya extension/);
    await say(r, 'message Priya Singh that again');
    expect((await say(r, 'yes'))?.spoken).not.toMatch(/extension/);
  });

  it('is not mentioned when the extension is current', async () => {
    const r = rig({ learning: 'on' });
    await say(r, 'message Priya Singh that hi');
    expect((await say(r, 'yes'))?.spoken).not.toMatch(/extension/);
  });
});

describe('what the user calls someone', () => {
  it('"when I say sis I mean Priya Singh" is kept, and then "sis" goes straight to that chat', async () => {
    const r = rig();
    const taught = await say(r, 'when I say sis I mean Priya Singh');
    expect(taught?.spoken).toBe('Okay. When you say sis, I\'ll open Priya Singh in WhatsApp. I only keep names, on this PC.');
    expect(r.book.learning()).toBe('on'); // asking is the yes
    expect(r.invoked).toEqual([]); // nothing in the browser was touched to teach it

    const out = await say(r, 'message sis that dinner is ready');
    expect(out?.spoken).toMatch(/^Found Priya Singh/);
    expect(r.app.open?.name).toBe('Priya Singh');
    expect(r.invoked).toEqual(['find_chat', 'fill_on_page']);
  });

  it('"call this chat akka" names the chat Eya just opened', async () => {
    const r = rig();
    expect((await say(r, 'call this chat sis'))?.ok).toBe(false); // nothing is open yet: it says so rather than guessing
    await say(r, 'open Priya Singh chat');
    const taught = await say(r, 'call this chat sis');
    expect(taught?.spoken).toMatch(/When you say sis, I'll open Priya Singh/);
    expect(r.book.resolve('whatsapp', 'sis')).toMatchObject({ kind: 'unique', via: 'alias', contact: { name: 'Priya Singh' } });
  });

  it('a part of a name Eya already knows is taken to mean the whole of it', async () => {
    const r = rig({ learning: 'on' });
    r.book.learn('whatsapp', ['Priya Singh']);
    await say(r, 'when I say sis I mean Priya');
    expect(r.book.resolve('whatsapp', 'sis')).toMatchObject({ contact: { name: 'Priya Singh' } });
  });

  it('does nothing while Chats are off, and never from always-on listening', async () => {
    const off = rig({ settings: { enabled: false, apps: {} } });
    expect((await say(off, 'when I say sis I mean Priya Singh'))?.spoken).toMatch(/Chats are off/);
    expect(off.book.count()).toBe(0);
    const live = rig();
    expect(await say(live, 'when I say sis I mean Priya Singh', true)).toBeNull();
    expect(live.book.count()).toBe(0);
  });

  it('a chat the user messages all the time is the one "Rahul" means (they are still told who it is)', async () => {
    const r = rig({ learning: 'on' });
    r.book.learn('whatsapp', ['Rahul Sharma', 'Rahul Verma']);
    expect((await say(r, 'message Rahul that hi'))?.spoken).toMatch(/^Which one/);
    for (let i = 0; i < 4; i += 1) r.book.used('whatsapp', 'Rahul Verma');
    const out = await say(r, 'message Rahul that hi');
    expect(out?.spoken).toMatch(/^Found Rahul Verma/);
    expect(r.app.thread).toEqual([]); // still only asked
  });
});

describe('a name the speech recogniser spelled by ear', () => {
  it('finds "Akka" when it heard "aka" — by searching the first letters and taking only a name that sounds the same', async () => {
    const r = rig();
    const lakes = new FakeChatApp([
      { name: 'Akka', phone: '+91 90000 22222', preview: 'ok' },
      { name: 'Akhil Rao', phone: '+91 90000 33333', preview: 'ok' },
      { name: 'Ravi', phone: '+91 90000 44444', preview: 'ok' },
    ]);
    const tools = new ToolRegistry();
    const policy = new CommunicationPolicy(() => ON);
    const session = new ChatSession();
    for (const t of createChatTools({ service: lakes, policy, session, folders, files: new FakeDisk(), sleep: async () => undefined })) tools.register(t);
    void r;
    const out = await tools.invoke('find_chat', { query: 'aka' });
    expect(out.ok).toBe(true);
    expect(out.data?.['status']).toBe('opened');
    expect(out.data?.['chat']).toBe('Akka');
    expect(String(out.data?.['note'])).toMatch(/close spelling/); // and it says so, so the user hears whose chat it opened
  });
});

describe('messaging by name', () => {
  it('finds the chat, types the message, asks who it is going to, and sends nothing yet', async () => {
    const r = rig();
    const out = await say(r, "message Rahul Sharma that I'll be late");
    expect(out?.spoken).toBe('Found Rahul Sharma. Send "I\'ll be late"?');
    expect(out?.ok).toBe(true);
    expect(r.app.open?.name).toBe('Rahul Sharma');
    expect(r.app.draft).toBe("I'll be late");
    expect(r.app.thread).toEqual([]); // nothing went
    expect(r.invoked).toEqual(['find_chat', 'fill_on_page']);
  });

  it('sends on a clear yes, checks that it went, and says so', async () => {
    const r = rig();
    await say(r, 'message Rahul Sharma that dinner is ready');
    const out = await say(r, 'yes');
    expect(out?.spoken).toMatch(/^Sent to Rahul Sharma\./);
    expect(out?.ok).toBe(true);
    expect(r.app.thread.map((m) => m.text)).toEqual(['dinner is ready']);
    expect(r.invoked.slice(-2)).toEqual(['click_on_page', 'verify_sent']);
  });

  it('does not send on a no, and leaves the message in the box', async () => {
    const r = rig();
    await say(r, 'message Priya Singh saying call me');
    const out = await say(r, 'no');
    expect(out?.spoken).toMatch(/won't send it/);
    expect(r.app.thread).toEqual([]);
    expect(r.app.draft).toBe('call me');
    expect(await say(r, 'yes')).toBeNull(); // nothing is waiting any more
    expect(r.app.thread).toEqual([]);
  });

  it('does not take anything else as a yes, and the question lapses', async () => {
    const r = rig();
    await say(r, 'message Priya Singh saying call me');
    expect(await say(r, 'open youtube')).toBeNull(); // a new request: goes on to the other layers
    expect(await say(r, 'yes')).toBeNull(); // and the question is gone
    expect(r.app.thread).toEqual([]);
  });

  it('keeps an unanswered question for a few minutes, then forgets it', async () => {
    const r = rig();
    await say(r, 'message Priya Singh saying call me');
    r.clock += 2 * 60_000 + 1;
    // still waiting: a slow page can use the first minutes, and the person may have stepped away
    const stillThere = await say(r, 'yes');
    expect(stillThere?.spoken).toMatch(/^Sent to Priya Singh/);

    const r2 = rig();
    await say(r2, 'message Priya Singh saying call me');
    r2.clock += 10 * 60_000 + 1;
    expect(await say(r2, 'yes')).toBeNull();
    expect(r2.app.thread).toEqual([]);
  });

  it('never starts or answers anything from always-on listening', async () => {
    const r = rig();
    expect(await say(r, 'message Priya Singh saying call me', true)).toBeNull();
    expect(r.invoked).toEqual([]);
    await say(r, 'message Priya Singh saying call me'); // typed or spoken to Eya
    expect(await say(r, 'yes', true)).toBeNull(); // a "yes" heard in the room is not the user's
    expect(r.app.thread).toEqual([]);
    expect((await say(r, 'yes'))?.spoken).toMatch(/^Sent to Priya Singh/); // the user's own yes still works
  });

  it('is told plainly when Chats are off, and touches nothing', async () => {
    const r = rig({ settings: OFF });
    const out = await say(r, 'message Priya Singh saying call me');
    expect(out).toMatchObject({ ok: false, spoken: "Chats are off for WhatsApp. Turn Chats on in Eya's panel, then ask me again." });
    expect(r.invoked).toEqual([]);
    expect(r.app.calls).toEqual([]);
  });

  it('opens the chat app first when another page is in front', async () => {
    const r = rig();
    r.app.url = 'https://example.com/';
    const out = await say(r, 'message Priya Singh saying call me');
    expect(r.invoked).toEqual(['find_chat', 'open_website', 'find_chat', 'fill_on_page']);
    expect(out?.spoken).toMatch(/^Found Priya Singh/);
  });

  it('opens Telegram for a Telegram request', async () => {
    const r = rig();
    r.app.url = 'https://example.com/';
    await say(r, 'message Priya Singh on telegram saying call me');
    expect(r.app.url).toBe('https://web.telegram.org/a/');
  });

  it('says so when it cannot find the chat, and does not guess', async () => {
    const r = rig();
    const out = await say(r, 'message Zorro saying hello');
    expect(out).toMatchObject({ ok: false });
    expect(out?.spoken).toMatch(/couldn't find a chat called Zorro/);
    expect(r.app.draft).toBe('');
  });

  it('says so when the message box is not there, and sends nothing', async () => {
    const r = rig({ fail: ['fill_on_page'] });
    const out = await say(r, 'message Priya Singh saying call me');
    expect(out).toMatchObject({ ok: false });
    expect(out?.spoken).toMatch(/couldn't find the message box, so nothing was typed or sent/);
    expect(await say(r, 'yes')).toBeNull();
  });

  it('is honest when the app does not show it went', async () => {
    for (const [behaviour, expected] of [
      ['fails', /failed to send/],
      ['pending', /still shows it as sending/],
      ['no_marks', /can't confirm/],
    ] as const) {
      db.exec('DELETE FROM contacts');
      const r = rig({ behaviour });
      await say(r, 'message Priya Singh saying call me');
      const out = await say(r, 'yes');
      expect(out?.ok, behaviour).toBe(false);
      expect(out?.spoken, behaviour).toMatch(expected);
      expect(out?.spoken, behaviour).not.toMatch(/^Sent/);
    }
  });
});

describe('which one?', () => {
  it('asks when the app shows two chats for a name, and opens the one chosen', async () => {
    const r = rig();
    const asked = await say(r, 'message Rahul saying see you at 5');
    expect(asked?.spoken).toBe('Which one: Rahul Sharma or Rahul Verma?');
    expect(r.app.open).toBeNull();
    const picked = await say(r, 'the second one');
    expect(r.app.open?.name).toBe('Rahul Verma');
    expect(picked?.spoken).toBe('Found Rahul Verma. Send "see you at 5"?');
    expect((await say(r, 'send it'))?.spoken).toMatch(/^Sent to Rahul Verma/);
    expect(r.app.thread.map((m) => m.text)).toEqual(['see you at 5']);
  });

  it('can be answered by the name', async () => {
    const r = rig();
    await say(r, 'message Rahul saying hi');
    await say(r, 'Sharma');
    expect(r.app.open?.name).toBe('Rahul Sharma');
  });

  it('asks again when the answer fits both, and gives up on an unrelated reply', async () => {
    const r = rig();
    await say(r, 'message Rahul saying hi');
    expect((await say(r, 'rahul'))?.spoken).toMatch(/not sure which/);
    expect(await say(r, 'open youtube')).toBeNull();
    expect(r.app.open).toBeNull();
  });

  it('asks without searching when its own saved names already show two', async () => {
    const r = rig({ learning: 'on' });
    r.book.learn('whatsapp', ['Rahul Sharma', 'Rahul Verma', 'Priya Singh']);
    const asked = await say(r, 'message Rahul saying hi');
    expect(asked?.spoken).toBe('Which one: Rahul Sharma or Rahul Verma?');
    expect(r.invoked).toEqual([]); // not a single page step yet
    await say(r, 'verma');
    expect(r.app.open?.name).toBe('Rahul Verma');
    expect(r.app.calls).toContain('fill:Search or start new chat=rahul verma'); // the exact name was searched, not "verma" alone
  });
});

describe('what the saved names change', () => {
  it('searches the exact chat when the full name was said, or a name the user confirmed before', async () => {
    const r = rig({ learning: 'on' });
    r.book.learn('whatsapp', ['Priya Singh', 'Amit Kumar']);
    await say(r, 'message Priya Singh saying hi');
    expect(r.app.calls).toContain('fill:Search or start new chat=priya singh');
    r.book.addAlias('whatsapp', 'Amit Kumar', 'Amit bhai');
    r.app.calls.length = 0;
    await say(r, 'message amit bhai saying hi');
    expect(r.app.calls).toContain('fill:Search or start new chat=amit kumar');
  });

  it("never narrows a partial name using only what it has learned: the app's own search sees everyone", async () => {
    const r = rig({ learning: 'on' });
    r.book.learn('whatsapp', ['Rahul Sharma']); // knows ONE Rahul; the app has two
    const asked = await say(r, 'message Rahul saying hi');
    expect(asked?.spoken).toBe('Which one: Rahul Sharma or Rahul Verma?');
    expect(r.app.open).toBeNull();
    expect(r.app.calls).toContain('fill:Search or start new chat=rahul');
  });

  it('works out where the name ends from the saved names when nobody said', async () => {
    const r = rig({ learning: 'on' });
    r.book.learn('whatsapp', ['Priya Singh', 'Amit Kumar']);
    const out = await say(r, "message Priya Singh I'll call you tonight");
    expect(r.app.draft).toBe("I'll call you tonight");
    expect(out?.spoken).toMatch(/^Found Priya Singh/);
    r.session.clear();
    await say(r, 'tell amit I reached');
    expect(r.app.draft).toBe('I reached');
  });

  it('does not guess where a name ends when it knows no names', async () => {
    const r = rig();
    expect(await say(r, "message Priya I'll call you tonight")).toBeNull(); // the model can ask who
    expect(r.invoked).toEqual([]);
  });

  it('redoes a split at "that" when the first part is nobody it knows', async () => {
    const r = rig({ learning: 'on' });
    r.book.learn('whatsapp', ['Priya Singh']);
    await say(r, 'message Priya I think that it is fine');
    expect(r.app.draft).toBe('I think that it is fine');
    expect(r.app.open?.name).toBe('Priya Singh');
  });

  it('remembers what the user called someone after a confirmed send', async () => {
    const r = rig();
    await say(r, 'message Sharma saying hello');
    await say(r, 'yes'); // asked about remembering names: this yes is for the SEND
    const consent = await say(r, 'yes');
    expect(consent?.spoken).toMatch(/remember chat names from now on/);
    expect(r.book.learning()).toBe('on');
    const sharma = r.book.list('whatsapp').find((c) => c.name === 'Rahul Sharma');
    expect(sharma).toMatchObject({ useCount: 1, aliases: ['Sharma'] });
    r.book.learn('whatsapp', ['Anita Sharma']);
    expect(r.book.resolve('whatsapp', 'sharma')).toMatchObject({ kind: 'unique', contact: { name: 'Rahul Sharma' }, via: 'alias' });
  });
});

describe('asking before it remembers anything', () => {
  it('offers once, after the first message that went, and keeps nothing until the user says yes', async () => {
    const r = rig();
    await say(r, 'message Priya Singh saying hi');
    const sent = await say(r, 'yes');
    expect(sent?.spoken).toMatch(/^Sent to Priya Singh\. By the way, I can remember the names in your WhatsApp.*Want that\? Say yes or no\.$/);
    expect(r.book.count()).toBe(0);
    const no = await say(r, 'no');
    expect(no?.spoken).toBe("Okay, I won't keep any chat names.");
    expect(r.book.learning()).toBe('off');
    expect(r.book.count()).toBe(0);
    // and it does not ask again
    r.app.thread = [];
    await say(r, 'message Priya Singh saying hi again');
    expect((await say(r, 'yes'))?.spoken).toBe('Sent to Priya Singh.');
  });

  it('keeps the chat it just used when the answer is yes', async () => {
    const r = rig();
    await say(r, 'message Priya Singh saying hi');
    await say(r, 'yes');
    await say(r, 'yes');
    expect(r.book.list('whatsapp').map((c) => c.name)).toEqual(['Priya Singh']);
    expect(r.book.learning()).toBe('on');
  });

  it('learns nothing while the answer is no', async () => {
    const r = rig({ learning: 'off' });
    await say(r, 'message Rahul Sharma saying hi');
    await say(r, 'yes');
    expect(r.book.count()).toBe(0);
  });
});

describe('remembering and forgetting chat names', () => {
  it('"remember my WhatsApp contacts" reads the names showing, says what it kept, and never keeps a preview or a number', async () => {
    const r = rig();
    const out = await say(r, 'remember my WhatsApp contacts');
    expect(out?.ok).toBe(true);
    expect(out?.spoken).toBe("Okay, I'll remember chat names from now on. I know 5 so far — like Amit Kumar, Mum and Priya Singh. I'll add more as you message people, and you can see or remove them in Memory.");
    expect(r.book.learning()).toBe('on');
    const stored = JSON.stringify([db.all('SELECT * FROM contacts'), db.all('SELECT * FROM contact_aliases'), db.all('SELECT * FROM contacts_meta')]);
    for (const private_ of ['hunter2', 'See you tomorrow', 'Thanks for the loan', 'Call me', '10:42', '98765', '+91', 'clinic']) expect(stored).not.toContain(private_);
  });

  it('opens the chat app first if needed', async () => {
    const r = rig();
    r.app.url = 'https://example.com/';
    await say(r, 'learn my contacts');
    expect(r.invoked).toEqual(['learn_chat_names', 'open_website', 'learn_chat_names']);
    expect(r.book.countFor('whatsapp')).toBe(5);
  });

  it('is refused while Chats are off', async () => {
    const r = rig({ settings: OFF });
    expect((await say(r, 'remember my whatsapp contacts'))?.spoken).toMatch(/Chats are off for WhatsApp/);
    expect(r.book.learning()).toBe('unasked');
    expect(r.book.count()).toBe(0);
  });

  it('forgets, stops, and counts', async () => {
    const r = rig();
    await say(r, 'remember my WhatsApp contacts');
    expect((await say(r, 'how many contacts do you know'))?.spoken).toBe('I know 5 chat names. You can see or remove them in Memory.');
    expect((await say(r, 'forget my contacts'))?.spoken).toBe('Done. I forgot 5 chat names.');
    expect(r.book.count()).toBe(0);
    expect(r.book.learning()).toBe('on'); // forgetting the names is not the same as stopping
    expect((await say(r, 'forget my contacts'))?.spoken).toBe("I don't have any chat names saved.");
    expect((await say(r, "don't remember my contacts"))?.spoken).toMatch(/won't keep any chat names/);
    expect(r.book.learning()).toBe('off');
    expect((await say(r, 'how many contacts do you know'))?.spoken).toMatch(/not remembering chat names/);
  });

  it('learns names as the model looks for chats, only after the user said yes', async () => {
    const off = rig();
    await off.app.listItems();
    await new ToolRegistryFor(off).invoke('find_chat', { query: 'Rahul' });
    expect(off.book.count()).toBe(0);

    db.exec('DELETE FROM contacts_meta');
    const on = rig({ learning: 'on' });
    await new ToolRegistryFor(on).invoke('find_chat', { query: 'Rahul' });
    expect(on.book.list('whatsapp').map((c) => c.name)).toEqual(['Rahul Sharma', 'Rahul Verma']); // only the rows that fit what was asked
  });
});

describe('opening a chat', () => {
  it('opens it and sends nothing', async () => {
    const r = rig();
    const out = await say(r, "open Priya's chat");
    expect(out).toMatchObject({ ok: true, spoken: 'Opened the chat with Priya Singh.' });
    expect(r.app.open?.name).toBe('Priya Singh');
    expect(r.invoked).toEqual(['find_chat']);
    expect(r.app.thread).toEqual([]);
  });
});

describe('when the browser is not connected', () => {
  it('hands the request back to the model, which knows how to help connect one, and says nothing odd', async () => {
    const r = rig({ noBrowser: ['find_chat'] });
    expect(await say(r, 'message Priya Singh saying hi')).toBeNull();
    expect(await say(r, "open Priya's chat")).toBeNull();
    expect(r.invoked).toEqual(['find_chat', 'find_chat']);
    expect(await say(r, 'yes')).toBeNull(); // nothing is waiting
  });

  it('also when opening the chat app finds no browser', async () => {
    const r = rig({ noBrowser: ['open_website'] });
    r.app.url = 'https://example.com/';
    expect(await say(r, 'message Priya Singh saying hi')).toBeNull();
  });

  it('keeps the yes it was given for remembering names, and says it could not reach the app', async () => {
    const r = rig({ noBrowser: ['learn_chat_names'] });
    const out = await say(r, 'remember my WhatsApp contacts');
    expect(out).toMatchObject({ ok: true });
    expect(out?.spoken).toBe("Okay, I'll remember chat names from now on. I couldn't reach WhatsApp in your browser just now — open it there and ask me again.");
    expect(r.book.learning()).toBe('on');
  });
});

describe('what it says is for the user, not the model', () => {
  it('never reads out instructions meant for the model', async () => {
    const said: string[] = [];
    for (const [opts, text] of [
      [{ fail: ['find_chat'] }, 'message Priya Singh saying hi'],
      [{ fail: ['fill_on_page'] }, 'message Priya Singh saying hi'],
      [{ fail: ['click_on_page'] }, 'message Priya Singh saying hi'],
      [{ fail: ['learn_chat_names'] }, 'remember my whatsapp contacts'],
      [{ fail: ['open_website'] }, 'message Priya Singh saying hi'],
    ] as const) {
      const r = rig(opts);
      if (opts.fail[0] === 'open_website') r.app.url = 'https://example.com/';
      if (opts.fail[0] === 'find_chat' && opts.fail.length === 1 && text.startsWith('message')) r.app.url = 'https://web.whatsapp.com/';
      const first = await say(r, text);
      if (first !== null) said.push(first.spoken);
      if (opts.fail[0] === 'click_on_page') {
        const second = await say(r, 'yes');
        if (second !== null) said.push(second.spoken);
      }
    }
    expect(said.length).toBeGreaterThanOrEqual(4);
    for (const line of said) expect(line, line).not.toMatch(/connect_chrome|Call |call |tool|Ask the user|ask the user|find_chat|click_on_page|failed$/);
  });
});

describe('what it leaves alone', () => {
  it('passes on anything that is not a chat request', async () => {
    const r = rig();
    for (const text of ['open youtube', 'what is the weather', 'remember that Ravi is my brother', 'send my project folder to Priya on whatsapp', 'yes']) {
      expect(await say(r, text), text).toBeNull();
    }
    expect(r.invoked).toEqual([]);
  });
});

/** Calls a tool of a rig by name, the way the model would. */
class ToolRegistryFor {
  constructor(private readonly r: Rig) {}
  invoke(name: string, args: ToolArgs): Promise<ToolResult> {
    const names = { learn: (a: string, l: readonly string[]) => this.r.book.learn(a, l), used: (a: string, l: string) => this.r.book.used(a, l), learning: () => this.r.book.learning() === 'on' };
    const policy = new CommunicationPolicy(() => ON);
    const tools = createChatTools({ service: this.r.app, policy, session: this.r.session, folders, files: new FakeDisk(), sleep: async () => undefined, names });
    const tool = tools.find((t) => t.schema.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.execute(args);
  }
}

describe('a slow connection: the chat app takes its time', () => {
  it('waits for the page to finish loading instead of giving up after a few seconds', async () => {
    const r = rig();
    r.app.url = 'about:blank'; // not open yet: it has to be opened first
    r.app.loadingFor = 25; // far more looks than the old five-second wait allowed
    const out = await say(r, 'send the latest pdf to Priya Singh on WhatsApp');
    expect(out?.spoken).toBe('Found Priya Singh. Send the file "report.pdf"?');
    expect(out?.pending).toBeUndefined();
    expect(r.app.thread).toEqual([]); // still nothing sent: the question comes first
  });

  it('a chat app that was already open but is still loading is waited for too', async () => {
    const r = rig();
    r.app.loadingFor = 8;
    const out = await say(r, 'message Priya Singh saying call me');
    expect(out?.spoken).toMatch(/^Found Priya Singh\.|Priya Singh/);
    expect(out?.spoken.endsWith('?')).toBe(true);
    expect(out?.pending).toBeUndefined();
  });

  it('after a very long wait it says so, keeps the task, and has typed and sent nothing', async () => {
    const r = rig();
    r.app.url = 'about:blank';
    r.app.loadingFor = 100_000;
    const out = await say(r, 'send the latest pdf to Priya Singh on WhatsApp');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toContain('taking a long time to load');
    expect(out?.spoken).toContain("I'll keep trying");
    expect(out?.pending).toMatchObject({ kind: 'retry', why: 'WhatsApp is still loading' });
    expect(r.app.thread).toEqual([]);
    expect(r.app.attached).toBeNull();
  });

  it('a log-in screen is not waited out: the person has to scan, and Eya carries on when they have', async () => {
    const r = rig();
    r.app.loginScreen = true;
    const out = await say(r, 'message Priya Singh saying call me');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toContain('QR code');
    expect(out?.pending).toMatchObject({ kind: 'needs_you', watch: 'browser' });
    expect(r.invoked.filter((n) => n === 'find_chat').length).toBeLessThan(4);
  });

  it('a chat that is not there is still said quickly when the page has loaded (no long wait for nothing)', async () => {
    const r = rig();
    const out = await say(r, 'message Zebediah Quux saying hello');
    expect(out?.spoken).toMatch(/couldn't find a chat called Zebediah Quux/);
    expect(r.invoked.filter((n) => n === 'find_chat').length).toBeLessThan(4);
  });

  it('once the page is ready, carrying on gets straight to the question (a task tried again is quick)', async () => {
    const r = rig();
    r.app.url = 'about:blank';
    r.app.loadingFor = 100_000;
    await say(r, 'send the latest pdf to Priya Singh on WhatsApp'); // gives up for now
    r.app.loadingFor = 0; // the page has loaded by the time the task is tried again
    const again = await say(r, 'send the latest pdf to Priya Singh on WhatsApp');
    expect(again?.spoken).toBe('Found Priya Singh. Send the file "report.pdf"?');
  });
});
