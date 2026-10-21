import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import type { AgentLocal } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { ConversationContext } from '../src/main/context/ConversationContext';
import { AllProvidersLimitedError } from '../src/main/providers/ai/ChainedAIProvider';
import { AIHttpError } from '../src/main/providers/ai/OpenAICompatibleProvider';
import { asksForGoAhead, describeStep, looksLikeAction, resumeHint, retryForAIFailure } from '../src/main/tasks/pendingSignals';
import type { AIChatMessage, AICompletion, AIProvider, AIToolCall } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';
import type { LocalCommandResult } from '../src/main/local/LocalCommands';
import type { AgentRequest } from '../src/shared/types';

const call = (name: string, args: Record<string, unknown> = {}): AIToolCall => ({ id: `id_${name}_${Math.random().toString(36).slice(2, 6)}`, name, args });
const step = (toolCalls: AIToolCall[]): AICompletion => ({ text: '', toolCalls });
const say = (text: string): AICompletion => ({ text, toolCalls: [] });

class Scripted implements AIProvider {
  readonly name = 'scripted';
  readonly systems: string[] = [];
  constructor(private readonly script: Array<AICompletion | Error | (() => AICompletion)>) {}
  isReady(): boolean {
    return true;
  }
  async complete(messages: readonly AIChatMessage[]): Promise<AICompletion> {
    this.systems.push(String(messages[0]?.content ?? ''));
    const next = this.script.shift();
    if (next === undefined) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  }
}

const quietTTS: TTSProvider = {
  name: 'quiet',
  init: async () => undefined,
  speak: async () => undefined,
  prefetch: () => undefined,
  stop: () => undefined,
  isReady: () => true,
  dispose: async () => undefined,
};

const ANY_ARGS = { url: { type: 'string' as const }, text: { type: 'string' as const }, label: { type: 'string' as const }, seconds: { type: 'number' as const } };

function fakeTool(name: string, respond: (args: ToolArgs) => ToolResult): Tool {
  return { schema: { name, description: name, args: ANY_ARGS, status: name }, execute: async (args) => respond(args) };
}

let tools: ToolRegistry;
const nullLayer: AgentLocal = { tryHandle: async () => null };

function engine(ai: AIProvider | undefined, over: { tasks?: AgentLocal | null; chat?: AgentLocal; progress?: () => string } = {}): AgentEngine {
  return new AgentEngine({
    router: new IntentRouter(),
    tools,
    composer: new ResponseComposer(),
    tts: quietTTS,
    context: new ConversationContext(),
    ...(ai !== undefined ? { ai } : {}),
    ...(over.tasks === null ? {} : { tasks: over.tasks ?? nullLayer }),
    ...(over.chat !== undefined ? { chat: over.chat } : {}),
    ...(over.progress !== undefined ? { progress: over.progress } : {}),
    now: () => new Date('2026-10-16T10:00:00Z'),
  });
}

const run = (e: AgentEngine, text: string, extra: Partial<AgentRequest> = {}) =>
  e.handle({ requestId: 'r1', text, source: 'text', ...extra }, () => undefined);

beforeEach(() => {
  tools = new ToolRegistry();
  tools.register(fakeTool('open_website', () => ({ ok: true, summary: 'opened' })));
  tools.register(fakeTool('click_on_page', (a) => (a['text'] === 'Captcha' ? { ok: false, summary: 'needs you', error: 'A CAPTCHA.', data: { needsUser: true, challengeKind: 'captcha' } } : { ok: true, summary: 'clicked' })));
  tools.register(fakeTool('wait_for_user_in_browser', () => ({ ok: true, summary: 'still waiting', data: { stillWaiting: true } })));
  tools.register(fakeTool('find_file', () => ({ ok: true, summary: 'found' })));
});
afterEach(() => vi.useRealTimers());

