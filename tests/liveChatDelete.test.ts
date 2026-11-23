import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatSession } from '../src/main/chat/chatSession';
import { ContactBook } from '../src/main/chat/ContactBook';
import { ChatCommands } from '../src/main/local/ChatCommands';
import { parseDeleteMessage, parseDeleteScope } from '../src/main/local/chatIntents';
import { MIGRATIONS } from '../src/main/memory/schema';
import { migrate, openDatabase } from '../src/main/memory/sqlite';
import type { Sql } from '../src/main/memory/sqlite';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';
import { EMPTY_LIVE_CHAT_VIEW, parseLiveChatRequest } from '../src/shared/liveChat';
import type { LiveChatRequest, LiveChatView } from '../src/shared/liveChat';
import { FakeSwitch, rig, settle } from './liveChatFixtures';

/**
 * "It should be able to delete a message — for everyone, or only here — also in WhatsApp." One message at a time, the last one the account sent; it is shown to the person first and
 * nothing is deleted without their answer. Over a MOCK chat and a MOCK page: how the real WhatsApp Web menu is built is NOT covered by these.
 */

describe('how a person says it', () => {
  it.each([
    ['delete that message', null],
    ['delete the last message', null],
    ['delete my last message for everyone', 'everyone'],
    ['delete the last message for me', 'me'],
    ['please delete that msg only for me', 'me'],
    ['remove your last message from here', 'me'],
    ['can you delete the last text for everyone', 'everyone'],
    ['unsend that', null],
    ['unsend it for everyone', 'everyone'],
    ['take back the last message', null],
    ['delete it for everyone', 'everyone'],
    ['delete that for me', 'me'],
    ['revoke the message for everybody', 'everyone'],
    ['delete the previous reply only here', 'me'],
  ])('%s → %s', (said, scope) => {
    expect(parseDeleteMessage(said)).toEqual({ scope });
  });

  it('"delete all the messages" is not done (one message, shown first): said so', () => {
    expect(parseDeleteMessage('delete all the messages')).toEqual({ scope: null, many: true });
    expect(parseDeleteMessage('clear every message in the chat')).toEqual({ scope: null, many: true });
  });

  it.each(['delete it', 'delete that file', 'delete the report', 'delete my files', 'remove the folder', 'send a message to Anna', 'what is the last message', 'the message was deleted', 'tell her I deleted it', 'undo', ''])('%s is not a request to delete a message', (said) => {
    expect(parseDeleteMessage(said)).toBeNull();
  });

  it.each([
    ['for everyone', 'everyone'],
    ['everyone please', 'everyone'],
    ['for both', 'everyone'],
    ['only for me', 'me'],
    ['just me', 'me'],
    ['here only', 'me'],
    ['for me', 'me'],
    ['no', 'no'],
    ['cancel', 'no'],
    ['leave it', 'no'],
    ["don't", 'no'],
  ])('the way, asked for: "%s" → %s', (said, way) => {
    expect(parseDeleteScope(said)).toBe(way);
  });

  it('anything else is not an answer', () => {
    expect(parseDeleteScope('what is the weather')).toBeNull();
    expect(parseDeleteScope('')).toBeNull();
  });

  it('the page request carries an id and a way, nothing else', () => {
    expect(parseLiveChatRequest({ kind: 'delete_message', id: 'true_1', scope: 'everyone' })).toEqual({ kind: 'delete_message', id: 'true_1', scope: 'everyone' });
    expect(parseLiveChatRequest({ kind: 'delete_message', id: 'true_1', scope: 'all' })).toBeNull();
    expect(parseLiveChatRequest({ kind: 'delete_message', scope: 'me' })).toBeNull();
    expect(parseLiveChatRequest({ kind: 'delete_message', id: 'x'.repeat(300), scope: 'me' })).toBeNull();
  });
});

