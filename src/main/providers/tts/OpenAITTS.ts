import { rootLogger } from '@main/logging/logger';
import { voiceForClassicModel } from '@shared/openaiVoice';
import { CREDIT_PATTERN } from '@main/providers/ai/failure';

const log = rootLogger.child('tts.openai');

/** OpenAI's "pcm" format is raw 24 kHz, 16-bit, mono: the same as Gemini's speech, so the same player plays it. */
export const OPENAI_TTS_SAMPLE_RATE = 24_000;

/** Best first. The newer model can be told how to sound; the older one is the one every account has. */
const DEFAULT_MODELS = ['gpt-4o-mini-tts', 'tts-1'] as const;
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const MAX_TEXT_CHARS = 1200;
/** How long an account with no credit is left alone before the voice is tried again. */
const NO_CREDIT_REST_MS = 3 * 60_000;
const TONE =
  'Speak like a warm, quick, friendly person helping someone they like: natural, relaxed pace, a little smile in the voice, with real-sounding pauses; a small "okay", "hmm" or "alright" should sound easy and human. Never robotic, never an announcer. Short sentences get a short, light delivery.';

export class OpenAITTSError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    /** Asking again (or another model) could work. */
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'OpenAITTSError';
  }
}

export interface OpenAITTSConfig {
  readonly models: readonly string[];
  readonly baseUrl: string;
  /** A model that has sent nothing by now is given up on for the next. */
  readonly firstChunkTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly fetchFn: typeof fetch;
}

export interface OpenAITTSDeps {
  /** The OpenAI key, read when needed (it can be added or changed while Eya runs). Null when there is none. */
  readonly getKey: () => string | null;
  readonly config?: Partial<OpenAITTSConfig>;
}

function clipText(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_TEXT_CHARS) return t;
  const cut = t.slice(0, MAX_TEXT_CHARS);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return lastStop > MAX_TEXT_CHARS / 2 ? cut.slice(0, lastStop + 1) : cut;
}

/** Joins a stream's pieces so that every piece handed on has a whole number of 16-bit samples (a sample can arrive split across two). */
export class SampleAligner {
  private spare: number | null = null;

  push(bytes: Uint8Array): Uint8Array | null {
    let data = bytes;
    if (this.spare !== null) {
      const joined = new Uint8Array(data.length + 1);
      joined[0] = this.spare;
      joined.set(data, 1);
      data = joined;
      this.spare = null;
    }
    if (data.length % 2 === 1) {
      this.spare = data[data.length - 1] ?? 0;
      data = data.subarray(0, data.length - 1);
    }
    return data.length > 0 ? data : null;
  }
}

/**
 * Streams speech from OpenAI's text-to-speech models. Audio is handed on as it arrives, so playback starts after the first piece even
 * for a long reply. Each call walks the models: one the account may not use (or that stalls) is skipped and left alone for a while.
 */
export class OpenAITTS {
  private readonly cfg: OpenAITTSConfig;
  private readonly skipUntil = new Map<string, number>();
  private noCreditUntil = 0;

  constructor(private readonly deps: OpenAITTSDeps) {
    this.cfg = {
      models: DEFAULT_MODELS,
      baseUrl: DEFAULT_BASE_URL,
      firstChunkTimeoutMs: 6000,
      totalTimeoutMs: 45_000,
      fetchFn: (url, init) => fetch(url, init),
      ...deps.config,
    };
  }

  hasKey(): boolean {
    const key = this.deps.getKey();
    return key !== null && key !== '';
  }

