import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * How many tokens each request takes. A request is everything Eya does for one thing the person said or typed: every answer the AI gives while
 * it is worked out, the AI's reading of a file, a web search that goes through the AI. Each provider reports what it used the moment an answer
 * arrives (`recordTokens`); whatever is running inside that request's own async context adds to that request's count, so nothing has to be
 * passed through the tools, and two requests running at once never mix. Outside a request (a key being tested, say) it does nothing.
 */
export interface TokenUsage {
  readonly prompt?: number | undefined;
  readonly completion?: number | undefined;
  readonly total?: number | undefined;
  /** How many of the prompt tokens the provider served from its cache (a part of `prompt`, not on top of it: never added to the total). */
  readonly cached?: number | undefined;
}

/** What one request took. */
export interface RequestTokens {
  /** How many AI answers came back for it. */
  calls: number;
  prompt: number;
  completion: number;
  total: number;
  /** Of the prompt tokens, how many came from the provider's cache (already counted in `prompt`). */
  cached: number;
  /** Tokens by who used them ("gemini", "openai", "ollama"…). */
  byProvider: Record<string, number>;
}

/** The numbers alone, as they are sent to the window and written in the log. */
export interface TokenSummary {
  readonly calls: number;
  readonly prompt: number;
  readonly completion: number;
  readonly total: number;
  /** Present only when some of the prompt was served from the provider's cache (already inside `prompt`). */
  readonly cached?: number;
}

/** One answer's usage, as it arrives (for diagnosis: written to the trace when EYA_TRACE_FILE is set). */
export interface UsageEvent {
  readonly provider: string;
  readonly prompt: number;
  readonly completion: number;
  readonly total: number;
  readonly cached: number;
}
const listeners = new Set<(e: UsageEvent) => void>();
export function onTokens(listener: (e: UsageEvent) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

const current = new AsyncLocalStorage<RequestTokens>();
let sinceStart = 0;

const num = (n: number | undefined): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/** Called by a provider when an answer arrives. Adds to the request that is running, if one is. */
export function recordTokens(provider: string, usage: TokenUsage): void {
  const prompt = num(usage.prompt);
  const completion = num(usage.completion);
  // (some services give only a total, or a total that also counts the thinking the answer needed: the total is what was used)
  const total = num(usage.total) || prompt + completion;
  if (total === 0) return;
  sinceStart += total;
  const cached = Math.min(num(usage.cached), prompt);
  for (const l of listeners) {
    try {
      l({ provider, prompt, completion: total > prompt ? total - prompt : completion, total, cached });
    } catch {
      /* a listener's trouble is its own */
    }
  }
  const meter = current.getStore();
  if (meter === undefined) return;
  meter.cached += cached;
  meter.calls += 1;
  meter.prompt += prompt;
  // (whatever the total holds beyond the prompt is the answer's side, thinking included, so that "sent + answer" always adds up to the total)
  meter.completion += total > prompt ? total - prompt : completion;
  meter.total += total;
  meter.byProvider[provider] = (meter.byProvider[provider] ?? 0) + total;
}

/**
 * Runs a request with its own count and returns the count with the result. A request that is already being counted (a spoken request is
 * transcribed first and then handled as text) is joined rather than counted twice: only the one that began the count is its `owner`.
 */
export async function withMeter<T>(run: () => Promise<T>): Promise<{ readonly result: T; readonly tokens: RequestTokens; readonly owner: boolean }> {
  const existing = current.getStore();
  if (existing !== undefined) return { result: await run(), tokens: existing, owner: false };
  const tokens: RequestTokens = { calls: 0, prompt: 0, completion: 0, total: 0, cached: 0, byProvider: {} };
  const result = await current.run(tokens, run);
  return { result, tokens, owner: true };
}

export function summarize(tokens: RequestTokens): TokenSummary {
  return { calls: tokens.calls, prompt: tokens.prompt, completion: tokens.completion, total: tokens.total, ...(tokens.cached > 0 ? { cached: tokens.cached } : {}) };
}

/** Everything counted since Eya started, over all requests. */
export function tokensSinceStart(): number {
  return sinceStart;
}
