import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import type { AgentDeps } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { StoppedError, abortable, isStopped, sleepUnlessStopped, wasAborted } from '../src/main/agent/stopping';
import { GeminiKeyPool } from '../src/main/config/geminiKeyPool';
import { ConversationContext } from '../src/main/context/ConversationContext';
import { ChainedAIProvider } from '../src/main/providers/ai/ChainedAIProvider';
import { GeminiAIProvider } from '../src/main/providers/ai/GeminiAIProvider';
import { OllamaAIProvider } from '../src/main/providers/ai/OllamaAIProvider';
import { OpenAICompatibleProvider } from '../src/main/providers/ai/OpenAICompatibleProvider';
import type { AIChatMessage, AICompletion, AIProvider, AIToolCall, AIToolSpec, CompleteOptions } from '../src/main/providers/ai/AIProvider';
import type { StoreIo } from '../src/main/privacy/communicationAccessStore';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import { TaskCompleter } from '../src/main/tasks/TaskCompleter';
import { TaskStore } from '../src/main/tasks/TaskStore';
import { trackRequest } from '../src/main/tasks/trackRequest';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import type { Tool, ToolResult } from '../src/main/tools/types';
import type { AgentUpdate } from '../src/shared/types';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const call = (name: string, args: Record<string, unknown> = {}): AIToolCall => ({ id: `id_${name}_${Math.random().toString(36).slice(2, 6)}`, name, args });
const step = (...toolCalls: AIToolCall[]): AICompletion => ({ text: '', toolCalls });
const say = (text: string): AICompletion => ({ text, toolCalls: [] });

/** An AI that answers as scripted, or never answers ("hang") until the request to it is cancelled. */
class Hanging implements AIProvider {
  readonly name = 'hanging';
  calls = 0;
  readonly signals: Array<AbortSignal | undefined> = [];
  constructor(private readonly script: Array<AICompletion | 'hang'>) {}
  isReady(): boolean {
    return true;
  }
  complete(_m: readonly AIChatMessage[], _t: readonly AIToolSpec[], options?: CompleteOptions): Promise<AICompletion> {
    this.calls += 1;
    this.signals.push(options?.signal);
    const next = this.script.shift();
    if (next !== undefined && next !== 'hang') return Promise.resolve(next);
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new StoppedError()), { once: true });
    });
  }
}

function voice(): { tts: TTSProvider; spoke: string[]; stops: { n: number } } {
  const spoke: string[] = [];
  const stops = { n: 0 };
  const tts: TTSProvider = { name: 'v', init: async () => undefined, speak: async (t) => void spoke.push(t), prefetch: () => undefined, stop: () => void (stops.n += 1), isReady: () => true, dispose: async () => undefined };
  return { tts, spoke, stops };
}

