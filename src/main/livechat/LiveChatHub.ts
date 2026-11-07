import { maskNumbersIn } from '@main/chat/recipientResolver';
import { rootLogger } from '@main/logging/logger';
import { EMPTY_LIVE_CHAT_VIEW } from '@shared/liveChat';
import type { LiveChatPause, LiveChatRequest, LiveChatResult, LiveChatSummary, LiveChatView } from '@shared/liveChat';
import type { LiveChatController } from './LiveChatController';

const log = rootLogger.child('livechat');

/** The most live chats that run at once (each is given a turn in a cycle that must stay shorter than the time a paused chat is left alone: see LiveChatController.armPausedLimit). */
export const MAX_LIVE_CHATS = 5;

export interface HubTimers {
  set(fn: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}

export interface HubDeps {
  /** Makes the controller for slot 0, 1, 2 … (each has its own saved file). */
  make(slot: number): LiveChatController;
  /** Whether several live chats may run at once (a setting). Off: one, as before. */
  multi(): boolean;
  now?: () => number;
  timers?: HubTimers;
  /** How often the turn is looked at (ms). */
  tickMs?: number;
  /** How long a chat keeps the turn when nothing is going on in it (ms). */
  dwellMs?: number;
  /** How long it keeps it when the other person wrote a moment ago (ms). */
  hotDwellMs?: number;
}

/**
 * SEVERAL LIVE CHATS AT ONCE. WhatsApp Web shows one chat at a time, so the live chats take turns: one is "in front" (its chat is open, it is watched, it answers at once), the others
 * wait on standby, and when the one in front has nothing going on (no message waiting, nothing being written or sent, no reply waiting for approval) the turn passes to the next:
 * the chat in front is put on standby, the next one's chat is opened again by its name and checked to be the right one (the same Resume every live chat has), and whatever was
 * written to it while it waited is read and answered. A chat is never touched in the middle of a reply. A conversation that is going on (they wrote a moment ago) keeps the turn a
 * little longer. Each live chat keeps its own state, its own saved file and its own quiet-time limit; the person's words ("stop live chat") are about the one shown, and "stop all
 * live chats" is about all of them.
 *
 * Everything the controllers do on the page goes through the one send gate and the one chat session, and only one is acting at any moment: this class does one thing at a time.
 */
export class LiveChatHub {
  private readonly slots: Array<LiveChatController | undefined> = [];
  private front = 0;
  private frontSince = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: unknown = null;
  private disposed = false;
  private readonly listeners = new Set<(v: LiveChatView) => void>();

  constructor(private readonly deps: HubDeps) {
    this.ctrl(0);
  }

  // ------------------------------------------------------------------------------------------------------------------------------------ the controllers
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private max(): number {
    return MAX_LIVE_CHATS;
  }

  private ctrl(slot: number): LiveChatController {
    let c = this.slots[slot];
    if (c === undefined) {
      c = this.deps.make(slot);
      this.slots[slot] = c;
      c.onChange(() => this.emit());
    }
    return c;
  }

  /** The slots whose live chat has not ended. */
  private live(): number[] {
    const out: number[] = [];
    this.slots.forEach((c, i) => {
      if (c !== undefined && c.view().active) out.push(i);
    });
    return out;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const v = this.view();
    for (const l of [...this.listeners]) l(v);
  }

  // ------------------------------------------------------------------------------------------------------------------------------------ what the page and the tools see
  view(): LiveChatView {
    // (the one in front; when it has ended and another is still running, that one)
    const live = this.live();
    if (live.length > 0 && !live.includes(this.front)) this.front = live[0] as number;
    const base = this.ctrl(this.front).view();
    if (live.length < 2) return base;
    const chats: LiveChatSummary[] = live.map((slot) => {
      const v = this.ctrl(slot).view();
      return { id: v.sessionId ?? `slot${slot}`, chat: maskNumbersIn(v.chat ?? 'a chat'), state: v.state, pause: v.pause, relation: v.relation ?? null, replies: v.replies, front: slot === this.front };
    });
    return { ...base, chats };
  }

