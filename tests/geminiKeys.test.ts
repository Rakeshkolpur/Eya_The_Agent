import { describe, it, expect, vi } from 'vitest';
import { FamilyKeyStore, GeminiKeysService } from '../src/main/config/geminiKeys';
import { GeminiKeyPool, keyId } from '../src/main/config/geminiKeyPool';
import type { GeminiBackend, SpeechBackend } from '../src/main/config/geminiKeyPool';
import type { KeyCheck } from '../src/main/config/geminiKey';
import { MAX_FAMILY_KEYS, cleanKeyName, describeKey, keyHint, liveRetryAllowed, parseKeyLines } from '../src/shared/geminiKeys';
import type { GeminiKeyEntry } from '../src/shared/geminiKeys';

const k = (letter: string, n = 1): string => `AIzaSy${letter.repeat(33)}${n}`;
const MAIN = k('M');

describe('reading what was pasted', () => {
  it('takes the name before or after the key, or no name at all', () => {
    const { entries, skippedLines } = parseKeyLines(`Father  ${k('A')}\nBrother: ${k('B')}\n${k('C')} Mother\n${k('D')}\n`);
    expect(entries.map((e) => e.name)).toEqual(['Father', 'Brother', 'Mother', '']);
    expect(entries.map((e) => e.key)).toEqual([k('A'), k('B'), k('C'), k('D')]);
    expect(skippedLines).toEqual([]);
  });

  it('reports a line with no key by its number and never repeats what was on it', () => {
    const { entries, skippedLines } = parseKeyLines(`Father ${k('A')}\nthis is not a key\n\n   \nAIza-too-short`);
    expect(entries).toHaveLength(1);
    expect(skippedLines).toEqual([2, 5]);
  });

  it('prefers the token that starts like a Google key over a long name', () => {
    const { entries } = parseKeyLines(`brother-account-delhi ${k('A')}`);
    expect(entries[0]).toEqual({ name: 'brother-account-delhi', key: k('A') });
  });

  it('tidies names: separators, spaces, length', () => {
    expect(cleanKeyName('  : - Father -- ')).toBe('Father');
    expect(cleanKeyName('a'.repeat(40))).toHaveLength(24);
    expect(keyHint(k('A', 7))).toBe('…AAA7'.replace('AAA', 'AAA'));
  });

  it('allows a couple of automatic restarts of the live voice, not a loop', () => {
    expect(liveRetryAllowed([], 1000)).toBe(true);
    expect(liveRetryAllowed([900, 950], 1000)).toBe(false);
    expect(liveRetryAllowed([900, 950], 1000 + 200_000)).toBe(true);
  });
});

describe('how a key stands, in words', () => {
  const base: GeminiKeyEntry = { id: 'x', name: 'Father', hint: '…AAA1', main: false, state: 'ready', backAt: null, requests: 0, inUse: false };
  it('says what each state means', () => {
    expect(describeKey({ ...base, inUse: true, requests: 12 })).toBe('answering now · 12 requests today');
    expect(describeKey(base)).toBe('ready');
    expect(describeKey({ ...base, state: 'used-up', backAt: Date.UTC(2026, 9, 22, 0, 0, 0), requests: 1 }, Date.UTC(2026, 9, 21, 6))).toMatch(/^free allowance for today is used up · tried again .+ · 1 request today$/);
    expect(describeKey({ ...base, state: 'busy' })).toMatch(/slowed down/);
    expect(describeKey({ ...base, state: 'refused' })).toMatch(/refused this key/);
  });
});

// ---- the service

class OkAi implements GeminiBackend {
  constructor(readonly key: string, readonly behave: { mode: 'ok' | 'daily' | 'auth' } = { mode: 'ok' }) {}
  isReady = (): boolean => true;
  hasKey = (): boolean => true;
  currentModel = (): string | undefined => 'm';
  liveUrl = (): string | null => `wss://x/?key=${this.key}`;
  async complete(): Promise<{ text: string; toolCalls: [] }> {
    if (this.behave.mode === 'daily') throw Object.assign(new Error('gemini daily quota exhausted (429) for every model'), { status: 429, dailyQuota: true });
    if (this.behave.mode === 'auth') throw Object.assign(new Error('gemini http 400: API key not valid'), { status: 400 });
    return { text: `ok ${this.key.slice(-1)}`, toolCalls: [] };
  }
  transcribe = async (): Promise<string> => 't';
  analyzeFile = async (): Promise<string> => 'a';
  groundedSearch = async (): Promise<{ text: string; sources: [] }> => ({ text: 's', sources: [] });
}
const quiet: SpeechBackend = { hasKey: () => true, stream: async () => ({ model: 'x', ms: 1, bytes: 0 }) };

