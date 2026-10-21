import { describe, it, expect, vi } from 'vitest';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { ConversationContext } from '../src/main/context/ConversationContext';
import { BackupAiService, BackupAiStore } from '../src/main/config/backupAi';
import { AIHttpError } from '../src/main/providers/ai/OpenAICompatibleProvider';
import { ChainedAIProvider } from '../src/main/providers/ai/ChainedAIProvider';
import { createChosenAiNotice, describeRoute, routeBadge } from '../src/shared/aiRoute';
import type { AiRouteStatus } from '../src/shared/aiRoute';
import { talkWay } from '../src/shared/liveFallback';
import type { AIChatMessage, AICompletion, AIProvider } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';

const OPENAI = { id: 'openai', label: 'OpenAI', model: 'gpt-5-mini', models: ['gpt-5-mini', 'gpt-4.1-mini'] };
const DEEPSEEK = { id: 'deepseek', label: 'DeepSeek', model: 'deepseek-v4-pro', models: ['deepseek-v4-pro'] };
const ROUTER = { id: 'openrouter', label: 'OpenRouter', model: 'poolside/laguna-s-2.1:free', models: ['poolside/laguna-s-2.1:free'] };

function route(over: Partial<AiRouteStatus>): AiRouteStatus {
  return {
    using: { role: 'gemini', id: null, label: 'Gemini', model: 'gemini-3.8-flash' },
    gemini: 'ready',
    geminiBackAt: null,
    prefer: 'auto',
    passedOver: [],
    backups: [],
    ...over,
  };
}

describe('how the person is talked with follows the AI they chose', () => {
  it('a chosen backup (any of them, not only ChatGPT) is never put through Gemini\'s live voice', () => {
    for (const first of [OPENAI, DEEPSEEK, ROUTER]) expect(talkWay(route({ prefer: 'backup', backups: [first, OPENAI] }))).toBe('hands-free');
  });

  it('Gemini first stays Gemini\'s live voice while Gemini can answer', () => {
    expect(talkWay(route({ backups: [OPENAI] }))).toBe('live');
    expect(talkWay(route({ gemini: 'busy', backups: [OPENAI] }))).toBe('live');
  });

  it('with Gemini out (allowance over, key refused, no key) and another AI to talk with, it does not try a voice that would only fail', () => {
    for (const gemini of ['limit', 'refused', 'no-key'] as const) expect(talkWay(route({ gemini, backups: [OPENAI] })), gemini).toBe('hands-free');
  });

  it('with nothing else to talk with, or nothing known yet, it is the live voice as before', () => {
    expect(talkWay(route({ gemini: 'limit' }))).toBe('live');
    expect(talkWay(null)).toBe('live');
  });
});

describe('the badge says when the AI you chose is not the one answering', () => {
  const now = 1_000_000;
  const chosenButEmpty = describeRoute({
    entries: [
      { name: 'openai', ready: true, model: 'gpt-5-mini', restingUntil: now + 60_000, restKind: 'credit' },
      { name: 'gemini', ready: true, model: 'gemini-3.8-flash' },
    ],
    geminiKey: true,
    backups: [OPENAI],
    prefer: 'backup',
    now,
  });

  it('"Gemini connected" no longer hides it', () => {
    const badge = routeBadge(chosenButEmpty);
    expect(badge.text).toBe('Gemini connected');
    expect(badge.sub).toBe('OpenAI has no credit');
    expect(badge.title).toContain('The AI you chose is not');
  });

  it('is as before when nothing was passed over', () => {
    const fine = describeRoute({ entries: [{ name: 'gemini', ready: true, model: 'gemini-3.8-flash' }], geminiKey: true, backups: [], prefer: 'auto', now });
    expect(routeBadge(fine)).toMatchObject({ text: 'Gemini connected', sub: 'gemini-3.8-flash' });
  });
});

