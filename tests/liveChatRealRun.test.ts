import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeError } from '../src/main/chrome/ChromeBridge';
import { ChromeBrowserService } from '../src/main/chrome/ChromeBrowserService';
import type { BridgeLike } from '../src/main/chrome/ChromeBrowserService';
import { ChatSession } from '../src/main/chat/chatSession';
import { scrub as scrubEvent } from '../src/main/chat/chatDiagnostics';
import { looksLikeControl } from '../src/main/chat/contactMatch';
import { ContactBook } from '../src/main/chat/ContactBook';
import { ChatCommands } from '../src/main/local/ChatCommands';
import { isLiveRetry } from '../src/main/local/chatIntents';
import { MIGRATIONS } from '../src/main/memory/schema';
import { migrate, openDatabase } from '../src/main/memory/sqlite';
import type { Sql } from '../src/main/memory/sqlite';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';
import { createChatTools } from '../src/main/tools/impl/chatTools';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import type { Tool } from '../src/main/tools/types';
import { FakeChatApp, FakeDisk } from './chatFixtures';
import { liveSystemPrompt } from '../src/main/agent/prompts';
import { QUICK_COMMAND_TOOL } from '../src/main/local/QuickCommands';
import { runLiveTool } from '../src/main/live/liveBridge';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { createLiveChatTool } from '../src/main/tools/impl/liveChatTool';
import { EMPTY_LIVE_CHAT_VIEW } from '../src/shared/liveChat';
import { rig, settle } from './liveChatFixtures';
import type { Rig } from './liveChatFixtures';

/**
 * What the second real run showed: a number that offered "12 unread messages" and "end-to-end encrypted" as the chats it could be, an "I opened that chat, you can do
 * now" that was handed to the AI (which told it back as "WhatsApp's layout isn't readable"), and nothing written down about why. Over a MOCK chat and a MOCK model.
 */

const NUMBER = '+91 98765 08501';
const SAID = `do live chat with number ${NUMBER}, you can introduce yourself, based on response respond until i said stop`;
const AFTER = 'i was opend that chat u can do now';

describe('"I opened that chat, you can do now" is the same request again', () => {
  it.each([
    AFTER,
    'i opened that chat',
    'I have opened the chat now',
    'the chat is open now',
    "it's opened, go",
    'ok now go',
    'now do it',
    'you can start now',
    'try again',
    'u can do now',
    'ok do now please',
    'continue',
  ])('%s → yes', (said) => {
    expect(isLiveRetry(said)).toBe(true);
  });

  it.each(['send hi to Rahul on whatsapp', 'what is the weather', 'open whatsapp', 'stop live chat', 'who is the prime minister of india', 'i will open the chat tomorrow and then we can talk about the case in detail please remember', 'do live chat with Rahul'])(
    '%s → no',
    (said) => {
      expect(isLiveRetry(said)).toBe(false);
    },
  );
});

describe('looks like a chat but is not', () => {
  it.each(['12 unread messages', '1 unread message', 'unread messages', '3 new messages', 'end-to-end encrypted', 'Messages are end-to-end encrypted', 'Messages and calls are end-to-end encrypted', 'Click to learn more'])('"%s" is not a chat', (label) => {
    expect(looksLikeControl(label)).toBe(true);
  });
  it.each(['Priya Singh', 'Rahul', '+91 98765 08501', 'Unread Rahul', 'Encrypted Files', 'End Game'])('"%s" can be a chat', (label) => {
    expect(looksLikeControl(label)).toBe(false);
  });
});

