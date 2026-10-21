import { rootLogger } from '@main/logging/logger';
import type { RequestHandler, AudioHandler } from '@main/ipc/ipcRouter';
import type { AgentRequest, AgentResult, AgentUpdate } from '@shared/types';
import type { AudioRequest } from '@shared/ipcContract';
import type { ToolRegistry } from '@main/tools/ToolRegistry';
import type { ToolArgs, ToolResult } from '@main/tools/types';
import type { TTSProvider } from '@main/providers/tts/TTSProvider';
import type { AIProvider, AIChatMessage, AICompletion, AIToolSpec } from '@main/providers/ai/AIProvider';
import type { ConversationContext, TurnRef } from '@main/context/ConversationContext';
import { normalizeCommand } from './IntentRouter';
import type { IntentRouter, IntentMatch } from './IntentRouter';
import type { ResponseComposer } from './ResponseComposer';
import { cleanForSpeech } from './speechText';
import { systemPrompt } from './prompts';
import { LOAD_TOOLS_SPEC, parseGroups, routeGroups, selectTools, soundsLikeRefusal, TOOL_GROUPS } from './toolGroups';
import type { ToolGroup } from './toolGroups';
import type { PendingSignal } from '@shared/tasks';
import { asksForGoAhead, describeStep, looksLikeAction, resumeHint, retryForAIFailure } from '@main/tasks/pendingSignals';
import { describeEarlier, normalizeEarlier } from '@main/tasks/progress';
import { INTENT_CONFIDENCE_THRESHOLD } from '@shared/constants';
import { CuePicker } from '@shared/humanCues';
import { allLimitedMessage, limitMessage } from '@shared/quotaReset';
import { AllProvidersLimitedError } from '@main/providers/ai/ChainedAIProvider';
import { backupPreset, isBackupAiProvider } from '@shared/backupAi';
import type { LocalOutcome } from '@main/memory/MemoryService';
import type { BeginOptions } from '@main/memory/taskRecorder';
import type { ActivityInput } from '@main/memory/activityLog';
import type { LocalCommandResult } from '@main/local/LocalCommands';

const log = rootLogger.child('agent');

const MAX_LIVE_COMMAND_WORDS = 14;
/** While a longer task goes on, Eya says what she is doing at most this many times, this far apart; after a while she says it is slow. */
const CUE_AGAIN_MS = 12_000;
const CUE_LONG_MS = 45_000;
const MAX_CUES = 4;

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
// A multi-step website task (open, click, observe, fill, click, observe
// again...) can genuinely need more tool calls than a file-finding task ever
// did — the number isn't known in advance, since it depends on what the live
// page actually shows at each step, not a predefined workflow. The 90s time
// budget below is the real ceiling against a runaway loop either way.
const MAX_AGENT_STEPS = 16;
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

