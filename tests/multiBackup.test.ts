import { describe, it, expect, vi } from 'vitest';
import { BackupAiService, BackupAiStore, configId } from '../src/main/config/backupAi';
import type { BackupAiConfig, ProbeVerdict } from '../src/main/config/backupAi';
import { BACKUP_AI_PRESETS, MAX_BACKUPS, backupId, backupLabelFor, providerFromKey } from '../src/shared/backupAi';
import { checkBackupKey, probeBackupModel } from '../src/main/providers/ai/OpenAICompatibleProvider';
import { AIHttpError } from '../src/main/providers/ai/OpenAICompatibleProvider';
import { ChainedAIProvider } from '../src/main/providers/ai/ChainedAIProvider';
import { SwitchableAIProvider } from '../src/main/providers/ai/SwitchableAIProvider';
import type { AICompletion, AIProvider } from '../src/main/providers/ai/AIProvider';
import { describeRoute, routeBadge } from '../src/shared/aiRoute';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const MISTRAL_KEY = 'test_key_not_real_0123456789_abcdef';
const OR_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const SN_KEY = 'sn0123456789abcdef0123456789abcdef';
const CUSTOM_KEY = 'ck0123456789abcdef0123456789abcdef';

function makeStore(canSave = true) {
  const files = new Map<string, Buffer>();
  const store = new BackupAiStore(
    'backup-ai.bin',
    { isAvailable: () => canSave, encrypt: (t) => Buffer.from(`enc:${t}`), decrypt: (d) => d.toString().replace(/^enc:/, '') },
    { read: (p) => files.get(p) ?? null, write: (p, d) => void files.set(p, d), remove: (p) => void files.delete(p) },
  );
  return { store, files };
}

interface Opts {
  verdict?: 'valid' | 'invalid' | 'notfound' | 'unreachable';
  models?: string[];
  probe?: ProbeVerdict | ((model: string) => ProbeVerdict);
  env?: NodeJS.ProcessEnv;
  store?: BackupAiStore;
  clearRests?: () => void;
}

function service(o: Opts = {}) {
  const made = makeStore();
  const store = o.store ?? made.store;
  const applied: BackupAiConfig[][] = [];
  const probed: string[] = [];
  const svc = new BackupAiService({
    store,
    env: o.env ?? {},
    check: async () => ({ verdict: o.verdict ?? 'valid', models: o.models ?? [] }),
    ...(o.probe !== undefined
      ? {
          probe: async (_u: string, _k: string, model: string) => {
            probed.push(model);
            return typeof o.probe === 'function' ? o.probe(model) : (o.probe as ProbeVerdict);
          },
        }
      : {}),
    apply: (cs) => void applied.push([...cs]),
    ...(o.clearRests !== undefined ? { clearRests: o.clearRests } : {}),
  });
  return { svc, store, files: made.files, applied, probed };
}

