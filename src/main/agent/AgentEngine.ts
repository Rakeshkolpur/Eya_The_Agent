import { rootLogger } from '@main/logging/logger';
import type { RequestHandler, AudioHandler } from '@main/ipc/ipcRouter';
import type { AgentRequest, AgentResult, AgentUpdate } from '@shared/types';
import type { AudioRequest } from '@shared/ipcContract';
import { DEFAULT_LANGUAGE, languageRule } from '@shared/language';
import type { EyaLanguage } from '@shared/language';
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
import { OllamaError } from '@main/providers/ai/OllamaAIProvider';
import { attachmentsHint } from '@shared/attachments';
import { AGENT_HINT, CHAT_TOOLS, chatSystemPrompt, isBlockedSiteResult, pointsToAgent, wantedAfterSite, wantsAgent } from './agentMode';
import { accountDiscoveryPlan, attribution, classifyToolFailure, describeClick, discoverSite, planClick, planDiscovery, refusalOf, withLegalOptions } from './discovery';
import type { Finding } from './discovery';
import { lookQuestion, newLookState, shouldLook, targetOf, withScreenLook } from './autoLook';
import { SHOP_SITES, productFromRequest, runShopOrder } from './shopRunner';
import { PENDING_MS, continueCheckout } from './checkoutRunner';
import type { CheckoutResult, PendingCheckout } from './checkoutRunner';
import { aboutTheScreen, asksToLogIn, browserAccessNudge, claimsNoBrowserAccess, claimsNoLogin, loginNudge } from './browserClaims';
import { withoutInventedNumbers } from './factGuard';
import { readTextToolCalls } from './textToolCalls';
import type { TextCallVerdict } from './textToolCalls';
import { traceEvent } from './trace';
import { STOPPED_SPOKEN, abortable, isStopped as isStoppedError, stoppedResult, wasAborted } from './stopping';
import { SIDE_EFFECT_TOOLS, callKey } from '@main/tasks/ledger';
import type { DoneCall } from '@shared/tasks';
import { canRunTogether, shortenOlderResults, startTogether } from './history';
import { summarize, tokensSinceStart, withMeter } from '@main/providers/ai/tokenMeter';
import { browseFocus, groupOfTool, LOAD_TOOLS_SPEC, OPENS_GROUP, OPENS_TOPIC, PROMPT_TOPICS, parseGroups, routeGroups, routeTopics, selectTools, TOOL_GROUPS } from './toolGroups';
import type { PromptTopic } from './prompts';
import type { ToolGroup } from './toolGroups';
import type { PendingSignal } from '@shared/tasks';
import { TIME_RETRY_WHY } from '@shared/tasks';
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
/** How many times a model that writes its tool calls as plain text is told to use the real ones before the request is given up on. */
const MAX_TEXT_CALL_REPAIRS = 2;
const TEXT_CALL_GAVE_UP = "I couldn't carry that out: the AI kept writing its steps as plain text that I can't run, so nothing was done. Please try again, or ask me in other words.";

