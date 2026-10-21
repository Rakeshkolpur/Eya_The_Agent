import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContactBook, isPlausibleChatName } from '../src/main/chat/ContactBook';
import { MIGRATIONS } from '../src/main/memory/schema';
import { migrate, openDatabase } from '../src/main/memory/sqlite';
import type { Sql } from '../src/main/memory/sqlite';

let dir: string;
let db: Sql;
let book: ContactBook;
let clock = '2026-10-09T10:00:00.000Z';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eya-contacts-'));
  db = openDatabase(join(dir, 'memory.db'));
  migrate(db, MIGRATIONS);
  clock = '2026-10-09T10:00:00.000Z';
  book = new ContactBook(db, () => clock);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const on = (): void => book.setLearning('on');
const names = (app = 'whatsapp'): string[] => book.list(app).map((c) => c.name).sort();

describe('what counts as a name', () => {
  it('accepts the names people have in a chat list', () => {
    for (const ok of ['Ravi', 'Ravi Kumar', 'Amma', 'Dr. Rao', 'Anil - Office', 'Family Group', 'Priya (Sister)', 'రవి', 'Rahul V', "D'Souza", 'Mum ❤']) {
      expect(isPlausibleChatName(ok), ok).toBe(true);
    }
  });

  it('turns away messages, links, numbers, times and buttons', () => {
    for (const bad of [
      '',
      'a',
      'See you tomorrow at the clinic, ok?',
      'my password is hunter2!',
      'https://example.com/x',
      'www.example.com',
      'ravi@example.com',
      '+91 98765 00432',
      '9876500432',
      '10:42',
      'Yesterday',
      'Today',
      'Send',
      'New chat',
      'Type a message',
      'Archived',
      'one two three four five six',
      'x'.repeat(60),
      'Thanks: see you',
    ]) {
      expect(isPlausibleChatName(bad), bad).toBe(false);
    }
  });
});

describe('the user\'s choice', () => {
  it('learns nothing until the user says yes', () => {
    expect(book.learning()).toBe('unasked');
    expect(book.learn('whatsapp', ['Ravi Kumar'])).toBe(0);
    book.used('whatsapp', 'Ravi Kumar');
    expect(book.count()).toBe(0);
    book.setLearning('on');
    expect(book.learning()).toBe('on');
    expect(book.learn('whatsapp', ['Ravi Kumar'])).toBe(1);
  });

  it('keeps nothing, and learns nothing, after a no', () => {
    on();
    book.learn('whatsapp', ['Ravi Kumar', 'Amma']);
    expect(book.count()).toBe(2);
    book.setLearning('off');
    expect(book.learning()).toBe('off');
    expect(book.count()).toBe(0);
    expect(book.learn('whatsapp', ['Ravi Kumar'])).toBe(0);
  });

  it('the choice survives closing and reopening the database', () => {
    on();
    book.learn('whatsapp', ['Ravi']);
    const again = new ContactBook(db, () => clock);
    expect(again.learning()).toBe('on');
    expect(again.countFor('whatsapp')).toBe(1);
  });
});

describe('learning names', () => {
  beforeEach(on);

  it('keeps names once, whatever the case or accents, and skips what is not a name', () => {
    const added = book.learn('whatsapp', ['Ravi Kumar', 'ravi kumar', 'Rávi Kumar', 'See you at 5, ok?', '+91 98765 00432', 'Amma']);
    expect(added).toBe(2);
    expect(names()).toEqual(['Amma', 'Ravi Kumar']);
  });

  it('keeps each app\'s names apart', () => {
    book.learn('whatsapp', ['Ravi']);
    book.learn('telegram', ['Ravi', 'Sita']);
    expect(book.countFor('whatsapp')).toBe(1);
    expect(book.countFor('telegram')).toBe(2);
  });

  it('counts how often a chat is used, and remembers a chat it opened even if it was not on the list', () => {
    book.used('whatsapp', 'Priya Singh');
    clock = '2026-10-09T11:00:00.000Z';
    book.used('whatsapp', 'Priya Singh');
    book.learn('whatsapp', ['Amit Kumar']);
    const list = book.list('whatsapp');
    expect(list[0]).toMatchObject({ name: 'Priya Singh', useCount: 2 });
    expect(list[1]).toMatchObject({ name: 'Amit Kumar', useCount: 0 });
  });

  it('stops at a limit rather than growing without end', () => {
    const many = Array.from({ length: 2100 }, (_, i) => `Person ${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26)}`);
    book.learn('whatsapp', many);
    expect(book.countFor('whatsapp')).toBe(2000);
  });
});