  onChange(listener: (v: LiveChatView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(): void {
    for (const c of this.slots) c?.refresh();
  }

  /** At start-up: every saved live chat comes back paused (or is not brought back at all if it is old): see LiveChatController.restore. */
  restore(): boolean {
    let any = false;
    for (let i = 0; i < this.max(); i += 1) {
      if (this.ctrl(i).restore()) {
        if (!any) this.front = i;
        any = true;
      }
    }
    this.frontSince = this.now();
    this.start();
    return any;
  }

  /** Pauses every live chat that is running (Communication Access or the permission was switched off). */
  async pause(why: LiveChatPause, message?: string): Promise<void> {
    await this.serial(async () => {
      for (const slot of this.live()) await this.ctrl(slot).pause(why, message);
    });
  }

  // ------------------------------------------------------------------------------------------------------------------------------------ requests
  handle(request: LiveChatRequest): Promise<LiveChatResult> {
    return this.serial(async () => {
      switch (request.kind) {
        case 'start':
          return this.begin(request);
        case 'stop':
          return this.stop(request);
        case 'focus':
          return this.focus(request.chat);
        default:
          return this.ctrl(this.front).handle(request);
      }
    });
  }

  private result(ok: boolean, message: string): LiveChatResult {
    return { ok, message, view: this.view() };
  }

  /** The chat in front waits for its turn: nothing is lost (a reply being written is not cut off: it is paused when it is done). */
  private async putOnStandby(slot: number): Promise<void> {
    const c = this.ctrl(slot);
    const state = c.view().state;
    // (a chat that is not watching anything already — paused, over, still asking which chat — has nothing to put aside; any other one must stop watching, or two would read the one page)
    if (state === 'PAUSED' || state === 'WAITING_FOR_USER' || !c.view().active) return;
    if (!(await c.standby())) await c.pause('standby');
  }

  private freeSlot(): number | null {
    for (let i = 0; i < this.max(); i += 1) {
      const c = this.slots[i];
      if (c === undefined || !c.view().active) return i;
    }
    return null;
  }

  private async begin(request: Extract<LiveChatRequest, { kind: 'start' }>): Promise<LiveChatResult> {
    this.start();
    const live = this.live();
    const front = this.ctrl(this.front);
    // One at a time (the setting is off), nothing running yet, or an unfinished try at choosing the chat: the controller's own rules, as before.
    if (!this.deps.multi() || live.length === 0 || front.view().state === 'WAITING_FOR_USER') {
      this.frontSince = this.now();
      return this.ctrl(this.front).handle(request);
    }
    if (live.length >= this.max()) {
      return this.result(false, `${live.length} live chats are already running, which is the most at once. Stop one first: say "stop live chat" (the one shown), or "stop all live chats".`);
    }
    const slot = this.freeSlot();
    if (slot === null) return this.result(false, 'All the places for live chats are in use. Stop one first.');
    const previous = this.front;
    await this.putOnStandby(previous);
    this.front = slot;
    this.frontSince = this.now();
    const started = await this.ctrl(slot).handle(request);
    const v = this.ctrl(slot).view();
    if (!v.active) {
      // it did not start: the one that was in front has the turn again
      this.front = previous;
      this.frontSince = this.now();
      await this.ctrl(previous).resume();
      return { ...started, view: this.view() };
    }
    // the same chat in two places would answer twice: the new one is ended, and the one that was there goes on
    const label = (v.chat ?? '').toLowerCase();
    const twin = live.find((s) => (this.ctrl(s).view().chat ?? '').toLowerCase() === label && label !== '');
    if (twin !== undefined) {
      await this.ctrl(slot).stop();
      this.front = twin;
      this.frontSince = this.now();
      await this.ctrl(twin).resume();
      return this.result(false, `A live chat with ${maskNumbersIn(v.chat ?? 'that chat')} is already running.`);
    }
    const others = this.live().length - 1;
    return { ...started, message: `${started.message} ${others} other live chat${others === 1 ? ' is' : 's are'} waiting for ${others === 1 ? 'its' : 'their'} turn: I look after each in turn, and the one shown is this one.`, view: this.view() };
  }

  private async stop(request: Extract<LiveChatRequest, { kind: 'stop' }>): Promise<LiveChatResult> {
    const live = this.live();
    if (request.all === true) {
      for (const slot of live) await this.ctrl(slot).stop();
      return this.result(true, live.length > 1 ? `Stopped all ${live.length} live chats. Nothing more will be read, drafted or sent.` : 'Stopped. Nothing more will be read, drafted or sent.');
    }
    let target = this.front;
    if (request.chat !== undefined) {
      const found = live.find((s) => this.ctrl(s).view().sessionId === request.chat);
      if (found === undefined) return this.result(false, 'That live chat is not running.');
      target = found;
    }
    const label = maskNumbersIn(this.ctrl(target).view().chat ?? 'the chat');
    const done = await this.ctrl(target).handle({ kind: 'stop' });
    const rest = this.live();
    if (rest.length === 0) return { ...done, view: this.view() };
    // the others go on: one of them has the turn now
    if (target === this.front) await this.promote(rest);
    return { ...done, message: `Stopped the live chat with ${label}. ${rest.length} other live chat${rest.length === 1 ? ' is' : 's are'} still running; say "stop all live chats" to end ${rest.length === 1 ? 'it' : 'them'} too.`, view: this.view() };
  }

  /** The one in front has ended: the next live chat that waits gets the turn. */
  private async promote(live: readonly number[] = this.live()): Promise<void> {
    const order = [...live.filter((s) => s > this.front), ...live.filter((s) => s < this.front)];
    for (const slot of order) {
      const c = this.ctrl(slot);
      const v = c.view();
      if (v.state === 'PAUSED' && v.pause === 'standby') {
        await c.resume();
        this.front = slot;
        this.frontSince = this.now();
        return;
      }
    }
    if (live.length > 0) this.front = live[0] as number;
  }

  private async focus(chat: string): Promise<LiveChatResult> {
    const slot = this.live().find((s) => this.ctrl(s).view().sessionId === chat);
    if (slot === undefined) return this.result(false, 'That live chat is not running.');
    if (slot === this.front) return this.result(true, 'That one is already the one shown.');
    await this.putOnStandby(this.front);
    const c = this.ctrl(slot);
    if (c.view().state === 'PAUSED') await c.resume();
    this.front = slot;
    this.frontSince = this.now();
    return this.result(true, `Now showing the live chat with ${maskNumbersIn(c.view().chat ?? 'the chat')}.`);
  }

  // ------------------------------------------------------------------------------------------------------------------------------------ taking turns
  private start(): void {
    if (this.timer !== null || this.disposed) return;
    const tick = this.deps.tickMs ?? 8_000;
    const run = (): void => {
      this.timer = null;
      if (this.disposed) return;
      void this.serial(() => this.rotate()).finally(() => {
        if (!this.disposed) this.timer = this.schedule(run, tick);
      });
    };
    this.timer = this.schedule(run, tick);
  }

  private schedule(fn: () => void, ms: number): unknown {
    return this.deps.timers !== undefined ? this.deps.timers.set(fn, ms) : setTimeout(fn, ms);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      if (this.deps.timers !== undefined) this.deps.timers.clear(this.timer);
      else clearTimeout(this.timer as ReturnType<typeof setTimeout>);
      this.timer = null;
    }
  }

  /** One look at whose turn it is. Public for the tests; the timer calls it. */
  async rotate(): Promise<void> {
    if (!this.deps.multi()) return;
    const live = this.live();
    if (live.length < 2) return;
    const front = this.ctrl(this.front);
    const fv = front.view();
    if (!fv.active || !live.includes(this.front)) {
      await this.promote(live);
      return;
    }
    // Only a chat with nothing going on gives its turn up: never one that is writing, sending, or waiting for the person (standby() below refuses unless it is settled, which includes being active).
    const kept = this.now() - this.frontSince;
    const wanted = front.quietMs() < 90_000 ? (this.deps.hotDwellMs ?? 75_000) : (this.deps.dwellMs ?? 25_000);
    if (kept < wanted) return;
    const order = [...live.filter((s) => s > this.front), ...live.filter((s) => s < this.front)];
    const next = order.find((s) => {
      const v = this.ctrl(s).view();
      return v.state === 'PAUSED' && v.pause === 'standby';
    });
    if (next === undefined) return; // (the others were paused by the person, or are not ready: they are not woken)
    if (!(await front.standby())) return;
    const c = this.ctrl(next);
    await c.resume();
    const after = c.view();
    if (after.active && (after.state === 'ACTIVE' || after.state === 'PROCESSING_MESSAGE' || after.state === 'DRAFT_READY' || after.state === 'WAITING_FOR_APPROVAL')) {
      this.front = next;
      this.frontSince = this.now();
      log.info('the turn passed to the next live chat', { live: live.length });
      return;
    }
    // it could not be brought forward (the chat did not open, it was stopped): the one that waited has the turn again
    log.info('the next live chat could not take its turn; the one before goes on', { state: after.state });
    await front.resume();
    this.frontSince = this.now();
  }
}
