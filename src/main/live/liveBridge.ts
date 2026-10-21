import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import type { LiveConfig, LiveToolCallRequest, LiveToolCallResult } from '@shared/ipcContract';
import { DEFAULT_VOICE } from '@shared/constants';
import { liveSystemPrompt } from '@main/agent/prompts';
import { refsFromToolResult, toolResultForModel } from '@main/agent/AgentEngine';
import type { Turn } from '@main/context/ConversationContext';
import type { ToolRegistry } from '@main/tools/ToolRegistry';
import type { ToolArgs, ToolResult } from '@main/tools/types';
import { rootLogger } from '@main/logging/logger';
import { LIVE_TASK_QUIET_MS, LiveTaskTracker } from './liveTasks';
import type { LiveTaskSink } from './liveTasks';
import type { ActivityInput } from '@main/memory/activityLog';
import { QUICK_COMMAND_TOOL } from '@main/local/QuickCommands';
import type { QuickRunner } from '@main/local/QuickCommands';
import type { LocalCommandResult } from '@main/local/LocalCommands';
import type { AgentResult } from '@shared/types';
import { describeStep } from '@main/tasks/pendingSignals';
import { describeEarlier, normalizeEarlier } from '@main/tasks/progress';
import type { EarlierLine } from '@main/tasks/progress';
import { runWithUserWords } from '@main/security/userWords';

const log = rootLogger.child('live');

// Measured with a spoken "open notepad" (an earlier day): 3.1-flash-live-preview asked for the tool in ~1.1s and began
// speaking in ~1.8s; 3.8-live ~1.5s / 2.2s; the 2.5 native-audio model ~5.6s and leaks its own notes, so it is the last resort.
//
// Re-measured on 2026-10-03 with spoken audio into the real Live API: 3.1-flash-live-preview opens, then the server closes
// EVERY audio session ~9 s in with 1011 "Internal error encountered." (even with no tools and a one-line prompt, so it is the
// model, not Eya's setup), while 3.8-live and the 2.5 model hear, call tools and answer normally. So the one that works comes
// first; the preview stays as a fallback in case it recovers. (LiveConversation also reopens on the next model, and tries a
// model that cut a session off last for a while, so this order is a starting point and not a single point of failure.)
const DEFAULT_LIVE_MODELS = [
  'gemini-3.8-live',
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-latest',
];

/** What a live conversation needs from memory (MemoryService has both): what to tell the model, and where tasks are counted. */
export interface LiveMemory extends LiveTaskSink {
  promptBlock(request: string, options: { readonly forLive: boolean }): string;
}

/** What the live bridge needs from the task completer: to take over work that is still going after the conversation stopped waiting for it. */
export interface LiveTaskKeeper {
  adopt(request: string, source: 'live', work: Promise<AgentResult>): string;
  /** A step found the page waiting for the person (a verification code, a CAPTCHA): keep the request as waiting for them. Optional. */
  waitForPerson?(request: string, source: 'live', why: string, steps?: readonly string[]): string;
}

/** What the model is told when a step is taking longer than it can wait: not "that failed", but "it is going on, and you will be told". */
function stillWorking(): LiveToolCallResult {
  return {
    content: toolResultForModel({
      ok: true,
      summary: 'still working',
      data: {
        stillWorking: true,
        say: 'This is taking a while (a slow page, probably). Eya keeps going in the background and will tell the user as soon as it is done.',
        next: 'Tell the user that in a few words. Do NOT try it again and do not start other steps for it: stop and wait; Eya will tell them what happened.',
      },
    }),
  };
}

/** A fast answer as the task completer understands it. */
function agentResultOf(result: LocalCommandResult): AgentResult {
  const asks = result.ok && result.spoken.trimEnd().endsWith('?');
  return {
    requestId: 'live',
    ok: result.ok,
    spoken: result.spoken,
    ...(result.pending !== undefined ? { pending: result.pending } : asks ? { pending: { kind: 'needs_you' as const, why: 'a question', asks: true } } : {}),
  };
}