describe('what a word means, and the chat the user usually means', () => {
  it('a word the user defined opens that chat, and the user asking is the yes to keeping it', () => {
    expect(book.learning()).toBe('unasked');
    expect(book.setAlias('whatsapp', 'Lakshmi Akka', 'akka')).toBe(true);
    expect(book.learning()).toBe('on');
    expect(book.resolve('whatsapp', 'akka')).toMatchObject({ kind: 'unique', via: 'alias', contact: { name: 'Lakshmi Akka' } });
  });

  it('a word has one meaning: giving it to another chat takes it from the first', () => {
    on();
    book.setAlias('whatsapp', 'Lakshmi Akka', 'akka');
    book.setAlias('whatsapp', 'Padma Akka', 'akka');
    expect(book.resolve('whatsapp', 'akka')).toMatchObject({ kind: 'unique', via: 'alias', contact: { name: 'Padma Akka' } });
    expect(book.list('whatsapp').find((c) => c.name === 'Lakshmi Akka')?.aliases).toEqual([]);
  });

  it('refuses a word that is the chat\'s own name, or not a name at all', () => {
    expect(book.setAlias('whatsapp', 'Lakshmi Akka', 'Lakshmi Akka')).toBe(false);
    expect(book.setAlias('whatsapp', 'Lakshmi Akka', 'see you at 5?')).toBe(false);
  });

  it('two chats share a word: the one opened far more often wins; without that, the user is asked', () => {
    on();
    book.learn('whatsapp', ['Lakshmi Akka', 'Padma Akka']);
    expect(book.resolve('whatsapp', 'akka').kind).toBe('ambiguous');
    for (let i = 0; i < 2; i += 1) book.used('whatsapp', 'Lakshmi Akka');
    expect(book.resolve('whatsapp', 'akka').kind).toBe('ambiguous'); // two uses is not yet a habit
    book.used('whatsapp', 'Lakshmi Akka');
    expect(book.resolve('whatsapp', 'akka')).toMatchObject({ kind: 'unique', via: 'usage', contact: { name: 'Lakshmi Akka' } });
    expect(book.favourite('whatsapp', ['Lakshmi Akka', 'Padma Akka'])).toBe('Lakshmi Akka');
    for (let i = 0; i < 3; i += 1) book.used('whatsapp', 'Padma Akka');
    expect(book.resolve('whatsapp', 'akka').kind).toBe('ambiguous'); // both are used a lot: nothing stands out
    expect(book.favourite('whatsapp', ['Lakshmi Akka', 'Padma Akka'])).toBeNull();
  });

  it('the same word spelled by ear is the same name ("aka" is "Akka")', () => {
    on();
    book.learn('whatsapp', ['Akka', 'Akhil Rao']);
    expect(book.resolve('whatsapp', 'aka')).toMatchObject({ kind: 'unique', contact: { name: 'Akka' } });
  });
});

describe('finding a chat from what was said', () => {
  beforeEach(() => {
    on();
    book.learn('whatsapp', ['Ravi Kumar', 'Ravi Teja', 'Amma', 'Priya Singh', 'Rahul Sharma', 'Rahul Verma']);
  });

  it('finds the one chat a name fits', () => {
    expect(book.resolve('whatsapp', 'priya')).toMatchObject({ kind: 'unique', contact: { name: 'Priya Singh' } });
    expect(book.resolve('whatsapp', 'Ravi Kumar')).toMatchObject({ kind: 'unique', contact: { name: 'Ravi Kumar' } });
    expect(book.resolve('whatsapp', 'teja')).toMatchObject({ kind: 'unique', contact: { name: 'Ravi Teja' } });
    expect(book.resolve('whatsapp', 'amma')).toMatchObject({ kind: 'unique', via: 'name' });
  });

  it('says so when two could be meant, and never guesses', () => {
    const r = book.resolve('whatsapp', 'ravi');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.contacts.map((c) => c.name).sort()).toEqual(['Ravi Kumar', 'Ravi Teja']);
    expect(book.resolve('whatsapp', 'rahul').kind).toBe('ambiguous');
  });

  it('knows nothing about a name it was not told, or another app', () => {
    expect(book.resolve('whatsapp', 'sanjay')).toEqual({ kind: 'none' });
    expect(book.resolve('telegram', 'amma')).toEqual({ kind: 'none' });
  });

  it('understands a close spelling of a longer name', () => {
    expect(book.resolve('whatsapp', 'priyaa singh')).toMatchObject({ kind: 'unique', contact: { name: 'Priya Singh' } });
  });
});

