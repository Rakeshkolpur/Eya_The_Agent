import { rootLogger } from '@main/logging/logger';
import type { AIChatMessage, AICompletion, AIProvider, AIToolSpec, CompleteOptions } from './AIProvider';
import { NotConfiguredError, failureOf, restFor } from './failure';
import type { FailureInfo, FailureKind } from './failure';

const log = rootLogger.child('ai.chain');

/** What one provider has done today (the free allowances are per day, so the count is what tells the user how far they got). */
export interface ProviderUsage {
  requests: number;
  /** Requests that had been answered when the day's allowance ran out: "my key gives me about this many". */
  limitedAfter?: number;
  limitedAt?: number;
}

/** What is kept between runs, so a spent allowance is still known after Eya restarts. */
export interface ChainState {
  /** The UTC day this is about: Google's daily allowance resets at midnight UTC. */
  readonly day: string;
  readonly rests: Readonly<Record<string, number>>;
  /** Why each resting provider is resting (limit, overload, bad key), so the user is told the right thing. */
  readonly restKinds?: Readonly<Record<string, FailureKind>>;
  readonly usage: Readonly<Record<string, ProviderUsage>>;
}

export interface ChainStore {
  load(): ChainState | null;
  save(state: ChainState): void;
}

export interface ChainOptions {
  readonly now?: () => number;
  readonly store?: ChainStore;
}

/** One provider as the chain sees it right now, for telling the user who is answering. */
export interface RouteEntry {
  readonly name: string;
  /** Configured and not known to be down. */
  readonly ready: boolean;
  readonly model?: string;
  /** When it will be tried again (epoch ms), if it is being left alone, and why. */
  readonly restingUntil?: number;
  readonly restKind?: FailureKind;
  readonly requests: number;
  readonly limitedAfter?: number;
}

export interface AiUsageSummary {
  readonly day: string;
  readonly providers: ReadonlyArray<{
    readonly name: string;
    readonly requests: number;
    readonly limitedAfter?: number;
    /** When it will be tried again (epoch ms), if it is being left alone. */
    readonly restingUntil?: number;
  }>;
}

/** Every AI that was tried had used up its allowance (or was rate limited): the thing to tell the user is when, and what still works. */
export class AllProvidersLimitedError extends Error {
  readonly allLimited = true;
  readonly status = 429;
  constructor(
    readonly providers: readonly string[],
    readonly dailyQuota: boolean,
    readonly retryAfterMs?: number,
    /** The ones among them that have no credit left (adding credit fixes those; waiting does not). */
    readonly noCredit: readonly string[] = [],
  ) {
    super(
      dailyQuota
        ? `${providers.join(' and ')}: daily quota exhausted (429)`
        : `${providers.join(' and ')}: rate limit (429)`,
    );
    this.name = 'AllProvidersLimitedError';
  }
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Tries providers in order and returns the first successful completion.
 * Order is passed in — put the highest-quality provider first, then the online backup, then offline fallbacks.
 *
 * A provider that fails because its allowance is spent (or it is overloaded) is left alone for a while, so the next requests go
 * straight to the backup instead of waiting for the primary to fail again each time; it is tried again when its rest is over. While a
 * later provider is ready, the earlier one is asked to give up quickly (`failFast`) rather than retry for ten seconds. Only falls
 * through on thrown errors; a valid empty completion is still returned as-is.
 *
 * If every provider fails, the error thrown is the FIRST provider's: that is the real reason ("rate limited", "overloaded"). The backup
 * being offline ("fetch failed") would otherwise hide it. The exception is when two or more were out of allowance: then the error says
 * so for all of them, with the soonest any is back.
 */
export class ChainedAIProvider implements AIProvider {
  readonly name = 'chain';
  private readonly rests = new Map<string, number>();
  private readonly restKinds = new Map<string, FailureKind>();
  private usage = new Map<string, ProviderUsage>();
  private day: string;
  private readonly now: () => number;
  /** A provider the user asked to be tried first (their chosen backup model), whatever the usual order. */
  private preferred: AIProvider | null = null;
  private readonly listeners: Array<() => void> = [];
  private lastSignature = '';

