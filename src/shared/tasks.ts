/**
 * Tasks Eya has been given and has not finished — or has, lately. A person says "send this to Akka on WhatsApp"; the page is slow, the
 * live conversation ends, the AI runs out for the day: the task is not forgotten. It is kept, tried again, and the person is told by a
 * notification when it is done, when it needs them (a question, a CAPTCHA to tick, a sign-in), or when it could not be done.
 */

/** running: Eya is on it now. waiting: it will be tried again shortly. needs_you: it waits for the person. The rest are over. */
export type TaskState = 'running' | 'waiting' | 'needs_you' | 'done' | 'failed' | 'cancelled';

/**
 * Where a task done through a plugin is, in the order a task goes: RECEIVED → PLANNING → EXECUTING → VERIFYING → COMPLETED. It can also be waiting for the
 * person (a choice, a yes, or a permission only they can give), failed, cancelled, or UNCERTAIN: an action outside Eya may or may not have happened, and
 * nothing is to be repeated until the place it happens has been looked at.
 */
export type TaskPhase = 'received' | 'planning' | 'executing' | 'verifying' | 'completed' | 'waiting_clarification' | 'waiting_permission' | 'failed' | 'cancelled' | 'uncertain';

/** Something a plugin task settled on: who a message is for, or which file. Names only — a phone number is kept masked, never whole. */
export interface TaskEntity {
  readonly kind: 'recipient' | 'file';
  readonly label: string;
  /** What the choice rests on ("exact name", "whole phone number", "the person chose it"). */
  readonly evidence: string;
  /** True for an identity (an exact name, a whole number, the person's own choice); false for a likely match. */
  readonly verified: boolean;
}

/** One thing that was seen to be so (never what was said in a chat). */
export interface TaskEvidence {
  readonly at: number;
  readonly what: string;
}

/** What a task carries when it is done through a plugin. */
export interface PluginTaskInfo {
  /** Names this one task, so that every step of it finds it again. */
  readonly key: string;
  readonly plugin: string;
  readonly action: string;
  readonly phase: TaskPhase;
  readonly entities: readonly TaskEntity[];
  readonly evidence: readonly TaskEvidence[];
  /** How many steps were tried again. */
  readonly retries: number;
  /** The question waiting for the person, if the task is waiting for one. */
  readonly question?: string;
}

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
  /** For a task done through a plugin: which, how far it has got, who it is for, and what was seen to happen. */
  readonly plugin: { readonly id: string; readonly action: string; readonly phase: TaskPhase; readonly entities: readonly TaskEntity[]; readonly evidence: readonly string[] } | null;
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
/** One call that changed something and worked, kept so that carrying a task on does not do it twice. */
export interface DoneCall {
  /** The tool and its exact arguments. */
  readonly key: string;
  /** What the tool said it did. */
  readonly summary: string;
}

/** Why a request that the clock cut short is kept to be carried on (the same words are on its card and in the notification). */
export const TIME_RETRY_WHY = 'it is taking a while';

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
  /** The exact calls that changed something and worked: a call that matches one is not made again. */
  readonly done?: readonly DoneCall[];
}

/** Something Eya has to say about a task nobody has said yet: a step that finished late, or a question that is now waiting. */
export interface TaskSay {
  readonly text: string;
  /** `relay`: what the other person in a live chat said for the person (see livechat/): shown in the chat with Eya (as `display`, when there is one) and spoken. */
  readonly kind: 'done' | 'ask' | 'info' | 'relay';
  /** What to show in the chat with Eya when it differs from what is spoken (a phone number is spoken by its last digits and shown masked). */
  readonly display?: string;
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
