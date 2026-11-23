import { describe, it, expect, vi } from 'vitest';
import { AIHttpError, OpenAICompatibleProvider } from '../src/main/providers/ai/OpenAICompatibleProvider';
import { BackupAiService, BackupAiStore, rankFreeModels } from '../src/main/config/backupAi';
import type { BackupAiConfig } from '../src/main/config/backupAi';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const ok = (text: string): Response => json({ choices: [{ message: { content: text } }] });
const modelOf = (init: unknown): string => (JSON.parse(String((init as RequestInit).body)) as { model: string }).model;

describe('OpenAICompatibleProvider with fallback models', () => {
  const make = (fetchFn: typeof fetch, models: string[], first = 'a:free'): OpenAICompatibleProvider =>
    new OpenAICompatibleProvider({ label: 'openrouter', baseUrl: 'https://x/v1', apiKey: 'k'.repeat(20), model: first, fallbackModels: models, fetchFn });

  it('asks the next free model when the first is rate limited upstream, and leaves the first alone afterwards', async () => {
    const asked: string[] = [];
    const f = vi.fn(async (_url: unknown, init: unknown) => {
      const m = modelOf(init);
      asked.push(m);
      if (m === 'a:free') return json({ error: { message: 'Provider returned error', code: 429 } }, 429);
      return ok(`from ${m}`);
    });
    const p = make(f as unknown as typeof fetch, ['b:free', 'c:free']);
    expect((await p.complete([{ role: 'user', content: 'x' }], [])).text).toBe('from b:free');
    expect(asked).toEqual(['a:free', 'b:free']);
    asked.length = 0;
    expect((await p.complete([{ role: 'user', content: 'x' }], [])).text).toBe('from b:free');
    expect(asked).toEqual(['b:free']); // a:free is resting
  });

  it('a retired model (404) is skipped, and a failure inside a 200 answer counts too', async () => {
    const f = vi.fn(async (_url: unknown, init: unknown) => {
      const m = modelOf(init);
      if (m === 'a:free') return json({ error: { message: 'No endpoints found' } }, 404);
      if (m === 'b:free') return json({ error: { message: 'upstream busy', code: 503 } }, 200);
      return ok('from c');
    });
    expect((await make(f as unknown as typeof fetch, ['b:free', 'c:free']).complete([{ role: 'user', content: 'x' }], [])).text).toBe('from c');
  });

  it('stops at once when the day is spent or the key is wrong: every model would say the same', async () => {
    const asked: string[] = [];
    const daily = vi.fn(async (_u: unknown, init: unknown) => {
      asked.push(modelOf(init));
      return json({ error: { message: 'Rate limit exceeded: free-models-per-day' } }, 429);
    });
    const err = (await make(daily as unknown as typeof fetch, ['b:free', 'c:free'])
      .complete([{ role: 'user', content: 'x' }], [])
      .catch((e: unknown) => e)) as AIHttpError;
    expect(err.dailyQuota).toBe(true);
    expect(asked).toEqual(['a:free']);

    const asked2: string[] = [];
    const badKey = vi.fn(async (_u: unknown, init: unknown) => {
      asked2.push(modelOf(init));
      return json({ error: { message: 'No auth credentials found' } }, 401);
    });
    await expect(make(badKey as unknown as typeof fetch, ['b:free']).complete([{ role: 'user', content: 'x' }], [])).rejects.toThrow(/401/);
    expect(asked2).toEqual(['a:free']);
  });

  it('tries at most five models in one request, and reports the first failure', async () => {
    const asked: string[] = [];
    const f = vi.fn(async (_u: unknown, init: unknown) => {
      asked.push(modelOf(init));
      return json({ error: { message: `busy ${asked.length}` } }, 503);
    });
    const err = (await make(f as unknown as typeof fetch, ['b:free', 'c:free', 'd:free', 'e:free', 'f:free', 'g:free'])
      .complete([{ role: 'user', content: 'x' }], [])
      .catch((e: unknown) => e)) as Error;
    expect(asked).toEqual(['a:free', 'b:free', 'c:free', 'd:free', 'e:free']);
    expect(err.message).toContain('busy 1');
  });

  it('a 403 for ONE model (OpenRouter: "only available on agentic harnesses") moves on to the next model instead of stopping the whole backup', async () => {
    const asked: string[] = [];
    const f = vi.fn(async (_u: unknown, init: unknown) => {
      const m = modelOf(init);
      asked.push(m);
      if (m === 'a:free') return json({ error: { message: 'a:free is only available on agentic harnesses', code: 403 } }, 403);
      return ok(`from ${m}`);
    });
    const p = make(f as unknown as typeof fetch, ['b:free', 'c:free']);
    expect((await p.complete([{ role: 'user', content: 'x' }], [])).text).toBe('from b:free');
    expect(asked).toEqual(['a:free', 'b:free']);
    // and it is left alone for a long while, not asked again a minute later
    asked.length = 0;
    expect((await p.complete([{ role: 'user', content: 'x' }], [])).text).toBe('from b:free');
    expect(asked).toEqual(['b:free']);
  });

  it('two 403s in a row are taken to be the key, and a single model that says 403 is reported at once', async () => {
    const asked: string[] = [];
    const forbidden = vi.fn(async (_u: unknown, init: unknown) => {
      asked.push(modelOf(init));
      return json({ error: { message: 'forbidden' } }, 403);
    });
    const err = (await make(forbidden as unknown as typeof fetch, ['b:free', 'c:free', 'd:free'])
      .complete([{ role: 'user', content: 'x' }], [])
      .catch((e: unknown) => e)) as AIHttpError;
    expect(err.status).toBe(403);
    expect(asked).toEqual(['a:free', 'b:free']);

    const only: string[] = [];
    const one = vi.fn(async (_u: unknown, init: unknown) => {
      only.push(modelOf(init));
      return json({ error: { message: 'forbidden' } }, 403);
    });
    const err2 = (await make(one as unknown as typeof fetch, []).complete([{ role: 'user', content: 'x' }], []).catch((e: unknown) => e)) as AIHttpError;
    expect(err2.status).toBe(403);
    expect(only).toEqual(['a:free']);
  });

  it('if every model is resting it still tries them', async () => {
    let calls = 0;
    const f = vi.fn(async () => {
      calls += 1;
      return calls <= 2 ? json({ error: { message: 'busy' } }, 503) : ok('back');
    });
    const p = make(f as unknown as typeof fetch, ['b:free'], 'a:free');
    await expect(p.complete([{ role: 'user', content: 'x' }], [])).rejects.toThrow();
    expect((await p.complete([{ role: 'user', content: 'x' }], [])).text).toBe('back');
  });
});