describe('what the user calls someone', () => {
  beforeEach(() => {
    on();
    book.learn('whatsapp', ['Amma', 'Appa', 'Ravi Kumar', 'Ravi Teja']);
  });

  it('turns "mom" into the chat, and settles a name that two chats share', () => {
    expect(book.resolve('whatsapp', 'mom').kind).toBe('none');
    expect(book.addAlias('whatsapp', 'Amma', 'Mom')).toBe(true);
    expect(book.resolve('whatsapp', 'mom')).toMatchObject({ kind: 'unique', contact: { name: 'Amma', aliases: ['Mom'] }, via: 'alias' });
    expect(book.resolve('whatsapp', 'ravi').kind).toBe('ambiguous');
    expect(book.addAlias('whatsapp', 'Ravi Kumar', 'Ravi')).toBe(true);
    // "Ravi" is now exactly one chat's name for it (the exact word beats the partial fits)
    expect(book.resolve('whatsapp', 'ravi')).toMatchObject({ kind: 'unique', contact: { name: 'Ravi Kumar' } });
  });

  it('does not keep the same alias twice, an alias that is the name, or one for a chat it does not know', () => {
    expect(book.addAlias('whatsapp', 'Amma', 'Mom')).toBe(true);
    expect(book.addAlias('whatsapp', 'Amma', 'mom')).toBe(false);
    expect(book.addAlias('whatsapp', 'Amma', 'amma')).toBe(false);
    expect(book.addAlias('whatsapp', 'Nobody', 'Nobody Here')).toBe(false);
    expect(book.addAlias('whatsapp', 'Amma', 'Please send it now, ok?')).toBe(false);
  });

  it('keeps only a few aliases per chat', () => {
    for (const a of ['Mom', 'Mum', 'Mother', 'Mummy', 'Ma']) expect(book.addAlias('whatsapp', 'Amma', a)).toBe(true);
    expect(book.addAlias('whatsapp', 'Amma', 'Mama')).toBe(false);
  });

  it('keeps no alias when learning is off', () => {
    book.setLearning('off');
    expect(book.addAlias('whatsapp', 'Amma', 'Mom')).toBe(false);
  });
});

describe('forgetting', () => {
  beforeEach(() => {
    on();
    book.learn('whatsapp', ['Amma', 'Ravi']);
    book.learn('telegram', ['Sita']);
    book.addAlias('whatsapp', 'Amma', 'Mom');
  });

  it('forgets one chat, with what the user called it', () => {
    const amma = book.list('whatsapp').find((c) => c.name === 'Amma');
    expect(book.forget(amma?.id ?? -1)).toBe(true);
    expect(names()).toEqual(['Ravi']);
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM contact_aliases')?.n).toBe(0);
    expect(book.forget(9999)).toBe(false);
  });

  it('forgets one app\'s chats, or all of them', () => {
    expect(book.forgetApp('whatsapp')).toBe(2);
    expect(book.countFor('whatsapp')).toBe(0);
    expect(book.countFor('telegram')).toBe(1);
    expect(book.forgetAll()).toBe(1);
    expect(book.count()).toBe(0);
    expect(book.learning()).toBe('on'); // forgetting the names is not changing the choice
  });

  it('tells listeners when something changed', () => {
    let calls = 0;
    book.onChange(() => (calls += 1));
    book.learn('whatsapp', ['New Person']);
    book.forgetAll();
    expect(calls).toBeGreaterThanOrEqual(2);
    book.forgetAll(); // nothing to forget: nothing to tell
    const before = calls;
    book.forgetAll();
    expect(calls).toBe(before);
  });
});

describe('what is on disk', () => {
  it('holds names and counts only', () => {
    on();
    book.learn('whatsapp', ['Ravi Kumar']);
    book.used('whatsapp', 'Ravi Kumar');
    const columns = db.all<{ name: string }>("SELECT name FROM pragma_table_info('contacts')").map((c) => c.name);
    expect(columns).toEqual(['id', 'app', 'name', 'name_norm', 'first_seen', 'last_seen', 'use_count', 'last_used']);
    const aliasColumns = db.all<{ name: string }>("SELECT name FROM pragma_table_info('contact_aliases')").map((c) => c.name);
    expect(aliasColumns).toEqual(['id', 'contact_id', 'alias_norm', 'alias_text']);
  });
});
