import type { AgentRequest, AgentResult } from '@shared/types';
import type { TaskCompleter } from './TaskCompleter';

/** A request still going after this long is shown as a task (a quick one is not worth a line in the list). */
export const VISIBLE_AFTER_MS = 8_000;

export interface TrackOptions {
  /**
   * Whether tools have started working on this request. A request that is only a conversation (a greeting, a question answered from what the AI
   * knows) is never shown as a task, however long a slow AI takes over it. Without this, every request that is slow counts as one.
   */
  readonly isWork?: () => boolean;
  readonly visibleAfterMs?: number;
  readonly timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  readonly now?: () => number;
}

/**
 * Runs a request and keeps what the person asked for if it does not simply finish.
 *
 * - A request that is quick and finishes is not recorded at all.
 * - One that is still going after a few seconds appears in the list as "working on it", so the person can see it and stop it.
 * - One that comes back with a signal (it ran out of time, the AI is out, a question, a check in the browser) is kept, and the
 *   completer carries it on.
 * - One that took a long time and finished is recorded, and announced with a notification.
 * - Whatever a request is, if it is handled, a question that was waiting for a yes or a no has had its answer (or has lapsed).
 */
export async function trackRequest(completer: TaskCompleter, req: AgentRequest, run: () => Promise<AgentResult>, options: TrackOptions = {}): Promise<AgentResult> {
  const now = options.now ?? Date.now;
  const set = options.timers?.set ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clear = options.timers?.clear ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const source = req.live === true ? 'live' : req.source;
  // Always-on listening that was not a command is nothing to keep.
  const started = now();
  let id: string | null = null;
  const isWork = options.isWork ?? ((): boolean => true);
  // A request that began a task through a plugin is already shown as that task (with its own progress): it is not listed a second time just for being slow.
  const covered = (): boolean => completer.hasPluginTaskSince(started);
  const handle = set(() => {
    if (id === null && isWork() && !covered()) {
      id = completer.begin(req.text, source);
      // (what the request has done so far, and what it does from now on, is kept with the task)
      completer.link(req.requestId, id);
    }
  }, options.visibleAfterMs ?? VISIBLE_AFTER_MS);
  let result: AgentResult;
  try {
    result = await run();
  } catch (err) {
    clear(handle);
    if (id !== null) completer.settle(id, { requestId: req.requestId, ok: false, spoken: 'That did not work.', pending: { kind: 'retry', why: 'something went wrong' } });
    completer.forget(req.requestId);
    throw err;
  }
  clear(handle);
  if (req.live === true && result.error === 'ignored') {
    if (id !== null) completer.cancel(id);
    completer.forget(req.requestId);
    return result;
  }
  // Stopped by the person: the task, if there is one, is stopped; it is not a failure to be tried again or told about.
  if (result.error === 'stopped') {
    if (id !== null) completer.cancel(id);
    completer.forget(req.requestId);
    return result;
  }
  // The yes or no that was being waited for has been given (or the person moved on to something else).
  completer.answered();
  const elapsedMs = now() - started;
  if (id === null && (result.pending !== undefined || (elapsedMs >= 20_000 && isWork() && !covered()))) {
    id = completer.begin(req.text, source);
    completer.link(req.requestId, id);
  }
  if (id !== null) completer.settle(id, result, { elapsedMs });
  completer.forget(req.requestId);
  return result;
}
