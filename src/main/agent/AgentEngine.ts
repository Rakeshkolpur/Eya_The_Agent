import { rootLogger } from '@main/logging/logger';
import type { RequestHandler, AudioHandler } from '@main/ipc/ipcRouter';
import type { AgentRequest, AgentResult, AgentUpdate } from '@shared/types';
import type { AudioRequest } from '@shared/ipcContract';
import type { ToolRegistry } from '@main/tools/ToolRegistry';
import type { ToolArgs, ToolResult } from '@main/tools/types';
import type { TTSProvider } from '@main/providers/tts/TTSProvider';
import type { AIProvider, AIChatMessage, AICompletion } from '@main/providers/ai/AIProvider';
import type { ConversationContext } from '@main/context/ConversationContext';
import { normalizeCommand } from './IntentRouter';
import type { IntentRouter, IntentMatch } from './IntentRouter';
import type { ResponseComposer } from './ResponseComposer';
import { cleanForSpeech } from './speechText';
import { systemPrompt } from './prompts';
import { ACK_WORKING, INTENT_CONFIDENCE_THRESHOLD } from '@shared/constants';

const log = rootLogger.child('agent');

const MAX_LIVE_COMMAND_WORDS = 14;

// Words that start talking-about-things, not asking-for-things. Live speech that
// begins this way is nearly always someone else's conversation or a video, so
// it is dropped without spending a model call on it. (Deliberately a short list
// of clear cases: dropping a real command costs more than one wasted call.)
const CHATTER_STARTERS = new Set([
  'i', "i'm", 'im', "i've", "i'll", "i'd", 'we', "we're", "we've", 'you', "you're", "you've",
  'he', "he's", 'she', "she's", 'they', "they're", 'it', "it's", 'so', 'and', 'but', 'because',
  'then', 'well', 'um', 'uh', 'yeah', 'yes', 'no', 'oh', 'like', 'this', "this is", 'that',
  "that's", 'these', 'those', 'there', "there's", 'here', "here's", 'my', 'our', 'his', 'her',
  'their', 'when', 'if', 'as', 'once', 'today', 'now', 'thanks', 'thank', 'hello', 'hi', 'hey',
]);

