import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase } from '../src/main/memory/sqlite';
import type { Sql } from '../src/main/memory/sqlite';
import { MIGRATIONS } from '../src/main/memory/schema';
import { SkillStore } from '../src/main/memory/SkillStore';
import { SkillMatcher } from '../src/main/memory/skillMatcher';
import { contentTokens, distinguishingTokens, editDistance, isTypoOf, looksSensitive, normalizeUtterance, slugify } from '../src/main/memory/normalize';
import type { NewStep } from '../src/main/memory/types';

const dirs: string[] = [];
const dbs: Sql[] = [];

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'eya-match-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'eya_memory.db'));
  dbs.push(db);
  migrate(db, MIGRATIONS);
  const store = new SkillStore(db);
  const matcher = new SkillMatcher(store);
  return { store, matcher, db };
}

afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const step: NewStep = { action: 'open_url', target: 'https://example.org/', value: '', submit: false, verifyKind: 'none', verifyText: '' };
const add = (store: SkillStore, name: string, triggers: string[]) => store.create({ name, triggers, steps: [step] });

describe('reducing a wording to its plain form', () => {
  it('drops case, punctuation, apostrophes, politeness and articles — so different wordings of one request coincide', () => {
    const plain = 'check todays cause list';
    for (const said of [
      "Check today's cause list",
      'check TODAYS cause list.',
      "Hey Eya, could you please check the today's cause list for me?",
      'ok eya can you check a todays cause list now',
      "  Check   today’s  cause-list! ".replace('-', ' '),
      'I want you to check today’s cause list',
      'please check todays cause list thanks',
    ]) {
      expect(normalizeUtterance(said), said).toBe(plain);
    }
  });

  it('keeps other scripts intact', () => {
    expect(normalizeUtterance('కాజ్ లిస్ట్ చూడు')).toBe('కాజ్ లిస్ట్ చూడు');
    expect(normalizeUtterance('काज़ लिस्ट देखो!')).toBe('काज़ लिस्ट देखो');
    expect(slugify('కాజ్ లిస్ట్')).toBe('కాజ్_లిస్ట్');
    expect(normalizeUtterance('')).toBe('');
    expect(normalizeUtterance('???')).toBe('');
  });

  it('finds the words that carry meaning, and the ones that change WHAT is asked', () => {
    expect(contentTokens(normalizeUtterance('check the todays cause list for me'))).toEqual(['check', 'todays', 'cause', 'list']);
    expect(contentTokens('check todays cause list of the day')).toEqual(['check', 'todays', 'cause', 'list', 'the', 'day']); // joining words go, the rest stay
    expect(distinguishingTokens('check todays cause list')).toEqual([]);
    expect(distinguishingTokens('check tomorrow cause list')).toEqual(['tomorrow']);
    expect(distinguishingTokens('cause list 14 october')).toEqual(['14', 'october']);
  });

  it('makes a readable name, measures edits, and spots secrets', () => {
    expect(slugify("Check today's cause list")).toBe('check_todays_cause_list');
    expect(slugify('!!!')).toBe('routine');
    expect(editDistance('cause', 'cuase')).toBe(1); // two neighbouring letters swapped is one slip
    expect(editDistance('cause', 'pause')).toBe(1);
    expect(isTypoOf('cause', 'cuase')).toBe(true);
    expect(isTypoOf('causes', 'cause')).toBe(true);
    expect(isTypoOf('cause', 'pause')).toBe(false); // a different word, not a slip
    expect(isTypoOf('list', 'lits')).toBe(false); // too short to be sure
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('abcdef', 'uvwxyz', 2)).toBe(3);
    expect(looksSensitive('my password is x')).toBe(true);
    expect(looksSensitive('Always save PDFs to Desktop')).toBe(false);
  });
});

