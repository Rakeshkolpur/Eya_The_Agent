import { createHash } from 'node:crypto';
import type { ScreenAskRequest, ScreenAskResult, ScreenFrame, ScreenShareStatus } from '@shared/ipcContract';
import { rootLogger } from '@main/logging/logger';

const log = rootLogger.child('screenshare');

/** How often a picture is taken, and how long sharing may run with nobody asking or talking before it switches itself off. */
export const FRAME_INTERVAL_MS = 1_000;
export const IDLE_STOP_MS = 15 * 60_000;
/** Pictures that fail this many times in a row end the sharing, rather than failing quietly forever. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** A question about the screen is given this long in all (Gemini tries several models, each with its own wait) before it is called too slow. */
export const ASK_TIMEOUT_MS = 45_000;

export interface ShareDeps {
  /** A picture of the whole screen the user is on (PNG bytes). */
  capture(): Promise<{ readonly bytes: Buffer }>;
  /** A small JPEG of it for the stream: what the preview shows and what a live conversation sees. */
  toFrame(png: Buffer): { readonly bytes: Buffer; readonly width: number; readonly height: number };
  /** A larger, sharper JPEG for answering a question about the screen. */
  toAnswerImage(png: Buffer): { readonly bytes: Buffer; readonly mime: string };
  /** The titles of the windows showing on the screen. */
  windowTitles(): Promise<readonly string[]>;
  /** The chat app this window title belongs to, if Chats are OFF for it; otherwise null. */
  blockedBy(title: string): string | null;
  /** Reads a picture and answers (Gemini). */
  analyze(bytes: Buffer, mime: string, prompt: string): Promise<string>;
  /** Takes anything that looks like a secret out of an answer. */
  scrub(text: string): string;
  /** Turns on or off hiding Eya's own windows from the picture. */
  protectOwnWindows(on: boolean): void;
  emitFrame(frame: ScreenFrame): void;
  emitStatus(status: ScreenShareStatus): void;
  /** A user-readable reason for a failed question (a Gemini limit, say). */
  explainError?(err: unknown): string;
  now?: () => number;
  schedule?(fn: () => void, ms: number): unknown;
  cancel?(handle: unknown): void;
  intervalMs?: number;
  idleMs?: number;
  askTimeoutMs?: number;
}

class AskTooSlow extends Error {
  constructor() {
    super('reading the screen took too long');
    this.name = 'AskTooSlow';
  }
}

/** What Gemini is asked about the picture. The answer is read aloud, so it must read as speech, and never carry a secret. */
export function buildAskPrompt(request: ScreenAskRequest): string {
  const base =
    "You are the eyes of a voice assistant on a Windows PC. This is a picture of the user's whole screen right now. " +
    'Speak to the user directly, in plain words: your answer will be read aloud, so no markdown, bullet symbols or headings; if there are steps say "first", "then", "after that". ' +
    'Be concise (under 120 words unless more is asked for). Never read out passwords, card numbers, one-time codes or other secrets: say "a password field" or "a card number" instead. ' +
    'If you cannot tell, say so; do not guess or invent anything that is not in the picture.';
  const question = request.question?.trim() ?? '';
  // Asking "nothing in particular" is asking what is there.
  const mode = request.mode === 'ask' && question === '' ? 'analyze' : request.mode;
  if (mode === 'explain') {
    return `${base}\nExplain what the user is looking at, as if to someone new to it: what it is, what it is for, and what the parts on the screen mean.`;
  }
  if (mode === 'next') {
    return `${base}\nWork out what the user is most likely trying to do here and tell them what to do next, step by step, saying where to click (left, right, top, bottom, centre) using only what is visible.`;
  }
  if (mode === 'ask') {
    return `${base}\nThe user asks: ${question}\nIf it is a how-to question, give short steps that point to what is visible and where it is on the screen.`;
  }
  return `${base}\nSay what is on the screen: the main application, what it is showing, and anything that looks important.`;
}

/**
 * Screen sharing: while it is on, Eya takes a picture of the screen about once a second and passes each CHANGED picture on — to the
 * preview, and to a live conversation if there is one — and can answer a question about what is on the screen right now.
 *
 * It is only ever on because the user turned it on, and it keeps itself honest: Eya's own windows are left out of the picture; if a
 * chat app that Chats are OFF for is showing anywhere, no picture is taken or passed on until it is gone; pictures are never saved; it
 * switches itself off after a quiet spell; and repeated failures end it with a reason instead of failing quietly.
 */
export class ScreenShare {
  private active = false;
  private paused: ScreenShareStatus['paused'] = null;
  private startedAt: number | null = null;
  private frames = 0;
  private lastHash = '';
  private lastTouch = 0;
  private failures = 0;
  private inFlight = false;
  private timer: unknown = null;
  private stopped: { reason: NonNullable<ScreenShareStatus['stopped']>; message?: string } | null = null;

