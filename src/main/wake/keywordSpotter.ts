import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SentencePiece } from './sentencePiece';

/**
 * A tiny always-on-device wake word: "hey Eya" is recognized as sound, not
 * text, by a 3.3M-parameter keyword-spotting model (sherpa-onnx, Apache 2.0).
 * It runs continuously on the raw microphone stream while nobody is talking to
 * Eya, so a conversation can open the moment she is called instead of waiting
 * for a whole utterance to be transcribed.
 *
 * Several ways of saying the name are listed as separate keywords, each with
 * its own sensitivity, because Whisper's own spelling attempts ("Aya", "I-A",
 * "ee-ya"...) are exactly how differently people say it. Tuned and measured
 * against 60 recordings of the phrase (two synthetic voices x three speeds)
 * and 182 short sentences + 62 minutes of unrelated narration as negatives:
 * ~82% caught, 3 false alarms in the short negatives, 0 in the hour of
 * narration. See tests/keywordSpotter.test.ts and the project memory for the
 * numbers behind these constants.
 */
export const WAKE_PHRASES: readonly { phrase: string; boost: number; threshold: number }[] = [
  { phrase: 'HEY EYA', boost: 1.5, threshold: 0.15 },
  { phrase: 'HEY AYA', boost: 1.5, threshold: 0.15 },
  { phrase: 'HEY EYE UH', boost: 1.5, threshold: 0.15 },
  { phrase: 'HEY EE YA', boost: 1.5, threshold: 0.15 },
  { phrase: 'HEY IYA', boost: 1.5, threshold: 0.15 },
  { phrase: 'HEY AY YA', boost: 1.5, threshold: 0.15 },
  { phrase: 'OKAY EYA', boost: 1.5, threshold: 0.15 },
  { phrase: 'HI EYA', boost: 1.5, threshold: 0.15 },
];

export const WAKE_SAMPLE_RATE = 16_000;

/** Builds the keywords-file text the model expects: one BPE-tokenized phrase per line. */
export function buildKeywordsFile(
  bpe: SentencePiece,
  entries: readonly { phrase: string; boost: number; threshold: number }[] = WAKE_PHRASES,
): string {
  return (
    entries
      .map(({ phrase, boost, threshold }) => `${bpe.encode(phrase).join(' ')} :${boost} #${threshold} @${phrase.replace(/\s+/g, '_')}`)
      .join('\n') + '\n'
  );
}

interface KwsStream {
  acceptWaveform(chunk: { sampleRate: number; samples: Float32Array }): void;
}

interface KwsHandle {
  createStream(): KwsStream;
  isReady(stream: KwsStream): boolean;
  decode(stream: KwsStream): void;
  reset(stream: KwsStream): void;
  getResult(stream: KwsStream): { keyword: string };
}

/** The slice of the sherpa-onnx-node module this needs, so tests can supply a fake. */
export interface KeywordSpotterBinding {
  KeywordSpotter: new (config: unknown) => KwsHandle;
}

export interface KeywordSpotterModelPaths {
  readonly encoder: string;
  readonly decoder: string;
  readonly joiner: string;
  readonly tokens: string;
  readonly bpeModel: string;
}

export interface KeywordSpotterConfig {
  readonly binding: KeywordSpotterBinding;
  readonly readBpeModel: (path: string) => Uint8Array;
  readonly model: KeywordSpotterModelPaths;
  readonly entries?: readonly { phrase: string; boost: number; threshold: number }[];
  readonly numThreads?: number;
  /** A detection is ignored if it comes within this long of the last one (the model can otherwise fire twice for one utterance). */
  readonly cooldownMs?: number;
  readonly now?: () => number;
}

function writeKeywordsFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'eya-wake-'));
  const path = join(dir, 'keywords.txt');
  writeFileSync(path, contents, 'utf8');
  return path;
}

/**
 * Feed it 16kHz mono audio as it arrives (any chunk size); it returns the
 * phrase that was recognized (its tag, e.g. "HEY_EYA"), at most once per
 * cooldown window, so one utterance can't fire it twice.
 */
export class WakeWordDetector {
  private readonly kws: KwsHandle;
  private readonly stream: KwsStream;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private lastFiredAt = Number.NEGATIVE_INFINITY;

  constructor(config: KeywordSpotterConfig) {
    const bpe = SentencePiece.parse(config.readBpeModel(config.model.bpeModel));
    const keywordsFile = writeKeywordsFile(buildKeywordsFile(bpe, config.entries));
    this.kws = new config.binding.KeywordSpotter({
      featConfig: { sampleRate: WAKE_SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: config.model.encoder, decoder: config.model.decoder, joiner: config.model.joiner },
        tokens: config.model.tokens,
        numThreads: config.numThreads ?? 1,
        provider: 'cpu',
        debug: 0,
      },
      maxActivePaths: 16,
      numTrailingBlanks: 1,
      keywordsFile,
    });
    this.stream = this.kws.createStream();
    this.cooldownMs = config.cooldownMs ?? 2000;
    this.now = config.now ?? Date.now;
  }

  push(samples16k: Float32Array): string | null {
    this.stream.acceptWaveform({ sampleRate: WAKE_SAMPLE_RATE, samples: samples16k });
    let found: string | null = null;
    while (this.kws.isReady(this.stream)) {
      this.kws.decode(this.stream);
      const keyword = this.kws.getResult(this.stream).keyword;
      if (keyword !== '') {
        this.kws.reset(this.stream); // ready to catch the next call right away
        found = keyword;
      }
    }
    if (found === null) return null;
    const now = this.now();
    if (now - this.lastFiredAt < this.cooldownMs) return null;
    this.lastFiredAt = now;
    return found;
  }
}
