import { describe, expect, it, vi } from 'vitest';
import { MAX_CHATS, MAX_CHAT_MESSAGES, MAX_MESSAGE_CHARS, MAX_TITLE_CHARS, cleanChat, isChatId, titleFrom } from '../src/shared/chats';
import type { StoredMessage } from '../src/shared/chats';
import { ChatStore } from '../src/main/chats/ChatStore';
import { SEED_TURNS, switchContext, turnsFrom } from '../src/main/chats/chatsIpc';
import { ConversationContext } from '../src/main/context/ConversationContext';
import { addMessage, emptyThread, storedMessages, threadFromStored } from '../src/renderer/thread';
import type { StoreIo } from '../src/main/privacy/communicationAccessStore';

// chatsIpc imports electron's ipcMain: the pure helpers are all this file uses
vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));

function memoryIo(): { io: StoreIo; files: Map<string, string> } {
  const files = new Map<string, string>();
  return { files, io: { read: (p) => files.get(p) ?? null, write: (p, t) => void files.set(p, t) } };
}

const msg = (role: 'user' | 'eya', text: string, at = 1): StoredMessage => ({ id: at, role, text, at, via: 'typed' });
const chat = (id: string, text = 'hello', updatedAt = 10): unknown => ({ id, title: text, createdAt: 1, updatedAt, messages: [msg('user', text), msg('eya', 'hi')] });

