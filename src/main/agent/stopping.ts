import type { AgentResult } from '@shared/types';

/**
 * Stopping a request on the spot. Each request that is being worked on has an abort signal; Stop (the button in the chat box, the Stop of the Browser
 * page and of the panel, Stop on a task) aborts it. What is in the middle of being done is let go of at once: the AI answer being waited for is
 * abandoned (the request to the AI is cancelled), a tool that is running is no longer waited for, and no new step is begun. The person is told
 * "Okay, I stopped." in the same moment, not after whatever was in flight has finished.
 */

/** What the person is told. */
export const STOPPED_SPOKEN = 'Okay, I stopped.';

/** Thrown to whoever was waiting for something when the request was stopped. */
export class StoppedError extends Error {
  readonly stopped = true;
  constructor() {
    super('stopped');
    // (named as the browser names a cancelled request, so anything that already treats an abort as "not a failure" does the same here)
    this.name = 'AbortError';
  }
}

/**
 * Whether this is the person's Stop. Only that: a provider that gave up waiting (its own timeout) also throws something called AbortError, and that is a
 * failure of the provider, to be moved on from, not a Stop. (It was once taken for one: the request ended with "Okay, I stopped." on its own.)
 */
export function isStopped(err: unknown): boolean {
  return err instanceof StoppedError;
}

/**
 * Waits for `work`, but no longer than the request is alive: when the signal is aborted the wait ends at once with a StoppedError, and whatever
 * `work` was doing is left to finish by itself with its result ignored (a file already being copied cannot be taken back, but nothing else is begun).
 */
export function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) {
    // (the work was started already: it is let go of, and its failure, if it fails, is nobody's business now)
    work.catch(() => undefined);
    return Promise.reject(new StoppedError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      work.catch(() => undefined);
      reject(new StoppedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** A pause that ends when the signal is aborted (so a stopped request is not left waiting for a Resume that nobody will press). */
export function sleepUnlessStopped(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** The result of a request the person stopped. `error: 'stopped'` is how the task keeper knows it was a Stop and not a failure. */
export function stoppedResult(requestId: string): AgentResult {
  return { requestId, ok: false, spoken: STOPPED_SPOKEN, error: 'stopped' };
}

/** Whether the signal has been aborted (a function, because the flag changes while awaiting: a plain check would be taken to never change). */
export function wasAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