describe('through ChatCommands: shown first, deleted only after the answer', () => {
  let dir: string;
  let db: Sql;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eya-del-'));
    db = openDatabase(join(dir, 'memory.db'));
    migrate(db, MIGRATIONS);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function talking(options: { active?: boolean; recent?: LiveChatView['recent'] } = {}) {
    const handled: LiveChatRequest[] = [];
    let ok = true;
    let say = 'Deleted.';
    const view = (): LiveChatView => ({
      ...EMPTY_LIVE_CHAT_VIEW,
      active: options.active ?? true,
      state: 'ACTIVE',
      chat: 'Priya Rao',
      sessionId: 's1',
      recent: options.recent ?? [
        { id: 'false_1', dir: 'in', kind: 'text', text: 'Are you coming?', at: '10:00', handled: true },
        { id: 'true_2', dir: 'out', kind: 'text', text: 'Yes, on my way!', at: '10:01', handled: true },
        { id: 'false_3', dir: 'in', kind: 'text', text: 'Great', at: '10:02', handled: true },
      ],
    });
    const liveChat = {
      view,
      handle: async (req: LiveChatRequest) => {
        handled.push(req);
        return { ok, message: ok ? say : say, view: view() };
      },
    };
    const cc = new ChatCommands({
      tools: { invoke: async (_n: string, _a: ToolArgs): Promise<ToolResult> => ({ ok: false, summary: 'unused', error: 'unused' }) },
      contacts: new ContactBook(db),
      policy: new CommunicationPolicy(() => ({ enabled: true, apps: {} })),
      session: new ChatSession(),
      confirmSends: 'unless_verified',
      fileRoute: 'chat',
      liveChat: liveChat as never,
      sleep: async () => undefined,
    });
    return { handled, say: (t: string) => cc.tryHandle(t), fail: (why: string) => { ok = false; say = why; } };
  }

  it('"delete the last message for everyone": the message is shown and nothing is deleted until a yes', async () => {
    const w = talking();
    const asked = await w.say('delete the last message for everyone');
    expect(asked?.spoken).toBe('Delete for everyone, so Priya Rao will not see it any more: "Yes, on my way!"? Say yes or no.');
    expect(w.handled).toEqual([]);
    const done = await w.say('yes');
    expect(w.handled).toEqual([{ kind: 'delete_message', id: 'true_2', scope: 'everyone' }]);
    expect(done?.spoken).toBe('Done. I deleted it for everyone in the chat with Priya Rao.');
  });

  it('"only for me": says plainly that the other person still sees it', async () => {
    const w = talking();
    const asked = await w.say('delete that message only for me');
    expect(asked?.spoken).toBe('Delete only from your side (Priya Rao will still see it): "Yes, on my way!"? Say yes or no.');
    const done = await w.say('yes');
    expect(w.handled).toEqual([{ kind: 'delete_message', id: 'true_2', scope: 'me' }]);
    expect(done?.spoken).toMatch(/only; Priya Rao can still see it/);
  });

  it('with no way said, it asks which: for everyone, or only for you — and the answer is the go-ahead', async () => {
    const w = talking();
    const asked = await w.say('delete that message');
    expect(asked?.spoken).toBe('The last message in the chat with Priya Rao is: "Yes, on my way!". Delete it for everyone (they will not see it any more), or only for you (they still see it)? Say "for everyone", "only for me", or "no".');
    expect(w.handled).toEqual([]);
    const done = await w.say('for everyone');
    expect(w.handled).toEqual([{ kind: 'delete_message', id: 'true_2', scope: 'everyone' }]);
    expect(done?.spoken).toMatch(/deleted it for everyone/);
  });

  it('"no" keeps it, either way', async () => {
    const a = talking();
    await a.say('delete the last message for everyone');
    expect((await a.say('no'))?.spoken).toBe('Okay, I left the message as it is.');
    expect(a.handled).toEqual([]);
    const b = talking();
    await b.say('delete that message');
    expect((await b.say('no'))?.spoken).toBe('Okay, I left the message as it is.');
    expect(b.handled).toEqual([]);
  });

  it('something else instead of an answer is a new request: the question lapses, nothing is deleted', async () => {
    const w = talking();
    await w.say('delete the last message for everyone');
    const other = await w.say('what is the weather');
    expect(other).toBeNull();
    expect(w.handled).toEqual([]);
    expect(await w.say('yes')).toBeNull(); // (a late yes has nothing to answer)
    expect(w.handled).toEqual([]);
  });

  it('a failure is said as it is, not as done', async () => {
    const w = talking();
    w.fail('WhatsApp does not offer "Delete for everyone" for that message, so I deleted nothing.');
    await w.say('delete the last message for everyone');
    const out = await w.say('yes');
    expect(out?.spoken).toMatch(/does not offer "Delete for everyone"/);
    expect(out?.spoken).not.toMatch(/^Done/);
  });

  it('only a message of the account\'s own is offered: none sent, nothing to delete', async () => {
    const w = talking({ recent: [{ id: 'false_1', dir: 'in', kind: 'text', text: 'Hello', at: '10:00', handled: true }] });
    const out = await w.say('delete the last message');
    expect(out?.spoken).toMatch(/I do not see a message of yours in the chat with Priya Rao/);
    expect(w.handled).toEqual([]);
  });

  it('a picture or a document is shown as that, not as empty words', async () => {
    const w = talking({ recent: [{ id: 'true_9', dir: 'out', kind: 'image', text: '', at: '10:00', handled: true }] });
    const out = await w.say('delete the last message for me');
    expect(out?.spoken).toMatch(/"a picture"/);
  });

  it('"delete all the messages" is not done: one at a time', async () => {
    const w = talking();
    const out = await w.say('delete all the messages');
    expect(out?.spoken).toMatch(/one message at a time/);
    expect(w.handled).toEqual([]);
  });

  it('with no live chat running these words are not about one (a file or anything else is the model\'s)', async () => {
    const w = talking({ active: false });
    expect(await w.say('delete the last message')).toBeNull();
    expect(w.handled).toEqual([]);
  });
});