  constructor(private readonly deps: ShareDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  status(): ScreenShareStatus {
    return {
      active: this.active,
      paused: this.paused,
      startedAt: this.startedAt,
      frames: this.frames,
      ...(this.stopped !== null ? { stopped: this.stopped.reason, ...(this.stopped.message !== undefined ? { message: this.stopped.message } : {}) } : {}),
    };
  }

  /** Turns sharing on. (The user's yes happens in the UI, or in the conversation, before this is called.) */
  start(): ScreenShareStatus {
    if (this.active) return this.status();
    this.active = true;
    this.paused = null;
    this.startedAt = this.now();
    this.frames = 0;
    this.lastHash = '';
    this.failures = 0;
    this.lastTouch = this.now();
    this.stopped = null;
    this.deps.protectOwnWindows(true);
    log.info('screen sharing started');
    this.deps.emitStatus(this.status());
    this.plan(0);
    return this.status();
  }

  stop(reason: NonNullable<ScreenShareStatus['stopped']> = 'user', message?: string): ScreenShareStatus {
    if (!this.active) return this.status();
    this.active = false;
    this.paused = null;
    this.cancelPlan();
    this.deps.protectOwnWindows(false);
    this.stopped = { reason, ...(message !== undefined ? { message } : {}) };
    log.info('screen sharing stopped', { reason, frames: this.frames });
    this.deps.emitStatus(this.status());
    return this.status();
  }

  /** The user is still here (asking, or talking about the screen). */
  touch(): void {
    this.lastTouch = this.now();
  }

  dispose(): void {
    this.stop('quit');
  }

  // --------------------------------------------------------------------------------------------- the stream
  private plan(ms: number): void {
    this.cancelPlan();
    const schedule = this.deps.schedule ?? ((fn, delay) => setTimeout(fn, delay));
    this.timer = schedule(() => void this.tick(), ms);
  }

  private cancelPlan(): void {
    if (this.timer !== null) (this.deps.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  /** The chat app (switched off) showing anywhere on the screen right now, or null. */
  private async blockedApp(): Promise<string | null> {
    for (const title of await this.deps.windowTitles()) {
      const app = this.deps.blockedBy(title);
      if (app !== null) return app;
    }
    return null;
  }

  private setPaused(next: ScreenShareStatus['paused']): void {
    if (this.paused?.app === next?.app && (this.paused === null) === (next === null)) return;
    this.paused = next;
    this.lastHash = ''; // after a pause the first picture is always passed on
    this.deps.emitStatus(this.status());
  }

  /** One round: take a picture if allowed, pass it on if it changed. (Public so tests can drive it.) */
  async tick(): Promise<void> {
    if (!this.active || this.inFlight) return;
    this.inFlight = true;
    try {
      if (this.now() - this.lastTouch > (this.deps.idleMs ?? IDLE_STOP_MS)) {
        this.stop('idle', 'Screen sharing switched itself off after a quiet spell.');
        return;
      }
      const before = await this.blockedApp();
      if (!this.active) return;
      if (before !== null) {
        this.setPaused({ reason: 'chat_app', app: before });
        this.failures = 0;
        return;
      }
      const picture = await this.deps.capture();
      if (!this.active) return;
      // A chat app can open between the check and the picture: look again, and throw the picture away if so.
      const after = await this.blockedApp();
      if (!this.active) return;
      if (after !== null) {
        this.setPaused({ reason: 'chat_app', app: after });
        return;
      }
      this.setPaused(null);
      const frame = this.deps.toFrame(picture.bytes);
      const hash = createHash('sha1').update(frame.bytes).digest('hex');
      this.failures = 0;
      if (hash === this.lastHash) return; // nothing changed: nothing to pass on
      this.lastHash = hash;
      this.frames += 1;
      this.deps.emitFrame({ jpeg: frame.bytes.toString('base64'), width: frame.width, height: frame.height, at: this.now() });
    } catch (err) {
      this.failures += 1;
      log.warn('could not take a picture of the screen', { err: String(err), failures: this.failures });
      if (this.failures >= MAX_CONSECUTIVE_FAILURES) this.stop('error', 'Windows would not let Eya capture the screen, so sharing was switched off.');
    } finally {
      this.inFlight = false;
      if (this.active) this.plan(this.deps.intervalMs ?? FRAME_INTERVAL_MS);
    }
  }

  // ------------------------------------------------------------------------------------------ asking about it
  /** Answers a question about what is on the screen RIGHT NOW (a fresh, sharper picture — not the last frame). */
  async ask(request: ScreenAskRequest): Promise<ScreenAskResult> {
    if (!this.active) return { ok: false, error: 'Screen sharing is off. Turn it on first, then ask me about the screen.' };
    this.touch();
    try {
      const blocked = await this.blockedApp();
      if (blocked !== null) return { ok: false, error: this.refusal(blocked) };
      const picture = await this.deps.capture();
      const after = await this.blockedApp();
      if (after !== null) return { ok: false, error: this.refusal(after) };
      const image = this.deps.toAnswerImage(picture.bytes);
      const answer = this.deps.scrub((await this.withinTime(this.deps.analyze(image.bytes, image.mime, buildAskPrompt(request)))).trim());
      if (answer === '') return { ok: false, error: 'I looked, but I could not make anything of the screen. Try again in a moment.' };
      return { ok: true, answer };
    } catch (err) {
      log.warn('could not answer about the screen', { err: String(err) });
      if (err instanceof AskTooSlow) return { ok: false, error: 'Gemini is taking too long to read the screen right now (it is probably busy). Try again in a moment.' };
      return { ok: false, error: this.deps.explainError?.(err) ?? "I couldn't read the screen just now." };
    }
  }

  /** Gives the reading a limit: busy servers can otherwise keep a question hanging for a minute or more. */
  private withinTime<T>(work: Promise<T>): Promise<T> {
    const limit = this.deps.askTimeoutMs ?? ASK_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AskTooSlow()), limit);
      work.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  private refusal(app: string): string {
    return `${app} is open on the screen and Chats are off for it, so I am not looking at the screen. Close it, or turn Chats on in Settings.`;
  }
}
