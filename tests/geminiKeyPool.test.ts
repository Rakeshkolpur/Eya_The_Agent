import { describe, it, expect } from 'vitest';
import { GeminiKeyPool, keyId } from '../src/main/config/geminiKeyPool';
import type { GeminiBackend, PoolState, PoolStateStore, SpeechBackend } from '../src/main/config/geminiKeyPool';
import { failureOf } from '../src/main/providers/ai/failure';
import type { AIChatMessage, AICompletion, CompleteOptions } from '../src/main/providers/ai/AIProvider';

type Mode = 'ok' | 'daily' | 'rate' | 'auth' | 'overloaded';

const KEY_A = 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const KEY_B = 'AIzaSyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2';
const KEY_C = 'AIzaSyCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3';

function fail(mode: Mode): Error {
  switch (mode) {
    case 'daily':
      return Object.assign(new Error('gemini daily quota exhausted (429) for every model'), { status: 429, dailyQuota: true });
    case 'rate':
      return Object.assign(new Error('gemini http 429: rate limited'), { status: 429, retryAfterMs: 20_000 });
    case 'auth':
      return Object.assign(new Error('gemini http 400: API key not valid'), { status: 400 });
    default:
      return Object.assign(new Error('gemini http 503: high demand'), { status: 503 });
  }
}

class FakeAi implements GeminiBackend {
  mode: Mode = 'ok';
  calls = 0;
  fastFlags: Array<boolean | undefined> = [];
  constructor(readonly key: string) {}
  isReady(): boolean {
    return true;
  }
  hasKey(): boolean {
    return true;
  }
  currentModel(): string | undefined {
    return `model-of-${this.key.slice(-1)}`;
  }
  liveUrl(): string | null {
    return `wss://live.example/?key=${this.key}`;
  }
  private attempt<T>(value: T): Promise<T> {
    this.calls += 1;
    return this.mode === 'ok' ? Promise.resolve(value) : Promise.reject(fail(this.mode));
  }
  complete(_m: readonly AIChatMessage[], _t: readonly unknown[], options?: CompleteOptions): Promise<AICompletion> {
    this.fastFlags.push(options?.failFast);
    return this.attempt({ text: `answer from ${this.key.slice(-1)}`, toolCalls: [] });
  }
  transcribe(): Promise<string> {
    return this.attempt(`heard by ${this.key.slice(-1)}`);
  }
  analyzeFile(): Promise<string> {
    return this.attempt(`read by ${this.key.slice(-1)}`);
  }
  groundedSearch(): Promise<{ text: string; sources: { title: string; uri: string }[] }> {
    return this.attempt({ text: `searched by ${this.key.slice(-1)}`, sources: [] });
  }
}

class FakeSpeech implements SpeechBackend {
  mode: Mode = 'ok';
  calls = 0;
  /** Plays this many chunks, then fails with `mode` (to model a stream that dies half way). */
  chunksBeforeFailing = 0;
  constructor(readonly key: string) {}
  hasKey(): boolean {
    return true;
  }
  async stream(_t: string, _v: string, onChunk: (pcm: Uint8Array) => void): Promise<{ model: string; ms: number; bytes: number }> {
    this.calls += 1;
    for (let i = 0; i < this.chunksBeforeFailing; i += 1) onChunk(new Uint8Array([1, 2]));
    if (this.mode !== 'ok') throw fail(this.mode);
    onChunk(new Uint8Array([9, 9]));
    return { model: `tts-${this.key.slice(-1)}`, ms: 5, bytes: 2 };
  }
}

function setup(keys: ReadonlyArray<readonly [string, string]> = [['Father', KEY_A], ['Brother', KEY_B], ['Mother', KEY_C]], opts: { state?: PoolStateStore; start?: number } = {}) {
  const clock = { now: opts.start ?? Date.UTC(2026, 9, 21, 6, 0, 0) };
  const ais = new Map<string, FakeAi>();
  const speeches = new Map<string, FakeSpeech>();
  const pool = new GeminiKeyPool({
    makeAi: (k) => {
      const a = new FakeAi(k);
      ais.set(k, a);
      return a;
    },
    makeSpeech: (k) => {
      const s = new FakeSpeech(k);
      speeches.set(k, s);
      return s;
    },
    ...(opts.state !== undefined ? { state: opts.state } : {}),
    now: () => clock.now,
  });
  pool.setKeys(keys.map(([name, key], i) => ({ name, key, main: i === 0 })));
  return { pool, clock, ais, speeches, a: ais.get(KEY_A) as FakeAi, b: ais.get(KEY_B) as FakeAi, c: ais.get(KEY_C) as FakeAi };
}

