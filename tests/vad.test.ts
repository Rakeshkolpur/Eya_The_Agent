import { describe, it, expect } from 'vitest';
import { DEFAULT_DETECTOR_OPTIONS, UtteranceDetector } from '../src/renderer/vad';
import type { DetectorEvent } from '../src/renderer/vad';
import { bytesToBase64, encodeWavPcm16, resample } from '../src/renderer/wav';

const RATE = 16_000;
const CHUNK = 128; // one AudioWorklet render quantum
const CHUNK_MS = (CHUNK / RATE) * 1000;

function tone(amplitude: number): Float32Array {
  const out = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE);
  return out;
}

function feed(det: UtteranceDetector, ms: number, amplitude: number): DetectorEvent[] {
  const events: DetectorEvent[] = [];
  const chunk = tone(amplitude);
  for (let t = 0; t < ms; t += CHUNK_MS) events.push(...det.push(chunk, RATE));
  return events;
}

describe('UtteranceDetector', () => {
  it('stays silent on silence and faint hiss', () => {
    const det = new UtteranceDetector();
    expect(feed(det, 3000, 0)).toHaveLength(0);
    expect(feed(det, 3000, 0.003)).toHaveLength(0);
  });

  it('emits start then one utterance for speech followed by silence', () => {
    const det = new UtteranceDetector();
    const events = [...feed(det, 500, 0), ...feed(det, 1000, 0.2), ...feed(det, 1200, 0)];
    expect(events.map((e) => e.type)).toEqual(['start', 'utterance']);
    const utt = events[1];
    if (utt?.type !== 'utterance') throw new Error('expected utterance');
    expect(utt.voicedMs).toBeGreaterThan(800);
    expect(utt.sampleRate).toBe(RATE);
    // Includes pre-roll, so it is longer than the spoken part alone.
    expect(utt.durationMs).toBeGreaterThan(1000);
  });

  it('keeps pre-roll so the first word is not clipped', () => {
    const det = new UtteranceDetector();
    const events = [...feed(det, 1000, 0), ...feed(det, 600, 0.2), ...feed(det, 1000, 0)];
    const utt = events.find((e) => e.type === 'utterance');
    if (utt?.type !== 'utterance') throw new Error('expected utterance');
    const preroll = utt.durationMs - 600 - DEFAULT_DETECTOR_OPTIONS.endSilenceMs;
    expect(preroll).toBeGreaterThan(250);
    expect(preroll).toBeLessThanOrEqual(500);
  });

  it('discards a short blip as noise', () => {
    const det = new UtteranceDetector();
    const events = [...feed(det, 300, 0), ...feed(det, 130, 0.2), ...feed(det, 1200, 0)];
    expect(events.some((e) => e.type === 'utterance')).toBe(false);
    expect(events.at(-1)?.type).toBe('discard');
  });

  it('ignores audio during the cooldown after reset', () => {
    const det = new UtteranceDetector();
    det.reset(600);
    expect(feed(det, 400, 0.2)).toHaveLength(0);
    // 200ms of cooldown remains, so a full second of speech leaves ~800ms audible.
    const later = [...feed(det, 1000, 0.2), ...feed(det, 1200, 0)];
    expect(later.some((e) => e.type === 'utterance')).toBe(true);
  });

  it('reset drops an in-progress utterance', () => {
    const det = new UtteranceDetector();
    feed(det, 600, 0.2);
    det.reset();
    expect(feed(det, 1500, 0)).toHaveLength(0);
  });

  it('drops a long monologue instead of sending it as a command', () => {
    const det = new UtteranceDetector();
    // Someone talking for 25s: nothing should ever be emitted as an utterance,
    // and the remainder must not be re-detected as fresh speech.
    const events = feed(det, 25_000, 0.2);
    expect(events.some((e) => e.type === 'utterance')).toBe(false);
    expect(events.filter((e) => e.type === 'start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'discard')).toHaveLength(1);
  });

  it('recovers and hears a real command after a dropped monologue', () => {
    const det = new UtteranceDetector();
    feed(det, 12_000, 0.2);
    feed(det, 1000, 0); // the talking stops
    const events = [...feed(det, 1000, 0.2), ...feed(det, 1000, 0)];
    expect(events.map((e) => e.type)).toEqual(['start', 'utterance']);
  });

  it('triggers when a voice rises clearly above a quiet room', () => {
    const det = new UtteranceDetector();
    feed(det, 2000, 0.004);
    const events = [...feed(det, 800, 0.15), ...feed(det, 1200, 0.004)];
    expect(events.map((e) => e.type)).toEqual(['start', 'utterance']);
  });
});

describe('wav encoding', () => {
  it('resamples 48k to 16k at one third the length', () => {
    const input = new Float32Array(4800).fill(0.5);
    const out = resample(input, 48_000, 16_000);
    expect(out.length).toBe(1600);
    expect(out[10]).toBeCloseTo(0.5, 5);
  });

  it('writes a valid mono 16-bit WAV header', () => {
    const wav = encodeWavPcm16(new Float32Array(1600), 16_000);
    const text = (o: number, n: number) => String.fromCharCode(...wav.subarray(o, o + n));
    const view = new DataView(wav.buffer);
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(text(12, 4)).toBe('fmt ');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(3200);
    expect(wav.length).toBe(44 + 3200);
  });

  it('clips out-of-range samples instead of wrapping', () => {
    const wav = encodeWavPcm16(new Float32Array([2, -2]), 16_000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });

  it('base64-encodes large buffers without blowing the call stack', () => {
    const bytes = new Uint8Array(500_000).fill(65);
    const b64 = bytesToBase64(bytes);
    expect(b64.length).toBe(Math.ceil(500_000 / 3) * 4);
    expect(atob(b64.slice(0, 8))).toBe('AAAAAA');
  });
});
