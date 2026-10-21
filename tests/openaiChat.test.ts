import { describe, it, expect, vi } from 'vitest';
import { BackupAiService, BackupAiStore, chooseModel, rankOpenAIChatModels } from '../src/main/config/backupAi';
import type { BackupAiConfig, ProbeVerdict } from '../src/main/config/backupAi';
import { OpenAICompatibleProvider, probeBackupModel } from '../src/main/providers/ai/OpenAICompatibleProvider';
import { backupPreset } from '../src/shared/backupAi';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (text: string): Response => json({ choices: [{ message: { content: text } }] });
const bodyOf = (init: unknown): Record<string, unknown> => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;

/** What an OpenAI account lists under one key: chat models, dated copies, audio, images, embeddings, code models. */
const ACCOUNT = [
  'gpt-4o',
  'gpt-4o-2024-08-06',
  'gpt-4o-mini',
  'gpt-4o-mini-2024-07-18',
  'gpt-4o-audio-preview',
  'gpt-4o-realtime-preview',
  'gpt-4o-mini-tts',
  'gpt-4o-transcribe',
  'gpt-4o-search-preview',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5-codex',
  'gpt-image-1',
  'gpt-3.5-turbo',
  'text-embedding-3-small',
  'tts-1',
  'whisper-1',
  'dall-e-3',
  'o3',
];

describe('choosing ChatGPT models from an account\'s list', () => {
  it('keeps only chat models fit for a spoken assistant: no dated copies, audio, image, search, code, nano or old models', () => {
    const ranked = rankOpenAIChatModels(ACCOUNT, backupPreset('openai').models);
    for (const bad of ['gpt-4o-2024-08-06', 'gpt-4o-audio-preview', 'gpt-4o-mini-tts', 'gpt-4o-transcribe', 'gpt-4o-search-preview', 'gpt-4.1-nano', 'gpt-5-nano', 'gpt-5-codex', 'gpt-image-1', 'gpt-3.5-turbo', 'o3', 'tts-1']) {
      expect(ranked, bad).not.toContain(bad);
    }
    expect(ranked).toEqual(expect.arrayContaining(['gpt-4.1-mini', 'gpt-4o-mini', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'gpt-5']));
  });

  it('puts the quick tool-following models first, in the order this app prefers, whatever the account lists first', () => {
    const ranked = rankOpenAIChatModels([...ACCOUNT].reverse(), backupPreset('openai').models);
    expect(ranked.slice(0, 3)).toEqual(['gpt-4.1-mini', 'gpt-4o-mini', 'gpt-5-mini']);
  });

  it('with none of the preferred ones, takes the newest by version, the mini before the full model', () => {
    const ranked = rankOpenAIChatModels(['gpt-9', 'gpt-9-mini', 'gpt-8.5', 'gpt-8.5-mini', 'gpt-7'], backupPreset('openai').models);
    expect(ranked).toEqual(['gpt-9-mini', 'gpt-9', 'gpt-8.5-mini', 'gpt-8.5', 'gpt-7']);
  });

  it('chooseModel gives OpenAI the best of the account, and honours a model the person typed', () => {
    expect(chooseModel('openai', undefined, ACCOUNT)).toBe('gpt-4.1-mini');
    expect(chooseModel('openai', undefined, ['gpt-5', 'gpt-5-mini', 'gpt-image-1'])).toBe('gpt-5-mini');
    expect(chooseModel('openai', 'gpt-5', ACCOUNT)).toBe('gpt-5');
  });
});

