import { describe, it, expect } from 'vitest';
import { describeRoute, routeBadge, shortModel } from '../src/shared/aiRoute';
import type { RouteEntryLike, RouteInput } from '../src/shared/aiRoute';
import { ChainedAIProvider } from '../src/main/providers/ai/ChainedAIProvider';
import { AIHttpError } from '../src/main/providers/ai/OpenAICompatibleProvider';
import { SwitchableAIProvider } from '../src/main/providers/ai/SwitchableAIProvider';
import type { AICompletion, AIProvider } from '../src/main/providers/ai/AIProvider';
import { BackupAiService, BackupAiStore } from '../src/main/config/backupAi';
import type { BackupAiConfig } from '../src/main/config/backupAi';
import { parseAppSettings, DEFAULT_APP_SETTINGS } from '../src/main/settings/appSettings';

const NOW = 1_800_000_000_000;
const MODELS = ['nvidia/nemotron-3-super-120b-a12b:free', 'google/gemma-4-31b-it:free'];
const backups = [{ id: 'openrouter', label: 'OpenRouter', model: MODELS[0] as string, models: MODELS }];

function input(entries: RouteEntryLike[], over: Partial<RouteInput> = {}): RouteInput {
  return { entries, geminiKey: true, backups, prefer: 'auto', now: NOW, ...over };
}

describe('describeRoute and the badge', () => {
  it('says Gemini connected (with its model) while Gemini can answer', () => {
    const r = describeRoute(
      input([
        { name: 'gemini', ready: true, model: 'gemini-3.8-flash' },
        { name: 'openrouter', ready: true, model: MODELS[0] as string },
        { name: 'ollama', ready: false },
      ]),
    );
    expect(r.using).toMatchObject({ role: 'gemini', label: 'Gemini', model: 'gemini-3.8-flash' });
    expect(r.gemini).toBe('ready');
    expect(routeBadge(r)).toMatchObject({ text: 'Gemini connected', sub: 'gemini-3.8-flash' });
  });

  it('once Gemini\'s allowance is over it names the model that took over, and why', () => {
    const r = describeRoute(
      input([
        { name: 'gemini', ready: true, model: 'gemini-3.8-flash', restingUntil: NOW + 600_000, restKind: 'daily' },
        { name: 'openrouter', ready: true, model: MODELS[1] as string },
      ]),
    );
    expect(r.gemini).toBe('limit');
    expect(r.geminiBackAt).toBe(NOW + 600_000);
    expect(r.using).toMatchObject({ role: 'backup', label: 'OpenRouter', model: MODELS[1] });
    const b = routeBadge(r);
    expect(b.text).toBe('OpenRouter · gemma-4-31b-it');
    expect(b.sub).toBe('Gemini limit over');
    expect(b.title).toContain('google/gemma-4-31b-it:free');
  });

  it('a rest that has ended means Gemini is connected again', () => {
    const r = describeRoute(input([{ name: 'gemini', ready: true, restingUntil: NOW - 1, restKind: 'daily' }, { name: 'openrouter', ready: true }]));
    expect(r.using?.role).toBe('gemini');
    expect(r.gemini).toBe('ready');
  });

  it('tells a busy Gemini and a refused key apart from a spent allowance', () => {
    const base = (kind: 'overloaded' | 'auth'): RouteInput =>
      input([{ name: 'gemini', ready: true, restingUntil: NOW + 60_000, restKind: kind }, { name: 'openrouter', ready: true, model: MODELS[0] as string }]);
    expect(routeBadge(describeRoute(base('overloaded'))).sub).toBe('Gemini is busy');
    expect(routeBadge(describeRoute(base('auth'))).sub).toBe('Gemini key refused');
  });

  it('shows "your choice" when the user put the backup first', () => {
    const r = describeRoute(
      input([{ name: 'openrouter', ready: true, model: MODELS[0] as string }, { name: 'gemini', ready: true }], { prefer: 'backup' }),
    );
    expect(r.using?.role).toBe('backup');
    expect(routeBadge(r).sub).toBe('your choice');
  });

  it('says so plainly when every AI is out, and when there is none at all', () => {
    const out = describeRoute(
      input([
        { name: 'gemini', ready: true, restingUntil: NOW + 1000, restKind: 'daily' },
        { name: 'openrouter', ready: true, restingUntil: NOW + 1000, restKind: 'daily' },
      ]),
    );
    expect(out.using).toBeNull();
    expect(routeBadge(out)).toMatchObject({ text: 'AI limit reached', sub: 'local commands only' });

    const none = describeRoute({ entries: [{ name: 'backup', ready: false }, { name: 'ollama', ready: false }], geminiKey: false, backups: [], prefer: 'auto', now: NOW });
    expect(none.using).toBeNull();
    expect(none.gemini).toBe('no-key');
    expect(routeBadge(none).text).toContain('No AI');
  });

  it('an empty backup slot is never "using", and the loading text is passed through', () => {
    const r = describeRoute({ entries: [{ name: 'backup', ready: false }, { name: 'ollama', ready: true, model: 'llama3.1' }], geminiKey: false, backups: [], prefer: 'auto', now: NOW });
    expect(r.using?.role).toBe('ollama');
    expect(routeBadge(null, 'Connecting…').text).toBe('Connecting…');
  });

  it('shortens model ids for the badge', () => {
    expect(shortModel('nvidia/nemotron-3-super-120b-a12b:free')).toBe('nemotron-3-super-120b-a12b');
    expect(shortModel('openrouter/free')).toBe('free');
    expect(shortModel('gemini-3.8-flash')).toBe('gemini-3.8-flash');
    expect(shortModel(null)).toBe('');
  });
});

