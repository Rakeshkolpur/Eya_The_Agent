import { describe, it, expect, beforeEach } from 'vitest';
import { AgentEngine, describeAIFailure, looksLikeChatter, toolResultForModel } from '../src/main/agent/AgentEngine';
import type { Transcriber } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { ConversationContext } from '../src/main/context/ConversationContext';
import type { AIChatMessage, AICompletion, AIProvider, AIToolCall } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';
import type { AgentUpdate } from '../src/shared/types';

const call = (name: string, args: Record<string, unknown> = {}): AIToolCall => ({
  id: `id_${name}_${Math.random().toString(36).slice(2, 6)}`,
  name,
  args,
});
const step = (toolCalls: AIToolCall[], text = ''): AICompletion => ({ text, toolCalls });
const say = (text: string): AICompletion => ({ text, toolCalls: [] });

class ScriptedAI implements AIProvider {
  readonly name = 'scripted';
  readonly seen: AIChatMessage[][] = [];
  constructor(private readonly script: Array<AICompletion | Error>) {}
  isReady(): boolean {
    return true;
  }
  async complete(messages: readonly AIChatMessage[]): Promise<AICompletion> {
    this.seen.push([...messages]);
    const next = this.script.shift();
    if (next === undefined) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    return next;
  }
}

class FakeTTS implements TTSProvider {
  readonly name = 'fake';
  readonly spoken: string[] = [];
  readonly prefetched: string[] = [];
  init = async (): Promise<void> => undefined;
  speak = async (text: string): Promise<void> => {
    this.spoken.push(text);
  };
  prefetch = (text: string): void => {
    this.prefetched.push(text);
  };
  stop = (): void => undefined;
  isReady = (): boolean => true;
  dispose = async (): Promise<void> => undefined;
}

let tools: ToolRegistry;
let toolLog: Array<{ name: string; args: ToolArgs }>;
let tts: FakeTTS;
let updates: AgentUpdate[];

function fakeTool(name: string, respond: (args: ToolArgs) => ToolResult, schemaArgs: Tool['schema']['args'] = {}): Tool {
  return {
    schema: { name, description: name, args: schemaArgs, status: `running ${name}` },
    async execute(args) {
      toolLog.push({ name, args });
      return respond(args);
    },
  };
}

function engineWith(ai: AIProvider | undefined, gemini?: Transcriber): AgentEngine {
  return new AgentEngine({
    router: new IntentRouter(),
    tools,
    composer: new ResponseComposer(),
    tts,
    context: new ConversationContext(),
    ...(ai !== undefined ? { ai } : {}),
    ...(gemini !== undefined ? { gemini } : {}),
    now: () => new Date('2026-09-28T10:00:00Z'),
  });
}

