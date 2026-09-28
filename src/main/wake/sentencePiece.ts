/**
 * A small SentencePiece encoder (Unigram or BPE, whichever the model file says),
 * just enough to turn a wake phrase such as "HEY EYA" into the model's own word
 * pieces, so a keyword can be added without any training. It reads the model's
 * `bpe.model` file. (Despite the file name, the keyword model shipped by
 * sherpa-onnx is a Unigram model, which is why both are handled.)
 */

const SPACE = '▁'; // "▁", SentencePiece's word-start marker

interface Piece {
  readonly text: string;
  readonly score: number;
  readonly type: number;
}

/** Piece types in sentencepiece_model.proto. */
const TYPE_NORMAL = 1;
const TYPE_USER_DEFINED = 4;

/** TrainerSpec.model_type in sentencepiece_model.proto. */
export type PieceModelType = 'unigram' | 'bpe';

class Reader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.bytes.length;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.bytes[this.pos];
      if (byte === undefined) throw new Error('unexpected end of model file');
      this.pos += 1;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) throw new Error('bad varint in model file');
    }
  }

  take(length: number): Uint8Array {
    if (this.pos + length > this.bytes.length) throw new Error('unexpected end of model file');
    const out = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.varint();
        return;
      case 1:
        this.take(8);
        return;
      case 2:
        this.take(this.varint());
        return;
      case 5:
        this.take(4);
        return;
      default:
        throw new Error(`unsupported field in model file (wire type ${wireType})`);
    }
  }
}

function parsePiece(bytes: Uint8Array): Piece {
  const reader = new Reader(bytes);
  let text = '';
  let score = 0;
  let type = TYPE_NORMAL;
  while (!reader.done) {
    const tag = reader.varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 1 && wire === 2) {
      text = new TextDecoder().decode(reader.take(reader.varint()));
    } else if (field === 2 && wire === 5) {
      const raw = reader.take(4);
      score = new DataView(raw.buffer, raw.byteOffset, 4).getFloat32(0, true);
    } else if (field === 3 && wire === 0) {
      type = reader.varint();
    } else {
      reader.skip(wire);
    }
  }
  return { text, score, type };
}

/** Reads TrainerSpec.model_type (field 3: 1 = unigram, 2 = bpe). */
function parseModelType(bytes: Uint8Array): PieceModelType | undefined {
  const reader = new Reader(bytes);
  while (!reader.done) {
    const tag = reader.varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 3 && wire === 0) {
      const value = reader.varint();
      if (value === 1) return 'unigram';
      if (value === 2) return 'bpe';
      return undefined;
    }
    reader.skip(wire);
  }
  return undefined;
}

export class SentencePiece {
  private readonly scores = new Map<string, number>();
  private maxPieceLength = 1;

  constructor(
    pieces: readonly Piece[],
    private readonly modelType: PieceModelType = 'unigram',
  ) {
    for (const piece of pieces) {
      if (piece.type === TYPE_NORMAL || piece.type === TYPE_USER_DEFINED) {
        this.scores.set(piece.text, piece.score);
        this.maxPieceLength = Math.max(this.maxPieceLength, Array.from(piece.text).length);
      }
    }
  }

  /** Reads the pieces out of a SentencePiece `.model` file. */
  static parse(bytes: Uint8Array): SentencePiece {
    const reader = new Reader(bytes);
    const pieces: Piece[] = [];
    let modelType: PieceModelType = 'unigram'; // the format's default
    while (!reader.done) {
      const tag = reader.varint();
      const field = Math.floor(tag / 8);
      const wire = tag % 8;
      if (field === 1 && wire === 2) {
        pieces.push(parsePiece(reader.take(reader.varint())));
      } else if (field === 2 && wire === 2) {
        modelType = parseModelType(reader.take(reader.varint())) ?? modelType;
      } else {
        reader.skip(wire);
      }
    }
    if (pieces.length === 0) throw new Error('no vocabulary found in model file');
    return new SentencePiece(pieces, modelType);
  }

  has(piece: string): boolean {
    return this.scores.has(piece);
  }

  /** Splits text into pieces the way the model was trained: each word gets a leading "▁", then the best-scoring merges are applied. */
  encode(text: string): string[] {
    const out: string[] = [];
    for (const word of text.trim().split(/\s+/)) {
      if (word.length === 0) continue;
      out.push(...this.encodeWord(SPACE + word));
    }
    return out;
  }

  private encodeWord(word: string): string[] {
    return this.modelType === 'bpe' ? this.encodeBpe(word) : this.encodeUnigram(word);
  }

  /** Unigram: the segmentation whose pieces have the best total score (Viterbi). */
  private encodeUnigram(word: string): string[] {
    const chars = Array.from(word);
    const n = chars.length;
    const best: number[] = new Array<number>(n + 1).fill(Number.NEGATIVE_INFINITY);
    const from: number[] = new Array<number>(n + 1).fill(-1);
    best[0] = 0;
    for (let end = 1; end <= n; end += 1) {
      for (let start = Math.max(0, end - this.maxPieceLength); start < end; start += 1) {
        const before = best[start];
        const score = this.scores.get(chars.slice(start, end).join(''));
        if (before === undefined || before === Number.NEGATIVE_INFINITY || score === undefined) continue;
        if (before + score > (best[end] ?? Number.NEGATIVE_INFINITY)) {
          best[end] = before + score;
          from[end] = start;
        }
      }
    }
    if ((best[n] ?? Number.NEGATIVE_INFINITY) === Number.NEGATIVE_INFINITY) {
      throw new Error(`cannot spell "${word}" with this model's pieces`);
    }
    const pieces: string[] = [];
    for (let end = n; end > 0; end = from[end] ?? 0) pieces.unshift(chars.slice(from[end] ?? 0, end).join(''));
    return pieces;
  }

  /** BPE: repeatedly merge the adjacent pair whose merged piece scores best. */
  private encodeBpe(word: string): string[] {
    let symbols = Array.from(word);
    for (;;) {
      let bestIndex = -1;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (let i = 0; i + 1 < symbols.length; i += 1) {
        const merged = `${symbols[i] ?? ''}${symbols[i + 1] ?? ''}`;
        const score = this.scores.get(merged);
        if (score !== undefined && score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }
      if (bestIndex < 0) return symbols;
      symbols = [
        ...symbols.slice(0, bestIndex),
        `${symbols[bestIndex] ?? ''}${symbols[bestIndex + 1] ?? ''}`,
        ...symbols.slice(bestIndex + 2),
      ];
    }
  }
}