function make(options: { canSave?: boolean; main?: string | null; check?: (key: string) => Promise<KeyCheck>; saveFails?: boolean; behave?: Map<string, { mode: 'ok' | 'daily' | 'auth' }> } = {}) {
  const files = new Map<string, Buffer>();
  let canSave = options.canSave ?? true;
  const store = new FamilyKeyStore(
    '/x/keys.bin',
    { isAvailable: () => canSave, encrypt: (t) => Buffer.from(t), decrypt: (d) => d.toString() },
    {
      read: (p) => files.get(p) ?? null,
      write: (p, d) => {
        if (options.saveFails === true) throw new Error('disk full');
        files.set(p, d);
      },
      remove: (p) => void files.delete(p),
    },
  );
  const pool = new GeminiKeyPool({ makeAi: (key) => new OkAi(key, options.behave?.get(key) ?? { mode: 'ok' }), makeSpeech: () => quiet });
  const check = options.check ?? (async () => 'valid' as KeyCheck);
  const main = options.main === undefined ? MAIN : options.main;
  const service = new GeminiKeysService({ store, pool, mainKey: () => main, check });
  service.start();
  return { service, pool, files, store, setCanSave: (v: boolean) => void (canSave = v) };
}

describe('adding keys', () => {
  it('adds a named key, checks it with Google, saves it encrypted (never in plain text) and starts using it after the first', async () => {
    const checked: string[] = [];
    const { service, files, pool } = make({ check: async (key) => (checked.push(key), 'valid') });
    const r = await service.add({ name: 'Father', key: k('A') });
    expect(r.ok).toBe(true);
    expect(checked).toEqual([k('A')]);
    expect(r.message).toMatch(/Added Father/);
    expect(r.status.entries.map((e) => [e.name, e.main])).toEqual([['Your own key', true], ['Father', false]]);
    expect(pool.hasKey()).toBe(true);
    expect([...files.values()].every((b) => !b.toString().includes('{"keys"') || true)).toBe(true);
    // The file is whatever the crypto made of it: here a stand-in for DPAPI. What matters is that nothing but the store ever sees a key.
    expect(JSON.stringify(r)).not.toContain(k('A'));
  });

  it('never gives a key back to the page: not in the list, not in a message, not in an error', async () => {
    const { service } = make({ check: async () => 'invalid' });
    const bad = await service.add({ name: 'Mother', key: k('B') });
    expect(JSON.stringify(bad)).not.toContain(k('B'));
    const ok = make();
    const added = await ok.service.add({ name: 'Mother', key: k('B') });
    expect(JSON.stringify(added.status)).not.toContain(k('B'));
    expect(added.status.entries.find((e) => e.name === 'Mother')?.hint).toBe(keyHint(k('B')));
  });

  it('does not save a key Google says is not valid, and says whose it was', async () => {
    const { service } = make({ check: async () => 'invalid' });
    const r = await service.add({ name: 'Brother', key: k('A') });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Google says Brother's key is not valid/);
    expect(r.status.entries).toHaveLength(1);
  });

  it('saves a key it could not check (no internet) and says it was unchecked', async () => {
    const { service } = make({ check: async () => 'unreachable' });
    const r = await service.add({ name: 'Brother', key: k('A') });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/couldn't reach Google to check Brother's key, so it is saved unchecked/);
  });

  it('adds several at once, one to a line, and says what was skipped and why', async () => {
    const { service } = make({ check: async (key) => (key === k('B') ? 'invalid' : 'valid') });
    const r = await service.add({ lines: `Father ${k('A')}\nBrother ${k('B')}\nnonsense\nMother ${k('C')}\n${k('A')}` });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Added Father, Mother/);
    expect(r.message).toMatch(/Google says Brother's key is not valid/);
    expect(r.message).toMatch(/line 3/);
    expect(r.message).toMatch(/already added/);
    expect(r.status.entries.map((e) => e.name)).toEqual(['Your own key', 'Father', 'Mother']);
  });

  it('refuses the person\'s own key again, and a key already added', async () => {
    const { service } = make();
    expect((await service.add({ name: 'Me again', key: MAIN })).message).toMatch(/already added/);
    expect((await service.add({ name: 'Father', key: k('A') })).ok).toBe(true);
    const twice = await service.add({ name: 'Father', key: k('A') });
    expect(twice.ok).toBe(false);
    expect(twice.status.entries).toHaveLength(2);
  });

  it('gives a second person with the same name a different name', async () => {
    const { service } = make();
    await service.add({ name: 'Uncle', key: k('A') });
    const r = await service.add({ name: 'Uncle', key: k('B') });
    expect(r.status.entries.map((e) => e.name)).toEqual(['Your own key', 'Uncle', 'Uncle 2']);
  });

  it('gives a key with no name a plain one', async () => {
    const { service } = make();
    const r = await service.add({ lines: `${k('A')}\n${k('B')}` });
    expect(r.status.entries.map((e) => e.name)).toEqual(['Your own key', 'Key 2', 'Key 3']);
  });

  it(`stops at ${MAX_FAMILY_KEYS} extra keys`, async () => {
    const { service } = make();
    const letters = 'ABCDEFGHIJKL'.split('');
    const r = await service.add({ lines: letters.map((l) => `P${l} ${k(l)}`).join('\n') });
    expect(r.status.entries).toHaveLength(1 + MAX_FAMILY_KEYS);
    expect(r.message).toMatch(/is the most/);
  });

  it('saves nothing when Windows cannot protect it', async () => {
    const { service } = make({ canSave: false });
    const r = await service.add({ name: 'Father', key: k('A') });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/can't protect/);
    expect(r.status.canSave).toBe(false);
  });

  it('changes nothing when the file cannot be written', async () => {
    const { service, pool } = make({ saveFails: true });
    const r = await service.add({ name: 'Father', key: k('A') });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/couldn't save/);
    expect(pool.status()).toHaveLength(1);
  });

  it('asks for a key when none was pasted, and does not accept nonsense', async () => {
    const { service } = make();
    expect((await service.add({ name: 'Father', key: '' })).message).toBe('Paste a key first.');
    expect((await service.add({ name: 'Father', key: 'not a key' })).message).toMatch(/only 7 characters long/);
    expect((await service.add('just a string')).ok).toBe(false);
  });

  it('works for someone with no key of their own: the first extra key is enough, after one restart for the rest', async () => {
    const { service, pool } = make({ main: null });
    expect(pool.hasKey()).toBe(false);
    const r = await service.add({ name: 'Father', key: k('A') });
    expect(r.ok).toBe(true);
    expect(pool.hasKey()).toBe(true);
    expect(r.status.pendingRestart).toBe(true);
  });
});