  constructor(
    private readonly providers: readonly AIProvider[],
    private readonly options: ChainOptions = {},
  ) {
    if (providers.length === 0) throw new Error('ChainedAIProvider needs at least one provider');
    this.now = options.now ?? Date.now;
    this.day = utcDay(this.now());
    const saved = options.store?.load() ?? null;
    if (saved !== null && saved.day === this.day) {
      for (const [name, until] of Object.entries(saved.rests)) {
        if (until <= this.now()) continue;
        this.rests.set(name, until);
        const kind = saved.restKinds?.[name];
        if (kind !== undefined) this.restKinds.set(name, kind);
      }
      for (const [name, u] of Object.entries(saved.usage)) this.usage.set(name, { ...u });
    }
  }

  isReady(): boolean {
    return this.providers.some((p) => p.isReady());
  }

  /** Forget that providers were resting (the user changed a key, or asked to try again): all of them, or only the one named. */
  clearRests(name?: string): void {
    if (name === undefined) {
      this.rests.clear();
      this.restKinds.clear();
    } else {
      this.rests.delete(name);
      this.restKinds.delete(name);
    }
    this.persist();
    this.notify();
  }

  /** A test showed this provider cannot answer (no credit, key refused): rest it as a failed request would, so the interface says so now. */
  markFailed(name: string, kind: FailureKind): void {
    if (!this.providers.some((p) => p.name === name)) return;
    this.rests.set(name, this.now() + restFor({ kind }));
    this.restKinds.set(name, kind);
    this.persist();
    this.notify();
  }

  /** Try this provider first (the user chose it); null puts the usual order back. */
  setPreferred(provider: AIProvider | null): void {
    this.preferred = provider;
    this.notify();
  }

  /** Called when who would answer, or why not, may have changed. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** The providers in the order they are tried right now, with whether they are usable, their model and any rest. */
  route(): readonly RouteEntry[] {
    this.rollDay();
    const now = this.now();
    return this.ordered().map((p) => {
      const u = this.usage.get(p.name);
      const until = this.rests.get(p.name);
      const resting = until !== undefined && until > now;
      const model = p.currentModel?.();
      const kind = this.restKinds.get(p.name);
      return {
        name: p.name,
        ready: p.isReady(),
        ...(model !== undefined ? { model } : {}),
        ...(resting ? { restingUntil: until } : {}),
        ...(resting && kind !== undefined ? { restKind: kind } : {}),
        requests: u?.requests ?? 0,
        ...(u?.limitedAfter !== undefined ? { limitedAfter: u.limitedAfter } : {}),
      };
    });
  }

  private ordered(): readonly AIProvider[] {
    const first = this.preferred;
    return first !== null && this.providers.includes(first) ? [first, ...this.providers.filter((p) => p !== first)] : this.providers;
  }

