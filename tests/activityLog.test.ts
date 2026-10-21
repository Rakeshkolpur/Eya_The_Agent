import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityStore, KEEP_ACTIVITIES, KEEP_ACTIVITY_DAYS } from '../src/main/memory/ActivityStore';
import { ActivityLog, describeActivity, kindOf, tidy } from '../src/main/memory/activityLog';
import { MIGRATIONS } from '../src/main/memory/schema';
import { migrate, openDatabase } from '../src/main/memory/sqlite';
import type { Sql } from '../src/main/memory/sqlite';

const dirs: string[] = [];
const dbs: Sql[] = [];

function rig(clock: () => string = () => new Date().toISOString()) {
  const dir = mkdtempSync(join(tmpdir(), 'eya-act-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'eya_memory.db'));
  dbs.push(db);
  migrate(db, MIGRATIONS);
  return { db, store: new ActivityStore(db, clock), dir };
}

afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('what becomes a history entry', () => {
  it('a browser task: a tidy title from the request, the reply as the detail, the site opened', () => {
    const a = describeActivity({ request: 'Hey Eya, could you please open the Telangana High Court cause list.', tools: ['open_website', 'click_on_page'], urls: ['https://www.tshc.gov.in/causeList.do'], spoken: 'Here is the cause list for today.', ok: true });
    expect(a).toEqual({
      kind: 'web',
      title: 'Open the Telangana High Court cause list',
      detail: 'Here is the cause list for today',
      ok: true,
      request: 'Hey Eya, could you please open the Telangana High Court cause list.',
      site: 'tshc.gov.in',
    });
  });

  it('a routine shows as "Ran routine", and "Done." is just Done', () => {
    expect(describeActivity({ request: "check today's cause list", tools: [], spoken: 'Done.', ok: true, routine: 'check_todays_cause_list' })).toMatchObject({
      title: 'Ran routine: check todays cause list',
      detail: 'Done',
      kind: 'action',
      request: "check today's cause list",
    });
  });

  it('sorts tasks into the filters: files, web, apps — and the most private first', () => {
    expect(kindOf(['find_file', 'move_file'], false)).toBe('file');
    expect(kindOf(['open_application'], false)).toBe('action');
    expect(kindOf(['open_website', 'move_file'], false)).toBe('web');
    expect(kindOf(['open_website', 'find_chat'], false)).toBe('chat');
    expect(kindOf(['open_website'], true)).toBe('chat');
  });

  it('keeps nothing from a chat app — not the contact, not the words — and cannot be repeated', () => {
    const a = describeActivity({ request: 'send the file report.pdf to Mahesh on WhatsApp', tools: ['open_website', 'find_chat', 'attach_file', 'verify_sent'], urls: ['https://web.whatsapp.com/'], spoken: 'Sent report.pdf to Mahesh Kumar', ok: true });
    expect(a).toEqual({ kind: 'chat', title: 'Worked in a chat app', detail: 'Done', ok: true, request: '', site: '' });
    expect(JSON.stringify(a)).not.toMatch(/Mahesh|report|whatsapp/i);
    // Even if only the address betrays it:
    const viaUrl = describeActivity({ request: 'open it', tools: ['open_website'], urls: ['https://web.whatsapp.com/'], ok: true }, (u) => u.includes('whatsapp'));
    expect(viaUrl).toMatchObject({ kind: 'chat', request: '', site: '' });
  });

  it('keeps no words of a request that looks private: a password, a long number, an e-mail address', () => {
    for (const request of ['log in with password hunter2', 'check case 9876543210', 'email priya@example.com the notes']) {
      const a = describeActivity({ request, tools: ['open_website'], urls: ['https://example.org/'], spoken: 'Done', ok: true });
      expect(a, request).toMatchObject({ title: 'A private request', request: '', detail: 'Done', site: '' });
    }
  });

  it('a fixed label replaces the request\'s words: nothing of what was asked is kept, and it cannot be repeated', () => {
    const a = describeActivity({ request: 'which meeting room is written here', label: 'Asked about my screen', tools: ['describe_screen'], ok: true });
    expect(a).toEqual({ kind: 'action', title: 'Asked about my screen', detail: 'Done', ok: true, request: '', site: '' });
    expect(JSON.stringify(a)).not.toContain('meeting');
    expect(describeActivity({ request: '', label: 'Asked about my screen', tools: ['describe_screen'], ok: false })).toMatchObject({ detail: 'It did not work', ok: false });
  });

  it('lists nothing for talk about memory or settings, or when no tool ran', () => {
    expect(describeActivity({ request: 'remember that Ravi is my brother', tools: ['remember'], ok: true })).toBeNull();
    expect(describeActivity({ request: 'what routines do I have', tools: ['list_routines', 'communication_access_status'], ok: true })).toBeNull();
    expect(describeActivity({ request: 'tell me a joke', tools: [], spoken: 'Why did…', ok: true })).toBeNull();
  });

  it('a failure says what Eya said, or that it did not work', () => {
    expect(describeActivity({ request: 'open the court site', tools: ['open_website'], spoken: "That didn't work.", ok: false })).toMatchObject({ ok: false, detail: "That didn't work" });
    expect(describeActivity({ request: 'open the court site', tools: ['open_website'], ok: false })).toMatchObject({ ok: false, detail: 'It did not work' });
  });

  it('titles are short, cased, and lose the polite lead-in', () => {
    expect(tidy('  please   open notepad. ', 90)).toBe('Open notepad');
    expect(tidy('Can you find my resume', 90)).toBe('Find my resume');
    expect(tidy('x'.repeat(200), 20)).toHaveLength(20);
    expect(tidy('', 20)).toBe('');
  });
});

describe('the history in the database', () => {
  const entry = (title: string, site = '') => ({ kind: 'web' as const, title, detail: 'Done', ok: true, request: title, site });

  it('is added by a schema step to a database that already held memory, without disturbing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eya-act-'));
    dirs.push(dir);
    const db = openDatabase(join(dir, 'old.db'));
    dbs.push(db);
    expect(migrate(db, MIGRATIONS.slice(0, 1))).toEqual({ from: 0, to: 1 });
    db.run("INSERT INTO memories (type, key, key_norm, value, created_at, updated_at) VALUES ('fact', 'Ravi', 'ravi', 'Ravi is my brother', 'x', 'x')");
    expect(migrate(db, MIGRATIONS)).toEqual({ from: 1, to: MIGRATIONS.length });
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM memories')?.n).toBe(1);
    expect(new ActivityStore(db).count()).toBe(0);
  });

  it('lists newest first and counts the sites opened most', () => {
    let t = 0;
    const { store } = rig(() => new Date(Date.UTC(2026, 9, 4, 10, t++)).toISOString());
    store.record(entry('First', 'tshc.gov.in'));
    store.record(entry('Second', 'example.org'));
    store.record(entry('Third', 'tshc.gov.in'));
    store.record({ ...entry('Fourth'), kind: 'file' });
    expect(store.list().map((a) => a.title)).toEqual(['Fourth', 'Third', 'Second', 'First']);
    expect(store.sites()).toEqual([{ site: 'tshc.gov.in', count: 2 }, { site: 'example.org', count: 1 }]);
    expect(store.list(2)).toHaveLength(2);
  });

  it('can delete one entry or clear everything, and says when it changed', () => {
    const { store } = rig();
    let changes = 0;
    store.onChange(() => (changes += 1));
    const a = store.record(entry('A'));
    store.record(entry('B'));
    expect(store.delete(a)).toBe(true);
    expect(store.delete(a)).toBe(false);
    expect(store.list().map((x) => x.title)).toEqual(['B']);
    store.clear();
    expect(store.count()).toBe(0);
    expect(changes).toBe(4); // two records, one real delete, one clear
  });

  it('keeps only the newest few hundred, and nothing older than the age limit', () => {
    let day = 0;
    const { store } = rig(() => new Date(Date.UTC(2026, 0, 1) + day * 3_600_000).toISOString());
    for (let i = 0; i < KEEP_ACTIVITIES + 20; i += 1) {
      store.record(entry(`entry ${i}`));
      day += 1;
    }
    expect(store.count()).toBe(KEEP_ACTIVITIES);
    expect(store.list(1)[0]?.title).toBe(`entry ${KEEP_ACTIVITIES + 19}`);
    day += KEEP_ACTIVITY_DAYS * 24 + 24;
    store.record(entry('fresh'));
    expect(store.list().map((a) => a.title)).toEqual(['fresh']); // everything older fell away
  });
});

describe('the log respects the "keep a history" choice', () => {
  it('records while it is on, and records nothing once it is off', () => {
    const { store } = rig();
    let keep = true;
    const log = new ActivityLog(store, { enabled: () => keep, isChatUrl: (u) => u.includes('whatsapp') });
    log.record({ request: 'open notepad', tools: ['open_application'], spoken: 'Done.', ok: true });
    keep = false;
    log.record({ request: 'open calculator', tools: ['open_application'], spoken: 'Done.', ok: true });
    expect(store.list().map((a) => a.title)).toEqual(['Open notepad']);
  });
});