export interface LiveBridgeDeps {
  readonly gemini: { liveUrl(): string | null };
  readonly tools: ToolRegistry;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /** Eya's memory: the user's preferences and saved routines go into the instructions, and repeated tasks are noticed. Optional. */
  readonly memory?: LiveMemory;
  /** Notes finished tasks in the history shown on the Recent screen. */
  readonly activity?: { record(input: ActivityInput): void };
  /** The fast everyday commands, offered to the model as one tool that works on what the user said. Optional. */
  readonly quick?: QuickRunner;
  /**
   * What the conversation has touched (the file the model just found, the one quick_command opened), so a follow-up like "send it to Uber"
   * or "open the second one" works whichever of them found it. Optional.
   */
  readonly context?: { push(turn: Turn): void };
  /** Takes over a step that is still going when the conversation stops waiting for it, so it is finished, and the person told. Optional. */
  readonly tasks?: LiveTaskKeeper;
  /** What is in progress (the tasks Eya is keeping), put in front of every new conversation: it knows what the user was doing. Optional. */
  readonly progress?: () => string;
}

function parseModels(raw: string | undefined): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : [...DEFAULT_LIVE_MODELS];
}

/** The lines the page sent of what was said earlier, checked: only who and what, capped. Anything else is dropped. */
export function parseEarlier(raw: unknown): EarlierLine[] {
  return normalizeEarlier(raw);
}

export function buildLiveConfig(deps: LiveBridgeDeps, voice: unknown, recent?: unknown): LiveConfig | null {
  const url = deps.gemini.liveUrl();
  if (url === null) return null;
  const safeVoice = typeof voice === 'string' && /^[A-Za-z]{2,24}$/.test(voice) ? voice : DEFAULT_VOICE;
  // The user's remembered preferences and the routines the model can run. A conversation cannot be re-briefed per request, so it
  // carries them all up front (a routine saved mid-conversation is known to the model from the tool result that saved it).
  let remembered = '';
  try {
    remembered = deps.memory?.promptBlock('', { forLive: true }) ?? '';
  } catch (err) {
    log.warn('memory could not be added to the live instructions', { err: String(err) });
  }
  // What is in progress, and what was said before this conversation (re)started: without them a new conversation knows nothing and asks
  // the user to explain again what they already said.
  let inProgress = '';
  try {
    inProgress = deps.progress?.() ?? '';
  } catch (err) {
    log.warn('progress could not be added to the live instructions', { err: String(err) });
  }
  const earlier = describeEarlier(parseEarlier(recent));
  const base = liveSystemPrompt(deps.now?.() ?? new Date());
  return {
    url,
    models: parseModels((deps.env ?? process.env)['EYA_LIVE_MODELS']),
    voice: safeVoice,
    systemInstruction: [base, remembered, inProgress, earlier].filter((part) => part !== '').join('\n\n'),
    tools: [
      ...(deps.quick !== undefined ? [{ name: QUICK_COMMAND_TOOL.name, description: QUICK_COMMAND_TOOL.description, parameters: QUICK_COMMAND_TOOL.parameters }] : []),
      ...deps.tools.toAISchema().map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    ],
  };
}

/**
 * The model asks for a tool by name. It goes through the same registry as
 * everything else, so the same argument checks and path rules apply.
 */
/** The model is waiting on the answer, in silence; better an honest "too slow" than minutes of nothing. */
const LIVE_TOOL_TIMEOUT_MS = 40_000;

/** The latest thing the user said that was a whole request (not just a code or a yes): what a task waiting for them is called. */
let lastAsked = '';

function wordsIn(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w !== '').length;
}