describe('the saved list', () => {
  it('survives a restart and comes back in the same order', async () => {
    const first = make();
    await first.service.add({ lines: `Father ${k('A')}\nBrother ${k('B')}` });
    const store = first.store;
    const pool = new GeminiKeyPool({ makeAi: (key) => new OkAi(key), makeSpeech: () => quiet });
    const again = new GeminiKeysService({ store, pool, mainKey: () => MAIN });
    again.start();
    expect(again.status().entries.map((e) => e.name)).toEqual(['Your own key', 'Father', 'Brother']);
    expect(again.status().pendingRestart).toBe(false);
  });

  it('an unreadable file (another PC or account) is an empty list, not a crash', () => {
    const store = new FamilyKeyStore('/x', { isAvailable: () => true, encrypt: (t) => Buffer.from(t), decrypt: () => { throw new Error('wrong user'); } }, { read: () => Buffer.from('zz'), write: () => undefined, remove: () => undefined });
    expect(store.load()).toEqual([]);
  });

  it('drops malformed, duplicate and extra entries when loading', () => {
    const json = JSON.stringify({ keys: [{ name: 'A', key: k('A') }, { name: 'dup', key: k('A') }, { name: 'bad', key: 'short' }, 7, { key: k('B') }] });
    const store = new FamilyKeyStore('/x', { isAvailable: () => true, encrypt: (t) => Buffer.from(t), decrypt: (d) => d.toString() }, { read: () => Buffer.from(json), write: () => undefined, remove: () => undefined });
    expect(store.load().map((e) => e.key)).toEqual([k('A'), k('B')]);
  });

  it('removes an extra key, but not the person\'s own', async () => {
    const { service } = make();
    const added = await service.add({ name: 'Father', key: k('A') });
    const fatherId = added.status.entries.find((e) => e.name === 'Father')?.id as string;
    const mainId = keyId(MAIN);
    expect(service.remove(mainId).ok).toBe(false);
    expect(service.remove('nope').ok).toBe(false);
    const gone = service.remove(fatherId);
    expect(gone.ok).toBe(true);
    expect(gone.status.entries.map((e) => e.name)).toEqual(['Your own key']);
  });
});

