import type { ChatDiagnostics } from './chatDiagnostics';
import { normalizeText } from './contactMatch';
import type { ChatAppId } from './platformAdapter';

/**
 * One chat request as a task with a known place in a known order. The chat commands used to keep only "a question is waiting"; whether the chat had
 * been opened, who it had been chosen as, whether the send had been tried, what had been seen, was in nobody's hands, so a request that was tried
 * again began from nothing and an action could be repeated because nothing said it had been done.
 *
 * Each state is entered only on EVIDENCE (a page that showed what the step was meant to produce). A step that did not produce it is not recorded as
 * done; it is retried only a bounded number of times, and each retry has to have looked at the page again. A task that cannot go on says why in
 * one of a short list of categories, which is also what is written to the diagnostics (never a name, a number or a message).
 */
export type ChatTaskState =
  | 'PARSE_REQUEST'
  | 'RESOLVE_FILE'
  | 'RESOLVE_RECIPIENT'
  | 'INSPECT_BROWSER'
  | 'OPEN_PLATFORM'
  | 'CHECK_LOGIN'
  | 'SEARCH_CONTACT'
  | 'EVALUATE_MATCHES'
  | 'AWAIT_RECIPIENT_CLARIFICATION'
  | 'OPEN_CONVERSATION'
  | 'VERIFY_CONVERSATION'
  | 'PREPARE_MESSAGE_OR_ATTACHMENT'
  | 'VERIFY_PREPARATION'
  | 'SEND'
  | 'VERIFY_SENT_RESULT'
  | 'COMPLETED'
  | 'FAILED';

/** The order the states normally come in: a state may only be entered going forward (or on to the end), never back to redo what was verified. */
const ORDER: readonly ChatTaskState[] = [
  'PARSE_REQUEST',
  'RESOLVE_FILE',
  'RESOLVE_RECIPIENT',
  'INSPECT_BROWSER',
  'OPEN_PLATFORM',
  'CHECK_LOGIN',
  'SEARCH_CONTACT',
  'EVALUATE_MATCHES',
  'AWAIT_RECIPIENT_CLARIFICATION',
  'OPEN_CONVERSATION',
  'VERIFY_CONVERSATION',
  'PREPARE_MESSAGE_OR_ATTACHMENT',
  'VERIFY_PREPARATION',
  'SEND',
  'VERIFY_SENT_RESULT',
  'COMPLETED',
];

export type FailureCategory =
  | 'chats_off'
  | 'unsupported_platform'
  | 'browser_unavailable'
  | 'login_needed'
  | 'page_slow'
  | 'chat_not_found'
  | 'recipient_ambiguous'
  | 'open_failed'
  | 'wrong_chat'
  | 'composer_missing'
  | 'file_not_found'
  | 'attach_failed'
  | 'send_failed'
  | 'send_uncertain'
  | 'declined'
  | 'plugin_blocked'
  | 'retries_used_up';

export type TaskAction = 'message' | 'file' | 'open';

/**
 * Told about every step of a task as it happens, so that something outside the chat commands can keep it (the persisted task a plugin keeps). It sees the same
 * things the diagnostics see — states, who was chosen and on what evidence, whether a send was begun and whether it was seen — and nothing else.
 */
export interface ChatTaskObserver {
  state(task: ChatTask, from: ChatTaskState, to: ChatTaskState): void;
  chose(task: ChatTask, selection: Selection): void;
  /** The file to send has been settled on (found on this PC, or the one just found or opened). */
  file(task: ChatTask, name: string, evidence: string): void;
  /** The task has stopped to ask the person something (a choice, or a yes before a send). */
  waiting(task: ChatTask, question: string): void;
  sendBegan(task: ChatTask): void;
  sendSeen(task: ChatTask, mark?: string): void;
  completed(task: ChatTask): void;
  failed(task: ChatTask, category: FailureCategory, recovery: string): void;
}

export interface TaskRecipient {
  /** Who the person said (kept in memory for the task, never written down). */
  readonly query: string;
  /** Whether it is a phone number. */
  readonly isNumber: boolean;
}

export interface Selection {
  readonly label: string;
  /** What the choice rests on ("exact name", "part of the name", "the user chose it" …). */
  readonly evidence: string;
  /** True only for an identity (exact name, whole number, the user's own choice); false for a likely match. */
  readonly verified: boolean;
  /** Whether the page's header was read and showed this name once the chat was open. */
  readonly headerChecked: boolean;
}

/** A step may be tried again this many times after the first (each time on a fresh look at the page). */
export const MAX_STEP_RETRIES = 2;

let counter = 0;
const newId = (): string => `t${Date.now().toString(36)}${(counter++ % 1296).toString(36)}`;