describe('a conversation as it is kept', () => {
  it('makes a title from the first words: one line, and short', () => {
    expect(titleFrom('  what is\n the date   today  ')).toBe('what is the date today');
    expect(titleFrom('')).toBe('New chat');
    const long = titleFrom('x'.repeat(200));
    expect(long.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });

  it('only takes safe ids', () => {
    expect(isChatId('chat_abc-123')).toBe(true);
    for (const bad of ['', '../x', 'a b', 'x'.repeat(65), 5, null, undefined]) expect(isChatId(bad)).toBe(false);
  });

  it('cleans what the page sends: unknown parts dropped, lengths capped, nothing trusted', () => {
    const raw = {
      id: 'c1',
      title: '   ',
      messages: [
        { id: 1, role: 'user', text: 'hello', at: 5, via: 'typed' },
        { id: 2, role: 'robot', text: 'ignored', at: 6 },
        { id: 3, role: 'eya', text: '   ', at: 7 },
        { id: 4, role: 'eya', text: 'x'.repeat(MAX_MESSAGE_CHARS + 50), at: 8, via: 'live', attachments: [{ name: 'a.pdf', kind: 'document', size: 3, path: 'C:\\secret.pdf' }, { name: 'bad', kind: 'exe', size: 1 }] },
        'nonsense',
      ],
    };
    const c = cleanChat(raw);
    expect(c).not.toBeNull();
    expect(c?.messages).toHaveLength(2);
    expect(c?.messages[1]?.text.length).toBe(MAX_MESSAGE_CHARS);
    expect(c?.messages[1]?.via).toBe('live');
    // a file is kept as its name only: no path, and a kind that is not one of ours is dropped
    expect(c?.messages[1]?.attachments).toEqual([{ name: 'a.pdf', kind: 'document', size: 3 }]);
    expect(c?.title).toBe('hello'); // from the first thing the user said
  });

  it('refuses what is not a conversation', () => {
    expect(cleanChat(null)).toBeNull();
    expect(cleanChat({ id: 'x y', messages: [msg('user', 'a')] })).toBeNull();
    expect(cleanChat({ id: 'ok', messages: [] })).toBeNull();
    expect(cleanChat({ id: 'ok', messages: 'no' })).toBeNull();
  });

  it('keeps only the latest messages of a very long conversation', () => {
    const many = Array.from({ length: MAX_CHAT_MESSAGES + 30 }, (_, i) => msg(i % 2 === 0 ? 'user' : 'eya', `m${i}`, i + 1));
    const c = cleanChat({ id: 'long', messages: many });
    expect(c?.messages).toHaveLength(MAX_CHAT_MESSAGES);
    expect(c?.messages[c.messages.length - 1]?.text).toBe(`m${MAX_CHAT_MESSAGES + 29}`);
  });
});

describe('the chat history on disk', () => {
  it('lists newest first, opens one, and is still there after a restart', () => {
    const { io, files } = memoryIo();
    const store = new ChatStore('chats.json', io);
    expect(store.list()).toEqual([]);
    store.upsert(chat('old', 'first question', 10));
    store.upsert(chat('new', 'second question', 20));
    expect(store.list().map((c) => c.id)).toEqual(['new', 'old']);
    expect(store.list()[0]).toMatchObject({ title: 'second question', messages: 2 });
    expect(store.get('old')?.messages[0]?.text).toBe('first question');
    expect(store.get('missing')).toBeNull();
    const again = new ChatStore('chats.json', io);
    expect(again.list().map((c) => c.id)).toEqual(['new', 'old']);
    expect(files.get('chats.json')).toContain('second question');
  });

  it('keeps the name the person gave a chat when the same chat is saved again', () => {
    const { io } = memoryIo();
    const store = new ChatStore('chats.json', io);
    store.upsert(chat('c1', 'what is the date', 10));
    expect(store.rename('c1', '  Hearing dates  ')).toBe(true);
    store.upsert({ id: 'c1', title: 'what is the date', createdAt: 99, updatedAt: 30, messages: [msg('user', 'what is the date'), msg('eya', 'Friday'), msg('user', 'and tomorrow')] });
    const got = store.get('c1');
    expect(got?.title).toBe('Hearing dates');
    expect(got?.createdAt).toBe(1);
    expect(got?.messages).toHaveLength(3);
    expect(store.rename('nope', 'x')).toBe(false);
  });

  it('deletes one, or all', () => {
    const { io } = memoryIo();
    const store = new ChatStore('chats.json', io);
    store.upsert(chat('a'));
    store.upsert(chat('b'));
    const changed = vi.fn();
    store.onChange(changed);
    expect(store.delete('a')).toBe(true);
    expect(store.delete('a')).toBe(false);
    expect(store.list().map((c) => c.id)).toEqual(['b']);
    expect(store.clear()).toBe(1);
    expect(store.list()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('forgets the oldest once there are more than the list is meant to hold', () => {
    const { io } = memoryIo();
    const store = new ChatStore('chats.json', io);
    for (let i = 0; i < MAX_CHATS + 5; i++) store.upsert(chat(`c${i}`, `q${i}`, 100 + i));
    const ids = store.list().map((c) => c.id);
    expect(ids).toHaveLength(MAX_CHATS);
    expect(ids).not.toContain('c0');
    expect(ids).toContain(`c${MAX_CHATS + 4}`);
  });

  it('starts with nothing when the file is damaged, and keeps working if the disk refuses', () => {
    const { io, files } = memoryIo();
    files.set('chats.json', '{ not json');
    expect(new ChatStore('chats.json', io).list()).toEqual([]);
    files.set('chats.json', JSON.stringify({ chats: [chat('good'), { id: 'bad id', messages: [] }, 7] }));
    expect(new ChatStore('chats.json', io).list().map((c) => c.id)).toEqual(['good']);
    const refusing = new ChatStore('chats.json', { read: () => null, write: () => { throw new Error('disk full'); } });
    expect(refusing.upsert(chat('x'))).not.toBeNull();
    expect(refusing.list().map((c) => c.id)).toEqual(['x']);
  });
});

describe('opening and starting conversations', () => {
  it('turns the messages into the exchanges the assistant remembers (the last few)', () => {
    const turns = turnsFrom([msg('user', 'q1', 1), msg('eya', 'a1', 2), msg('user', 'q2', 3), msg('user', 'q3', 4), msg('eya', 'a3', 5), msg('user', 'q4', 6)]);
    expect(turns.map((t) => [t.userText, t.reply])).toEqual([['q1', 'a1'], ['q2', undefined], ['q3', 'a3'], ['q4', undefined]]);
    const many = Array.from({ length: 40 }, (_, i) => msg(i % 2 === 0 ? 'user' : 'eya', `m${i}`, i));
    expect(turnsFrom(many)).toHaveLength(SEED_TURNS);
  });

  it('a new chat forgets the talk so far; an opened one gives the assistant its end', () => {
    const context = new ConversationContext();
    context.push({ at: 1, userText: 'old question', reply: 'old answer', ok: true, refs: [{ kind: 'file', value: 'C:\\a.pdf' }] });
    switchContext(context, null);
    expect(context.recent()).toEqual([]);
    expect(context.lastRefOfKind('file')).toBeUndefined();
    const opened = cleanChat({ id: 'o1', messages: [msg('user', 'what is the total', 1), msg('eya', 'Ten rupees', 2)] });
    switchContext(context, opened);
    expect(context.recent().map((t) => [t.userText, t.reply])).toEqual([['what is the total', 'Ten rupees']]);
    switchContext(context, null);
    expect(context.recent()).toEqual([]);
  });
});

describe('the conversation on the screen and in the file', () => {
  it('puts a kept conversation back on the screen, numbered again, and writes it back the same', () => {
    const t = threadFromStored([
      { role: 'user', text: 'hello', at: 1, via: 'typed', attachments: [{ name: 'a.pdf', kind: 'document', size: 9 }] },
      { role: 'eya', text: 'hi', at: 2, via: 'voice' },
    ]);
    expect(t.messages.map((m) => m.id)).toEqual([1, 2]);
    expect(t.nextId).toBe(3);
    expect(t.liveUser).toBeNull();
    expect(t.messages[0]?.attachments).toEqual([{ name: 'a.pdf', kind: 'document', size: 9 }]);
    // carrying on adds to it
    const more = addMessage(t, 'user', 'and then?', 'typed', 3);
    expect(more.messages).toHaveLength(3);
    expect(storedMessages(more).map((m) => m.text)).toEqual(['hello', 'hi', 'and then?']);
    expect(storedMessages(emptyThread)).toEqual([]);
  });
});
