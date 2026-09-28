/** 16-bit little-endian PCM bytes -> floats in [-1, 1) for Web Audio. */
export function pcm16ToFloat32(pcm: Uint8Array): Float32Array<ArrayBuffer> {
  const samples = Math.floor(pcm.length / 2);
  const out = new Float32Array(samples);
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  for (let i = 0; i < samples; i += 1) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** Floats in [-1, 1] -> 16-bit little-endian PCM bytes (clipped, not wrapped). */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/**
 * The microphone delivers tiny 128-sample blocks. Streaming each one on its own
 * would be hundreds of messages a second, and resampling each in isolation
 * would drift; gather about 100ms and hand over whole blocks instead.
 */
export class FrameBatcher {
  private parts: Float32Array[] = [];
  private length = 0;

  push(chunk: Float32Array, sampleRate: number, blockMs = 100): Float32Array | null {
    this.parts.push(chunk);
    this.length += chunk.length;
    if (this.length < (sampleRate * blockMs) / 1000) return null;
    return this.take();
  }

  /** Whatever is held, e.g. when the stream stops. */
  flush(): Float32Array | null {
    return this.length === 0 ? null : this.take();
  }

  reset(): void {
    this.parts = [];
    this.length = 0;
  }

  private take(): Float32Array {
    const out = new Float32Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    this.reset();
    return out;
  }
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * The speech stream arrives as many tiny pieces (40-200ms). Scheduling each
 * one separately risks audible gaps, so pieces are gathered until there is a
 * comfortable amount to play. A piece that ends mid-sample carries its odd
 * byte into the next batch instead of corrupting it.
 */
export class PcmCoalescer {
  private parts: Uint8Array[] = [];
  private bytes = 0;
  private first = true;

  constructor(
    private readonly firstBatchBytes: number,
    private readonly batchBytes: number,
  ) {}

  push(chunk: Uint8Array): Uint8Array | null {
    if (chunk.length === 0) return null;
    this.parts.push(chunk);
    this.bytes += chunk.length;
    const needed = this.first ? this.firstBatchBytes : this.batchBytes;
    if (this.bytes < needed) return null;
    return this.take();
  }

  /** Everything still held, e.g. when the stream ends. */
  flush(): Uint8Array | null {
    if (this.bytes < 2) return null;
    return this.take();
  }

  private take(): Uint8Array {
    const all = concatBytes(this.parts);
    const usable = all.length - (all.length % 2);
    const batch = all.subarray(0, usable);
    this.parts = usable < all.length ? [all.subarray(usable)] : [];
    this.bytes = all.length - usable;
    this.first = false;
    return batch;
  }
}
