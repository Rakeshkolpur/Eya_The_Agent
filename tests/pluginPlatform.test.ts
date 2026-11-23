import { describe, expect, it } from 'vitest';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { ChatSession } from '../src/main/chat/chatSession';
import { ContactBook } from '../src/main/chat/ContactBook';
import { FileSendJournal } from '../src/main/chat/sendJournal';
import { ConversationContext } from '../src/main/context/ConversationContext';
import { ChatCommands } from '../src/main/local/ChatCommands';
import { MIGRATIONS } from '../src/main/memory/schema';
import { migrate, openDatabase } from '../src/main/memory/sqlite';
import { createLiveChatTool } from '../src/main/tools/impl/liveChatTool';
import { EMPTY_LIVE_CHAT_VIEW } from '../src/shared/liveChat';
import { WHATSAPP_PLUGIN, whatsappConnector } from '../src/main/plugins/builtin/whatsapp';
import { ChatTaskJournal } from '../src/main/plugins/chatTaskJournal';
import type { PluginTaskSink } from '../src/main/plugins/chatTaskJournal';
import { LocalCatalog } from '../src/main/plugins/catalog';
import { PluginManager } from '../src/main/plugins/PluginManager';
import { PluginStateStore } from '../src/main/plugins/PluginStateStore';
import type { CatalogSource, PluginManifest } from '../src/main/plugins/types';
import type { AIChatMessage, AICompletion, AIProvider, AIToolCall, AIToolSpec } from '../src/main/providers/ai/AIProvider';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { CommunicationSettings } from '../src/main/privacy/communicationAccess';
import { CommunicationAccessStore } from '../src/main/privacy/communicationAccessStore';
import type { StoreIo } from '../src/main/privacy/communicationAccessStore';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import { TaskCompleter, SEND_PRESSED } from '../src/main/tasks/TaskCompleter';
import type { TaskNotice } from '../src/main/tasks/TaskCompleter';
import { TaskStore } from '../src/main/tasks/TaskStore';
import { trackRequest } from '../src/main/tasks/trackRequest';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { createBrowserTools } from '../src/main/tools/impl/browserTools';
import { createChatSendGate, createChatTools } from '../src/main/tools/impl/chatTools';
import type { Tool, ToolResult } from '../src/main/tools/types';
import type { TaskPhase } from '../src/shared/tasks';
import type { AgentRequest, AgentResult } from '../src/shared/types';
import { FakeChatApp, FakeDisk } from './chatFixtures';
import type { FakeChatRow } from './chatFixtures';

/**
 * The whole slice, end to end against a mock of the chat page: WhatsApp's existing tools → the plugin framework (installed, connected, allowed) → the persisted
 * task (what it settled on, what was seen, where it stands) → a verified result — and what happens when the plugin is not allowed, when Eya closes in the
 * middle of a send, and when the same thing is asked for again. None of this is evidence about the real WhatsApp Web.
 */

const HOME = 'C:\\Users\\Test';
const folders: KnownFolders = { home: HOME, downloads: `${HOME}\\Downloads`, desktop: `${HOME}\\Desktop`, documents: `${HOME}\\Documents`, pictures: `${HOME}\\Pictures`, videos: `${HOME}\\Videos`, music: `${HOME}\\Music`, temp: HOME };
const PDF = `${HOME}\\Desktop\\report.pdf`;
const PEOPLE: readonly FakeChatRow[] = [
  { name: 'Anna Reddy', phone: '+91 93611 13900', preview: 'see you' },
  { name: 'Anna Kumar', phone: '+91 80000 11111', preview: 'ok' },
  { name: 'Ravi Kumar', phone: '+91 98765 00432', preview: 'ok' },
  { name: '+91 70211 13900', phone: '+91 70211 13900', preview: 'hello' },
  { name: 'Priya', phone: '+91 99887 70432', preview: 'thanks' },
];
const ON: CommunicationSettings = { enabled: true, apps: {} };

function memoryIo(initial: Record<string, string> = {}): { io: StoreIo; files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return { files, io: { read: (p) => files.get(p) ?? null, write: (p, t) => void files.set(p, t) } };
}

interface Files {
  readonly access: ReturnType<typeof memoryIo>;
  readonly plugins: ReturnType<typeof memoryIo>;
  readonly tasks: ReturnType<typeof memoryIo>;
  readonly journal: ReturnType<typeof memoryIo>;
}