// "I'd like you to...", "I'm looking for..." start with a chatter word but are requests.
const REQUEST_OPENERS: readonly RegExp[] = [
  /^i(?:'d| would) like\b/,
  /^i(?:'m| am) (?:looking for|trying to|searching for)\b/,
  /^i (?:want|need|wanna|gotta) /,
  /^i(?:'ll| will) need\b/,
];

/** Whether always-on speech is worth a model call. Exported for testing. */
export function looksLikeChatter(text: string): boolean {
  const plain = text.toLowerCase().replace(/[.,!?;:"]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (REQUEST_OPENERS.some((re) => re.test(plain))) return false;
  const first = normalizeCommand(text).split(/\s+/)[0]?.replace(/[^a-z']/g, '') ?? '';
  // "hey eya ..." is addressed to us; normalizeCommand has already stripped it.
  return first.length > 0 && CHATTER_STARTERS.has(first);
}
const MAX_AGENT_STEPS = 8;
const AGENT_BUDGET_MS = 90_000;
const MAX_TOOL_RESULT_CHARS = 12_000;

type FailureKind = 'daily' | 'rate' | 'overloaded' | 'other';

function classifyAIFailure(err: unknown): FailureKind {
  const message = err instanceof Error ? err.message : String(err);
  if (/daily quota/i.test(message)) return 'daily';
  if (/\b429\b|quota|rate.?limit|exhausted/i.test(message)) return 'rate';
  if (/\b(500|502|503|504)\b|overload|high demand|unavailable/i.test(message)) return 'overloaded';
  return 'other';
}

/** A reason for a model failure that is honest about what actually went wrong. */
export function describeAIFailure(err: unknown): string {
  switch (classifyAIFailure(err)) {
    case 'daily':
      return "I've used up today's free Gemini limit. It resets tomorrow, or you can turn on billing in Google AI Studio.";
    case 'rate':
      return "I've hit Gemini's usage limit for now. Give me a minute and try again.";
    case 'overloaded':
      return 'Gemini is overloaded at the moment. Try again in a moment.';
    default:
      return "I couldn't reach the language model.";
  }
}

/** Set only when the cause is Gemini's own limits, which the user should hear about. */
function serviceNotice(err: unknown): string | undefined {
  return classifyAIFailure(err) === 'other' ? undefined : describeAIFailure(err);
}

/** What the engine needs from the transcriber. */
export interface Transcriber {
  hasKey(): boolean;
  transcribe(audioBase64: string, mimeType: string): Promise<string>;
}

export interface AgentDeps {
  readonly router: IntentRouter;
  readonly tools: ToolRegistry;
  readonly composer: ResponseComposer;
  readonly tts: TTSProvider;
  readonly context: ConversationContext;
  readonly ai?: AIProvider;
  readonly gemini?: Transcriber;
  readonly now?: () => Date;
}

/**
 * The agent loop.
 *
 * Order of operations per request:
 *  1. Local IntentRouter: instant path for well-known commands.
 *  2. Otherwise the model plans with tools. It may call several tools in a
 *     row, each result going back to it, until it has an answer (bounded by a
 *     step limit and a time budget).
 *  3. The answer is cleaned up and spoken.
 */
export class AgentEngine implements RequestHandler, AudioHandler {
  constructor(private readonly deps: AgentDeps) {}

  async handleAudio(
    req: AudioRequest,
    onUpdate: (u: AgentUpdate) => void,
  ): Promise<AgentResult> {
    const emit = (patch: Omit<AgentUpdate, 'requestId'>) =>
      onUpdate({ requestId: req.requestId, ...patch });

    // Live listening fires on any loud sound, so failures and empty results
    // must stay silent there; only explicit mic presses get spoken feedback.
    const live = req.live === true;
    const gemini = this.deps.gemini;
    if (gemini === undefined || !gemini.hasKey()) {
      if (live) {
        emit({ state: 'idle' });
        return { requestId: req.requestId, ok: false, spoken: '', error: 'no transcriber' };
      }
      return this.respondNoIntent(req, emit, "I can't transcribe without a Gemini key.");
    }

    const fail = async (spoken: string, error: string, notice?: string): Promise<AgentResult> => {
      if (live) {
        // Never spoken (live listening fires on any sound), but if Gemini's own
        // limits are the cause, show that so the silence isn't a mystery.
        emit({ state: 'idle', message: notice ?? '' });
        return { requestId: req.requestId, ok: false, spoken: notice ?? '', error };
      }
      emit({ state: 'speaking', message: spoken });
      await this.speak(spoken);
      emit({ state: 'idle' });
      return { requestId: req.requestId, ok: false, spoken, error };
    };

    emit({ state: 'thinking', message: 'Transcribing…' });
    let text = '';
    try {
      text = await gemini.transcribe(req.audioBase64, req.mimeType);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('transcribe failed', { err: message, live });
      return fail(
        classifyAIFailure(err) === 'other' ? "I couldn't hear that." : describeAIFailure(err),
        message,
        serviceNotice(err),
      );
    }
    if (text.length === 0) {
      log.info('empty transcript', { live });
      return fail("I didn't catch that.", 'empty transcript');
    }
    log.info('heard', { text, live });
    emit({ state: 'thinking', message: `Heard: "${text}"` });
    return this.handle(
      { requestId: req.requestId, text, source: 'voice', ...(live ? { live: true } : {}) },
      onUpdate,
    );
  }

  async handle(req: AgentRequest, onUpdate: (u: AgentUpdate) => void): Promise<AgentResult> {
    const emit = (patch: Omit<AgentUpdate, 'requestId'>) =>
      onUpdate({ requestId: req.requestId, ...patch });

    emit({ state: 'thinking' });

    // Fast path.
    const intent = this.deps.router.match(req.text);
    if (intent !== undefined && intent.confidence >= INTENT_CONFIDENCE_THRESHOLD) {
      return this.runIntent(req, intent, emit);
    }

    // Always-on listening hears everything in the room. A real command is a
    // handful of words; anything longer is conversation, so don't spend an LLM
    // call (or quota) on it and don't answer it.
    if (req.live === true) {
      const words = req.text.trim().split(/\s+/).length;
      if (words > MAX_LIVE_COMMAND_WORDS) {
        log.info('ignored live speech: too long to be a command', { words });
        return this.ignore(req, emit);
      }
      if (looksLikeChatter(req.text)) {
        log.info('ignored live speech: sounds like conversation', { text: req.text });
        return this.ignore(req, emit);
      }
    }

    if (this.deps.ai !== undefined) return this.runAgent(req, emit);
    return this.respondNoIntent(req, emit);
  }

  private async runIntent(
    req: AgentRequest,
    intent: IntentMatch,
    emit: (patch: Omit<AgentUpdate, 'requestId'>) => void,
  ): Promise<AgentResult> {
    emit({ state: 'working', message: this.deps.tools.statusFor(intent.tool) });
    log.info('fast-path intent', { tool: intent.tool, args: intent.args });

    // The success line is predictable, so start generating its audio now and
    // it will be ready the moment the tool confirms, instead of adding the
    // speech-synthesis time on top of the launch time.
    this.deps.tts.prefetch?.(
      this.deps.composer.compose({
        userText: req.text,
        intentTool: intent.tool,
        toolResult: { ok: true, summary: '', data: { app: intent.canonicalName } },
      }),
    );

    const toolStarted = Date.now();
    const toolResult = await this.deps.tools.invoke(intent.tool, intent.args);
    log.info('tool done', { tool: intent.tool, ok: toolResult.ok, ms: Date.now() - toolStarted });
    const spoken = this.deps.composer.compose({
      userText: req.text,
      intentTool: intent.tool,
      toolResult,
    });

    return this.finish(req, spoken, toolResult.ok, {
      intent: intent.tool,
      subject: intent.canonicalName,
      ...(toolResult.error !== undefined ? { error: toolResult.error } : {}),
      emit,
    });
  }

  private async runAgent(
    req: AgentRequest,
    emit: (patch: Omit<AgentUpdate, 'requestId'>) => void,
  ): Promise<AgentResult> {
    const { ai, tools, context } = this.deps;
    if (ai === undefined) return this.respondNoIntent(req, emit);

    emit({ state: 'thinking', message: 'Thinking…' });
    const started = Date.now();
    const now = this.deps.now?.() ?? new Date();
    const messages: AIChatMessage[] = [
      { role: 'system', content: systemPrompt(now) },
      ...this.messagesFromContext(context),
      { role: 'user', content: req.text },
    ];
    const toolSpecs = tools.toAISchema().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    let answer = '';
    let lastToolName: string | undefined;
    let lastToolOk = true;
    let acknowledged = false;
    let finished = false;

    for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
      if (Date.now() - started > AGENT_BUDGET_MS) {
        log.warn('agent out of time', { step });
        break;
      }

      let completion: AICompletion;
      try {
        completion = await ai.complete(messages, toolSpecs);
      } catch (err) {
        log.warn('LLM completion failed', { step, err: String(err) });
        if (step === 0) return this.respondNoIntent(req, emit, describeAIFailure(err));
        answer = describeAIFailure(err);
        lastToolOk = false;
        finished = true;
        break;
      }

      if (completion.toolCalls.length === 0) {
        // Chatter that wasn't a command stays unanswered when always-on.
        if (step === 0 && req.live === true) {
          log.info('ignored live speech: not a command', { text: req.text });
          return this.ignore(req, emit);
        }
        answer = completion.text;
        finished = true;
        break;
      }

      messages.push({ role: 'assistant', content: completion.text, toolCalls: completion.toolCalls });

      // A second round means this is a longer task; say so once.
      if (step >= 1 && !acknowledged) {
        acknowledged = true;
        void this.speak(ACK_WORKING);
      }

      for (const call of completion.toolCalls) {
        emit({ state: 'working', message: tools.statusFor(call.name) });
        log.info('tool call', { step, name: call.name, args: call.args });
        const toolStarted = Date.now();
        const result = await tools.invoke(call.name, call.args as ToolArgs);
        log.info('tool result', { name: call.name, ok: result.ok, ms: Date.now() - toolStarted });
        lastToolName = call.name;
        lastToolOk = result.ok;
        messages.push({
          role: 'tool',
          name: call.name,
          toolCallId: call.id,
          content: toolResultForModel(result),
        });
      }
    }

    if (!finished && answer.length === 0) {
      answer = "That took more steps than I can do in one go. Could you break it down?";
      lastToolOk = false;
    }
    const spoken = cleanForSpeech(answer) || (lastToolOk ? 'Done.' : "That didn't work.");
    log.info('agent finished', { steps: messages.filter((m) => m.role === 'assistant').length, ms: Date.now() - started });

    return this.finish(req, spoken, lastToolOk, {
      ...(lastToolName !== undefined ? { intent: lastToolName } : {}),
      emit,
    });
  }

  /** Live speech that wasn't a command: say nothing, do nothing. */
  private ignore(
    req: AgentRequest,
    emit: (patch: Omit<AgentUpdate, 'requestId'>) => void,
  ): AgentResult {
    emit({ state: 'idle', message: '' });
    return { requestId: req.requestId, ok: false, spoken: '', error: 'ignored' };
  }

  private async respondNoIntent(
    req: AgentRequest | AudioRequest,
    emit: (patch: Omit<AgentUpdate, 'requestId'>) => void,
    override?: string,
  ): Promise<AgentResult> {
    const spoken = override ?? "I don't know how to do that yet.";
    const text = 'text' in req ? req.text : '';
    return this.finish({ requestId: req.requestId, text, source: 'text' }, spoken, false, { emit });
  }

  private async speak(text: string): Promise<void> {
    try {
      await this.deps.tts.speak(text);
    } catch (err) {
      log.warn('tts speak failed', { err: String(err) });
    }
  }

  private async finish(
    req: AgentRequest,
    spoken: string,
    ok: boolean,
    extras: {
      readonly intent?: string;
      readonly subject?: string;
      readonly error?: string;
      readonly emit: (patch: Omit<AgentUpdate, 'requestId'>) => void;
    },
  ): Promise<AgentResult> {
    extras.emit({ state: 'speaking', message: spoken });
    await this.speak(spoken);
    extras.emit({ state: 'idle' });

    this.deps.context.push({
      at: Date.now(),
      userText: req.text,
      ...(extras.intent !== undefined ? { intent: extras.intent, toolUsed: extras.intent } : {}),
      reply: spoken,
      ok,
      refs: extras.subject !== undefined
        ? [{ kind: 'application' as const, value: extras.subject }]
        : [],
    });

    return {
      requestId: req.requestId,
      ok,
      spoken,
      ...(extras.error !== undefined ? { error: extras.error } : {}),
    };
  }

  private messagesFromContext(ctx: ConversationContext): AIChatMessage[] {
    const out: AIChatMessage[] = [];
    for (const turn of ctx.recent().slice(-4)) {
      if (turn.userText.length === 0) continue;
      out.push({ role: 'user', content: turn.userText });
      out.push({ role: 'assistant', content: turn.reply ?? (turn.ok ? 'Done.' : 'That did not work.') });
    }
    return out;
  }
}

/** A tool result as the model sees it, kept within a sane size. */
export function toolResultForModel(result: ToolResult): string {
  const payload = {
    ok: result.ok,
    summary: result.summary,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.data !== undefined ? { data: result.data } : {}),
  };
  const json = JSON.stringify(payload);
  if (json.length <= MAX_TOOL_RESULT_CHARS) return json;
  return JSON.stringify({
    ok: result.ok,
    summary: result.summary,
    data: { truncated: true, preview: json.slice(0, MAX_TOOL_RESULT_CHARS) },
  });
}