  private notify(): void {
    if (this.listeners.length === 0) return;
    const signature = this.route()
      .map((e) => [e.name, e.ready, e.model ?? '', e.restingUntil ?? '', e.restKind ?? ''].join('|'))
      .join(';');
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // a listener's trouble is its own
      }
    }
  }

  summary(): AiUsageSummary {
    this.rollDay();
    const now = this.now();
    return {
      day: this.day,
      providers: this.providers.map((p) => {
        const u = this.usage.get(p.name);
        const until = this.rests.get(p.name);
        return {
          name: p.name,
          requests: u?.requests ?? 0,
          ...(u?.limitedAfter !== undefined ? { limitedAfter: u.limitedAfter } : {}),
          ...(until !== undefined && until > now ? { restingUntil: until } : {}),
        };
      }),
    };
  }

  async complete(
    messages: readonly AIChatMessage[],
    tools: readonly AIToolSpec[],
    _options?: CompleteOptions,
  ): Promise<AICompletion> {
    this.rollDay();
    const now = this.now();
    const rested = (p: AIProvider): boolean => (this.rests.get(p.name) ?? 0) > now;
    // If every provider is resting, try them all anyway, in order: a rest is a guess, and refusing to try is worse than a failed try.
    const all = this.ordered();
    const fresh = all.filter((p) => !rested(p));
    const order = fresh.length > 0 ? fresh : all;
    if (order.length < all.length) {
      log.info('skipping providers that are resting', { skipped: all.filter(rested).map((p) => p.name) });
    }

    let firstError: unknown;
    const limited: Array<{ name: string; info: FailureInfo }> = [];
    for (let i = 0; i < order.length; i += 1) {
      const p = order[i] as AIProvider;
      const another = order.slice(i + 1).some((q) => q.isReady());
      try {
        const started = Date.now();
        const result = await p.complete(messages, tools, another ? { failFast: true } : undefined);
        this.count(p.name).requests += 1;
        this.persist();
        this.notify();
        log.debug('provider succeeded', { provider: p.name, ms: Date.now() - started, tools: result.toolCalls.length });
        return result;
      } catch (err) {
        if (err instanceof NotConfiguredError) continue;
        firstError ??= err;
        const info = failureOf(err);
        const rest = restFor(info);
        this.rests.set(p.name, this.now() + rest);
        this.restKinds.set(p.name, info.kind);
        const u = this.count(p.name);
        if (info.kind === 'daily' || info.kind === 'rate' || info.kind === 'credit') {
          limited.push({ name: p.name, info });
          if ((info.kind === 'daily' || info.kind === 'credit') && u.limitedAfter === undefined) {
            u.limitedAfter = u.requests;
            u.limitedAt = this.now();
            log.warn('daily allowance used up', { provider: p.name, requestsToday: u.requests });
          }
        }
        this.persist();
        this.notify();
        log.warn('provider failed, trying next', {
          provider: p.name,
          kind: info.kind,
          restMs: rest,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Providers skipped because they were resting from a limit count too: they are out as much as the ones that just failed.
    const skipped = this.providers.filter((p) => !order.includes(p) && ['daily', 'rate', 'credit'].includes(this.restKinds.get(p.name) ?? ''));
    const names = [...skipped.map((p) => p.name), ...limited.map((l) => l.name)];
    // Gemini on its own keeps its own wording (and its own error); any other single provider, or two or more, are named.
    if (names.length >= 2 || (names.length === 1 && names[0] !== 'gemini')) {
      const waits = [
        ...limited.flatMap((l) => (l.info.retryAfterMs !== undefined ? [l.info.retryAfterMs] : [])),
        ...skipped.flatMap((p) => {
          const until = this.rests.get(p.name);
          return until === undefined ? [] : [Math.max(0, until - now)];
        }),
      ];
      const spent = (kind: string | undefined): boolean => kind === 'daily' || kind === 'credit';
      const daily = limited.every((l) => spent(l.info.kind)) && skipped.every((p) => spent(this.restKinds.get(p.name)));
      const noCredit = [...limited.filter((l) => l.info.kind === 'credit').map((l) => l.name), ...skipped.filter((p) => this.restKinds.get(p.name) === 'credit').map((p) => p.name)];
      throw new AllProvidersLimitedError(names, daily, waits.length > 0 ? Math.min(...waits) : undefined, noCredit);
    }
    throw firstError ?? new Error('All AI providers failed');
  }

  private count(name: string): ProviderUsage {
    let u = this.usage.get(name);
    if (u === undefined) {
      u = { requests: 0 };
      this.usage.set(name, u);
    }
    return u;
  }

  /** A new UTC day is a new allowance: yesterday's counts and rests mean nothing now. */
  private rollDay(): void {
    const today = utcDay(this.now());
    if (today === this.day) return;
    this.day = today;
    this.usage = new Map();
    this.rests.clear();
    this.restKinds.clear();
    this.persist();
  }

  private persist(): void {
    const store = this.options.store;
    if (store === undefined) return;
    try {
      store.save({
        day: this.day,
        rests: Object.fromEntries([...this.rests].filter(([, until]) => until > this.now())),
        restKinds: Object.fromEntries(this.restKinds),
        usage: Object.fromEntries(this.usage),
      });
    } catch (err) {
      log.warn('could not save the AI usage record', { err: String(err) });
    }
  }
}
