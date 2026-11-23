import { maskNumbersIn } from '@main/chat/recipientResolver';
import type { Home } from '@main/browser/tabScope';
import type { LiveChatRequest, LiveChatResult, LiveChatView } from '@shared/liveChat';
import { classifyTask } from '@shared/taskBoard';
import type { TaskBoardAction, TaskBoardSnapshot, TaskKind, TaskRow } from '@shared/taskBoard';
import { PHASE_LABEL } from '@shared/tasks';
import type { AgentRequest, AgentResult } from '@shared/types';
import type { TaskCompleter } from './TaskCompleter';
import type { StoredTask } from './TaskStore';

/**
 * Where each task works in the browser: the tab and the browser it opened its first page in. A task keeps them for as long as it lives, over its retries and the answers it is given,
 * so two tasks at once each stay in their own page. (In memory: after a restart a task opens its page again, in a tab of its own.)
 */
export class TaskPlaces {
  private readonly map = new Map<string, { tab: number | null; home: Home | null }>();

  /** `onChange`: told when a task's place is fixed or changes (the card says where the task works, so the page is told at once, not at the task's next step). */
  constructor(private readonly onChange?: () => void) {}

  get(id: string): { tab: number | null; home: Home | null } {
    return this.map.get(id) ?? { tab: null, home: null };
  }

  set(id: string, tab: number | null, home: Home | null): void {
    const had = this.map.get(id);
    this.map.set(id, { tab, home });
    if (had === undefined || had.tab !== tab || had.home !== home) this.onChange?.();
  }

  forget(id: string): void {
    this.map.delete(id);
  }
}

export interface TaskBoardDeps {
  readonly completer: TaskCompleter;
  readonly places: TaskPlaces;
  /** Runs one request in the engine: a task (`req.task` is set: it runs in its own place) or a plain request. */
  readonly run: (req: AgentRequest) => Promise<AgentResult>;
  /** The live chats (the hub): they are on the same list as the tasks. */
  readonly live?: { view(): LiveChatView; handle(request: LiveChatRequest): Promise<LiveChatResult> };
  /** Whether some quick command is waiting for an answer (a live chat that began and asked who the other person is). */
  readonly hasQuestion?: () => boolean;
  /** Shows a tab of Eya Browser on the Browser page. */
  readonly showTab?: (tab: number) => void;
  readonly now?: () => number;
  /** Told whenever the list may have changed. */
  readonly onChange?: () => void;
}

const TASK_PREFIX = 'task:';
const LIVE_PREFIX = 'live:';

/** The words for where a live chat is, when it has a note of its own it says that instead. */
const LIVE_STATE_WORD: Readonly<Record<string, string>> = {
  ACTIVE: 'Watching the chat',
  PROCESSING_MESSAGE: 'Writing a reply',
  DRAFT_READY: 'A reply is ready',
  WAITING_FOR_APPROVAL: 'A reply waits for you',
  WAITING_FOR_USER: 'Needs you',
  SENDING: 'Sending a reply',
  VERIFYING: 'Checking the reply went',
  RESOLVING_CONTACT: 'Finding the chat',
  CONNECTING: 'Opening the chat',
  PAUSED: 'Paused',
  FAILED: 'Could not go on',
};

/**
 * The Tasks page's brain: ONE list of everything Eya is doing for the person — tasks they typed in (each runs on its own, with its own browser tab and its own questions) and the live
 * chats — and what they can do with each. A task is kept by the task completer (it is tried again when it has to be, and the person is told when it is done or needs them); this adds
 * starting one on purpose, answering what one asked, and the list.
 */
export class TaskBoard {
  private counter = 0;

