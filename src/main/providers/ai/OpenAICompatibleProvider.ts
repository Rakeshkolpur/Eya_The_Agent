import { rootLogger } from '@main/logging/logger';
import type { AIChatMessage, AICompletion, AIProvider, AIToolCall, AIToolSpec } from './AIProvider';
import { CREDIT_PATTERN } from './failure';

const log = rootLogger.child('ai.backup');

export interface OpenAICompatibleConfig {
  /** Short name used in logs and messages ("groq"). */
  readonly label: string;
  /** Where requests go, without the trailing /chat/completions ("https://api.groq.com/openai/v1"). */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /**
   * More models to try, in order, when `model` fails for a reason that is about that model (rate limited upstream, down, retired).
   * Used for OpenRouter's many free models, which are limited and go down one at a time.
   */
  readonly fallbackModels?: readonly string[];
  readonly timeoutMs?: number;
  /** For tests, and so the app can use Electron's own network stack. */
  readonly fetchFn?: typeof fetch;
}

/** An error from the service, carrying what the chain needs to decide how long to leave it alone. */
export class AIHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
    /** The per-day allowance is what ran out: trying again in a minute will not help. */
    readonly dailyQuota = false,
  ) {
    super(message);
    this.name = 'AIHttpError';
  }
}

interface ChatToolCall {
  readonly id?: string;
  readonly function?: { readonly name?: string; readonly arguments?: unknown };
}

interface ChatResponse {
  readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: string | null; readonly tool_calls?: readonly ChatToolCall[] } }>;
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number; readonly total_tokens?: number };
  readonly error?: { readonly message?: string; readonly code?: unknown };
}

const DEFAULT_TIMEOUT_MS = 25_000;
/** How many different models one request may try before giving up: each is a round trip, and the user is waiting. */
const MAX_MODEL_TRIES = 5;
const DAILY_PATTERN = /per[ -]?day|daily|\bRPD\b|\bTPD\b|free-models-per-day/i;

/** How long a model that just failed is left alone, by what went wrong with it. */
function modelRestMs(err: unknown): number {
  if (!(err instanceof AIHttpError)) return 60_000; // a timeout or a dropped connection
  if (err.status === 404 || err.status === 410) return 30 * 60_000; // retired or renamed
  if (err.status === 402) return 30 * 60_000; // needs credit: not free after all
  if (err.status === 403) return 30 * 60_000; // this model is not allowed for this key / this kind of use
  if (err.status === 429) return Math.min(5 * 60_000, Math.max(30_000, err.retryAfterMs ?? 60_000));
  if (err.status === 400) return 2 * 60_000; // it kept writing broken tool calls
  return 60_000;
}