/** What the model is told when its answer was a tool call written as text that cannot be run. */
function textCallRepairNote(verdict: Extract<TextCallVerdict, { kind: 'invalid' }>, offered: readonly string[]): string {
  return (
    `(Eya) Your last reply was text written like a tool call, but ${verdict.reason}. Never write a tool call as text: use the tools through the tool-calling interface, ` +
    `and only ones you were given (${offered.slice(0, 14).join(', ')}). Nothing you wrote was run. Carry on with the person's request with a real tool call, or answer in plain words.`
  );
}
const AGENT_BUDGET_MS = 90_000;
/** Once the browser is in use the request may take longer: finding the right site and then doing the task on it is more than a chat answer. */
const AGENT_BROWSER_BUDGET_MS = 180_000;
const BROWSER_TOOLS = new Set(['open_website', 'find_and_open_website', 'download_from_site', 'click_on_page', 'fill_on_page', 'inspect_page', 'find_on_page', 'read_page', 'scroll_page']);
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
  // The local AI says for itself what is wrong (Ollama is not running, the model is not installed…) and what to do about it.
  if (err instanceof OllamaError) return err.userMessage;
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
  /**
   * What the model is told about its access to a browser (connected and ready, or exactly what is missing), for a request that is about a website. See
   * browser/browserAccess.ts: a model that is not told it has hands in the user's browser guesses, and the guess is "share your screen".
   */
  readonly browserAccess?: () => string;
  /**
   * Looks at the screen when a click or fill did not find its target (see autoLook.ts): given the question, answers what the screen shows, or null when it
   * cannot or must not (the setting is off, not the person's own browser, no picture reader). Never asks the person.
   */
  readonly autoLook?: (question: string) => Promise<string | null>;
  /** What is in progress (the tasks Eya is keeping), so what the user says next is understood in that light. See tasks/progress.ts. */
  readonly progress?: () => string;
  /** The language every answer is asked to be in (see shared/language.ts). English when not given. */
  readonly language?: () => EyaLanguage;
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
  /** Where the files attached to a message are noted, so the document tool may read them wherever they are (see AttachedFiles). */
  readonly attached?: { allow(paths: readonly string[]): void };
  /** Called when tools start working on a request: until then it is only a conversation, and a conversation is never shown as a task. */
  readonly workStarted?: (requestId: string) => void;
  /**
   * Called each time a request has done something that cannot be done twice (a file moved, a setting changed): the steps so far and the exact calls
   * that worked, so that a request that is cut off (Eya closed, the AI out) is carried on from there and does not repeat them.
   */
  readonly checkpoint?: (requestId: string, progress: { readonly steps: readonly string[]; readonly done: readonly DoneCall[] }) => void;
  /**
   * Whether the person has stopped this request (cancelled its task). Asked between steps: a request that was stopped does not go on with the rest of its
   * steps (each of which can change something, and each AI step costs tokens), whatever it was in the middle of finishes and no more is begun.
   */
  readonly shouldStop?: (requestId: string) => boolean;
  /**
   * Waits while the person has paused the work (the Pause button). Asked before each AI step and each tool, so that Pause holds the whole request and
   * not only the browser. Returns when the work is resumed, or at once when the request is stopped.
   */
  readonly waitWhilePaused?: (signal: AbortSignal | undefined) => Promise<void>;
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
  /** A checkout that stopped for the person's answer (which address, how to pay, whether to place it): their next short message is read as that answer. See checkoutRunner.ts. */
  private pendingCheckout: PendingCheckout | null = null;

  constructor(private readonly deps: AgentDeps) {}

  /** The requests being worked on, each with the signal that stops it. */
  private readonly active = new Map<string, AbortController>();

  private signalOf(requestId: string): AbortSignal | undefined {
    return this.active.get(requestId)?.signal;
  }

  private isStopped(requestId: string): boolean {
    return wasAborted(this.signalOf(requestId));
  }

  /** Stops one request on the spot. True when it was being worked on. */
  stopRequest(requestId: string): boolean {
    const controller = this.active.get(requestId);
    if (controller === undefined || controller.signal.aborted) return false;
    controller.abort();
    return true;
  }

  /** Stops every request that is being worked on, on the spot. Returns how many there were. */
  stopAll(): number {
    let stopped = 0;
    for (const id of [...this.active.keys()]) if (this.stopRequest(id)) stopped += 1;
    // (Stop also silences her: the answer may already be back and be being read aloud)
    try {
      this.deps.tts.stop();
    } catch {
      /* nothing was being said */
    }
    return stopped;
  }

  /**
   * Runs a request so that Stop ends it at once. The work goes on in its own time (what is in flight, an AI answer being waited for, a tool running, is
   * cancelled or let go of), but whoever asked gets "Okay, I stopped." in the moment Stop is pressed, the chat box is released, the voice is silenced and
   * nothing more is said about it.
   */
  private async supervised(requestId: string, onUpdate: (u: AgentUpdate) => void, run: (guarded: (u: AgentUpdate) => void) => Promise<AgentResult>): Promise<AgentResult> {
    const controller = new AbortController();
    this.active.set(requestId, controller);
    // (after Stop nothing more of this request reaches the screen)
    const guarded = (u: AgentUpdate): void => {
      if (!controller.signal.aborted) onUpdate(u);
    };
    const running = run(guarded);
    const forget = (): void => void this.active.delete(requestId);
    running.then(forget, forget);
    const stopped = new Promise<AgentResult>((resolve) => {
      const go = (): void => resolve(stoppedResult(requestId));
      if (controller.signal.aborted) go();
      else controller.signal.addEventListener('abort', go, { once: true });
    });
    const result = await Promise.race([running, stopped]);
    if (!controller.signal.aborted) return result;
    log.info('stopped by the person', { requestId });
    try {
      this.deps.tts.stop();
    } catch {
      /* nothing was being said */
    }
    onUpdate({ requestId, state: 'idle', message: '' });
    return result.error === 'stopped' ? result : stoppedResult(requestId);
  }

  /** Runs one request with its own token count (every AI answer that comes back for it adds to it) and puts the count on the result and in the log. */
  private async counted(requestId: string, run: () => Promise<AgentResult>): Promise<AgentResult> {
    const { result, tokens, owner } = await withMeter(run);
    // (a spoken request is transcribed and then handled as text: the count belongs to the one that began it, and is reported once)
    if (!owner || tokens.calls === 0) return result;
    const summary = summarize(tokens);
    const detail = { requestId, ...summary, byProvider: tokens.byProvider, sinceStart: tokensSinceStart() };
    log.info('tokens for request', detail);
    traceEvent('tokens', detail);
    return { ...result, tokens: summary };
  }

  async handleAudio(req: AudioRequest, onUpdate: (u: AgentUpdate) => void): Promise<AgentResult> {
    return this.supervised(req.requestId, onUpdate, (guarded) => this.counted(req.requestId, () => this.handleAudioRequest(req, guarded)));
  }

  private async handleAudioRequest(
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
    // (a spoken request is transcribed and then handled as text: it is being supervised already, and is not set up a second time)
    if (this.active.has(req.requestId)) return this.counted(req.requestId, () => this.handleRequest(req, onUpdate));
    return this.supervised(req.requestId, onUpdate, (guarded) => this.counted(req.requestId, () => this.handleRequest(req, guarded)));
  }

  private async handleRequest(req: AgentRequest, onUpdate: (u: AgentUpdate) => void): Promise<AgentResult> {
    // Plain chat (Agent mode off): answered as a conversation. It is not wrapped in the task keeper, so it never becomes a task or opens a panel.
    if (req.mode === 'chat' && req.live !== true && req.resume === undefined) return this.handleChat(req, onUpdate);
    // A task Eya carries on by herself is already being kept: it is not wrapped again (that would make each go a new task).
    const around = this.deps.around;
    if (around === undefined || req.resume !== undefined) return this.handleNow(req, onUpdate);
    return around(req, () => this.handleNow(req, onUpdate));
  }

  /** Agent mode is off: the person is talking. What needs the computer or a browser is said to need Agent mode; everything else is answered. */
  private async handleChat(req: AgentRequest, onUpdate: (u: AgentUpdate) => void): Promise<AgentResult> {
    const emit = (patch: Omit<AgentUpdate, 'requestId'>) => onUpdate({ requestId: req.requestId, ...patch });
    emit({ state: 'thinking' });
    // "What are you working on", "cancel the task": about the tasks already kept, so still answered.
    const taskCommands = this.deps.tasks;
    if (taskCommands !== undefined) {
      const done = await this.askLocal(taskCommands, req);
      if (done !== null) return this.finish(req, done.spoken, done.ok, { intent: done.intent, emit });
    }
    // An everyday command is what Agent mode is for: said at once, with a button, instead of an answer made up by the AI.
    if ((req.attachments === undefined || req.attachments.length === 0) && wantsAgent(req.text)) {
      return this.finish(req, AGENT_HINT, true, { emit, suggestAgent: true, speakInBackground: true });
    }
    return this.runChat(req, emit);
  }

  /** Plain chat: the AI answers; it may look a fact up on the web or read an attached file, and nothing else. */
  private async runChat(req: AgentRequest, emit: (patch: Omit<AgentUpdate, 'requestId'>) => void): Promise<AgentResult> {
    const { ai, tools, context } = this.deps;
    if (ai === undefined) return this.respondNoIntent(req, emit);
    emit({ state: 'thinking', message: 'Thinking…' });
    const now = this.deps.now?.() ?? new Date();
    const earlier = describeEarlier(normalizeEarlier(req.history));
    const attached = req.attachments !== undefined && req.attachments.length > 0 ? req.attachments : undefined;
    if (attached !== undefined) this.deps.attached?.allow(attached.map((a) => a.path));
    const system = [chatSystemPrompt(now), languageRule(this.deps.language?.() ?? DEFAULT_LANGUAGE), earlier === '' ? undefined : earlier, attached === undefined ? undefined : attachmentsHint(attached)]
      .filter((x): x is string => x !== undefined)
      .join('\n\n');
    const specs: AIToolSpec[] = tools
      .toAISchema()
      .filter((s) => CHAT_TOOLS.has(s.name))
      .map((s) => ({ name: s.name, description: s.description, parameters: s.parameters }));
    const messages: AIChatMessage[] = [{ role: 'system', content: system }, ...(earlier === '' ? this.messagesFromContext(context) : []), { role: 'user', content: req.text }];
    const askedAt = Date.now();
    const chatSignal = this.signalOf(req.requestId);
    let answer = '';
    // (a question, a search or two, then the answer; every attached file may take a turn of its own to be read)
    const maxSteps = Math.min(4 + (attached?.length ?? 0), 12);
    let chatRepaired = false;
    for (let step = 0; step < maxSteps; step += 1) {
      let completion: AICompletion;
      // Paused: nothing more is begun until it is resumed (Stop ends the wait at once).
      await this.deps.waitWhilePaused?.(chatSignal);
      if (this.isStopped(req.requestId)) return stoppedResult(req.requestId);
      try {
        completion = await ai.complete(messages, specs, { onPartial: (soFar) => emit({ state: 'thinking', partial: soFar }), ...(chatSignal !== undefined ? { signal: chatSignal } : {}) });
      } catch (err) {
        if (this.isStopped(req.requestId) || isStoppedError(err)) return stoppedResult(req.requestId);
        log.warn('chat completion failed', { step, err: String(err) });
        return this.respondNoIntent(req, emit, describeAIFailure(err));
      }
      // (a tool call written as text: run if it is a real tool of this mode, otherwise never shown — see textToolCalls.ts)
      if (completion.toolCalls.length === 0 && completion.text.trim() !== '') {
        const verdict = readTextToolCalls(completion.text, specs.map((s) => s.name));
        if (verdict.kind === 'calls') {
          completion = { ...completion, text: '', toolCalls: verdict.calls.map((c, i) => ({ id: `text_${step}_${i}`, name: c.name, args: c.args })) };
        } else if (verdict.kind === 'invalid') {
          log.warn('a chat answer was a tool call that cannot be run: not shown', { step, reason: verdict.reason });
          if (step + 1 < maxSteps && !chatRepaired) {
            chatRepaired = true;
            messages.push({ role: 'user', content: textCallRepairNote(verdict, specs.map((s) => s.name)) });
            continue;
          }
          answer = TEXT_CALL_GAVE_UP;
          break;
        }
      }
      if (completion.toolCalls.length === 0) {
        answer = completion.text;
        break;
      }
      messages.push({ role: 'assistant', content: completion.text, toolCalls: completion.toolCalls });
      const together = canRunTogether(completion.toolCalls) ? startTogether(completion.toolCalls.map((c) => () => tools.invoke(c.name, c.args as ToolArgs))) : null;
      for (const [callIndex, call] of completion.toolCalls.entries()) {
        emit({ state: 'thinking', message: tools.statusFor(call.name) });
        let result: ToolResult;
        try {
          result = !CHAT_TOOLS.has(call.name) ? { ok: false, summary: 'needs Agent mode', error: 'That needs Agent mode.' } : await abortable(together !== null ? (together[callIndex] as Promise<ToolResult>) : tools.invoke(call.name, call.args as ToolArgs), chatSignal);
        } catch (err) {
          if (isStoppedError(err)) return stoppedResult(req.requestId);
          throw err;
        }
        messages.push({ role: 'tool', name: call.name, toolCallId: call.id, content: toolResultForModel(result) });
      }
    }
    const ok = answer.trim() !== '';
    answer = withoutInventedNumbers(answer, messages.filter((m) => m.role !== 'assistant').map((m) => m.content)).text;
    let spoken = cleanForSpeech(answer) || "I couldn't put an answer together just now. Could you ask me again?";
    const aiNote = this.deps.aiNote?.() ?? null;
    if (aiNote !== null) spoken = `${aiNote} ${spoken}`;
    log.info('chat answered', { ms: Date.now() - askedAt });
    return this.finish(req, spoken, ok, { emit, ...(pointsToAgent(spoken) ? { suggestAgent: true } : {}) });
  }

  private async handleNow(req: AgentRequest, onUpdate: (u: AgentUpdate) => void): Promise<AgentResult> {
    const emit = (patch: Omit<AgentUpdate, 'requestId'>) =>
      onUpdate({ requestId: req.requestId, ...patch });

    emit({ state: 'thinking' });

    // A message with files attached goes straight to the AI. The quick commands read the words alone and would act on them ("message Ravi that
    // this is the report") without the files.
    if (req.attachments !== undefined && req.attachments.length > 0 && this.deps.ai !== undefined) {
      this.deps.attached?.allow(req.attachments.map((a) => a.path));
      return this.runAgent(req, emit);
    }

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
    // What stops this request: Stop cancels the AI answer being waited for and lets go of any tool that is running.
    const signal = this.signalOf(req.requestId);
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
      req.attachments !== undefined && req.attachments.length > 0 ? attachmentsHint(req.attachments) : undefined,
    ].filter((x): x is string => x !== undefined);
    // Only the abilities this request is about travel with it (see toolGroups.ts); the model can ask for the rest with load_tools.
    // A routine that stopped partway may need anything, so it gets everything.
    const recentTools = context
      .recent()
      .slice(-2)
      .flatMap((turn) => (turn.toolUsed === undefined ? [] : [turn.toolUsed]));
    const active: Set<ToolGroup> = handoff === undefined ? routeGroups(req.text, { recentTools }) : new Set(TOOL_GROUPS);
    const topics: Set<PromptTopic> = handoff === undefined ? routeTopics(req.text, { recentTools }) : new Set(PROMPT_TOPICS);
    const everyTool = tools.toAISchema().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    const rule = languageRule(this.deps.language?.() ?? DEFAULT_LANGUAGE);
    // A request that has settled into the browser goes on without the tools and instructions about the PC itself (see browseFocus); never on the first step.
    let focused = false;
    let pcOn = false;
    const systemText = (): string => {
      const base = `${systemPrompt(now, active, topics, focused)}\n\n${rule}`;
      // (what the model's hands in the browser are, for a request that is about a website: said every time the browser group is on, so it is never left to guess)
      const access = active.has('browser') ? (this.deps.browserAccess?.() ?? '') : '';
      const all = access === '' ? extras : [...extras, access];
      return all.length === 0 ? base : `${base}\n\n${all.join('\n\n')}`;
    };
    const toolsForNow = (): AIToolSpec[] => {
      const chosen: AIToolSpec[] = selectTools(everyTool, active, topics, focused);
      // The valve is only worth sending while something is switched off.
      if (active.size < TOOL_GROUPS.length || focused) chosen.push(LOAD_TOOLS_SPEC);
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
    // The attached files are the files "it" and "that file" mean in the next message.
    const allRefs: TurnRef[] = (req.attachments ?? []).map((a) => ({ kind: 'file' as const, value: a.path, meta: { name: a.name } }));

    let retriedWithEverything = false;
    // How many times the model wrote a tool call as plain text that could not be run (see textToolCalls.ts).
    let textCallRepairs = 0;
    // How many times the model said it cannot work in the browser (or asked for the screen to be shared) while it can (see browserClaims.ts), and whether a
    // browser step has really reported that no browser is there (then what it says may be true, and it is not argued with).
    let browserClaimNudges = 0;
    let browserUnavailable = false;
    // Said once: a blocked site named in the model's own tool call gets the lawful options for the film looked up too (see below).
    let legalLookedFor = false;
    // Where each thing that went wrong came from (the AI declining is not the browser failing), the page Eya herself opened, and what was
    // already done in plain words for the person (for when the AI cannot go on).
    const findings: Finding[] = [];
    let openedPage: { readonly title: string; readonly host: string } | null = null;
    let discoveryLine = '';
    let finalRefusal = false;
    // Set when the application's own step has already done everything that was asked (the site is open and checked, and nothing more was wanted):
    // the answer is what it did, and no AI call is made for it (a round trip of about 20,000 tokens to say "opened").
    let doneByEya: string | null = null;
    // What worked so far (so a task carried on later does not repeat it), whether a check or sign-in is waiting for the person, and the AI's
    // failure if it was the AI that stopped the request.
    const stepsDone: string[] = [];
    // The calls that changed something and worked: those from before when a task is being carried on, and those made now. A call that matches one of the
    // earlier ones is not made again.
    const completedCalls: DoneCall[] = [...(req.resume?.done ?? [])];
    const alreadyDone = new Map<string, string>(completedCalls.map((d) => [d.key, d.summary]));
    let blockedByPerson = false;
    let aiRetry: { readonly why: string; readonly retryAfterMs: number } | null = null;
    let endedBy: 'time' | null = null;
    let stoppedByPerson = false;
    // (clicks that found nothing, and the looks at the screen made because of them: see autoLook.ts)
    const lookState = newLookState();
    const completionMs: number[] = [];

    // Finding a website is the application's job, not something the model has to agree to: when the request names a site or gives an address, Eya
    // looks it up, opens it in her browser and checks that the page really loaded BEFORE the model is asked anything. The model then gets what
    // really happened (the page, or exactly where it stopped and whose rule or error that was) and decides what comes next.
    // (a shop, food or travel site the person uses with their own account — "open swiggi and login", "login filpkart and order …" — is opened the same way, and whether they are signed in
    // is read from the page and told to the model, instead of the model guessing: it said "you need to log in" to people who were signed in)
    // The person's answer to a checkout that stopped for it ("UPI", "the second one", "yes"): read for what it was waiting for, by the application, with no AI call. Anything that is not
    // such an answer (a long message, another request) leaves it to the ordinary way, and a checkout older than 20 minutes is forgotten.
    let answeredCheckout: CheckoutResult | null = null;
    const waiting = this.pendingCheckout;
    if (waiting !== null && Date.now() - waiting.at >= PENDING_MS) this.pendingCheckout = null;
    else if (waiting !== null && req.live !== true && req.mode !== 'chat' && req.attachments === undefined && req.text.trim().split(/\s+/).length <= 8 && tools.get('click_on_page') !== undefined && tools.get('inspect_page') !== undefined) {
      const gone = (): ToolResult => ({ ok: false, summary: 'stopped', error: 'stopped' });
      this.deps.workStarted?.(req.requestId);
      answeredCheckout = await continueCheckout(
        { invoke: (n, a) => abortable(tools.invoke(n, a, { lenient: true }), signal).catch((err: unknown) => (isStoppedError(err) ? gone() : Promise.reject(err))), say: (message) => emit({ state: 'working', message }), stopped: () => this.isStopped(req.requestId) },
        waiting,
        req.text,
      );
      if (answeredCheckout !== null) {
        this.pendingCheckout = answeredCheckout.pending;
        for (const name of answeredCheckout.tools) toolsUsed.push(name);
        stepsDone.push(...answeredCheckout.steps);
        if (answeredCheckout.needsUser) blockedByPerson = true;
        log.info('the application went on with the checkout from the person\'s answer', { stage: waiting.stage, answered: answeredCheckout.answer !== null, steps: answeredCheckout.steps.length });
        if (answeredCheckout.answer !== null) {
          doneByEya = answeredCheckout.answer;
          discoveryLine = answeredCheckout.answer;
        } else if (answeredCheckout.note !== '') {
          messages[messages.length - 1] = { role: 'user', content: `${req.text}\n\n(From Eya, not from the user.) ${answeredCheckout.note}` };
        }
      }
    }
    const plan = answeredCheckout === null && req.live !== true && req.resume === undefined && req.attachments === undefined && req.mode !== 'chat' && tools.get('find_and_open_website') !== undefined ? (planDiscovery(req.text) ?? accountDiscoveryPlan(req.text)) : null;
    if (plan !== null) {
      this.deps.workStarted?.(req.requestId);
      // (stopped while it was finding the site: the wait ends at once, as a step that did not work; the loop below sees the Stop and ends the request)
      const gone = (): ToolResult => ({ ok: false, summary: 'stopped', error: 'stopped' });
      const found = await discoverSite(plan, req.text, { invoke: (n, a) => abortable(tools.invoke(n, a), signal).catch((err: unknown) => (isStoppedError(err) ? gone() : Promise.reject(err))), say: (message) => emit({ state: 'working', message }), resultText: toolResultForModel });
      findings.push(...found.findings);
      toolsUsed.push('find_and_open_website');
      lastToolName = 'find_and_open_website';
      lastToolOk = found.opened;
      blockedByPerson = found.needsUser;
      discoveryLine = found.line;
      // (a blocked site already had its lawful options looked up in that step: the model asking for the same site again does not repeat it)
      if (found.findings.some((f) => f.source === 'application_policy')) legalLookedFor = true;
      if (found.opened && (plan.then === '' || found.finished === true)) doneByEya = found.line;
      if (found.opened) {
        stepsDone.push(found.step);
        if (found.page !== null) {
          openedPage = { title: found.page.title, host: found.page.host };
          urlsOpened.push(found.page.url);
        }
      }
      // "login flipkart and order <phone>" on a shop where the person is (or may be) signed in: the application does the steps itself, with no AI call (search, the phone that is
      // really the one named, the variant, Add to cart / Buy, the cart or checkout it leads to) and stops where the person decides, before anything is paid or placed. Where it
      // cannot go on, the model is given the steps done and carries on from the page; a sign-in wall is the person's.
      let shopNote = '';
      if (found.opened && !found.needsUser && found.finished !== true && doneByEya === null && plan.account?.intent === 'order' && SHOP_SITES.has(plan.account.site.id) && found.signIn?.answer !== 'no' && tools.get('fill_on_page') !== undefined && tools.get('click_on_page') !== undefined && tools.get('inspect_page') !== undefined) {
        const product = productFromRequest(req.text);
        if (product !== '') {
          const gone = (): ToolResult => ({ ok: false, summary: 'stopped', error: 'stopped' });
          const ran = await runShopOrder(
            { invoke: (n, a) => abortable(tools.invoke(n, a, { lenient: true }), signal).catch((err: unknown) => (isStoppedError(err) ? gone() : Promise.reject(err))), say: (message) => emit({ state: 'working', message }), stopped: () => this.isStopped(req.requestId) },
            { site: plan.account.site.name, siteId: plan.account.site.id, product },
          );
          for (const name of ran.tools) toolsUsed.push(name);
          this.pendingCheckout = ran.pending ?? null;
          stepsDone.push(...ran.steps);
          if (ran.tools.length > 0) lastToolName = ran.tools[ran.tools.length - 1] as string;
          if (ran.needsUser) blockedByPerson = true;
          log.info('the application ran the order itself', { site: plan.account.site.name, product, steps: ran.steps.length, answered: ran.answer !== null, needsUser: ran.needsUser });
          if (ran.answer !== null) {
            doneByEya = ran.answer;
            discoveryLine = ran.answer;
          } else if (ran.steps.length > 0) {
            shopNote = ran.note;
            discoveryLine = `${found.line} I ${ran.steps.join(', then ').toLowerCase()}.`;
          }
        }
      }
      // "...and click X": when what is left of the request is one plain click, Eya makes it herself with the same tool the model would use (so every check on a
      // click applies), and judges it only from the page that comes back. A click the page showed to work, with nothing else asked, is the answer — no AI call;
      // anything else goes to the model with what happened, so it does not repeat the click.
      let note = shopNote === '' ? found.note : `${found.note}\n${shopNote}`;
      // (an account-site request is the whole sentence the person said, never "one plain click")
      const label = found.opened && !found.needsUser && plan.account === undefined ? planClick(plan.then) : null;
      if (label !== null && tools.get('click_on_page') !== undefined) {
        emit({ state: 'working', message: tools.statusFor('click_on_page') });
        let clicked: ToolResult;
        try {
          clicked = await abortable(tools.invoke('click_on_page', { text: label }, { lenient: true }), signal);
        } catch (err) {
          if (!isStoppedError(err)) throw err;
          clicked = { ok: false, summary: 'stopped', error: 'stopped' };
        }
        const report = describeClick(label, clicked, toolResultForModel(clicked));
        toolsUsed.push('click_on_page');
        lastToolName = 'click_on_page';
        lastToolOk = clicked.ok;
        const failure = classifyToolFailure('click_on_page', clicked);
        if (failure !== null) findings.push(failure);
        if (clicked.data?.['needsUser'] === true) blockedByPerson = true;
        if (report.verified) {
          stepsDone.push(report.step);
          if (plan.then !== '' && doneByEya === null) doneByEya = `${found.line} ${report.line}`;
        }
        note = `${found.note}\n${report.note}`;
        log.info('the application made the click itself', { label, verified: report.verified, ok: clicked.ok });
        traceEvent('discovery_click', { label, verified: report.verified, ok: clicked.ok, summary: clicked.summary });
      }
      // (added to the person's own message, so that the two never sit side by side as separate turns)
      messages[messages.length - 1] = { role: 'user', content: `${req.text}\n\n${note}` };
      const follows = OPENS_GROUP['find_and_open_website'];
      if (follows !== undefined && !active.has(follows)) {
        active.add(follows);
        messages[0] = { role: 'system', content: systemText() };
        toolSpecs = toolsForNow();
      }
      log.info('discovery by the application', { target: plan.url ?? plan.name, opened: found.opened, findings: found.findings.map((f) => f.source), ...(found.signIn !== undefined ? { signedIn: found.signIn.answer, evidence: found.signIn.evidence.slice(0, 200) } : {}) });
      traceEvent('discovery', { target: plan.url ?? plan.name, then: plan.then, opened: found.opened, page: found.page, findings: found.findings, line: found.line });
    }

    for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
      // Stopped (the Stop buttons, or the task cancelled): nothing more is begun. Paused: nothing more is begun until it is resumed.
      if (this.deps.shouldStop?.(req.requestId) === true) this.stopRequest(req.requestId);
      await this.deps.waitWhilePaused?.(signal);
      if (this.isStopped(req.requestId)) {
        stoppedByPerson = true;
        break;
      }
      if (doneByEya !== null) {
        answer = doneByEya;
        finished = true;
        log.info('answered without the AI: the application had done everything that was asked', { step });
        break;
      }
      if (Date.now() - started > (toolsUsed.some((n) => BROWSER_TOOLS.has(n)) ? AGENT_BROWSER_BUDGET_MS : AGENT_BUDGET_MS)) {
        log.warn('agent out of time', { step });
        endedBy = 'time';
        break;
      }

      let completion: AICompletion;
      const askedAt = Date.now();
      try {
        // The local AI writes its answer word by word: it is shown as it comes (never for always-on speech, which may turn out not to be for Eya).
        // (a page read two steps ago is no longer the page in front of her: its text is cut down, so every step does not carry it again)
        completion = await ai.complete(shortenOlderResults(messages), toolSpecs, { ...(req.live === true ? {} : { onPartial: (soFar: string) => emit({ state: 'thinking', partial: soFar }) }), ...(signal !== undefined ? { signal } : {}) });
        completionMs.push(Date.now() - askedAt);
      } catch (err) {
        // Stopped while waiting for the AI: the request to it has been cancelled, nothing failed, and there is nothing to retry.
        if (this.isStopped(req.requestId) || isStoppedError(err)) {
          stoppedByPerson = true;
          break;
        }
        log.warn('LLM completion failed', { step, err: String(err) });
        findings.push({ source: 'model_unavailable', detail: describeAIFailure(err) });
        const retry = this.deps.tasks === undefined ? null : retryForAIFailure(err);
        if (step === 0) {
          closeTask(false);
          // What Eya already did herself (the page she opened) is said first: the AI being out does not undo it.
          const done = discoveryLine === '' ? '' : `${discoveryLine} `;
          traceEvent('diagnosis', { findings });
          // An action asked for while the AI is out is not dropped: it is kept, and done when the AI is back. A question is not (an answer
          // that arrives hours later is no use), so the person is told as before.
          if (retry !== null && looksLikeAction(req.text)) {
            return this.respondNoIntent(req, emit, `${done}${describeAIFailure(err)} I'll keep this and do it as soon as it's back, and tell you.`, {
              kind: 'retry',
              why: retry.why,
              retryAfterMs: retry.retryAfterMs,
            }, findings);
          }
          return this.respondNoIntent(req, emit, `${done}${describeAIFailure(err)}`, undefined, findings);
        }
        answer = describeAIFailure(err);
        lastToolOk = false;
        finished = true;
        aiRetry = retry;
        break;
      }

      // A model that wrote its tool call as plain TEXT (Llama on Groq does): a call to a tool that exists is run as the real call it was meant to be; one
      // that cannot be run is never shown as the answer and never run, and the model is told to use the tools properly (see textToolCalls.ts).
      if (completion.toolCalls.length === 0 && completion.text.trim() !== '') {
        const verdict = readTextToolCalls(completion.text, toolSpecs.map((t) => t.name));
        if (verdict.kind === 'calls') {
          log.info('tool calls written as text were run as real calls', { step, tools: verdict.calls.map((c) => c.name) });
          completion = { ...completion, text: '', toolCalls: verdict.calls.map((c, i) => ({ id: `text_${step}_${i}`, name: c.name, args: c.args })) };
        } else if (verdict.kind === 'invalid') {
          textCallRepairs += 1;
          log.warn('an answer was a tool call that cannot be run: not shown, not run', { step, reason: verdict.reason, repairs: textCallRepairs });
          findings.push({ source: 'model_malformed', detail: `The AI wrote a tool call as plain text that cannot be run (${verdict.reason}).` });
          if (textCallRepairs <= MAX_TEXT_CALL_REPAIRS) {
            messages.push({ role: 'user', content: textCallRepairNote(verdict, toolSpecs.map((t) => t.name)) });
            continue;
          }
          answer = TEXT_CALL_GAVE_UP;
          lastToolOk = false;
          finished = true;
          break;
        }
      }

      if (completion.toolCalls.length === 0) {
        // Chatter that wasn't a command stays unanswered when always-on.
        if (step === 0 && req.live === true) {
          log.info('ignored live speech: not a command', { text: req.text });
          closeTask(false);
          return this.ignore(req, emit);
        }
        // "I can't interact with your browser" / "please share your screen" while the browser is in its hands is a guess, not a fact, and sends the person to do by
        // hand what was asked of Eya. It is answered with what is true (see browserClaims.ts) instead of being passed on — but not when a browser step has really
        // reported that no browser is there, and not for a request that is about the screen itself.
        // (and the same for a refused log-in: "I can't access Swiggy without your login credentials" to someone who only asked to log in)
        const refusedLogin = asksToLogIn(req.text) && claimsNoLogin(completion.text);
        if (browserClaimNudges < 2 && !browserUnavailable && completion.blocked === undefined && !aboutTheScreen(req.text) && (claimsNoBrowserAccess(completion.text) || refusedLogin)) {
          browserClaimNudges += 1;
          findings.push({ source: 'model_refusal', detail: 'The AI said it could not work in the browser, or asked for the screen to be shared, although the browser tools were available.' });
          log.warn('the AI claimed it cannot work in the browser; told what is true and asked again', { step, nudges: browserClaimNudges });
          if (!active.has('browser')) {
            active.add('browser');
            messages[0] = { role: 'system', content: systemText() };
            toolSpecs = toolsForNow();
          }
          messages.push({ role: 'user', content: refusedLogin ? loginNudge() : browserAccessNudge(toolSpecs.map((t) => t.name)) });
          continue;
        }
        // Whose "no" is this? The provider's own safety system or a refusal on policy grounds is the model's decision: it is reported as that and not
        // argued with (no other wording, no other provider). Only a "no" for lack of a tool is a gap in Eya's own set-up.
        const refusal = completion.blocked !== undefined ? 'policy' : refusalOf(completion.text);
        // "I can't do that" while abilities are switched off usually means the one it needs is among them: switch them all on, ask again.
        if (!retriedWithEverything && toolsUsed.length === 0 && active.size < TOOL_GROUPS.length && (refusal === 'capability' || refusal === 'unknown')) {
          retriedWithEverything = true;
          for (const g of TOOL_GROUPS) active.add(g);
          pcOn = true;
          focused = false;
          messages[0] = { role: 'system', content: systemText() };
          toolSpecs = toolsForNow();
          log.info('refusal with abilities off; trying again with everything', { step });
          continue;
        }
        if (refusal !== null) {
          finalRefusal = true;
          findings.push({ source: 'model_refusal', detail: completion.blocked ?? completion.text.slice(0, 240) });
          log.info('the AI model declined', { kind: refusal, ...(completion.blocked !== undefined ? { blocked: completion.blocked } : {}), browserOpened: openedPage !== null });
        }
        answer = completion.text.trim() === '' && completion.blocked !== undefined ? `The AI's own safety system stopped this answer: ${completion.blocked}.` : completion.text;
        finished = true;
        break;
      }

      messages.push({ role: 'assistant', content: completion.text, toolCalls: completion.toolCalls });

      // Several reads that need no page and do not depend on one another (the model asked for them in one turn) run together; everything else, and
      // anything that touches a page, runs one after the other in the order asked.
      const together = canRunTogether(completion.toolCalls) ? startTogether(completion.toolCalls.map((c) => () => tools.invoke(c.name, c.args as ToolArgs, { lenient: true }))) : null;
      if (together !== null) this.deps.workStarted?.(req.requestId);

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

      for (const [callIndex, call] of completion.toolCalls.entries()) {
        // (stopped while this turn's calls were being run: the rest of them are not made)
        if (callIndex > 0 && this.deps.shouldStop?.(req.requestId) === true) {
          stoppedByPerson = true;
          break;
        }
        const ledgerKey = SIDE_EFFECT_TOOLS.has(call.name) ? callKey(call.name, call.args) : null;
        const doneBefore = ledgerKey !== null && req.resume !== undefined ? alreadyDone.get(ledgerKey) : undefined;
        emit({ state: 'working', message: tools.statusFor(call.name) });
        log.info('tool call', { step, name: call.name, args: call.args });
        const toolStarted = Date.now();
        let result: ToolResult;
        if (call.name === LOAD_TOOLS_SPEC.name) {
          // Answered here: switch the groups on, and from the next step the model sees their tools and their part of the prompt.
          const asked = parseGroups(String((call.args as ToolArgs)['groups'] ?? ''));
          const fresh: string[] = [...asked.groups].filter((g) => !active.has(g));
          const freshTopics = [...asked.topics].filter((p) => !topics.has(p));
          for (const g of asked.groups) active.add(g);
          for (const p of asked.topics) topics.add(p);
          const freshPc = asked.pc && focused;
          if (asked.pc) {
            pcOn = true;
            focused = false;
          }
          messages[0] = { role: 'system', content: systemText() };
          toolSpecs = toolsForNow();
          log.info('tools loaded', { asked: [...asked.groups, ...asked.topics, ...(asked.pc ? ['pc'] : [])], fresh: [...fresh, ...freshTopics, ...(freshPc ? ['pc'] : [])], unknown: asked.unknown });
          result =
            asked.groups.size === 0 && asked.topics.size === 0 && !asked.pc
              ? { ok: false, summary: 'no such group', error: `Unknown group. Choose from: ${[...TOOL_GROUPS, ...PROMPT_TOPICS, 'pc'].join(', ')}.` }
              : {
                  ok: true,
                  summary: fresh.length + freshTopics.length === 0 && !freshPc ? 'Those were already on.' : `Switched on: ${[...fresh, ...freshTopics, ...(freshPc ? ['pc'] : [])].join(', ')}. Use them now.`,
                };
        } else if (doneBefore !== undefined) {
          // Done before this task was carried on: it is not done a second time, and the model is told so.
          result = { ok: true, summary: `already done before this task was carried on: ${doneBefore}`, data: { alreadyDone: true } };
          log.info('not repeated: it was already done before the task was carried on', { name: call.name });
        } else {
          this.deps.workStarted?.(req.requestId);
          try {
            await this.deps.waitWhilePaused?.(signal);
            // (a tool that is running is not waited for once Stop is pressed: it finishes by itself, and nothing else is begun)
            result = await abortable(together !== null ? (together[callIndex] as Promise<ToolResult>) : tools.invoke(call.name, call.args as ToolArgs, { lenient: true }), signal);
          } catch (err) {
            if (!isStoppedError(err)) throw err;
            stoppedByPerson = true;
            break;
          }
          // A site that gives films, songs or programs away without permission is not opened or searched for by name. The person already said what
          // they wanted from it, so the lawful places for that are looked up right here and go back with the result: the answer then carries real
          // options instead of asking them again what they want (the traced model, told to do this itself, asked instead).
          if (!legalLookedFor && call.name === 'find_and_open_website' && isBlockedSiteResult(result)) {
            legalLookedFor = true;
            const wanted = wantedAfterSite(req.text, String((call.args as ToolArgs)['name'] ?? ''));
            if (wanted !== '') {
              emit({ state: 'working', message: 'Looking for a legal place to watch it…' });
              result = await withLegalOptions((n, a) => abortable(tools.invoke(n, a), signal), result, wanted);
            }
          }
          // A site that was found and opened is next clicked, read and filled in: those tools (and their part of the prompt) come with it.
          const follows = OPENS_GROUP[call.name];
          if (follows !== undefined && !active.has(follows)) {
            active.add(follows);
            messages[0] = { role: 'system', content: systemText() };
            toolSpecs = toolsForNow();
            log.info('tools loaded', { asked: [follows], fresh: [follows], by: call.name });
          }
          // (playing a video is the moment the rules for adverts matter)
          const followsTopic = OPENS_TOPIC[call.name];
          if (followsTopic !== undefined && !topics.has(followsTopic)) {
            topics.add(followsTopic);
            messages[0] = { role: 'system', content: systemText() };
            toolSpecs = toolsForNow();
          }
        }
        log.info('tool result', {
          name: call.name,
          ok: result.ok,
          ms: Date.now() - toolStarted,
          // Why it did not work, so a failure in the log is diagnosable rather than just "ok: false".
          ...(result.ok ? {} : { summary: result.summary, ...(result.error !== undefined ? { error: result.error.slice(0, 240) } : {}) }),
        });
        // A click or fill that found nothing: Eya looks at the screen herself, without asking (the person's own standing wish, a setting), and what it shows goes
        // into this step's answer, so the next step is made from it instead of another guess.
        if (this.deps.autoLook !== undefined && call.name !== LOAD_TOOLS_SPEC.name && doneBefore === undefined && shouldLook(lookState, call.name, call.args as ToolArgs, result)) {
          lookState.looks += 1;
          emit({ state: 'working', message: "I can't find it on the page, so I'm looking at the screen…" });
          try {
            const seen = await abortable(this.deps.autoLook(lookQuestion(targetOf(call.args as ToolArgs))), signal);
            log.info('looked at the screen by herself', { target: targetOf(call.args as ToolArgs), saw: seen !== null && seen.trim() !== '', chars: seen?.length ?? 0 });
            if (seen !== null && seen.trim() !== '') result = withScreenLook(result, seen);
          } catch (err) {
            if (isStoppedError(err)) {
              stoppedByPerson = true;
              break;
            }
            log.warn('looking at the screen failed; carrying on without it', { err: String(err) });
          }
        }
        // Switching abilities on is the engine's own housekeeping: it is not something the user asked for, so it is not recorded as a step.
        if (call.name !== LOAD_TOOLS_SPEC.name) {
          // (a browser step that reports no browser is there makes what the model says about it possibly true; one that works makes it false again)
          if (result.data?.['browserUnavailable'] === true || result.data?.['communicationAccess'] === 'off') browserUnavailable = true;
          else if (result.ok && groupOfTool(call.name) === 'browser') browserUnavailable = false;
          const failure = classifyToolFailure(call.name, result);
          if (failure !== null) findings.push(failure);
          lastToolName = call.name;
          lastToolOk = result.ok;
          toolsUsed.push(call.name);
          if ((call.name === 'open_website' || call.name === 'find_and_open_website' || call.name === 'download_from_site') && typeof (call.args as ToolArgs)['url'] === 'string') urlsOpened.push((call.args as ToolArgs)['url'] as string);
          if (memory !== undefined) this.memorySafely('observe', () => memory.observeTool(call.name, call.args as ToolArgs, result));
          allRefs.push(...refsFromToolResult(call.name, result));
          // (Waiting for the person is not a step that was done.)
          if (result.ok && call.name !== 'wait_for_user_in_browser') {
            const line = describeStep(call.name, call.args as ToolArgs);
            if (line !== null) stepsDone.push(line);
          }
          // Something that changed something has worked: kept now, so that being cut off here does not mean doing it again.
          if (ledgerKey !== null && result.ok && doneBefore === undefined) {
            completedCalls.push({ key: ledgerKey, summary: result.summary.slice(0, 160) });
            alreadyDone.set(ledgerKey, result.summary.slice(0, 160));
            try {
              this.deps.checkpoint?.(req.requestId, { steps: [...stepsDone], done: [...completedCalls] });
            } catch (err) {
              log.warn('could not keep the progress of a task; carrying on', { err: String(err) });
            }
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
      // Work that has settled into the browser goes on without the tools and instructions about the PC itself (and gets them back at once if a file
      // turns up, the model asks, or anything else about the request says it is not only the web).
      const nowFocused = browseFocus({ groups: active, text: req.text, toolsUsed, sawFile: allRefs.some((r) => r.kind === 'file'), pcOn });
      if (nowFocused !== focused) {
        focused = nowFocused;
        messages[0] = { role: 'system', content: systemText() };
        toolSpecs = toolsForNow();
        log.info(focused ? 'working in the browser only: the tools about the PC are set aside' : 'the tools about the PC are back', { step, tools: toolSpecs.length });
      }
    }

    const keeping = this.deps.tasks !== undefined;
    if (stoppedByPerson) {
      log.info('stopped by the person; no more steps', { steps: toolsUsed.length });
      answer = STOPPED_SPOKEN;
      finished = true;
      lastToolOk = false;
    }
    if (!finished && answer.length === 0) {
      answer =
        keeping && endedBy === 'time'
          ? "That's taking a while. I'll keep going in the background and tell you as soon as it's done."
          : describeGaveUp(endedBy ?? 'steps', completionMs, toolsUsed.length);
      lastToolOk = false;
    }
    // A phone number the model wrote that is in nothing Eya had in front of her (what was said, an earlier line, a tool's result) was made up: it is taken
    // out, and the answer says so (see factGuard.ts).
    if (answer !== '') {
      const guarded = withoutInventedNumbers(answer, messages.filter((m) => m.role !== 'assistant').map((m) => m.content));
      if (guarded.removed > 0) {
        log.warn('a phone number in the answer was not in anything Eya had: removed', { removed: guarded.removed });
        findings.push({ source: 'model_malformed', detail: 'The AI wrote a phone number that did not come from any contact, page or message, so it was removed.' });
        answer = guarded.text;
      }
    }
    let spoken = cleanForSpeech(answer) || (lastToolOk ? 'Done.' : "That didn't work.");
    // When the answer is itself a "no" from the model, say plainly that it was the model's, and what the browser did, so the wrong part is not blamed.
    if (finalRefusal) {
      const whose = attribution(findings, openedPage);
      if (whose !== '') spoken = `${spoken} ${whose}`;
    }
    if (findings.length > 0) {
      log.info('diagnosis', { findings });
      traceEvent('diagnosis', { findings });
    }
    // The AI you chose could not answer and another one did: say so, so it does not look as though your choice was ignored.
    const aiNote = completionMs.length > 0 ? this.deps.aiNote?.() ?? null : null;
    if (aiNote !== null) spoken = `${aiNote} ${spoken}`;
    // What did not simply finish is kept as a task (see AgentResult.pending): to be tried again, or to wait for the person.
    let pending: PendingSignal | undefined;
    const doneField = completedCalls.length > 0 ? { done: [...completedCalls] } : {};
    if (keeping) {
      if (aiRetry !== null) {
        pending = { kind: 'retry', why: aiRetry.why, retryAfterMs: aiRetry.retryAfterMs, steps: [...stepsDone], ...doneField };
        spoken = `${spoken} I'll try again when it's back and tell you.`;
      } else if (endedBy === 'time') {
        pending = { kind: 'retry', why: TIME_RETRY_WHY, retryAfterMs: 20_000, steps: [...stepsDone], ...doneField };
      } else if (blockedByPerson) {
        pending = { kind: 'needs_you', why: 'a check or sign-in in your browser', watch: 'browser', steps: [...stepsDone], ...doneField };
      } else if (finished && lastToolOk && toolsUsed.length > 0 && asksForGoAhead(spoken)) {
        pending = { kind: 'needs_you', why: 'a question', asks: true, steps: [...stepsDone], ...doneField };
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
      ...(findings.length > 0 ? { diagnosis: findings } : {}),
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
    diagnosis?: readonly Finding[],
  ): Promise<AgentResult> {
    const spoken = override ?? "I don't know how to do that yet.";
    const text = 'text' in req ? req.text : '';
    // (a spoken request stays a spoken one: it is not answered in text just because the AI could not be reached)
    return this.finish({ requestId: req.requestId, text, source: 'text' in req ? req.source : 'voice', ...(req.live === true ? { live: true } : {}) }, spoken, false, { emit, ...(pending !== undefined ? { pending } : {}), ...(diagnosis !== undefined && diagnosis.length > 0 ? { diagnosis } : {}) });
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
      readonly suggestAgent?: boolean;
      /**
       * The words go back at once and are spoken meanwhile. Default: for a typed request (the person is reading, and waiting for the voice to finish
       * only delays the text: an AI-free answer took as long as its own speech); not for a spoken one, which waits until Eya has finished talking so that the
       * listening does not start over her own voice.
       */
      readonly speakInBackground?: boolean;
      /** Where each thing that went wrong came from. */
      readonly diagnosis?: readonly Finding[];
      readonly emit: (patch: Omit<AgentUpdate, 'requestId'>) => void;
    },
  ): Promise<AgentResult> {
    // (stopped: the answer is "Okay, I stopped." and is not spoken; what was being worked on is not remembered as done)
    if (this.isStopped(req.requestId)) return stoppedResult(req.requestId);
    extras.emit({ state: 'speaking', message: spoken });
    if (extras.speakInBackground ?? (req.source === 'text' && req.live !== true)) {
      void this.speak(spoken).then(() => extras.emit({ state: 'idle' }));
    } else {
      await this.speak(spoken);
      extras.emit({ state: 'idle' });
    }

    const refs =
      extras.refs ??
      (extras.subject !== undefined ? [{ kind: 'application' as const, value: extras.subject }] : []);
    this.deps.context.push({
      at: Date.now(),
      // (what was attached goes into the line the next message is understood against: "and the second page?")
      userText: req.attachments !== undefined && req.attachments.length > 0 ? `${req.text} [attached: ${req.attachments.map((a) => a.name).join(', ')}]` : req.text,
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
      ...(extras.suggestAgent === true ? { suggestAgent: true } : {}),
      ...(extras.diagnosis !== undefined && extras.diagnosis.length > 0 ? { diagnosis: extras.diagnosis.map((f) => ({ source: f.source, detail: f.detail })) } : {}),
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