describe('through ChatCommands, with the real controller over the mock chat', () => {
  let dir: string;
  let db: Sql;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eya-realrun-'));
    db = openDatabase(join(dir, 'memory.db'));
    migrate(db, MIGRATIONS);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function commands() {
    const r = rig();
    const queries: string[] = [];
    const open = r.chat.actions.open;
    r.chat.actions.open = async (q) => (queries.push(q), open(q));
    const cc = new ChatCommands({
      tools: { invoke: async (_n: string, _a: ToolArgs): Promise<ToolResult> => ({ ok: false, summary: 'unused', error: 'unused' }) },
      contacts: new ContactBook(db),
      policy: new CommunicationPolicy(() => ({ enabled: true, apps: {} })),
      session: new ChatSession(),
      confirmSends: 'unless_verified',
      fileRoute: 'chat',
      liveChat: r.controller,
      sleep: async () => undefined,
    });
    return { r, queries, say: (text: string) => cc.tryHandle(text) };
  }

  it('the sentence of the second real run is a live chat with that number (not left for the AI)', async () => {
    const { r, queries, say } = commands();
    r.chat.openOutcome = { kind: 'ambiguous', options: [{ label: 'Rahul Sharma', choice: 1 }, { label: 'Rahul Verma', choice: 2 }] };
    const out = await say(SAID);
    expect(out, 'handled here, with Eya\'s own words').not.toBeNull();
    expect(queries).toEqual([NUMBER]);
    expect(out?.spoken).toMatch(/Several chats fit/);
    expect(r.controller.view().state).toBe('WAITING_FOR_USER');
  });

  it('then "I opened that chat, you can do now": the unfinished try is replaced and the same number is looked for again — in Eya\'s own words, never the AI\'s retelling', async () => {
    const { r, queries, say } = commands();
    r.chat.openOutcome = { kind: 'ambiguous', options: [{ label: 'Rahul Sharma', choice: 1 }, { label: 'Rahul Verma', choice: 2 }] };
    await say(SAID);
    // the person opens the chat: now the number is found
    r.chat.openOutcome = { kind: 'opened', label: 'Rahul Sharma', verified: true };
    const again = await say(AFTER);
    expect(again, 'not handed to the model').not.toBeNull();
    expect(again?.ok, again?.spoken).toBe(true);
    expect(queries).toEqual([NUMBER, NUMBER]);
    expect(again?.spoken).toMatch(/Live chat is on with Rahul Sharma/);
    expect(r.controller.view().active).toBe(true);
    expect(r.chat.watching).toBe(true);
  });

  it('and when it still cannot be done, the reason is said exactly (with the counts), not as "the layout"', async () => {
    const { r, say } = commands();
    r.chat.openOutcome = { kind: 'ambiguous', options: [{ label: 'a', choice: 1 }, { label: 'b', choice: 2 }] };
    await say(SAID);
    r.chat.openOutcome = { kind: 'opened', label: 'Rahul Sharma', verified: true };
    r.chat.reliable = false;
    const again = await say('now do it');
    expect(again?.ok).toBe(false);
    expect(again?.spoken).toMatch(/cannot read reliably/);
  });

  it('a sentence like that when no live chat was asked for just before is NOT taken for one', async () => {
    const { say } = commands();
    expect(await say(AFTER)).toBeNull();
    expect(await say('ok now go')).toBeNull();
  });

  it('nor while a live chat is really running (then "ok now go" is not about starting one)', async () => {
    const { r, say } = commands();
    await say('do live chat with Rahul');
    expect(r.controller.view().state).toBe('ACTIVE');
    expect(await say('ok now go')).toBeNull();
  });
});

describe('the controller: an unfinished try at choosing the chat is replaced; a running chat is not', () => {
  it('replaced', async () => {
    const r = rig();
    r.chat.openOutcome = { kind: 'ambiguous', options: [{ label: 'x', choice: 1 }, { label: 'y', choice: 2 }] };
    expect((await r.controller.start('Rahul')).view.state).toBe('WAITING_FOR_USER');
    r.chat.openOutcome = { kind: 'opened', label: 'Rahul Sharma', verified: true };
    const res = await r.controller.start('Rahul');
    expect(res.view.state, res.message).toBe('ACTIVE');
  });

  it('not replaced when it is really running', async () => {
    const r = rig();
    await r.controller.start('Rahul');
    const res = await r.controller.start('Rahul');
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/is running/);
    expect(res.message).toMatch(/one live chat at a time/);
  });

  it('nor when it is waiting for the person about a reply (that is a running chat)', async () => {
    const r = rig();
    r.ai.say('Hi', { confidence: 'low', commitment: true });
    await r.controller.start('Rahul', 'assisted');
    r.chat.incoming('Can you come?');
    r.chat.changed();
    await settle();
    const res = await r.controller.start('Rahul');
    expect(res.ok).toBe(false);
  });
});