/**
 * A backup AI: any service that speaks the common OpenAI chat format (Groq, Mistral, Cerebras, OpenRouter, OpenAI, a local server).
 * Same shape as the other providers, so the chain can hand a request over mid-conversation.
 *
 * With `fallbackModels` it walks them like Gemini's model list: a model that fails for its own reasons is left alone for a while and the
 * next one answers. A failure that is the same for every model (the key, the day's allowance) stops the walk at once.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name: string;
  private readonly cfg: Required<Omit<OpenAICompatibleConfig, 'fetchFn' | 'fallbackModels'>> & { readonly fetchFn: typeof fetch };
  private models: string[];
  private readonly restUntil = new Map<string, number>();
  /** What each model turned out not to accept (OpenAI's newer models: `max_tokens` is `max_completion_tokens`, and only the default temperature). */
  private readonly quirks = new Map<string, { completionTokens?: boolean; noTemperature?: boolean }>();
  private lastModel: string | undefined;

  constructor(config: OpenAICompatibleConfig) {
    this.name = config.label;
    this.cfg = {
      label: config.label,
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      apiKey: config.apiKey,
      model: config.model,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchFn: config.fetchFn ?? fetch,
    };
    this.models = [...new Set([config.model, ...(config.fallbackModels ?? [])].filter((m) => m !== ''))];
  }

  isReady(): boolean {
    return this.cfg.apiKey.length > 0 && this.models.length > 0;
  }

  get model(): string {
    return this.cfg.model;
  }

  currentModel(): string | undefined {
    return this.lastModel ?? this.cfg.model;
  }

  /** Every model this provider will try, in order. */
  get modelList(): readonly string[] {
    return this.models;
  }

  async complete(messages: readonly AIChatMessage[], tools: readonly AIToolSpec[]): Promise<AICompletion> {
    const base: Record<string, unknown> = {
      messages: toOpenAIMessages(messages),
      temperature: 0.2,
      max_tokens: 1024,
    };
    if (tools.length > 0) {
      base['tools'] = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      base['tool_choice'] = 'auto';
    }
    const now = Date.now();
    const ready = this.models.filter((m) => (this.restUntil.get(m) ?? 0) <= now);
    // If every model is resting, try them anyway: a rest is a guess.
    const order = (ready.length > 0 ? ready : this.models).slice(0, MAX_MODEL_TRIES);
    let firstError: unknown;
    let lastError: unknown;
    let forbidden = 0;
    for (const model of order) {
      try {
        const done = await this.withOneRetry({ ...base, model });
        this.lastModel = model;
        return done;
      } catch (err) {
        firstError ??= err;
        lastError = err;
        const http = err instanceof AIHttpError ? err : null;
        // The same for every model, so no point asking the next one: a refused KEY (401) and a spent day's allowance. A 403 is not
        // always: OpenRouter answers 403 for one model that is "only available on agentic harnesses" while its other models work. So one
        // 403 moves on to the next model, and only a second 403 in a row (or a 403 from the last model there is) is taken to be the key.
        forbidden = http?.status === 403 ? forbidden + 1 : 0;
        const lastModelTried = order.indexOf(model) === order.length - 1;
        if (http !== null && (http.dailyQuota || http.status === 401 || (http.status === 403 && (forbidden >= 2 || lastModelTried)))) throw err;
        this.restUntil.set(model, Date.now() + modelRestMs(err));
        log.warn('model failed', {
          provider: this.cfg.label,
          model,
          err: err instanceof Error ? err.message.slice(0, 160) : String(err),
          next: !lastModelTried,
        });
      }
    }
    // (The first model's 403 is only about that model: if the others failed for other reasons, those are the ones to report.)
    throw firstError instanceof AIHttpError && firstError.status === 403 && lastError !== undefined ? lastError : (firstError ?? new Error(`${this.cfg.label} has no model to ask`));
  }

  /** Smaller models now and then write a malformed tool call, which the service rejects with 400; a second try usually comes out right. */
  private async withOneRetry(body: Record<string, unknown>): Promise<AICompletion> {
    const model = String(body['model']);
    let malformedTries = 0;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.send(this.shaped(body, model));
      } catch (err) {
        const http = err instanceof AIHttpError && err.status === 400 ? err : null;
        // A parameter this model does not take is learned from the service's own answer, once, and used from then on.
        const learned = http !== null && this.learnQuirk(model, http.message);
        if (learned && attempt < 3) {
          log.info('this model takes different parameters, trying again', { provider: this.cfg.label, model });
          continue;
        }
        const malformed = http !== null && /tool_use_failed|failed to call a function|invalid.*tool/i.test(http.message);
        if (!malformed || malformedTries >= 1) throw err;
        malformedTries += 1;
        log.info('malformed tool call, trying once more', { provider: this.cfg.label, model });
      }
    }
  }

  /** The request in the shape this model accepts. */
  private shaped(body: Record<string, unknown>, model: string): Record<string, unknown> {
    const quirk = this.quirks.get(model);
    if (quirk === undefined) return body;
    const out = { ...body };
    if (quirk.completionTokens === true) {
      delete out['max_tokens'];
      // (A model that reasons spends part of this on thinking, so it is more than a spoken answer needs.)
      out['max_completion_tokens'] = 2048;
    }
    if (quirk.noTemperature === true) delete out['temperature'];
    return out;
  }

  /** Reads "Unsupported parameter: 'max_tokens'..." / "'temperature' does not support 0.2..." and remembers it. True when something new was learned. */
  private learnQuirk(model: string, message: string): boolean {
    const quirk = this.quirks.get(model) ?? {};
    let learned = false;
    if (quirk.completionTokens !== true && /max_tokens/i.test(message) && /max_completion_tokens|unsupported|not supported/i.test(message)) {
      quirk.completionTokens = true;
      learned = true;
    }
    if (quirk.noTemperature !== true && /temperature/i.test(message) && /unsupported|not support|only the default|default \(1\)/i.test(message)) {
      quirk.noTemperature = true;
      learned = true;
    }
    if (learned) this.quirks.set(model, quirk);
    return learned;
  }

  private async send(body: Record<string, unknown>): Promise<AICompletion> {
    const started = Date.now();
    const res = await this.cfg.fetchFn(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw httpError(this.cfg.label, res.status, text, res.headers);
    }
    const data = (await res.json()) as ChatResponse;
    if (data.error !== undefined) {
      // OpenRouter reports an upstream failure inside a 200 answer.
      const status = typeof data.error.code === 'number' ? data.error.code : 500;
      const message = data.error.message ?? 'unknown';
      const daily = status === 429 && DAILY_PATTERN.test(message);
      throw new AIHttpError(status, daily ? `${this.cfg.label} daily quota exhausted (429)` : `${this.cfg.label} error: ${message}`, undefined, daily);
    }
    const message = data.choices?.[0]?.message;
    const toolCalls: AIToolCall[] = [];
    (message?.tool_calls ?? []).forEach((call, i) => {
      const name = call.function?.name;
      if (typeof name !== 'string' || name.length === 0) return;
      toolCalls.push({ id: call.id ?? `bk_${i}_${Date.now()}`, name, args: parseArgs(call.function?.arguments) });
    });
    log.info('completed', {
      provider: this.cfg.label,
      model: String(body['model']),
      ms: Date.now() - started,
      tools: toolCalls.length,
      ...(data.usage?.total_tokens !== undefined ? { tokens: data.usage.total_tokens } : {}),
    });
    return { text: (message?.content ?? '').trim(), toolCalls };
  }
}

