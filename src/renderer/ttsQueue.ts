export type Priority = 'high' | 'low';

interface Job {
  readonly text: string;
  readonly resolve: (wav: ArrayBuffer | null) => void;
}

/**
 * Runs speech-generation jobs one at a time. Kokoro can only do one phrase
 * at once, and a phrase takes seconds, so ordering matters: a reply the user
 * is waiting on (high) must jump ahead of background pre-generation (low).
 */
export class GenerationQueue {
  private pending: Job[] = [];
  private busy = false;
  private ready = false;

  constructor(private readonly run: (text: string) => Promise<ArrayBuffer | null>) {}

  /** Jobs are held until the engine has loaded. */
  setReady(ready: boolean): void {
    this.ready = ready;
    this.pump();
  }

  enqueue(text: string, priority: Priority): Promise<ArrayBuffer | null> {
    return new Promise((resolve) => {
      const job: Job = { text, resolve };
      if (priority === 'high') this.pending.unshift(job);
      else this.pending.push(job);
      this.pump();
    });
  }

  /** Something already queued in the background is now urgent. */
  bump(text: string): void {
    const index = this.pending.findIndex((j) => j.text === text);
    if (index <= 0) return;
    const [job] = this.pending.splice(index, 1);
    if (job !== undefined) this.pending.unshift(job);
  }

  /** The engine is gone: release everyone waiting with "no audio". */
  failAll(): void {
    this.ready = false;
    const stranded = this.pending;
    this.pending = [];
    for (const job of stranded) job.resolve(null);
  }

  get queued(): number {
    return this.pending.length;
  }

  private pump(): void {
    if (this.busy || !this.ready) return;
    const job = this.pending.shift();
    if (job === undefined) return;
    this.busy = true;
    void this.run(job.text)
      .then(
        (wav) => job.resolve(wav),
        () => job.resolve(null),
      )
      .finally(() => {
        this.busy = false;
        this.pump();
      });
  }
}