export class ChatTask {
  readonly id = newId();
  /** What makes two requests the same request (same app, action, recipient and thing sent): a request said again is the task already under way. */
  readonly signature: string;
  readonly startedAt: number;
  /** How many times this request has been taken up again (a retry, or the person saying it again). */
  resumed = 0;
  state: ChatTaskState = 'PARSE_REQUEST';
  /** The last state that was entered on evidence (what a retry may rely on). */
  lastVerified: ChatTaskState = 'PARSE_REQUEST';
  /** How the candidates were judged (categories only). */
  candidates: ReadonlyArray<{ readonly evidence: string; readonly verified: boolean }> = [];
  selected: Selection | null = null;
  sendAttempted = false;
  sendVerified = false;
  lastError: { readonly category: FailureCategory; readonly recovery: string } | null = null;
  /** How many times each step has been tried again. */
  readonly retries = new Map<string, number>();
  private steps = 0;
  private enteredAt = Date.now();

  constructor(
    readonly platform: ChatAppId,
    readonly action: TaskAction,
    readonly recipient: TaskRecipient,
    /** A key for what is being sent (the words, or the file's name), for telling one send from another. Never written down. */
    readonly contentKey: string | null,
    private readonly diagnostics?: ChatDiagnostics,
    private readonly clock: () => number = Date.now,
    private readonly observer?: ChatTaskObserver,
  ) {
    this.enteredAt = clock();
    this.startedAt = this.enteredAt;
    this.signature = `${platform}|${action}|${normalizeText(recipient.query)}|${contentKey === null ? '' : normalizeText(contentKey)}`;
  }

  /** A step that was carried out (a tool call): how long it took and how it ended, in a word from a short list. Never what was in it. */
  observed(op: string, ms: number, ok: boolean, category?: string): void {
    this.steps += 1;
    this.diagnostics?.record({ task: this.id, step: this.steps, op, from: this.state, ms, ok, ...(category !== undefined ? { category } : {}), attempts: (this.retries.get(op) ?? 0) + 1 });
  }

  /** Whether the task is over, one way or the other. */
  get finished(): boolean {
    return this.state === 'COMPLETED' || this.state === 'FAILED';
  }

  /**
   * Moves to a later state because the page showed what the step was meant to produce. Going back is refused (a verified step is not done again),
   * and so is moving on after the end. Returns false when it was not allowed.
   */
  enter(next: ChatTaskState): boolean {
    if (this.finished) return false;
    const from = ORDER.indexOf(this.state);
    const to = ORDER.indexOf(next);
    if (next === 'FAILED' || to < 0 || to < from) return false;
    this.note(next, true);
    const previous = this.state;
    this.state = next;
    this.lastVerified = next;
    this.observer?.state(this, previous, next);
    return true;
  }

  /** The step that was begun did not produce what it should: said, with a category, and the state stays where the evidence last was. */
  stepFailed(op: string, category: FailureCategory, recovery: string): void {
    this.lastError = { category, recovery };
    this.steps += 1;
    this.diagnostics?.record({ task: this.id, step: this.steps, op, from: this.state, ok: false, category, observed: false, attempts: (this.retries.get(op) ?? 0) + 1 });
  }

  /**
   * May this step be tried again? Only a bounded number of times: the answer is no after MAX_STEP_RETRIES, and the task should then say what it
   * could not do, or ask, instead of going round again.
   */
  tryAgain(op: string): boolean {
    const used = this.retries.get(op) ?? 0;
    if (used >= MAX_STEP_RETRIES) {
      this.lastError = { category: 'retries_used_up', recovery: `${op} did not work after ${used + 1} tries` };
      return false;
    }
    this.retries.set(op, used + 1);
    return true;
  }

  chose(selection: Selection): void {
    this.selected = selection;
    this.observer?.chose(this, selection);
  }

  /** The file this task sends has been settled on, and how. */
  fileChosen(name: string, evidence: string): void {
    this.observer?.file(this, name, evidence);
  }

  /** The task has asked the person something and waits for the answer. */
  waiting(question: string): void {
    if (!this.finished) this.observer?.waiting(this, question);
  }

  /** The send was begun (the Send control was pressed). From here on the outcome has to be looked at before anything is sent again. */
  sendBegan(): void {
    this.sendAttempted = true;
    this.observer?.sendBegan(this);
  }

  /** The chat showed the message or file as sent. */
  sendSeen(mark?: string): void {
    this.sendVerified = true;
    this.observer?.sendSeen(this, mark);
  }

  complete(): void {
    if (this.finished) return;
    this.note('COMPLETED', true);
    this.state = 'COMPLETED';
    this.observer?.completed(this);
  }

  fail(category: FailureCategory, recovery: string): void {
    if (this.finished) return;
    this.lastError = { category, recovery };
    this.note('FAILED', false, category);
    this.state = 'FAILED';
    this.observer?.failed(this, category, recovery);
  }

  private note(to: ChatTaskState, ok: boolean, category?: string): void {
    this.steps += 1;
    const now = this.clock();
    this.diagnostics?.record({
      task: this.id,
      step: this.steps,
      op: 'state',
      from: this.state,
      to,
      ms: now - this.enteredAt,
      ok,
      observed: ok,
      ...(category !== undefined ? { category } : {}),
    });
    this.enteredAt = now;
  }
}