function tool(name: string, run: (args: Record<string, unknown>) => Promise<ToolResult>): Tool {
  return { schema: { name, description: name, args: { path: { type: 'string' }, url: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' } }, status: `${name}…` }, execute: (a) => run(a as Record<string, unknown>) };
}

function world(ai: AIProvider, tools: Tool[], extra: Partial<AgentDeps> = {}) {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  const v = voice();
  const context = new ConversationContext();
  const engine = new AgentEngine({ router: new IntentRouter(), tools: registry, composer: new ResponseComposer(), tts: v.tts, context, ai, now: () => new Date('2026-10-24T10:00:00Z'), ...extra });
  return { engine, v, context };
}
const ask = (e: AgentEngine, text: string, updates: AgentUpdate[] = [], extra: Record<string, unknown> = {}, id = 'req-1') => e.handle({ requestId: id, text, source: 'text', mode: 'agent', ...extra }, (u) => updates.push(u));

// ------------------------------------------------------------------------------------------------------------------ the helpers
describe('stopping helpers', () => {
  it('abortable ends the wait at once when the signal is aborted, lets go of the work, and passes results and failures through otherwise', async () => {
    const ac = new AbortController();
    const slow = new Promise<string>((r) => setTimeout(() => r('late'), 200));
    const waiting = abortable(slow, ac.signal);
    setTimeout(() => ac.abort(), 20);
    const t0 = Date.now();
    await expect(waiting).rejects.toBeInstanceOf(StoppedError);
    expect(Date.now() - t0).toBeLessThan(120);
    await expect(abortable(Promise.resolve('ok'), new AbortController().signal)).resolves.toBe('ok');
    await expect(abortable(Promise.reject(new Error('real failure')), new AbortController().signal)).rejects.toThrow('real failure');
    await expect(abortable(Promise.resolve('x'), undefined)).resolves.toBe('x');
    const gone = new AbortController();
    gone.abort();
    await expect(abortable(Promise.resolve('x'), gone.signal)).rejects.toBeInstanceOf(StoppedError);
  });

  it('knows a stop when it sees one, and a sleep ends when the signal does', async () => {
    expect(isStopped(new StoppedError())).toBe(true);
    // (a provider's own timeout is also called AbortError, and is not a Stop)
    expect(isStopped(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(false);
    expect(isStopped(new Error('x'))).toBe(false);
    expect(wasAborted(undefined)).toBe(false);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const t0 = Date.now();
    await sleepUnlessStopped(5000, ac.signal);
    expect(Date.now() - t0).toBeLessThan(150);
  });
});

// ------------------------------------------------------------------------------------------------------------------ the engine
describe('Stop ends a request on the spot', () => {
  it('while the AI is being waited for: the answer is back at once, the request to the AI is cancelled, nothing is said, nothing more reaches the screen', async () => {
    const ai = new Hanging(['hang']);
    const { engine, v } = world(ai, []);
    const updates: AgentUpdate[] = [];
    const running = ask(engine, 'tell me something interesting', updates);
    await sleep(40);
    const t0 = Date.now();
    expect(engine.stopAll()).toBe(1);
    const result = await running;
    expect(Date.now() - t0).toBeLessThan(100);
    expect(result).toMatchObject({ ok: false, spoken: 'Okay, I stopped.', error: 'stopped' });
    expect(ai.signals[0]?.aborted).toBe(true);
    expect(v.spoke).toEqual([]);
    expect(v.stops.n).toBeGreaterThan(0);
    expect(updates[updates.length - 1]).toMatchObject({ state: 'idle' });
    const heard = updates.length;
    await sleep(120);
    expect(updates.length).toBe(heard);
    expect(ai.calls).toBe(1);
  });

  it('while a tool is running: it is not waited for, and nothing else is begun, even when it finishes by itself afterwards', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    let finished = 0;
    const slow = tool('create_folder', async () => {
      started += 1;
      await gate;
      finished += 1;
      return { ok: true, summary: 'made' };
    });
    const ai = new Hanging([step(call('create_folder', { path: 'a' })), step(call('create_folder', { path: 'b' })), say('Both made.')]);
    const { engine } = world(ai, [slow]);
    const running = ask(engine, 'make two folders for me');
    await sleep(60);
    expect(started).toBe(1);
    const t0 = Date.now();
    engine.stopAll();
    const result = await running;
    expect(Date.now() - t0).toBeLessThan(100);
    expect(result.spoken).toBe('Okay, I stopped.');
    release();
    await sleep(80);
    expect(finished).toBe(1); // it finished by itself
    expect(started).toBe(1); // and the second folder was never begun
    expect(ai.calls).toBe(1); // and the AI was not asked again
  });

  it('while the application is finding a website for the request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const finder = tool('find_and_open_website', async () => {
      await gate;
      return { ok: true, summary: 'opened', data: { currentPage: { url: 'https://slow.example/', title: 'Slow' } } };
    });
    const ai = new Hanging([say('never asked')]);
    const { engine } = world(ai, [finder]);
    const running = ask(engine, 'open the website slow.example and read it to me');
    await sleep(40);
    const t0 = Date.now();
    engine.stopAll();
    const result = await running;
    expect(Date.now() - t0).toBeLessThan(100);
    expect(result.error).toBe('stopped');
    release();
    await sleep(80);
    expect(ai.calls).toBe(0);
  });

  it('even a wait that cannot be cancelled (the quick local-command layer, 500 ms here) is let go of at once, and nothing is begun when it ends', async () => {
    const ai = new Hanging([say('never asked')]);
    const slowLocal = { tryHandle: async () => (await sleep(500), null) };
    const { engine } = world(ai, [], { local: slowLocal });
    const running = ask(engine, 'do something for me');
    await sleep(60);
    const t0 = Date.now();
    engine.stopAll();
    const result = await running;
    expect(Date.now() - t0).toBeLessThan(150);
    expect(result.error).toBe('stopped');
    await sleep(600); // the slow layer has now finished by itself
    expect(ai.calls).toBe(0); // and the request did not go on to ask the AI
  });

  it('in plain chat as well', async () => {
    const ai = new Hanging(['hang']);
    const { engine } = world(ai, []);
    const running = ask(engine, 'what is the capital of France', [], { mode: 'chat' });
    await sleep(40);
    engine.stopAll();
    expect((await running).spoken).toBe('Okay, I stopped.');
    expect(ai.signals[0]?.aborted).toBe(true);
  });

  it('a stopped request is not remembered, and a new request afterwards works normally', async () => {
    const ai = new Hanging(['hang', say('Hello again.')]);
    const { engine, context } = world(ai, []);
    const first = ask(engine, 'tell me a long story', [], { mode: 'chat' }, 'a');
    await sleep(30);
    engine.stopAll();
    await first;
    expect(context.recent()).toHaveLength(0);
    const second = await ask(engine, 'hello there', [], { mode: 'chat' }, 'b');
    expect(second.spoken).toBe('Hello again.');
    expect(second.ok).toBe(true);
  });

  it('stopRequest ends only that request; stopAll ends them all and silences her even when there is nothing left to stop', async () => {
    const ai = new Hanging(['hang', 'hang']);
    const { engine, v } = world(ai, []);
    const a = ask(engine, 'first thing', [], { mode: 'chat' }, 'a');
    const b = ask(engine, 'second thing', [], { mode: 'chat' }, 'b');
    await sleep(30);
    expect(engine.stopRequest('a')).toBe(true);
    expect(engine.stopRequest('a')).toBe(false);
    expect(engine.stopRequest('nobody')).toBe(false);
    expect((await a).error).toBe('stopped');
    let bDone = false;
    void b.then(() => (bDone = true));
    await sleep(40);
    expect(bDone).toBe(false); // the other one goes on
    expect(engine.stopAll()).toBe(1);
    expect((await b).error).toBe('stopped');
    const before = v.stops.n;
    expect(engine.stopAll()).toBe(0);
    expect(v.stops.n).toBe(before + 1);
  });
});

describe('Pause holds the whole request; Stop ends it even while paused', () => {
  function pauser() {
    let paused = false;
    let wake: (() => void) | null = null;
    return {
      pause: () => (paused = true),
      resume: () => {
        paused = false;
        wake?.();
      },
      waitWhilePaused: async (signal: AbortSignal | undefined): Promise<void> => {
        while (paused && signal?.aborted !== true) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
      },
    };
  }

  it('no AI step and no tool is begun while it is paused, and the work goes on when it is resumed', async () => {
    const p = pauser();
    const ran: string[] = [];
    const t = tool('create_folder', async (a) => (ran.push(String(a['path'])), { ok: true, summary: 'made' }));
    const ai = new Hanging([step(call('create_folder', { path: 'a' })), say('Made it.')]);
    const { engine } = world(ai, [t], { waitWhilePaused: p.waitWhilePaused });
    p.pause();
    const running = ask(engine, 'make a folder called a');
    await sleep(150);
    expect(ai.calls).toBe(0);
    expect(ran).toEqual([]);
    p.resume();
    const result = await running;
    expect(result.spoken).toBe('Made it.');
    expect(ran).toEqual(['a']);
  });

  it('plain chat is held too: no AI step while it is paused', async () => {
    const p = pauser();
    const ai = new Hanging([say('Hello.')]);
    const { engine } = world(ai, [], { waitWhilePaused: p.waitWhilePaused });
    p.pause();
    const running = ask(engine, 'say hello to me', [], { mode: 'chat' });
    await sleep(150);
    expect(ai.calls).toBe(0);
    p.resume();
    expect((await running).spoken).toBe('Hello.');
  });

  it('pressing Stop while it is paused ends it at once', async () => {
    const p = pauser();
    const ai = new Hanging([say('never')]);
    const { engine } = world(ai, [], { waitWhilePaused: p.waitWhilePaused });
    p.pause();
    const running = ask(engine, 'make a folder called a');
    await sleep(60);
    const t0 = Date.now();
    engine.stopAll();
    const result = await running;
    expect(Date.now() - t0).toBeLessThan(100);
    expect(result.error).toBe('stopped');
    expect(ai.calls).toBe(0);
  });
});

describe('a stopped task is stopped, not failed', () => {
  const memoryIo = (): StoreIo => {
    const files = new Map<string, string>();
    return { read: (p) => files.get(p) ?? null, write: (p, t) => void files.set(p, t) };
  };

  function tracked(ai: AIProvider, tools: Tool[]) {
    const worked = new Set<string>();
    let completer!: TaskCompleter;
    const w = world(ai, tools, {
      workStarted: (id) => void worked.add(id),
      around: (req, run) => trackRequest(completer, req, run, { isWork: () => worked.has(req.requestId), visibleAfterMs: 20 }),
      shouldStop: (id) => completer.wasStopped(id),
    });
    completer = new TaskCompleter({ store: new TaskStore('tasks.json', memoryIo()), run: async () => ({ requestId: 'x', ok: true, spoken: '' }), notify: () => undefined, stopRequest: (id) => void w.engine.stopRequest(id) });
    return { ...w, completer };
  }

  it('Stop on the chat box: the task it belongs to ends as stopped, with no retry and no notice of a failure', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = tool('create_folder', async () => {
      await gate;
      return { ok: true, summary: 'made' };
    });
    const ai = new Hanging([step(call('create_folder', { path: 'a' })), say('done')]);
    const { engine, completer } = tracked(ai, [slow]);
    const running = ask(engine, 'make a folder called a');
    await sleep(120); // the request has been going long enough to be shown as a task
    expect(completer.snapshot().items).toHaveLength(1);
    engine.stopAll();
    const result = await running;
    release();
    await sleep(60);
    expect(result.error).toBe('stopped');
    const item = completer.snapshot().items[0];
    expect(item?.state).toBe('cancelled');
    expect(completer.snapshot().items.filter((i) => i.state === 'waiting' || i.state === 'failed')).toEqual([]);
  });

  it('Stop on the task (the Tasks card): the request behind it ends at once, not at its next step', async () => {
    const ai = new Hanging([step(call('create_folder', { path: 'a' })), 'hang']);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = tool('create_folder', async () => {
      await gate;
      return { ok: true, summary: 'made' };
    });
    const { engine, completer } = tracked(ai, [slow]);
    const running = ask(engine, 'make a folder called a');
    await sleep(120);
    const id = completer.snapshot().items[0]?.id ?? '';
    const t0 = Date.now();
    completer.cancel(id);
    const result = await running;
    release();
    expect(Date.now() - t0).toBeLessThan(150);
    expect(result.spoken).toBe('Okay, I stopped.');
    expect(completer.snapshot().items[0]?.state).toBe('cancelled');
  });
});