function displayName(provider: string): string {
  if (provider === 'gemini') return 'Gemini';
  if (provider.startsWith('custom-')) return provider.slice('custom-'.length);
  return isBackupAiProvider(provider) ? backupPreset(provider).label : provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** How long Google said to wait on a per-minute limit, if the error carries it. */
function retryHint(err: unknown): number | undefined {
  const ms = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/**
 * A reason for a model failure that is honest about what actually went wrong — and, for a limit, WHEN it comes back,
 * by Google's own stated wait, in the user's own time (a per-minute limit as "about N seconds").
 */
export function describeAIFailure(err: unknown, now: Date = new Date()): string {
  if (err instanceof AllProvidersLimitedError) {
    const base = allLimitedMessage(err.providers.map(displayName), { daily: err.dailyQuota, retryAfterMs: err.retryAfterMs }, now);
    if (err.noCredit.length === 0) return base;
    const who = err.noCredit.map(displayName);
    const names = who.length === 1 ? (who[0] as string) : `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}`;
    return `${base} ${names} ${who.length === 1 ? 'has' : 'have'} no credit left, which waiting does not fix: add credit with ${who.length === 1 ? 'them' : 'them'} (for OpenAI, platform.openai.com → Billing) and it works again at once.`;
  }
  switch (classifyAIFailure(err)) {
    case 'daily':
      return limitMessage({ daily: true, retryAfterMs: retryHint(err) }, now, {}, true);
    case 'rate':
      return limitMessage({ daily: false, retryAfterMs: retryHint(err) }, now);
    case 'overloaded':
      return 'Gemini is overloaded at the moment. Try again in a moment.';
    default:
      return "I couldn't reach the language model.";
  }
}

/**
 * What is said when a task was given up on: the true reason. Running out of TIME after a few slow steps is nearly always the AI service
 * being overloaded or out of quota (each step then takes 6-30 s), and "too many steps" would send the user to split a request that was
 * never too big.
 */
export function describeGaveUp(reason: 'time' | 'steps', completionMs: readonly number[], stepsDone: number): string {
  if (reason === 'steps') return 'That took more steps than I can do in one go. Could you break it down?';
  const slow = completionMs.length > 0 && completionMs.reduce((a, b) => a + b, 0) / completionMs.length >= 5000;
  const done = `${stepsDone} step${stepsDone === 1 ? '' : 's'}`;
  return slow
    ? `The AI service is very slow right now (Gemini is overloaded or its daily limit is used up), so I ran out of time after ${done}. Please try again in a minute or two.`
    : `That took too long and I ran out of time after ${done}. Please ask for one smaller thing at a time.`;
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

/**
 * What the engine needs from Eya's memory (MemoryService implements it). Everything here is a local lookup against SQLite: nothing
 * in it calls a model, so asking is cheap enough to do for every command.
 */
export interface AgentMemory {
  /** A memory command ("what do you remember?", a yes to "save this as a routine?") or a saved routine the command clearly means — handled or handed back. */
  tryHandle(text: string): Promise<LocalOutcome | null>;
  beginTask(request: string, options?: BeginOptions): void;
  observeTool(name: string, args: ToolArgs, result: ToolResult): void;
  /** The task is over; the text of an offer to save it as a routine, when it is time to make one. */
  finishTask(ok: boolean, options?: { readonly announce?: boolean }): string | null;
  /** Remembered preferences/facts relevant to the request, and the routines the model can run. */
  promptBlock(request: string): string;
  /** A routine the request is close to, but not sure enough to run without the model. */
  possibleRoutineHint(text: string): string | null;
}

/** Where finished tasks are noted for the Recent screen (see ActivityLog). */
export interface AgentActivity {
  record(input: ActivityInput): void;
}

/**
 * Everyday commands carried out without the model (open a site, search one, open a folder, find or open a file, download a link):
 * LocalCommands implements it. It answers only what it is sure of and returns null for the rest, so the model gets those as before.
 */
export interface AgentLocal {
  tryHandle(text: string, options?: { readonly live?: boolean }): Promise<LocalCommandResult | null>;
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
  /** What is going on in the user's browsers right now (which are connected, how many tabs), for the model's context. */
  readonly browserContext?: () => string;
  /** What is in progress (the tasks Eya is keeping), so what the user says next is understood in that light. See tasks/progress.ts. */
  readonly progress?: () => string;
  /** A sentence to put before an answer when the AI the person chose could not answer and another did (see createChosenAiNotice), else null. */
  readonly aiNote?: () => string | null;
  /** Local memory: preferences and facts, saved routines, and the watcher that offers to save a repeated task. Optional so Eya runs without it. */
  readonly memory?: AgentMemory;
  /** The history of what Eya did. Optional; whether one is kept is the user's choice and is decided inside it. */
  readonly activity?: AgentActivity;
  /** The fast path for everyday commands (see AgentLocal). Optional so Eya runs without it. */
  readonly local?: AgentLocal;
  /** The fast path for chat requests (messaging by name, learning chat names). Asked before memory; see ChatCommands. */
  readonly chat?: AgentLocal;
  /** Writing Watch commands ("watch my writing", "check this document", "fix it"). Asked first; see WritingCommands. Never from always-on listening. */
  readonly writing?: AgentLocal;
  /**
   * Control of the tasks Eya keeps ("cancel the task", "what are you working on", "continue"). Asked before anything else. Its presence
   * also means a request that cannot finish (the AI is out, it ran out of time, a check needs the person) is kept as a task rather than
   * dropped: the result then says so (see AgentResult.pending).
   */
  readonly tasks?: AgentLocal;
  /**
   * Wraps every request (typed, spoken, from the quick panel) so that one that does not simply finish can be kept as a task. Optional;
   * without it a request is handled and forgotten, as before.
   */
  readonly around?: (req: AgentRequest, run: () => Promise<AgentResult>) => Promise<AgentResult>;
}

/**
 * The agent loop.
 *
 * Order of operations per request:
 *  1. Local IntentRouter: instant path for well-known commands.
 *  2. Local memory (SQLite): a memory command, or a saved routine the command clearly means, is handled right here — no model.
 *  2b. Local commands: open a site, search one, open a folder, find or open a file, download a link — also no model.
 *  3. Otherwise the model plans with tools. It may call several tools in a
 *     row, each result going back to it, until it has an answer (bounded by a
 *     step limit and a time budget).
 *  4. The answer is cleaned up and spoken.
 */
export class AgentEngine implements RequestHandler, AudioHandler {
  /** What she says while something takes a moment: different each time, and about what she is doing (see shared/humanCues.ts). */
  private readonly cues = new CuePicker();

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
    // A task Eya carries on by herself is already being kept: it is not wrapped again (that would make each go a new task).
    const around = this.deps.around;
    if (around === undefined || req.resume !== undefined) return this.handleNow(req, onUpdate);
    return around(req, () => this.handleNow(req, onUpdate));
  }

  private async handleNow(req: AgentRequest, onUpdate: (u: AgentUpdate) => void): Promise<AgentResult> {
    const emit = (patch: Omit<AgentUpdate, 'requestId'>) =>
      onUpdate({ requestId: req.requestId, ...patch });

    emit({ state: 'thinking' });

    // "Cancel the task", "what are you working on", "continue": what the person says to the tasks Eya is keeping.
    const taskCommands = this.deps.tasks;
    if (taskCommands !== undefined) {
      const done = await this.askLocal(taskCommands, req);
      if (done !== null) return this.finish(req, done.spoken, done.ok, { intent: done.intent, emit });
    }

    // Fast path.
    const intent = this.deps.router.match(req.text);
    if (intent !== undefined && intent.confidence >= INTENT_CONFIDENCE_THRESHOLD) {
      return this.runIntent(req, intent, emit);
    }

    // Writing Watch ("watch my writing", "check this document", "fix it"): reads and, on a click or an order, corrects the user's own document,
    // so only what was said or typed to Eya counts — never always-on listening. Nothing it says goes into the history: it quotes the draft.
    const writing = this.deps.writing;
    if (writing !== undefined && req.live !== true) {
      const done = await this.askLocal(writing, req);
      if (done !== null) return this.finish(req, done.spoken, done.ok, { intent: done.intent, emit });
    }

    // Chat requests ("message Ravi that I'll be late", "remember my WhatsApp contacts", the "yes" to "Send it?") come before memory: the
    // words "remember my contacts" and "forget my contacts" are memory commands too, and a chat question waiting for its yes must get it.
    // It never acts on always-on listening (see ChatCommands), only on what the user said or typed to Eya.
    const chat = this.deps.chat;
    if (chat !== undefined && (req.live !== true || req.text.trim().split(/\s+/).length <= MAX_LIVE_COMMAND_WORDS)) {
      const asked = Date.now();
      const done = await this.askLocal(chat, req);
      if (done !== null) return this.finishLocal(req, done, asked, emit);
    }

    // Memory next, and before the chatter filter on purpose: a bare "yes" (to "save this as a routine?") and a routine called
    // "today's cause list" both start with words the filter treats as chatter. Only a short, command-sized utterance counts when
    // always-on, the same as any command.
    let handoff: Extract<LocalOutcome, { kind: 'handoff' }> | undefined;
    const memory = this.deps.memory;
    if (memory !== undefined && (req.live !== true || req.text.trim().split(/\s+/).length <= MAX_LIVE_COMMAND_WORDS)) {
      const asked = Date.now();
      const local = await this.askMemory(memory, req.text);
      if (local?.kind === 'answered') {
        // For a routine, ms is the whole run (every step), since there is no model to wait for; for a memory command it is the lookup.
        log.info('handled by local memory', { routine: local.routine, ok: local.ok, ms: Date.now() - asked });
        if (local.routine !== undefined) this.noteActivity({ request: req.text, tools: [], spoken: local.spoken, ok: local.ok, routine: local.routine });
        return this.finish(req, local.spoken, local.ok, { ...(local.routine !== undefined ? { intent: 'run_routine' } : {}), emit });
      }
      if (local?.kind === 'handoff') handoff = local;
    }

    // Everyday commands next (a site, a folder, a file, a download): recognised by shape, carried out by the same tools the model would
    // use, and spoken about in a line — typically in milliseconds instead of a model round trip. Anything it is not sure of returns
    // null and carries on to the model exactly as before. Not while a routine has just handed over to the model.
    const fast = this.deps.local;
    if (fast !== undefined && handoff === undefined && (req.live !== true || req.text.trim().split(/\s+/).length <= MAX_LIVE_COMMAND_WORDS)) {
      const asked = Date.now();
      const done = await this.askLocal(fast, req);
      if (done !== null) return this.finishLocal(req, done, asked, emit);
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

    if (this.deps.ai !== undefined) return this.runAgent(req, emit, handoff);
    return this.respondNoIntent(req, emit);
  }

  /** Looks the request up in local memory. A failure there must never stop Eya answering, so it is logged and treated as "not memory's". */
  private async askMemory(memory: AgentMemory, text: string): Promise<LocalOutcome | null> {
    try {
      const started = Date.now();
      const outcome = await memory.tryHandle(text);
      if (outcome === null) log.debug('memory lookup: no match', { ms: Date.now() - started });
      return outcome;
    } catch (err) {
      log.warn('memory lookup failed; carrying on without it', { err: String(err) });
      return null;
    }
  }

  /** A command the fast path carried out: noted in the history, spoken, and remembered for "open it" / "the second one". */
  private finishLocal(
    req: AgentRequest,
    done: LocalCommandResult,
    asked: number,
    emit: (patch: Omit<AgentUpdate, 'requestId'>) => void,
  ): Promise<AgentResult> {
    log.info('handled locally', { intent: done.intent, ok: done.ok, ms: Date.now() - asked });
    this.noteActivity({
      request: req.text,
      tools: done.tools,
      ...(done.urls !== undefined ? { urls: done.urls } : {}),
      spoken: done.spoken,
      ok: done.ok,
    });
    // A chat step that asks "Send it?" (or "Which one?") is waiting for the person; one that could not finish yet says so itself.
    const pending: PendingSignal | undefined =
      done.pending ??
      (this.deps.tasks !== undefined && done.ok && done.intent.startsWith('chat_') && done.spoken.trimEnd().endsWith('?')
        ? { kind: 'needs_you', why: 'a question', asks: true }
        : undefined);
    return this.finish(req, done.spoken, done.ok, { intent: done.intent, refs: [...done.refs], emit, ...(pending !== undefined ? { pending } : {}) });
  }

  /** A failure in the fast path must never stop Eya answering: it is logged and treated as "not mine". */
  private async askLocal(local: AgentLocal, req: AgentRequest): Promise<LocalCommandResult | null> {
    try {
      return await local.tryHandle(req.text, { live: req.live === true });
    } catch (err) {
      log.warn('local command failed; carrying on without it', { err: String(err) });
      return null;
    }
  }

  /** The history is a convenience: a failure to note something never changes what the user is told. */
  private noteActivity(input: ActivityInput): void {
    const activity = this.deps.activity;
    if (activity === undefined) return;
    this.memorySafely('activity', () => activity.record(input));
  }

  /** Memory must never get in the way of the answer: whatever it does, an error here is logged and ignored. */
  private memorySafely<T>(what: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      log.warn(`memory ${what} failed; ignored`, { err: String(err) });
      return undefined;
    }
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

    this.noteActivity({ request: req.text, tools: [intent.tool], spoken, ok: toolResult.ok });
    return this.finish(req, spoken, toolResult.ok, {
      intent: intent.tool,
      subject: intent.canonicalName,
      refs: [
        { kind: 'application', value: intent.canonicalName },
        ...refsFromToolResult(intent.tool, toolResult),
      ],
      ...(toolResult.error !== undefined ? { error: toolResult.error } : {}),
      emit,
    });
  }

  private async runAgent(
    req: AgentRequest,
    emit: (patch: Omit<AgentUpdate, 'requestId'>) => void,
    handoff?: Extract<LocalOutcome, { kind: 'handoff' }>,
  ): Promise<AgentResult> {
    const { ai, tools, context } = this.deps;
    if (ai === undefined) return this.respondNoIntent(req, emit);

    emit({ state: 'thinking', message: 'Thinking…' });
    const started = Date.now();
    const now = this.deps.now?.() ?? new Date();
    const hint = contextHintText(context);
    const browserNow = this.deps.browserContext?.() ?? '';
    // (A task being carried on already has its own account of itself.)
    const inProgress = req.resume === undefined ? (this.deps.progress?.() ?? '') : '';
    // The conversation so far, when it moved here from another way of talking (Gemini Live gave out): the new AI carries on from it.
    const earlier = describeEarlier(normalizeEarlier(req.history));

    // Memory: start watching this task (so a repeat can be noticed), and tell the model what the user asked it to remember and
    // which routines it can run. A routine that just stopped partway hands over what it did and where it stopped.
    const memory = req.resume === undefined ? this.deps.memory : undefined;
    if (memory !== undefined) {
      const options: BeginOptions =
        handoff === undefined
          ? {}
          : handoff.replacing !== undefined
            ? { replacing: handoff.replacing, ...(handoff.prefix !== undefined ? { prefix: handoff.prefix } : {}) }
            : { viaRoutine: true }; // paused for the user's say-so: nothing wrong with the routine, nothing new to learn
      this.memorySafely('begin', () => memory.beginTask(req.text, options));
    }
    // announce: false — the offer is added to what Eya says in this very reply, so the app must not also speak it as a push.
    const closeTask = (ok: boolean): string | null => (memory === undefined ? null : (this.memorySafely('finish', () => memory.finishTask(ok, { announce: false })) ?? null));
    const remembered = this.deps.memory === undefined ? '' : (this.memorySafely('prompt', () => this.deps.memory?.promptBlock(req.text) ?? '') ?? '');
    const closeRoutine = memory === undefined || handoff !== undefined ? null : (this.memorySafely('hint', () => memory.possibleRoutineHint(req.text)) ?? null);
    const extras = [
      hint,
      browserNow === '' ? undefined : browserNow,
      inProgress === '' ? undefined : inProgress,
      earlier === '' ? undefined : earlier,
      remembered === '' ? undefined : remembered,
      closeRoutine ?? undefined,
      handoff?.hint,
      req.resume === undefined ? undefined : resumeHint(req.resume),
    ].filter((x): x is string => x !== undefined);
    // Only the abilities this request is about travel with it (see toolGroups.ts); the model can ask for the rest with load_tools.
    // A routine that stopped partway may need anything, so it gets everything.
    const recentTools = context
      .recent()
      .slice(-2)
      .flatMap((turn) => (turn.toolUsed === undefined ? [] : [turn.toolUsed]));
    const active: Set<ToolGroup> = handoff === undefined ? routeGroups(req.text, { recentTools }) : new Set(TOOL_GROUPS);
    const everyTool = tools.toAISchema().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    const systemText = (): string => {
      const base = systemPrompt(now, active);
      return extras.length === 0 ? base : `${base}\n\n${extras.join('\n\n')}`;
    };
    const toolsForNow = (): AIToolSpec[] => {
      const chosen: AIToolSpec[] = selectTools(everyTool, active);
      // The valve is only worth sending while something is switched off.
      if (active.size < TOOL_GROUPS.length) chosen.push(LOAD_TOOLS_SPEC);
      return chosen;
    };
    const messages: AIChatMessage[] = [
      { role: 'system', content: systemText() },
      // (The earlier lines already include what the last few requests were, so they are not added twice.)
      ...(earlier === '' ? this.messagesFromContext(context) : []),
      { role: 'user', content: req.text },
    ];
    let toolSpecs = toolsForNow();
    log.info('tools for request', { groups: [...active].sort(), tools: toolSpecs.length, of: everyTool.length });

    let answer = '';
    let lastToolName: string | undefined;
    const toolsUsed: string[] = [];
    const urlsOpened: string[] = [];
    let lastToolOk = true;
    let acknowledged = false;
    let lastCueAt = 0;
    let cuesSpoken = 0;
    let finished = false;
    const allRefs: TurnRef[] = [];

    let retriedWithEverything = false;
    // What worked so far (so a task carried on later does not repeat it), whether a check or sign-in is waiting for the person, and the AI's
    // failure if it was the AI that stopped the request.
    const stepsDone: string[] = [];
    let blockedByPerson = false;
    let aiRetry: { readonly why: string; readonly retryAfterMs: number } | null = null;
    let endedBy: 'time' | null = null;
    const completionMs: number[] = [];
    for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
      if (Date.now() - started > AGENT_BUDGET_MS) {
        log.warn('agent out of time', { step });
        endedBy = 'time';
        break;
      }

      let completion: AICompletion;
      const askedAt = Date.now();
      try {
        completion = await ai.complete(messages, toolSpecs);
        completionMs.push(Date.now() - askedAt);
      } catch (err) {
        log.warn('LLM completion failed', { step, err: String(err) });
        const retry = this.deps.tasks === undefined ? null : retryForAIFailure(err);
        if (step === 0) {
          closeTask(false);
          // An action asked for while the AI is out is not dropped: it is kept, and done when the AI is back. A question is not (an answer
          // that arrives hours later is no use), so the person is told as before.
          if (retry !== null && looksLikeAction(req.text)) {
            return this.respondNoIntent(req, emit, `${describeAIFailure(err)} I'll keep this and do it as soon as it's back, and tell you.`, {
              kind: 'retry',
              why: retry.why,
              retryAfterMs: retry.retryAfterMs,
            });
          }
          return this.respondNoIntent(req, emit, describeAIFailure(err));
        }
        answer = describeAIFailure(err);
        lastToolOk = false;
        finished = true;
        aiRetry = retry;
        break;
      }

      if (completion.toolCalls.length === 0) {
        // Chatter that wasn't a command stays unanswered when always-on.
        if (step === 0 && req.live === true) {
          log.info('ignored live speech: not a command', { text: req.text });
          closeTask(false);
          return this.ignore(req, emit);
        }
        // "I can't do that" while abilities are switched off usually means the one it needs is among them: switch them all on, ask again.
        if (!retriedWithEverything && toolsUsed.length === 0 && active.size < TOOL_GROUPS.length && soundsLikeRefusal(completion.text)) {
          retriedWithEverything = true;
          for (const g of TOOL_GROUPS) active.add(g);
          messages[0] = { role: 'system', content: systemText() };
          toolSpecs = toolsForNow();
          log.info('refusal with abilities off; trying again with everything', { step });
          continue;
        }
        answer = completion.text;
        finished = true;
        break;
      }

      messages.push({ role: 'assistant', content: completion.text, toolCalls: completion.toolCalls });

      // A second round means this is a longer task. Say what is being done, the way a person would ("okay, opening Flipkart"), and, if it
      // goes on, now and then say something else (never the same words twice, never more than a few times, never on top of each other).
      if (step >= 1 && completion.toolCalls.length > 0) {
        const sinceCue = Date.now() - lastCueAt;
        if (!acknowledged || (sinceCue > CUE_AGAIN_MS && cuesSpoken < MAX_CUES)) {
          const next = completion.toolCalls[0];
          const stage = !acknowledged || Date.now() - started < CUE_LONG_MS ? 'start' : 'long';
          acknowledged = true;
          cuesSpoken += 1;
          lastCueAt = Date.now();
          void this.speak(this.cues.pick({ ...(next !== undefined ? { tool: next.name, args: next.args as Record<string, unknown> } : {}), stage }));
        }
      }

      for (const call of completion.toolCalls) {
        emit({ state: 'working', message: tools.statusFor(call.name) });
        log.info('tool call', { step, name: call.name, args: call.args });
        const toolStarted = Date.now();
        let result: ToolResult;
        if (call.name === LOAD_TOOLS_SPEC.name) {
          // Answered here: switch the groups on, and from the next step the model sees their tools and their part of the prompt.
          const asked = parseGroups(String((call.args as ToolArgs)['groups'] ?? ''));
          const fresh = [...asked.groups].filter((g) => !active.has(g));
          for (const g of asked.groups) active.add(g);
          messages[0] = { role: 'system', content: systemText() };
          toolSpecs = toolsForNow();
          log.info('tools loaded', { asked: [...asked.groups], fresh, unknown: asked.unknown });
          result =
            asked.groups.size === 0
              ? { ok: false, summary: 'no such group', error: `Unknown group. Choose from: ${TOOL_GROUPS.join(', ')}.` }
              : {
                  ok: true,
                  summary: fresh.length === 0 ? 'Those were already on.' : `Switched on: ${fresh.join(', ')}. Use their tools now.`,
                };
        } else {
          result = await tools.invoke(call.name, call.args as ToolArgs);
        }
        log.info('tool result', {
          name: call.name,
          ok: result.ok,
          ms: Date.now() - toolStarted,
          // Why it did not work, so a failure in the log is diagnosable rather than just "ok: false".
          ...(result.ok ? {} : { summary: result.summary, ...(result.error !== undefined ? { error: result.error.slice(0, 240) } : {}) }),
        });
        // Switching abilities on is the engine's own housekeeping: it is not something the user asked for, so it is not recorded as a step.
        if (call.name !== LOAD_TOOLS_SPEC.name) {
          lastToolName = call.name;
          lastToolOk = result.ok;
          toolsUsed.push(call.name);
          if (call.name === 'open_website' && typeof (call.args as ToolArgs)['url'] === 'string') urlsOpened.push((call.args as ToolArgs)['url'] as string);
          if (memory !== undefined) this.memorySafely('observe', () => memory.observeTool(call.name, call.args as ToolArgs, result));
          allRefs.push(...refsFromToolResult(call.name, result));
          // (Waiting for the person is not a step that was done.)
          if (result.ok && call.name !== 'wait_for_user_in_browser') {
            const line = describeStep(call.name, call.args as ToolArgs);
            if (line !== null) stepsDone.push(line);
          }
          // A CAPTCHA, a sign-in or a code is the person's to do: the request is waiting for them until a later step works.
          if (result.data?.['needsUser'] === true) blockedByPerson = true;
          else if (result.ok && (call.name !== 'wait_for_user_in_browser' || result.data?.['userFinished'] === true)) blockedByPerson = false;
        }
        messages.push({
          role: 'tool',
          name: call.name,
          toolCallId: call.id,
          content: toolResultForModel(result),
        });
      }
    }

    const keeping = this.deps.tasks !== undefined;
    if (!finished && answer.length === 0) {
      answer =
        keeping && endedBy === 'time'
          ? "That's taking a while. I'll keep going in the background and tell you as soon as it's done."
          : describeGaveUp(endedBy ?? 'steps', completionMs, toolsUsed.length);
      lastToolOk = false;
    }
    let spoken = cleanForSpeech(answer) || (lastToolOk ? 'Done.' : "That didn't work.");
    // The AI you chose could not answer and another one did: say so, so it does not look as though your choice was ignored.
    const aiNote = completionMs.length > 0 ? this.deps.aiNote?.() ?? null : null;
    if (aiNote !== null) spoken = `${aiNote} ${spoken}`;
    // What did not simply finish is kept as a task (see AgentResult.pending): to be tried again, or to wait for the person.
    let pending: PendingSignal | undefined;
    if (keeping) {
      if (aiRetry !== null) {
        pending = { kind: 'retry', why: aiRetry.why, retryAfterMs: aiRetry.retryAfterMs, steps: [...stepsDone] };
        spoken = `${spoken} I'll try again when it's back and tell you.`;
      } else if (endedBy === 'time') {
        pending = { kind: 'retry', why: 'it is taking a while', retryAfterMs: 20_000, steps: [...stepsDone] };
      } else if (blockedByPerson) {
        pending = { kind: 'needs_you', why: 'a check or sign-in in your browser', watch: 'browser', steps: [...stepsDone] };
      } else if (finished && lastToolOk && toolsUsed.length > 0 && asksForGoAhead(spoken)) {
        pending = { kind: 'needs_you', why: 'a question', asks: true, steps: [...stepsDone] };
      }
    }
    log.info('agent finished', { steps: messages.filter((m) => m.role === 'assistant').length, ms: Date.now() - started });

    // The task counts as done only if the model finished on its own, the last thing it did worked, and it is not waiting on the user
    // (a reply that ends in a question is the model asking, not finishing). If it has now worked the same way several times, the
    // offer to save it as a routine is added to what is said.
    const taskDone = finished && lastToolOk && !spoken.trimEnd().endsWith('?');
    this.noteActivity({ request: req.text, tools: toolsUsed, urls: urlsOpened, spoken, ok: taskDone });
    const offer = closeTask(taskDone);
    if (offer !== null) spoken = `${spoken}${/[.!?]$/.test(spoken.trimEnd()) ? '' : '.'} ${offer}`;

    return this.finish(req, spoken, lastToolOk, {
      ...(lastToolName !== undefined ? { intent: lastToolName } : {}),
      refs: allRefs,
      emit,
      ...(pending !== undefined ? { pending } : {}),
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
    pending?: PendingSignal,
  ): Promise<AgentResult> {
    const spoken = override ?? "I don't know how to do that yet.";
    const text = 'text' in req ? req.text : '';
    return this.finish({ requestId: req.requestId, text, source: 'text' }, spoken, false, { emit, ...(pending !== undefined ? { pending } : {}) });
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
      readonly refs?: readonly TurnRef[];
      readonly pending?: PendingSignal;
      readonly emit: (patch: Omit<AgentUpdate, 'requestId'>) => void;
    },
  ): Promise<AgentResult> {
    extras.emit({ state: 'speaking', message: spoken });
    await this.speak(spoken);
    extras.emit({ state: 'idle' });

    const refs =
      extras.refs ??
      (extras.subject !== undefined ? [{ kind: 'application' as const, value: extras.subject }] : []);
    this.deps.context.push({
      at: Date.now(),
      userText: req.text,
      ...(extras.intent !== undefined ? { intent: extras.intent, toolUsed: extras.intent } : {}),
      reply: spoken,
      ok,
      refs,
    });

    return {
      requestId: req.requestId,
      ok,
      spoken,
      ...(extras.error !== undefined ? { error: extras.error } : {}),
      ...(extras.pending !== undefined ? { pending: extras.pending } : {}),
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

/**
 * A short, unspoken addendum to the system prompt naming the most recent file
 * and folder the conversation touched, so "copy it to Desktop" or "put it in
 * that folder" resolves reliably. The literal path only ever lives here and
 * in tool results — never in what gets spoken — since the spoken reply says
 * "your Downloads folder", not the path itself.
 */
export function contextHintText(context: ConversationContext): string | undefined {
  const files = context.lastRefsOfKind('file');
  const folder = context.lastRefOfKind('folder');
  if (files.length === 0 && folder === undefined) return undefined;
  const parts: string[] = [];
  if (files.length === 1) {
    parts.push(`The file most recently found, opened, or touched is: ${files[0]?.value}`);
  } else if (files.length > 1) {
    const listed = files
      .map((f, i) => `${i + 1}. ${(f.meta?.['name'] as string | undefined) ?? f.value} — ${f.value}`)
      .join('\n');
    parts.push(
      `The most recent file search found these, newest first (resolve "the first/second one", "the <name> one", etc. against this list):\n${listed}`,
    );
  }
  if (folder !== undefined) parts.push(`The folder most recently created or touched is: ${folder.value}`);
  return (
    `Conversation context (not something to say aloud; use it to resolve "it", "that file", "the folder", etc.):\n` +
    `${parts.join('\n')}\nIf the user clearly means something else, use that instead.`
  );
}

const FOLDER_TOOLS = new Set(['create_folder', 'open_folder', 'delete_folder']);

/**
 * What a tool result implies for "it"/"that file"/"the folder" resolution
 * later. A tool that returns a `path` is remembered as the most recent
 * file or folder touched; `find_file`'s first (newest) match counts too.
 * These feed `ConversationContext`, whose `lastRefOfKind` already existed for
 * exactly this purpose.
 */
/** How many of a multi-file search result are worth remembering for "the second one"/"the cause list one". */
const MAX_SEARCH_REFS = 10;

export function refsFromToolResult(toolName: string, result: ToolResult): TurnRef[] {
  if (!result.ok || result.data === undefined) return [];
  const refs: TurnRef[] = [];
  const path = result.data['path'];
  if (typeof path === 'string') {
    refs.push({ kind: FOLDER_TOOLS.has(toolName) ? 'folder' : 'file', value: path });
  }
  const files = result.data['files'];
  if (Array.isArray(files)) {
    files.slice(0, MAX_SEARCH_REFS).forEach((entry, index) => {
      const f = entry as { path?: unknown; name?: unknown } | undefined;
      if (f !== undefined && typeof f.path === 'string') {
        refs.push({
          kind: 'file',
          value: f.path,
          meta: { index, ...(typeof f.name === 'string' ? { name: f.name } : {}) },
        });
      }
    });
  }
  return refs;
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
