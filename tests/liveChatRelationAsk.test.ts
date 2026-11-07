import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatSession } from '../src/main/chat/chatSession';
import { ContactBook } from '../src/main/chat/ContactBook';
import { ChatCommands } from '../src/main/local/ChatCommands';
import { parseChatIntent } from '../src/main/local/chatIntents';
import { RelationBook } from '../src/main/livechat/RelationBook';
import { relationStyle } from '../src/main/livechat/style';
import { MIGRATIONS } from '../src/main/memory/schema';
import { migrate, openDatabase } from '../src/main/memory/sqlite';
import type { Sql } from '../src/main/memory/sqlite';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';
import { parseLiveChatRequest } from '../src/shared/liveChat';
import { MemoryIo, rig, settle } from './liveChatFixtures';

const NUMBER = '+91 98765 08501';

describe('"do live chat with …" asks who the person is, once, before it starts', () => {
  let dir: string;
  let db: Sql;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eya-relask-'));
    db = openDatabase(join(dir, 'memory.db'));
    migrate(db, MIGRATIONS);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function commands(withBook = true) {
    const r = rig();
    const io = new MemoryIo();
    const book = new RelationBook('rel.json', io);
    const cc = new ChatCommands({
      tools: { invoke: async (_n: string, _a: ToolArgs): Promise<ToolResult> => ({ ok: false, summary: 'unused', error: 'unused' }) },
      contacts: new ContactBook(db),
      policy: new CommunicationPolicy(() => ({ enabled: true, apps: {} })),
      session: new ChatSession(),
      confirmSends: 'unless_verified',
      fileRoute: 'chat',
      liveChat: r.controller,
      ...(withBook ? { relations: book } : {}),
      sleep: async () => undefined,
    });
    return { r, book, io, say: (text: string) => cc.tryHandle(text) };
  }

  it('nothing is started before the answer: the question is the reply', async () => {
    const { r, say } = commands();
    const out = await say(`do live chat with ${NUMBER}`);
    expect(out?.spoken).toMatch(/^Who is .*8501 to you\? Say friend, family, sir or boss, partner/);
    expect(out?.spoken).toMatch(/short and natural like a real person/);
    expect(r.controller.view().active).toBe(false);
  });

  it('"friend" answers it: the live chat starts as a friend, and is told so', async () => {
    const { r, book, say } = commands();
    r.ai.say('Hey!');
    await say(`do live chat with ${NUMBER}`);
    const started = await say('friend');
    expect(started?.spoken).toMatch(/^Okay, a friend\. /);
    expect(started?.spoken).toMatch(/Live chat is on/);
    await settle();
    expect(r.controller.view().relation).toBe('friend');
    expect(book.get(NUMBER)).toBe('friend');
  });

  it('"sir", "girlfriend", "my mother", "client" all say who they are', async () => {
    for (const [said, relation] of [['sir', 'senior'], ['my girlfriend', 'partner'], ['my mother', 'family'], ['a client', 'client']] as const) {
      const { r, say } = commands();
      await say(`do live chat with ${NUMBER}`);
      await say(said);
      await settle();
      expect(r.controller.view().relation, said).toBe(relation);
    }
  });

  it('what they said about her in the same breath answers it: no question', async () => {
    const { r, book, say } = commands();
    const out = await say(`do live chat with ${NUMBER}, she is my close friend, make her happy`);
    expect(out?.spoken).not.toMatch(/Who is/);
    await settle();
    expect(r.controller.view().relation).toBe('friend');
    expect(book.get(NUMBER)).toBe('friend');
  });

  it('it is asked once: the next time the same person is remembered (by the digits of the number, in any spelling of it)', async () => {
    const { r, say } = commands();
    await say(`do live chat with ${NUMBER}`);
    await say('boss');
    await settle();
    await r.controller.stop();
    const again = await say('do live chat with 9876508501');
    expect(again?.spoken).not.toMatch(/Who is/);
    await settle();
    expect(r.controller.view().relation).toBe('senior');
  });

  it('what is kept is a hash, never the number or the name', async () => {
    const { io, say } = commands();
    await say(`do live chat with ${NUMBER}`);
    await say('friend');
    const text = [...io.files.values()].join('');
    expect(text).not.toMatch(/9876508501|98765|Rahul|friend.*08501/);
    expect(text).toMatch(/"[0-9a-f]{16}":"friend"/);
  });

  it('an answer that names nobody ("hmm", a new request) is not an answer: the question lapses and nothing is started', async () => {
    const { r, say } = commands();
    await say(`do live chat with ${NUMBER}`);
    const out = await say('what is the weather');
    expect(out).toBeNull();
    expect(r.controller.view().active).toBe(false);
  });

  it('"no" cancels it', async () => {
    const { r, say } = commands();
    await say(`do live chat with ${NUMBER}`);
    expect((await say('no'))?.spoken).toMatch(/Okay, I won't start the live chat/);
    expect(r.controller.view().active).toBe(false);
  });

  it('without a relation book (the setting is not there) nothing is asked, as before', async () => {
    const { r, say } = commands(false);
    const out = await say(`do live chat with ${NUMBER}`);
    expect(out?.spoken).not.toMatch(/Who is/);
    await settle();
    expect(r.controller.view().active).toBe(true);
  });
});

describe('the words and the request', () => {
  it('"stop all live chats" is told from "stop live chat"', () => {
    expect(parseChatIntent('stop all live chats')).toMatchObject({ kind: 'live_chat', action: 'stop', all: true });
    expect(parseChatIntent('stop every live chat')).toMatchObject({ kind: 'live_chat', action: 'stop', all: true });
    expect(parseChatIntent('stop live chat')).toMatchObject({ kind: 'live_chat', action: 'stop' });
    expect((parseChatIntent('stop live chat') as { all?: boolean }).all).toBeUndefined();
  });

  it('the page\'s start request carries a relation only when it is one of the known', () => {
    expect(parseLiveChatRequest({ kind: 'start', name: 'Rahul', relation: 'senior' })).toMatchObject({ kind: 'start', relation: 'senior' });
    expect((parseLiveChatRequest({ kind: 'start', name: 'Rahul', relation: 'enemy' }) as { relation?: string }).relation).toBeUndefined();
    expect(parseLiveChatRequest({ kind: 'stop', all: true })).toEqual({ kind: 'stop', all: true });
    expect(parseLiveChatRequest({ kind: 'stop' })).toEqual({ kind: 'stop' });
    expect(parseLiveChatRequest({ kind: 'focus', chat: 'abc' })).toEqual({ kind: 'focus', chat: 'abc' });
    expect(parseLiveChatRequest({ kind: 'focus' })).toBeNull();
  });

  it('and the style that follows is the one for that person', () => {
    expect(relationStyle('senior')).not.toBe(relationStyle('friend'));
  });
});