// ---- the chain reports who would answer, and can be told to ask one first ------------------------------------------------------

class P implements AIProvider {
  constructor(
    readonly name: string,
    private readonly outcome: AICompletion | Error,
    private readonly model?: string,
  ) {}
  isReady(): boolean {
    return true;
  }
  currentModel(): string | undefined {
    return this.model;
  }
  async complete(): Promise<AICompletion> {
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}
const said = (t: string): AICompletion => ({ text: t, toolCalls: [] });

describe('ChainedAIProvider route, preference and change events', () => {
  it('reports the order, the models, and who rests after Gemini runs out — and announces the change', async () => {
    const gemini = new P('gemini', new AIHttpError(429, 'gemini daily quota exhausted (429)', undefined, true), 'gemini-3.8-flash');
    const backupAi = new P('openrouter', said('ok'), MODELS[0]);
    const chain = new ChainedAIProvider([gemini, backupAi], { now: () => NOW });
    let changes = 0;
    chain.onChange(() => (changes += 1));

    expect(chain.route().map((e) => e.name)).toEqual(['gemini', 'openrouter']);
    expect(chain.route()[0]).toMatchObject({ model: 'gemini-3.8-flash', ready: true });

    await chain.complete([], []);
    expect(changes).toBeGreaterThan(0);
    const entries = chain.route();
    expect(entries[0]).toMatchObject({ name: 'gemini', restKind: 'daily' });
    expect(entries[0]?.restingUntil).toBeGreaterThan(NOW);
    const r = describeRoute({ entries, geminiKey: true, backups, prefer: 'auto', now: NOW });
    expect(r.using?.label).toBe('OpenRouter');
    expect(r.gemini).toBe('limit');
  });

  it('asks the preferred provider first, and goes back to the usual order when it is cleared', async () => {
    const order: string[] = [];
    const mk = (name: string): AIProvider => ({
      name,
      isReady: () => true,
      complete: async () => {
        order.push(name);
        return said(name);
      },
    });
    const gemini = mk('gemini');
    const slot = new SwitchableAIProvider();
    slot.set(mk('openrouter'));
    const chain = new ChainedAIProvider([gemini, slot]);
    await chain.complete([], []);
    chain.setPreferred(slot);
    await chain.complete([], []);
    chain.setPreferred(null);
    await chain.complete([], []);
    expect(order).toEqual(['gemini', 'openrouter', 'gemini']);
    expect(chain.route().map((e) => e.name)).toEqual(['gemini', 'openrouter']);
  });

  it('the slot passes the model through, so the badge can name it', () => {
    const slot = new SwitchableAIProvider();
    expect(slot.currentModel()).toBeUndefined();
    slot.set(new P('openrouter', said('x'), MODELS[1]));
    expect(slot.currentModel()).toBe(MODELS[1]);
  });
});

// ---- choosing the backup's model -----------------------------------------------------------------------------------------------

describe('BackupAiService.setModel', () => {
  function seeded() {
    const files = new Map<string, Buffer>();
    const store = new BackupAiStore(
      'b.bin',
      { isAvailable: () => true, encrypt: (t) => Buffer.from(`enc:${t}`), decrypt: (d) => d.toString().replace(/^enc:/, '') },
      { read: (p) => files.get(p) ?? null, write: (p, d) => void files.set(p, d), remove: (p) => void files.delete(p) },
    );
    const applied: Array<BackupAiConfig | null> = [];
    const all = ['nvidia/nemotron-3-super-120b-a12b:free', 'google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free'];
    const svc = new BackupAiService({
      store,
      env: {},
      check: async () => ({ verdict: 'valid', models: all, toolModels: all }),
      apply: (cs) => void applied.push(cs[0] ?? null),
    });
    return { svc, store, applied };
  }

  it('puts the chosen model first, keeps the rest as fallbacks, saves it, and puts it to work', async () => {
    const { svc, store, applied } = seeded();
    await svc.set({ provider: 'openrouter', key: 'sk-or-v1-0123456789abcdef0123456789abcdef' });
    expect(svc.status().models[0]).toBe('nvidia/nemotron-3-super-120b-a12b:free');
    const r = svc.setModel('google/gemma-4-26b-a4b-it:free');
    expect(r.ok).toBe(true);
    expect(r.status.model).toBe('google/gemma-4-26b-a4b-it:free');
    expect(r.status.models).toHaveLength(3);
    expect(r.status.models[0]).toBe('google/gemma-4-26b-a4b-it:free');
    expect(applied.at(-1)?.model).toBe('google/gemma-4-26b-a4b-it:free');
    expect(store.load()[0]?.model).toBe('google/gemma-4-26b-a4b-it:free'); // it is there after a restart
  });

  it('refuses a model that is not in the list, and says so when there is no backup', async () => {
    const { svc } = seeded();
    expect(svc.setModel('x/y').ok).toBe(false);
    await svc.set({ provider: 'openrouter', key: 'sk-or-v1-0123456789abcdef0123456789abcdef' });
    const r = svc.setModel('not/in-the-list:free');
    expect(r.ok).toBe(false);
    expect(r.status.model).toBe('nvidia/nemotron-3-super-120b-a12b:free');
  });
});

describe('the "which AI first" setting', () => {
  it('defaults to automatic and only accepts "backup" as the other value', () => {
    expect(DEFAULT_APP_SETTINGS.aiFirst).toBe('auto');
    expect(parseAppSettings({ aiFirst: 'backup' }).aiFirst).toBe('backup');
    expect(parseAppSettings({ aiFirst: 'gemini' }).aiFirst).toBe('auto');
    expect(parseAppSettings({}).aiFirst).toBe('auto');
  });
});
