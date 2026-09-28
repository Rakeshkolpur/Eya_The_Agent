import { describe, it, expect } from 'vitest';
import { WakeWordUplink } from '../src/renderer/wakeWord';

describe('WakeWordUplink', () => {
  it('batches roughly 100ms before sending, resampled to 16kHz', () => {
    const sent: Float32Array[] = [];
    const uplink = new WakeWordUplink((s) => sent.push(s));
    // 48kHz mic blocks of 128 samples; ~100ms needs 48*100=4800 samples.
    for (let i = 0; i < 40; i += 1) uplink.push(new Float32Array(128).fill(0.2), 48_000);
    expect(sent).toHaveLength(1);
    // 100ms at 16kHz is 1600 samples; the batching can overshoot slightly, never undershoot.
    expect(sent[0]?.length).toBeGreaterThanOrEqual(1600);
    expect(sent[0]?.length).toBeLessThan(1700);
  });

  it('sends nothing for less than a full batch', () => {
    const sent: Float32Array[] = [];
    const uplink = new WakeWordUplink((s) => sent.push(s));
    uplink.push(new Float32Array(128).fill(0.2), 48_000);
    expect(sent).toHaveLength(0);
  });

  it('keeps sending batches as audio keeps arriving', () => {
    const sent: Float32Array[] = [];
    const uplink = new WakeWordUplink((s) => sent.push(s));
    for (let i = 0; i < 120; i += 1) uplink.push(new Float32Array(128).fill(0.2), 48_000);
    expect(sent.length).toBeGreaterThanOrEqual(3);
  });

  it('reset() drops whatever was only partly batched, without sending it', () => {
    const sent: Float32Array[] = [];
    const uplink = new WakeWordUplink((s) => sent.push(s));
    // 30 chunks (3840 samples) and 20 more (2560) are each under the ~4800-sample
    // threshold alone, but well over it combined — so this only stays quiet if
    // reset() truly drops the first 30 rather than carrying them into the next batch.
    for (let i = 0; i < 30; i += 1) uplink.push(new Float32Array(128).fill(0.2), 48_000);
    uplink.reset();
    for (let i = 0; i < 20; i += 1) uplink.push(new Float32Array(128).fill(0.2), 48_000);
    expect(sent).toHaveLength(0);
  });
});