describe('why it stopped is written down — a category and counts, never a word of a chat', () => {
  function withNotes() {
    const r: Rig = rig();
    const notes: Array<{ op: string; category?: string; counts?: Readonly<Record<string, number>> }> = [];
    const c = new (r.controller.constructor as new (deps: unknown) => Rig['controller'])({ ...r.deps, diagnose: (e: { op: string; category?: string; counts?: Record<string, number> }) => notes.push(e) });
    return { r, c, notes };
  }

  it('a page called unreadable: the counts', async () => {
    const { r, c, notes } = withNotes();
    r.chat.reliable = false;
    await c.start('Rahul');
    expect(notes.find((n) => n.category === 'unreadable')).toBeDefined();
    expect(notes.some((n) => n.op === 'livechat_failed')).toBe(true);
  });

  it('several chats offered: how many', async () => {
    const { r, c, notes } = withNotes();
    r.chat.openOutcome = { kind: 'ambiguous', options: [{ label: 'x', choice: 1 }, { label: 'y', choice: 2 }] };
    await c.start('Rahul');
    expect(notes).toContainEqual({ op: 'livechat_start', category: 'several_chats', counts: { offered: 2 } });
  });

  it('a chat that started: how the sides of what it read were told, as counts', async () => {
    const { r, c, notes } = withNotes();
    r.chat.diagnostics = { rows: 16, otherRows: 3, messageLike: 16, how: 'bubbles', unknownSide: 0, sides: { geo: 14, ticks: 5, dflt: 1, conflicts: 2 } };
    const res = await c.start('Rahul');
    expect(res.view.state, res.message).toBe('ACTIVE');
    expect(notes).toContainEqual({ op: 'livechat_read', category: 'start_ok', counts: { rows: 16, other: 3, marks: 16, geo: 14, ticks: 5, dflt: 1, conflicts: 2 } });
    // (and nothing of the chat itself in it)
    expect(JSON.stringify(notes)).not.toMatch(/Rahul|Hello|Hi/);
  });

  it('a pause: the reason', async () => {
    const { c, notes } = withNotes();
    await c.start('Rahul');
    await c.pause('user');
    expect(notes).toContainEqual({ op: 'livechat_paused', category: 'user' });
  });

  it('what is written down is plain: names of counts, numbers, nothing else', () => {
    const e = scrubEvent({ task: 'livechat', op: 'livechat_start', category: 'unreadable', counts: { rows: 12, other: 26, 'a b c': 5, text: Number.NaN } });
    expect(e).toMatchObject({ task: 'livechat', op: 'livechat_start', category: 'unreadable', n_rows: 12, n_other: 26, n_abc: 5 });
    expect(Object.keys(e).some((k) => k === 'n_text')).toBe(false);
  });
});

