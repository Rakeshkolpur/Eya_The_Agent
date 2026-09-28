import { PcmCoalescer, pcm16ToFloat32 } from './pcm';

const SAMPLE_RATE = 24_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
// Start once ~120ms is in hand, then schedule in ~200ms batches.
const FIRST_BATCH_BYTES = Math.round(BYTES_PER_SECOND * 0.12);
const BATCH_BYTES = Math.round(BYTES_PER_SECOND * 0.2);
const START_LEAD_S = 0.04;

let context: AudioContext | null = null;

function audioContext(): AudioContext {
  if (context === null || context.state === 'closed') {
    context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  }
  if (context.state === 'suspended') void context.resume();
  return context;
}

export interface PcmPlayback {
  /** Add audio; playback starts as soon as there is enough. */
  push(pcm: Uint8Array): void;
  /** No more audio is coming; `finished` resolves once it has all played. */
  end(): void;
  /** Silence immediately. */
  stop(): void;
  readonly finished: Promise<void>;
}

/**
 * Plays a stream of 24kHz mono 16-bit PCM without gaps by scheduling each
 * batch to start exactly when the previous one ends.
 */
export function createPcmPlayback(): PcmPlayback {
  const ctx = audioContext();
  const coalescer = new PcmCoalescer(FIRST_BATCH_BYTES, BATCH_BYTES);
  const playing = new Set<AudioBufferSourceNode>();
  let nextStart = 0;
  let ended = false;
  let stopped = false;
  let settle: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const maybeFinish = (): void => {
    if ((ended || stopped) && playing.size === 0) settle();
  };

  const schedule = (bytes: Uint8Array): void => {
    const samples = pcm16ToFloat32(bytes);
    if (samples.length === 0) return;
    const buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    // If the network fell behind, playback resumes from "now" (a brief gap)
    // rather than trying to catch up in the past.
    const startAt = Math.max(ctx.currentTime + START_LEAD_S, nextStart);
    source.start(startAt);
    nextStart = startAt + buffer.duration;
    playing.add(source);
    source.onended = () => {
      playing.delete(source);
      maybeFinish();
    };
  };

  return {
    push(pcm) {
      if (stopped || ended) return;
      const batch = coalescer.push(pcm);
      if (batch !== null) schedule(batch);
    },
    end() {
      if (stopped || ended) return;
      ended = true;
      const rest = coalescer.flush();
      if (rest !== null) schedule(rest);
      maybeFinish();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const source of playing) {
        try {
          source.stop();
        } catch {
          // Already finished.
        }
      }
      playing.clear();
      settle();
    },
    finished,
  };
}
