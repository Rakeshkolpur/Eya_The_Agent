import { describe, it, expect, vi } from 'vitest';
import {
  AIHttpError,
  OpenAICompatibleProvider,
  checkBackupKey,
  parseWaitMs,
  toOpenAIMessages,
} from '../src/main/providers/ai/OpenAICompatibleProvider';
import { AllProvidersLimitedError, ChainedAIProvider } from '../src/main/providers/ai/ChainedAIProvider';
import type { ChainState, ChainStore } from '../src/main/providers/ai/ChainedAIProvider';
import { SwitchableAIProvider } from '../src/main/providers/ai/SwitchableAIProvider';
import { NotConfiguredError, failureOf, restFor } from '../src/main/providers/ai/failure';
import { GeminiAIProvider } from '../src/main/providers/ai/GeminiAIProvider';
import type { AICompletion, AIProvider, CompleteOptions } from '../src/main/providers/ai/AIProvider';
import { BackupAiService, BackupAiStore, chooseModel, isAcceptableBaseUrl } from '../src/main/config/backupAi';
import type { BackupAiConfig } from '../src/main/config/backupAi';
import { allLimitedMessage, limitMessage } from '../src/shared/quotaReset';
import { providerFromKey } from '../src/shared/backupAi';
import { describeAIFailure } from '../src/main/agent/AgentEngine';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('OpenAICompatibleProvider', () => {
  const make = (fetchFn: typeof fetch): OpenAICompatibleProvider =>
    new OpenAICompatibleProvider({ label: 'groq', baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-test-0123456789abcdef', model: 'm1', fetchFn });

  it('sends the chat format with tools and parses text and tool calls', async () => {
    const fetchFn = vi.fn(async () =>
      json({
        choices: [
          {
            message: {
              content: 'Opening it.',
              tool_calls: [{ id: 'abc', type: 'function', function: { name: 'open_application', arguments: '{"name":"notepad"}' } }],
            },
          },
        ],
        usage: { total_tokens: 321 },
      }),
    );
    const out = await make(fetchFn as unknown as typeof fetch).complete(
      [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'open notepad' },
      ],
      [{ name: 'open_application', description: 'open', parameters: { type: 'object', properties: { name: { type: 'string' } } } }],
    );
    expect(out.text).toBe('Opening it.');
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]).toMatchObject({ id: 'abc', name: 'open_application', args: { name: 'notepad' } });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test-0123456789abcdef');
    const sent = JSON.parse(String(init.body)) as { model: string; tools: Array<{ function: { name: string } }>; tool_choice: string };
    expect(sent.model).toBe('m1');
    expect(sent.tools[0]?.function.name).toBe('open_application');
    expect(sent.tool_choice).toBe('auto');
  });

  it('omits tools when there are none, and tolerates null content and bad argument JSON', async () => {
    const fetchFn = vi.fn(async () =>
      json({ choices: [{ message: { content: null, tool_calls: [{ id: 'x', function: { name: 'find_file', arguments: '{not json' } }] } }] }),
    );
    const out = await make(fetchFn as unknown as typeof fetch).complete([{ role: 'user', content: 'hi' }], []);
    const body = JSON.parse(String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body['tools']).toBeUndefined();
    expect(out.text).toBe('');
    expect(out.toolCalls[0]).toMatchObject({ name: 'find_file', args: {} });
  });

  it('turns a 429 with a per-day cap into a daily-quota error with no short wait', async () => {
    const fetchFn = vi.fn(async () =>
      json({ error: { message: 'Rate limit reached for model on tokens per day (TPD): Limit 100000' } }, 429, { 'retry-after': '37' }),
    );
    const err = (await make(fetchFn as unknown as typeof fetch)
      .complete([{ role: 'user', content: 'hi' }], [])
      .catch((e: unknown) => e)) as AIHttpError;
    expect(err).toBeInstanceOf(AIHttpError);
    expect(err.status).toBe(429);
    expect(err.dailyQuota).toBe(true);
    expect(err.message).toMatch(/daily quota/);
    expect(failureOf(err).kind).toBe('daily');
  });

  it('a per-minute 429 carries the wait the service named', async () => {
    const fetchFn = vi.fn(async () => json({ error: { message: 'Rate limit reached (RPM)' } }, 429, { 'retry-after': '12' }));
    const err = (await make(fetchFn as unknown as typeof fetch)
      .complete([{ role: 'user', content: 'hi' }], [])
      .catch((e: unknown) => e)) as AIHttpError;
    expect(err.dailyQuota).toBe(false);
    expect(err.retryAfterMs).toBe(12_000);
    expect(failureOf(err)).toEqual({ kind: 'rate', retryAfterMs: 12_000 });
  });

  it('tries once more when the service rejects a malformed tool call, then gives up', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return json({ error: { message: 'Failed to call a function', code: 'tool_use_failed' } }, 400);
      return json({ choices: [{ message: { content: 'ok' } }] });
    });
    expect((await make(fetchFn as unknown as typeof fetch).complete([{ role: 'user', content: 'x' }], [])).text).toBe('ok');
    expect(calls).toBe(2);

    let always = 0;
    const stuck = vi.fn(async () => {
      always += 1;
      return json({ error: { message: 'tool_use_failed' } }, 400);
    });
    await expect(make(stuck as unknown as typeof fetch).complete([{ role: 'user', content: 'x' }], [])).rejects.toThrow(/400/);
    expect(always).toBe(2);
  });

  it('is ready only with a key and a model', () => {
    expect(new OpenAICompatibleProvider({ label: 'x', baseUrl: 'https://a', apiKey: '', model: 'm' }).isReady()).toBe(false);
    expect(new OpenAICompatibleProvider({ label: 'x', baseUrl: 'https://a', apiKey: 'k', model: '' }).isReady()).toBe(false);
    expect(new OpenAICompatibleProvider({ label: 'x', baseUrl: 'https://a', apiKey: 'k', model: 'm' }).isReady()).toBe(true);
  });
});