const ask = (pool: GeminiKeyPool) => pool.complete([{ role: 'user', content: 'hi' }], []);

describe('several Gemini keys used one after another', () => {
  it('the first key answers until its day is used up; the request that finds it spent goes straight on to the next', async () => {
    const { pool, a, b } = setup();
    expect((await ask(pool)).text).toBe('answer from 1');
    a.mode = 'daily';
    expect((await ask(pool)).text).toBe('answer from 2'); // same request, no error shown
    expect(a.calls).toBe(2);
    expect((await ask(pool)).text).toBe('answer from 2');
    expect(a.calls).toBe(2); // not asked again: it is resting
    expect(b.calls).toBe(2);
  });

  it('moves on to the third key when the second is spent too, and says which is answering', async () => {
    const { pool, a, b } = setup();
    a.mode = 'daily';
    b.mode = 'daily';
    expect((await ask(pool)).text).toBe('answer from 3');
    const states = pool.status().map((e) => [e.name, e.state, e.inUse]);
    expect(states).toEqual([['Father', 'used-up', false], ['Brother', 'used-up', false], ['Mother', 'ready', true]]);
    expect(pool.currentModel()).toBe('model-of-3');
  });

  it('a key that is only rate limited is set aside for a short while; the next key carries on and the first is not gone back to', async () => {
    const { pool, clock, a } = setup();
    a.mode = 'rate';
    expect((await ask(pool)).text).toBe('answer from 2');
    expect(pool.status()[0]).toMatchObject({ state: 'busy' });
    a.mode = 'ok';
    clock.now += 6 * 60_000; // past any short rest: key 1 is ready again...
    expect(pool.status()[0]).toMatchObject({ state: 'ready', inUse: false });
    expect((await ask(pool)).text).toBe('answer from 2'); // ...but key 2 carries on until it is finished with
    expect((await ask(pool)).text).toBe('answer from 2');
  });

  it('goes one by one: each key is finished with before the next, then back to the earlier ones, never jumping about', async () => {
    const { pool, clock, a, b, c } = setup();
    const heard: string[] = [];
    const next = async (): Promise<void> => void heard.push((await ask(pool)).text.slice(-1));
    await next();
    await next(); // key 1, key 1
    a.mode = 'daily';
    await next();
    await next(); // key 2, key 2 (key 1 is spent)
    a.mode = 'ok'; // key 1 recovers, but key 2 is still the one in use
    await next();
    b.mode = 'daily';
    await next();
    await next(); // key 2 spent: on to key 3, not back to key 1
    c.mode = 'daily';
    clock.now += 4 * 3_600_000; // (the earlier keys' rests have run out by now)
    await next(); // key 3 spent: only now back round to key 1
    expect(heard).toEqual(['1', '1', '2', '2', '2', '3', '3', '1']);
  });

  it('starts again from the first key on a new day', async () => {
    const { pool, clock, a } = setup();
    a.mode = 'daily';
    await ask(pool);
    expect((await ask(pool)).text).toBe('answer from 2');
    a.mode = 'ok';
    clock.now = Date.UTC(2026, 9, 22, 0, 5, 0);
    expect((await ask(pool)).text).toBe('answer from 1');
  });

  it('a used-up key is tried again at the day\'s reset, not before', async () => {
    const { pool, clock, a } = setup();
    a.mode = 'daily';
    await ask(pool);
    a.mode = 'ok';
    clock.now += 2 * 3_600_000; // 8:00 UTC: still the same day
    expect((await ask(pool)).text).toBe('answer from 2');
    clock.now = Date.UTC(2026, 9, 22, 0, 5, 0); // the next day
    expect((await ask(pool)).text).toBe('answer from 1');
  });

  it('a key Google refuses is set aside and named as refused', async () => {
    const { pool, a } = setup();
    a.mode = 'auth';
    expect((await ask(pool)).text).toBe('answer from 2');
    expect(pool.status()[0]).toMatchObject({ state: 'refused', backAt: null });
  });

  it('an overloaded service is the same for every key: it is not passed round', async () => {
    const { pool, a, b } = setup();
    a.mode = 'overloaded';
    await expect(ask(pool)).rejects.toMatchObject({ status: 503 });
    expect(b.calls).toBe(0);
    expect(pool.status()[0]).toMatchObject({ state: 'ready' });
  });

  it('when every key is used up the failure is the daily one a single key would give', async () => {
    const { pool, a, b, c } = setup();
    for (const k of [a, b, c]) k.mode = 'daily';
    const err = await ask(pool).catch((e: unknown) => e);
    expect(failureOf(err).kind).toBe('daily');
    expect(pool.status().every((e) => e.state === 'used-up')).toBe(true);
  });

  it('a limit is reported rather than a refusal when keys failed in both ways', async () => {
    const { pool, a, b } = setup([['Father', KEY_A], ['Brother', KEY_B]]);
    a.mode = 'auth';
    b.mode = 'rate';
    expect(failureOf(await ask(pool).catch((e: unknown) => e)).kind).toBe('rate');
  });

  it('asks the earlier keys to give up quickly (another key is ready) but lets the last one take its time', async () => {
    const { pool, a, b, c } = setup();
    a.mode = 'daily';
    b.mode = 'daily';
    await pool.complete([{ role: 'user', content: 'x' }], [], { failFast: false });
    expect(a.fastFlags).toEqual([true]);
    expect(b.fastFlags).toEqual([true]);
    expect(c.fastFlags).toEqual([false]);
  });

  it('reading documents, transcribing and searching move to the next key the same way', async () => {
    const { pool, a } = setup();
    a.mode = 'daily';
    expect(await pool.transcribe('x', 'audio/wav')).toBe('heard by 2');
    expect(await pool.analyzeFile('x', 'application/pdf', 'q')).toBe('read by 2');
    expect((await pool.groundedSearch('q')).text).toBe('searched by 2');
  });

  it('with no key at all it says so', async () => {
    const { pool } = setup([]);
    expect(pool.hasKey()).toBe(false);
    expect(pool.liveUrl()).toBeNull();
    await expect(ask(pool)).rejects.toThrow(/key missing/);
  });
});

