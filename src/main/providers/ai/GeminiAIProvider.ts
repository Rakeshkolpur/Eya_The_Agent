import { rootLogger } from '@main/logging/logger';
import type {
  AIChatMessage,
  AICompletion,
  AIProvider,
  AIToolCall,
  AIToolSpec,
} from './AIProvider';

const log = rootLogger.child('ai.gemini');

export interface GeminiConfig {
  readonly apiKey: string;
  /** Models for planning/tool-calling, tried in order. */
  readonly models: readonly string[];
  /** Models for audio transcription, tried in order. */
  readonly transcribeModels: readonly string[];
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /**
   * If the first transcription model hasn't answered by then, the next races
   * it. Only for transcription: it is latency-critical, whereas racing
   * planning calls just burns rate limit when the API is already struggling.
   */
  readonly transcribeHedgeMs: number;
  /** Waits between rounds when every model failed transiently; one per retry. */
  readonly retryDelaysMs: readonly number[];
}

// Measured on this API key (3 runs each, 1.5s "open notepad" clip):
// gemini-3.6-flash ~2.0-2.3s (once 11s), 3.1-flash-lite-preview ~1.7-3.0s,
// 3.7 ~4-6s, 3.5 ~11-14s.
const PLANNING_DEFAULT = ['gemini-3.8-flash'];
const TRANSCRIBE_DEFAULT = ['gemini-3.6-flash'];
// Free-tier limits are counted per model, so more models means more capacity
// when the preferred ones are spent or overloaded. The last two are slower.
const FALLBACK_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.1-flash-lite-preview',
  'gemini-3-flash-preview',
  'gemini-flash-latest',
];

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiContent {
  readonly role: 'user' | 'model';
  readonly parts: readonly GeminiPart[];
}

interface GeminiPart {
  readonly text?: string;
  readonly thoughtSignature?: string;
  readonly functionCall?: {
    readonly name?: string;
    readonly args?: Readonly<Record<string, unknown>>;
  };
  readonly functionResponse?: {
    readonly name: string;
    readonly response: unknown;
  };
}

interface GeminiCandidate {
  readonly content?: {
    readonly role?: string;
    readonly parts?: readonly GeminiPart[];
  };
  readonly finishReason?: string;
  readonly groundingMetadata?: {
    readonly groundingChunks?: readonly {
      readonly web?: { readonly uri?: string; readonly title?: string };
    }[];
  };
}

interface GeminiResponse {
  readonly candidates?: readonly GeminiCandidate[];
  readonly promptFeedback?: unknown;
  readonly error?: { readonly message?: string; readonly code?: number };
}

interface GenerateResult {
  readonly data: GeminiResponse;
  readonly model: string;
  readonly ms: number;
}

export interface SearchSource {
  readonly title: string;
  readonly uri: string;
}

class GeminiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Google's own "try again in N seconds" hint on a rate limit, if given. */
    readonly retryAfterMs?: number,
    /** The free tier's per-day request cap: retrying in a minute won't help. */
    readonly dailyQuota = false,
  ) {
    super(message);
    this.name = 'GeminiHttpError';
  }
}

// A per-day cap resets at midnight Pacific; there's no point asking sooner.
const DAILY_QUOTA_COOLDOWN_MS = 30 * 60_000;

const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1200, 2500];
const MAX_RATE_LIMIT_WAIT_MS = 8000;

/**
 * How long to wait before another round, or null if waiting won't help.
 * `delays` has one entry per retry allowed.
 */
export function retryDelayFor(
  err: unknown,
  attempt: number,
  delays: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
): number | null {
  const delay = delays[attempt];
  if (delay === undefined) return null;
  if (!(err instanceof GeminiHttpError)) {
    // A dropped connection (not our own timeout) is worth another try.
    return err instanceof TypeError ? delay : null;
  }
  if (TRANSIENT_STATUSES.has(err.status)) return delay;
  if (err.status === 429 && err.retryAfterMs !== undefined && err.retryAfterMs <= MAX_RATE_LIMIT_WAIT_MS) {
    return err.retryAfterMs + 200;
  }
  return null;
}

function parseModelList(raw: string | undefined, fallback: readonly string[]): string[] {
  const parsed = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : [...fallback];
}