describe('toOpenAIMessages', () => {
  it('maps a whole tool round, renaming ids to nine letters and digits that match', () => {
    const out = toOpenAIMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'find it' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'gc_0_1699999999999', name: 'find_file', args: { name: 'a' } }] },
      { role: 'tool', name: 'find_file', toolCallId: 'gc_0_1699999999999', content: '{"ok":true}' },
      { role: 'assistant', content: 'Found it.' },
    ]) as Array<Record<string, unknown>>;
    expect(out.map((m) => m['role'])).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    const call = (out[2]?.['tool_calls'] as Array<{ id: string; function: { arguments: string } }>)[0];
    expect(call?.id).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(call?.function.arguments).toBe('{"name":"a"}');
    expect(out[3]?.['tool_call_id']).toBe(call?.id);
    expect(out[2]?.['content']).toBeNull();
  });

  it('drops an empty assistant turn, and finds the call a tool result belongs to by name when it has no id', () => {
    const out = toOpenAIMessages([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '  ' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'k1', name: 'read_file', args: {} }] },
      { role: 'tool', name: 'read_file', content: 'hello' },
    ]) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(3);
    const id = (out[1]?.['tool_calls'] as Array<{ id: string }>)[0]?.id;
    expect(out[2]?.['tool_call_id']).toBe(id);
  });
});

describe('parseWaitMs', () => {
  it('reads seconds, minute-second strings and milliseconds', () => {
    expect(parseWaitMs('37')).toBe(37_000);
    expect(parseWaitMs('2.5')).toBe(2500);
    expect(parseWaitMs('1m30.5s')).toBe(90_500);
    expect(parseWaitMs('7.66s')).toBe(7660);
    expect(parseWaitMs('250ms')).toBe(250);
    expect(parseWaitMs('')).toBeUndefined();
    expect(parseWaitMs(null)).toBeUndefined();
    expect(parseWaitMs('soon')).toBeUndefined();
  });
});

