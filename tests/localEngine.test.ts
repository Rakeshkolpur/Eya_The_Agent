import { describe, it, expect, beforeEach } from 'vitest';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import type { AgentLocal, AgentMemory } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { ConversationContext } from '../src/main/context/ConversationContext';
import type { LocalCommandResult } from '../src/main/local/LocalCommands';
import type { LocalOutcome } from '../src/main/memory/MemoryService';
import type { AIChatMessage, AICompletion, AIProvider } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import type { ActivityInput } from '../src/main/memory/activityLog';
import type { AgentUpdate } from '../src/shared/types';

class ScriptedAI implements AIProvider {
  readonly name = 'scripted';
  calls = 0;
  constructor(private readonly reply = 'From the model.') {}
  isReady(): boolean {
    return true;
  }
  async complete(_messages: readonly AIChatMessage[]): Promise<AICompletion> {
    this.calls += 1;
    return { text: this.reply, toolCalls: [] };
  }
}

class FakeTTS implements TTSProvider {
  readonly name = 'fake';
  readonly spoken: string[] = [];
  init = async (): Promise<void> => undefined;
  speak = async (text: string): Promise<void> => {
    this.spoken.push(text);
  };
  stop = (): void => undefined;
  isReady = (): boolean => true;
  dispose = async (): Promise<void> => undefined;
}

const result = (patch: Partial<LocalCommandResult> = {}): LocalCommandResult => ({
  spoken: 'Opening YouTube.',
  ok: true,
  intent: 'open_site',
  tools: ['open_url'],
  urls: ['https://www.youtube.com/'],
  refs: [],
  ...patch,
});

let tts: FakeTTS;
let ai: ScriptedAI;
let asked: Array<{ text: string; live: boolean | undefined }>;
let activity: ActivityInput[];
let toolCalls: string[];
let context: ConversationContext;

function engine(opts: { local?: AgentLocal | undefined; chat?: AgentLocal; writing?: AgentLocal; memory?: AgentMemory; router?: IntentRouter } = {}): AgentEngine {
  const tools = new ToolRegistry();
  for (const name of ['open_application', 'close_application']) {
    tools.register({
      schema: { name, description: name, args: { name: { type: 'string', required: true } } },
      async execute() {
        toolCalls.push(name);
        return { ok: true, summary: 'ok', data: { app: 'chrome' } };
      },
    });
  }
  return new AgentEngine({
    router: opts.router ?? new IntentRouter(),
    tools,
    composer: new ResponseComposer(),
    tts,
    context,
    ai,
    ...(opts.local !== undefined ? { local: opts.local } : {}),
    ...(opts.chat !== undefined ? { chat: opts.chat } : {}),
    ...(opts.writing !== undefined ? { writing: opts.writing } : {}),
    ...(opts.memory !== undefined ? { memory: opts.memory } : {}),
    activity: { record: (input) => void activity.push(input) },
    now: () => new Date('2026-10-08T10:00:00Z'),
  });
}

const say = (e: AgentEngine, text: string, live = false) =>
  e.handle({ requestId: 'r1', text, source: 'text', ...(live ? { live: true } : {}) }, (_u: AgentUpdate) => undefined);

const local = (handler: (text: string) => LocalCommandResult | null | Error): AgentLocal => ({
  tryHandle: async (text, options) => {
    asked.push({ text, live: options?.live });
    const out = handler(text);
    if (out instanceof Error) throw out;
    return out;
  },
});

const memory = (outcome: LocalOutcome | null): AgentMemory => ({
  tryHandle: async () => outcome,
  beginTask: () => undefined,
  observeTool: () => undefined,
  finishTask: () => null,
  promptBlock: () => '',
  possibleRoutineHint: () => null,
});

beforeEach(() => {
  tts = new FakeTTS();
  ai = new ScriptedAI();
  asked = [];
  activity = [];
  toolCalls = [];
  context = new ConversationContext();
});