// ------------------------------------------------------------------------------------------------------------------ the providers
describe('the request to the AI is cancelled, and a Stop is not a failure of the service', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r(undefined)); })));
  });
  async function hangingServer(): Promise<{ url: string; hits: { n: number; keys: string[] } }> {
    const hits = { n: 0, keys: [] as string[] };
    const server = createServer((req: IncomingMessage, _res: ServerResponse) => {
      hits.n += 1;
      hits.keys.push(String(req.headers['x-goog-api-key'] ?? ''));
      // (never answers)
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
  }
  const messages: AIChatMessage[] = [{ role: 'user', content: 'hello' }];

  it('Gemini: the wait ends at once, the model ladder is not walked and no model is rested for it', async () => {
    const s = await hangingServer();
    const provider = new GeminiAIProvider({ apiKey: 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1', baseUrl: `${s.url}/v1beta`, retryDelaysMs: [], planningTimeoutMs: 20_000, timeoutMs: 20_000 });
    const ac = new AbortController();
    const running = provider.complete(messages, [], { signal: ac.signal });
    setTimeout(() => ac.abort(), 60);
    const t0 = Date.now();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t0).toBeLessThan(400);
    expect(s.hits.n).toBe(1); // one model was asked; the next was never tried
    // not rested: the next request asks the same first model again
    const again = provider.complete(messages, [], { signal: AbortSignal.timeout(80) }).catch(() => undefined);
    await again;
    expect(s.hits.n).toBe(2);
  });

  it('the key pool: the key that was asked is not set aside, and no other key is asked', async () => {
    const s = await hangingServer();
    const A = 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
    const B = 'AIzaSyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2';
    const pool = new GeminiKeyPool({
      makeAi: (apiKey) => new GeminiAIProvider({ apiKey, baseUrl: `${s.url}/v1beta`, retryDelaysMs: [], planningTimeoutMs: 20_000, timeoutMs: 20_000 }),
      makeSpeech: () => ({ hasKey: () => true, stream: async () => { throw new Error('none'); } }),
    });
    pool.setKeys([{ name: 'A', key: A, main: true }, { name: 'B', key: B, main: false }]);
    const ac = new AbortController();
    const running = pool.complete(messages, [], { signal: ac.signal });
    setTimeout(() => ac.abort(), 60);
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.hits.keys.every((k) => k === A)).toBe(true);
    const next = pool.complete(messages, [], { signal: AbortSignal.timeout(80) }).catch(() => undefined);
    await next;
    expect(s.hits.keys[s.hits.keys.length - 1]).toBe(A); // A is still the key that is asked first
  });

  it('the chain: no provider is rested for a Stop, and the next one is not asked', async () => {
    let secondAsked = 0;
    const first = new Hanging(['hang']);
    const second: AIProvider = { name: 'second', isReady: () => true, complete: async () => (secondAsked += 1, say('answered')) };
    const chain = new ChainedAIProvider([first, second]);
    const ac = new AbortController();
    const running = chain.complete(messages, [], { signal: ac.signal });
    setTimeout(() => ac.abort(), 40);
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(secondAsked).toBe(0);
    expect(chain.route().every((r) => r.restingUntil === undefined)).toBe(true);
  });

  it('a ChatGPT-style service and the local AI: the wait ends at once', async () => {
    const s = await hangingServer();
    const openai = new OpenAICompatibleProvider({ label: 'backup1', baseUrl: `${s.url}/v1`, apiKey: 'k'.repeat(24), model: 'm1', fallbackModels: ['m2', 'm3'] });
    const ac = new AbortController();
    const running = openai.complete(messages, [], { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const t0 = Date.now();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t0).toBeLessThan(400);
    expect(s.hits.n).toBe(1); // the other models were not tried

    const local = new OllamaAIProvider({ baseUrl: s.url, model: () => 'llama3.2:1b', firstWordMs: 20_000, quietMs: 20_000, totalMs: 40_000 });
    const ac2 = new AbortController();
    const running2 = local.complete(messages, [], { signal: ac2.signal });
    setTimeout(() => ac2.abort(), 50);
    const t1 = Date.now();
    await expect(running2).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t1).toBeLessThan(400);
  });
});