  constructor(private readonly deps: TaskBoardDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The list changed (a task moved on, a live chat did something): the page is told. */
  changed(): void {
    this.deps.onChange?.();
  }

  // ------------------------------------------------------------------------------------------------------------ starting
  /** A new task, in the person's words: it is on the list at once and goes on by itself while the others do. Returns its id. */
  start(text: string): string {
    const request = text.replace(/\s+/g, ' ').trim();
    const id = this.deps.completer.begin(request, 'page');
    this.run(id, request, false);
    return id;
  }

  /** One go at a task: the request runs as the task (in its own place) and what comes back is what the task completer is told. */
  private run(id: string, text: string, plain: boolean): void {
    const requestId = `board-${id}-${(this.counter += 1)}`;
    const started = this.now();
    const kind = classifyTask(this.deps.completer.taskOf(id)?.request ?? text);
    this.deps.completer.link(requestId, id);
    // (a plain request is the person's answer to a question a quick command asked: no task scope, it is read by the one that asked)
    const request: AgentRequest = plain ? { requestId, text, source: 'text' } : { requestId, text, source: 'text', mode: 'agent', task: { id } };
    this.deps.run(request).then(
      (result) => this.finish(id, requestId, kind, started, result),
      () => this.finish(id, requestId, kind, started, { requestId, ok: false, spoken: 'That did not work.', pending: { kind: 'retry', why: 'something went wrong' } }),
    );
  }

  private finish(id: string, requestId: string, kind: TaskKind, startedAt: number, result: AgentResult): void {
    const { completer } = this.deps;
    completer.forget(requestId);
    // Stopped by the person: the task is stopped (it is not a failure to try again).
    if (result.error === 'stopped') {
      completer.cancel(id);
      return;
    }
    let settled = result;
    // A live chat that began and asked who the other person is: the question is on the task's card, and the answer goes to the one that asked.
    if (kind === 'live_chat' && result.ok && result.pending === undefined) {
      if (this.deps.hasQuestion?.() === true) settled = { ...result, pending: { kind: 'needs_you', why: result.spoken } };
    }
    completer.settle(id, settled, { elapsedMs: this.now() - startedAt });
  }

  // ------------------------------------------------------------------------------------------------------------ answering
  /** What the person answered to what one task asked. */
  answer(rowId: string, text: string): boolean {
    const id = this.taskIdOf(rowId);
    if (id === null) return false;
    const task = this.deps.completer.taskOf(id);
    if (task === undefined || task.state !== 'needs_you') return false;
    const words = text.replace(/\s+/g, ' ').trim();
    if (words === '') return false;
    // A live chat waiting for who the other person is: the answer is for the question that was asked (it starts the live chat), and the task is done when it has.
    if (classifyTask(task.request) === 'live_chat' && this.deps.hasQuestion?.() === true) {
      this.run(id, words, true);
      return true;
    }
    return this.deps.completer.answer(id, words);
  }

  // ------------------------------------------------------------------------------------------------------------ what the person can do
  act(action: TaskBoardAction): TaskBoardSnapshot {
    switch (action.kind) {
      case 'start':
        this.start(action.text);
        break;
      case 'answer':
        this.answer(action.id, action.text);
        break;
      case 'stop': {
        const id = this.taskIdOf(action.id);
        if (id !== null) this.deps.completer.cancel(id);
        else if (action.id.startsWith(LIVE_PREFIX)) void this.deps.live?.handle({ kind: 'stop', chat: action.id.slice(LIVE_PREFIX.length) }).then(() => this.changed());
        break;
      }
      case 'resume': {
        const id = this.taskIdOf(action.id);
        if (id !== null) this.deps.completer.resume(id);
        else if (action.id.startsWith(LIVE_PREFIX)) void this.deps.live?.handle({ kind: 'resume' }).then(() => this.changed());
        break;
      }
      case 'stop_all':
        this.deps.completer.cancelAll();
        void this.deps.live?.handle({ kind: 'stop', all: true }).then(() => this.changed());
        break;
      case 'clear_finished':
        this.deps.completer.clearFinished();
        break;
      case 'show_browser': {
        const id = this.taskIdOf(action.id);
        if (id !== null) {
          const place = this.deps.places.get(id);
          if (place.home === 'eya' && place.tab !== null) this.deps.showTab?.(place.tab);
        }
        break;
      }
    }
    return this.snapshot();
  }

  private taskIdOf(rowId: string): string | null {
    return rowId.startsWith(TASK_PREFIX) ? rowId.slice(TASK_PREFIX.length) : null;
  }

  // ------------------------------------------------------------------------------------------------------------ the list
  snapshot(): TaskBoardSnapshot {
    const tasks = this.deps.completer.all().map((t) => this.rowOfTask(t));
    const lives = this.liveRows();
    const isOpen = (r: TaskRow): boolean => r.state === 'running' || r.state === 'waiting' || r.state === 'needs_you' || r.state === 'paused';
    const open = [...tasks, ...lives].filter(isOpen).sort((a, b) => b.createdAt - a.createdAt);
    const finished = [...tasks, ...lives].filter((r) => !isOpen(r)).sort((a, b) => b.updatedAt - a.updatedAt);
    return { rows: [...open, ...finished], open: open.length };
  }

  private rowOfTask(t: StoredTask): TaskRow {
    const place = this.deps.places.get(t.id);
    return {
      id: `${TASK_PREFIX}${t.id}`,
      kind: classifyTask(t.request),
      title: t.request,
      state: t.state,
      note: t.note,
      steps: t.steps.slice(-6),
      // (a task waiting for the person to finish something in the browser is not asking a question)
      asks: t.state === 'needs_you' && t.plugin === undefined && t.watch === undefined,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      where: place.home === 'eya' ? 'eya' : place.home === 'chrome' || place.home === 'edge' ? 'mine' : null,
      resumable: t.plugin === undefined,
      phase: t.plugin === undefined ? null : PHASE_LABEL[t.plugin.phase],
      evidence: t.plugin === undefined ? [] : t.plugin.evidence.slice(-3).map((e) => e.what),
    };
  }

  private liveRows(): TaskRow[] {
    const live = this.deps.live;
    if (live === undefined) return [];
    const v = live.view();
    if (!v.active) return [];
    const chats =
      v.chats !== undefined && v.chats.length > 1
        ? v.chats.map((c) => ({ id: c.id, chat: c.chat, state: c.state, pause: c.pause, relation: c.relation, replies: c.replies, front: c.front }))
        : [{ id: v.sessionId ?? 'live', chat: maskNumbersIn(v.chat ?? 'a chat'), state: v.state, pause: v.pause, relation: v.relation ?? null, replies: v.replies, front: true }];
    return chats.map((c): TaskRow => {
      const paused = c.state === 'PAUSED';
      const needs = c.state === 'WAITING_FOR_USER' || c.state === 'WAITING_FOR_APPROVAL';
      const note = c.front ? (v.notice ?? v.error ?? LIVE_STATE_WORD[c.state] ?? 'Running') : c.pause === 'standby' ? 'Waiting for its turn' : (LIVE_STATE_WORD[c.state] ?? 'Running');
      return {
        id: `${LIVE_PREFIX}${c.id}`,
        kind: 'live_chat',
        title: `Live chat with ${c.chat}`,
        state: c.state === 'FAILED' ? 'failed' : paused ? 'paused' : needs ? 'needs_you' : 'running',
        note,
        steps: [],
        asks: false,
        createdAt: v.startedAt ?? 0,
        updatedAt: v.lastCheckAt ?? v.startedAt ?? 0,
        where: null,
        resumable: true,
        phase: null,
        evidence: [],
        live: { replies: c.replies, mode: v.mode, relation: c.relation },
      };
    });
  }
}