describe('checkBackupKey for OpenRouter', () => {
  it('asks /key as well, because its model list is public, and reports which models can use tools', async () => {
    const urls: string[] = [];
    const f = vi.fn(async (url: unknown) => {
      urls.push(String(url));
      if (String(url).endsWith('/key')) return json({ data: { label: 'k' } });
      return json({
        data: [
          { id: 'a:free', supported_parameters: ['tools', 'temperature'] },
          { id: 'b:free', supported_parameters: ['temperature'] },
        ],
      });
    });
    const r = await checkBackupKey('https://openrouter.ai/api/v1', 'k', f as unknown as typeof fetch);
    expect(urls).toEqual(['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/models']);
    expect(r).toEqual({ verdict: 'valid', models: ['a:free', 'b:free'], toolModels: ['a:free'] });
  });
  it('a wrong key is caught by /key even though /models would answer', async () => {
    const f = vi.fn(async (url: unknown) => (String(url).endsWith('/key') ? json({}, 401) : json({ data: [{ id: 'x' }] })));
    expect((await checkBackupKey('https://openrouter.ai/api/v1', 'bad', f as unknown as typeof fetch)).verdict).toBe('invalid');
  });
});

describe('checkBackupKey', () => {
  it('says valid with the models the service offers', async () => {
    const f = vi.fn(async () => json({ data: [{ id: 'a' }, { id: 'b' }] }));
    expect(await checkBackupKey('https://x/v1/', 'k', f as unknown as typeof fetch)).toEqual({ verdict: 'valid', models: ['a', 'b'] });
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://x/v1/models');
  });
  it('401 is invalid; a server error or no network says nothing about the key', async () => {
    expect((await checkBackupKey('https://x', 'k', (async () => json({}, 401)) as unknown as typeof fetch)).verdict).toBe('invalid');
    expect((await checkBackupKey('https://x', 'k', (async () => json({}, 500)) as unknown as typeof fetch)).verdict).toBe('unreachable');
    expect((await checkBackupKey('https://x', 'k', (async () => { throw new Error('down'); }) as unknown as typeof fetch)).verdict).toBe('unreachable');
  });
});

describe('failureOf and restFor', () => {
  it('classifies the errors every provider throws', () => {
    expect(failureOf(new Error('gemini daily quota exhausted (429) for gemini-3.8-flash')).kind).toBe('daily');
    expect(failureOf(new Error('gemini http 429: rate limited')).kind).toBe('rate');
    expect(failureOf(new Error('gemini http 503: high demand')).kind).toBe('overloaded');
    expect(failureOf(new Error('groq http 401: invalid api key')).kind).toBe('auth');
    expect(failureOf(new Error('fetch failed')).kind).toBe('other');
  });
  it('rests a spent daily allowance for up to half an hour, a short limit for what the service said', () => {
    expect(restFor({ kind: 'daily' })).toBe(30 * 60_000);
    expect(restFor({ kind: 'daily', retryAfterMs: 120_000 })).toBe(120_000);
    expect(restFor({ kind: 'rate', retryAfterMs: 12_000 })).toBe(12_000);
    expect(restFor({ kind: 'rate' })).toBe(60_000);
    expect(restFor({ kind: 'other' })).toBe(30_000);
  });
});

// ---- the chain --------------------------------------------------------------------------------------------------------------------------

class Scripted implements AIProvider {
  readonly calls: Array<CompleteOptions | undefined> = [];
  constructor(
    readonly name: string,
    private readonly outcomes: Array<AICompletion | Error>,
    private ready = true,
  ) {}
  isReady(): boolean {
    return this.ready;
  }
  async complete(_m: unknown, _t: unknown, options?: CompleteOptions): Promise<AICompletion> {
    this.calls.push(options);
    const next = this.outcomes.length > 1 ? this.outcomes.shift() : this.outcomes[0];
    if (next === undefined) throw new Error('no outcome');
    if (next instanceof Error) throw next;
    return next;
  }
}

