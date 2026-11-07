import { beforeEach, describe, expect, it } from 'vitest';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { ConversationContext } from '../src/main/context/ConversationContext';
import type { AIChatMessage, AICompletion, AIProvider, AIToolSpec } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';

/**
 * A model that sends a tool an argument it does not have ({"n": "1"} for go_back) used to have the call refused; the next step cost about
 * 12,000 to 16,000 tokens and several seconds only to send it again without the argument (one step in sixteen of a traced court-site task).
 * In the step loop of the agent an ordinary tool now runs without it and the result says it was set aside. A tool that asks for a yes stays strict,
 * and so does everything that does not ask for this (the registry's own default, the live voice bridge, the quick commands).
 */

function registry(): { tools: ToolRegistry; seen: ToolArgs[] } {
  const seen: ToolArgs[] = [];
  const tools = new ToolRegistry();
  const run = async (args: ToolArgs): Promise<ToolResult> => (seen.push(args), { ok: true, summary: 'done', data: { saw: Object.keys(args) } });
  const make = (name: string, args: Tool['schema']['args'], extra: Partial<Tool['schema']> = {}): Tool => ({ schema: { name, description: name, args, ...extra }, execute: run });
  tools.register(make('go_back', {}));
  tools.register(make('search', { query: { type: 'string', required: true } }));
  tools.register(make('delete_thing', { path: { type: 'string', required: true }, confirm: { type: 'boolean' } }));
  tools.register(make('remove_all', { mode: { type: 'string', enum: ['recycle', 'permanent'] } }));
  tools.register(make('asks_first', { what: { type: 'string', required: true } }, { requiresConfirmation: true }));
  return { tools, seen };
}

const lenient = { lenient: true } as const;

describe('an argument a tool does not have, when the caller asks for the lenient rule', () => {
  it('is set aside, the tool runs without it, and the result says so', async () => {
    const { tools, seen } = registry();
    const result = await tools.invoke('go_back', { n: '1' }, lenient);
    expect(result).toMatchObject({ ok: true, data: { ignoredArgs: ['n'], saw: [] } });
    expect(seen).toEqual([{}]);
  });

  it('keeps the arguments it does have', async () => {
    const { tools, seen } = registry();
    expect(await tools.invoke('search', { query: 'cause list', limit: 5, page: 2 }, lenient)).toMatchObject({ ok: true, data: { ignoredArgs: ['limit', 'page'], saw: ['query'] } });
    expect(seen).toEqual([{ query: 'cause list' }]);
  });

  it('says nothing when there was nothing to set aside', async () => {
    const { tools } = registry();
    expect((await tools.invoke('search', { query: 'x' }, lenient)).data).toEqual({ saw: ['query'] });
  });

  it('does not rescue a call that lacks what it needs, or whose argument has the wrong type', async () => {
    const { tools, seen } = registry();
    expect(await tools.invoke('search', { q: 'x' }, lenient)).toMatchObject({ ok: false, summary: 'invalid arguments' });
    expect(await tools.invoke('search', { query: 5 as unknown as string }, lenient)).toMatchObject({ ok: false, summary: 'invalid arguments' });
    expect(seen).toEqual([]);
  });

  it('stays strict for a tool that asks for a yes: a misnamed argument there is worth stopping on', async () => {
    const { tools, seen } = registry();
    expect(await tools.invoke('delete_thing', { path: 'a', confirmed: true }, lenient)).toMatchObject({ ok: false, error: expect.stringContaining("Unknown arg 'confirmed'") });
    expect(await tools.invoke('remove_all', { permanent: true }, lenient)).toMatchObject({ ok: false, summary: 'invalid arguments' });
    expect(await tools.invoke('asks_first', { what: 'x', yes: true }, lenient)).toMatchObject({ ok: false, summary: 'invalid arguments' });
    expect(seen).toEqual([]);
  });

  it('is not the default: without it every extra argument is refused, as before', async () => {
    const { tools, seen } = registry();
    expect(await tools.invoke('go_back', { n: '1' })).toMatchObject({ ok: false, summary: 'invalid arguments' });
    expect(await tools.invoke('search', { query: 'x', limit: 5 })).toMatchObject({ ok: false, summary: 'invalid arguments' });
    expect(seen).toEqual([]);
  });
});

// ---- the agent's step loop asks for it -------------------------------------------------------------------------------------------------

class ScriptedAI implements AIProvider {
  readonly name = 'scripted';
  readonly sent: AIChatMessage[][] = [];
  constructor(private readonly script: AICompletion[]) {}
  isReady(): boolean {
    return true;
  }
  async complete(messages: readonly AIChatMessage[], _tools: readonly AIToolSpec[]): Promise<AICompletion> {
    this.sent.push([...messages]);
    const next = this.script.shift();
    if (next === undefined) throw new Error('script exhausted');
    return next;
  }
}

const quietTTS: TTSProvider = { name: 'quiet', init: async () => undefined, speak: async () => undefined, prefetch: () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };

describe('the agent loop', () => {
  let seen: ToolArgs[];
  let tools: ToolRegistry;
  beforeEach(() => {
    ({ tools, seen } = registry());
  });
  const ask = (ai: AIProvider, text: string) =>
    new AgentEngine({ router: new IntentRouter(), tools, composer: new ResponseComposer(), tts: quietTTS, context: new ConversationContext(), ai, now: () => new Date('2026-10-24T12:00:00Z') }).handle({ requestId: 'r', text, source: 'text' }, () => undefined);

  it('does not spend a step on a tool call that only had an argument too many', async () => {
    const ai = new ScriptedAI([{ text: '', toolCalls: [{ id: 'a', name: 'go_back', args: { n: '1' } }] }, { text: 'Went back.', toolCalls: [] }]);
    const result = await ask(ai, 'go back on the court site');
    expect(seen).toEqual([{}]); // the tool ran, once, at the first step
    expect(ai.sent).toHaveLength(2); // two AI calls: the call, and the answer. (Refused, it was four: call, refused, call again, answer.)
    const result2 = ai.sent[1]?.find((m) => m.role === 'tool');
    expect(result2?.content).toContain('ignoredArgs');
    expect(result.spoken).toContain('Went back');
  });
});