export async function runLiveTool(
  tools: ToolRegistry,
  req: unknown,
  timeoutMs: number = LIVE_TOOL_TIMEOUT_MS,
  tracker?: LiveTaskTracker,
  quick?: QuickRunner,
  activity?: { record(input: ActivityInput): void },
  context?: { push(turn: Turn): void },
  tasks?: LiveTaskKeeper,
): Promise<LiveToolCallResult> {
  const request = req as Partial<LiveToolCallRequest> | null;
  if (
    request === null ||
    typeof request !== 'object' ||
    typeof request.name !== 'string' ||
    typeof request.args !== 'object' ||
    request.args === null ||
    Array.isArray(request.args)
  ) {
    return { content: toolResultForModel({ ok: false, summary: 'bad request', error: 'The tool request was malformed.' }) };
  }
  const heard = typeof request.heard === 'string' ? request.heard.slice(0, 300) : undefined;
  if (request.name === QUICK_COMMAND_TOOL.name) {
    return quick === undefined
      ? { content: toolResultForModel({ ok: false, summary: 'not available', error: 'Quick commands are not available; use your other tools.' }) }
      : runQuickCommand(quick, typeof request.heard === 'string' ? request.heard.slice(0, 1000) : '', request.turn, timeoutMs, activity, context, tasks);
  }
  // Memory only watches: nothing it does may hold up or break a tool call.
  const watch = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      log.warn(`memory ${what} failed; ignored`, { err: String(err) });
    }
  };
  const turn = typeof request.turn === 'number' && Number.isInteger(request.turn) ? request.turn : undefined;
  watch('before-call', () => tracker?.before(heard, turn));
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (heard !== undefined && wordsIn(heard) >= 4 && !/^[\d\s,.-]+$/.test(heard)) lastAsked = heard;
  // Run with the user's own words attached: a verification code is typed only if they said it.
  const invocation = runWithUserWords(heard ?? '', () => tools.invoke(request.name as string, request.args as ToolArgs));
  const raced = await Promise.race([
    invocation,
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  let result: ToolResult;
  if (raced === 'timeout') {
    // The step is still going (a slow page, say). Giving up on it would forget what the person asked for: it is handed to the task
    // completer, which waits for it, carries the request on from there, and tells the person when it is done.
    const said = heard?.trim() ?? '';
    const stepLine = describeStep(request.name, request.args as ToolArgs);
    if (tasks !== undefined && said !== '') {
      log.info('live tool is slow; kept as a task', { name: request.name, ms: Date.now() - started });
      tasks.adopt(
        said,
        'live',
        invocation.then(
          (r): AgentResult => ({
            requestId: 'live',
            ok: r.ok,
            spoken: r.ok ? 'That step finished.' : 'That step did not work.',
            pending: { kind: 'retry', why: 'a slow step finished', retryAfterMs: 1_000, steps: r.ok && stepLine !== null ? [stepLine] : [] },
          }),
        ),
      );
      return stillWorking();
    }
    result = { ok: false, summary: 'timed out', error: 'That is taking too long, so I stopped waiting for it.' };
  } else {
    result = raced;
  }
  log.info('live tool', { name: request.name, ok: result.ok, ms: Date.now() - started });
  // The page is waiting for the person (a verification code, a CAPTCHA, a sign-in they asked for): keep what they asked for, so the
  // conversation stays open for it, a new one is told about it, and Eya goes on by herself if they finish it in the browser.
  watch('waiting-for-person', () => {
    const kind = result.data?.['challengeKind'];
    if (result.data?.['needsUser'] !== true || tasks?.waitForPerson === undefined) return;
    const asked = lastAsked !== '' ? lastAsked : (heard ?? '');
    const wants = kind === 'mfa' || kind === 'captcha' || kind === 'bot_check' || kind === 'payment' || (kind === 'login' && /log ?in|sign ?in|account/i.test(asked));
    if (!wants || asked.trim() === '') return;
    const why =
      kind === 'mfa' ? 'a verification code' : kind === 'captcha' ? 'a CAPTCHA' : kind === 'bot_check' ? 'a check that you are a person' : kind === 'payment' ? 'the payment' : 'a sign-in';
    const stepLine = describeStep(request.name as string, request.args as ToolArgs);
    tasks.waitForPerson(asked, 'live', why, stepLine !== null ? [stepLine] : []);
  });
  watch('after-call', () => tracker?.after(request.name as string, request.args as ToolArgs, result, heard, turn));
  // The files and folders a tool turned up are remembered for what the user says next ("send it to Uber").
  watch('context', () => {
    const refs = refsFromToolResult(request.name as string, result);
    if (refs.length > 0) context?.push({ at: Date.now(), userText: heard ?? '', toolUsed: request.name as string, ok: result.ok, refs });
  });
  return { content: toolResultForModel(result) };
}

/**
 * quick_command: the fast everyday commands, done from what the USER said (never from anything the model passes), so a message is
 * word for word and a yes is theirs. It is not a step a routine could repeat, so the task tracker never sees it.
 */
async function runQuickCommand(
  quick: QuickRunner,
  heard: string,
  turn: unknown,
  timeoutMs: number,
  activity?: { record(input: ActivityInput): void },
  context?: { push(turn: Turn): void },
  tasks?: LiveTaskKeeper,
): Promise<LiveToolCallResult> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const running = quick.run(heard, typeof turn === 'number' && Number.isInteger(turn) ? turn : undefined);
    const answer = await Promise.race([
      running,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
    if (answer === 'timeout') {
      // Still going (a chat app that is slow to load): kept, finished in the background, and the person is told when it is ready (or what
      // it needs from them) — the question it ends with is still waiting for their yes when it comes.
      if (tasks !== undefined && heard.trim() !== '') {
        log.info('quick command is slow; kept as a task', { ms: Date.now() - started });
        tasks.adopt(
          heard.trim(),
          'live',
          running.then(
            (a): AgentResult => (a.handled ? agentResultOf(a.result) : { requestId: 'live', ok: true, spoken: '' }),
          ),
        );
        return stillWorking();
      }
      return { content: toolResultForModel({ ok: false, summary: 'timed out', error: 'That is taking too long, so I stopped waiting for it.' }) };
    }
    log.info('live quick command', { handled: answer.handled, ms: Date.now() - started });
    if (!answer.handled) {
      return { content: toolResultForModel({ ok: true, summary: 'not a quick command', data: { handled: false, next: 'Not one of the quick commands: use your other tools as usual.' } }) };
    }
    const { result } = answer;
    try {
      if (result.refs.length > 0) context?.push({ at: Date.now(), userText: heard, toolUsed: 'quick_command', ok: result.ok, refs: result.refs });
    } catch (err) {
      log.warn('could not note a quick command in the conversation; ignored', { err: String(err) });
    }
    try {
      activity?.record({ request: heard, tools: result.tools, ...(result.urls !== undefined ? { urls: result.urls } : {}), spoken: result.spoken, ok: result.ok });
    } catch (err) {
      log.warn('could not note a quick command in the history; ignored', { err: String(err) });
    }
    const question = result.spoken.trimEnd().endsWith('?');
    return {
      content: toolResultForModel({
        ok: result.ok,
        summary: result.ok ? 'done' : 'did not work',
        data: {
          handled: true,
          say: result.spoken,
          next: question
            ? 'This is a question for the user. Ask it in your own words, wait for THEIR answer, then call quick_command again. Do not answer it yourself.'
            : 'Say this to the user briefly, in your own words. Do not do it again.',
        },
      }),
    };
  } catch (err) {
    log.warn('quick command failed; the model carries on without it', { err: String(err) });
    return { content: toolResultForModel({ ok: true, summary: 'not a quick command', data: { handled: false, next: 'Use your other tools as usual.' } }) };
  } finally {
    clearTimeout(timer);
  }
}

export function registerLiveBridge(deps: LiveBridgeDeps): void {
  const tracker =
    deps.memory === undefined
      ? undefined
      : new LiveTaskTracker(
          deps.memory,
          LIVE_TASK_QUIET_MS,
          (what, err) => log.warn(`memory could not ${what}; ignored`, { err: String(err) }),
          (task) => deps.activity?.record({ request: task.request, tools: task.tools, urls: task.urls, ok: task.ok }),
        );
  ipcMain.handle(IpcChannels.liveConfig, (_evt, voice: unknown, recent: unknown) => buildLiveConfig(deps, voice, recent));
  ipcMain.handle(IpcChannels.liveToolCall, (_evt, req: unknown) =>
    runLiveTool(deps.tools, req, undefined, tracker, deps.quick, deps.activity, deps.context, deps.tasks),
  );
}