describe('the page\'s masked shape reaches Eya clean', () => {
  class Bridge implements BridgeLike {
    connected = true;
    constructor(private readonly reply: unknown) {}
    isConnected() {
      return true;
    }
    async request<T = unknown>(op: string): Promise<T> {
      if (op !== 'chat_read') throw new BridgeError('extension_error', `unexpected ${op}`);
      return this.reply as T;
    }
    capabilities() {
      return ['chat_read', 'chat_watch', 'chat_read_bubbles', 'chat_read_sides', 'chat_documents'];
    }
  }

  it('is kept to the characters a shape uses, and cut short', async () => {
    const shape = `main=#aaaa; how=bubbles; counts=rows:3,other:9; ids=aaaaa_999@a.a_AAAA; pre=[99:99, 99/99/9999] Aaaaa:; bubble=div[row]{msg}(data-id)<div ${'x'.repeat(900)}<script>alert(1)</script>`;
    const service = new ChromeBrowserService(new Bridge({ tabId: 1, hasMain: true, title: 'x', messages: [], reliable: false, diagnostics: { rows: 3, otherRows: 9, messageLike: 4, how: 'bubbles', unknownSide: 3, shape } }));
    const r = await service.chatRead(10);
    expect(r.ok && r.diagnostics?.how).toBe('bubbles');
    expect(r.ok && r.diagnostics?.unknownSide).toBe(3);
    const kept = r.ok ? (r.diagnostics?.shape ?? '') : '';
    expect(kept.length).toBeLessThanOrEqual(600);
    expect(kept).toMatch(/^main=#aaaa; how=bubbles; counts=rows:3,other:9; ids=aaaaa_999@a\.a_AAAA; pre=\[99:99, 99\/99\/9999\] Aaaaa:;/);
    expect(kept).not.toMatch(/[`'"\\;]{2}/); // (nothing but a shape's own characters)
  });

  it('how the sides were told arrives as counts under fixed names only: other names, negative or non-number values are dropped', async () => {
    const reply = { tabId: 1, hasMain: true, title: 'x', messages: [], reliable: true, diagnostics: { rows: 16, otherRows: 3, messageLike: 16, how: 'bubbles', unknownSide: 0, sides: { geo: 14, ticks: 5, dflt: 1, conflicts: 2, cls: -1, id: 'many', 'Rahul S.': 9, '__proto__': 3 } } };
    const r = await new ChromeBrowserService(new Bridge(reply)).chatRead(10);
    expect(r.ok && r.diagnostics?.sides).toEqual({ geo: 14, ticks: 5, dflt: 1, conflicts: 2 });
    // none given: no "sides" at all
    const none = await new ChromeBrowserService(new Bridge({ ...reply, diagnostics: { rows: 16, otherRows: 3, messageLike: 16, how: 'bubbles' } })).chatRead(10);
    expect(none.ok && none.diagnostics?.sides).toBeUndefined();
  });

  it('a made-up "how" or negative counts are dropped', async () => {
    const service = new ChromeBrowserService(new Bridge({ tabId: 1, hasMain: true, title: 'x', messages: [], reliable: true, diagnostics: { rows: 1, otherRows: -4, messageLike: 0, how: 'Rm -rf /' } }));
    const r = await service.chatRead(10);
    expect(r.ok && r.diagnostics).toBeUndefined(); // (counts that are not counts: no diagnostics at all)
    const ok = await new ChromeBrowserService(new Bridge({ tabId: 1, hasMain: true, title: 'x', messages: [], reliable: true, diagnostics: { rows: 1, otherRows: 4, messageLike: 0, how: 'Rm -rf /' } })).chatRead(10);
    expect(ok.ok && ok.diagnostics).toEqual({ rows: 1, otherRows: 4, messageLike: 0 });
  });
});

describe('find_chat: the chat that is already open and shows exactly the number asked for IS that chat', () => {
  const HOME = 'C:\Users\Test';
  const folders: KnownFolders = { home: HOME, downloads: HOME, desktop: HOME, documents: HOME, pictures: HOME, videos: HOME, music: HOME, temp: HOME };
  function world(composer: string) {
    const app = new FakeChatApp();
    const original = app.inspectPage.bind(app);
    app.inspectPage = async () => ({ ...(await original()), inputs: ['Search or start new chat', composer] });
    const session = new ChatSession();
    const tools = createChatTools({ service: app, policy: new CommunicationPolicy(() => ({ enabled: true, apps: {} })), session, folders, files: new FakeDisk() });
    const find = tools.find((t) => t.schema.name === 'find_chat') as Tool;
    return { app, session, find };
  }
  const touched = (calls: readonly string[]): string[] => calls.filter((c) => /^(fill|click|clickItem|list)/.test(c));

  it('opened and verified at once, with nothing typed into the search and nothing clicked', async () => {
    const { app, session, find } = world('Type a message to +91 70000 11122');
    const r = await find.execute({ query: '+91 70000 11122' });
    expect(r.ok, r.error).toBe(true);
    expect(r.data).toMatchObject({ status: 'opened', alreadyOpen: true, verified: true, headerChecked: true, numberEndsIn: '122' });
    expect(touched(app.calls)).toEqual([]);
    expect(session.chat()).toMatchObject({ label: '+91 70000 11122', verified: true, headerChecked: true, proof: 'composer' });
  });

  it('the number written another way is the same number', async () => {
    const { app, find } = world('Type a message to +91 70000 11122');
    const r = await find.execute({ query: '7000011122' });
    expect(r.data).toMatchObject({ status: 'opened', alreadyOpen: true });
    expect(touched(app.calls)).toEqual([]);
  });

  it('another number is NOT taken for it: it is looked for as before', async () => {
    const { app, find } = world('Type a message to +91 70000 11122');
    const r = await find.execute({ query: '+91 98765 43210' });
    expect(r.data?.['alreadyOpen']).toBeUndefined();
    expect(touched(app.calls).length).toBeGreaterThan(0);
  });

  it('a message box that names a person, not a number, is not enough for a number', async () => {
    const { app, find } = world('Type a message to Rahul Sharma');
    const r = await find.execute({ query: '+91 70000 11122' });
    expect(r.data?.['alreadyOpen']).toBeUndefined();
    expect(touched(app.calls).length).toBeGreaterThan(0);
  });

  it('only for a whole number: the last digits of one are not an identity', async () => {
    const { app, find } = world('Type a message to +91 70000 11122');
    const r = await find.execute({ query: 'ending 122' });
    expect(r.data?.['alreadyOpen']).toBeUndefined();
    expect(touched(app.calls).length).toBeGreaterThan(0);
  });
});

describe('the voice AI is told what a live chat is, and to call quick_command for it', () => {
  it('the quick_command tool names live chat and the phrases people use', () => {
    expect(QUICK_COMMAND_TOOL.description).toMatch(/LIVE CHAT in WhatsApp/);
    expect(QUICK_COMMAND_TOOL.description).toMatch(/do live chat with <name or number>/);
    expect(QUICK_COMMAND_TOOL.description).toMatch(/I opened that chat, you can do now/);
    expect(QUICK_COMMAND_TOOL.description).toMatch(/NOT a call and NOT a single message/);
  });

  it('the voice prompt says to call it first, and never to say it stopped, started or cannot read the page unless the tool said so', () => {
    const prompt = liveSystemPrompt(new Date('2026-11-04T10:00:00Z'));
    expect(prompt).toMatch(/LIVE CHAT: whenever the user asks for a live chat/);
    expect(prompt).toMatch(/call quick_command FIRST/);
    expect(prompt).toMatch(/Never say you cannot do it, that WhatsApp's layout cannot be read, or that you stopped or started one, unless quick_command said so/);
    expect(prompt).toMatch(/what you did not hear from a tool did not happen/);
  });
});

describe('an extension that cannot read the page the way WhatsApp shows it today is said to be old — not the page unreadable', () => {
  // (an extension that says what it can do)
  class Caps implements BridgeLike {
    calls: string[] = [];
    constructor(private readonly caps: readonly string[]) {}
    isConnected() {
      return true;
    }
    async request<T = unknown>(op: string): Promise<T> {
      this.calls.push(op);
      if (op === 'chat_watch') return { watching: true, tabId: 1, hasMain: true, rows: 0, title: 'x' } as T;
      return { tabId: 1, hasMain: true, title: 'x', messages: [], reliable: true } as T;
    }
    capabilities(): readonly string[] {
      return this.caps;
    }
  }
  // (one that does not)
  class Silent implements BridgeLike {
    isConnected() {
      return true;
    }
    async request<T = unknown>(op: string): Promise<T> {
      if (op === 'chat_watch') return { watching: true, tabId: 1, hasMain: true, rows: 0, title: 'x' } as T;
      return { tabId: 1, hasMain: true, title: 'x', messages: [], reliable: true } as T;
    }
  }
  const OLD = ['chat_read', 'chat_watch', 'chat_read_bubbles']; // (version 0.11.3: it reads bubbles, but cannot tell their side on the page as it is today)

  it('starting says to reload it, and names the version — and asks the extension nothing', async () => {
    const bridge = new Caps(OLD);
    const r = await new ChromeBrowserService(bridge).chatWatch('start');
    expect(r).toMatchObject({ ok: false, reason: 'extension_old' });
    expect(r.ok === false ? r.message : '').toMatch(/older than this live chat needs/);
    expect(r.ok === false ? r.message : '').toMatch(/version 0\.11\.6/);
    expect(bridge.calls).toEqual([]);
  });

  it('reading too', async () => {
    const r = await new ChromeBrowserService(new Caps(OLD)).chatRead(10);
    expect(r).toMatchObject({ ok: false, reason: 'extension_old' });
  });

  it('stopping a watcher is still allowed (it must be possible to switch it off)', async () => {
    const bridge = new Caps(OLD);
    const r = await new ChromeBrowserService(bridge).chatWatch('stop');
    expect(r.ok).toBe(true);
    expect(bridge.calls).toEqual(['chat_watch']);
  });

  it('the current extension goes ahead', async () => {
    const r = await new ChromeBrowserService(new Caps([...OLD, 'chat_read_bubbles', 'chat_read_sides', 'chat_documents'])).chatWatch('start');
    expect(r.ok).toBe(true);
    expect((await new ChromeBrowserService(new Caps([...OLD, 'chat_read_bubbles', 'chat_read_sides', 'chat_documents'])).chatRead(10)).ok).toBe(true);
  });

  it('an extension that reads the sides but reads a document as a text message (0.11.5) is told to reload, and asked nothing — a PDF would never be taken', async () => {
    const bridge = new Caps([...OLD, 'chat_read_sides', 'chat_media']);
    const w = await new ChromeBrowserService(bridge).chatWatch('start');
    expect(w).toMatchObject({ ok: false, reason: 'extension_old' });
    expect(w.ok === false ? w.message : '').toMatch(/reads a document someone sends as an ordinary text message/);
    expect(w.ok === false ? w.message : '').toMatch(/version 0\.11\.6/);
    expect(await new ChromeBrowserService(new Caps([...OLD, 'chat_read_sides', 'chat_media'])).chatRead(10)).toMatchObject({ ok: false, reason: 'extension_old' });
    expect(bridge.calls).toEqual([]);
  });

  it('a bridge that does not say what it can do is taken as it is', async () => {
    expect((await new ChromeBrowserService(new Silent()).chatWatch('start')).ok).toBe(true);
  });

  it('the live chat then says exactly that (a failed start with a reason the person can act on)', async () => {
    const r = rig();
    r.chat.watcherFails = { message: 'The Eya extension in this browser is older than this live chat needs: reload it once.', pause: 'extension_old' };
    const res = await r.controller.start('Rahul');
    expect(res.view).toMatchObject({ state: 'FAILED', pause: 'extension_old' });
    expect(res.message).toMatch(/older than this live chat needs/);
  });
});

describe('the AI is told to pass a live chat failure on in the same words', () => {
  it('the voice path: a failed live chat command comes with that instruction', async () => {
    const out = await runLiveTool(new ToolRegistry(), { name: 'quick_command', args: {}, heard: 'do live chat with Rahul' }, undefined, undefined, {
      run: async () => ({ handled: true, result: { spoken: 'The Eya extension in this browser is older than this live chat needs. Reload it.', ok: false, intent: 'chat_live', tools: ['live_chat'], refs: [] } }),
    } as never);
    const data = JSON.parse(out.content) as { data?: { say?: string; next?: string } };
    expect(data.data?.say).toMatch(/older than this live chat needs/);
    expect(data.data?.next).toMatch(/in the same words as far as you can/);
    expect(data.data?.next).toMatch(/do not shorten it/);
  });

  it('other quick commands are still said in the AI\'s own words', async () => {
    const out = await runLiveTool(new ToolRegistry(), { name: 'quick_command', args: {}, heard: 'open notepad' }, undefined, undefined, {
      run: async () => ({ handled: true, result: { spoken: 'Opened.', ok: true, intent: 'open', tools: [], refs: [] } }),
    } as never);
    expect((JSON.parse(out.content) as { data?: { next?: string } }).data?.next).toMatch(/in your own words/);
  });

  it('the live_chat tool: a failure says the same', async () => {
    const view = { ...EMPTY_LIVE_CHAT_VIEW, state: 'FAILED' as const };
    const tool = createLiveChatTool({ handle: async () => ({ ok: false, message: 'The Eya extension is older than this live chat needs.', view }), view: () => view });
    const r = await tool.execute({ action: 'start', name: 'Rahul' });
    expect(r.data?.['next']).toMatch(/in the same words as far as you can/);
    const ok = await createLiveChatTool({ handle: async () => ({ ok: true, message: 'on', view }), view: () => view }).execute({ action: 'start', name: 'Rahul' });
    expect(ok.data?.['next']).toBeUndefined();
  });
});
