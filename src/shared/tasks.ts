/**
 * Tasks Eya has been given and has not finished — or has, lately. A person says "send this to Akka on WhatsApp"; the page is slow, the
 * live conversation ends, the AI runs out for the day: the task is not forgotten. It is kept, tried again, and the person is told by a
 * notification when it is done, when it needs them (a question, a CAPTCHA to tick, a sign-in), or when it could not be done.
 */

/** running: Eya is on it now. waiting: it will be tried again shortly. needs_you: it waits for the person. The rest are over. */
export type TaskState = 'running' | 'waiting' | 'needs_you' | 'done' | 'failed' | 'cancelled';

export interface TaskView {
  readonly id: string;
  /** What the person asked for, in their words. */
  readonly request: string;
  readonly state: TaskState;
  /** One line: what is happening, what is waited for, or how it ended. */
  readonly note: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly attempts: number;
  /** When it will be tried again (epoch ms), for a waiting task. */
  readonly retryAt: number | null;
  /** The note is a question the person can answer with a yes or a no. */
  readonly asks: boolean;
}

export interface TasksSnapshot {
  /** Open tasks first (newest first), then the ones that ended lately. */
  readonly items: readonly TaskView[];
  /** How many are not over: running, waiting, or waiting for the person. */
  readonly open: number;
}

export type TaskAction =
  | { readonly kind: 'cancel'; readonly id: string }
  | { readonly kind: 'cancel_all' }
  | { readonly kind: 'resume'; readonly id: string }
  | { readonly kind: 'clear_finished' };

/**
 * What a request that did not simply finish tells the task completer about itself. A request that did finish carries nothing.
 * `retry`: it ran out of time or the AI was out of allowance, so it should be tried again. `needs_you`: it is waiting for the person.
 */
export interface PendingSignal {
  readonly kind: 'retry' | 'needs_you';
  /** Short and plain, for the card and the notification ("WhatsApp is still loading"). */
  readonly why: string;
  /** For `retry`: how long to wait before trying again. */
  readonly retryAfterMs?: number;
  /** For `needs_you`: Eya watches the browser, and carries on by herself when the person has finished (a check, a sign-in). */
  readonly watch?: 'browser';
  /** For `needs_you`: the note is a question that a yes or a no answers. */
  readonly asks?: boolean;
  /** What had already been done, so that trying again does not repeat it. */
  readonly steps?: readonly string[];
}

/** Something Eya has to say about a task nobody has said yet: a step that finished late, or a question that is now waiting. */
export interface TaskSay {
  readonly text: string;
  readonly kind: 'done' | 'ask' | 'info';
}

/** An action sent by the page, checked: anything that is not exactly one of the known actions is nothing. */
export function parseTaskAction(raw: unknown): TaskAction | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  switch (r['kind']) {
    case 'cancel':
    case 'resume':
      return typeof r['id'] === 'string' && r['id'] !== '' && r['id'].length < 80 ? { kind: r['kind'], id: r['id'] } : null;
    case 'cancel_all':
    case 'clear_finished':
      return { kind: r['kind'] };
    default:
      return null;
  }
}