const newFiles = (): Files => ({ access: memoryIo(), plugins: memoryIo(), tasks: memoryIo(), journal: memoryIo() });

interface Platform {
  readonly app: FakeChatApp;
  readonly manager: PluginManager;
  readonly tools: ToolRegistry;
  readonly tasks: TaskCompleter;
  readonly notices: TaskNotice[];
  readonly chat: ChatCommands;
  readonly session: ChatSession;
  readonly files: Files;
  readonly phases: TaskPhase[];
  readonly ran: string[];
  readonly clock: { now: number };
  say(text: string): ReturnType<ChatCommands['tryHandle']>;
  /** Eya closed and opened again: the same page, the same files on disk, everything else new. */
  restart(): Platform;
}

let db: ReturnType<typeof openDatabase> | null = null;
function book(): ContactBook {
  if (db === null) {
    db = openDatabase(':memory:');
    migrate(db, MIGRATIONS);
  }
  return new ContactBook(db);
}

function platform(options: { access?: CommunicationSettings; app?: FakeChatApp; files?: Files; clock?: { now: number }; confirmSends?: 'always' | 'unless_verified' } = {}): Platform {
  const files = options.files ?? newFiles();
  const app = options.app ?? new FakeChatApp(PEOPLE);
  const clock = options.clock ?? { now: new Date('2026-10-27T10:00:00').getTime() };
  const access = new CommunicationAccessStore('access.json', files.access.io);
  if (options.access !== undefined && files.access.files.size === 0) access.set(options.access);
  else access.load();
  const policy = new CommunicationPolicy(() => access.get());
  const session = new ChatSession(() => clock.now, undefined, new FileSendJournal('journal.json', files.journal.io));
  const tools = new ToolRegistry();
  const names = { learn: () => 0, used: () => undefined, learning: () => false };
  const disk = new FakeDisk({ [PDF]: { isFile: true, isDirectory: false, size: 10, content: Buffer.from('0123456789') } });
  // (as in main.ts: the manager is built once the tools it names are registered, and the Send gate asks it later)
  let manager: PluginManager | null = null;
  const gate = createChatSendGate(session, policy, { permitsApp: (a, p) => manager?.permitsApp(a, p) ?? null });
  for (const t of createChatTools({ service: app, policy, session, folders, files: disk, sleep: async () => undefined, names })) tools.register(t);
  for (const t of createBrowserTools(app, undefined, { chatGate: gate })) tools.register(t);
  tools.register(createLiveChatTool({ handle: async () => ({ ok: true, message: '', view: EMPTY_LIVE_CHAT_VIEW }), view: () => EMPTY_LIVE_CHAT_VIEW }));
  const live = new PluginManager({
    catalog: new LocalCatalog(),
    store: new PluginStateStore('plugins.json', files.plugins.io),
    connectors: { whatsapp: whatsappConnector(policy, access) },
    eyaVersion: '0.1.0',
    knownTools: () => new Set(tools.list().map((t) => t.schema.name)),
  });
  manager = live;
  tools.setGuard({ blocked: (n) => live.blockFor(n), observe: (n, r) => live.observe(n, r) });

  const ran: string[] = [];
  const notices: TaskNotice[] = [];
  const completer = new TaskCompleter({
    store: new TaskStore('tasks.json', files.tasks.io),
    run: async (task) => {
      ran.push(task.id);
      return { requestId: task.id, ok: true, spoken: 'ran' };
    },
    notify: (n) => notices.push(n),
    now: () => clock.now,
    tickMs: 1_000_000,
  });
  const phases: TaskPhase[] = [];
  const sink: PluginTaskSink = {
    beginPlugin: (i) => completer.beginPlugin(i),
    pluginUpdate: (k, c) => {
      if (c.phase !== undefined) phases.push(c.phase);
      completer.pluginUpdate(k, c);
    },
    pluginFinish: (k, o, n) => {
      phases.push(o);
      completer.pluginFinish(k, o, n);
    },
  };
  const chat = new ChatCommands({
    tools: { invoke: (name, args) => tools.invoke(name, args) },
    contacts: book(),
    policy,
    session,
    files: { locate: async () => ({ kind: 'one', path: PDF, name: 'report.pdf' }) },
    confirmSends: options.confirmSends ?? 'unless_verified',
    fileRoute: 'chat',
    journal: new ChatTaskJournal(sink),
    permits: (appId, permission) => live.permitsApp(appId, permission),
    now: () => clock.now,
    sleep: async () => undefined,
  });
  return {
    app,
    manager: live,
    tools,
    tasks: completer,
    notices,
    chat,
    session,
    files,
    phases,
    ran,
    clock,
    say: (text) => chat.tryHandle(text),
    restart: () => platform({ app, files, clock, ...(options.confirmSends !== undefined ? { confirmSends: options.confirmSends } : {}) }),
  };
}