  async stream(text: string, voice: string, onChunk: (pcm: Uint8Array) => void, signal: AbortSignal): Promise<{ model: string; ms: number; bytes: number }> {
    const key = this.deps.getKey();
    if (key === null || key === '') throw new OpenAITTSError('OpenAI key missing', 0, false);
    const spoken = clipText(text);
    if (spoken.length === 0) return { model: '', ms: 0, bytes: 0 };

    const now = Date.now();
    // An account with no credit cannot speak with any model: say so at once instead of asking each one (the voice falls back to the
    // on-device one without a two-second wait for every sentence). Looked at again every few minutes, in case credit was added.
    if (this.noCreditUntil > now) throw new OpenAITTSError('openai tts http 429: no credits remaining', 429, false);
    const ready = this.cfg.models.filter((m) => (this.skipUntil.get(m) ?? 0) <= now);
    const order = ready.length > 0 ? ready : this.cfg.models;

    let lastError: unknown;
    for (const model of order) {
      if (signal.aborted) throw new OpenAITTSError('cancelled', 0, false);
      const started = Date.now();
      let bytes = 0;
      try {
        await this.streamModel(key, model, spoken, voice, (pcm) => {
          bytes += pcm.length;
          onChunk(pcm);
        }, signal);
        return { model, ms: Date.now() - started, bytes };
      } catch (err) {
        lastError = err;
        if (signal.aborted) throw err;
        const status = err instanceof OpenAITTSError ? err.status : 0;
        // A refused key is the same for every model: do not try the next one.
        if (status === 401) throw err;
        if (status === 429 && CREDIT_PATTERN.test(err instanceof Error ? err.message : '')) {
          this.noCreditUntil = Date.now() + NO_CREDIT_REST_MS;
          log.warn('openai voice: no credit left on this account', { ms: Date.now() - started });
          throw err;
        }
        const coolMs = status === 404 || status === 403 ? 30 * 60_000 : status === 429 ? 60_000 : 15_000;
        this.skipUntil.set(model, Date.now() + coolMs);
        log.warn('tts model failed', { model, status, ms: Date.now() - started, heardAudio: bytes > 0, err: err instanceof Error ? err.message.slice(0, 140) : String(err) });
        // Half a sentence has been played: another voice for the rest would be worse than stopping.
        if (bytes > 0) throw err;
      }
    }
    throw lastError ?? new OpenAITTSError('no OpenAI speech model available');
  }

  private async streamModel(key: string, model: string, text: string, voice: string, onChunk: (pcm: Uint8Array) => void, outer: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort();
    outer.addEventListener('abort', onOuterAbort, { once: true });
    let stalled = false;
    let heard = false;
    const firstChunkTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, this.cfg.firstChunkTimeoutMs);
    const totalTimer = setTimeout(() => controller.abort(), this.cfg.totalTimeoutMs);

    try {
      const classic = model.startsWith('tts-1');
      const res = await this.cfg.fetchFn(`${this.cfg.baseUrl.replace(/\/+$/, '')}/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          input: text,
          voice: classic ? voiceForClassicModel(voice) : voice,
          response_format: 'pcm',
          // Only the newer model can be told how to sound.
          ...(classic ? {} : { instructions: TONE }),
        }),
        signal: controller.signal,
      });
      if (!res.ok || res.body === null) {
        const detail = await res.text().catch(() => '');
        throw new OpenAITTSError(`openai tts http ${res.status}: ${detail.replace(/\s+/g, ' ').slice(0, 200)}`, res.status, res.status !== 401);
      }
      const reader = res.body.getReader();
      const aligner = new SampleAligner();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const whole = aligner.push(value);
        if (whole === null) continue;
        if (!heard) {
          heard = true;
          clearTimeout(firstChunkTimer);
        }
        onChunk(whole);
      }
      if (!heard) throw new OpenAITTSError('openai tts returned no audio');
    } catch (err) {
      if (stalled && !heard) throw new OpenAITTSError('openai tts first audio timed out');
      if (outer.aborted) throw new OpenAITTSError('cancelled', 0, false);
      throw err;
    } finally {
      clearTimeout(firstChunkTimer);
      clearTimeout(totalTimer);
      outer.removeEventListener('abort', onOuterAbort);
    }
  }
}