describe('several backup AIs', () => {
  it('adds them in order, each with its own key, and applies them all', async () => {
    const { svc, applied } = service({ models: ['mistral-small-latest', 'llama-3.3-70b'] });
    svc.start();
    expect((await svc.set({ provider: 'mistral', key: MISTRAL_KEY })).ok).toBe(true);
    const r = await svc.set({ provider: 'cerebras', key: 'csk-0123456789abcdef0123456789abcdef' });
    expect(r.ok).toBe(true);
    expect(r.status.entries.map((e) => e.id)).toEqual(['mistral', 'cerebras']);
    expect(r.status.entries.map((e) => e.label)).toEqual(['Mistral', 'Cerebras']);
    expect(r.status.configured).toBe(true);
    expect(applied.at(-1)?.map((c) => c.provider)).toEqual(['mistral', 'cerebras']);
    expect(JSON.stringify(r)).not.toContain(MISTRAL_KEY);
    expect(r.message).toContain('backup number 2');
  });

  it('a key for a service already added replaces it instead of adding a second', async () => {
    const { svc } = service({ models: ['mistral-small-latest'] });
    await svc.set({ provider: 'mistral', key: MISTRAL_KEY });
    const r = await svc.set({ provider: 'mistral', key: 'other_test_key_not_real_9876543210_zyx' });
    expect(r.status.entries).toHaveLength(1);
    expect(r.status.entries[0]?.hint).toBe('…3210');
  });

  it('stops at the most allowed, and says so', async () => {
    const { svc } = service({ models: ['m'] });
    const providers = ['mistral', 'cerebras', 'google', 'openrouter', 'groq', 'sambanova'] as const;
    expect(providers).toHaveLength(MAX_BACKUPS);
    for (const [i, p] of providers.entries()) {
      const r = await svc.set({ provider: p, key: `${MISTRAL_KEY}${i}`, model: 'x-model' });
      expect(r.ok).toBe(true);
    }
    const seventh = await svc.set({ provider: 'deepseek', key: `${MISTRAL_KEY}9`, model: 'deepseek-chat' });
    expect(seventh.ok).toBe(false);
    expect(seventh.message).toContain(`${MAX_BACKUPS} backup AIs`);
    expect(seventh.status.entries).toHaveLength(MAX_BACKUPS);
  });

  it('removes one by id and keeps the rest, in order; and removes the file when none are left', async () => {
    const { svc, store, files } = service({ models: ['m'] });
    await svc.set({ provider: 'mistral', key: MISTRAL_KEY, model: 'a' });
    await svc.set({ provider: 'groq', key: `${MISTRAL_KEY}1`, model: 'b' });
    await svc.set({ provider: 'cerebras', key: `${MISTRAL_KEY}2`, model: 'c' });
    const r = svc.clear('groq');
    expect(r.ok).toBe(true);
    expect(r.status.entries.map((e) => e.id)).toEqual(['mistral', 'cerebras']);
    expect(store.load().map((c) => c.provider)).toEqual(['mistral', 'cerebras']);
    svc.clear();
    expect(svc.status().configured).toBe(false);
    expect(files.size).toBe(0);
  });

  it('is there again, in the same order, after a restart', async () => {
    const first = service({ models: ['m'] });
    await first.svc.set({ provider: 'mistral', key: MISTRAL_KEY, model: 'a' });
    await first.svc.set({ provider: 'groq', key: `${MISTRAL_KEY}1`, model: 'b' });
    const again = service({ store: first.store });
    again.svc.start();
    expect(again.svc.status().entries.map((e) => e.id)).toEqual(['mistral', 'groq']);
    expect(again.applied[0]?.map((c) => c.model)).toEqual(['a', 'b']);
  });

  it('still reads the one-backup file earlier versions wrote', () => {
    const { store, files } = makeStore();
    const legacy = JSON.stringify({ provider: 'openrouter', apiKey: OR_KEY, model: 'nvidia/x:free', baseUrl: 'https://openrouter.ai/api/v1' });
    files.set('backup-ai.bin', Buffer.from(`enc:${legacy}`));
    const loaded = store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ provider: 'openrouter', model: 'nvidia/x:free' });
  });

  it('use() asks that backup first, and that order is kept', async () => {
    const { svc, store } = service({ models: ['m'] });
    await svc.set({ provider: 'mistral', key: MISTRAL_KEY, model: 'mistral-small-latest' });
    await svc.set({ provider: 'groq', key: `${MISTRAL_KEY}1`, model: 'llama-3.3-70b-versatile' });
    const r = svc.use('llama-3.3-70b-versatile', 'groq');
    expect(r.ok).toBe(true);
    expect(r.status.entries.map((e) => e.id)).toEqual(['groq', 'mistral']);
    expect(r.status.provider).toBe('groq'); // the first one, in the older fields
    expect(store.load().map((c) => c.provider)).toEqual(['groq', 'mistral']);
    expect(svc.use('not-a-model', 'groq').ok).toBe(false);
    expect(svc.use('x', 'nope').ok).toBe(false);
  });

  it('two custom addresses live side by side, named by their address', async () => {
    const { svc } = service({ models: [] });
    await svc.set({ provider: 'custom', key: CUSTOM_KEY, baseUrl: 'https://api.one.example/v1', model: 'm1' });
    const r = await svc.set({ provider: 'custom', key: `${CUSTOM_KEY}x`, baseUrl: 'https://api.two.example/v1', model: 'm2' });
    expect(r.status.entries.map((e) => e.id)).toEqual(['custom-api.one.example', 'custom-api.two.example']);
    expect(r.status.entries.map((e) => e.label)).toEqual(['api.one.example', 'api.two.example']);
    expect(configId({ provider: 'custom', baseUrl: 'https://api.one.example/v1' })).toBe('custom-api.one.example');
  });

  it('an environment key is listed first and cannot be removed from Settings', async () => {
    const { svc } = service({ models: ['m'], env: { EYA_BACKUP_AI_KEY: MISTRAL_KEY, EYA_BACKUP_AI_PROVIDER: 'mistral' } });
    svc.start();
    await svc.set({ provider: 'groq', key: `${MISTRAL_KEY}1`, model: 'g' });
    expect(svc.status().entries.map((e) => [e.id, e.source])).toEqual([
      ['mistral', 'env'],
      ['groq', 'saved'],
    ]);
    expect(svc.clear('mistral').ok).toBe(false);
    svc.clear();
    expect(svc.status().entries.map((e) => e.id)).toEqual(['mistral']);
  });
});

