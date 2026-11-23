import { describe, it, expect } from 'vitest';
import { FrameBatcher, PcmCoalescer, concatBytes, floatToPcm16, pcm16ToFloat32 } from '../src/renderer/pcm';

const bytes = (n: number, fill = 1): Uint8Array => new Uint8Array(n).fill(fill);

describe('pcm16ToFloat32', () => {
  it('converts little-endian 16-bit samples to [-1, 1)', () => {
    const pcm = new Uint8Array([0x00, 0x00, 0x00, 0x40, 0x00, 0x80, 0xff, 0x7f]); // 0, 16384, -32768, 32767
    const out = pcm16ToFloat32(pcm);
    expect([...out]).toEqual([0, 0.5, -1, 32767 / 32768]);
  });

  it('respects a view into a larger buffer', () => {
    const whole = new Uint8Array([9, 9, 0x00, 0x40, 9, 9]);
    expect([...pcm16ToFloat32(whole.subarray(2, 4))]).toEqual([0.5]);
  });

  it('ignores a dangling odd byte', () => {
    expect(pcm16ToFloat32(new Uint8Array([0, 0x40, 7])).length).toBe(1);
  });
});

describe('PcmCoalescer', () => {
  it('holds pieces until the first batch is big enough, then uses the larger batch size', () => {
    const c = new PcmCoalescer(100, 400);
    expect(c.push(bytes(60))).toBeNull();
    expect(c.push(bytes(60))?.length).toBe(120); // first batch: 100 needed
    expect(c.push(bytes(300))).toBeNull(); // later batches need 400
    expect(c.push(bytes(150))?.length).toBe(450);
  });

  it('flush returns whatever is left', () => {
    const c = new PcmCoalescer(100, 400);
    c.push(bytes(40));
    expect(c.flush()?.length).toBe(40);
    expect(c.flush()).toBeNull();
  });

  it('never splits a sample: an odd trailing byte carries into the next batch', () => {
    const c = new PcmCoalescer(10, 10);
    const first = c.push(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
    expect(first?.length).toBe(10);
    const second = c.push(new Uint8Array([12, 13, 14, 15, 16, 17, 18, 19, 20]));
    expect([...(second ?? [])]).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it('preserves every byte in order across many small pieces', () => {
    const c = new PcmCoalescer(50, 80);
    const input: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const piece = new Uint8Array(6).map((_, j) => (i * 6 + j) % 251);
      input.push(...piece);
      const batch = c.push(piece);
      if (batch !== null) out.push(...batch);
    }
    const rest = c.flush();
    if (rest !== null) out.push(...rest);
    expect(out).toEqual(input);
  });
});

describe('floatToPcm16', () => {
  it('round-trips through pcm16ToFloat32 to within one quantization step', () => {
    const input = Float32Array.from([0, 0.5, -0.5, 0.999, -1, 0.123]);
    const back = pcm16ToFloat32(floatToPcm16(input));
    for (let i = 0; i < input.length; i += 1) expect(Math.abs((back[i] ?? 0) - (input[i] ?? 0))).toBeLessThan(1 / 16384);
  });

  it('clips out-of-range samples instead of wrapping around', () => {
    const bytes = floatToPcm16(Float32Array.from([3, -3]));
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(32767);
    expect(view.getInt16(2, true)).toBe(-32768);
  });

  it('writes two little-endian bytes per sample', () => {
    expect([...floatToPcm16(Float32Array.from([0.5]))]).toEqual([0xff, 0x3f]);
  });
});

describe('FrameBatcher', () => {
  const frame = (n: number, v = 0.1): Float32Array => new Float32Array(n).fill(v);

  it('holds tiny mic blocks until about 100ms is gathered', () => {
    const b = new FrameBatcher();
    let batch: Float32Array | null = null;
    let pushes = 0;
    while (batch === null) {
      batch = b.push(frame(128), 16_000);
      pushes += 1;
    }
    expect(pushes).toBe(13); // 13 x 128 = 1664 >= 1600 samples (100ms at 16kHz)
    expect(batch.length).toBe(1664);
  });

  it('scales the block to the sample rate', () => {
    const b = new FrameBatcher();
    let total = 0;
    let out: Float32Array | null = null;
    while (out === null) {
      out = b.push(frame(128), 48_000);
      total += 128;
    }
    expect(out.length).toBe(total);
    expect(total).toBeGreaterThanOrEqual(4800);
    expect(total - 128).toBeLessThan(4800);
  });

  it('keeps every sample in order across batches', () => {
    const b = new FrameBatcher();
    const all: number[] = [];
    const emitted: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const chunk = Float32Array.from({ length: 128 }, (_, j) => (i * 128 + j) / 10_000);
      all.push(...chunk);
      const batch = b.push(chunk, 16_000);
      if (batch !== null) emitted.push(...batch);
    }
    const rest = b.flush();
    if (rest !== null) emitted.push(...rest);
    expect(emitted).toEqual(all);
  });

  it('flush returns the remainder once, and reset discards it', () => {
    const b = new FrameBatcher();
    b.push(frame(50), 16_000);
    expect(b.flush()?.length).toBe(50);
    expect(b.flush()).toBeNull();
    b.push(frame(50), 16_000);
    b.reset();
    expect(b.flush()).toBeNull();
  });
});

describe('concatBytes', () => {
  it('joins in order', () => {
    expect([...concatBytes([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([])])]).toEqual([1, 2, 3]);
  });
});