describe('rankFreeModels', () => {
  const live = [
    'thinkingmachines/inkling:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'liquid/lfm-2.5-2.6b:free',
    'google/gemma-4-31b-it:free',
    'paid/model-70b',
    'google/gemma-4-26b-a4b-it:free',
    'openrouter/free',
  ];
  it('puts the preferred first, then the other free ones, then the free router; never a paid or a tiny one', () => {
    const ranked = rankFreeModels(live, ['nvidia/nemotron-3-super-120b-a12b:free', 'google/gemma-4-31b-it:free']);
    expect(ranked).toEqual([
      'nvidia/nemotron-3-super-120b-a12b:free',
      'google/gemma-4-31b-it:free',
      'thinkingmachines/inkling:free',
      'google/gemma-4-26b-a4b-it:free',
      'openrouter/free',
    ]);
    expect(ranked).not.toContain('paid/model-70b');
    expect(ranked).not.toContain('liquid/lfm-2.5-2.6b:free');
  });
  it('is capped', () => {
    const many = Array.from({ length: 30 }, (_, i) => `vendor/model-${i + 30}b:free`);
    expect(rankFreeModels(many, [], 12)).toHaveLength(12);
  });
});

describe('BackupAiService with OpenRouter', () => {
  function memoryStore() {
    const files = new Map<string, Buffer>();
    const store = new BackupAiStore(
      'b.bin',
      { isAvailable: () => true, encrypt: (t) => Buffer.from(`enc:${t}`), decrypt: (d) => d.toString().replace(/^enc:/, '') },
      { read: (p) => files.get(p) ?? null, write: (p, d) => void files.set(p, d), remove: (p) => void files.delete(p) },
    );
    return { store, files };
  }
  const listed = ['nvidia/nemotron-3-super-120b-a12b:free', 'google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free', 'openrouter/free'];

  it('saves the best free model and every other free tool-capable one as fallbacks', async () => {
    const { store } = memoryStore();
    const applied: Array<BackupAiConfig | null> = [];
    const svc = new BackupAiService({
      store,
      env: {},
      check: async () => ({ verdict: 'valid', models: [...listed, 'paid/x'], toolModels: listed }),
      apply: (cs) => void applied.push(cs[0] ?? null),
    });
    const r = await svc.set({ provider: 'openrouter', key: 'sk-or-v1-0123456789abcdef0123456789abcdef' });
    expect(r.ok).toBe(true);
    expect(r.status.model).toBe('nvidia/nemotron-3-super-120b-a12b:free');
    expect(r.status.extraModels).toBe(3);
    expect(applied[0]?.fallbackModels).toEqual(['google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free', 'openrouter/free']);
  });

  it('on start it re-reads the list: new free models are added and a retired first choice is replaced', async () => {
    const { store, files } = memoryStore();
    const first = new BackupAiService({
      store,
      env: {},
      check: async () => ({ verdict: 'valid', models: ['old/gone-120b:free'], toolModels: ['old/gone-120b:free'] }),
      apply: () => undefined,
    });
    await first.set({ provider: 'openrouter', key: 'sk-or-v1-0123456789abcdef0123456789abcdef', model: 'old/gone-120b:free' });
    expect(files.size).toBe(1);

    const applied: Array<BackupAiConfig | null> = [];
    const second = new BackupAiService({
      store,
      env: {},
      check: async () => ({ verdict: 'valid', models: listed, toolModels: listed }),
      apply: (cs) => void applied.push(cs[0] ?? null),
    });
    second.start();
    await second.refreshModels();
    const last = applied.at(-1);
    expect(last?.model).toBe('nvidia/nemotron-3-super-120b-a12b:free');
    expect(last?.fallbackModels).toEqual(['google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free', 'openrouter/free']);
    expect(second.status().extraModels).toBe(3);
  });

  it('a failed refresh (offline) leaves what was saved in use', async () => {
    const { store } = memoryStore();
    const seed = new BackupAiService({
      store,
      env: {},
      check: async () => ({ verdict: 'valid', models: listed, toolModels: listed }),
      apply: () => undefined,
    });
    await seed.set({ provider: 'openrouter', key: 'sk-or-v1-0123456789abcdef0123456789abcdef' });
    const applied: Array<BackupAiConfig | null> = [];
    const again = new BackupAiService({ store, env: {}, check: async () => ({ verdict: 'unreachable', models: [] }), apply: (cs) => void applied.push(cs[0] ?? null) });
    again.start();
    await again.refreshModels();
    expect(applied).toHaveLength(1);
    expect(applied[0]?.model).toBe('nvidia/nemotron-3-super-120b-a12b:free');
  });
});
