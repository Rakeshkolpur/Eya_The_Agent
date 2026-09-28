import { FrameBatcher } from './pcm';
import { resample } from './wav';

const WAKE_SAMPLE_RATE = 16_000;

/**
 * Gathers raw microphone blocks into ~100ms batches at 16kHz and hands each
 * one to `send`, so the main process can run wake-word detection on them.
 * Mirrors how `LiveConversation` batches audio for the Live API, but there is
 * no session to fail into: `send` is fire-and-forget.
 */
export class WakeWordUplink {
  private readonly batcher = new FrameBatcher();

  constructor(private readonly send: (samples16k: Float32Array) => void) {}

  push(chunk: Float32Array, sampleRate: number): void {
    const block = this.batcher.push(chunk, sampleRate);
    if (block !== null) this.send(resample(block, sampleRate, WAKE_SAMPLE_RATE));
  }

  reset(): void {
    this.batcher.reset();
  }
}