describe('the live chat deletes only what was chosen, and only where it is safe', () => {
  async function chatting() {
    const sw = new FakeSwitch();
    sw.on = true;
    const r = rig({ enable: sw.control });
    r.chat.open = 'Priya Rao';
    r.chat.title = 'Priya Rao';
    r.chat.openOutcome = { kind: 'opened', label: 'Priya Rao', verified: true };
    r.ai.say("Hi! 😊 How are you doing today?");
    await r.controller.start('Priya Rao');
    await settle(40);
    return r;
  }

  it('deletes the message asked for, in the chosen way, and takes it out of the conversation', async () => {
    const r = await chatting();
    const mine = r.chat.messages.find((m) => m.dir === 'out');
    expect(mine).toBeDefined();
    const out = await r.controller.handle({ kind: 'delete_message', id: mine!.id, scope: 'everyone' });
    expect(out.ok, out.message).toBe(true);
    expect(out.message).toBe('Deleted for everyone.');
    expect(r.chat.deleted).toEqual([{ id: mine!.id, scope: 'everyone' }]);
    expect(r.controller.view().recent.some((m) => m.id === mine!.id)).toBe(false);
  });

  it('only for the person: said as that', async () => {
    const r = await chatting();
    const mine = r.chat.messages.find((m) => m.dir === 'out')!;
    expect((await r.controller.handle({ kind: 'delete_message', id: mine.id, scope: 'me' })).message).toBe('Deleted from your side only.');
    expect(r.chat.deleted).toEqual([{ id: mine.id, scope: 'me' }]);
  });

  it('the other person\'s message is never deleted', async () => {
    const r = await chatting();
    const theirs = r.chat.incoming('hello there');
    const out = await r.controller.handle({ kind: 'delete_message', id: theirs.id, scope: 'me' });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/not sent from your account/);
    expect(r.chat.deleted).toEqual([]);
  });

  it('a message that is no longer in the chat is not deleted', async () => {
    const r = await chatting();
    const out = await r.controller.handle({ kind: 'delete_message', id: 'true_nope', scope: 'me' });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/not in the chat any more/);
    expect(r.chat.deleted).toEqual([]);
  });

  it('another chat open: nothing is deleted', async () => {
    const r = await chatting();
    const mine = r.chat.messages.find((m) => m.dir === 'out')!;
    r.chat.open = 'Somebody Else';
    const out = await r.controller.handle({ kind: 'delete_message', id: mine.id, scope: 'me' });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/not the one that is open/);
    expect(r.chat.deleted).toEqual([]);
  });

  it('a page that would not delete is said as that', async () => {
    const r = await chatting();
    const mine = r.chat.messages.find((m) => m.dir === 'out')!;
    r.chat.deleteSays = 'WhatsApp does not offer "Delete for everyone" for that message, so I deleted nothing.';
    const out = await r.controller.handle({ kind: 'delete_message', id: mine.id, scope: 'everyone' });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/does not offer "Delete for everyone"/);
    expect(r.controller.view().recent.some((m) => m.id === mine.id)).toBe(true);
  });

  it('a connection that cannot delete says so', async () => {
    const r = await chatting();
    const mine = r.chat.messages.find((m) => m.dir === 'out')!;
    r.chat.cannotDelete = true;
    expect((await r.controller.handle({ kind: 'delete_message', id: mine.id, scope: 'me' })).message).toMatch(/cannot delete a message/);
  });

  it('with no live chat running nothing is deleted', async () => {
    const r = rig();
    const out = await r.controller.handle({ kind: 'delete_message', id: 'true_1', scope: 'me' });
    expect(out.ok).toBe(false);
    expect(r.chat.deleted).toEqual([]);
  });

  it('when Chats are switched off for WhatsApp nothing is deleted', async () => {
    const sw = new FakeSwitch();
    sw.on = true;
    let allowed: string | null = null;
    const r = rig({ enable: sw.control, allowed: () => allowed });
    r.chat.open = 'Priya Rao';
    r.chat.title = 'Priya Rao';
    r.chat.openOutcome = { kind: 'opened', label: 'Priya Rao', verified: true };
    r.ai.say('Hi!');
    await r.controller.start('Priya Rao');
    await settle(40);
    const mine = r.chat.messages.find((m) => m.dir === 'out')!;
    allowed = 'Chats are switched off for WhatsApp in Eya.';
    const out = await r.controller.handle({ kind: 'delete_message', id: mine.id, scope: 'me' });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/switched off/);
    expect(r.chat.deleted).toEqual([]);
  });
});