describe('the list of keys', () => {
  it('keeps what is known about the keys that stay, drops the rest, and ignores the same key twice', async () => {
    const { pool, a } = setup();
    a.mode = 'daily';
    await ask(pool);
    pool.setKeys([
      { name: 'Dad', key: KEY_A, main: true },
      { name: 'Dad again', key: KEY_A, main: false },
      { name: 'Mother', key: KEY_C, main: false },
    ]);
    const status = pool.status();
    expect(status.map((e) => e.name)).toEqual(['Dad', 'Mother']);
    expect(status[0]).toMatchObject({ state: 'used-up' }); // still resting: not forgotten by being renamed
    expect(status[0]?.id).toBe(keyId(KEY_A));
  });

  it('tells the interface only when something changed, not on every request', async () => {
    const { pool, a } = setup();
    let changes = 0;
    pool.onChange(() => (changes += 1));
    await ask(pool);
    await ask(pool);
    await ask(pool);
    expect(changes).toBe(0); // key 1 was already the one in use: nothing to announce
    a.mode = 'daily';
    await ask(pool);
    expect(changes).toBeGreaterThanOrEqual(1); // key 1 used up, key 2 now answering
    const after = changes;
    await ask(pool);
    expect(changes).toBe(after);
  });

  it('counts the requests each key answered today and starts again on a new day', async () => {
    const { pool, clock, a } = setup();
    await ask(pool);
    await ask(pool);
    a.mode = 'daily';
    await ask(pool);
    expect(pool.status().map((e) => e.requests)).toEqual([2, 1, 0]);
    clock.now = Date.UTC(2026, 9, 22, 1, 0, 0);
    expect(pool.status().map((e) => e.requests)).toEqual([0, 0, 0]);
    expect(pool.status().every((e) => e.state === 'ready')).toBe(true);
  });

  it('remembers which keys are resting across a restart (no key is in what is saved)', async () => {
    let saved: PoolState | null = null;
    const store: PoolStateStore = { load: () => saved, save: (s) => void (saved = s) };
    const first = setup(undefined, { state: store });
    first.a.mode = 'daily';
    await ask(first.pool);
    expect(JSON.stringify(saved)).not.toContain('AIza');
    const second = setup(undefined, { state: store });
    expect(second.pool.status().map((e) => e.state)).toEqual(['used-up', 'ready', 'ready']);
    await ask(second.pool);
    expect(second.a.calls).toBe(0); // not asked: it was already known to be spent
  });

  it('ignores a saved state from another day', () => {
    const yesterday: PoolState = { day: '2026-10-20', rests: { [keyId(KEY_A)]: { until: Date.UTC(2026, 9, 21, 23), kind: 'daily' } }, requests: { [keyId(KEY_A)]: 40 } };
    const { pool } = setup(undefined, { state: { load: () => yesterday, save: () => undefined } });
    expect(pool.status()[0]).toMatchObject({ state: 'ready', requests: 0 });
  });
});

