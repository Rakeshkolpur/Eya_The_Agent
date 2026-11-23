import { describe, it, expect, vi } from 'vitest';
import { failureOf, restFor } from '../src/main/providers/ai/failure';
import { AIHttpError, OpenAICompatibleProvider, probeBackupModel } from '../src/main/providers/ai/OpenAICompatibleProvider';
import { AllProvidersLimitedError, ChainedAIProvider } from '../src/main/providers/ai/ChainedAIProvider';
import { BackupAiService, BackupAiStore } from '../src/main/config/backupAi';
import type { ProbeVerdict } from '../src/main/config/backupAi';
import { describeAIFailure } from '../src/main/agent/AgentEngine';
import { describeRoute, routeBadge } from '../src/shared/aiRoute';
import type { AIProvider } from '../src/main/providers/ai/AIProvider';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const NO_CREDIT = { error: { message: 'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.', type: 'insufficient_quota', code: 'insufficient_quota' } };
const bodyOf = (init: unknown): Record<string, unknown> => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;

describe('an account with no credit is not a rate limit', () => {
  it('is its own kind of failure, for OpenAI, DeepSeek and the others', () => {
    for (const message of [
      'openai http 429: {"error":{"message":"You have no credits remaining.","type":"insufficient_quota"}}',
      'deepseek http 402: {"error":{"message":"Insufficient Balance"}}',
      'openai has no credit left (429)',
    ]) {
      expect(failureOf(new AIHttpError(429, message)).kind, message).toBe('credit');
    }
    expect(failureOf(new AIHttpError(429, 'Rate limit reached for requests per minute')).kind).toBe('rate');
    // Gemini's own wording for its limits must not be taken for an empty account.
    const geminiLimit = 'gemini http 429: You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits';
    expect(failureOf(new AIHttpError(429, geminiLimit)).kind).toBe('rate');
    // Looked at again within a few minutes: someone who has just added credit is waiting for it to work.
    expect(restFor({ kind: 'credit' })).toBe(3 * 60_000);
  });

  it('a spent account stops the walk through its models at once, with a plain message', async () => {
    const asked: string[] = [];
    const f = vi.fn(async (_u: unknown, init: unknown) => {
      asked.push(String(bodyOf(init)['model']));
      return json(NO_CREDIT, 429);
    });
    const p = new OpenAICompatibleProvider({ label: 'openai', baseUrl: 'https://x/v1', apiKey: 'k'.repeat(20), model: 'a', fallbackModels: ['b', 'c', 'd'], fetchFn: f as unknown as typeof fetch });
    const err = (await p.complete([{ role: 'user', content: 'x' }], []).catch((e: unknown) => e)) as AIHttpError;
    expect(asked).toEqual(['a']); // not five identical refusals
    expect(err.message).toBe('openai has no credit left (429)');
    expect(failureOf(err).kind).toBe('credit');
  });

  it('OpenRouter\'s 402 for one paid model is still only about that model', async () => {
    const asked: string[] = [];
    const f = vi.fn(async (_u: unknown, init: unknown) => {
      const m = String(bodyOf(init)['model']);
      asked.push(m);
      return m === 'a:free' ? json({ error: { message: 'Insufficient credits' } }, 402) : json({ choices: [{ message: { content: 'fine' } }] });
    });
    const p = new OpenAICompatibleProvider({ label: 'openrouter', baseUrl: 'https://x/v1', apiKey: 'k'.repeat(20), model: 'a:free', fallbackModels: ['b:free'], fetchFn: f as unknown as typeof fetch });
    expect((await p.complete([{ role: 'user', content: 'x' }], [])).text).toBe('fine');
    expect(asked).toEqual(['a:free', 'b:free']);
  });
});

