import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { ChatStore } from '../src/main/chats/ChatStore';
import { ConversationContext } from '../src/main/context/ConversationContext';
import type { StoreIo } from '../src/main/privacy/communicationAccessStore';
import { AllProvidersLimitedError } from '../src/main/providers/ai/ChainedAIProvider';
import type { AIChatMessage, AICompletion, AIProvider, AIToolCall, AIToolSpec } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import { CoalescedWriter } from '../src/main/storage/CoalescedWriter';
import { TaskCompleter } from '../src/main/tasks/TaskCompleter';
import type { CompleterDeps } from '../src/main/tasks/TaskCompleter';
import { TaskStore } from '../src/main/tasks/TaskStore';
import { MAX_DONE, SIDE_EFFECT_TOOLS, callKey, mergeDone, mergeSteps } from '../src/main/tasks/ledger';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import type { Tool, ToolResult } from '../src/main/tools/types';
import type { AgentResult } from '../src/shared/types';

function memoryIo(): StoreIo & { files: Map<string, string>; writes: number } {
  const files = new Map<string, string>();
  const io = { files, writes: 0, read: (p: string) => files.get(p) ?? null, write: (p: string, t: string) => { io.writes += 1; files.set(p, t); } };
  return io;
}

afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------------------------------------------- batched writes
describe('a burst of saves is written once', () => {
  it('with no delay every save is written as it is asked for; with a delay only the last one is, after the delay', () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const now = new CoalescedWriter(0);
    now.schedule(() => writes.push('a'));
    now.schedule(() => writes.push('b'));
    expect(writes).toEqual(['a', 'b']);
    writes.length = 0;
    const later = new CoalescedWriter(300);
    for (const x of ['1', '2', '3', '4', '5']) later.schedule(() => writes.push(x));
    expect(writes).toEqual([]);
    expect(later.waiting).toBe(true);
    vi.advanceTimersByTime(299);
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(writes).toEqual(['5']);
    expect(later.waiting).toBe(false);
  });

  it('flush writes what is waiting at once, once; cancel drops it; neither does anything when nothing is waiting', () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const w = new CoalescedWriter(1000);
    w.flush();
    w.schedule(() => writes.push('x'));
    w.flush();
    w.flush();
    expect(writes).toEqual(['x']);
    w.schedule(() => writes.push('y'));
    w.cancel();
    vi.advanceTimersByTime(5000);
    expect(writes).toEqual(['x']);
  });

  const chat = (n: number) => ({ id: 'c1', title: 'Chat', createdAt: 1, updatedAt: n, messages: [{ role: 'user', text: `message ${n}`, at: n, via: 'typed' }] });

  it('the chat history: a burst of changes is one write holding the last of them; written at once when the app closes', () => {
    vi.useFakeTimers();
    const io = memoryIo();
    const store = new ChatStore('chats.json', io, 300);
    let heard = 0;
    store.onChange(() => (heard += 1));
    for (let n = 1; n <= 6; n++) store.upsert(chat(n));
    expect(io.writes).toBe(0);
    expect(heard).toBe(6); // (the screen is told at once)
    expect(store.list()).toHaveLength(1);
    store.flush();
    expect(io.writes).toBe(1);
    expect(io.files.get('chats.json')).toContain('message 6');
    store.upsert(chat(7));
    vi.advanceTimersByTime(301);
    expect(io.writes).toBe(2);
    expect(io.files.get('chats.json')).toContain('message 7');
  });

  it('without a delay the chat history is written at every change, as before', () => {
    const io = memoryIo();
    const store = new ChatStore('chats.json', io);
    store.upsert(chat(1));
    store.upsert(chat(2));
    expect(io.writes).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------- the record of what was done
describe('the record of what a task has done', () => {
  it('the same call is the same call however its arguments are ordered; a different argument is a different call', () => {
    expect(callKey('move_file', { from: 'a', to: 'b' })).toBe(callKey('move_file', { to: 'b', from: 'a' }));
    expect(callKey('move_file', { from: 'a', to: 'b' })).not.toBe(callKey('move_file', { from: 'a', to: 'c' }));
    expect(callKey('delete_file', { path: 'x' })).not.toBe(callKey('delete_file', { path: 'x', confirm: true }));
    expect(callKey('create_folder', { path: 'x', note: undefined })).toBe(callKey('create_folder', { path: 'x' }));
    expect(callKey('word_edit', { ops: [{ a: 1, b: 2 }] })).toBe(callKey('word_edit', { ops: [{ b: 2, a: 1 }] }));
  });

  it('what changes things is in the list; what only reads, or touches a page, is not', () => {
    for (const name of ['move_file', 'copy_file', 'create_folder', 'delete_file', 'download_file', 'word_write', 'remember', 'set_volume', 'shutdown_computer']) expect(SIDE_EFFECT_TOOLS.has(name), name).toBe(true);
    for (const name of ['find_file', 'read_file', 'analyze_document', 'web_search', 'click_on_page', 'open_website', 'fill_on_page', 'list_memories']) expect(SIDE_EFFECT_TOOLS.has(name), name).toBe(false);
  });

  it('merging keeps each call once, the latest forty, and each step line once', () => {
    const a = [{ key: 'k1', summary: 's1' }, { key: 'k2', summary: 's2' }];
    expect(mergeDone(a, [{ key: 'k2', summary: 'again' }, { key: 'k3', summary: 's3' }]).map((d) => d.key)).toEqual(['k1', 'k2', 'k3']);
    expect(mergeDone(undefined, undefined)).toEqual([]);
    const many = Array.from({ length: 60 }, (_, i) => ({ key: `k${i}`, summary: 's' }));
    expect(mergeDone(many, [])).toHaveLength(MAX_DONE);
    expect(mergeDone(many, [])[MAX_DONE - 1]?.key).toBe('k59');
    expect(mergeSteps(['one', 'two'], ['two', 'three'])).toEqual(['one', 'two', 'three']);
    expect(mergeSteps(Array.from({ length: 25 }, (_, i) => `s${i}`), [], 20)).toHaveLength(20);
  });

  it('the task file keeps the record, drops malformed entries, and holds at most forty', () => {
    const io = memoryIo();
    const store = new TaskStore('tasks.json', io);
    const base = { id: 't1', request: 'move my files', source: 'text' as const, state: 'waiting' as const, createdAt: 1, updatedAt: 2, attempts: 1, note: 'n', steps: ['a'] };
    store.save([{ ...base, done: Array.from({ length: 55 }, (_, i) => ({ key: `k${i}`, summary: `s${i}` })) }]);
    const loaded = new TaskStore('tasks.json', io).load();
    expect(loaded[0]?.done).toHaveLength(MAX_DONE);
    io.files.set('tasks.json', JSON.stringify({ version: 1, tasks: [{ ...base, done: [{ key: 'ok', summary: 'fine' }, { key: 5 }, 'junk', null, { summary: 'no key' }] }, { ...base, id: 't2' }] }));
    const cleaned = new TaskStore('tasks.json', io).load();
    expect(cleaned[0]?.done).toEqual([{ key: 'ok', summary: 'fine' }]);
    expect(cleaned[1]?.done).toBeUndefined();
  });

  it('progress is written a moment later, in one write; a full save replaces what was waiting (it would only be older); flush writes it', () => {
    vi.useFakeTimers();
    const io = memoryIo();
    const store = new TaskStore('tasks.json', io);
    const task = { id: 't1', request: 'x', source: 'text' as const, state: 'running' as const, createdAt: 1, updatedAt: 2, attempts: 1, note: 'n', steps: [] as string[] };
    for (let i = 1; i <= 5; i++) store.saveSoon([{ ...task, steps: [`step ${i}`] }]);
    expect(io.writes).toBe(0);
    vi.advanceTimersByTime(251);
    expect(io.writes).toBe(1);
    expect(io.files.get('tasks.json')).toContain('step 5');
    store.saveSoon([{ ...task, steps: ['stale'] }]);
    store.save([{ ...task, steps: ['fuller'] }]);
    vi.advanceTimersByTime(1000);
    expect(io.files.get('tasks.json')).toContain('fuller');
    expect(io.files.get('tasks.json')).not.toContain('stale');
    store.saveSoon([{ ...task, steps: ['last words'] }]);
    store.flush();
    expect(io.files.get('tasks.json')).toContain('last words');
  });
});

// ---------------------------------------------------------------------------------------------------------------- not doing it twice
describe('a task that is carried on does not repeat what it already did', () => {
  const call = (name: string, args: Record<string, unknown> = {}): AIToolCall => ({ id: `id_${name}_${Math.random().toString(36).slice(2, 6)}`, name, args });
  const step = (...toolCalls: AIToolCall[]): AICompletion => ({ text: '', toolCalls });
  const say = (text: string): AICompletion => ({ text, toolCalls: [] });
  const quota = new AllProvidersLimitedError(['gemini'], true);

  class Scripted implements AIProvider {
    readonly name = 'scripted';
    readonly sent: AIChatMessage[][] = [];
    constructor(private readonly script: Array<AICompletion | Error>) {}
    isReady(): boolean {
      return true;
    }
    async complete(messages: readonly AIChatMessage[], _tools: readonly AIToolSpec[]): Promise<AICompletion> {
      this.sent.push([...messages]);
      const next = this.script.shift();
      if (next === undefined) throw new Error('script exhausted');
      if (next instanceof Error) throw next;
      return next;
    }
  }

  const quiet: TTSProvider = { name: 'quiet', init: async () => undefined, speak: async () => undefined, prefetch: () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };

  type Progress = { steps: readonly string[]; done: readonly { key: string; summary: string }[] };
  function world(script: Array<AICompletion | Error>, onCheckpoint: (requestId: string, progress: Progress) => void = () => undefined, shouldStop?: (requestId: string) => boolean) {
    const ran: string[] = [];
    const registry = new ToolRegistry();
    for (const name of ['create_folder', 'move_file', 'copy_file', 'find_file']) {
      const tool: Tool = {
        schema: { name, description: name, args: { path: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } }, status: `${name}…` },
        execute: async (args): Promise<ToolResult> => (ran.push(`${name} ${String(args['path'] ?? args['from'] ?? '')}`), { ok: true, summary: `${name} ok` }),
      };
      registry.register(tool);
    }
    const ai = new Scripted(script);
    const engine = new AgentEngine({
      router: new IntentRouter(),
      tools: registry,
      composer: new ResponseComposer(),
      tts: quiet,
      context: new ConversationContext(),
      ai,
      tasks: { tryHandle: async () => null },
      checkpoint: onCheckpoint,
      ...(shouldStop !== undefined ? { shouldStop } : {}),
      now: () => new Date('2026-10-24T10:00:00Z'),
    });
    return { engine, ai, ran };
  }
  const run = (e: AgentEngine, extra: Record<string, unknown> = {}, id = 'req-1') => e.handle({ requestId: id, text: 'put my reports in a new folder', source: 'text', mode: 'agent', ...extra }, () => undefined);

  it('keeps what worked as it happens (a checkpoint after each step that changed something), and hands it to the task when the AI runs out', async () => {
    const checkpoints: Array<{ requestId: string; steps: readonly string[]; done: readonly { key: string; summary: string }[] }> = [];
    const w = world([step(call('create_folder', { path: 'C:/Reports' })), step(call('find_file', { path: 'report' })), step(call('move_file', { from: 'C:/a.pdf', to: 'C:/Reports' })), quota], (requestId, progress) => void checkpoints.push({ requestId, ...progress }));
    const result = await run(w.engine);
    expect(w.ran).toEqual(['create_folder C:/Reports', 'find_file report', 'move_file C:/a.pdf']);
    expect(checkpoints.map((c) => c.done.length)).toEqual([1, 2]); // (the search changed nothing: no checkpoint)
    expect(checkpoints.every((c) => c.requestId === 'req-1')).toBe(true);
    expect(result.pending?.kind).toBe('retry');
    expect(result.pending?.done?.map((d) => d.key)).toEqual([callKey('create_folder', { path: 'C:/Reports' }), callKey('move_file', { from: 'C:/a.pdf', to: 'C:/Reports' })]);
  });

  it('when it is carried on, a call it already made is not made again, the model is told so, and a new call still runs', async () => {
    const first = world([step(call('create_folder', { path: 'C:/Reports' })), step(call('move_file', { from: 'C:/a.pdf', to: 'C:/Reports' })), quota]);
    const interrupted = await run(first.engine);
    const second = world([
      step(call('create_folder', { path: 'C:/Reports' })), // the model, starting over, does it again
      step(call('move_file', { from: 'C:/a.pdf', to: 'C:/Reports' })),
      step(call('copy_file', { from: 'C:/b.pdf', to: 'C:/Reports' })), // this one is new
      say('All done.'),
    ]);
    const result = await run(second.engine, { resume: { steps: interrupted.pending?.steps ?? [], note: 'the AI was out', done: interrupted.pending?.done ?? [] } }, 'task-1-2');
    expect(second.ran).toEqual(['copy_file C:/b.pdf']); // the two that were done before did not run again
    expect(result.spoken).toBe('All done.');
    const told = (second.ai.sent[1] ?? []).filter((m) => m.role === 'tool').map((m) => m.content).join(' ');
    expect(told).toContain('already done before this task was carried on');
    expect(told).toContain('alreadyDone');
  });

  it('the record is only used when a task is carried on: the same request asked again as a new request does it again', async () => {
    const again = world([step(call('create_folder', { path: 'C:/Reports' })), say('Made.')]);
    await run(again.engine); // (no resume)
    expect(again.ran).toEqual(['create_folder C:/Reports']);
    const once = world([step(call('create_folder', { path: 'C:/Reports' })), say('Made.')]);
    await run(once.engine, { resume: { steps: [], note: 'x', done: [] } }); // (resumed, but nothing was recorded)
    expect(once.ran).toEqual(['create_folder C:/Reports']);
  });

  it('a call with different arguments is not mistaken for one that was done', async () => {
    const w = world([step(call('create_folder', { path: 'C:/Other' })), say('Made.')]);
    await run(w.engine, { resume: { steps: [], note: 'x', done: [{ key: callKey('create_folder', { path: 'C:/Reports' }), summary: 'create_folder ok' }] } });
    expect(w.ran).toEqual(['create_folder C:/Other']);
  });

  it('end to end: cut off, Eya closed and started again, carried on: each thing is done once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const io = memoryIo();
    let clock = 1_000_000;
    const completerFor = (runTask: CompleterDeps['run']) => new TaskCompleter({ store: new TaskStore('tasks.json', io), now: () => clock, run: runTask, notify: () => undefined });

    // --- the first run: a folder is made and a file moved, then the AI runs out (the engine reports each step to the completer as it happens)
    const c1 = completerFor(async () => ({ requestId: 'x', ok: true, spoken: '' }));
    const first = world([step(call('create_folder', { path: 'C:/Reports' })), step(call('move_file', { from: 'C:/a.pdf', to: 'C:/Reports' })), quota], (requestId, progress) => c1.checkpoint(requestId, progress));
    const taskId = c1.begin('put my reports in a new folder', 'text');
    c1.link('req-1', taskId);
    const interrupted: AgentResult = await run(first.engine);
    expect(interrupted.pending?.kind).toBe('retry');
    expect(first.ran).toEqual(['create_folder C:/Reports', 'move_file C:/a.pdf']);
    // --- Eya is closed before the result is settled: the progress was kept as it happened, and closing writes what was still waiting
    c1.stop();
    expect(JSON.parse(io.files.get('tasks.json') ?? '{}').tasks[0].done).toHaveLength(2);

    // --- Eya starts again: the task is loaded and carried on, told what was done; the model starts over, and the two calls are not made again
    const seen: Array<{ done?: readonly unknown[]; steps: readonly string[] }> = [];
    const second = world([step(call('create_folder', { path: 'C:/Reports' })), step(call('move_file', { from: 'C:/a.pdf', to: 'C:/Reports' })), step(call('copy_file', { from: 'C:/b.pdf', to: 'C:/Reports' })), say('Finished.')]);
    const c2 = completerFor(async (task) => {
      seen.push({ ...(task.done !== undefined ? { done: task.done } : {}), steps: task.steps });
      return run(second.engine, { resume: { steps: task.steps, note: task.note, ...(task.done !== undefined ? { done: task.done } : {}) } }, `task-${task.id}-${task.attempts}`);
    });
    c2.start();
    clock += 10_000;
    await c2.tick();
    c2.stop();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.done).toHaveLength(2);
    expect(second.ran).toEqual(['copy_file C:/b.pdf']); // across both runs: the folder was made once, the file moved once, the new file copied once
    expect(c2.snapshot().items[0]?.state).toBe('done');
  });
});