describe('AgentEngine with local commands', () => {
  it('answers an everyday command without the model, and keeps the record', async () => {
    const e = engine({ local: local(() => result({ refs: [{ kind: 'file', value: 'C:\\x\\a.pdf', meta: { index: 0, name: 'a.pdf' } }] })) });
    const out = await say(e, 'open youtube');
    expect(out).toMatchObject({ ok: true, spoken: 'Opening YouTube.' });
    expect(ai.calls).toBe(0);
    expect(tts.spoken).toEqual(['Opening YouTube.']);
    expect(activity).toEqual([{ request: 'open youtube', tools: ['open_url'], urls: ['https://www.youtube.com/'], spoken: 'Opening YouTube.', ok: true }]);
    expect(context.lastRefsOfKind('file').map((r) => r.value)).toEqual(['C:\\x\\a.pdf']); // "open it" can refer back
  });

  it('reports a command that did not work as not ok', async () => {
    const e = engine({ local: local(() => result({ ok: false, spoken: "I couldn't open YouTube." })) });
    expect(await say(e, 'open youtube')).toMatchObject({ ok: false, spoken: "I couldn't open YouTube." });
    expect(ai.calls).toBe(0);
  });

  it('goes on to the model when the local layer is not sure', async () => {
    const e = engine({ local: local(() => null) });
    const out = await say(e, 'plan my weekend');
    expect(out.spoken).toBe('From the model.');
    expect(ai.calls).toBe(1);
    expect(asked).toHaveLength(1);
  });

  it('goes on to the model if the local layer breaks', async () => {
    const e = engine({ local: local(() => new Error('boom')) });
    expect((await say(e, 'open youtube')).spoken).toBe('From the model.');
    expect(ai.calls).toBe(1);
  });

  it('is unchanged when there is no local layer', async () => {
    expect((await say(engine(), 'open youtube')).spoken).toBe('From the model.');
  });

  it('lets the app shortcut win, so apps are never second-guessed', async () => {
    const e = engine({ local: local(() => result()) });
    await say(e, 'open chrome');
    expect(toolCalls).toEqual(['open_application']);
    expect(asked).toEqual([]);
  });

  it('lets a saved routine win over a local command', async () => {
    const e = engine({ local: local(() => result()), memory: memory({ kind: 'answered', spoken: 'Ran your routine.', ok: true, routine: 'open_youtube' }) });
    const out = await say(e, 'open youtube');
    expect(out.spoken).toBe('Ran your routine.');
    expect(asked).toEqual([]);
  });

  it('does not run a local command while a routine is handing over to the model', async () => {
    const e = engine({
      local: local(() => result()),
      memory: memory({ kind: 'handoff', hint: 'it stopped', routine: 'cause_list' }),
    });
    await say(e, 'open youtube');
    expect(asked).toEqual([]);
    expect(ai.calls).toBe(1);
  });

  it('tells the local layer when it is always-on listening, and ignores long speech there', async () => {
    const e = engine({ local: local(() => result()) });
    await say(e, 'open youtube', true);
    expect(asked).toEqual([{ text: 'open youtube', live: true }]);

    asked = [];
    const longTalk = 'open youtube and then we were thinking about maybe going to the market later this afternoon if it stops raining';
    await say(e, longTalk, true);
    expect(asked).toEqual([]); // a room full of conversation is never taken for a command
    expect(ai.calls).toBe(0);
  });

  it('is as quick as the lookup: no model, no waiting', async () => {
    const e = engine({ local: local(() => result()) });
    const started = performance.now();
    await say(e, 'open youtube');
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('AgentEngine with Writing Watch commands', () => {
  it('asks the writing layer first, speaks what it says, and does not put the words of the draft into the history', async () => {
    const e = engine({ writing: local(() => result({ spoken: '"recieved" may be misspelled.', intent: 'writing_watch', tools: [], urls: undefined as never })), chat: local(() => result({ spoken: 'chat took it' })) });
    const out = await say(e, 'read it');
    expect(out.spoken).toBe('"recieved" may be misspelled.');
    expect(asked.map((a) => a.text)).toEqual(['read it']); // the chat layer was never asked
    expect(activity).toEqual([]); // what it quotes from the user's petition is not written to the Recent list
    expect(ai.calls).toBe(0);
  });

  it('is never started or answered from always-on listening', async () => {
    const e = engine({ writing: local(() => result({ spoken: 'Okay, watching.' })) });
    const out = await say(e, 'watch my writing', true);
    expect(asked).toEqual([]); // not even asked
    expect(out.spoken).not.toBe('Okay, watching.');
  });

  it('goes on when the writing layer is not sure', async () => {
    const e = engine({ writing: local(() => null), local: local(() => result({ spoken: 'local took it' })) });
    expect((await say(e, 'open youtube')).spoken).toBe('local took it');
  });
});

describe('AgentEngine with chat commands', () => {
  const memoryThatRecords = (asked: string[]): AgentMemory => ({ ...memory(null), tryHandle: async (text) => { asked.push(text); return null; } });

  it('asks the chat layer before memory, so "remember my contacts" is not taken for a memory', async () => {
    const memoryAsked: string[] = [];
    const e = engine({ chat: local(() => result({ spoken: 'Okay, I will remember chat names.', intent: 'chat_names', tools: [], urls: undefined as never })), memory: memoryThatRecords(memoryAsked) });
    const out = await say(e, 'remember my WhatsApp contacts');
    expect(out.spoken).toBe('Okay, I will remember chat names.');
    expect(memoryAsked).toEqual([]);
    expect(ai.calls).toBe(0);
  });

  it('goes on to memory, the local layer and the model when the chat layer is not sure', async () => {
    const memoryAsked: string[] = [];
    const e = engine({ chat: local(() => null), local: local(() => null), memory: memoryThatRecords(memoryAsked) });
    expect((await say(e, 'plan my weekend')).spoken).toBe('From the model.');
    expect(memoryAsked).toEqual(['plan my weekend']);
    expect(ai.calls).toBe(1);
  });

  it('records a chat command in the history without its words, and does not put the chat in the conversation record as a file', async () => {
    const e = engine({ chat: local(() => result({ spoken: 'Sent.', intent: 'chat_send', tools: ['find_chat', 'fill_on_page', 'click_on_page', 'verify_sent'], urls: undefined as never, refs: [] })) });
    await say(e, 'message Ravi that I will be late');
    expect(activity).toHaveLength(1);
    expect(activity[0]?.tools).toContain('find_chat');
    expect(context.lastRefsOfKind('file')).toEqual([]);
  });

  it('is told when it is always-on listening', async () => {
    const e = engine({ chat: local(() => null) });
    await say(e, 'yes', true);
    expect(asked).toEqual([{ text: 'yes', live: true }]);
  });

  it('falls through to the model if the chat layer breaks', async () => {
    const e = engine({ chat: local(() => new Error('boom')) });
    expect((await say(e, 'message Ravi hi')).spoken).toBe('From the model.');
  });
});
