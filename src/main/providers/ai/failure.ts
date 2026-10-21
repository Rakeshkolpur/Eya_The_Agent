/**
 * What kind of failure an AI provider's error is, read the same way for every provider (Gemini, a backup service, Ollama), so the
 * chain can decide how long to leave a provider alone and the engine can tell the user the truth.
 *
 * Providers throw errors that carry `status` (the HTTP status, 0 for a timeout or a dropped connection), `retryAfterMs` (the
 * service's own "try again in" hint) and `dailyQuota` (the per-day allowance is what ran out).
 */
export type FailureKind = 'daily' | 'rate' | 'overloaded' | 'auth' | 'credit' | 'other';

export interface FailureInfo {
  readonly kind: FailureKind;
  readonly retryAfterMs?: number;
}

interface FailureFields {
  readonly status?: unknown;
  readonly retryAfterMs?: unknown;
  readonly dailyQuota?: unknown;
}

/** What services say when an account has no money/credit left (OpenAI answers 429 "insufficient_quota"; DeepSeek, 402 "Insufficient Balance"). */
export const CREDIT_PATTERN = /insufficient[_ ]quota|no credits? (?:remaining|left)|out of credits?|credit balance (?:is )?too low|insufficient balance|doesn'?t have any credits|has no credit left/i;

export function failureOf(err: unknown): FailureInfo {
  const fields = (typeof err === 'object' && err !== null ? err : {}) as FailureFields;
  const message = err instanceof Error ? err.message : String(err);
  const status = typeof fields.status === 'number' ? fields.status : undefined;
  const retryAfterMs =
    typeof fields.retryAfterMs === 'number' && Number.isFinite(fields.retryAfterMs) && fields.retryAfterMs >= 0 ? fields.retryAfterMs : undefined;
  const hint = retryAfterMs === undefined ? {} : { retryAfterMs };
  // (Before the limits: an account with no credit says 429 too, but waiting does not help; adding credit does.)
  if (CREDIT_PATTERN.test(message)) return { kind: 'credit' };
  if (fields.dailyQuota === true || /daily quota/i.test(message)) return { kind: 'daily', ...hint };
  if (status === 429 || /\b429\b|quota|rate.?limit|exhausted/i.test(message)) return { kind: 'rate', ...hint };
  if (status === 401 || status === 403 || /\b(401|403)\b|api key|unauthori[sz]ed|permission denied/i.test(message)) return { kind: 'auth' };
  if ((status !== undefined && status >= 500) || /\b(500|502|503|504)\b|overload|high demand|unavailable/i.test(message)) {
    return { kind: 'overloaded', ...hint };
  }
  return { kind: 'other' };
}

/** How long a provider that just failed this way is left alone before it is tried again. */
export function restFor(info: FailureInfo): number {
  const MINUTE = 60_000;
  switch (info.kind) {
    // The day's allowance: re-check every half hour at most (billing may have been switched on), sooner only if the service says so.
    case 'daily':
      return Math.min(30 * MINUTE, Math.max(5_000, info.retryAfterMs ?? 30 * MINUTE));
    // No credit: looked at again every few minutes (credit may have been added, and then the person is waiting for it to work), not on
    // every request. One refused try costs a fraction of a second.
    case 'credit':
      return 3 * MINUTE;
    case 'rate':
      return Math.min(5 * MINUTE, Math.max(5_000, info.retryAfterMs ?? MINUTE));
    case 'overloaded':
      return Math.min(5 * MINUTE, Math.max(10_000, info.retryAfterMs ?? MINUTE));
    case 'auth':
      return 10 * MINUTE;
    default:
      return 30_000;
  }
}

/** Thrown by a backup slot that has nothing in it: the chain moves on without counting it as a failure. */
export class NotConfiguredError extends Error {
  constructor(what: string) {
    super(`${what} is not set up`);
    this.name = 'NotConfigured';
  }
}