describe('testing one key', () => {
  it('a key that works is put back in use at once', async () => {
    const { pool, a } = setup();
    a.mode = 'daily';
    await ask(pool);
    a.mode = 'ok';
    const r = await pool.testKey(keyId(KEY_A));
    expect(r).toMatchObject({ ok: true, kind: 'ok' });
    expect(pool.status()[0]).toMatchObject({ state: 'ready' });
    expect((await ask(pool)).text).toBe('answer from 2'); // key 2 is the one in use and carries on
    (pool as unknown as { active: string | null }).active = null; // (a new day would do this) ...
    expect((await ask(pool)).text).toBe('answer from 1'); // ... and the key found working is the first used again
  });

  it('one that is used up says so, with when it will be tried again, and is set aside', async () => {
    const { pool, a } = setup();
    a.mode = 'daily';
    const r = await pool.testKey(keyId(KEY_A));
    expect(r).toMatchObject({ ok: false, kind: 'daily' });
    expect(r.backAt).toBeGreaterThan(Date.UTC(2026, 9, 21, 6));
    expect(pool.status()[0]).toMatchObject({ state: 'used-up' });
  });

  it('a refused key is named as refused, and an unknown key as not found', async () => {
    const { pool, a } = setup();
    a.mode = 'auth';
    expect(await pool.testKey(keyId(KEY_A))).toMatchObject({ ok: false, kind: 'auth' });
    expect(await pool.testKey('nope')).toMatchObject({ ok: false });
  });
});

describe('the live voice', () => {
  it('starts on the first key, and after trouble the next start uses the next key', () => {
    const { pool } = setup();
    expect(pool.liveUrl()).toContain(KEY_A);
    expect(pool.liveTrouble()).toBe(true); // another key is free
    expect(pool.liveUrl()).toContain(KEY_B);
    expect(pool.liveTrouble()).toBe(true);
    expect(pool.liveUrl()).toContain(KEY_C);
    expect(pool.liveTrouble()).toBe(false); // none left to try
  });

  it('comes back to the first key after a while', () => {
    const { pool, clock } = setup();
    pool.liveUrl();
    pool.liveTrouble();
    expect(pool.liveUrl()).toContain(KEY_B);
    clock.now += 11 * 60_000;
    expect(pool.liveUrl()).toContain(KEY_A);
  });

  it('with one key there is nothing else to try', () => {
    const { pool } = setup([['Me', KEY_A]]);
    pool.liveUrl();
    expect(pool.liveTrouble()).toBe(false);
    expect(pool.liveUrl()).toContain(KEY_A); // still tries the only one it has
  });
});

describe('speech', () => {
  it('moves to the next key when one key\'s speech allowance is spent, and remembers it', async () => {
    const { pool, speeches } = setup();
    (speeches.get(KEY_A) as FakeSpeech).mode = 'daily';
    const chunks: number[] = [];
    const out = await pool.speech.stream('hello', 'Kore', (p) => chunks.push(p.length), new AbortController().signal);
    expect(out.model).toBe('tts-2');
    await pool.speech.stream('hello again', 'Kore', () => undefined, new AbortController().signal);
    expect((speeches.get(KEY_A) as FakeSpeech).calls).toBe(1); // not asked again while resting
  });

  it('its own allowance running out does not stop the key from answering in text', async () => {
    const { pool, speeches } = setup();
    (speeches.get(KEY_A) as FakeSpeech).mode = 'daily';
    await pool.speech.stream('hello', 'Kore', () => undefined, new AbortController().signal);
    expect((await ask(pool)).text).toBe('answer from 1');
  });

  it('after a few words were already spoken it stops rather than start again in another key\'s voice', async () => {
    const { pool, speeches } = setup();
    const first = speeches.get(KEY_A) as FakeSpeech;
    first.mode = 'rate';
    first.chunksBeforeFailing = 1;
    await expect(pool.speech.stream('hello', 'Kore', () => undefined, new AbortController().signal)).rejects.toMatchObject({ status: 429 });
    expect((speeches.get(KEY_B) as FakeSpeech).calls).toBe(0);
  });

  it('a hiccup that is not about the key is not passed round', async () => {
    const { pool, speeches } = setup();
    (speeches.get(KEY_A) as FakeSpeech).mode = 'overloaded';
    await expect(pool.speech.stream('hello', 'Kore', () => undefined, new AbortController().signal)).rejects.toMatchObject({ status: 503 });
    expect((speeches.get(KEY_B) as FakeSpeech).calls).toBe(0);
  });

  it('says whether there is a key at all', () => {
    expect(setup().pool.speech.hasKey()).toBe(true);
    expect(setup([]).pool.speech.hasKey()).toBe(false);
  });
});
