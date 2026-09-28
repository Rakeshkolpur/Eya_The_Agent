import { cleanTranscript } from './sttText';
import type { SttBackend } from './sttBackend';
import type { SttRequest, SttResponse } from './sttWorker';

export type SttState = 'idle' | 'loading' | 'ready' | 'failed';

/** The slice of Worker this needs, so tests can supply a fake. */
export interface SttWorkerLike {
  postMessage(message: SttRequest, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<SttResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface LocalSttOptions {
  /** A transcription that hasn't come back by then is abandoned (caller falls back). */
  readonly transcribeTimeoutMs: number;
  /** 'auto' tries the graphics chip and keeps it only if faster; 'wasm' forces the processor. */
  readonly backend?: 'auto' | SttBackend;
}

interface Pending {
  readonly resolve: (text: string | null) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * On-device speech recognition. `transcribe` resolves with:
 *   - the cleaned text ('' if it was silence or noise),
 *   - or null when local recognition can't answer (still loading, failed,
 *     timed out), meaning the caller should fall back to another route.
 */
export class LocalStt {
  private worker: SttWorkerLike | null = null;
  private current: SttState = 'idle';
  private activeBackend: SttBackend = 'wasm';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(state: SttState, detail?: string) => void>();

  constructor(
    private readonly makeWorker: () => SttWorkerLike,
    private readonly opts: LocalSttOptions = { transcribeTimeoutMs: 12_000 },
  ) {}

  get state(): SttState {
    return this.current;
  }

  /** What is doing the recognizing right now: the processor, or the graphics chip once it has proved faster. */
  get backend(): SttBackend {
    return this.activeBackend;
  }

  onState(listener: (state: SttState, detail?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Begins loading the model in the background. Safe to call more than once. */
  start(): void {
    if (this.worker !== null || this.current === 'failed') return;
    let worker: SttWorkerLike;
    try {
      worker = this.makeWorker();
    } catch (err) {
      this.setState('failed', err instanceof Error ? err.message : String(err));
      return;
    }
    this.worker = worker;
    this.setState('loading');
    worker.onmessage = (event) => this.handle(event.data);
    worker.onerror = (event) => this.fail(`speech worker crashed: ${event.message}`);
    worker.postMessage(this.opts.backend === undefined ? { type: 'init' } : { type: 'init', backend: this.opts.backend });
  }

  transcribe(samples: Float32Array): Promise<string | null> {
    if (this.current !== 'ready' || this.worker === null) return Promise.resolve(null);
    // One at a time: the model isn't built for overlapping requests.
    const job = this.chain.then(() => this.run(samples));
    this.chain = job.catch(() => undefined);
    return job;
  }

  private run(samples: Float32Array): Promise<string | null> {
    const worker = this.worker;
    if (this.current !== 'ready' || worker === null) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, this.opts.transcribeTimeoutMs);
      this.pending.set(id, { resolve, timer });
      // Send a copy: the caller may still need the samples if we fall back.
      const copy = samples.slice();
      worker.postMessage({ type: 'transcribe', id, samples: copy }, [copy.buffer]);
    });
  }

  private handle(msg: SttResponse): void {
    switch (msg.type) {
      case 'progress':
        this.notify(`downloading speech model ${msg.percent}%`);
        break;
      case 'ready': {
        this.activeBackend = msg.backend;
        const loaded = msg.loadMs > 0 ? `loaded in ${msg.loadMs}ms, ` : '';
        const note = msg.note !== undefined ? ` (${msg.note})` : '';
        this.setState('ready', `${loaded}using ${msg.backend === 'webgpu' ? 'the graphics chip' : `the processor, ${msg.threads} thread${msg.threads === 1 ? '' : 's'}`}${note}`);
        break;
      }
      case 'init-failed':
        this.fail(msg.error);
        break;
      case 'result': {
        const entry = this.pending.get(msg.id);
        if (entry === undefined) return; // already timed out
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg.error !== undefined ? null : cleanTranscript(msg.text));
        break;
      }
    }
  }

  private fail(detail: string): void {
    this.setState('failed', detail);
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve(null);
    }
    this.pending.clear();
  }

  private setState(state: SttState, detail?: string): void {
    this.current = state;
    this.notify(detail);
  }

  private notify(detail?: string): void {
    for (const listener of this.listeners) listener(this.current, detail);
  }
}
