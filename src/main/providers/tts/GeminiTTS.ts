import { rootLogger } from '@main/logging/logger';

const log = rootLogger.child('tts.gemini');

/** Gemini speech models return 24kHz mono 16-bit PCM. */
export const TTS_SAMPLE_RATE = 24_000;

// Measured on this key: the lite model streams first audio in ~1s and is the
// most consistent; the full model and 2.5 preview spike to 10s+ under load.
const DEFAULT_MODELS = [
  'gemini-3.8-flash-lite-tts',
  'gemini-3.8-flash-tts',
  'gemini-2.5-flash-preview-tts',
];
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_TEXT_CHARS = 1200;

export interface GeminiTTSConfig {
  readonly apiKey: string;
  readonly models: readonly string[];
  readonly baseUrl: string;
  /** A model that hasn't produced audio by now is abandoned for the next. */
  readonly firstChunkTimeoutMs: number;
  readonly totalTimeoutMs: number;
}

export class GeminiTTSError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly retryable = true,
    /** The free tier's per-day cap: asking again in a minute won't help. */
    readonly dailyQuota = false,
  ) {
    super(message);
    this.name = 'GeminiTTSError';
  }
}

// A per-day cap resets at midnight Pacific; there's no point asking sooner.
const DAILY_QUOTA_COOLDOWN_MS = 30 * 60_000;

/** Splits an SSE byte stream into event payloads; returns the unfinished tail. */
export function parseSse(buffer: string): { payloads: string[]; rest: string } {
  const parts = buffer.replaceAll('\r\n', '\n').split('\n\n');
  const rest = parts.pop() ?? '';
  const payloads: string[] = [];
  for (const event of parts) {
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data.length > 0) payloads.push(data);
  }
  return { payloads, rest };
}

/** Removes a RIFF/WAVE header so the bytes are plain PCM. */
export function stripWavHeader(bytes: Uint8Array): Uint8Array {
  const isRiff = bytes.length > 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF';
  if (!isRiff) return bytes;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4);
    const size = view.getUint32(0, true);
    if (id === 'data') return bytes.subarray(offset + 8);
    offset += 8 + size + (size % 2);
  }
  return bytes.subarray(44);
}

interface StreamPart {
  readonly inlineData?: { readonly data?: string; readonly mimeType?: string };
}

/** Pulls PCM audio out of one SSE payload. Throws if the payload is an API error. */
export function extractAudio(payload: string): Uint8Array[] {
  let json: {
    error?: { message?: string; code?: number };
    candidates?: { content?: { parts?: StreamPart[] } }[];
  };
  try {
    json = JSON.parse(payload) as typeof json;
  } catch {
    return [];
  }
  if (json.error !== undefined) {
    const status = json.error.code ?? 500;
    throw new GeminiTTSError(`gemini tts error: ${json.error.message ?? 'unknown'}`, status);
  }
  const out: Uint8Array[] = [];
  for (const part of json.candidates?.[0]?.content?.parts ?? []) {
    const data = part.inlineData?.data;
    if (typeof data !== 'string' || data.length === 0) continue;
    let bytes: Uint8Array = Buffer.from(data, 'base64');
    if (/wav/i.test(part.inlineData?.mimeType ?? '')) bytes = stripWavHeader(bytes);
    if (bytes.length > 0) out.push(bytes);
  }
  return out;
}

function clipText(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_TEXT_CHARS) return t;
  const cut = t.slice(0, MAX_TEXT_CHARS);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return lastStop > MAX_TEXT_CHARS / 2 ? cut.slice(0, lastStop + 1) : cut;
}

/**
 * Streams speech from Gemini's TTS models. Audio arrives as it is generated,
 * so playback can start about a second in even for a long reply. Each call
 * walks the model list: a model that errors or stalls is skipped and cooled
 * down so it doesn't add latency to every phrase.
 */
export class GeminiTTS {
  private readonly cfg: GeminiTTSConfig;
  private readonly skipUntil = new Map<string, number>();
  private readonly dailyLimitUntil = new Map<string, number>();

