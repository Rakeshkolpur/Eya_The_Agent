import { rootLogger } from '@main/logging/logger';
import type { AgentResult } from '@shared/types';
import type { TaskAction, TaskState, TaskView, TasksSnapshot } from '@shared/tasks';
import type { StoredTask, TaskStore } from './TaskStore';

const log = rootLogger.child('tasks');

export interface TaskNotice {
  readonly kind: 'done' | 'failed' | 'needs_you' | 'waiting';
  readonly title: string;
  readonly body: string;
  readonly taskId: string;
}

export interface CompleterDeps {
  readonly store: TaskStore;
  /** Carries the task on through the engine (the engine speaks its own answer). Resolves with how it went. */
  readonly run: (task: StoredTask) => Promise<AgentResult>;
  /** A desktop notification: the person may not be looking at Eya, or may have ended the conversation. */
  readonly notify: (notice: TaskNotice) => void;
  /** Says something nobody has said yet (a step that finished after its caller gave up waiting): aloud, or into the live conversation. */
  readonly say?: (text: string, kind: 'done' | 'ask' | 'info') => void;
  /** Watches the person's browser while they do something there; true once what they were doing has changed (they finished). */
  readonly watchBrowser?: (timeoutMs: number) => Promise<boolean>;
  readonly now?: () => number;
  /** Called after any change, to refresh what the pages show. */
  readonly onChange?: () => void;
  readonly newId?: () => string;
  readonly maxAttempts?: number;
  /** An open task older than this is given up. */
  readonly keepMs?: number;
  /** A task cut off by Eya closing is carried on at start-up only if it is younger than this; older ones wait for the person. */
  readonly resumeWithinMs?: number;
  /** A task that finished is announced only if it took longer than this (a quick one needs no notification). */
  readonly notifyAfterMs?: number;
  readonly tickMs?: number;
  /** How long to pause before watching the browser again when the last look came back at once (so a browser that is not there is not spun on). */
  readonly watchPauseMs?: number;
}

const MINUTE = 60_000;
const DEFAULTS = { maxAttempts: 8, keepMs: 6 * 60 * MINUTE, resumeWithinMs: 30 * MINUTE, notifyAfterMs: 20_000, tickMs: 5_000 };
const FINISHED_KEPT = 30;
const FINISHED_VISIBLE = 12;
/** How long Eya watches the browser for a person to finish a check or a sign-in before she stops and waits to be told. */
const WATCH_MS = 20 * MINUTE;