function parseArgs(raw: unknown): Readonly<Record<string, unknown>> {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** "1m30.5s", "7.66s", "250ms" (the rate-limit reset headers) or plain seconds (Retry-After), as milliseconds. */
export function parseWaitMs(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  if (text === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  let total = 0;
  let matched = false;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3_600_000;
  }
  return matched ? Math.round(total) : undefined;
}

function httpError(label: string, status: number, body: string, headers: Headers): AIHttpError {
  const retryAfterMs =
    parseWaitMs(headers.get('retry-after')) ?? parseWaitMs(headers.get('x-ratelimit-reset-requests')) ?? parseWaitMs(headers.get('x-ratelimit-reset-tokens'));
  // An account with no credit: the same for every model, and not a limit that waiting cures (OpenRouter's 402 is about one paid model).
  const noCredit = (status === 429 || status === 402) && label !== 'openrouter' && CREDIT_PATTERN.test(body);
  const daily = status === 429 && DAILY_PATTERN.test(body);
  const detail = body.slice(0, 300);
  const message = noCredit ? `${label} has no credit left (${status})` : daily ? `${label} daily quota exhausted (429)` : `${label} http ${status}: ${detail}`;
  // A "per day" cap never comes back in minutes whatever the header says about the per-minute window.
  return new AIHttpError(status, message, daily || noCredit ? undefined : retryAfterMs, daily || noCredit);
}

/**
 * Our conversation format as the OpenAI chat format. Tool-call ids are renamed to nine letters-and-digits: some services accept
 * nothing else, and the ids we hold may have come from another provider's reply earlier in the same request.
 */
export function toOpenAIMessages(messages: readonly AIChatMessage[]): unknown[] {
  const out: unknown[] = [];
  const ids = new Map<string, string>();
  const idFor = (original: string): string => {
    let id = ids.get(original);
    if (id === undefined) {
      id = `call${String(ids.size + 1).padStart(5, '0')}`;
      ids.set(original, id);
    }
    return id;
  };
  const lastCallByName = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content });
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const calls = (m.toolCalls ?? []).map((c) => {
        lastCallByName.set(c.name, c.id);
        return { id: idFor(c.id), type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } };
      });
      if (calls.length === 0 && m.content.trim() === '') continue;
      out.push({ role: 'assistant', content: m.content.trim() === '' ? null : m.content, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
    } else {
      const original = m.toolCallId ?? (m.name !== undefined ? lastCallByName.get(m.name) : undefined) ?? `tool_${out.length}`;
      out.push({ role: 'tool', tool_call_id: idFor(original), content: m.content });
    }
  }
  return out;
}

export type KeyVerdict = 'valid' | 'invalid' | 'notfound' | 'unreachable';

export interface KeyCheckResult {
  readonly verdict: KeyVerdict;
  /** What the service itself said when it refused ("Incorrect API key provided", an HTTP status), so the person can see why. */
  readonly detail?: string;
  /** Every model the service lists. */
  readonly models: readonly string[];
  /** The ones that say they can call tools, when the service says so for its models (OpenRouter does); otherwise undefined. */
  readonly toolModels?: readonly string[];
}