  constructor(overrides?: Partial<GeminiTTSConfig>) {
    const envModels = (process.env['EYA_TTS_MODELS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    this.cfg = {
      apiKey: process.env['EYA_GEMINI_API_KEY'] ?? '',
      models: envModels.length > 0 ? envModels : DEFAULT_MODELS,
      baseUrl: DEFAULT_BASE_URL,
      firstChunkTimeoutMs: 2500,
      totalTimeoutMs: 45_000,
      ...overrides,
    };
  }

  hasKey(): boolean {
    return this.cfg.apiKey.length > 0;
  }

  async stream(
    text: string,
    voice: string,
    onChunk: (pcm: Uint8Array) => void,
    signal: AbortSignal,
  ): Promise<{ model: string; ms: number; bytes: number }> {
    if (!this.hasKey()) throw new GeminiTTSError('Gemini API key missing', 0, false);
    const spoken = clipText(text);
    if (spoken.length === 0) return { model: '', ms: 0, bytes: 0 };

    const now = Date.now();
    const usable = this.cfg.models.filter((m) => (this.dailyLimitUntil.get(m) ?? 0) <= now);
    if (usable.length === 0) {
      throw new GeminiTTSError('gemini tts daily quota exhausted (429) for every model', 429, false, true);
    }
    const ready = usable.filter((m) => (this.skipUntil.get(m) ?? 0) <= now);
    const order = ready.length > 0 ? ready : usable;

    let lastError: unknown;
    for (const model of order) {
      if (signal.aborted) throw new GeminiTTSError('cancelled', 0, false);
      const started = Date.now();
      let bytes = 0;
      try {
        await this.streamModel(model, spoken, voice, (pcm) => {
          bytes += pcm.length;
          onChunk(pcm);
        }, signal);
        return { model, ms: Date.now() - started, bytes };
      } catch (err) {
        lastError = err;
        if (signal.aborted) throw err;
        const status = err instanceof GeminiTTSError ? err.status : 0;
        if (err instanceof GeminiTTSError && err.dailyQuota) {
          this.dailyLimitUntil.set(model, Date.now() + DAILY_QUOTA_COOLDOWN_MS);
        }
        const coolMs = status === 404 ? 600_000 : status === 429 ? 60_000 : 15_000;
        this.skipUntil.set(model, Date.now() + coolMs);
        log.warn('tts model failed', {
          model,
          status,
          ms: Date.now() - started,
          heardAudio: bytes > 0,
          err: err instanceof Error ? err.message.slice(0, 140) : String(err),
        });
        // Half a sentence has already been played; switching voice mid-way
        // would be worse than stopping.
        if (bytes > 0) throw err;
      }
    }
    throw lastError ?? new GeminiTTSError('no tts models available');
  }

  private async streamModel(
    model: string,
    text: string,
    voice: string,
    onChunk: (pcm: Uint8Array) => void,
    outer: AbortSignal,
  ): Promise<void> {
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
      const url = `${this.cfg.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.cfg.apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          },
        }),
        signal: controller.signal,
      });
      if (!res.ok || res.body === null) {
        const detail = await res.text().catch(() => '');
        const daily = res.status === 429 && /PerDay/i.test(detail);
        throw new GeminiTTSError(
          daily
            ? `gemini tts daily quota exhausted (429) for ${model}`
            : `gemini tts http ${res.status}: ${detail.slice(0, 200)}`,
          res.status,
          true,
          daily,
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const parsed = parseSse(pending);
        pending = parsed.rest;
        for (const payload of parsed.payloads) {
          for (const pcm of extractAudio(payload)) {
            if (!heard) {
              heard = true;
              clearTimeout(firstChunkTimer);
            }
            onChunk(pcm);
          }
        }
      }
      if (!heard) throw new GeminiTTSError('gemini tts returned no audio');
    } catch (err) {
      if (stalled && !heard) throw new GeminiTTSError('gemini tts first audio timed out');
      if (outer.aborted) throw new GeminiTTSError('cancelled', 0, false);
      throw err;
    } finally {
      clearTimeout(firstChunkTimer);
      clearTimeout(totalTimer);
      outer.removeEventListener('abort', onOuterAbort);
    }
  }
}