function transcriber(outcome: string | Error, hasKey = true): Transcriber {
  return {
    hasKey: () => hasKey,
    transcribe: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

const runAudio = (engine: AgentEngine, live: boolean) =>
  engine.handleAudio(
    { requestId: 'v1', audioBase64: 'AAAA', mimeType: 'audio/wav', ...(live ? { live: true } : {}) },
    (u) => updates.push(u),
  );

const run = (engine: AgentEngine, text: string, live = false) =>
  engine.handle(
    { requestId: 'r1', text, source: live ? 'voice' : 'text', ...(live ? { live: true } : {}) },
    (u) => updates.push(u),
  );

beforeEach(() => {
  tools = new ToolRegistry();
  toolLog = [];
  tts = new FakeTTS();
  updates = [];
  tools.register(
    fakeTool(
      'find_file',
      () => ({ ok: true, summary: 'found 1 file', data: { files: [{ path: 'C:\\Users\\me\\Downloads\\order.pdf' }] } }),
      { extension: { type: 'string' } },
    ),
  );
  tools.register(
    fakeTool(
      'analyze_document',
      (a) => ({ ok: true, summary: 'read it', data: { answer: `case 42 for ${String(a['path'])}` } }),
      { path: { type: 'string', required: true }, question: { type: 'string', required: true } },
    ),
  );
  tools.register(
    fakeTool('web_search', () => ({ ok: true, summary: 'searched', data: { answer: 'hearing moved to the 12th' } }), {
      query: { type: 'string', required: true },
    }),
  );
  tools.register(fakeTool('open_application', () => ({ ok: true, summary: 'open', data: { app: 'notepad' } }), { name: { type: 'string', required: true } }));
});

describe('multi-step tasks', () => {
  it('chains tools, feeding each result into the next model call', async () => {
    const ai = new ScriptedAI([
      step([call('find_file', { extension: 'pdf' })]),
      step([call('analyze_document', { path: 'C:\\Users\\me\\Downloads\\order.pdf', question: 'summary' })]),
      step([call('web_search', { query: 'case 42 hearing' })]),
      say('Your latest order is case 42, and the hearing moved to the twelfth.'),
    ]);
    const result = await run(engineWith(ai), 'find my latest pdf, read it and check the web for updates');

    expect(result.ok).toBe(true);
    expect(toolLog.map((t) => t.name)).toEqual(['find_file', 'analyze_document', 'web_search']);
    expect(ai.seen).toHaveLength(4);

    // The second call must contain the model's own call and the tool's answer, by name.
    const second = ai.seen[1] ?? [];
    const assistant = second.find((m) => m.role === 'assistant' && m.toolCalls !== undefined);
    expect(assistant?.toolCalls?.[0]?.name).toBe('find_file');
    const toolMsg = second.find((m) => m.role === 'tool');
    expect(toolMsg?.name).toBe('find_file');
    expect(toolMsg?.content).toContain('order.pdf');

    // The final call sees all three results.
    expect((ai.seen[3] ?? []).filter((m) => m.role === 'tool').map((m) => m.name)).toEqual([
      'find_file',
      'analyze_document',
      'web_search',
    ]);
    expect(result.spoken).toBe('Your latest order is case 42, and the hearing moved to the twelfth.');
  });

  it('tells you once, before the reply, that a longer task is under way', async () => {
    const ai = new ScriptedAI([
      step([call('find_file')]),
      step([call('analyze_document', { path: 'p', question: 'q' })]),
      step([call('web_search', { query: 'x' })]),
      say('All done.'),
    ]);
    await run(engineWith(ai), 'do the long thing');
    expect(tts.spoken).toEqual(['Working on it.', 'All done.']);
  });

  it('stays quiet until the answer when one round is enough', async () => {
    const ai = new ScriptedAI([step([call('find_file')]), say('You have one PDF.')]);
    await run(engineWith(ai), 'how many pdfs do I have');
    expect(tts.spoken).toEqual(['You have one PDF.']);
  });

  it('runs several tool calls the model asks for in the same turn', async () => {
    const ai = new ScriptedAI([
      step([call('find_file'), call('web_search', { query: 'x' })]),
      say('Both done.'),
    ]);
    await run(engineWith(ai), 'do two things');
    expect(toolLog.map((t) => t.name)).toEqual(['find_file', 'web_search']);
    const tail = (ai.seen[1] ?? []).filter((m) => m.role === 'tool');
    expect(tail).toHaveLength(2);
  });

  it('shows what it is doing while each tool runs', async () => {
    const ai = new ScriptedAI([step([call('find_file')]), say('ok')]);
    await run(engineWith(ai), 'go');
    expect(updates.some((u) => u.state === 'working' && u.message === 'running find_file')).toBe(true);
  });

  it('gives the model the date and remembers the recent conversation', async () => {
    const ai = new ScriptedAI([say('Sure.'), say('Sure.')]);
    const engine = engineWith(ai);
    await run(engine, 'what day is it');
    await run(engine, 'and the one after');
    const system = ai.seen[0]?.[0];
    expect(system?.role).toBe('system');
    expect(system?.content).toContain('September 2026');
    const second = ai.seen[1] ?? [];
    expect(second.some((m) => m.role === 'user' && m.content === 'what day is it')).toBe(true);
    expect(second.some((m) => m.role === 'assistant' && m.content === 'Sure.')).toBe(true);
  });
});

describe('when things go wrong', () => {
  it('lets the model recover from a failed tool', async () => {
    tools.register(fakeTool('flaky', () => ({ ok: false, summary: 'failed', error: 'no such folder' })));
    const ai = new ScriptedAI([
      step([call('flaky')]),
      step([call('find_file')]),
      say('I found it another way.'),
    ]);
    const result = await run(engineWith(ai), 'try hard');
    expect(result.ok).toBe(true);
    const failedResult = (ai.seen[1] ?? []).find((m) => m.role === 'tool');
    expect(failedResult?.content).toContain('no such folder');
  });

  it('feeds validation errors back instead of running a tool with bad arguments', async () => {
    const ai = new ScriptedAI([
      step([call('analyze_document', { path: 'p' })]), // question missing
      say('I need to know what to look for.'),
    ]);
    await run(engineWith(ai), 'read it');
    expect(toolLog).toEqual([]);
    const fed = (ai.seen[1] ?? []).find((m) => m.role === 'tool');
    expect(fed?.content).toMatch(/question/);
  });

  it('feeds back an unknown tool name rather than crashing', async () => {
    const ai = new ScriptedAI([step([call('format_disk')]), say('I cannot do that.')]);
    const result = await run(engineWith(ai), 'do something odd');
    expect(result.spoken).toBe('I cannot do that.');
    expect((ai.seen[1] ?? []).find((m) => m.role === 'tool')?.content).toMatch(/No such tool/);
  });

  it('stops after the step limit and says so', async () => {
    const endless = Array.from({ length: 20 }, () => step([call('find_file')]));
    const ai = new ScriptedAI(endless);
    const result = await run(engineWith(ai), 'loop forever');
    expect(ai.seen).toHaveLength(8);
    expect(result.ok).toBe(false);
    expect(result.spoken).toMatch(/more steps/);
  });

  it('reports a dead model at the start honestly', async () => {
    const ai = new ScriptedAI([new Error('network down')]);
    const result = await run(engineWith(ai), 'hello there friend');
    expect(result.ok).toBe(false);
    expect(result.spoken).toBe("I couldn't reach the language model.");
  });

  it('says what actually went wrong if the model drops out partway', async () => {
    const ai = new ScriptedAI([step([call('find_file')]), new Error('gemini http 429: quota exceeded')]);
    const result = await run(engineWith(ai), 'find things');
    expect(result.ok).toBe(false);
    expect(result.spoken).toMatch(/usage limit/);
  });

  it('describes the failure honestly, not as a lost connection', () => {
    expect(describeAIFailure(new Error('gemini http 429: You exceeded your current quota'))).toMatch(/usage limit/);
    expect(describeAIFailure(new Error('gemini http 503: This model is currently experiencing high demand'))).toMatch(/overloaded/);
    expect(describeAIFailure(new Error('gemini http 500: internal'))).toMatch(/overloaded/);
    expect(describeAIFailure(new TypeError('fetch failed'))).toBe("I couldn't reach the language model.");
  });

  it('speaks the honest reason when the model is rate limited from the start', async () => {
    const ai = new ScriptedAI([new Error('gemini http 429: quota exceeded')]);
    const result = await run(engineWith(ai), 'hello there friend');
    expect(result.spoken).toMatch(/usage limit/);
  });

  it('answers plainly when there is no model at all', async () => {
    const result = await run(engineWith(undefined), 'what is the meaning of life');
    expect(result.spoken).toBe("I don't know how to do that yet.");
  });
});

describe('speech', () => {
  it('cleans markdown and links out of what is spoken', async () => {
    const ai = new ScriptedAI([say('**Good news!** See [the court](https://court.example/x) for `details`.')]);
    const result = await run(engineWith(ai), 'any news');
    expect(result.spoken).toBe('Good news! See the court for details.');
    expect(tts.spoken).toEqual([result.spoken]);
  });

  it('falls back to a short line if the model says nothing', async () => {
    const ai = new ScriptedAI([say('')]);
    expect((await run(engineWith(ai), 'hmm what now')).spoken).toBe('Done.');
  });
});

describe('the instant path and always-on listening', () => {
  it('never calls the model for a simple app command, and prefetches the reply', async () => {
    const ai = new ScriptedAI([]);
    const result = await run(engineWith(ai), 'Hey Eya, please open Notepad');
    expect(ai.seen).toHaveLength(0);
    expect(toolLog).toEqual([{ name: 'open_application', args: { name: 'notepad' } }]);
    expect(result.spoken).toBe('Notepad is open.');
    expect(tts.prefetched).toEqual(['Notepad is open.']);
  });

  it('ignores long chatter without spending a model call', async () => {
    const ai = new ScriptedAI([]);
    const chatter = 'so anyway this stethoscope can tell me my heart health in exactly sixty seconds which is really cool';
    const result = await run(engineWith(ai), chatter, true);
    expect(ai.seen).toHaveLength(0);
    expect(result.spoken).toBe('');
    expect(tts.spoken).toEqual([]);
  });

  it('drops obvious conversation without a model call, but not real requests', async () => {
    const ai = new ScriptedAI([]);
    const engine = engineWith(ai);
    const chatter = [
      "I'm going to show you how to make a simple, easy, and delicious breakfast.",
      "it's really nice to meet you all today",
      'so anyway that was pretty good',
    ];
    for (const text of chatter) {
      const result = await run(engine, text, true);
      expect(result.error, text).toBe('ignored');
    }
    expect(ai.seen).toHaveLength(0);

    expect(looksLikeChatter('Find my latest PDF in Downloads')).toBe(false);
    expect(looksLikeChatter('Hey Eya, open Chrome')).toBe(false);
    expect(looksLikeChatter('what is the weather today')).toBe(false);
    expect(looksLikeChatter('Can you read my latest pdf')).toBe(false);
    expect(looksLikeChatter("I'd like you to open the calculator")).toBe(false);
    expect(looksLikeChatter("I'm looking for my resume")).toBe(false);
    expect(looksLikeChatter('I need to find my invoice')).toBe(false);
    expect(looksLikeChatter('')).toBe(false);
  });

  it('typed input is never treated as chatter', async () => {
    const ai = new ScriptedAI([say('Sure.')]);
    const result = await run(engineWith(ai), "I'm curious what day it is");
    expect(result.spoken).toBe('Sure.');
  });

  it('stays silent when a short live phrase turns out not to be a command', async () => {
    const ai = new ScriptedAI([say('I am doing well, thanks for asking!')]);
    const result = await run(engineWith(ai), 'how are you doing', true);
    expect(result.error).toBe('ignored');
    expect(tts.spoken).toEqual([]);
  });

  it('still carries out a live command that needs tools', async () => {
    const ai = new ScriptedAI([step([call('find_file')]), say('You have one PDF.')]);
    const result = await run(engineWith(ai), 'how many pdfs are in my downloads', true);
    expect(result.spoken).toBe('You have one PDF.');
  });

  it('answers a typed question even though live chatter would be ignored', async () => {
    const ai = new ScriptedAI([say('I am doing well, thanks for asking!')]);
    const result = await run(engineWith(ai), 'how are you doing');
    expect(result.spoken).toBe('I am doing well, thanks for asking!');
  });
});

describe('voice input', () => {
  it('turns speech into text and carries out the command', async () => {
    const result = await runAudio(engineWith(undefined, transcriber('Open Notepad')), true);
    expect(toolLog).toEqual([{ name: 'open_application', args: { name: 'notepad' } }]);
    expect(result.spoken).toBe('Notepad is open.');
  });

  it('says the daily limit is spent in words, not silence, for a typed-mic press', async () => {
    const err = new Error('gemini daily quota exhausted (429) for gemini-3.6-flash');
    const result = await runAudio(engineWith(undefined, transcriber(err)), false);
    expect(result.spoken).toMatch(/today's free Gemini limit/);
    expect(tts.spoken).toEqual([result.spoken]);
  });

  it('shows the limit on screen but never speaks it during always-on listening', async () => {
    const err = new Error('gemini daily quota exhausted (429) for gemini-3.6-flash');
    const result = await runAudio(engineWith(undefined, transcriber(err)), true);
    expect(result.spoken).toMatch(/today's free Gemini limit/);
    expect(tts.spoken).toEqual([]);
    expect(updates.some((u) => u.message?.includes("today's free Gemini limit"))).toBe(true);
  });

  it('stays completely quiet on always-on failures that are not about limits', async () => {
    const result = await runAudio(engineWith(undefined, transcriber(new Error('audio decode failed'))), true);
    expect(result.spoken).toBe('');
    expect(tts.spoken).toEqual([]);
  });

  it('handles an empty transcript: silent when live, polite when not', async () => {
    const live = await runAudio(engineWith(undefined, transcriber('')), true);
    expect(live.spoken).toBe('');
    expect(tts.spoken).toEqual([]);
    const pressed = await runAudio(engineWith(undefined, transcriber('')), false);
    expect(pressed.spoken).toBe("I didn't catch that.");
  });

  it('does not act without a key, and says why only when asked directly', async () => {
    const live = await runAudio(engineWith(undefined, transcriber('open notepad', false)), true);
    expect(live.spoken).toBe('');
    expect(toolLog).toEqual([]);
    const pressed = await runAudio(engineWith(undefined, transcriber('open notepad', false)), false);
    expect(pressed.spoken).toMatch(/Gemini key/);
  });
});

describe('daily limit wording', () => {
  it('is distinct from a momentary rate limit', () => {
    expect(describeAIFailure(new Error('gemini daily quota exhausted (429) for x'))).toMatch(/resets tomorrow/);
    expect(describeAIFailure(new Error('gemini http 429: slow down'))).toMatch(/Give me a minute/);
  });
});

describe('toolResultForModel', () => {
  it('keeps small results whole', () => {
    const json = JSON.parse(toolResultForModel({ ok: true, summary: 's', data: { a: 1 } })) as Record<string, unknown>;
    expect(json).toEqual({ ok: true, summary: 's', data: { a: 1 } });
  });

  it('shrinks huge results into valid JSON with a truncation marker', () => {
    const json = JSON.parse(toolResultForModel({ ok: true, summary: 's', data: { blob: 'x'.repeat(50_000) } })) as {
      data: { truncated: boolean; preview: string };
    };
    expect(json.data.truncated).toBe(true);
    expect(json.data.preview.length).toBeLessThanOrEqual(12_000);
  });
});