const said = (text: string): AICompletion => ({ text, toolCalls: [] });
const dailyLimit = (who: string): AIHttpError => new AIHttpError(429, `${who} daily quota exhausted (429)`, undefined, true);

describe('ChainedAIProvider: resting, fail-fast and honest limits', () => {
  it('goes straight to the backup for the next requests once Gemini is out, and tries Gemini again after its rest', async () => {
    let t = 1_000_000;
    const gemini = new Scripted('gemini', [dailyLimit('gemini'), said('from gemini')]);
    const backup = new Scripted('groq', [said('from groq')]);
    const chain = new ChainedAIProvider([gemini, backup], { now: () => t });

    expect((await chain.complete([], [])).text).toBe('from groq');
    expect(gemini.calls).toHaveLength(1);
    // the second request does not even ask Gemini
    expect((await chain.complete([], [])).text).toBe('from groq');
    expect(gemini.calls).toHaveLength(1);
    expect(backup.calls).toHaveLength(2);
    // after the rest (30 minutes for a spent daily allowance) Gemini is asked again, and now answers
    t += 31 * 60_000;
    expect((await chain.complete([], [])).text).toBe('from gemini');
    expect(gemini.calls).toHaveLength(2);
  });

  it('asks the primary to give up quickly only while a later provider is ready', async () => {
    const gemini = new Scripted('gemini', [said('ok')]);
    const ready = new Scripted('groq', [said('b')], true);
    await new ChainedAIProvider([gemini, ready]).complete([], []);
    expect(gemini.calls[0]).toEqual({ failFast: true });

    const alone = new Scripted('gemini', [said('ok')]);
    const notReady = new Scripted('ollama', [said('b')], false);
    await new ChainedAIProvider([alone, notReady]).complete([], []);
    expect(alone.calls[0]).toBeUndefined();
  });

  it('says both are out, with the soonest return, when Gemini and the backup are both limited', async () => {
    const gemini = new Scripted('gemini', [new AIHttpError(429, 'gemini daily quota exhausted (429)', 20_000_000, true)]);
    const backup = new Scripted('groq', [dailyLimit('groq')]);
    const local = new Scripted('ollama', [new Error('fetch failed')]);
    const err = (await new ChainedAIProvider([gemini, backup, local]).complete([], []).catch((e: unknown) => e)) as AllProvidersLimitedError;
    expect(err).toBeInstanceOf(AllProvidersLimitedError);
    expect(err.providers).toEqual(['gemini', 'groq']);
    expect(err.dailyQuota).toBe(true);
    expect(err.retryAfterMs).toBe(20_000_000);
  });

  it('a backup that is limited on its own is named, not blamed on Gemini', async () => {
    const slot = new SwitchableAIProvider();
    slot.set(new Scripted('groq', [dailyLimit('groq')]));
    const err = (await new ChainedAIProvider([slot]).complete([], []).catch((e: unknown) => e)) as AllProvidersLimitedError;
    expect(err).toBeInstanceOf(AllProvidersLimitedError);
    expect(err.providers).toEqual(['groq']);
    expect(describeAIFailure(err, new Date('2026-10-02T16:34:04Z'))).toContain('Groq has used up its free allowance');
  });

  it('counts a provider that is resting from a limit as out, when the other one runs out too', async () => {
    const t = 5_000_000;
    const gemini = new Scripted('gemini', [dailyLimit('gemini')]);
    const backup = new Scripted('groq', [said('ok'), dailyLimit('groq')]);
    const chain = new ChainedAIProvider([gemini, backup], { now: () => t });
    await chain.complete([], []); // gemini out, groq answers
    const err = (await chain.complete([], []).catch((e: unknown) => e)) as AllProvidersLimitedError; // gemini skipped (resting), groq now out
    expect(err).toBeInstanceOf(AllProvidersLimitedError);
    expect([...err.providers].sort()).toEqual(['gemini', 'groq']);
    expect(err.dailyQuota).toBe(true);
  });

  it("still reports the primary's own error when only it was limited (no backup set up)", async () => {
    const gemini = new Scripted('gemini', [new Error('gemini http 429: quota exceeded')]);
    const slot = new SwitchableAIProvider();
    const err = (await new ChainedAIProvider([gemini, slot]).complete([], []).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/429/);
    expect(err).not.toBeInstanceOf(AllProvidersLimitedError);
  });

  it('tries everything in order when every provider is resting', async () => {
    const a = new Scripted('a', [new Error('http 503 overloaded'), said('a is back')]);
    const b = new Scripted('b', [new Error('http 503 overloaded')]);
    const chain = new ChainedAIProvider([a, b]);
    await expect(chain.complete([], [])).rejects.toThrow();
    expect((await chain.complete([], [])).text).toBe('a is back');
  });

  it('counts requests per provider and when the allowance ran out', async () => {
    const gemini = new Scripted('gemini', [said('1'), said('2'), dailyLimit('gemini')]);
    const backup = new Scripted('groq', [said('b')]);
    const chain = new ChainedAIProvider([gemini, backup]);
    await chain.complete([], []);
    await chain.complete([], []);
    await chain.complete([], []);
    const s = chain.summary();
    expect(s.providers.find((p) => p.name === 'gemini')).toMatchObject({ requests: 2, limitedAfter: 2 });
    expect(s.providers.find((p) => p.name === 'groq')?.requests).toBe(1);
    expect(s.providers.find((p) => p.name === 'gemini')?.restingUntil).toBeGreaterThan(Date.now());
  });

  it('remembers a spent allowance across a restart (same UTC day only)', async () => {
    let saved: ChainState | null = null;
    const store: ChainStore = { load: () => saved, save: (s) => void (saved = s) };
    const t = Date.UTC(2026, 9, 10, 12, 0, 0);
    const first = new ChainedAIProvider([new Scripted('gemini', [dailyLimit('gemini')]), new Scripted('groq', [said('b')])], { now: () => t, store });
    await first.complete([], []);
    expect(saved).not.toBeNull();

    const gemini2 = new Scripted('gemini', [said('should not be asked')]);
    const second = new ChainedAIProvider([gemini2, new Scripted('groq', [said('b')])], { now: () => t + 60_000, store });
    expect((await second.complete([], [])).text).toBe('b');
    expect(gemini2.calls).toHaveLength(0);

    // the next UTC day is a fresh allowance
    const gemini3 = new Scripted('gemini', [said('fresh day')]);
    const third = new ChainedAIProvider([gemini3, new Scripted('groq', [said('b')])], { now: () => t + 24 * 3_600_000, store });
    expect((await third.complete([], [])).text).toBe('fresh day');
  });

  it('an empty backup slot is skipped without counting as a failure', async () => {
    const slot = new SwitchableAIProvider();
    const local = new Scripted('ollama', [said('local')]);
    const chain = new ChainedAIProvider([slot, local]);
    expect((await chain.complete([], [])).text).toBe('local');
    await expect(slot.complete([], [])).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it('clearRests lets a freshly saved key be used immediately', async () => {
    const slot = new SwitchableAIProvider();
    slot.set(new Scripted('groq', [new AIHttpError(401, 'groq http 401: bad key')]));
    const chain = new ChainedAIProvider([slot, new Scripted('ollama', [said('local')])]);
    expect((await chain.complete([], [])).text).toBe('local');
    slot.set(new Scripted('mistral', [said('mistral works')]));
    chain.clearRests();
    expect((await chain.complete([], [])).text).toBe('mistral works');
  });
});

describe('what the user is told when everything is limited', () => {
  const now = new Date('2026-10-02T16:34:04Z');
  const IST = { timeZone: 'Asia/Kolkata', locale: 'en-IN' };
  it('names both, the time they come back, and what still works', () => {
    const said = allLimitedMessage(['Gemini', 'Groq'], { daily: true, retryAfterMs: 26_755_000 }, now, IST);
    expect(said).toContain('Gemini and Groq have both used up their free allowance for today');
    expect(said).toContain('5:30');
    expect(said).toContain('Everything that does not need an AI still works');
  });
  it('describeAIFailure uses it for an AllProvidersLimitedError and keeps the old text otherwise', () => {
    const both = describeAIFailure(new AllProvidersLimitedError(['gemini', 'groq'], true), now);
    expect(both).toContain('Gemini and Groq');
    const only = describeAIFailure(new Error('gemini daily quota exhausted (429) for every model'), now);
    expect(only).toContain("today's free Gemini limit");
    expect(only).toContain('backup AI key under Settings');
  });
  it('the Gemini-only text is unchanged unless a backup is suggested', () => {
    expect(limitMessage({ daily: true, retryAfterMs: 26_755_000 }, now, IST)).toContain('or turn on billing in Google AI Studio');
  });
});

// ---- Gemini hands over quickly when another AI is ready ------------------------------------------------------------------------------

describe('GeminiAIProvider with failFast', () => {
  it('tries only the first two models and never waits a retry round', async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      seen.push(String(url));
      return json({ error: { message: 'overloaded' } }, 503);
    }) as unknown as typeof fetch;
    try {
      const p = new GeminiAIProvider({ apiKey: 'k', models: ['m1', 'm2', 'm3', 'm4'], retryDelaysMs: [400, 400] });
      const started = Date.now();
      await expect(p.complete([{ role: 'user', content: 'x' }], [], { failFast: true })).rejects.toThrow();
      expect(seen).toHaveLength(2);
      expect(Date.now() - started).toBeLessThan(300); // no 400 ms retry round
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---- the key service ------------------------------------------------------------------------------------------------------------------

function memoryStore(canSave = true): { store: BackupAiStore; files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  const store = new BackupAiStore(
    'backup-ai.bin',
    {
      isAvailable: () => canSave,
      encrypt: (text) => Buffer.from(`enc:${text}`),
      decrypt: (data) => data.toString().replace(/^enc:/, ''),
    },
    {
      read: (p) => files.get(p) ?? null,
      write: (p, d) => void files.set(p, d),
      remove: (p) => void files.delete(p),
    },
  );
  return { store, files };
}

describe('BackupAiService', () => {
  const KEY = 'gsk_abcdefghijklmnopqrstuvwxyz012345';
  function service(over: { canSave?: boolean; env?: NodeJS.ProcessEnv; verdict?: 'valid' | 'invalid' | 'unreachable'; models?: string[] } = {}) {
    const { store, files } = memoryStore(over.canSave ?? true);
    const applied: Array<BackupAiConfig | null> = [];
    const svc = new BackupAiService({
      store,
      env: over.env ?? {},
      check: async () => ({ verdict: over.verdict ?? 'valid', models: over.models ?? ['llama-3.3-70b-versatile', 'other'] }),
      apply: (cs) => void applied.push(cs[0] ?? null),
    });
    return { svc, files, applied };
  }

  it('saves a checked key encrypted, picks the best model the service offers, and puts it to work at once', async () => {
    const { svc, files, applied } = service();
    svc.start();
    expect(applied).toEqual([null]);
    const r = await svc.set({ provider: 'groq', key: ` ${KEY} ` });
    expect(r.ok).toBe(true);
    expect(r.status).toMatchObject({ configured: true, provider: 'groq', model: 'llama-3.3-70b-versatile', hint: '…2345', source: 'saved' });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(applied[1]).toMatchObject({ provider: 'groq', apiKey: KEY, baseUrl: 'https://api.groq.com/openai/v1' });
    expect([...files.values()][0]?.toString()).toMatch(/^enc:/);
  });

  it('is restored on the next start', async () => {
    const a = service();
    await a.svc.set({ provider: 'mistral', key: 'AbCdEf0123456789AbCdEf0123456789', model: 'mistral-small-latest' });
    const store = new BackupAiStore('backup-ai.bin', { isAvailable: () => true, encrypt: (t) => Buffer.from(`enc:${t}`), decrypt: (d) => d.toString().replace(/^enc:/, '') }, {
      read: (p) => a.files.get(p) ?? null,
      write: () => undefined,
      remove: () => undefined,
    });
    const applied: Array<BackupAiConfig | null> = [];
    new BackupAiService({ store, env: {}, check: async () => ({ verdict: 'valid', models: [] }), apply: (cs) => void applied.push(cs[0] ?? null) }).start();
    expect(applied[0]).toMatchObject({ provider: 'mistral', model: 'mistral-small-latest' });
  });

  it('uses the service a key belongs to when its start says so, whatever Service was selected', async () => {
    const seen: string[] = [];
    const { store } = memoryStore(true);
    const svc = new BackupAiService({
      store,
      env: {},
      check: async (baseUrl) => {
        seen.push(baseUrl);
        return { verdict: 'valid', models: ['nvidia/nemotron-3-super-120b-a12b:free'], toolModels: ['nvidia/nemotron-3-super-120b-a12b:free'] };
      },
      apply: () => undefined,
    });
    const r = await svc.set({ provider: 'mistral', key: 'sk-or-v1-0123456789abcdef0123456789abcdef' });
    expect(seen).toEqual(['https://openrouter.ai/api/v1']);
    expect(r.ok).toBe(true);
    expect(r.status.provider).toBe('openrouter');
    expect(r.message).toContain('That key is for OpenRouter, not Mistral');
  });

  it('a rejected key is reported under the service it was really tried with', async () => {
    const r = await service({ verdict: 'invalid' }).svc.set({ provider: 'mistral', key: 'sk-or-v1-0123456789abcdef0123456789abcdef' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('OpenRouter says that key is not valid');
    expect(r.message).toContain('not Mistral');
  });

  it('does not guess a service for keys with no telltale start', () => {
    expect(providerFromKey('sk-or-v1-abc')).toBe('openrouter');
    expect(providerFromKey('gsk_abc')).toBe('groq');
    expect(providerFromKey('csk-abc')).toBe('cerebras');
    expect(providerFromKey('sk-proj-abc')).toBeUndefined();
    expect(providerFromKey('AbCdEf0123456789AbCdEf0123456789')).toBeUndefined();
  });

  it('refuses a key the service rejects, a malformed key, and an unprotected save', async () => {
    expect((await service({ verdict: 'invalid' }).svc.set({ provider: 'groq', key: KEY })).ok).toBe(false);
    expect((await service().svc.set({ provider: 'groq', key: 'short' })).ok).toBe(false);
    const noCrypto = await service({ canSave: false }).svc.set({ provider: 'groq', key: KEY });
    expect(noCrypto.ok).toBe(false);
    expect(noCrypto.message).toMatch(/protect/);
    expect((await service().svc.set({ provider: 'nope', key: KEY })).ok).toBe(false);
  });

  it('saves anyway, with a note, when the service cannot be reached to check', async () => {
    const r = await service({ verdict: 'unreachable', models: [] }).svc.set({ provider: 'groq', key: KEY });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/couldn't reach/);
    expect(r.status.model).toBe('llama-3.3-70b-versatile');
  });

  it('custom needs an https address (or one on this PC) and a model', async () => {
    const { svc } = service({ models: [] });
    expect((await svc.set({ provider: 'custom', key: KEY, baseUrl: 'http://example.com/v1', model: 'm' })).ok).toBe(false);
    expect((await svc.set({ provider: 'custom', key: KEY, baseUrl: 'https://example.com/v1' })).ok).toBe(false); // no model, none offered
    const ok = await svc.set({ provider: 'custom', key: KEY, baseUrl: 'https://example.com/v1/', model: 'my-model' });
    expect(ok.ok).toBe(true);
    expect(ok.status.baseUrl).toBe('https://example.com/v1');
    const local = await service({ models: ['qwen'] }).svc.set({ provider: 'custom', key: '', baseUrl: 'http://localhost:1234/v1' });
    expect(local.ok).toBe(true);
    expect(local.status.model).toBe('qwen');
  });

  it('a key in the environment wins and cannot be removed from Settings; clear removes only the saved one', async () => {
    const env = { EYA_BACKUP_AI_KEY: KEY, EYA_BACKUP_AI_PROVIDER: 'cerebras' } as NodeJS.ProcessEnv;
    const { svc, applied } = service({ env });
    svc.start();
    expect(applied[0]).toMatchObject({ provider: 'cerebras', apiKey: KEY });
    expect(svc.status().source).toBe('env');
    expect(svc.clear().status.configured).toBe(true);

    const s2 = service();
    await s2.svc.set({ provider: 'groq', key: KEY });
    const cleared = s2.svc.clear();
    expect(cleared.status.configured).toBe(false);
    expect(s2.applied.at(-1)).toBeNull();
    expect(s2.files.size).toBe(0);
  });
});

describe('chooseModel and base URLs', () => {
  it('prefers the user\'s own, then the first preferred model on offer, then any big general model', () => {
    expect(chooseModel('groq', ' my-model ', [])).toBe('my-model');
    expect(chooseModel('groq', undefined, ['x', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile'])).toBe('llama-3.3-70b-versatile');
    // OpenRouter: only free models that can use tools, never a paid one, whatever else is listed
    const listed = ['meta-llama/llama-3.3-70b-instruct', 'google/gemma-4-31b-it:free', 'some/tiny:free', 'nvidia/nemotron-3-super-120b-a12b:free'];
    expect(chooseModel('openrouter', undefined, listed, ['google/gemma-4-31b-it:free', 'meta-llama/llama-3.3-70b-instruct'])).toBe('google/gemma-4-31b-it:free');
    expect(chooseModel('openrouter', undefined, listed)).toBe('nvidia/nemotron-3-super-120b-a12b:free');
    expect(chooseModel('openrouter', undefined, ['paid/llama-3.3-70b-instruct', 'odd/one:free'], ['odd/one:free'])).toBe('odd/one:free');
    expect(chooseModel('openrouter', undefined, ['paid/llama-3.3-70b-instruct'], ['paid/llama-3.3-70b-instruct'])).not.toBe('paid/llama-3.3-70b-instruct');
    expect(chooseModel('cerebras', undefined, ['tiny-1b', 'llama-3.1-70b-new'])).toBe('llama-3.1-70b-new');
    expect(chooseModel('groq', undefined, [])).toBe('llama-3.3-70b-versatile');
    expect(chooseModel('custom', undefined, [])).toBeNull();
  });
  it('accepts https and addresses on this PC only', () => {
    expect(isAcceptableBaseUrl('https://api.groq.com/openai/v1')).toBe(true);
    expect(isAcceptableBaseUrl('http://localhost:11434/v1')).toBe(true);
    expect(isAcceptableBaseUrl('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isAcceptableBaseUrl('http://api.example.com/v1')).toBe(false);
    expect(isAcceptableBaseUrl('ftp://x')).toBe(false);
    expect(isAcceptableBaseUrl('https://')).toBe(false);
  });
});