describe('what a request that did not finish tells the task completer', () => {
  it('an ACTION asked for while the AI is out is kept to be done when it is back', async () => {
    const limited = new AllProvidersLimitedError(['gemini', 'groq'], true, 3_600_000);
    const r = await run(engine(new Scripted([limited])), 'send the invoice to Akka on WhatsApp');
    expect(r.ok).toBe(false);
    expect(r.pending).toMatchObject({ kind: 'retry', why: 'the AI is out of its allowance for now' });
    expect(r.pending?.retryAfterMs).toBeGreaterThanOrEqual(2 * 60_000);
    expect(r.pending?.retryAfterMs).toBeLessThanOrEqual(30 * 60_000);
    expect(r.spoken).toContain("I'll keep this and do it as soon as it's back");
  });

  it('a QUESTION asked while the AI is out is not kept (an answer hours later is no use)', async () => {
    const r = await run(engine(new Scripted([new Error('gemini daily quota exhausted (429) for every model')])), 'what is the capital of Karnataka');
    expect(r.pending).toBeUndefined();
    expect(r.spoken).toContain("today's free Gemini limit");
  });

  it('an AI failure that is not a limit or an overload is not kept either', async () => {
    const r = await run(engine(new Scripted([new Error('fetch failed')])), 'send the invoice to Akka');
    expect(r.pending).toBeUndefined();
  });

  it('running out of time is kept: the person hears it will carry on, not "too many steps"', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'));
    const slow = (): AICompletion => {
      vi.setSystemTime(Date.now() + 100_000); // the next step starts after the 90 s budget
      return step([call('open_website', { url: 'https://web.whatsapp.com/' })]);
    };
    const r = await run(engine(new Scripted([slow, say('unreachable')])), 'open whatsapp and send the file');
    expect(r.ok).toBe(false);
    expect(r.pending).toMatchObject({ kind: 'retry', why: 'it is taking a while', retryAfterMs: 20_000 });
    expect(r.pending?.steps).toEqual(['open_website https://web.whatsapp.com/']);
    expect(r.spoken).toBe("That's taking a while. I'll keep going in the background and tell you as soon as it's done.");
  });

  it('a CAPTCHA the model reports is kept as waiting for the person, with the browser watched and what was done so far', async () => {
    const ai = new Scripted([
      step([call('open_website', { url: 'https://services.ecourts.gov.in/' })]),
      step([call('click_on_page', { text: 'Captcha' })]),
      step([call('wait_for_user_in_browser', {})]),
      say('There is a CAPTCHA. Please complete it in your browser and I will carry on.'),
    ]);
    const r = await run(engine(ai), 'check the case status on the court site');
    expect(r.pending).toMatchObject({ kind: 'needs_you', watch: 'browser' });
    expect(r.pending?.steps).toEqual(['open_website https://services.ecourts.gov.in/']);
  });

  it('a CAPTCHA that the person then finished (a later step worked) is not kept', async () => {
    const ai = new Scripted([
      step([call('click_on_page', { text: 'Captcha' })]),
      step([call('click_on_page', { text: 'Search' })]),
      say('Done, the case is listed.'),
    ]);
    const r = await run(engine(ai), 'check the case status');
    expect(r.pending).toBeUndefined();
  });

  it('a question that wants a go-ahead is kept as waiting for the answer; "anything else?" is not', async () => {
    const asks = await run(engine(new Scripted([step([call('find_file')]), say('I found bill.pdf. Shall I send it to Uber?')])), 'send my bill to Uber');
    expect(asks.pending).toMatchObject({ kind: 'needs_you', asks: true });
    const chatter = await run(engine(new Scripted([step([call('find_file')]), say('Opened it. Anything else?')])), 'open my bill');
    expect(chatter.pending).toBeUndefined();
  });

  it('nothing is kept when the engine has no task completer (it behaves as it always did)', async () => {
    const limited = new AllProvidersLimitedError(['gemini'], true);
    const r = await run(engine(new Scripted([limited]), { tasks: null }), 'send the invoice to Akka');
    expect(r.pending).toBeUndefined();
    expect(r.spoken).not.toContain("I'll keep this");
  });

  it('a task carried on by Eya is told what was done and not to repeat it, and is not counted as a new thing the person did', async () => {
    const ai = new Scripted([step([call('find_file')]), say('Done.')]);
    await run(engine(ai), 'send the invoice to Akka on WhatsApp', { resume: { steps: ['open_website https://web.whatsapp.com/'], note: 'WhatsApp was loading' } });
    expect(ai.systems[0]).toContain('carrying on by herself');
    expect(ai.systems[0]).toContain('open_website https://web.whatsapp.com/');
    expect(ai.systems[0]).toContain('never send, delete or pay');
  });
});

describe('what a fast local answer tells the task completer', () => {
  const local = (r: Partial<LocalCommandResult> & Pick<LocalCommandResult, 'spoken' | 'ok' | 'intent'>): AgentLocal => ({
    tryHandle: async () => ({ tools: [], refs: [], ...r }),
  });

  it('a chat question ("Send it?") is waiting for the person', async () => {
    const r = await run(engine(undefined, { chat: local({ spoken: 'Found Akka. Send the file "bill.pdf"?', ok: true, intent: 'chat_file' }) }), 'send the bill to Akka');
    expect(r.pending).toMatchObject({ kind: 'needs_you', asks: true });
    expect(r.spoken).toBe('Found Akka. Send the file "bill.pdf"?');
  });

  it('a chat step that could not finish yet passes its own signal on', async () => {
    const pending = { kind: 'retry', why: 'WhatsApp is still loading', retryAfterMs: 15_000 } as const;
    const r = await run(engine(undefined, { chat: local({ spoken: 'WhatsApp is taking a long time to load.', ok: false, intent: 'chat_message', pending }) }), 'send the bill to Akka');
    expect(r.pending).toEqual(pending);
  });

  it('an ordinary answer carries no signal', async () => {
    const r = await run(engine(undefined, { chat: local({ spoken: 'Opened the chat with Akka.', ok: true, intent: 'chat_open' }) }), 'open the chat with Akka');
    expect(r.pending).toBeUndefined();
  });
});

