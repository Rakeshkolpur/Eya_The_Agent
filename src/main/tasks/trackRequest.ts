import type { AgentRequest, AgentResult } from '@shared/types';
import type { TaskCompleter } from './TaskCompleter';

/** A request still going after this long is shown as a task (a quick one is not worth a line in the list). */
export const VISIBLE_AFTER_MS = 8_000;

export interface TrackOptions {
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
  const handle = set(() => {
    if (id === null) id = completer.begin(req.text, source);
  }, options.visibleAfterMs ?? VISIBLE_AFTER_MS);
  let result: AgentResult;
  try {
    result = await run();
  } catch (err) {
    clear(handle);
    if (id !== null) completer.settle(id, { requestId: req.requestId, ok: false, spoken: 'That did not work.', pending: { kind: 'retry', why: 'something went wrong' } });
    throw err;
  }
  clear(handle);
  if (req.live === true && result.error === 'ignored') {
    if (id !== null) completer.cancel(id);
    return result;
  }
  // The yes or no that was being waited for has been given (or the person moved on to something else).
  completer.answered();
  const elapsedMs = now() - started;
  if (id === null && (result.pending !== undefined || elapsedMs >= 20_000)) id = completer.begin(req.text, source);
  if (id !== null) completer.settle(id, result, { elapsedMs });
  return result;
}