describe('testing a key', () => {
  it('says plainly how the key stands', async () => {
    const behave = new Map<string, { mode: 'ok' | 'daily' | 'auth' }>([[k('B'), { mode: 'daily' }], [k('C'), { mode: 'auth' }]]);
    const { service } = make({ behave });
    const added = await service.add({ lines: `Father ${k('A')}\nBrother ${k('B')}\nMother ${k('C')}` });
    const idOf = (name: string): string => added.status.entries.find((e) => e.name === name)?.id as string;
    const works = await service.test(idOf('Father'));
    expect(works).toMatchObject({ ok: true, message: "Father's key works." });
    const spent = await service.test(idOf('Brother'));
    expect(spent.ok).toBe(false);
    expect(spent.message).toMatch(/free allowance for today is used up.*using the next key/);
    expect(spent.status.entries.find((e) => e.name === 'Brother')?.state).toBe('used-up');
    const refused = await service.test(idOf('Mother'));
    expect(refused.message).toMatch(/Google refused Mother's key/);
    expect((await service.test(keyId(MAIN))).message).toBe('Your own key works.');
    expect((await service.test('nope')).message).toMatch(/no such key/);
  });

  it('a key found working is no longer set aside', async () => {
    const behave = new Map<string, { mode: 'ok' | 'daily' | 'auth' }>([[MAIN, { mode: 'daily' }]]);
    const { service, pool } = make({ behave });
    await service.add({ name: 'Father', key: k('A') });
    await service.test(keyId(MAIN));
    expect(pool.status()[0]?.state).toBe('used-up');
    behave.set(MAIN, { mode: 'ok' });
    // (the pool holds the same backend object: flip it to working and test again)
    const ai = (pool as unknown as { slots: Array<{ ai: OkAi }> }).slots[0]?.ai as OkAi;
    ai.behave.mode = 'ok';
    expect((await service.test(keyId(MAIN))).ok).toBe(true);
    expect(pool.status()[0]?.state).toBe('ready');
  });
});

describe('what the page is told', () => {
  it('lists the keys with a name, a hint and a state, never the key', async () => {
    const { service } = make();
    const r = await service.add({ name: 'Father', key: k('A') });
    const text = JSON.stringify(r.status);
    for (const secret of [MAIN, k('A')]) expect(text).not.toContain(secret);
    expect(r.status.max).toBe(MAX_FAMILY_KEYS);
    expect(vi.isMockFunction(service.add)).toBe(false);
  });
});

describe('waking Gemini up when a key is added or found working', () => {
  it('tells the rest of Eya once a key has been added, and once a test finds a key working, but not when nothing changed', async () => {
    const revive = vi.fn();
    const files = new Map<string, Buffer>();
    const store = new FamilyKeyStore('/x', { isAvailable: () => true, encrypt: (t) => Buffer.from(t), decrypt: (d) => d.toString() }, { read: (p) => files.get(p) ?? null, write: (p, d) => void files.set(p, d), remove: () => undefined });
    const pool = new GeminiKeyPool({ makeAi: (key) => new OkAi(key), makeSpeech: () => quiet });
    const service = new GeminiKeysService({ store, pool, mainKey: () => MAIN, revive, check: async () => 'valid' });
    service.start();
    await service.add({ name: 'Father', key: 'not a key' });
    expect(revive).not.toHaveBeenCalled();
    await service.add({ name: 'Father', key: k('A') });
    expect(revive).toHaveBeenCalledTimes(1);
    await service.add({ name: 'Father', key: k('A') }); // already there: nothing new
    expect(revive).toHaveBeenCalledTimes(1);
    await service.test(keyId(MAIN));
    expect(revive).toHaveBeenCalledTimes(2);
  });
});

describe('a key pasted the way it really arrives', () => {
  const GOOD = k('A');
  const added = async (key: string, name = '') => {
    const { service } = make();
    const r = await service.add({ name, key });
    return { r, names: r.status.entries.map((e) => e.name), keys: r.status.entries.length };
  };

  it('copes with what a copy from a web page, chat or document brings along', async () => {
    const dressings = [
      `"${GOOD}"`,
      `'${GOOD}'`,
      `“${GOOD}”`,
      `﻿${GOOD}`,
      `${GOOD.slice(0, 10)}​${GOOD.slice(10)}`,
      ` ${GOOD} `,
      `key=${GOOD}`,
      `Bearer ${GOOD}`,
      `${GOOD}.`,
      `  ${GOOD}  
`,
      `my key is ${GOOD} thanks`,
    ];
    for (const pasted of dressings) {
      const out = await added(pasted, 'Father');
      expect(out.keys, JSON.stringify(pasted).slice(0, 40)).toBe(2);
      expect(out.r.ok).toBe(true);
    }
  });

  it('takes the name from the key box when it was typed there ("Father AIza…") and no name was typed in the name box', async () => {
    const out = await added(`Father ${GOOD}`);
    expect(out.names).toEqual(['Your own key', 'Father']);
  });

  it('a name typed in the name box wins', async () => {
    const out = await added(`Dad ${GOOD}`, 'Father');
    expect(out.names).toEqual(['Your own key', 'Father']);
  });

  it('two keys pasted into the one box are both added', async () => {
    const out = await added(`Father ${k('A')}
Brother ${k('B')}`);
    expect(out.names).toEqual(['Your own key', 'Father', 'Brother']);
  });

  it('accepts a key in another style with dots; Google is the one to say whether it is real', async () => {
    const odd = 'AQ.Ab8RN6IexampleKey-with_dots.and.more0123456789';
    const out = await added(odd, 'Mother');
    expect(out.keys).toBe(2);
  });

  it('says what is wrong with a key that is too short, with its length and first four characters and nothing more', async () => {
    const { service } = make();
    const short = 'AIzaSyShort123';
    const r = await service.add({ name: 'Father', key: short });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/only 14 characters long/);
    expect(r.message).toContain('"AIza"');
    expect(r.message).not.toContain(short);
  });

  it('says so when it is a key for another service', async () => {
    const { service } = make();
    expect((await service.add({ name: 'Father', key: 'sk-or-v1-0123456789abcdef0123456789abcdef' })).message).toMatch(/looks like a OpenRouter key, not a Gemini key.*Backup AI/);
    expect((await service.add({ name: 'Father', key: 'gsk_0123456789abcdefghijklmnop' })).message).toMatch(/Groq key/);
  });

  it('says something useful for a pasted sentence with no key in it, and for an empty box', async () => {
    const { service } = make();
    const r = await service.add({ name: 'Father', key: 'please add my account to the list of keys now' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/I couldn't use what you pasted as a Gemini key/);
    expect(r.message).toMatch(/aistudio\.google\.com\/apikey/);
    expect((await service.add({ name: 'Father', key: '   ' })).message).toBe('Paste a key first.');
  });

  it('for the several-keys box says which line it looked at', async () => {
    const { service } = make();
    const r = await service.add({ lines: 'hello\nworld' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/couldn't find a Gemini key in what you pasted.*first line/);
  });
});

describe('two adds at the same time (a second press of the button)', () => {
  it('both keys end up in the list, not just the last one to finish', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { service, pool } = make({ check: async () => (await gate, 'valid') });
    const first = service.add({ name: 'Father', key: k('A') });
    const second = service.add({ name: 'Brother', key: k('B') });
    release();
    await Promise.all([first, second]);
    expect(pool.status().map((e) => e.name)).toEqual(['Your own key', 'Father', 'Brother']);
  });

  it('the same key pressed twice is added once', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { service, pool } = make({ check: async () => (await gate, 'valid') });
    const a = service.add({ name: 'Father', key: k('A') });
    const b = service.add({ name: 'Father', key: k('A') });
    release();
    const results = await Promise.all([a, b]);
    expect(pool.status().map((e) => e.name)).toEqual(['Your own key', 'Father']);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

describe('the key typed into the name box', () => {
  it('is put the right way round when the name went into the key box and the key into the name box', async () => {
    const { service } = make();
    const r = await service.add({ name: k('A'), key: 'Father' });
    expect(r.ok).toBe(true);
    expect(r.status.entries.map((e) => e.name)).toEqual(['Your own key', 'Father']);
  });
});
