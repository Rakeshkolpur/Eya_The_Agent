/**
 * Turns a burst of saves into one. A store that rewrites a whole file on every change (the chat history is rewritten each time a message is added; at its
 * largest that is 40 ms of the main process, measured) asks for the write with `schedule`; what is written is whatever was asked for last, once, a moment
 * later. `flush` writes it now (the app is closing, or the person must not lose this). With a delay of 0 nothing is deferred and every save is written as
 * it is asked for, which is how the stores behave when they are not given a delay.
 *
 * What is written is built at the moment of the write, not when it was asked for, so a burst of ten changes is turned into text once, not ten times.
 */
export class CoalescedWriter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: (() => void) | null = null;

  constructor(private readonly delayMs: number = 0) {}

  /** Ask for a write (a function that does it). Written after the delay unless a later one replaces it first. */
  schedule(write: () => void): void {
    if (this.delayMs <= 0) {
      write();
      return;
    }
    this.pending = write;
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.delayMs);
      // (a pending save must not keep the process alive: the app flushes on its way out)
      this.timer.unref?.();
    }
  }

  /** Writes what is waiting, now. Does nothing when nothing is waiting. */
  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const write = this.pending;
    this.pending = null;
    if (write !== null) write();
  }

  /** Forgets what is waiting without writing it (a fuller save is about to be written, which makes it out of date). */
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  /** Whether a write is waiting. */
  get waiting(): boolean {
    return this.pending !== null;
  }
}