function unique(list: readonly string[]): string[] {
  return [...new Set(list)];
}

function textOf(response: GeminiResponse): string {
  let out = '';
  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (typeof part.text === 'string') out += part.text;
  }
  return out.trim();
}

/**
 * Google Gemini provider (v1beta generateContent, functionDeclarations for
 * tool calling). Requires EYA_GEMINI_API_KEY.
 *
 * Every call walks a model list: if a model is rate-limited (429), retired
 * (404) or erroring, the next one is tried, and the failed model is skipped
 * for a cool-down period. A model that is merely slow is raced by the next one
 * after a short delay, so one latency spike doesn't stall a command.
 * Env: EYA_GEMINI_MODEL and EYA_GEMINI_TRANSCRIBE_MODEL (comma-separated).
 */
export class GeminiAIProvider implements AIProvider {
  readonly name = 'gemini';
  private readonly cfg: GeminiConfig;
  private cachedAvailability: boolean | null = null;
  private readonly skipUntil = new Map<string, number>();
  /** Models whose free daily quota is spent; never retried until it resets. */
  private readonly dailyLimitUntil = new Map<string, number>();
  /** Why each model last failed, so retries can skip the ones that can't recover soon. */
  private readonly lastFailure = new Map<string, number>();

  constructor(overrides?: Partial<GeminiConfig>) {
    this.cfg = {
      apiKey: process.env['EYA_GEMINI_API_KEY'] ?? '',
      models: unique([
        ...parseModelList(process.env['EYA_GEMINI_MODEL'], PLANNING_DEFAULT),
        ...FALLBACK_MODELS,
      ]),
      transcribeModels: unique([
        ...parseModelList(process.env['EYA_GEMINI_TRANSCRIBE_MODEL'], TRANSCRIBE_DEFAULT),
        ...FALLBACK_MODELS,
      ]),
      baseUrl: DEFAULT_BASE_URL,
      timeoutMs: 30_000,
      transcribeHedgeMs: 3500,
      retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
      ...overrides,
    };
  }

  isReady(): boolean {
    return this.cfg.apiKey.length > 0 && this.cachedAvailability !== false;
  }

  hasKey(): boolean {
    return this.cfg.apiKey.length > 0;
  }