describe('the chain says which AI has no credit, and moves on', () => {
  const failing = (name: string, error: Error): AIProvider => ({ name, isReady: () => true, complete: async () => Promise.reject(error) });

  it('when everything is out, the person is told that adding credit is what fixes the one with none', async () => {
    const chain = new ChainedAIProvider([
      failing('gemini', new AIHttpError(429, 'gemini daily quota exhausted (429)', undefined, true)),
      failing('openai', new AIHttpError(429, 'openai has no credit left (429)', undefined, true)),
    ]);
    const err = (await chain.complete([{ role: 'user', content: 'x' }], []).catch((e: unknown) => e)) as AllProvidersLimitedError;
    expect(err).toBeInstanceOf(AllProvidersLimitedError);
    expect(err.noCredit).toEqual(['openai']);
    const said = describeAIFailure(err, new Date('2026-10-21T12:00:00Z'));
    expect(said).toMatch(/OpenAI has no credit left/);
    expect(said).toMatch(/add credit/);
  });

  it('a provider with no credit is passed over and named so in the badge and the list', () => {
    const now = 1_000_000;
    const route = describeRoute({
      entries: [
        { name: 'openai', ready: true, model: 'gpt-4.1-mini', restingUntil: now + 60_000, restKind: 'credit' },
        { name: 'gemini', ready: true, model: 'gemini-3.8-flash' },
      ],
      geminiKey: true,
      backups: [{ id: 'openai', label: 'OpenAI', model: 'gpt-4.1-mini', models: ['gpt-4.1-mini'] }],
      prefer: 'backup',
      now,
    });
    expect(route.using?.role).toBe('gemini');
    expect(route.passedOver).toEqual([{ label: 'OpenAI', why: 'credit' }]);

    // With ChatGPT chosen first and out of credit, the badge shows who is answering instead and why ChatGPT was passed over.
    const second = describeRoute({
      entries: [
        { name: 'openai', ready: true, model: 'gpt-4.1-mini', restingUntil: now + 60_000, restKind: 'credit' },
        { name: 'openrouter', ready: true, model: 'nvidia/nemotron-3-super-120b-a12b:free' },
      ],
      geminiKey: false,
      backups: [
        { id: 'openai', label: 'OpenAI', model: 'gpt-4.1-mini', models: ['gpt-4.1-mini'] },
        { id: 'openrouter', label: 'OpenRouter', model: 'nvidia/nemotron-3-super-120b-a12b:free', models: ['nvidia/nemotron-3-super-120b-a12b:free'] },
      ],
      prefer: 'backup',
      now,
    });
    expect(second.using?.label).toBe('OpenRouter');
    expect(routeBadge(second).sub).toBe('OpenAI has no credit');
  });
});

describe('testing and adding a key on an account with no credit', () => {
  it('the probe tells "no credit" from a real rate limit', async () => {
    const empty = vi.fn(async () => json(NO_CREDIT, 429));
    expect(await probeBackupModel('https://api.openai.com/v1', 'k', 'gpt-4.1-mini', empty as unknown as typeof fetch)).toBe('nocredit');
    const busy = vi.fn(async () => json({ error: { message: 'Rate limit reached for requests per minute' } }, 429));
    expect(await probeBackupModel('https://api.openai.com/v1', 'k', 'gpt-4.1-mini', busy as unknown as typeof fetch)).toBe('ok');
  });

  function service(probe: ProbeVerdict) {
    const files = new Map<string, Buffer>();
    const store = new BackupAiStore('/x/b.bin', { isAvailable: () => true, encrypt: (t) => Buffer.from(t), decrypt: (d) => d.toString() }, { read: (p) => files.get(p) ?? null, write: (p, d) => void files.set(p, d), remove: (p) => void files.delete(p) });
    return new BackupAiService({ store, env: {}, check: async () => ({ verdict: 'valid', models: ['gpt-4.1-mini', 'gpt-4o-mini'] }), probe: async () => probe, apply: () => undefined });
  }
  const KEY = 'sk-proj-0123456789abcdefABCDEF0123456789';

  it('the key is saved (it is a good key) and the empty account is said plainly', async () => {
    const svc = service('nocredit');
    const r = await svc.set({ provider: 'openai', key: KEY });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/no credit left/);
    expect(r.message).toMatch(/platform\.openai\.com/);
    expect(svc.keyFor('openai')).toBe(KEY);
  });

  it('Test says it does not work, and why, instead of "works"', async () => {
    const svc = service('ok');
    await svc.set({ provider: 'openai', key: KEY });
    const later = new BackupAiService({
      store: (svc as unknown as { deps: { store: BackupAiStore } }).deps.store,
      env: {},
      check: async () => ({ verdict: 'valid', models: [] }),
      probe: async () => 'nocredit',
      apply: () => undefined,
    });
    later.start();
    const r = await later.test('openai');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/accepted the key, but the account has no credit left/);
  });
});
