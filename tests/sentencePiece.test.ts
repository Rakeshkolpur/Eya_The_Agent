import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SentencePiece } from '../src/main/wake/sentencePiece';

// The real model file the wake word is built from. If it's missing (a fresh
// checkout before the model has been downloaded) these tests are skipped
// rather than failing the whole suite.
const MODEL_DIR = join(
  __dirname,
  '..',
  'models',
  'kws',
  'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01',
);
const bpePath = join(MODEL_DIR, 'bpe.model');
const hasModel = (() => {
  try {
    readFileSync(bpePath);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasModel)('SentencePiece (against the real wake-word model)', () => {
  const bpe = SentencePiece.parse(readFileSync(bpePath));

  it('reproduces the tokenization the model ships its own example keywords with', () => {
    const raw = readFileSync(join(MODEL_DIR, 'keywords_raw.txt'), 'utf8').trim().split(/\r?\n/);
    const want = readFileSync(join(MODEL_DIR, 'keywords.txt'), 'utf8').trim().split(/\r?\n/);
    raw.forEach((phrase, i) => {
      expect(bpe.encode(phrase).join(' '), phrase).toBe(want[i]);
    });
  });

  it('spells "HEY EYA" and the pronunciations Whisper produced for it', () => {
    expect(bpe.encode('HEY EYA').join(' ')).toBe('▁HE Y ▁E Y A');
    expect(bpe.encode('HEY AYA').join(' ')).toBe('▁HE Y ▁A Y A');
    expect(bpe.encode('EYA').join(' ')).toBe('▁E Y A');
  });

  it('every piece it produces exists in the model vocabulary', () => {
    for (const phrase of ['HEY EYA', 'HEY AYA', 'OKAY EYA', 'HI EYA', 'THE QUICK BROWN FOX']) {
      for (const piece of bpe.encode(phrase)) expect(bpe.has(piece), `${phrase} -> ${piece}`).toBe(true);
    }
  });
});

describe('SentencePiece (synthetic model, no real file needed)', () => {
  // A minimal Unigram model file built by hand: TrainerSpec.model_type = 1
  // (field 3, varint), then a few ModelProto.pieces entries (field 1, each a
  // SentencePiece { text: string (field 1), score: float (field 2) }).
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
    const scoreBytes = new Uint8Array(new Float32Array([score]).buffer);
    const field1 = [0x0a, ...encodeVarint(textBytes.length), ...textBytes]; // tag 1<<3|2
    const field2 = [0x15, ...scoreBytes]; // tag 2<<3|5 (fixed32)
    return [...field1, ...field2];
  }
  function modelBytes(pieces: Array<[string, number]>): Uint8Array {
    const bytes: number[] = [];
    for (const [text, score] of pieces) {
      const body = piece(text, score);
      bytes.push(0x0a, ...encodeVarint(body.length), ...body); // ModelProto.pieces, tag 1<<3|2
    }
    // TrainerSpec { model_type: UNIGRAM(1) } nested at field 2 of ModelProto.
    const trainerSpec = [0x18, 1]; // tag 3<<3|0 (varint), value 1
    bytes.push(0x12, ...encodeVarint(trainerSpec.length), ...trainerSpec); // ModelProto.trainer_spec, tag 2<<3|2
    return new Uint8Array(bytes);
  }

  it('segments a word into the pieces with the best total score', () => {
    const bpe = SentencePiece.parse(
      modelBytes([
        ['\u2581HE', -1],
        ['Y', -1],
        ['\u2581HEY', -0.5], // one piece beats two, if it exists
        ['\u2581E', -1],
        ['A', -1],
      ]),
    );
    expect(bpe.encode('HEY').join(' ')).toBe('▁HEY');
    expect(bpe.encode('HE').join(' ')).toBe('▁HE');
  });

  it('throws a clear error when a word cannot be spelled at all', () => {
    const bpe = SentencePiece.parse(modelBytes([['\u2581A', -1]]));
    expect(() => bpe.encode('ZZZ')).toThrow(/cannot spell/);
  });

  it('treats each word separately, joined by spaces in the output', () => {
    const bpe = SentencePiece.parse(
      modelBytes([
        ['\u2581GO', -1],
        ['\u2581HOME', -1],
      ]),
    );
    expect(bpe.encode('GO HOME').join(' ')).toBe('▁GO ▁HOME');
  });
});