  /**
   * The Gemini Live WebSocket address, or null without a key. The key rides in
   * the address, so treat the value as a secret: never log it.
   */
  liveUrl(): string | null {
    if (this.cfg.apiKey.length === 0) return null;
    return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(this.cfg.apiKey)}`;
  }

  /**
   * Transcribe audio using Gemini's multimodal input. Accepts a base64
   * payload (no data-URL prefix) and its MIME type — Gemini's inline_data
   * parts handle audio/webm, audio/mp3, audio/wav, etc.
   */
  async transcribe(audioBase64: string, mimeType: string): Promise<string> {
    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: mimeType, data: audioBase64 } },
            {
              text:
                'Transcribe the speech exactly as spoken, in one short line, with no quotes and no preface. ' +
                'If there is no clearly intelligible speech (silence, noise, a cough, music), output nothing at all.',
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 256,
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    const { data, model, ms } = await this.generate(this.cfg.transcribeModels, body, this.cfg.transcribeHedgeMs);
    const out = textOf(data);
    log.info('transcribed', { chars: out.length, model, ms });
    return out;
  }

  async complete(
    messages: readonly AIChatMessage[],
    tools: readonly AIToolSpec[],
  ): Promise<AICompletion> {
    const { systemInstruction, contents } = toGeminiMessages(messages);
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1024,
        // Mapping a command to a tool needs no deliberation. Measured:
        // thinking on = ~6.0s per call, off = ~2.7s.
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    if (systemInstruction !== undefined) body['systemInstruction'] = systemInstruction;
    if (tools.length > 0) {
      body['tools'] = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
      body['toolConfig'] = { functionCallingConfig: { mode: 'AUTO' } };
    }

    const { data, model, ms } = await this.generate(this.cfg.models, body);
    const completion = this.parseCandidate(data);
    log.info('completed', { model, ms, tools: completion.toolCalls.length });
    return completion;
  }

  /** Ask a question about a document or image (PDF, text, png/jpg/webp). */
  async analyzeFile(dataBase64: string, mimeType: string, question: string): Promise<string> {
    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ inline_data: { mime_type: mimeType, data: dataBase64 } }, { text: question }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1500,
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    // No hedging: racing would upload a large file twice.
    const { data, model, ms } = await this.generate(this.cfg.models, body);
    log.info('analyzed file', { model, ms, mimeType });
    return textOf(data);
  }

  /** A web-grounded answer using Google Search, with the pages it drew from. */
  async groundedSearch(query: string): Promise<{ text: string; sources: SearchSource[] }> {
    const body = {
      contents: [{ role: 'user', parts: [{ text: query }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1200,
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    const { data, model, ms } = await this.generate(this.cfg.models, body);
    const seen = new Set<string>();
    const sources: SearchSource[] = [];
    for (const chunk of data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) {
      const uri = chunk.web?.uri;
      if (typeof uri !== 'string' || seen.has(uri)) continue;
      seen.add(uri);
      sources.push({ title: chunk.web?.title ?? uri, uri });
      if (sources.length >= 5) break;
    }
    log.info('searched', { model, ms, sources: sources.length });
    return { text: textOf(data), sources };
  }

  /**
   * One or more rounds over the model list. If every model fails for a reason
   * that passes ("high demand", a short rate limit, a dropped connection), wait
   * a moment and go round again instead of giving up on the user's command.
   */
  private async generate(
    models: readonly string[],
    body: unknown,
    hedgeAfterMs?: number,
  ): Promise<GenerateResult> {
    if (this.cfg.apiKey.length === 0) {
      throw new Error('Gemini API key missing (set EYA_GEMINI_API_KEY)');
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.generateRound(models, body, hedgeAfterMs, attempt > 0);
      } catch (err) {
        const wait = retryDelayFor(err, attempt, this.cfg.retryDelaysMs);
        if (wait === null) throw err;
        log.info('all models failed for now; trying again shortly', { attempt: attempt + 1, waitMs: wait });
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  /**
   * Tries models in order. On failure the next model starts immediately; if
   * `hedgeAfterMs` is given, the next model also starts when the current one
   * is merely slow, and the first success wins.
   */
  private generateRound(
    models: readonly string[],
    body: unknown,
    hedgeAfterMs: number | undefined,
    ignoreCooldowns: boolean,
  ): Promise<GenerateResult> {
    const now = Date.now();
    // A spent daily quota is skipped outright, even on a retry round.
    const usable = models.filter((m) => (this.dailyLimitUntil.get(m) ?? 0) <= now);
    if (usable.length === 0) {
      return Promise.reject(
        new GeminiHttpError(429, 'gemini daily quota exhausted (429) for every model', undefined, true),
      );
    }
    let order: string[];
    if (ignoreCooldowns) {
      // A retry is for "high demand" blips. A model that was rate limited or
      // retired won't be back in a couple of seconds, so don't spend the time.
      const blipped = usable.filter((m) => {
        const status = this.lastFailure.get(m);
        return status !== 429 && status !== 404;
      });
      order = blipped.length > 0 ? blipped : usable;
    } else {
      const available = usable.filter((m) => (this.skipUntil.get(m) ?? 0) <= now);
      // If every model is cooling down, try them all rather than fail outright.
      order = available.length > 0 ? available : usable;
    }

    return new Promise<GenerateResult>((resolve, reject) => {
      const attempts = new Map<string, AbortController>();
      let nextIndex = 0;
      let running = 0;
      let settled = false;
      let firstError: unknown;
      let hedgeTimer: ReturnType<typeof setTimeout> | null = null;

      const finish = (winner: string | null): void => {
        settled = true;
        if (hedgeTimer !== null) clearTimeout(hedgeTimer);
        for (const [model, controller] of attempts) if (model !== winner) controller.abort();
      };

      const launch = (): boolean => {
        const model = order[nextIndex];
        if (model === undefined) return false;
        nextIndex += 1;
        running += 1;
        const started = Date.now();
        const controller = new AbortController();
        attempts.set(model, controller);

        this.callModel(model, body, controller.signal).then(
          (data) => {
            if (settled) return;
            this.cachedAvailability = true;
            this.lastFailure.delete(model);
            finish(model);
            resolve({ data, model, ms: Date.now() - started });
          },
          (err: unknown) => {
            running -= 1;
            if (settled) return; // a raced loser we aborted
            // Report the primary model's error, not whichever failed last.
            firstError ??= err;
            const status = err instanceof GeminiHttpError ? err.status : 0;
            this.lastFailure.set(model, status);
            if (err instanceof GeminiHttpError && err.dailyQuota) {
              this.dailyLimitUntil.set(model, Date.now() + DAILY_QUOTA_COOLDOWN_MS);
            }
            const coolMs = status === 404 ? 600_000 : status === 429 ? 60_000 : 15_000;
            this.skipUntil.set(model, Date.now() + coolMs);
            log.warn('model failed, trying next', {
              model,
              status,
              ms: Date.now() - started,
              err: err instanceof Error ? err.message.slice(0, 160) : String(err),
            });
            if (!launch() && running === 0) {
              finish(null);
              this.cachedAvailability = false;
              reject(firstError instanceof Error ? firstError : new Error('No Gemini models available'));
            }
          },
        );
        return true;
      };

      launch();
      if (hedgeAfterMs !== undefined) {
        hedgeTimer = setTimeout(() => {
          if (settled) return;
          log.info('slow model, racing the next', { after: hedgeAfterMs });
          launch();
        }, hedgeAfterMs);
      }
    });
  }

  private async callModel(model: string, body: unknown, signal: AbortSignal): Promise<GeminiResponse> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const url = `${this.cfg.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.cfg.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const hint = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(text)?.[1];
        const daily = res.status === 429 && /PerDay/i.test(text);
        throw new GeminiHttpError(
          res.status,
          daily
            ? `gemini daily quota exhausted (429) for ${model}`
            : `gemini http ${res.status}: ${text.slice(0, 300)}`,
          hint !== undefined ? Math.round(Number(hint) * 1000) : undefined,
          daily,
        );
      }
      const data = (await res.json()) as GeminiResponse;
      if (data.error !== undefined) {
        throw new GeminiHttpError(data.error.code ?? 500, `gemini error: ${data.error.message ?? 'unknown'}`);
      }
      return data;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  }

  private parseCandidate(data: GeminiResponse): AICompletion {
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    let text = '';
    const toolCalls: AIToolCall[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part === undefined) continue;
      if (typeof part.text === 'string') text += part.text;
      if (part.functionCall !== undefined) {
        const name = part.functionCall.name;
        if (typeof name === 'string' && name.length > 0) {
          toolCalls.push({
            id: `gc_${i}_${Date.now()}`,
            name,
            args: part.functionCall.args ?? {},
            ...(typeof part.thoughtSignature === 'string' ? { signature: part.thoughtSignature } : {}),
          });
        }
      }
    }
    return { text: text.trim(), toolCalls };
  }
}

