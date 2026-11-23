export interface DetectorOptions {
  /** Sustained loudness needed before we call it speech. */
  readonly startMs: number;
  /** Trailing quiet that ends an utterance. */
  readonly endSilenceMs: number;
  /** Utterances with less actual voiced audio than this are noise. */
  readonly minVoicedMs: number;
  readonly maxUtteranceMs: number;
  /** Audio kept from before speech was detected so the first word isn't clipped. */
  readonly prerollMs: number;
  readonly minStartThreshold: number;
  readonly minContinueThreshold: number;
}

export const DEFAULT_DETECTOR_OPTIONS: DetectorOptions = {
  startMs: 100,
  endSilenceMs: 550,
  minVoicedMs: 250,
  // A command is a few seconds. Longer than this is conversation, not a
  // command, so it is dropped instead of being sent for transcription.
  maxUtteranceMs: 10_000,
  prerollMs: 400,
  minStartThreshold: 0.02,
  minContinueThreshold: 0.012,
};

export type DetectorEvent =
  | { readonly type: 'start' }
  | { readonly type: 'discard' }
  | {
      readonly type: 'utterance';
      readonly samples: Float32Array;
      readonly sampleRate: number;
      readonly durationMs: number;
      readonly voicedMs: number;
    };

export function computeRms(chunk: Float32Array): number {
  if (chunk.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < chunk.length; i += 1) {
    const v = chunk[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / chunk.length);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Splits a continuous mic stream into utterances. Thresholds adapt to the
 * room: `noiseFloor` tracks background level while idle, and speech must
 * rise well above it. Feed it fixed-rate chunks via push(); it returns
 * events. Time is measured in audio samples, not wall-clock, so it behaves
 * identically at any chunk size or sample rate.
 */
export class UtteranceDetector {
  // 'lockout': an over-long utterance was dropped; stay quiet until the
  // talking actually stops, so the rest of it isn't re-detected as new speech.
  private state: 'idle' | 'speech' | 'lockout' = 'idle';
  private noiseFloor = 0.005;
  private preroll: Float32Array[] = [];
  private prerollMs = 0;
  private frames: Float32Array[] = [];
  private totalMs = 0;
  private voicedMs = 0;
  private silenceMs = 0;
  private aboveMs = 0;
  private cooldownMs = 0;
  private lastSampleRate = 16_000;

  constructor(private readonly opts: DetectorOptions = DEFAULT_DETECTOR_OPTIONS) {}

  /** Drop any in-progress utterance and ignore audio for `cooldownMs`. */
  reset(cooldownMs = 0): void {
    this.state = 'idle';
    this.preroll = [];
    this.prerollMs = 0;
    this.frames = [];
    this.totalMs = 0;
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.aboveMs = 0;
    this.cooldownMs = cooldownMs;
  }

  push(chunk: Float32Array, sampleRate: number): DetectorEvent[] {
    const events: DetectorEvent[] = [];
    if (chunk.length === 0) return events;
    this.lastSampleRate = sampleRate;
    const dur = (chunk.length / sampleRate) * 1000;
    const rms = computeRms(chunk);

    if (this.cooldownMs > 0) {
      this.cooldownMs -= dur;
      return events;
    }

    if (this.state === 'lockout') {
      const continueThreshold = Math.max(this.opts.minContinueThreshold, this.noiseFloor * 2.2);
      if (rms >= continueThreshold) this.silenceMs = 0;
      else this.silenceMs += dur;
      if (this.silenceMs >= this.opts.endSilenceMs) this.reset();
      return events;
    }

    if (this.state === 'idle') {
      const startThreshold = Math.max(this.opts.minStartThreshold, this.noiseFloor * 4);
      if (rms < startThreshold) {
        this.noiseFloor = clamp(this.noiseFloor * 0.97 + rms * 0.03, 0.002, 0.05);
      }
      this.preroll.push(chunk);
      this.prerollMs += dur;
      while (this.prerollMs - this.chunkMs(this.preroll[0]) >= this.opts.prerollMs) {
        const dropped = this.preroll.shift();
        this.prerollMs -= this.chunkMs(dropped);
      }
      if (rms > startThreshold) this.aboveMs += dur;
      else this.aboveMs = Math.max(0, this.aboveMs - dur);

      if (this.aboveMs >= this.opts.startMs) {
        this.state = 'speech';
        this.frames = this.preroll;
        this.totalMs = this.prerollMs;
        this.voicedMs = 0;
        this.silenceMs = 0;
        this.preroll = [];
        this.prerollMs = 0;
        this.aboveMs = 0;
        events.push({ type: 'start' });
      }
      return events;
    }

    this.frames.push(chunk);
    this.totalMs += dur;
    const continueThreshold = Math.max(this.opts.minContinueThreshold, this.noiseFloor * 2.2);
    if (rms >= continueThreshold) {
      this.voicedMs += dur;
      this.silenceMs = 0;
    } else {
      this.silenceMs += dur;
    }

    if (this.totalMs >= this.opts.maxUtteranceMs && this.silenceMs < this.opts.endSilenceMs) {
      this.reset();
      this.state = 'lockout';
      events.push({ type: 'discard' });
      return events;
    }

    if (this.silenceMs >= this.opts.endSilenceMs) {
      const voiced = this.voicedMs;
      const total = this.totalMs;
      const frames = this.frames;
      this.reset();
      if (voiced < this.opts.minVoicedMs) {
        events.push({ type: 'discard' });
      } else {
        events.push({
          type: 'utterance',
          samples: concat(frames),
          sampleRate: this.lastSampleRate,
          durationMs: total,
          voicedMs: voiced,
        });
      }
    }
    return events;
  }

  private chunkMs(chunk: Float32Array | undefined): number {
    return chunk === undefined ? 0 : (chunk.length / this.lastSampleRate) * 1000;
  }
}

function concat(frames: readonly Float32Array[]): Float32Array {
  let length = 0;
  for (const f of frames) length += f.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}
