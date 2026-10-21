import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseTooNewError, migrate, openDatabase, openDatabaseSafely } from '../src/main/memory/sqlite';
import type { Sql } from '../src/main/memory/sqlite';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../src/main/memory/schema';
import { MemoryRejected, MemoryStore } from '../src/main/memory/MemoryStore';
import { SkillRejected, SkillStore } from '../src/main/memory/SkillStore';
import type { NewStep } from '../src/main/memory/types';

const dirs: string[] = [];
const opened: Sql[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'eya-mem-'));
  dirs.push(d);
  return d;
}

function freshDb(): { db: Sql; path: string } {
  const path = join(tempDir(), 'data', 'eya_memory.db');
  const db = openDatabase(path);
  opened.push(db);
  migrate(db, MIGRATIONS);
  return { db, path };
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 4, 10, 0, tick++)).toISOString();

const openUrl = (url: string, verifyText = ''): NewStep => ({ action: 'open_url', target: url, value: '', submit: false, verifyKind: verifyText === '' ? 'none' : 'url_contains', verifyText });
const click = (text: string): NewStep => ({ action: 'click_text', target: text, value: '', submit: false, verifyKind: 'none', verifyText: '' });

describe('the database file and its schema versions', () => {
  it('is created on first use, in the folder asked for, with every table and the latest version', () => {
    const { db, path } = freshDb();
    expect(existsSync(path)).toBe(true);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((t) => t.name);
    expect(tables).toEqual([
      'activity', 'contact_aliases', 'contacts', 'contacts_meta', 'memories', 'skill_runs', 'skill_steps', 'skill_triggers', 'skills',
      'task_candidate_phrases', 'task_candidate_steps', 'task_candidates',
    ]);
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(LATEST_SCHEMA_VERSION);
  });

  it('running the migrations again on every start changes nothing', () => {
    const { db } = freshDb();
    new MemoryStore(db, clock).save('fact', 'Ravi', 'my brother');
    expect(migrate(db, MIGRATIONS)).toEqual({ from: LATEST_SCHEMA_VERSION, to: LATEST_SCHEMA_VERSION });
    expect(new MemoryStore(db).count()).toBe(1);
  });

  it('a later schema step carries an older database forward without losing what it holds', () => {
    const { db } = freshDb();
    new MemoryStore(db, clock).save('preference', 'downloads', 'Desktop');
    const next = { version: LATEST_SCHEMA_VERSION + 1, name: 'add a column', sql: "ALTER TABLE memories ADD COLUMN note TEXT NOT NULL DEFAULT ''" };
    expect(migrate(db, [...MIGRATIONS, next])).toEqual({ from: LATEST_SCHEMA_VERSION, to: LATEST_SCHEMA_VERSION + 1 });
    expect(db.get<{ note: string; value: string }>('SELECT note, value FROM memories')).toEqual({ note: '', value: 'Desktop' });
  });

  it('a failed step is rolled back completely and the version does not move', () => {
    const { db } = freshDb();
    const broken = { version: LATEST_SCHEMA_VERSION + 1, name: 'half works', sql: 'CREATE TABLE half (a INTEGER); INSERT INTO nothing_here VALUES (1);' };
    expect(() => migrate(db, [...MIGRATIONS, broken])).toThrow();
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(LATEST_SCHEMA_VERSION);
    expect(db.get('SELECT name FROM sqlite_master WHERE name = ?', ['half'])).toBeUndefined();
  });

  it('refuses a database made by a newer Eya instead of guessing at it', () => {
    const { db } = freshDb();
    db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 5}`);
    expect(() => migrate(db, MIGRATIONS)).toThrow(DatabaseTooNewError);
  });

  it('keeps what was saved after the file is closed and opened again', () => {
    const { db, path } = freshDb();
    new MemoryStore(db, clock).save('fact', 'Ravi', "my brother's contact");
    new SkillStore(db, clock).create({ name: 'cause list', triggers: ['check cause list'], steps: [openUrl('https://example.org/')] });
    db.close();
    const again = openDatabase(path);
    opened.push(again);
    migrate(again, MIGRATIONS);
    expect(new MemoryStore(again).list().map((m) => m.value)).toEqual(["my brother's contact"]);
    expect(new SkillStore(again).list().map((s) => s.name)).toEqual(['cause list']);
  });

  it('a damaged file is moved aside (never deleted) and a fresh one started', () => {
    const dir = tempDir();
    const path = join(dir, 'eya_memory.db');
    writeFileSync(path, 'this is definitely not a sqlite database, just text '.repeat(200));
    const { db, movedAside } = openDatabaseSafely(path, () => 111);
    opened.push(db);
    expect(movedAside).toBe(`${path}.damaged-111`);
    expect(readdirSync(dir)).toContain('eya_memory.db.damaged-111');
    migrate(db, MIGRATIONS);
    expect(new MemoryStore(db, clock).save('fact', 'a', 'b').created).toBe(true);
  });

  it('a healthy file is opened as it is', () => {
    const { db: first, path } = freshDb();
    first.close();
    const { db, movedAside } = openDatabaseSafely(path);
    opened.push(db);
    expect(movedAside).toBeNull();
  });

  it('values are never pasted into SQL: hostile text is stored as plain text and harms nothing', () => {
    const { db } = freshDb();
    const store = new MemoryStore(db, clock);
    const nasty = "x'); DROP TABLE memories; --";
    store.save('fact', nasty, nasty);
    expect(store.list().map((m) => m.value)).toEqual([nasty]);
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM memories')?.n).toBe(1);
  });
});

describe('memories: save, retrieve, update, delete', () => {
  it('saves a preference and a fact and gets them back', () => {
    const { db } = freshDb();
    const store = new MemoryStore(db, clock);
    const pref = store.save('preference', 'downloaded pdfs', 'Always save downloaded PDFs to Desktop');
    const fact = store.save('fact', 'Ravi', "Ravi is my brother's contact");
    expect(pref.created).toBe(true);
    expect(store.get(pref.memory.id)).toMatchObject({ type: 'preference', key: 'downloaded pdfs', value: 'Always save downloaded PDFs to Desktop' });
    expect(store.getByKey('fact', 'ravi')?.value).toBe("Ravi is my brother's contact");
    expect(store.list().map((m) => m.id)).toEqual([fact.memory.id, pref.memory.id]); // newest first
    expect(store.list('preference')).toHaveLength(1);
    expect(store.count()).toBe(2);
  });

  it('saying the same thing again updates it instead of piling up (the key is compared without case or punctuation)', () => {
    const { db } = freshDb();
    const store = new MemoryStore(db, clock);
    const first = store.save('preference', 'Downloaded PDFs', 'Desktop');
    const again = store.save('preference', 'downloaded  pdfs!', 'Documents');
    expect(again.created).toBe(false);
    expect(again.memory.id).toBe(first.memory.id);
    expect(store.count()).toBe(1);
    expect(store.getByKey('preference', 'downloaded pdfs')?.value).toBe('Documents');
    expect(new Date(again.memory.updatedAt).getTime()).toBeGreaterThan(new Date(first.memory.createdAt).getTime());
    // The same key as a fact is a separate memory.
    expect(store.save('fact', 'downloaded pdfs', 'a thing').created).toBe(true);
  });

  it('updates a memory by id (its name, its value, or both), and refuses to collide with another', () => {
    const { db } = freshDb();
    const store = new MemoryStore(db, clock);
    const a = store.save('fact', 'Ravi', 'brother');
    store.save('fact', 'Sita', 'sister');
    expect(store.update(a.memory.id, { value: 'older brother' })?.value).toBe('older brother');
    expect(store.update(a.memory.id, { key: 'Ravi Kumar' })?.key).toBe('Ravi Kumar');
    expect(store.getByKey('fact', 'ravi kumar')?.value).toBe('older brother');
    expect(() => store.update(a.memory.id, { key: 'sita' })).toThrow(MemoryRejected);
    expect(store.update(9999, { value: 'x' })).toBeUndefined();
  });

  it('deletes by id and by key', () => {
    const { db } = freshDb();
    const store = new MemoryStore(db, clock);
    const a = store.save('fact', 'Ravi', 'brother');
    store.save('preference', 'Browser', 'Edge');
    expect(store.delete(a.memory.id)).toBe(true);
    expect(store.delete(a.memory.id)).toBe(false);
    expect(store.deleteByKey('browser').map((m) => m.value)).toEqual(['Edge']);
    expect(store.count()).toBe(0);
    expect(store.deleteByKey('nothing here')).toEqual([]);
  });

  it('refuses nothing-to-remember, runaway length, and passwords / codes / card numbers', () => {
    const { db } = freshDb();
    const store = new MemoryStore(db, clock);
    const why = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as MemoryRejected).why;
      }
      return 'accepted';
    };
    expect(why(() => store.save('fact', '  ', 'x'))).toBe('empty');
    expect(why(() => store.save('fact', 'x', ''))).toBe('empty');
    expect(why(() => store.save('fact', '!!!', 'x'))).toBe('empty');
    expect(why(() => store.save('fact', 'k', 'v'.repeat(501)))).toBe('too_long');
    expect(why(() => store.save('fact', 'my bank password', 'hunter2'))).toBe('sensitive');
    expect(why(() => store.save('fact', 'card', '4111 1111 1111 1111'))).toBe('sensitive');
    expect(why(() => store.save('fact', 'otp', '123456'))).toBe('sensitive');
    expect(why(() => store.save('thing' as never, 'k', 'v'))).toBe('bad_type');
    expect(why(() => store.save('fact', 'bus pass', 'blue one'))).toBe('accepted'); // "pass" alone is not a password
    expect(store.count()).toBe(1);
  });

  it('puts the right memories in front of the model: every preference, and only the facts that share a word with the request', () => {
    const { db } = freshDb();
    const store = new MemoryStore(db, clock);
    store.save('preference', 'downloaded pdfs', 'Always save downloaded PDFs to Desktop');
    store.save('fact', 'Ravi', "Ravi is my brother's contact");
    store.save('fact', 'dentist', 'Dr Rao, Banjara Hills');
    const forRavi = store.relevant('call Ravi please').map((m) => m.key);
    expect(forRavi).toEqual(['downloaded pdfs', 'Ravi']);
    expect(store.relevant('open notepad').map((m) => m.key)).toEqual(['downloaded pdfs']);
    expect(store.relevant('').map((m) => m.key)).toEqual(['downloaded pdfs']);
  });

  it('tells listeners when something changes', () => {
    const { db } = freshDb();
    const store = new MemoryStore(db, clock);
    let n = 0;
    const off = store.onChange(() => (n += 1));
    const m = store.save('fact', 'a', 'b').memory;
    store.update(m.id, { value: 'c' });
    store.delete(m.id);
    off();
    store.save('fact', 'x', 'y');
    expect(n).toBe(3);
  });
});

describe('skills (routines) in the database', () => {
  const make = (store: SkillStore, name = 'check cause list', triggers = ["check today's cause list", 'check cause list']) =>
    store.create({ name, description: 'The High Court cause list', triggers, steps: [openUrl('https://tshc.gov.in/', 'tshc.gov.in'), click('Cause List')] });

  it('saves a skill with its triggers and ordered steps, and reads it back whole', () => {
    const { db } = freshDb();
    const store = new SkillStore(db, clock);
    const s = make(store);
    expect(s).toMatchObject({ name: 'check cause list', enabled: true, useCount: 0, successCount: 0, failureCount: 0, lastUsedAt: null });
    expect(s.triggers).toEqual(["check today's cause list", 'check cause list']);
    expect(s.steps.map((x) => [x.position, x.action, x.target])).toEqual([[1, 'open_url', 'https://tshc.gov.in/'], [2, 'click_text', 'Cause List']]);
    expect(s.steps[0]).toMatchObject({ verifyKind: 'url_contains', verifyText: 'tshc.gov.in' });
    expect(store.detailByName('CHECK CAUSE LIST')?.id).toBe(s.id);
  });

  it('is all-or-nothing: a bad step leaves no half-made routine behind', () => {
    const { db } = freshDb();
    const store = new SkillStore(db, clock);
    expect(() => store.create({ name: 'broken', triggers: ['do broken'], steps: [openUrl('https://a.example/'), { ...click('x'), action: 'launch_missiles' as never }] })).toThrow(SkillRejected);
    expect(store.count()).toBe(0);
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM skill_triggers')?.n).toBe(0);
  });

  it('checks every step: what it needs, normal web addresses only, nothing sensitive typed', () => {
    const { db } = freshDb();
    const store = new SkillStore(db, clock);
    const bad = (step: NewStep) => () => store.create({ name: `n${tick++}`, triggers: [`t${tick++}`], steps: [step] });
    expect(bad(openUrl('javascript:alert(1)'))).toThrow(/http or https/);
    expect(bad(openUrl('file:///C:/Windows/notepad.exe'))).toThrow(/http or https/);
    expect(bad({ ...click(''), target: '' })).toThrow(/text to look for/);
    expect(bad({ action: 'type_text', target: 'Password', value: 'x', submit: false, verifyKind: 'none', verifyText: '' })).toThrow(/never types passwords/);
    expect(bad({ action: 'type_text', target: 'Search', value: '4111 1111 1111 1111', submit: false, verifyKind: 'none', verifyText: '' })).toThrow(/never types/);
    expect(bad({ action: 'verify', target: '', value: '', submit: false, verifyKind: 'none', verifyText: '' })).toThrow(/needs to say what to check/);
    expect(bad({ ...click('ok'), verifyKind: 'page_contains', verifyText: '' })).toThrow(/text to check/);
    expect(() => store.create({ name: 'empty', triggers: ['do empty'], steps: [] })).toThrow(/at least one step/);
    expect(store.count()).toBe(0);
  });

  it('keeps names unique (case-insensitively) and a wording pointing at ONE routine', () => {
    const { db } = freshDb();
    const store = new SkillStore(db, clock);
    make(store);
    expect(() => make(store, 'Check Cause List', ['something else'])).toThrow(/already a routine called/);
    try {
      make(store, 'other', ["Check today's cause list!"]); // the same wording once reduced to its plain form
      throw new Error('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(SkillRejected);
      expect((e as SkillRejected).why).toBe('trigger_taken');
      expect((e as SkillRejected).otherSkill).toBe('check cause list');
    }
    expect(store.count()).toBe(1);
  });

  it('enables and disables, renames, and edits the wordings and the steps', () => {
    const { db } = freshDb();
    const store = new SkillStore(db, clock);
    const s = make(store);
    store.setEnabled(s.id, false);
    expect(store.get(s.id)?.enabled).toBe(false);
    expect(store.enabledTriggers()).toEqual([]);
    store.setEnabled(s.id, true);
    expect(store.enabledTriggers().map((t) => t.norm).sort()).toEqual(['check cause list', 'check todays cause list']);
    store.rename(s.id, 'HC cause list');
    expect(store.get(s.id)?.name).toBe('HC cause list');
    store.addTrigger(s.id, 'high court cause list');
    store.removeTrigger(s.id, 'check cause list');
    expect(store.triggersOf(s.id)).toEqual(["check today's cause list", 'high court cause list']);
    store.replaceSteps(s.id, [openUrl('https://new.example/'), click('Orders')]);
    expect(store.stepsOf(s.id).map((x) => x.target)).toEqual(['https://new.example/', 'Orders']);
    expect(store.get(s.id)?.name).toBe('HC cause list'); // a better workflow keeps the routine itself
    expect(() => store.removeTrigger(s.id, 'high court cause list')).not.toThrow();
    expect(() => store.setTriggers(s.id, [])).toThrow(/at least one phrase/);
    expect(() => store.setEnabled(999, true)).toThrow(/no such routine/);
  });

  it('records successes and failures: counts, last used, and a short history', () => {
    const { db } = freshDb();
    const store = new SkillStore(db, clock);
    const s = make(store);
    store.recordRun(s.id, 'success');
    store.recordRun(s.id, 'success');
    store.recordRun(s.id, 'verify_failed', 2, 'the page did not say "Cause List"');
    store.recordRun(s.id, 'needs_user', 2, 'asked for a yes'); // being asked something is neither a success nor a failure
    const after = store.get(s.id);
    expect(after).toMatchObject({ useCount: 4, successCount: 2, failureCount: 1 });
    expect(after?.lastUsedAt).not.toBeNull();
    const runs = store.recentRuns(s.id);
    expect(runs.map((r) => r.outcome)).toEqual(['needs_user', 'verify_failed', 'success', 'success']);
    expect(runs[1]).toMatchObject({ failedStep: 2, detail: 'the page did not say "Cause List"' });
  });

  it('keeps only the latest runs in the history', () => {
    const { db } = freshDb();
    const store = new SkillStore(db, clock);
    const s = make(store);
    for (let i = 0; i < 30; i += 1) store.recordRun(s.id, 'success');
    expect(store.recentRuns(s.id, 100)).toHaveLength(20);
    expect(store.get(s.id)?.useCount).toBe(30);
  });

  it('deleting a routine removes its wordings, steps and history with it', () => {
    const { db } = freshDb();
    const store = new SkillStore(db, clock);
    const s = make(store);
    store.recordRun(s.id, 'success');
    expect(store.delete(s.id)).toBe(true);
    for (const table of ['skill_triggers', 'skill_steps', 'skill_runs']) expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n).toBe(0);
    expect(store.delete(s.id)).toBe(false);
  });

  it('finds a routine by name, by a wording, or by its name spoken with spaces', () => {
    const { db } = freshDb();
    const store = new SkillStore(db, clock);
    const s = make(store, 'check_hc_cause_list', ['check hc cause list']);
    expect(store.find('check_hc_cause_list')?.id).toBe(s.id);
    expect(store.find('Check HC cause list')?.id).toBe(s.id);
    expect(store.find('check hc cause list please')?.id).toBe(s.id);
    expect(store.find('nonsense')).toBeUndefined();
  });
});