// ------------------------------------------------------------------------------------------------------------------ a provider giving up is not a Stop
describe('a provider that gives up waiting (its own timeout) is not the person pressing Stop', () => {
  const timeout = (): Error => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  const messages: AIChatMessage[] = [{ role: 'user', content: 'hello' }];

  it('the chain moves on to the next provider (found with the real Gemini: a slow answer was reported as "Okay, I stopped.")', async () => {
    const slowFirst: AIProvider = { name: 'slow', isReady: () => true, complete: async () => { throw timeout(); } };
    const second: AIProvider = { name: 'second', isReady: () => true, complete: async () => say('answered by the next one') };
    const chain = new ChainedAIProvider([slowFirst, second]);
    await expect(chain.complete(messages, [])).resolves.toMatchObject({ text: 'answered by the next one' });
  });

  it('the request is not reported as stopped: it is an AI problem, said as one', async () => {
    const ai: AIProvider = { name: 'slow', isReady: () => true, complete: async () => { throw timeout(); } };
    const { engine } = world(ai, []);
    const result = await ask(engine, 'tell me something', [], { mode: 'chat' });
    expect(result.error).not.toBe('stopped');
    expect(result.spoken).not.toBe('Okay, I stopped.');
  });

  it('the real Gemini provider: a model that does not answer in time fails with its own timeout, not a Stop', async () => {
    const server = createServer((_req: IncomingMessage, _res: ServerResponse) => undefined);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta`;
      const provider = new GeminiAIProvider({ apiKey: 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1', baseUrl: url, retryDelaysMs: [], planningTimeoutMs: 250, timeoutMs: 250 });
      const err = await provider.complete(messages, []).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(isStopped(err)).toBe(false);
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r(undefined)));
    }
  });
});
