import { rootLogger } from '@main/logging/logger';
import { recordTokens } from './tokenMeter';
import { StoppedError, sleepUnlessStopped, wasAborted } from '@main/agent/stopping';
import type {
  AIChatMessage,
  AICompletion,
  AIProvider,
  AIToolCall,
  AIToolSpec,
  CompleteOptions,
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
   * A planning step answers in 1.5-9 s even when the service is struggling; one that has not by now is hung (a model was seen taking its
   * whole 30 s and then failing, which on its own used up a third of a task's time).
   */
  readonly planningTimeoutMs: number;
  /**
   * If the first transcription model hasn't answered by then, the next races
   * it. Transcription is latency-critical, so this is early.
   */
  readonly transcribeHedgeMs: number;
  /**
   * Planning calls are raced only when one is genuinely slow (they answer in 1.5-4.6 s when healthy), so that an overloaded model that
   * hangs costs a few seconds instead of its whole 30 s timeout, without doubling the load on an API that is already struggling.
   */
  readonly planningHedgeMs: number;
  /** Waits between rounds when every model failed transiently; one per retry. */
  readonly retryDelaysMs: readonly number[];
  /** With another AI ready to take over: no further model is started once the round has used this long. */
  readonly failFastRoundMs: number;
  /** With another AI ready to take over: a model that has not answered by then is raced by the next one. */
  readonly failFastHedgeMs: number;
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
  readonly usageMetadata?: { readonly promptTokenCount?: number; readonly candidatesTokenCount?: number; readonly totalTokenCount?: number; readonly cachedContentTokenCount?: number };
  readonly error?: { readonly message?: string; readonly code?: number };
}

/**
 * When another AI is ready to take over, each Gemini model gets this long, and Gemini hands the request on once the models tried have used up the round's
 * time. It used to be "the first two models": when those two were the ones that were slow or spent for the day (a model under high demand, a daily quota),
 * the two that were working (answering in about two seconds) were never reached, and every step went on to the free models of other services, which are
 * slow, limited and poor at using tools. A failure that comes back quickly (a quota, a refusal, "high demand") costs about a second and is moved past;
 * only slow ones use up the time.
 */
const FAIL_FAST_TIMEOUT_MS = 10_000;
const FAIL_FAST_HEDGE_MS = 4000;
const FAIL_FAST_MODELS = 4;
/** Whatever the round's time, this many different models are asked before Gemini gives a request up. */
const MIN_MODELS_TRIED = 2;
const FAIL_FAST_ROUND_MS = 8000;

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

// A per-day cap is spent for hours: re-check every half hour at most (in case billing was switched on), sooner only if
// Google itself says it comes back sooner. Measured: its 429 carries the wait, which for this cap ends at midnight UTC.
const DAILY_QUOTA_COOLDOWN_MS = 30 * 60_000;

/** Default for `planningHedgeMs`: past this a planning call is raced by the next model and the first answer wins. */
// 0 = do not race a second model when the first is merely slow: one model answers each request (racing made the answers come from a
// different model, in a different style and sometimes language, from one request to the next). A model that FAILS still hands over to the next.
const PLANNING_HEDGE_MS = 0;
/** How long a model that just failed is left alone: an overloaded model is not back in 15 s, and retrying it on every step cost 2–30 s a time. */
const COOLDOWN_OVERLOADED_MS = 60_000;
const COOLDOWN_TIMED_OUT_MS = 120_000;

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
  /**
   * Each model whose LAST failure was a rate/quota limit (429): whether it is the daily cap, and — for a per-minute limit —
   * when Google said it would work again. Lets the error the user hears describe the real best case across ALL models
   * ("back in 40 seconds") rather than only the first model's failure ("used up for today").
   */
  private readonly limitState = new Map<string, { readonly daily: boolean; readonly retryAt?: number }>();
  /** The model that answered last, so the interface can say which one Eya is talking to. */
  private lastModel: string | undefined;

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
      baseUrl: process.env['EYA_GEMINI_BASE_URL']?.trim() || DEFAULT_BASE_URL,
      timeoutMs: 30_000,
      planningTimeoutMs: 20_000,
      transcribeHedgeMs: 3500,
      planningHedgeMs: PLANNING_HEDGE_MS,
      retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
      failFastRoundMs: FAIL_FAST_ROUND_MS,
      failFastHedgeMs: FAIL_FAST_HEDGE_MS,
      ...overrides,
    };
  }

  isReady(): boolean {
    return this.cfg.apiKey.length > 0 && this.cachedAvailability !== false;
  }

  hasKey(): boolean {
    return this.cfg.apiKey.length > 0;
  }

  currentModel(): string | undefined {
    return this.lastModel ?? this.cfg.models[0];
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
    options?: CompleteOptions,
  ): Promise<AICompletion> {
    const fast = options?.failFast === true;
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

    const { data, model, ms } = await this.generate(
      this.cfg.models,
      body,
      // (in a fail-fast call a model that has not answered in 4 s is raced by the next one: a hung model costs 4 s, not its whole 10)
      fast ? (this.cfg.planningHedgeMs > 0 ? Math.min(this.cfg.failFastHedgeMs, this.cfg.planningHedgeMs) : this.cfg.failFastHedgeMs) : this.cfg.planningHedgeMs,
      fast ? Math.min(FAIL_FAST_TIMEOUT_MS, this.cfg.planningTimeoutMs) : this.cfg.planningTimeoutMs,
      fast,
      options?.signal,
    );
    const completion = this.parseCandidate(data);
    this.lastModel = model;
    log.info('completed', {
      model,
      ms,
      tools: completion.toolCalls.length,
      ...(data.usageMetadata?.totalTokenCount !== undefined ? { tokens: data.usageMetadata.totalTokenCount } : {}),
    });
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
    timeoutMs?: number,
    fast = false,
    signal?: AbortSignal,
  ): Promise<GenerateResult> {
    if (this.cfg.apiKey.length === 0) {
      throw new Error('Gemini API key missing (set EYA_GEMINI_API_KEY)');
    }
    // "fast": another AI will take over if this one fails, so no waiting rounds and only the first couple of models.
    const delays = fast ? [] : this.cfg.retryDelaysMs;
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted === true) throw new StoppedError();
      try {
        return await this.generateRound(models, body, hedgeAfterMs, attempt > 0, timeoutMs, fast ? FAIL_FAST_MODELS : undefined, signal, fast ? this.cfg.failFastRoundMs : undefined);
      } catch (err) {
        // (stopped: not a failure of any model, nothing is rested, nothing is tried again)
        if (wasAborted(signal)) throw new StoppedError();
        const wait = retryDelayFor(err, attempt, delays);
        if (wait === null) throw err;
        log.info('all models failed for now; trying again shortly', { attempt: attempt + 1, waitMs: wait });
        await sleepUnlessStopped(wait, signal);
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
    timeoutMs?: number,
    maxModels?: number,
    signal?: AbortSignal,
    roundBudgetMs?: number,
  ): Promise<GenerateResult> {
    if (signal?.aborted === true) return Promise.reject(new StoppedError());
    const now = Date.now();
    // A spent daily quota is skipped outright, even on a retry round.
    const usable = models.filter((m) => (this.dailyLimitUntil.get(m) ?? 0) <= now);
    if (usable.length === 0) {
      // Every model's day is spent. Say so, and when Google said it comes back; never anything vaguer.
      const spent = this.finalError(models, undefined);
      return Promise.reject(spent instanceof GeminiHttpError ? spent : new GeminiHttpError(429, 'gemini daily quota exhausted (429) for every model', undefined, true));
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
    if (maxModels !== undefined) order = order.slice(0, maxModels);

    const roundStarted = Date.now();
    return new Promise<GenerateResult>((resolve, reject) => {
      const attempts = new Map<string, AbortController>();
      let nextIndex = 0;
      let running = 0;
      let settled = false;
      let firstError: unknown;
      // (the first failure that is NOT a limit on one model: a timeout or "high demand" says what Gemini is doing now; one model's spent day does not)
      let firstOther: unknown;
      let hedgeTimer: ReturnType<typeof setTimeout> | null = null;

      // Stopped by the person: every request still waiting is cancelled and the wait ends at once.
      const onStop = (): void => {
        if (settled) return;
        finish(null);
        reject(new StoppedError());
      };
      const finish = (winner: string | null): void => {
        settled = true;
        signal?.removeEventListener('abort', onStop);
        if (hedgeTimer !== null) clearTimeout(hedgeTimer);
        for (const [model, controller] of attempts) if (model !== winner) controller.abort();
      };
      signal?.addEventListener('abort', onStop, { once: true });

      const launch = (): boolean => {
        const model = order[nextIndex];
        if (model === undefined) return false;
        // (the models tried so far have used up the time this round may take: the next AI is waiting)
        // (but never before a SECOND model has had its turn: one model that hangs for its whole 10 s used to use up the round, so the models that answer in two seconds were never asked, Gemini was rested, and the request went on to services that were out of credit and to the small local AI, which refused)
        if (nextIndex >= MIN_MODELS_TRIED && roundBudgetMs !== undefined && Date.now() - roundStarted >= roundBudgetMs) return false;
        nextIndex += 1;
        running += 1;
        const started = Date.now();
        const controller = new AbortController();
        attempts.set(model, controller);

        this.callModel(model, body, controller.signal, timeoutMs).then(
          (data) => {
            if (settled) return;
            this.cachedAvailability = true;
            this.lastFailure.delete(model);
            this.limitState.delete(model);
            finish(model);
            resolve({ data, model, ms: Date.now() - started });
          },
          (err: unknown) => {
            running -= 1;
            if (settled) return; // a raced loser we aborted
            // Report the primary model's error, not whichever failed last.
            firstError ??= err;
            const status = err instanceof GeminiHttpError ? err.status : 0;
            if (status !== 429) firstOther ??= err;
            this.lastFailure.set(model, status);
            if (status === 429 && err instanceof GeminiHttpError) {
              this.limitState.set(model, {
                daily: err.dailyQuota,
                ...(err.retryAfterMs !== undefined ? { retryAt: Date.now() + err.retryAfterMs } : {}),
              });
            } else {
              this.limitState.delete(model);
            }
            if (err instanceof GeminiHttpError && err.dailyQuota) {
              const sooner = err.retryAfterMs !== undefined ? Math.max(5_000, err.retryAfterMs) : DAILY_QUOTA_COOLDOWN_MS;
              this.dailyLimitUntil.set(model, Date.now() + Math.min(DAILY_QUOTA_COOLDOWN_MS, sooner));
            }
            const coolMs = status === 404 ? 600_000 : status === 429 ? 60_000 : status === 0 ? COOLDOWN_TIMED_OUT_MS : COOLDOWN_OVERLOADED_MS;
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
              reject(this.finalError(models, firstOther ?? firstError));
            }
          },
        );
        return true;
      };

      launch();
      if (hedgeAfterMs !== undefined && hedgeAfterMs > 0) {
        hedgeTimer = setTimeout(() => {
          if (settled) return;
          log.info('slow model, racing the next', { after: hedgeAfterMs });
          launch();
        }, hedgeAfterMs);
      }
    });
  }

  /**
   * The error to give up with. When EVERY model is limited (429) it says what the user needs to hear — the daily cap, or
   * the soonest a per-minute limit clears — instead of whichever model happened to fail first. Anything else is the first
   * model's own error, as before.
   */
  private finalError(models: readonly string[], firstError: unknown): Error {
    const limited = models.flatMap((m) => {
      const state = this.limitState.get(m);
      return state === undefined ? [] : [state];
    });
    if (limited.length === models.length && limited.length > 0) {
      const now = Date.now();
      // The soonest ANY model is back, by Google's own word — never a guess at when a limit resets.
      const waits = limited.flatMap((s) => (s.retryAt !== undefined ? [Math.max(0, s.retryAt - now)] : []));
      const retryAfterMs = waits.length > 0 ? Math.min(...waits) : undefined;
      if (limited.every((s) => s.daily)) {
        return new GeminiHttpError(429, 'gemini daily quota exhausted (429) for every model', retryAfterMs, true);
      }
      const message = firstError instanceof Error ? firstError.message : 'gemini http 429: rate limited';
      return new GeminiHttpError(429, message.startsWith('gemini daily') ? 'gemini http 429: rate limited' : message, retryAfterMs, false);
    }
    return firstError instanceof Error ? firstError : new Error('No Gemini models available');
  }

  private async callModel(model: string, body: unknown, signal: AbortSignal, timeoutMs?: number): Promise<GeminiResponse> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? this.cfg.timeoutMs);
    try {
      const url = `${this.cfg.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.cfg.apiKey,
        },
        body: JSON.stringify(withForeignCallSignatures(model, body)),
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
      // (every answer that came back counts, whatever it was for: the chat, a file, a web search; and the total includes the thinking)
      recordTokens('gemini', { prompt: data.usageMetadata?.promptTokenCount, completion: data.usageMetadata?.candidatesTokenCount, total: data.usageMetadata?.totalTokenCount, cached: data.usageMetadata?.cachedContentTokenCount });
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
    const blocked = toolCalls.length === 0 && text.trim() === '' ? blockReason(data, candidate?.finishReason) : undefined;
    return { text: text.trim(), toolCalls, ...(blocked !== undefined ? { blocked } : {}) };
  }
}

/** Why Gemini's own safety system stopped an answer (a blocked prompt, or an answer cut by a safety filter), or undefined when it did not. */
const SAFETY_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);
export function blockReason(data: { readonly promptFeedback?: unknown }, finishReason: string | undefined): string | undefined {
  const feedback = data.promptFeedback;
  if (typeof feedback === 'object' && feedback !== null) {
    const reason = (feedback as { readonly blockReason?: unknown }).blockReason;
    if (typeof reason === 'string' && reason !== '' && reason !== 'BLOCK_REASON_UNSPECIFIED') return `the prompt was blocked (${reason})`;
  }
  if (finishReason !== undefined && SAFETY_FINISH.has(finishReason)) return `the answer was stopped by a safety filter (${finishReason})`;
  return undefined;
}

/**
 * What Google documents for a function call that did not come from the model being asked: a stand-in signature, which makes it accept the call as it is.
 * (Gemini 3 models answer HTTP 400 "Function call is missing a thought_signature" to any call in the conversation that carries none.)
 */
export const FOREIGN_CALL_SIGNATURE = 'skip_thought_signature_validator';

/**
 * The conversation as `model` wants it. The chain hands a request from one AI to another from step to step, so the function call of an earlier step
 * is often one that another AI made and that has no signature: every Gemini 3 model then refused the next step with a 400, and each such step went
 * on to the slower free models (about 17 seconds a step, and the Gemini answer that would have been better never came). A call the model made itself
 * keeps its own signature; only the first call of a turn that has none gets the stand-in. Older models do not take one, so they get the body as it is.
 */
export function withForeignCallSignatures(model: string, body: unknown): unknown {
  if (!/^gemini-3/i.test(model) || typeof body !== 'object' || body === null) return body;
  const contents = (body as { readonly contents?: unknown }).contents;
  if (!Array.isArray(contents)) return body;
  let changed = false;
  const fixed = (contents as readonly GeminiContent[]).map((content) => {
    if (content.role !== 'model') return content;
    const first = content.parts.findIndex((p) => p.functionCall !== undefined);
    if (first < 0 || content.parts.some((p) => p.functionCall !== undefined && typeof p.thoughtSignature === 'string')) return content;
    changed = true;
    return { ...content, parts: content.parts.map((p, i) => (i === first ? { ...p, thoughtSignature: FOREIGN_CALL_SIGNATURE } : p)) };
  });
  return changed ? { ...(body as Record<string, unknown>), contents: fixed } : body;
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