describe('stopping a task that is running', () => {
  const call = (name: string, args: Record<string, unknown> = {}): AIToolCall => ({ id: `id_${name}_${Math.random().toString(36).slice(2, 6)}`, name, args });
  const step = (...toolCalls: AIToolCall[]): AICompletion => ({ text: '', toolCalls });
  const quiet: TTSProvider = { name: 'quiet', init: async () => undefined, speak: async () => undefined, prefetch: () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };
  class Counting implements AIProvider {
    readonly name = 'counting';
    calls = 0;
    constructor(private readonly script: AICompletion[]) {}
    isReady(): boolean {
      return true;
    }
    async complete(): Promise<AICompletion> {
      this.calls += 1;
      const next = this.script.shift();
      if (next === undefined) throw new Error('script exhausted');
      return next;
    }
  }
  function setup(script: AICompletion[], stopAfter: number) {
    const ran: string[] = [];
    let stopped = false;
    const registry = new ToolRegistry();
    for (const name of ['create_folder', 'copy_file']) {
      registry.register({ schema: { name, description: name, args: { path: { type: 'string' } }, status: `${name}…` }, execute: async (args): Promise<ToolResult> => { ran.push(`${name} ${String(args['path'])}`); if (ran.length >= stopAfter) stopped = true; return { ok: true, summary: 'ok' }; } });
    }
    const ai = new Counting(script);
    const engine = new AgentEngine({ router: new IntentRouter(), tools: registry, composer: new ResponseComposer(), tts: quiet, context: new ConversationContext(), ai, tasks: { tryHandle: async () => null }, shouldStop: () => stopped, now: () => new Date('2026-10-24T10:00:00Z') });
    return { engine, ai, ran };
  }
  const go = (e: AgentEngine) => e.handle({ requestId: 'req-1', text: 'make three folders for me', source: 'text', mode: 'agent' }, () => undefined);

  it('between steps: once the person stops it, no more AI steps and no more tools, and it says so', async () => {
    const s = setup([step(call('create_folder', { path: 'a' })), step(call('create_folder', { path: 'b' })), step(call('create_folder', { path: 'c' })), { text: 'All made.', toolCalls: [] }], 1);
    const result = await go(s.engine);
    expect(s.ran).toEqual(['create_folder a']);
    expect(s.ai.calls).toBe(1);
    expect(result.spoken).toBe('Okay, I stopped.');
    expect(result.ok).toBe(false);
    expect(result.pending).toBeUndefined(); // (stopped on purpose: it is not kept to be tried again)
  });

  it('in the middle of a turn: the calls after the one that was running are not made', async () => {
    const s = setup([step(call('create_folder', { path: 'a' }), call('create_folder', { path: 'b' }), call('copy_file', { path: 'c' })), { text: 'Done.', toolCalls: [] }], 1);
    const result = await go(s.engine);
    expect(s.ran).toEqual(['create_folder a']);
    expect(result.spoken).toBe('Okay, I stopped.');
  });

  it('not stopped: everything runs as before', async () => {
    const s = setup([step(call('create_folder', { path: 'a' })), step(call('create_folder', { path: 'b' })), { text: 'Both made.', toolCalls: [] }], 99);
    const result = await go(s.engine);
    expect(s.ran).toEqual(['create_folder a', 'create_folder b']);
    expect(result.spoken).toBe('Both made.');
  });

  it('the completer knows a request is stopped once its task is cancelled, and only then', () => {
    const io = memoryIo();
    const c = new TaskCompleter({ store: new TaskStore('tasks.json', io), now: () => 1_000_000, run: async () => ({ requestId: 'x', ok: true, spoken: '' }), notify: () => undefined });
    const id = c.begin('make three folders', 'text');
    c.link('req-1', id);
    expect(c.wasStopped('req-1')).toBe(false);
    expect(c.wasStopped('unknown')).toBe(false);
    c.cancel(id);
    expect(c.wasStopped('req-1')).toBe(true);
    c.forget('req-1');
    expect(c.wasStopped('req-1')).toBe(false);
  });
});
