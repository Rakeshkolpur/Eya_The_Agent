/**
 * While Eya is working for the person (a request she is carrying out, a task she is keeping), the PC must not fall asleep under her: a sleeping PC is an Eya that
 * went offline in the middle of the job, and the person, busy with their own work, did nothing to cause it. This holds the system awake (the screen may still turn
 * off) for as long as anything is being worked on, and lets go the moment nothing is. Nothing else is touched.
 *
 * Each piece of work holds it under its own name, so two jobs ending at different times cannot release each other's. Work that has held it for hours is taken to be
 * stuck (a task that never ends must not keep a laptop awake all night), and is let go.
 */

export interface PowerBlocker {
  start(kind: 'prevent-app-suspension'): number;
  stop(id: number): void;
  isStarted?(id: number): boolean;
}

/** The longest one piece of work may hold the PC awake (ms). */
export const MAX_HOLD_MS = 3 * 60 * 60_000;

export class KeepAwake {
  private readonly holds = new Map<string, number>();
  private blockerId: number | null = null;

  constructor(
    private readonly blocker: PowerBlocker,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts (or renews) a hold for this piece of work. */
  hold(name: string): void {
    this.drop();
    if (!this.holds.has(name)) this.holds.set(name, this.now());
    this.sync();
  }

  /** The work ended. */
  release(name: string): void {
    this.holds.delete(name);
    this.drop();
    this.sync();
  }

  /** Sets what the tasks hold: any open task holds, none does not. (Called whenever the tasks change.) */
  setTasksOpen(open: number): void {
    if (open > 0) this.hold('tasks');
    else this.release('tasks');
  }

  /** The PC is being held awake right now. */
  get holding(): boolean {
    return this.blockerId !== null;
  }

  /** Called every so often: work that has held it for hours is let go even if nothing else happened. */
  sweep(): void {
    this.drop();
    this.sync();
  }

  /** Lets go of everything (at quit). */
  releaseAll(): void {
    this.holds.clear();
    this.sync();
  }

  /** Work that has been held for hours is stuck: it no longer keeps the PC awake. */
  private drop(): void {
    const now = this.now();
    for (const [name, since] of this.holds) if (now - since > MAX_HOLD_MS) this.holds.delete(name);
  }

  private sync(): void {
    if (this.holds.size > 0 && this.blockerId === null) this.blockerId = this.blocker.start('prevent-app-suspension');
    else if (this.holds.size === 0 && this.blockerId !== null) {
      this.blocker.stop(this.blockerId);
      this.blockerId = null;
    }
  }
}

/** What the agent's updates say about work: working → a hold for that request; anything else for that request → released. */
export function trackAgentWork(keepAwake: Pick<KeepAwake, 'hold' | 'release'>, update: { readonly requestId: string; readonly state: string }): void {
  if (update.state === 'working') keepAwake.hold(`request:${update.requestId}`);
  else if (update.state !== 'thinking') keepAwake.release(`request:${update.requestId}`);
}