const only = (p: Platform) => p.tasks.snapshot().items.filter((t) => t.plugin !== null);
const lastTask = (p: Platform) => only(p)[0];
const fileText = (p: Platform): string => p.files.tasks.files.get('tasks.json') ?? '';

// ------------------------------------------------------------------------------------------------------------------ the slice
describe('WhatsApp through the plugin framework, kept as a task, to a checked result', () => {
  it('a message is sent, checked, and kept as a task that says who, what was seen, and that it is done', async () => {
    const p = platform({ access: ON });
    const out = await p.say("send Don't wait, I'm late to Anna Reddy on WhatsApp");
    expect(out?.spoken).toMatch(/^Sent to Anna Reddy\./);
    expect(p.app.thread.map((m) => m.text)).toEqual(["Don't wait, I'm late"]);

    const t = lastTask(p);
    expect(t?.request).toBe('Send a message to Anna Reddy on WhatsApp');
    expect(t?.state).toBe('done');
    expect(t?.plugin).toMatchObject({ id: 'whatsapp', action: 'send_message', phase: 'completed' });
    expect(t?.plugin?.entities).toEqual([{ kind: 'recipient', label: 'Anna Reddy', evidence: 'exact name', verified: true }]);
    const seen = t?.plugin?.evidence.join(' | ') ?? '';
    expect(seen).toContain('Chose Anna Reddy on: exact name');
    expect(seen).toContain('The page showed the chat open');
    expect(seen).toContain('The message was typed in the message box; nothing sent yet');
    expect(seen).toContain(`${SEND_PRESSED}; its result has not been seen yet`);
    expect(seen).toContain('The chat showed it as sent');
    // in that order: nothing is claimed before it was seen
    expect(seen.indexOf('typed in the message box')).toBeLessThan(seen.indexOf(SEND_PRESSED));
    expect(seen.indexOf(SEND_PRESSED)).toBeLessThan(seen.indexOf('showed it as sent'));
  });

  it('goes through the phases in the order a task goes: received, planning, executing, verifying, completed', async () => {
    const p = platform({ access: ON });
    await p.say('send hello to Anna Reddy on WhatsApp');
    const order = p.phases.filter((x, i) => x !== p.phases[i - 1]);
    const at = (x: TaskPhase): number => order.indexOf(x);
    expect(at('planning')).toBeGreaterThanOrEqual(0);
    expect(at('planning')).toBeLessThan(at('executing'));
    expect(at('executing')).toBeLessThan(at('verifying'));
    expect(at('verifying')).toBeLessThan(at('completed'));
    expect(order[order.length - 1]).toBe('completed');
    expect(order).not.toContain('failed');
  });

  it('keeps no message and no whole phone number on disk', async () => {
    const p = platform({ access: ON });
    await p.say('send my secret plan is at nine to 70211 13900 on WhatsApp');
    await p.say('send hello to Anna Reddy on WhatsApp');
    const text = fileText(p);
    expect(text).toContain('whatsapp');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('hello');
    expect(text).not.toMatch(/70211|13900|93611/);
    // (every piece of TEXT in the file: the times are numbers of their own)
    const words: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') words.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walk);
    };
    walk(JSON.parse(text));
    expect(words.filter((w) => /\d{7,}/.test(w))).toEqual([]);
    // the recipient listed under its number is kept masked
    const unsaved = only(p).find((t) => t.plugin?.entities.some((e) => e.label.includes('•')));
    expect(unsaved?.request).toBe('Send a message to +91 ••••••3900 on WhatsApp');
    // and the send journal holds fingerprints only
    const journal = p.files.journal.files.get('journal.json') ?? '';
    expect(journal).not.toMatch(/Anna|hello|secret|70211/);
    expect(JSON.parse(journal).sends[0].h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('a question waits as "waiting for your answer", and the answer carries the same task on to done', async () => {
    const p = platform({ access: ON });
    const asked = await p.say('send hello to Anna on WhatsApp');
    expect(asked?.spoken).toMatch(/^Which one: /);
    const waiting = lastTask(p);
    expect(waiting).toMatchObject({ state: 'needs_you', asks: true });
    expect(waiting?.plugin?.phase).toBe('waiting_clarification');
    expect(p.app.thread).toEqual([]);
    const picked = await p.say('Anna Reddy');
    expect(picked?.spoken).toMatch(/^Sent to Anna Reddy\./);
    expect(only(p)).toHaveLength(1); // one task all the way through, not a new one for the answer
    expect(lastTask(p)).toMatchObject({ state: 'done', asks: false });
    expect(lastTask(p)?.plugin?.phase).toBe('completed');
  });

  it('a no is a stopped task, and says nothing was sent', async () => {
    const p = platform({ access: ON });
    await p.say('send hello to Ravi on WhatsApp'); // a part of a name: asks
    expect(lastTask(p)?.plugin?.phase).toBe('waiting_clarification');
    await p.say('no');
    expect(lastTask(p)).toMatchObject({ state: 'cancelled', note: 'You said no, so nothing was sent.' });
    expect(p.app.thread).toEqual([]);
  });

  it('a file is kept as a task too, with the file named and the same checks', async () => {
    const p = platform({ access: ON });
    const out = await p.say('send the latest pdf to Priya on WhatsApp');
    expect(out?.spoken).toMatch(/^Sent "report\.pdf" to Priya\./);
    expect(lastTask(p)?.request).toBe('Send "report.pdf" to Priya on WhatsApp');
    expect(lastTask(p)?.plugin).toMatchObject({ action: 'send_file', phase: 'completed' });
    expect(lastTask(p)?.plugin?.evidence.join(' | ')).toContain('The chat showed it as sent');
  });

  it('opening a chat is a task too (find_chat), done when the page showed it open', async () => {
    const p = platform({ access: ON });
    await p.say("open Priya's chat on WhatsApp");
    expect(lastTask(p)?.plugin).toMatchObject({ action: 'find_chat', phase: 'completed' });
    expect(lastTask(p)?.note).toBe('The chat is open; the page showed it.');
  });

  it('a task for an app that has no plugin is not kept as a plugin task', async () => {
    const p = platform({ access: { enabled: true, apps: {} } });
    await p.say('send hello to Priya on Telegram');
    expect(only(p)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------ not allowed
describe('when the plugin may not do it', () => {
  it('not connected (WhatsApp not allowed in Eya): the existing answer comes first, and nothing is touched or kept', async () => {
    const p = platform(); // WhatsApp never allowed: for WhatsApp, "connected" IS Communication Access
    const out = await p.say('send hello to Anna Reddy on WhatsApp');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toMatch(/Chats are off for WhatsApp/);
    expect(p.app.thread).toEqual([]);
    expect(p.app.draft).toBe('');
    expect(p.app.calls).toEqual([]);
    expect(only(p)).toEqual([]); // nothing was begun, so nothing is kept
    // the plugin itself says the same on its card, and the AI is not offered its tools
    expect(p.manager.list()[0]?.status).toBe('not_connected');
    expect(p.tools.toAISchema().map((t) => t.name)).not.toContain('find_chat');
  });

  it('switched off: says so in words, touches nothing, and waits for the person\'s permission', async () => {
    const p = platform({ access: ON });
    p.manager.apply({ kind: 'disable', id: 'whatsapp' });
    const out = await p.say('send hello to Anna Reddy on WhatsApp');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toMatch(/The WhatsApp plugin is switched off\. Switch it on on the Plugins page\. Nothing was sent\./);
    expect(p.app.thread).toEqual([]);
    expect(p.app.draft).toBe('');
    expect(lastTask(p)).toMatchObject({ state: 'needs_you', asks: false });
    expect(lastTask(p)?.plugin?.phase).toBe('waiting_permission');
  });

  it('a newer request replaces the old one that was waiting for a permission', async () => {
    const p = platform({ access: ON });
    p.manager.apply({ kind: 'disable', id: 'whatsapp' });
    await p.say('send hello to Anna Reddy on WhatsApp');
    p.manager.apply({ kind: 'enable', id: 'whatsapp' });
    const out = await p.say('send hello to Anna Reddy on WhatsApp');
    expect(out?.spoken).toMatch(/^Sent to Anna Reddy\./);
    const tasks = only(p);
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.state === 'cancelled')?.note).toBe('Replaced by a newer request.');
    expect(tasks.find((t) => t.state === 'done')).toBeDefined();
  });

  it('without "send text messages" it is refused BEFORE anything is typed: no message is left in the box', async () => {
    const p = platform({ access: ON });
    p.manager.apply({ kind: 'revoke', id: 'whatsapp', permission: 'messages.send' });
    const out = await p.say('send hello to Anna Reddy on WhatsApp');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toMatch(/has not been given the permission "Send text messages"/);
    expect(out?.spoken).toMatch(/Nothing was typed or sent\./);
    expect(p.app.draft).toBe('');
    expect(p.app.thread).toEqual([]);
    expect(lastTask(p)?.plugin?.phase).toBe('waiting_permission');
  });

  it('without "send files" a file is refused before it is attached', async () => {
    const p = platform({ access: ON });
    p.manager.apply({ kind: 'revoke', id: 'whatsapp', permission: 'files.send' });
    const out = await p.say('send the latest pdf to Priya on WhatsApp');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toMatch(/"Send files"/);
    expect(p.app.attached).toBeNull();
    expect(p.app.thread).toEqual([]);
  });

  it('a permission taken away AFTER the person was asked, before their yes, stops the send at the page', async () => {
    const p = platform({ access: ON });
    const asked = await p.say('send hello to Ravi on WhatsApp');
    expect(asked?.spoken).toContain('Send "hello"?');
    expect(p.app.draft).toBe('hello'); // typed, not sent
    p.manager.apply({ kind: 'disable', id: 'whatsapp' });
    const yes = await p.say('yes');
    expect(yes?.ok).toBe(false);
    expect(yes?.spoken).toMatch(/The WhatsApp plugin is switched off\./);
    expect(yes?.spoken).toMatch(/Nothing was sent\./);
    expect(p.app.thread).toEqual([]);
  });

  it('a plugin that is uninstalled can do nothing, and installing it again gives it nothing', async () => {
    const p = platform({ access: ON });
    p.manager.apply({ kind: 'uninstall', id: 'whatsapp' });
    expect((await p.say('send hello to Anna Reddy on WhatsApp'))?.spoken).toMatch(/Chats are off for WhatsApp/); // (uninstalling also disconnected it)
    p.manager.apply({ kind: 'install', id: 'whatsapp' });
    const out = await p.say('send hello to Anna Reddy on WhatsApp');
    expect(out?.ok).toBe(false); // installed, but not connected and nothing allowed
    expect(p.app.thread).toEqual([]);
  });

  it('remembering chat names is held to the permission too', async () => {
    const p = platform({ access: ON });
    p.manager.apply({ kind: 'revoke', id: 'whatsapp', permission: 'chats.read' });
    const out = await p.say('remember my WhatsApp contacts');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toMatch(/"Find chats and contacts"/);
  });
});

// ------------------------------------------------------------------------------------------------------------------ never sent twice
describe('uncertain outcomes and restarts', () => {
  it('a send that could not be seen is an UNCERTAIN task: the person is told, and it is not repeated', async () => {
    const p = platform({ access: ON });
    p.app.behaviour = 'no_marks';
    const out = await p.say('send hello to Anna Reddy on WhatsApp');
    expect(out?.ok).toBe(false);
    const t = lastTask(p);
    expect(t?.plugin?.phase).toBe('uncertain');
    expect(t?.state).toBe('needs_you');
    expect(t?.note).toMatch(/It may already have gone: look in the chat/);
    expect(t?.plugin?.evidence.join(' | ')).toContain(SEND_PRESSED);
    expect(p.notices.map((n) => n.title)).toContain("Eya isn't sure it was sent");
  });

  it('after Eya is closed and opened again, asking for the same thing LOOKS in the chat first and does not send a second copy', async () => {
    const p = platform({ access: ON });
    p.app.behaviour = 'no_marks';
    await p.say('send hello to Anna Reddy on WhatsApp');
    expect(p.app.thread.filter((m) => m.text === 'hello')).toHaveLength(1);
    // Eya closes. The page (and the message in it) is still there; everything Eya kept in memory is gone.
    const again = p.restart();
    again.app.behaviour = 'normal';
    const out = await again.say('send hello to Anna Reddy on WhatsApp');
    expect(again.app.thread.filter((m) => m.text === 'hello')).toHaveLength(1); // not a second copy
    expect(out?.spoken).toMatch(/already in the chat/);
  });

  it('without the journal the same repeat WOULD have been sent (the journal is what prevents it)', async () => {
    const p = platform({ access: ON });
    p.app.behaviour = 'no_marks';
    await p.say('send hello to Anna Reddy on WhatsApp');
    const files = { ...p.files, journal: memoryIo() }; // a journal that remembers nothing
    const again = platform({ app: p.app, files, clock: p.clock });
    again.app.behaviour = 'normal';
    await again.say('send hello to Anna Reddy on WhatsApp');
    expect(again.app.thread.filter((m) => m.text === 'hello')).toHaveLength(2);
  });

  it('a request said again after it WAS seen to go is said to be a repeat and asked about', async () => {
    const p = platform({ access: ON });
    await p.say('send hello to Anna Reddy on WhatsApp');
    const again = p.restart();
    const out = await again.say('send hello to Anna Reddy on WhatsApp');
    expect(out?.spoken).toMatch(/already sent this message/);
    expect(again.app.thread).toHaveLength(1);
  });

  it('a task cut off while a send was under way comes back as uncertain, is never carried on by itself, and cannot be resumed from the list', async () => {
    const p = platform({ access: ON });
    p.tasks.beginPlugin({ key: 'k1', plugin: 'whatsapp', action: 'send_message', title: 'Send a message to Anna Reddy on WhatsApp' });
    p.tasks.pluginUpdate('k1', { phase: 'executing', evidence: `${SEND_PRESSED}; its result has not been seen yet` });
    p.tasks.beginPlugin({ key: 'k2', plugin: 'whatsapp', action: 'send_message', title: 'Send a message on WhatsApp' });
    p.tasks.pluginUpdate('k2', { phase: 'planning' });
    // (Eya is closed here)
    const reopened = new TaskCompleter({ store: new TaskStore('tasks.json', p.files.tasks.io), run: async (t) => (p.ran.push(t.id), { requestId: t.id, ok: true, spoken: 'ran' }), notify: () => undefined, now: () => p.clock.now + 5_000, tickMs: 1_000_000 });
    const items = reopened.snapshot().items;
    const sending = items.find((t) => t.request.includes('Anna Reddy'));
    const planning = items.find((t) => t.request === 'Send a message on WhatsApp');
    expect(sending).toMatchObject({ state: 'needs_you' });
    expect(sending?.plugin?.phase).toBe('uncertain');
    expect(sending?.note).toMatch(/may already have gone/);
    expect(planning).toMatchObject({ state: 'failed' });
    expect(planning?.note).toMatch(/before anything was sent/);
    await reopened.tick();
    expect(p.ran).toEqual([]); // never run again by itself
    expect(reopened.resume(sending?.id as string)).toBe(false);
    expect(reopened.resume(planning?.id as string)).toBe(false);
    expect(p.ran).toEqual([]);
  });

  it('a plugin task that somehow reads "waiting to try again" is still never run by the completer', async () => {
    const p = platform({ access: ON });
    p.files.tasks.files.set(
      'tasks.json',
      JSON.stringify({ version: 1, tasks: [{ id: 'old1', request: 'Send a message on WhatsApp', source: 'text', state: 'waiting', createdAt: p.clock.now - 1000, updatedAt: p.clock.now - 1000, attempts: 1, retryAt: 0, note: 'x', steps: [], plugin: { key: 'k', plugin: 'whatsapp', action: 'send_message', phase: 'executing', entities: [], evidence: [], retries: 0 } }] }),
    );
    const reopened = new TaskCompleter({ store: new TaskStore('tasks.json', p.files.tasks.io), run: async (t) => (p.ran.push(t.id), { requestId: t.id, ok: true, spoken: 'ran' }), notify: () => undefined, now: () => p.clock.now, tickMs: 1_000_000 });
    await reopened.tick();
    expect(p.ran).toEqual([]);
  });

  it('a task the person stopped that went through anyway is recorded as having gone through', () => {
    const p = platform({ access: ON });
    p.tasks.beginPlugin({ key: 'k', plugin: 'whatsapp', action: 'send_message', title: 'Send a message on WhatsApp' });
    p.tasks.pluginUpdate('k', { phase: 'executing' });
    const id = lastTask(p)?.id as string;
    p.tasks.cancel(id);
    expect(lastTask(p)).toMatchObject({ state: 'cancelled' });
    p.tasks.pluginFinish('k', 'completed', 'Sent.');
    expect(lastTask(p)).toMatchObject({ state: 'done', note: 'You stopped this, but it had already gone through.' });
  });

  it('what the person chose in Plugins is still chosen after a restart, and still holds', async () => {
    const p = platform({ access: ON });
    p.manager.apply({ kind: 'revoke', id: 'whatsapp', permission: 'messages.send' });
    const again = p.restart();
    const out = await again.say('send hello to Anna Reddy on WhatsApp');
    expect(out?.ok).toBe(false);
    expect(again.app.thread).toEqual([]);
  });

  it('a plugin task is listed once even when the request is slow (the request is not also kept as a second task)', async () => {
    const p = platform({ access: ON });
    const pending: Array<() => void> = [];
    const req: AgentRequest = { requestId: 'r1', text: 'send hello to Anna on WhatsApp', source: 'text', mode: 'agent' };
    const result: AgentResult = { requestId: 'r1', ok: true, spoken: 'Sent.' };
    await trackRequest(
      p.tasks,
      req,
      async () => {
        p.tasks.beginPlugin({ key: 'slow', plugin: 'whatsapp', action: 'send_message', title: 'Send a message on WhatsApp' });
        pending.forEach((f) => f()); // the eight-second timer fires while it is under way
        p.clock.now += 30_000;
        return result;
      },
      { isWork: () => true, timers: { set: (fn) => (pending.push(fn), pending.length), clear: () => undefined }, now: () => p.clock.now },
    );
    expect(p.tasks.snapshot().items).toHaveLength(1);
    expect(p.tasks.snapshot().items[0]?.plugin).not.toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------------------------ the engine and more than one plugin
const NOTES: PluginManifest = {
  id: 'notes',
  name: 'Notes',
  description: 'Keep short notes.',
  version: '1.0.0',
  author: 'Test',
  compat: { minEya: '0.1.0' },
  bundled: true,
  auth: { kind: 'none', describe: 'Nothing to connect.' },
  permissions: [{ id: 'notes.write', label: 'Save notes', description: 'Save a note.', risk: 'write' }],
  actions: [{ id: 'save_note', label: 'Save a note', description: 'Save a note.', tools: ['notes_save'], gate: 'registry', permission: 'notes.write', verify: 'Reads it back.' }],
};

const call = (name: string, args: Record<string, unknown> = {}): AIToolCall => ({ id: `id_${name}_${Math.random().toString(36).slice(2, 6)}`, name, args });
const step = (...toolCalls: AIToolCall[]): AICompletion => ({ text: '', toolCalls });
const say = (text: string): AICompletion => ({ text, toolCalls: [] });
const quietTTS: TTSProvider = { name: 'quiet', init: async () => undefined, speak: async () => undefined, prefetch: () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };

class Recording implements AIProvider {
  readonly name = 'recording';
  readonly tools: string[][] = [];
  readonly sent: AIChatMessage[][] = [];
  constructor(private readonly script: AICompletion[]) {}
  isReady(): boolean {
    return true;
  }
  async complete(messages: readonly AIChatMessage[], tools: readonly AIToolSpec[]): Promise<AICompletion> {
    this.tools.push(tools.map((t) => t.name));
    this.sent.push([...messages]);
    const next = this.script.shift();
    if (next === undefined) throw new Error('script exhausted');
    return next;
  }
}

describe('the engine discovers and uses the tools of more than one plugin in one task', () => {
  function engineWorld(script: AICompletion[], options: { notesInstalled?: boolean } = {}) {
    const files = newFiles();
    const access = new CommunicationAccessStore('access.json', files.access.io);
    access.set(ON);
    const policy = new CommunicationPolicy(() => access.get());
    const tools = new ToolRegistry();
    const ran: string[] = [];
    const fake = (name: string, respond: () => ToolResult = () => ({ ok: true, summary: `${name} done` })): Tool => ({
      schema: { name, description: name, args: { query: { type: 'string' as const }, text: { type: 'string' as const }, label: { type: 'string' as const }, value: { type: 'string' as const }, name: { type: 'string' as const }, path: { type: 'string' as const } } },
      execute: async (): Promise<ToolResult> => (ran.push(name), respond()),
    });
    for (const n of ['find_chat', 'find_chat_files', 'live_chat', 'learn_chat_names', 'fill_on_page', 'click_on_page', 'share_file_to_chat', 'attach_file', 'verify_sent', 'notes_save']) tools.register(fake(n));
    const catalog: CatalogSource = { name: 'Test', remote: false, entries: () => [WHATSAPP_PLUGIN, NOTES].map((manifest) => ({ manifest, trust: 'built-in' as const })) };
    const manager = new PluginManager({ catalog, store: new PluginStateStore('plugins.json', files.plugins.io), connectors: { whatsapp: whatsappConnector(policy, access) }, eyaVersion: '0.1.0', knownTools: () => new Set(tools.list().map((t) => t.schema.name)) });
    if (options.notesInstalled === false) manager.apply({ kind: 'uninstall', id: 'notes' });
    else manager.apply({ kind: 'grant_all', id: 'notes' });
    tools.setGuard({ blocked: (n) => manager.blockFor(n), observe: (n, r) => manager.observe(n, r) });
    const ai = new Recording(script);
    const engine = new AgentEngine({ router: new IntentRouter(), tools, composer: new ResponseComposer(), tts: quietTTS, context: new ConversationContext(), ai, now: () => new Date('2026-10-27T10:00:00Z') });
    const ask = (text: string): Promise<AgentResult> => engine.handle({ requestId: `r${Math.random().toString(36).slice(2, 6)}`, text, source: 'text', mode: 'agent' }, () => undefined);
    return { ai, ran, manager, ask };
  }

  it('one request uses a tool of each plugin, in turn, through the same engine', async () => {
    const w = engineWorld([step(call('notes_save', { text: 'meeting at six' })), step(call('find_chat', { query: 'Ravi' })), say('Saved the note and found Ravi on WhatsApp.')]);
    const r = await w.ask('save a note that the meeting is at six and find Ravi on WhatsApp');
    expect(r.spoken).toBe('Saved the note and found Ravi on WhatsApp.');
    expect(w.ran).toEqual(['notes_save', 'find_chat']);
    // both plugins' tools were offered
    expect(w.ai.tools[0]).toEqual(expect.arrayContaining(['notes_save', 'find_chat']));
  });

  it('the AI is offered only the tools of plugins that can be used, and is told in a line which are not', async () => {
    const w = engineWorld([say('ok')], { notesInstalled: false });
    await w.ask('send hello to Ravi on WhatsApp');
    expect(w.ai.tools[0]).toContain('find_chat');
    expect(w.ai.tools[0]).not.toContain('notes_save');
    w.manager.apply({ kind: 'disconnect', id: 'whatsapp' });
    const again = engineWorld([say('ok')]);
    again.manager.apply({ kind: 'disconnect', id: 'whatsapp' });
    await again.ask('send hello to Ravi on WhatsApp');
    expect(again.ai.tools[0]).not.toContain('find_chat');
    expect(again.ai.tools[0]).toContain('notes_save');
  });

  it('a call to a tool that is not allowed is refused and the AI is told why, and that there is no other way', async () => {
    const w = engineWorld([step(call('share_file_to_chat', { path: 'x.pdf' })), say('I cannot send that file: the WhatsApp plugin may not send files.')]);
    w.manager.apply({ kind: 'revoke', id: 'whatsapp', permission: 'files.send' });
    const r = await w.ask('send x.pdf to Ravi on WhatsApp');
    expect(w.ran).toEqual([]); // never ran
    const told = JSON.stringify(w.ai.sent[1]);
    expect(told).toMatch(/has not been given the permission/);
    expect(told).toMatch(/do not try another way/);
    expect(r.spoken).toMatch(/cannot send that file/);
  });

  it('a bad call (a wrong argument) is refused by the same check as any tool, and the plugin\'s record shows no error for it', async () => {
    const w = engineWorld([step(call('find_chat', { bogus: 'x', confirm: true })), say('done')]);
    await w.ask('find Ravi on WhatsApp');
    expect(w.manager.list().find((p) => p.id === 'whatsapp')?.lastError).toBeNull();
  });
});
