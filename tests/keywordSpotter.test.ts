import { describe, it, expect } from 'vitest';
import { buildKeywordsFile, WakeWordDetector, WAKE_SAMPLE_RATE } from '../src/main/wake/keywordSpotter';
import type { KeywordSpotterBinding } from '../src/main/wake/keywordSpotter';
import { SentencePiece } from '../src/main/wake/sentencePiece';

// A hand-rolled Unigram model with just enough pieces to spell "HEY EYA" and
// "HEY AYA" (mirrors the real model's own pieces for these letters).
function encodeVarint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}
function piece(text: string, score: number): number[] {
  const textBytes = Array.from(new TextEncoder().encode(text));
  const scoreBytes = Array.from(new Uint8Array(new Float32Array([score]).buffer));
  return [0x0a, ...encodeVarint(textBytes.length), ...textBytes, 0x15, ...scoreBytes];
}
function fakeModelBytes(): Uint8Array {
  const pieces: Array<[string, number]> = [
    ['▁HE', -1], ['Y', -1], ['▁A', -1], ['▁E', -1], ['A', -1],
  ];
  const bytes: number[] = [];
  for (const [text, score] of pieces) {
    const body = piece(text, score);
    bytes.push(0x0a, ...encodeVarint(body.length), ...body);
  }
  bytes.push(0x12, 2, 0x18, 1); // trainer_spec { model_type: UNIGRAM }
  return new Uint8Array(bytes);
}

describe('buildKeywordsFile', () => {
  it('writes one BPE-tokenized, boosted, thresholded line per phrase', () => {
    const bpe = SentencePiece.parse(fakeModelBytes());
    const text = buildKeywordsFile(bpe, [
      { phrase: 'HEY EYA', boost: 1.5, threshold: 0.15 },
      { phrase: 'HEY AYA', boost: 2, threshold: 0.1 },
    ]);
    expect(text).toBe('▁HE Y ▁E Y A :1.5 #0.15 @HEY_EYA\n▁HE Y ▁A Y A :2 #0.1 @HEY_AYA\n');
  });
});

function loudChunk(n = 100): Float32Array {
  return new Float32Array(n).fill(1);
}
function quietChunk(n = 100): Float32Array {
  return new Float32Array(n).fill(0.001);
}

describe('WakeWordDetector', () => {
  const model = { encoder: 'e', decoder: 'd', joiner: 'j', tokens: 't', bpeModel: 'bpe' };
  const readBpeModel = () => fakeModelBytes();
  // The fake model file above only has pieces for HEY/AYA/EYA; restrict to what it can spell.
  const entries = [{ phrase: 'HEY EYA', boost: 1.5, threshold: 0.15 }];

  it('reports nothing for ordinary audio', () => {
    class NeverReady {
      constructor(_config: unknown) {
        void _config;
      }
      createStream() {
        return { acceptWaveform: () => undefined };
      }
      isReady(): boolean {
        return false;
      }
      decode(): void {}
      reset(): void {}
      getResult(): { keyword: string } {
        return { keyword: '' };
      }
    }
    const binding = { KeywordSpotter: NeverReady } as unknown as KeywordSpotterBinding;
    const det = new WakeWordDetector({ binding, readBpeModel, model, entries });
    expect(det.push(quietChunk())).toBeNull();
  });

  it('reports the phrase once the model has accumulated enough signal to recognize it', () => {
    // A stream that "recognizes" the phrase once enough loud audio has passed
    // through it, exercising the real push()/isReady/decode/getResult/reset loop.
    class LoudDetectingSpotter {
      private energy = 0;
      constructor(_config: unknown) {
        void _config;
      }
      createStream() {
        const self = this;
        return {
          acceptWaveform: ({ samples }: { samples: Float32Array }) => {
            let sum = 0;
            for (const s of samples) sum += Math.abs(s);
            self.energy += sum;
          },
        };
      }
      isReady(): boolean {
        return this.energy > 10;
      }
      decode(): void {
        /* nothing to do */
      }
      reset(): void {
        this.energy = 0;
      }
      getResult(): { keyword: string } {
        return { keyword: 'HEY_EYA' };
      }
    }
    const binding = { KeywordSpotter: LoudDetectingSpotter } as unknown as KeywordSpotterBinding;
    const det = new WakeWordDetector({ binding, readBpeModel, model, entries });
    expect(det.push(quietChunk(50))).toBeNull();
    expect(det.push(loudChunk(50))).toBe('HEY_EYA');
  });

  it('ignores a second detection inside the cooldown window, so one utterance cannot fire twice', () => {
    class AlwaysReady {
      // Each push() delivers one chunk ("armed"); decoding it once and resetting
      // (as WakeWordDetector does after every detection) must make isReady() go
      // false again until the next chunk arrives, or the decode loop never ends.
      private armed = false;
      constructor(_config: unknown) {
        void _config;
      }
      createStream() {
        return { acceptWaveform: () => { this.armed = true; } };
      }
      isReady(): boolean {
        return this.armed;
      }
      decode(): void {
        /* the fake has nothing to compute; getResult() below decides */
      }
      reset(): void {
        this.armed = false;
      }
      getResult(): { keyword: string } {
        return { keyword: 'HEY_EYA' };
      }
    }
    const binding = { KeywordSpotter: AlwaysReady } as unknown as KeywordSpotterBinding;
    const clock = { t: 0 };
    const det = new WakeWordDetector({ binding, readBpeModel, model, entries, cooldownMs: 2000, now: () => clock.t });
    expect(det.push(loudChunk(1))).toBe('HEY_EYA');
    clock.t += 500;
    expect(det.push(loudChunk(1))).toBeNull(); // too soon
    clock.t += 1600;
    expect(det.push(loudChunk(1))).toBe('HEY_EYA'); // past the cooldown
  });

  it('passes the sample rate and phrase config through to the native model', () => {
    const seen: unknown[] = [];
    class RecordingSpotter {
      constructor(config: unknown) {
        seen.push(config);
      }
      createStream() {
        return { acceptWaveform: () => undefined };
      }
      isReady(): boolean {
        return false;
      }
      decode(): void {}
      reset(): void {}
      getResult(): { keyword: string } {
        return { keyword: '' };
      }
    }
    const binding = { KeywordSpotter: RecordingSpotter } as unknown as KeywordSpotterBinding;
    new WakeWordDetector({
      binding,
      readBpeModel,
      model,
      entries: [{ phrase: 'HEY EYA', boost: 1, threshold: 0.2 }],
    });
    const cfg = seen[0] as { featConfig: { sampleRate: number }; modelConfig: { transducer: { encoder: string } } };
    expect(cfg.featConfig.sampleRate).toBe(WAKE_SAMPLE_RATE);
    expect(cfg.modelConfig.transducer.encoder).toBe('e');
  });
});

void vi;