describe('checking a key before it is saved', () => {
  it('a service whose model list is public gets one test message, and a rejected key is not saved', async () => {
    const { svc, probed } = service({ models: ['Meta-Llama-3.3-70B-Instruct'], probe: 'invalid' });
    const r = await svc.set({ provider: 'sambanova', key: SN_KEY });
    expect(probed).toEqual(['Meta-Llama-3.3-70B-Instruct']);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('SambaNova says that key is not valid');
    expect(svc.status().configured).toBe(false);
  });

  it('if the model is not there it tries the service\'s next preferred one', async () => {
    const { svc, probed } = service({
      models: ['Meta-Llama-3.3-70B-Instruct', 'gpt-oss-120b', 'DeepSeek-V3.2'],
      probe: (m) => (m === 'Meta-Llama-3.3-70B-Instruct' ? 'missing' : 'ok'),
    });
    const r = await svc.set({ provider: 'sambanova', key: SN_KEY });
    expect(probed).toEqual(['Meta-Llama-3.3-70B-Instruct', 'gpt-oss-120b']);
    expect(r.ok).toBe(true);
    expect(r.status.model).toBe('gpt-oss-120b');
  });

  it('if the test message cannot be sent it still saves, and says it does not know yet', async () => {
    const { svc } = service({ models: ['Meta-Llama-3.3-70B-Instruct'], probe: 'unreachable' });
    const r = await svc.set({ provider: 'sambanova', key: SN_KEY });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("don't know yet that it works");
  });

  it('every key is sent one test message before it is saved (a service that accepts any key for its model list would otherwise save a bad one)', async () => {
    const { svc, probed } = service({ models: ['mistral-small-latest'], probe: 'ok' });
    const r = await svc.set({ provider: 'mistral', key: MISTRAL_KEY });
    expect(r.ok).toBe(true);
    expect(probed).toEqual(['mistral-small-latest']);
  });

  it('a key the service refuses in the test message is not saved', async () => {
    const { svc, files } = service({ models: ['mistral-small-latest'], probe: 'invalid' });
    const r = await svc.set({ provider: 'mistral', key: MISTRAL_KEY });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('says that key is not valid');
    expect(files.size).toBe(0);
  });

  it('a model that is refused for this key (403) is not taken for a bad key: the next model is tried, and the one that works is used', async () => {
    const free = ['aa/one:free', 'bb/two:free', 'cc/three:free'];
    const { svc, probed } = service({ models: free, probe: (m) => (m === 'aa/one:free' ? 'forbidden' : 'ok') });
    const r = await svc.set({ provider: 'openrouter', key: 'sk-or-v1-0123456789abcdef0123456789abcdef' });
    expect(r.ok).toBe(true);
    expect(probed[0]).toBe('aa/one:free');
    expect(probed.length).toBeGreaterThanOrEqual(2);
    expect(r.status.entries[0]?.model).not.toBe('aa/one:free');
  });

  it('when every model is refused for the key, it says so and saves nothing', async () => {
    const { svc, files } = service({ models: ['aa/one:free', 'bb/two:free'], probe: 'forbidden' });
    const r = await svc.set({ provider: 'openrouter', key: 'sk-or-v1-0123456789abcdef0123456789abcdef' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('refused the test message');
    expect(files.size).toBe(0);
  });

  it('an address that does not exist is refused by name', async () => {
    const r = await service({ verdict: 'notfound' }).svc.set({ provider: 'custom', key: CUSTOM_KEY, baseUrl: 'https://nope.example/v1', model: 'm' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('did not recognise that address');
  });

  it('checkBackupKey: 400/401/403 is the key, 404 is the address, Google\'s "models/" prefix is dropped', async () => {
    const f = (status: number, body: unknown = {}) => (async () => json(body, status)) as unknown as typeof fetch;
    expect((await checkBackupKey('https://x', 'k', f(400))).verdict).toBe('invalid');
    expect((await checkBackupKey('https://x', 'k', f(401))).verdict).toBe('invalid');
    expect((await checkBackupKey('https://x', 'k', f(404))).verdict).toBe('notfound');
    expect((await checkBackupKey('https://x', 'k', f(503))).verdict).toBe('unreachable');
    const g = await checkBackupKey('https://x', 'k', f(200, { data: [{ id: 'models/gemini-3.6-flash' }, { id: 'models/gemini-flash-latest' }] }));
    expect(g.models).toEqual(['gemini-3.6-flash', 'gemini-flash-latest']);
  });

  it('probeBackupModel: a limit answer still means the key is good', async () => {
    const f = (status: number) => (async () => json({}, status)) as unknown as typeof fetch;
    expect(await probeBackupModel('https://x', 'k', 'm', f(200))).toBe('ok');
    expect(await probeBackupModel('https://x', 'k', 'm', f(429))).toBe('ok');
    expect(await probeBackupModel('https://x', 'k', 'm', f(401))).toBe('invalid');
    expect(await probeBackupModel('https://x', 'k', 'm', f(404))).toBe('missing');
    expect(await probeBackupModel('https://x', 'k', 'm', (async () => { throw new Error('down'); }) as unknown as typeof fetch)).toBe('unreachable');
  });
});

describe('the services on offer', () => {
  it('has one entry per service, a real https address for each (but the custom one), and a way to get a key', () => {
    const ids = BACKUP_AI_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(10);
    for (const p of BACKUP_AI_PRESETS) {
      if (p.id === 'custom') continue;
      expect(p.baseUrl).toMatch(/^https:\/\/[^/]+/);
      expect(p.keyPage).not.toBe('');
      expect(p.models.length).toBeGreaterThan(0);
    }
  });

  it('knows a key\'s service from its start, and never guesses for the rest', () => {
    expect(providerFromKey('hf_abc')).toBe('huggingface');
    expect(providerFromKey('nvapi-abc')).toBe('nvidia');
    expect(providerFromKey('xai-abc')).toBe('xai');
    expect(providerFromKey('fw_abc')).toBe('fireworks');
    expect(providerFromKey('AIzaSyabc')).toBe('google');
    expect(providerFromKey('sk-proj-abc')).toBeUndefined();
    expect(providerFromKey(MISTRAL_KEY)).toBeUndefined();
  });

  it('names a backup by its service, or for a custom one by its address', () => {
    expect(backupId('openrouter', 'https://openrouter.ai/api/v1')).toBe('openrouter');
    expect(backupId('custom', 'https://API.Example.com/v1')).toBe('custom-api.example.com');
    expect(backupLabelFor('custom', 'http://localhost:1234/v1')).toBe('localhost:1234');
    expect(backupId('custom', 'http://127.0.0.1:1234/v1')).not.toBe(backupId('custom', 'http://127.0.0.1:5678/v1'));
    expect(backupLabelFor('mistral', 'https://api.mistral.ai/v1')).toBe('Mistral');
  });
});

// ---- the chain with several backups --------------------------------------------------------------------------------------------

class P implements AIProvider {
  calls = 0;
  constructor(
    readonly name: string,
    private readonly outcome: AICompletion | Error,
    private readonly model = 'm',
  ) {}
  isReady(): boolean {
    return true;
  }
  currentModel(): string {
    return this.model;
  }
  async complete(): Promise<AICompletion> {
    this.calls += 1;
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}
const said = (t: string): AICompletion => ({ text: t, toolCalls: [] });
const daily = (n: string): AIHttpError => new AIHttpError(429, `${n} daily quota exhausted (429)`, undefined, true);

describe('Gemini, then the backups in order', () => {
  it('goes to the second backup when the first is out, and the badge says who was passed over', async () => {
    const gemini = new P('gemini', daily('gemini'), 'gemini-3.8-flash');
    const slot1 = new SwitchableAIProvider('backup1');
    const slot2 = new SwitchableAIProvider('backup2');
    const slot3 = new SwitchableAIProvider('backup3');
    slot1.set(new P('mistral', daily('mistral'), 'mistral-small-latest'));
    slot2.set(new P('openrouter', said('from openrouter'), 'nvidia/nemotron-3-super-120b-a12b:free'));
    const chain = new ChainedAIProvider([gemini, slot1, slot2, slot3]);

    expect((await chain.complete([], [])).text).toBe('from openrouter');

    const route = describeRoute({
      entries: chain.route(),
      geminiKey: true,
      backups: [
        { id: 'mistral', label: 'Mistral', model: 'mistral-small-latest', models: ['mistral-small-latest'] },
        { id: 'openrouter', label: 'OpenRouter', model: 'nvidia/nemotron-3-super-120b-a12b:free', models: ['nvidia/nemotron-3-super-120b-a12b:free'] },
      ],
      prefer: 'auto',
      now: Date.now(),
    });
    expect(route.using).toMatchObject({ role: 'backup', id: 'openrouter', label: 'OpenRouter' });
    expect(route.passedOver.map((p) => p.label)).toEqual(['Gemini', 'Mistral']);
    expect(routeBadge(route)).toMatchObject({ text: 'OpenRouter · nemotron-3-super-120b-a12b', sub: 'Gemini and Mistral limit over' });
  });

  it('with every backup out too it says the AIs are all out, and an empty slot is not counted', async () => {
    const slot1 = new SwitchableAIProvider('backup1');
    slot1.set(new P('mistral', daily('mistral')));
    const slot2 = new SwitchableAIProvider('backup2');
    const chain = new ChainedAIProvider([new P('gemini', daily('gemini')), slot1, slot2]);
    const err = (await chain.complete([], []).catch((e: unknown) => e)) as Error;
    expect(err.name).toBe('AllProvidersLimitedError');
    const route = describeRoute({
      entries: chain.route(),
      geminiKey: true,
      backups: [{ id: 'mistral', label: 'Mistral', model: 'm', models: ['m'] }],
      prefer: 'auto',
      now: Date.now(),
    });
    expect(route.using).toBeNull();
    expect(routeBadge(route).text).toBe('AI limit reached');
  });

  it('asks the chosen backup first when the user put it first', async () => {
    const slot1 = new SwitchableAIProvider('backup1');
    const slot2 = new SwitchableAIProvider('backup2');
    const a = new P('mistral', said('mistral'));
    const b = new P('groq', said('groq'));
    slot1.set(a);
    slot2.set(b);
    const chain = new ChainedAIProvider([new P('gemini', said('gemini')), slot1, slot2]);
    chain.setPreferred(slot2);
    expect((await chain.complete([], [])).text).toBe('groq');
    expect(vi.isMockFunction(a.complete)).toBe(false);
    expect(a.calls).toBe(0);
  });
});

describe('what can be chosen, and who is "connected"', () => {
  it('a service\'s other preferred models that it really offers are listed to choose from, and fall back to', async () => {
    const { svc } = service({ models: ['mistral-small-latest', 'mistral-medium-latest', 'something-else'] });
    const r = await svc.set({ provider: 'mistral', key: MISTRAL_KEY });
    expect(r.status.entries[0]?.models).toEqual(['mistral-small-latest', 'mistral-medium-latest']);
    expect(svc.use('mistral-medium-latest', 'mistral').ok).toBe(true);
    expect(svc.status().entries[0]?.models[0]).toBe('mistral-medium-latest');
  });

  it('Gemini counts as connected again as soon as its rest is over, even though its last try failed', () => {
    const NOW = 1_800_000_000_000;
    const route = describeRoute({
      entries: [
        { name: 'gemini', ready: false, restingUntil: NOW - 1000, restKind: 'daily' },
        { name: 'mistral', ready: true },
      ],
      geminiKey: true,
      backups: [{ id: 'mistral', label: 'Mistral', model: 'm', models: ['m'] }],
      prefer: 'auto',
      now: NOW,
    });
    expect(route.using?.role).toBe('gemini');
    expect(route.gemini).toBe('ready');
  });

  it('and while it rests it is named as passed over even though it is not "ready"', () => {
    const NOW = 1_800_000_000_000;
    const route = describeRoute({
      entries: [
        { name: 'gemini', ready: false, restingUntil: NOW + 60_000, restKind: 'auth' },
        { name: 'mistral', ready: true, model: 'mistral-small-latest' },
      ],
      geminiKey: true,
      backups: [{ id: 'mistral', label: 'Mistral', model: 'mistral-small-latest', models: ['mistral-small-latest'] }],
      prefer: 'auto',
      now: NOW,
    });
    expect(route.passedOver).toEqual([{ label: 'Gemini', why: 'refused' }]);
    expect(routeBadge(route).sub).toBe('Gemini key refused');
  });
});

describe('when a key is refused, Eya says why', () => {
  const res = (status: number, body: string): Response => new Response(body, { status, headers: { 'content-type': 'application/json' } });

  it('reads the service\'s own words from the shapes xAI, Groq, Mistral and OpenAI really use', async () => {
    const shapes: Array<[number, string, RegExp]> = [
      [400, '{"code":"invalid-argument","error":"Incorrect API key provided. You can obtain an API key from https://console.x.ai."}', /HTTP 400: Incorrect API key provided/],
      [401, '{"error":{"message":"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}', /HTTP 401: Invalid API Key/],
      [401, '{"detail":"Invalid API Key"}', /HTTP 401: Invalid API Key/],
      [401, '{"message":"Wrong API Key","type":"invalid_request_error"}', /HTTP 401: Wrong API Key/],
      [403, 'forbidden', /HTTP 403: forbidden/],
    ];
    for (const [status, body, want] of shapes) {
      const r = await checkBackupKey('https://x', 'k', (async () => res(status, body)) as unknown as typeof fetch);
      expect(r.verdict).toBe('invalid');
      expect(r.detail).toMatch(want);
    }
  });

  it('puts that in the message, and notes a key that does not start the way the service\'s keys do', async () => {
    const svc = new BackupAiService({
      store: makeStore().store,
      env: {},
      check: async () => ({ verdict: 'invalid', models: [], detail: 'HTTP 400: Incorrect API key provided' }),
      apply: () => undefined,
    });
    const r = await svc.set({ provider: 'xai', key: 'AbCdEf0123456789AbCdEf0123456789AbCdEf01' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('xAI Grok says that key is not valid (it said: HTTP 400: Incorrect API key provided)');
    expect(r.message).toContain('A xAI Grok key starts with "xai-", and this one starts with "AbCd"');
  });

  it('does not add that note when the key starts the right way', async () => {
    const svc = new BackupAiService({
      store: makeStore().store,
      env: {},
      check: async () => ({ verdict: 'invalid', models: [], detail: 'HTTP 401: Invalid API Key' }),
      apply: () => undefined,
    });
    const r = await svc.set({ provider: 'groq', key: 'gsk_0123456789abcdef0123456789abcdef' });
    expect(r.message).toContain('Groq says that key is not valid (it said: HTTP 401: Invalid API Key)');
    expect(r.message).not.toContain('starts with');
  });

  it('a Groq key pasted under xAI Grok is used for Groq, and the note says so', async () => {
    const seen: string[] = [];
    const svc = new BackupAiService({
      store: makeStore().store,
      env: {},
      check: async (baseUrl) => {
        seen.push(baseUrl);
        return { verdict: 'valid', models: ['llama-3.3-70b-versatile'] };
      },
      apply: () => undefined,
    });
    const r = await svc.set({ provider: 'xai', key: 'gsk_0123456789abcdef0123456789abcdef' });
    expect(seen).toEqual(['https://api.groq.com/openai/v1']);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('That key is for Groq, not xAI Grok');
  });

  it('tells Groq and Grok apart in the list the person picks from', () => {
    const groq = BACKUP_AI_PRESETS.find((p) => p.id === 'groq');
    const xai = BACKUP_AI_PRESETS.find((p) => p.id === 'xai');
    expect(groq?.keyStart).toBe('gsk_');
    expect(xai?.keyStart).toBe('xai-');
    expect(groq?.note).toContain('not Grok');
    expect(xai?.note).toContain('not Groq');
  });
});

describe('testing a saved backup AI', () => {
  const OR_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
  const free = ['aa/one:free', 'bb/two:free', 'cc/three:free'];

  async function withOpenRouter(probe: (m: string) => ProbeVerdict, clearRests?: () => void) {
    const made = service({ models: free, probe: () => 'ok', ...(clearRests !== undefined ? { clearRests } : {}) });
    expect((await made.svc.set({ provider: 'openrouter', key: OR_KEY })).ok).toBe(true);
    // the same service, now answering tests the way the test wants
    const svc = new BackupAiService({
      store: made.store,
      env: {},
      check: async () => ({ verdict: 'valid', models: free }),
      probe: async (_u, _k, m) => probe(m),
      apply: () => undefined,
      ...(clearRests !== undefined ? { clearRests } : {}),
    });
    svc.start();
    return svc;
  }

  it('says it works, with the model, and makes the chain forget what it held against it', async () => {
    let cleared = 0;
    const svc = await withOpenRouter(() => 'ok', () => void (cleared += 1));
    const r = await svc.test('openrouter');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/OpenRouter works/);
    expect(cleared).toBe(1);
  });

  it('passes over a model the key may not use and puts the one that works first', async () => {
    const svc = await withOpenRouter((m) => (m === 'aa/one:free' ? 'forbidden' : 'ok'));
    const before = svc.status().entries[0]?.model;
    expect(before).toBe('aa/one:free');
    const r = await svc.test('openrouter');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('is not available to this key');
    expect(svc.status().entries[0]?.model).toBe('bb/two:free');
  });

  it('a refused key is said plainly, with what to do', async () => {
    const svc = await withOpenRouter(() => 'invalid');
    const r = await svc.test('openrouter');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('refused this key');
    expect(r.message).toContain('Paste a new key');
  });

  it('no answer from any model, no connection, and no such backup are each said', async () => {
    const none = await (await withOpenRouter(() => 'forbidden')).test('openrouter');
    expect(none.ok).toBe(false);
    expect(none.message).toContain('none of its models answered');
    const down = await (await withOpenRouter(() => 'unreachable')).test('openrouter');
    expect(down.ok).toBe(false);
    expect(down.message).toContain("couldn't reach");
    const missing = await (await withOpenRouter(() => 'ok')).test('groq');
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain('no such backup AI');
  });
});