/** Gemini needs a JSON object for a function result. */
function toResponseObject(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { result: parsed };
  } catch {
    return { result: content };
  }
}

export function toGeminiMessages(
  messages: readonly AIChatMessage[],
): { systemInstruction?: { parts: readonly { text: string }[] }; contents: readonly GeminiContent[] } {
  let systemInstruction: { parts: readonly { text: string }[] } | undefined;
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemInstruction = { parts: [{ text: m.content }] };
      continue;
    }

    if (m.role === 'tool') {
      const part: GeminiPart = {
        functionResponse: { name: m.name ?? 'tool', response: toResponseObject(m.content) },
      };
      // All results answering one model turn belong in a single user turn.
      const last = contents[contents.length - 1];
      if (last !== undefined && last.role === 'user' && last.parts.every((p) => p.functionResponse !== undefined)) {
        contents[contents.length - 1] = { role: 'user', parts: [...last.parts, part] };
      } else {
        contents.push({ role: 'user', parts: [part] });
      }
      continue;
    }

    if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (m.content.trim().length > 0) parts.push({ text: m.content });
      for (const call of m.toolCalls ?? []) {
        parts.push({
          functionCall: { name: call.name, args: call.args },
          ...(call.signature !== undefined ? { thoughtSignature: call.signature } : {}),
        });
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }

    contents.push({ role: 'user', parts: [{ text: m.content }] });
  }
  return systemInstruction !== undefined
    ? { systemInstruction, contents }
    : { contents };
}