describe('saving an OpenAI key', () => {
  const KEY = 'sk-proj-0123456789abcdefABCDEF0123456789';
  function service(probe: (m: string) => ProbeVerdict = () => 'ok') {
    const files = new Map<string, Buffer>();
    const store = new BackupAiStore(
      '/x/backup.bin',
      { isAvailable: () => true, encrypt: (t) => Buffer.from(t), decrypt: (d) => d.toString() },
      { read: (p) => files.get(p) ?? null, write: (p, d) => void files.set(p, d), remove: (p) => void files.delete(p) },
    );
    const applied: BackupAiConfig[][] = [];
    const probed: string[] = [];
    const svc = new BackupAiService({
      store,
      env: {},
      check: async () => ({ verdict: 'valid', models: ACCOUNT }),
      probe: async (_u, _k, m) => {
        probed.push(m);
        return probe(m);
      },
      apply: (c) => void applied.push([...c]),
    });
    return { svc, probed, applied };
  }

  it('uses the quick model first, keeps the other chat models to choose from, and hands the key only to the main process', async () => {
    const { svc, probed } = service();
    const r = await svc.set({ provider: 'openai', key: KEY });
    expect(r.ok).toBe(true);
    expect(probed).toEqual(['gpt-4.1-mini']);
    const entry = r.status.entries[0];
    expect(entry?.id).toBe('openai');
    expect(entry?.model).toBe('gpt-4.1-mini');
    expect(entry?.models).toEqual(expect.arrayContaining(['gpt-4o-mini', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o']));
    expect(entry?.models).not.toContain('gpt-image-1');
    expect(JSON.stringify(r)).not.toContain(KEY);
    // the voice reads the key from the service (main process); nothing else can
    expect(svc.keyFor('openai')).toBe(KEY);
    expect(svc.keyFor('groq')).toBeNull();
  });

  it('a model the key may not use (403) is passed over for the next one', async () => {
    const { svc } = service((m) => (m === 'gpt-4.1-mini' ? 'forbidden' : 'ok'));
    const r = await svc.set({ provider: 'openai', key: KEY });
    expect(r.ok).toBe(true);
    expect(r.status.entries[0]?.model).toBe('gpt-4o-mini');
  });
});

describe('OpenAI\'s newer models take different parameters', () => {
  const make = (fetchFn: typeof fetch, model = 'gpt-5-mini'): OpenAICompatibleProvider =>
    new OpenAICompatibleProvider({ label: 'openai', baseUrl: 'https://x/v1', apiKey: 'k'.repeat(20), model, fetchFn });

  it('learns "max_tokens" and a fixed temperature from the answer, retries at once, and sends the right shape from then on', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const f = vi.fn(async (_u: unknown, init: unknown) => {
      const b = bodyOf(init);
      seen.push(b);
      if ('max_tokens' in b) return json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: 'invalid_request_error' } }, 400);
      if ('temperature' in b) return json({ error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported." } }, 400);
      return ok('hello');
    });
    const p = make(f as unknown as typeof fetch);
    expect((await p.complete([{ role: 'user', content: 'x' }], [])).text).toBe('hello');
    expect(seen).toHaveLength(3); // the first shape, then without max_tokens, then without the temperature
    expect(seen[2]).not.toHaveProperty('max_tokens');
    expect(seen[2]).not.toHaveProperty('temperature');
    expect(seen[2]?.['max_completion_tokens']).toBeGreaterThanOrEqual(1024);
    seen.length = 0;
    expect((await p.complete([{ role: 'user', content: 'again' }], [])).text).toBe('hello');
    expect(seen).toHaveLength(1); // learned: no second round of errors
  });

  it('what is learned about one model is not applied to another', async () => {
    const seen: Array<{ model: string; hasMax: boolean }> = [];
    const f = vi.fn(async (_u: unknown, init: unknown) => {
      const b = bodyOf(init);
      seen.push({ model: String(b['model']), hasMax: 'max_tokens' in b });
      if (b['model'] === 'gpt-5-mini' && 'max_tokens' in b) return json({ error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens'." } }, 400);
      return ok('ok');
    });
    const a = make(f as unknown as typeof fetch, 'gpt-5-mini');
    await a.complete([{ role: 'user', content: 'x' }], []);
    const b = make(f as unknown as typeof fetch, 'gpt-4.1-mini');
    await b.complete([{ role: 'user', content: 'x' }], []);
    expect(seen.at(-1)).toEqual({ model: 'gpt-4.1-mini', hasMax: true });
  });

  it('an ordinary 400 is not mistaken for a parameter it can fix', async () => {
    const f = vi.fn(async () => json({ error: { message: 'Invalid value for messages[3].role' } }, 400));
    await expect(make(f as unknown as typeof fetch).complete([{ role: 'user', content: 'x' }], [])).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('the key probe does not take those parameters for a missing model', async () => {
    const f = vi.fn(async (_u: unknown, init: unknown) => {
      const b = bodyOf(init);
      if ('max_tokens' in b) return json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model." } }, 400);
      return ok('OK');
    });
    expect(await probeBackupModel('https://x/v1', 'k', 'gpt-5-mini', f as unknown as typeof fetch)).toBe('ok');
    const missing = vi.fn(async () => json({ error: { message: 'The model `gpt-9` does not exist' } }, 400));
    expect(await probeBackupModel('https://x/v1', 'k', 'gpt-9', missing as unknown as typeof fetch)).toBe('missing');
  });
});