function short(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** How long before going at a task again: soon at first, then less often. */
export function backoffMs(attempts: number): number {
  return [20_000, 45_000, 90_000, 3 * MINUTE][Math.min(Math.max(attempts, 1), 4) - 1] as number;
}

const isOpen = (s: TaskState): boolean => s === 'running' || s === 'waiting' || s === 'needs_you';

/**
 * Keeps what the person asked for until it is done.
 *
 * A request that cannot finish at once — the page is slow, the AI is out for the day, a check needs the person — becomes a task that is
 * remembered on disk, tried again, and told about by a notification. It is over only when it is done, when the person says to stop, or
 * after it has been tried for long enough that going on would be silly.
 *
 * Nothing here decides how to do a task: `run` carries it through the same engine as any request, with what was already done. And nothing
 * here may send, delete or buy anything the person did not say yes to: the steps that ask first still ask first.
 */
export class TaskCompleter {
  private tasks: StoredTask[];
  private working = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly watching = new Set<string>();
  private readonly cfg: Required<Pick<CompleterDeps, 'maxAttempts' | 'keepMs' | 'resumeWithinMs' | 'notifyAfterMs' | 'tickMs'>>;
  private readonly clock: () => number;
  private counter = 0;

  constructor(private readonly deps: CompleterDeps) {
    this.cfg = {
      maxAttempts: deps.maxAttempts ?? DEFAULTS.maxAttempts,
      keepMs: deps.keepMs ?? DEFAULTS.keepMs,
      resumeWithinMs: deps.resumeWithinMs ?? DEFAULTS.resumeWithinMs,
      notifyAfterMs: deps.notifyAfterMs ?? DEFAULTS.notifyAfterMs,
      tickMs: deps.tickMs ?? DEFAULTS.tickMs,
    };
    this.clock = deps.now ?? Date.now;
    this.tasks = deps.store.load();
    this.recover();
  }

  // ------------------------------------------------------------------------------------------------------------ start / stop
  /** Starts looking, every few seconds, for tasks that are due to be tried again. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), this.cfg.tickMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Tasks that were running when Eya closed were cut off: carry on with the recent ones, and leave the old ones for the person to say. */
  private recover(): void {
    const now = this.clock();
    this.tasks = this.tasks.map((t) => {
      if (t.state !== 'running') return t;
      if (now - t.updatedAt <= this.cfg.resumeWithinMs) {
        return { ...t, state: 'waiting' as const, retryAt: now + 3_000, note: 'Carrying on after Eya started again.', updatedAt: now };
      }
      return { ...t, state: 'needs_you' as const, note: 'This was cut off when Eya closed. Resume it?', updatedAt: now };
    });
    this.trim();
    this.save();
  }

  // ------------------------------------------------------------------------------------------------------------ making tasks
  /** A request is being worked on and may not finish at once. Returns its id. */
  begin(request: string, source: StoredTask['source'] = 'text'): string {
    const now = this.clock();
    // Asking again for what is already being kept replaces it: one task, not two of the same.
    const same = request.trim().slice(0, 500).toLowerCase();
    for (const older of this.tasks.filter((t) => isOpen(t.state) && t.request.toLowerCase() === same)) this.cancelOne(older, 'Replaced by the same request again.');
    const task: StoredTask = {
      id: this.deps.newId?.() ?? `t${now.toString(36)}${(this.counter += 1).toString(36)}`,
      request: request.trim().slice(0, 500),
      source,
      state: 'running',
      createdAt: now,
      updatedAt: now,
      attempts: 1,
      note: 'Working on it…',
      steps: [],
    };
    this.tasks = [task, ...this.tasks];
    this.changed();
    return task.id;
  }

  /**
   * A step in a live conversation found the page waiting for the person (a verification code, a CAPTCHA, a sign-in). The request is kept
   * as waiting for them: the conversation is not ended for being quiet, the page is watched (so if they finish it themselves Eya goes on),
   * a new conversation is told about it, and they get a notification.
   */
  waitForPerson(request: string, source: StoredTask['source'], why: string, steps: readonly string[] = []): string {
    const id = this.begin(request, source);
    this.settle(id, { requestId: id, ok: true, spoken: '', pending: { kind: 'needs_you', why, watch: 'browser', steps } });
    return id;
  }

  /**
   * The person gave what the waiting tasks were waiting for (they said the verification code and it was typed): those that waited for them
   * in the browser are over, and the conversation carries on with the rest. Returns how many.
   */
  userContinued(): number {
    const waiting = this.tasks.filter((t) => t.state === 'needs_you' && t.watch === 'browser');
    for (const t of waiting) this.finishAs(t.id, 'done', 'You gave the code and Eya carried on.', { steps: t.steps, notify: false });
    return waiting.length;
  }

  /**
   * Work that is still going after the one who asked it has stopped waiting (a step that outlasted the live conversation's patience):
   * when it finishes, the person is told, aloud if they are there and by a notification.
   */
  adopt(request: string, source: StoredTask['source'], work: Promise<AgentResult>): string {
    const id = this.begin(request, source);
    const note = (t: StoredTask): StoredTask => ({ ...t, note: 'Still working on it in the background…' });
    this.patch(id, note);
    work.then(
      (result) => this.settle(id, result, { announce: true }),
      (err: unknown) => {
        log.warn('background work failed', { err: String(err) });
        this.settle(id, { requestId: id, ok: false, spoken: 'That did not work.', pending: { kind: 'retry', why: 'something went wrong' } }, { announce: true });
      },
    );
    return id;
  }

  /**
   * How a request that was being worked on ended. A request that simply finished is done (or failed); one that carries a signal is kept:
   * to be tried again, or to wait for the person.
   */
  settle(id: string, result: AgentResult, options: { readonly announce?: boolean; readonly elapsedMs?: number } = {}): void {
    const task = this.find(id);
    if (task === undefined || task.state === 'cancelled') return;
    const now = this.clock();
    const signal = result.pending;
    // Work that turned out to be nothing (the fast layer did not take it, and said nothing) leaves no task behind.
    if (signal === undefined && result.ok && result.spoken.trim() === '') {
      this.cancelOne(task, 'Nothing to do.');
      this.trim();
      return;
    }
    const steps = [...task.steps, ...(signal?.steps ?? [])].slice(-20);
    const took = options.elapsedMs ?? now - task.createdAt;
    const worth = took >= this.cfg.notifyAfterMs || task.attempts > 1 || options.announce === true;

    if (signal?.kind === 'retry') {
      if (task.attempts >= this.cfg.maxAttempts) {
        this.finishAs(id, 'failed', `I tried ${task.attempts} times and could not finish this (${signal.why}).`, { steps, notify: true });
        return;
      }
      const first = task.told !== true;
      this.patch(id, (t) => ({
        ...t,
        state: 'waiting',
        retryAt: now + (signal.retryAfterMs ?? backoffMs(t.attempts)),
        note: signal.why,
        steps,
        updatedAt: now,
        told: true,
      }));
      if (first) {
        this.notice('waiting', "Eya is still working on it", `${short(task.request)} — ${signal.why}. She will keep trying and tell you when it is done.`, id);
        if (options.announce === true) this.deps.say?.(`${signal.why}. I'll keep trying and tell you when it's done.`, 'info');
      }
      return;
    }

    if (signal?.kind === 'needs_you') {
      const note = signal.asks === true ? result.spoken : signal.why;
      this.patch(id, (t) => ({
        ...t,
        state: 'needs_you',
        note,
        steps,
        updatedAt: now,
        asks: signal.asks === true,
        ...(signal.watch !== undefined ? { watch: signal.watch } : {}),
        told: true,
      }));
      this.notice('needs_you', signal.asks === true ? 'Eya has a question' : 'Eya needs you', `${short(task.request)} — ${short(note, 140)}`, id);
      if (options.announce === true) this.deps.say?.(note, signal.asks === true ? 'ask' : 'info');
      return;
    }

    this.finishAs(id, result.ok ? 'done' : 'failed', result.spoken, { steps, notify: worth });
    if (options.announce === true) this.deps.say?.(result.spoken, 'done');
  }

  private finishAs(id: string, state: 'done' | 'failed', note: string, options: { readonly steps: readonly string[]; readonly notify: boolean }): void {
    const task = this.find(id);
    if (task === undefined) return;
    const now = this.clock();
    this.patch(id, (t) => {
      const { retryAt: _r, watch: _w, ...rest } = t;
      void _r;
      void _w;
      return { ...rest, state, note: short(note, 300), steps: [...options.steps], updatedAt: now, asks: false, told: true };
    });
    this.trim();
    if (options.notify) {
      this.notice(state === 'done' ? 'done' : 'failed', state === 'done' ? 'Eya finished' : "Eya couldn't finish", `${short(task.request)} — ${short(note, 140)}`, id);
    }
  }

  /** A question that was waiting for a yes or a no has had its answer (or has lapsed, because the person asked for something else). */
  answered(): void {
    const ids = this.tasks.filter((t) => t.state === 'needs_you' && t.asks === true).map((t) => t.id);
    for (const id of ids) this.finishAs(id, 'done', 'Answered.', { steps: this.find(id)?.steps ?? [], notify: false });
  }

  // ------------------------------------------------------------------------------------------------------------ the person's say
  /** Stops a task, or with no id the most recent open one. Returns how many were stopped. */
  cancel(id?: string): number {
    const target = id === undefined ? this.tasks.filter((t) => isOpen(t.state)).slice(0, 1) : this.tasks.filter((t) => t.id === id && isOpen(t.state));
    for (const t of target) this.cancelOne(t);
    return target.length;
  }

  cancelAll(): number {
    const open = this.tasks.filter((t) => isOpen(t.state));
    for (const t of open) this.cancelOne(t);
    return open.length;
  }

  private cancelOne(t: StoredTask, note = 'You stopped this.'): void {
    this.patch(t.id, (x) => {
      const { retryAt: _r, watch: _w, ...rest } = x;
      void _r;
      void _w;
      return { ...rest, state: 'cancelled', note, updatedAt: this.clock(), asks: false };
    });
    this.trim();
  }

  /** Tries a task that is waiting, or that was left for the person, again right away. */
  resume(id: string): boolean {
    const t = this.find(id);
    if (t === undefined || (t.state !== 'needs_you' && t.state !== 'waiting' && t.state !== 'failed' && t.state !== 'cancelled')) return false;
    this.patch(id, (x) => {
      const { watch: _w, ...rest } = x;
      void _w;
      return { ...rest, state: 'waiting', retryAt: this.clock(), note: 'Trying again now.', attempts: Math.min(x.attempts, this.cfg.maxAttempts - 1), asks: false, updatedAt: this.clock() };
    });
    void this.tick();
    return true;
  }

  clearFinished(): void {
    this.tasks = this.tasks.filter((t) => isOpen(t.state));
    this.changed();
  }

  act(action: TaskAction): TasksSnapshot {
    switch (action.kind) {
      case 'cancel':
        this.cancel(action.id);
        break;
      case 'cancel_all':
        this.cancelAll();
        break;
      case 'resume':
        this.resume(action.id);
        break;
      case 'clear_finished':
        this.clearFinished();
        break;
    }
    return this.snapshot();
  }

  // ------------------------------------------------------------------------------------------------------------ looking
  openTasks(): readonly StoredTask[] {
    return this.tasks.filter((t) => isOpen(t.state));
  }

  snapshot(): TasksSnapshot {
    const open = this.tasks.filter((t) => isOpen(t.state));
    const finished = this.tasks.filter((t) => !isOpen(t.state)).slice(0, FINISHED_VISIBLE);
    const view = (t: StoredTask): TaskView => ({
      id: t.id,
      request: t.request,
      state: t.state,
      note: t.note,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      attempts: t.attempts,
      retryAt: t.retryAt ?? null,
      asks: t.asks === true,
    });
    return { items: [...open, ...finished].map(view), open: open.length };
  }

  // ------------------------------------------------------------------------------------------------------------ the work
  /** Goes at whatever is due: one task at a time, and starts watching the browser for a person who is doing a check. Exposed for tests. */
  async tick(): Promise<void> {
    const now = this.clock();
    // Open for far too long: give up, quietly.
    for (const t of this.tasks.filter((x) => isOpen(x.state) && now - x.createdAt > this.cfg.keepMs)) {
      this.finishAs(t.id, 'failed', 'I gave up on this after a long time.', { steps: t.steps, notify: false });
    }
    for (const t of this.tasks.filter((x) => x.state === 'needs_you' && x.watch === 'browser' && !this.watching.has(x.id))) void this.watch(t.id);
    if (this.working) return;
    const due = this.tasks
      .filter((t) => t.state === 'waiting' && (t.retryAt ?? 0) <= now)
      .sort((a, b) => (a.retryAt ?? 0) - (b.retryAt ?? 0))[0];
    if (due === undefined) return;
    this.working = true;
    try {
      await this.runTask(due.id);
    } finally {
      this.working = false;
    }
  }

  private async runTask(id: string): Promise<void> {
    const started = this.clock();
    const t = this.patch(id, (x) => {
      const { retryAt: _r, ...rest } = x;
      void _r;
      return { ...rest, state: 'running', attempts: x.attempts + 1, note: 'Working on it again…', updatedAt: started };
    });
    if (t === undefined) return;
    log.info('carrying on with a task', { id, attempt: t.attempts, request: short(t.request, 60) });
    let result: AgentResult;
    try {
      result = await this.deps.run(t);
    } catch (err) {
      log.warn('a task failed with an error; it will be tried again', { id, err: String(err) });
      result = { requestId: id, ok: false, spoken: 'That did not work.', pending: { kind: 'retry', why: 'something went wrong' } };
    }
    this.settle(id, result, { elapsedMs: this.clock() - started });
  }

  /** The person is doing something in the browser that Eya cannot do for them (a check, a sign-in): watch, and carry on when it is done. */
  private async watch(id: string): Promise<void> {
    const watcher = this.deps.watchBrowser;
    if (watcher === undefined) return;
    this.watching.add(id);
    try {
      const deadline = this.clock() + WATCH_MS;
      while (this.clock() < deadline) {
        const t = this.find(id);
        if (t === undefined || t.state !== 'needs_you' || t.watch !== 'browser') return;
        const lookedAt = this.clock();
        const finished = await watcher(30_000).catch(() => false);
        // A look that came back at once (no browser to watch) is not repeated at once: that would spin.
        if (!finished && this.clock() - lookedAt < 1_000) await new Promise((r) => setTimeout(r, this.deps.watchPauseMs ?? 2_000));
        if (finished) {
          // (Something else may have settled it while this was looking: a task that is over is not brought back.)
          if (this.find(id)?.state !== 'needs_you') return;
          this.patch(id, (x) => {
            const { watch: _w, ...rest } = x;
            void _w;
            return { ...rest, state: 'waiting', retryAt: this.clock(), note: 'You finished, so Eya is carrying on.', asks: false, updatedAt: this.clock() };
          });
          void this.tick();
          return;
        }
      }
      // They are taking a long time: stop watching, and wait to be told.
      this.patch(id, (x) => {
        const { watch: _w, ...rest } = x;
        void _w;
        return { ...rest, note: 'Still waiting for you. Say "continue" when you have finished.', updatedAt: this.clock() };
      });
    } finally {
      this.watching.delete(id);
    }
  }

  // ------------------------------------------------------------------------------------------------------------ small things
  private find(id: string): StoredTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  private patch(id: string, fn: (t: StoredTask) => StoredTask): StoredTask | undefined {
    let out: StoredTask | undefined;
    this.tasks = this.tasks.map((t) => {
      if (t.id !== id) return t;
      out = fn(t);
      return out;
    });
    if (out !== undefined) this.changed();
    return out;
  }

  /** Open tasks stay; of the finished ones only the latest few are kept. */
  private trim(): void {
    const open = this.tasks.filter((t) => isOpen(t.state));
    const finished = this.tasks.filter((t) => !isOpen(t.state)).slice(0, FINISHED_KEPT);
    this.tasks = [...open, ...finished].sort((a, b) => b.updatedAt - a.updatedAt);
    this.save();
  }

  private notice(kind: TaskNotice['kind'], title: string, body: string, taskId: string): void {
    try {
      this.deps.notify({ kind, title, body, taskId });
    } catch (err) {
      log.warn('could not show a notification', { err: String(err) });
    }
  }

  private save(): void {
    this.deps.store.save(this.tasks);
  }

  private changed(): void {
    this.save();
    try {
      this.deps.onChange?.();
    } catch (err) {
      log.warn('a task listener failed; ignored', { err: String(err) });
    }
  }
}