describe('being told once, in words, why the chosen AI is not answering', () => {
  const credit = route({ prefer: 'backup', backups: [OPENAI], passedOver: [{ label: 'OpenAI', why: 'credit' }] });

  it('says which AI has no credit, who answers instead, and what puts it right', () => {
    const said = createChosenAiNotice(() => credit)();
    expect(said).toMatch(/OpenAI has no credit left, so Gemini is answering for now/);
    expect(said).toMatch(/platform\.openai\.com/);
    expect(said).toMatch(/switch straight back/);
  });

  it('is said once, not on every answer, and again after half an hour', () => {
    let at = 0;
    const notice = createChosenAiNotice(() => credit, () => at);
    expect(notice()).not.toBeNull();
    at = 60_000;
    expect(notice()).toBeNull();
    at = 31 * 60_000;
    expect(notice()).not.toBeNull();
  });

  it('is said again after the chosen AI has worked in between', () => {
    let state: AiRouteStatus = credit;
    const notice = createChosenAiNotice(() => state, () => 0);
    expect(notice()).not.toBeNull();
    state = route({ prefer: 'backup', backups: [OPENAI], using: { role: 'backup', id: 'openai', label: 'OpenAI', model: 'gpt-5-mini' } });
    expect(notice()).toBeNull();
    state = credit;
    expect(notice()).not.toBeNull();
  });

  it('has a sentence for a used-up allowance and a refused key, and none for a passing busy spell', () => {
    const limited = route({ prefer: 'backup', backups: [DEEPSEEK], passedOver: [{ label: 'DeepSeek', why: 'limit' }] });
    expect(createChosenAiNotice(() => limited)()).toMatch(/DeepSeek's allowance is used up/);
    const refused = route({ prefer: 'backup', backups: [DEEPSEEK], passedOver: [{ label: 'DeepSeek', why: 'refused' }] });
    expect(createChosenAiNotice(() => refused)()).toMatch(/refused its key/);
    const busy = route({ prefer: 'backup', backups: [DEEPSEEK], passedOver: [{ label: 'DeepSeek', why: 'busy' }] });
    expect(createChosenAiNotice(() => busy)()).toBeNull();
  });

  it('says nothing when Gemini was chosen (automatic), when another AI than the chosen one was passed over, or when nothing can answer', () => {
    expect(createChosenAiNotice(() => route({ prefer: 'auto', backups: [OPENAI], passedOver: [{ label: 'OpenAI', why: 'credit' }] }))()).toBeNull();
    expect(createChosenAiNotice(() => route({ prefer: 'backup', backups: [DEEPSEEK, OPENAI], passedOver: [{ label: 'OpenAI', why: 'credit' }] }))()).toBeNull();
    expect(createChosenAiNotice(() => route({ prefer: 'backup', backups: [OPENAI], using: null, passedOver: [{ label: 'OpenAI', why: 'credit' }] }))()).toBeNull();
  });
});

describe('the answer starts with that note when the chosen AI was passed over', () => {
  class Scripted implements AIProvider {
    readonly name = 'scripted';
    isReady(): boolean {
      return true;
    }
    async complete(_m: readonly AIChatMessage[]): Promise<AICompletion> {
      return { text: 'It is half past ten.', toolCalls: [] };
    }
  }
  const quiet: TTSProvider = { name: 'q', init: async () => undefined, speak: async () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };
  const engine = (aiNote?: () => string | null): AgentEngine =>
    new AgentEngine({ router: new IntentRouter(), tools: new ToolRegistry(), composer: new ResponseComposer(), tts: quiet, context: new ConversationContext(), ai: new Scripted(), ...(aiNote !== undefined ? { aiNote } : {}) });

  it('puts the note in front of what the AI that did answer said', async () => {
    const r = await engine(() => 'OpenAI has no credit left, so Gemini is answering for now.').handle({ requestId: 'a', text: 'what is the time', source: 'text' }, () => undefined);
    expect(r.spoken).toBe('OpenAI has no credit left, so Gemini is answering for now. It is half past ten.');
  });

  it('is unchanged without a note', async () => {
    const r = await engine(() => null).handle({ requestId: 'b', text: 'what is the time', source: 'text' }, () => undefined);
    expect(r.spoken).toBe('It is half past ten.');
    const plain = await engine().handle({ requestId: 'c', text: 'what is the time', source: 'text' }, () => undefined);
    expect(plain.spoken).toBe('It is half past ten.');
  });
});

describe('choosing a model asks for it at once', () => {
  const files = new Map<string, Buffer>();
  const store = new BackupAiStore('/x/b.bin', { isAvailable: () => true, encrypt: (t) => Buffer.from(t), decrypt: (d) => d.toString() }, { read: (p) => files.get(p) ?? null, write: (p, d) => void files.set(p, d), remove: (p) => void files.delete(p) });
  const clearRests = vi.fn();
  const svc = new BackupAiService({ store, env: {}, check: async () => ({ verdict: 'valid', models: ['gpt-5-mini', 'gpt-4.1-mini'] }), probe: async () => 'ok', apply: () => undefined, clearRests });

  it('forgets what the chain held against that AI (an empty account, a refused key), even when the model is the one already in use', async () => {
    await svc.set({ provider: 'openai', key: 'sk-proj-0123456789abcdefABCDEF0123456789' });
    clearRests.mockClear();
    const current = svc.status().entries[0]?.model ?? '';
    expect(svc.use(current, 'openai').ok).toBe(true);
    expect(clearRests).toHaveBeenCalledWith('openai');
  });

  it('but picking only a model of a backup (not asking it first) does not', () => {
    clearRests.mockClear();
    const other = svc.status().entries[0]?.models.find((m) => m !== svc.status().entries[0]?.model) ?? '';
    expect(svc.setModel(other, 'openai').ok).toBe(true);
    expect(clearRests).not.toHaveBeenCalled();
  });
});

describe('the chain can forget one AI\'s rest and leave the others', () => {
  const failing = (name: string): AIProvider => ({ name, isReady: () => true, complete: vi.fn(async () => Promise.reject(new AIHttpError(429, `${name} has no credit left (429)`, undefined, true))) });
  const working = (name: string): AIProvider => ({ name, isReady: () => true, complete: vi.fn(async () => ({ text: `from ${name}`, toolCalls: [] })) });

  it('after it is forgotten the chosen one is asked again first', async () => {
    const a = failing('openai');
    const b = working('gemini');
    const c = working('openrouter');
    const chain = new ChainedAIProvider([a, b, c]);
    expect((await chain.complete([{ role: 'user', content: 'x' }], [])).text).toBe('from gemini');
    expect(a.complete).toHaveBeenCalledTimes(1);
    await chain.complete([{ role: 'user', content: 'x' }], []);
    expect(a.complete).toHaveBeenCalledTimes(1); // resting: not asked again
    chain.clearRests('openai');
    await chain.complete([{ role: 'user', content: 'x' }], []);
    expect(a.complete).toHaveBeenCalledTimes(2); // asked again at once
  });

  it('clearing one leaves another AI\'s rest alone', async () => {
    const g = failing('gemini');
    const o = failing('openai');
    const rest = working('openrouter');
    const chain = new ChainedAIProvider([g, o, rest]);
    await chain.complete([{ role: 'user', content: 'x' }], []);
    chain.clearRests('openai');
    const kinds = chain.route().map((e) => [e.name, e.restingUntil !== undefined]);
    expect(kinds).toEqual([['gemini', true], ['openai', false], ['openrouter', false]]);
  });
});

describe('a test that finds the account empty, or the key refused, is seen everywhere at once', () => {
  const KEY = 'sk-proj-0123456789abcdefABCDEF0123456789';
  async function testWith(verdict: 'ok' | 'nocredit' | 'invalid') {
    const files = new Map<string, Buffer>();
    const store = new BackupAiStore('/x/b.bin', { isAvailable: () => true, encrypt: (t) => Buffer.from(t), decrypt: (d) => d.toString() }, { read: (p) => files.get(p) ?? null, write: (p, d) => void files.set(p, d), remove: (p) => void files.delete(p) });
    const noteFailure = vi.fn();
    const clearRests = vi.fn();
    let probe: 'ok' | 'nocredit' | 'invalid' = 'ok';
    const svc = new BackupAiService({ store, env: {}, check: async () => ({ verdict: 'valid', models: ['gpt-5-mini'] }), probe: async () => probe, apply: () => undefined, noteFailure, clearRests });
    await svc.set({ provider: 'openai', key: KEY });
    probe = verdict;
    clearRests.mockClear();
    const r = await svc.test('openai');
    return { r, noteFailure, clearRests };
  }

  it('an empty account is rested as "no credit", so the badge and the list say so now', async () => {
    const { r, noteFailure, clearRests } = await testWith('nocredit');
    expect(r.ok).toBe(false);
    expect(noteFailure).toHaveBeenCalledWith('openai', 'credit');
    expect(clearRests).not.toHaveBeenCalled();
  });

  it('a refused key is rested as refused', async () => {
    const { noteFailure } = await testWith('invalid');
    expect(noteFailure).toHaveBeenCalledWith('openai', 'auth');
  });

  it('a working one is asked again at once, and only that one is forgiven', async () => {
    const { r, noteFailure, clearRests } = await testWith('ok');
    expect(r.ok).toBe(true);
    expect(noteFailure).not.toHaveBeenCalled();
    expect(clearRests).toHaveBeenCalledWith('openai');
  });

  it('the chain shows it: passed over for credit until it works', async () => {
    const a: AIProvider = { name: 'openai', isReady: () => true, complete: async () => ({ text: 'from openai', toolCalls: [] }) };
    const b: AIProvider = { name: 'gemini', isReady: () => true, complete: async () => ({ text: 'from gemini', toolCalls: [] }) };
    const chain = new ChainedAIProvider([a, b]);
    chain.markFailed('openai', 'credit');
    expect(chain.route().find((e) => e.name === 'openai')).toMatchObject({ restKind: 'credit' });
    expect((await chain.complete([{ role: 'user', content: 'x' }], [])).text).toBe('from gemini');
    chain.markFailed('nobody', 'credit'); // an unknown name changes nothing
    chain.clearRests('openai');
    expect((await chain.complete([{ role: 'user', content: 'x' }], [])).text).toBe('from openai');
  });
});