describe('the task commands come before everything else', () => {
  it('"cancel the task" is answered by the tasks layer and the model is never asked', async () => {
    const layer: AgentLocal = { tryHandle: async (t) => (t === 'cancel the task' ? { spoken: "Okay, I've stopped it.", ok: true, intent: 'task_cancel', tools: [], refs: [] } : null) };
    const ai = new Scripted([]);
    const r = await run(engine(ai, { tasks: layer }), 'cancel the task');
    expect(r.spoken).toBe("Okay, I've stopped it.");
    expect(ai.systems).toHaveLength(0);
  });
});

describe('pendingSignals', () => {
  it('knows an action from a question', () => {
    for (const t of ['send this image to Akka', 'please open the cause list', 'Can you download the form', 'check the case status', 'find my resume']) expect(looksLikeAction(t), t).toBe(true);
    for (const t of ['what is the capital of Karnataka', 'who is the chief justice', 'is it going to rain', 'tell me a joke?'.replace('tell', 'hmm')]) expect(looksLikeAction(t), t).toBe(false);
  });

  it('writes a step without what the person typed', () => {
    expect(describeStep('open_website', { url: 'https://web.whatsapp.com/' })).toBe('open_website https://web.whatsapp.com/');
    expect(describeStep('fill_on_page', { label: 'Type a message', value: 'my secret message' })).toBe('fill_on_page Type a message');
    expect(describeStep('fill_on_page', { text: 'secret', value: 'x' })).toBe('fill_on_page');
    expect(describeStep('load_tools', { groups: 'word' })).toBeNull();
    expect(describeStep('list_windows', {})).toBe('list_windows');
  });

  it('reads how long to wait from the kind of AI failure, and leaves other failures alone', () => {
    expect(retryForAIFailure(new AIHttpError(429, 'groq daily quota exhausted (429)', undefined, true))?.retryAfterMs).toBe(15 * 60_000);
    expect(retryForAIFailure(new AIHttpError(429, 'groq http 429', 12_000))?.retryAfterMs).toBe(20_000);
    expect(retryForAIFailure(new Error('gemini http 503: high demand'))?.why).toContain('overloaded');
    expect(retryForAIFailure(new Error('fetch failed'))).toBeNull();
    expect(retryForAIFailure(new AIHttpError(401, 'bad key'))).toBeNull();
  });

  it('asks for a go-ahead only when it really does', () => {
    expect(asksForGoAhead('Shall I send it to Uber?')).toBe(true);
    expect(asksForGoAhead('Which one: Akka or Akka Raju?')).toBe(true);
    expect(asksForGoAhead('Anything else?')).toBe(false);
    expect(asksForGoAhead('Done, I sent it.')).toBe(false);
  });

  it('the hint for a resumed task says what is done and never to send without a yes', () => {
    const hint = resumeHint({ steps: ['open_website x'], note: 'it was slow' });
    expect(hint).toContain('Already done: open_website x');
    expect(hint).toContain('it was slow');
    expect(resumeHint({ steps: [], note: '' })).toContain('Nothing is known to be done yet');
  });
});

describe('what is in progress is in front of the model when the user speaks again', () => {
  const BRIEF = 'In progress: 1. "open flipkart and log in, then book the red shirt" — waiting for the user: a verification code.';

  it('"the code is 482913", said to a fresh conversation, reaches a model that knows what it belongs to', async () => {
    const ai = new Scripted([say('Typed the code and carried on.')]);
    await run(engine(ai, { progress: () => BRIEF }), 'the code is 482913');
    expect(ai.systems[0]).toContain('waiting for the user: a verification code');
    expect(ai.systems[0]).toContain('open flipkart and log in, then book the red shirt');
  });

  it('nothing is added when nothing is in progress', async () => {
    const ai = new Scripted([say('ok')]);
    await run(engine(ai, { progress: () => '' }), 'what is the time');
    expect(ai.systems[0]).not.toContain('In progress');
  });

  it('a task being carried on has its own account of itself, so the list is not added a second time', async () => {
    const ai = new Scripted([say('ok')]);
    await run(engine(ai, { progress: () => BRIEF }), 'open flipkart and log in, then book the red shirt', { resume: { steps: ['open_website https://www.flipkart.com/'], note: 'a verification code' } });
    expect(ai.systems[0]).not.toContain('waiting for the user: a verification code.');
    expect(ai.systems[0]).toContain('carrying on by herself');
  });
});