describe('matching a command to a saved routine', () => {
  it('matches the exact saved wording', () => {
    const { store, matcher } = rig();
    const s = add(store, 'cause list', ["check today's cause list"]);
    const m = matcher.match("check today's cause list");
    expect(m).toMatchObject({ via: 'exact', score: 1, strong: true, trigger: "check today's cause list" });
    expect(m?.skill.id).toBe(s.id);
  });

  it('matches the same words in different case, punctuation and politeness (exact, on the plain form)', () => {
    const { store, matcher } = rig();
    const s = add(store, 'cause list', ["check today's cause list"]);
    for (const said of ['CHECK TODAYS CAUSE LIST', 'Hey Eya, please check the todays cause list for me!', 'could you check today’s cause list', 'check todays cause list.']) {
      const m = matcher.match(said);
      expect(m?.via, said).toBe('exact');
      expect(m?.skill.id).toBe(s.id);
    }
  });

  it('matches any of a routine\'s several wordings', () => {
    const { store, matcher } = rig();
    const s = add(store, 'cause list', ["check today's cause list", 'high court cause list', 'check cause list']);
    expect(matcher.match('high court cause list')?.skill.id).toBe(s.id);
    expect(matcher.match('check cause list')?.skill.id).toBe(s.id);
  });

  it('accepts a very close wording (a slip of a letter, one small extra word) and says it was close', () => {
    const { store, matcher } = rig();
    const s = add(store, 'cause list', ["check today's cause list"]);
    const typo = matcher.match('check todays cuase list');
    expect(typo).toMatchObject({ via: 'fuzzy', strong: true });
    expect(typo?.skill.id).toBe(s.id);
  });

  it('does NOT bridge a different date, day or number: "tomorrow" is not "today"', () => {
    const { store, matcher } = rig();
    add(store, 'cause list', ["check today's cause list"]);
    expect(matcher.match("check tomorrow's cause list")).toBeNull();
    expect(matcher.match('check cause list for monday')).toBeNull();
    expect(matcher.match('check todays cause list 2')).toBeNull();
    expect(matcher.match('check last weeks cause list')).toBeNull();
  });

  it('does not run on something merely related, or something that adds a different subject', () => {
    const { store, matcher } = rig();
    add(store, 'cause list', ["check today's cause list"]);
    expect(matcher.match('what is the weather')).toBeNull();
    expect(matcher.match('open notepad')).toBeNull();
    expect(matcher.match('list')).toBeNull();
    expect(matcher.match('check the delhi high court cause list and mail it to my lawyer')).toBeNull();
    expect(matcher.match('')).toBeNull();
    expect(matcher.match('???')).toBeNull();
  });

  it('when two routines are equally close it does not guess', () => {
    const { store, matcher } = rig();
    add(store, 'a', ['check cause list orders']);
    add(store, 'b', ['check cause list notices']);
    expect(matcher.match('check cause list')).toBeNull(); // as close to one as to the other: not clear which was meant
    expect(matcher.match('check cause list order')?.skill.name).toBe('a'); // but a slip toward one of them is clear
    expect(matcher.match('check cause list orders')?.skill.name).toBe('a'); // exact is always fine
  });

  it('a disabled routine is never matched, and is matched again when re-enabled', () => {
    const { store, matcher } = rig();
    const s = add(store, 'cause list', ['check cause list']);
    expect(matcher.match('check cause list')).not.toBeNull();
    store.setEnabled(s.id, false);
    expect(matcher.match('check cause list')).toBeNull();
    expect(matcher.match('check caus list')).toBeNull();
    store.setEnabled(s.id, true);
    expect(matcher.match('check cause list')).not.toBeNull();
  });

  it('follows changes to the routines at once: new, edited and deleted wordings', () => {
    const { store, matcher } = rig();
    expect(matcher.match('check cause list')).toBeNull();
    const s = add(store, 'cause list', ['check cause list']);
    expect(matcher.match('check cause list')?.skill.id).toBe(s.id);
    store.setTriggers(s.id, ['show orders']);
    expect(matcher.match('check cause list')).toBeNull();
    expect(matcher.match('show orders')?.skill.id).toBe(s.id);
    store.delete(s.id);
    expect(matcher.match('show orders')).toBeNull();
  });

  it('is extremely fast: an exact match among 500 routines takes a fraction of a millisecond (no database, no model)', () => {
    const { store, matcher, db } = rig();
    db.transaction(() => {
      for (let i = 0; i < 500; i += 1) add(store, `routine ${i}`, [`do thing number ${i} now ok`, `thing ${i} alpha`]);
    });
    matcher.refresh();
    const t0 = performance.now();
    for (let i = 0; i < 1000; i += 1) matcher.match('thing 321 alpha');
    const perMatch = (performance.now() - t0) / 1000;
    expect(matcher.match('thing 321 alpha')?.skill.name).toBe('routine 321');
    expect(perMatch).toBeLessThan(2);
  });

  it('even a close-but-not-exact lookup among 500 routines stays quick', () => {
    const { store, matcher, db } = rig();
    db.transaction(() => {
      for (let i = 0; i < 500; i += 1) add(store, `routine ${i}`, [`check ${['orders', 'notices', 'cases', 'judges'][i % 4]} list ${['alpha', 'beta', 'gamma'][i % 3]} ${i}`]);
    });
    matcher.refresh();
    const t0 = performance.now();
    matcher.match('check orders list alpha 400 ok sure');
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