/** Asks the service whether a key is accepted, and which models it offers (a cheap request). Never throws. */
export async function checkBackupKey(
  baseUrl: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<KeyCheckResult> {
  const base = baseUrl.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${apiKey}` };
  try {
    // OpenRouter lists its models to anyone, so /models proves nothing about the key; its /key answers 401 for a wrong one.
    if (/^https:\/\/([^/]+\.)?openrouter\.ai(\/|$)/i.test(base)) {
      const keyRes = await fetchFn(`${base}/key`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (keyRes.status === 401 || keyRes.status === 403) return { verdict: 'invalid', models: [] };
      if (!keyRes.ok) return { verdict: 'unreachable', models: [] };
    }
    const res = await fetchFn(`${base}/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    // A list request has nothing else that could be wrong, so a 400 is the key (Google and xAI answer a bad key with 400).
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { verdict: 'invalid', models: [], detail: await whatItSaid(res) };
    }
    if (res.status === 404 || res.status === 410) return { verdict: 'notfound', models: [], detail: await whatItSaid(res) };
    if (!res.ok) return { verdict: 'unreachable', models: [] };
    const data = (await res.json().catch(() => ({}))) as {
      data?: ReadonlyArray<{ id?: unknown; supported_parameters?: unknown }>;
    };
    // Google lists its models as "models/gemini-...", and asks for them by the plain name.
    const listed = (data.data ?? []).flatMap((m) => (typeof m.id === 'string' ? [{ id: m.id.replace(/^models\//, ''), params: m.supported_parameters }] : []));
    const models = listed.map((m) => m.id);
    const says = listed.some((m) => Array.isArray(m.params));
    const toolModels = says ? listed.filter((m) => Array.isArray(m.params) && m.params.includes('tools')).map((m) => m.id) : undefined;
    return { verdict: 'valid', models, ...(toolModels !== undefined ? { toolModels } : {}) };
  } catch {
    return { verdict: 'unreachable', models: [] };
  }
}

/** "HTTP 400: Incorrect API key provided" — the status and the service's own words, short. */
async function whatItSaid(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  let said = text.replace(/\s+/g, ' ').trim();
  try {
    const j = JSON.parse(text) as { error?: unknown; message?: unknown; detail?: unknown };
    const inner = typeof j.error === 'object' && j.error !== null ? (j.error as { message?: unknown }).message : j.error;
    const pick = [inner, j.message, j.detail].find((v) => typeof v === 'string' && v !== '');
    if (typeof pick === 'string') said = pick;
  } catch {
    // not JSON: the plain text will do
  }
  said = said.slice(0, 140);
  return said === '' ? `HTTP ${res.status}` : `HTTP ${res.status}: ${said}`;
}

export type ProbeVerdict = 'ok' | 'invalid' | 'forbidden' | 'missing' | 'nocredit' | 'unreachable';

/**
 * Sends one tiny message to see that a key really works with a model (for services whose model list is public, so the list says
 * nothing about the key). A limit answer still means the key is good. Never throws.
 */
export async function probeBackupModel(
  baseUrl: string,
  apiKey: string,
  model: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15000,
): Promise<ProbeVerdict> {
  try {
    const ask = (extra: Record<string, unknown>): Promise<Response> =>
      fetchFn(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the word OK.' }], ...extra }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    let res = await ask({ max_tokens: 8, temperature: 0 });
    // OpenAI's newer models take `max_completion_tokens` and only the default temperature: that is not a missing model.
    if (res.status === 400) {
      const said = await res.text().catch(() => '');
      if (/max_tokens|temperature/i.test(said)) res = await ask({ max_completion_tokens: 256 });
      else return 'missing';
    }
    // A limit answer still means the key is good, but "you have no credits" (also a 429 at OpenAI) means nothing will answer until credit is added.
    if (res.status === 429 || res.status === 402) {
      const said = await res.text().catch(() => '');
      if (CREDIT_PATTERN.test(said) && !/openrouter\.ai/i.test(baseUrl)) return 'nocredit';
      if (res.status === 429) return 'ok';
    }
    if (res.ok) return 'ok';
    if (res.status === 401) return 'invalid';
    // 403: this key may not use this model (or this kind of use); another model may be fine, so it is not called a bad key.
    if (res.status === 403) return 'forbidden';
    if (res.status === 404 || res.status === 400 || res.status === 422) return 'missing';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}
