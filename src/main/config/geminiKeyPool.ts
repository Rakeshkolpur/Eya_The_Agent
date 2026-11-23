import { createHash } from 'node:crypto';
import { rootLogger } from '@main/logging/logger';
import { failureOf, restFor } from '@main/providers/ai/failure';
import type { FailureInfo } from '@main/providers/ai/failure';
import type { AIChatMessage, AICompletion, AIProvider, AIToolSpec, CompleteOptions } from '@main/providers/ai/AIProvider';
import { keyHint } from '@shared/geminiKeys';
import type { GeminiKeyEntry, GeminiKeyState } from '@shared/geminiKeys';
import { nextUtcMidnight } from '@shared/quotaReset';

const log = rootLogger.child('ai.keys');

/** What one key's worth of Gemini does: GeminiAIProvider fits. */
export interface GeminiBackend {
  isReady(): boolean;
  hasKey(): boolean;
  currentModel(): string | undefined;
  liveUrl(): string | null;
  complete(messages: readonly AIChatMessage[], tools: readonly AIToolSpec[], options?: CompleteOptions): Promise<AICompletion>;
  transcribe(audioBase64: string, mimeType: string): Promise<string>;
  analyzeFile(dataBase64: string, mimeType: string, question: string): Promise<string>;
  groundedSearch(query: string): Promise<{ text: string; sources: { title: string; uri: string }[] }>;
}

/** What one key's worth of Gemini speech does: GeminiTTS fits. */
export interface SpeechBackend {
  hasKey(): boolean;
  stream(text: string, voice: string, onChunk: (pcm: Uint8Array) => void, signal: AbortSignal): Promise<{ model: string; ms: number; bytes: number }>;
}

type RestKind = 'daily' | 'rate' | 'auth';

export interface PoolState {
  readonly day: string;
  readonly rests: Readonly<Record<string, { readonly until: number; readonly kind: RestKind }>>;
  readonly requests: Readonly<Record<string, number>>;
}

/** What the pool keeps between runs: which key is resting and how many requests each answered today. No keys in it. */
export interface PoolStateStore {
  load(): PoolState | null;
  save(state: PoolState): void;
}

export interface PoolKey {
  readonly name: string;
  readonly key: string;
  readonly main: boolean;
}

export interface PoolDeps {
  readonly makeAi: (apiKey: string) => GeminiBackend;
  readonly makeSpeech: (apiKey: string) => SpeechBackend;
  readonly state?: PoolStateStore;
  readonly now?: () => number;
}

interface Slot {
  readonly id: string;
  name: string;
  readonly key: string;
  main: boolean;
  readonly ai: GeminiBackend;
  readonly speech: SpeechBackend;
}

/** A used-up key is looked at again after this at the latest (billing may have been switched on); it comes back by itself at the day's reset. */
const DAILY_REST_CAP_MS = 3 * 3_600_000;
/** A key the live voice just failed on is left alone this long, so the next conversation starts on another one. */
const LIVE_REST_MS = 10 * 60_000;
const TEST_MESSAGE: readonly AIChatMessage[] = [{ role: 'user', content: 'Reply with the single word: ok' }];

/** A short fingerprint that names a key without being it. */
export function keyId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 10);
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Several Gemini keys used one after another. The first key that is not resting answers; when Google says its free allowance for the day is
 * spent (or it is rate limited, or the key is refused) that key is put to rest and the same request goes straight on to the next one, so the
 * person never sees the switch. A used-up key comes back at the day's reset (or when Test shows it works). Only when every key is out does
 * the request fail, with the same error a single key would give.
 *
 * It stands in for one Gemini provider everywhere (answers, reading documents, transcribing, searching, the live voice's address) and
 * also gives the speech engine the same treatment, so each of them moves to the next key when its own allowance runs out.
 */
export class GeminiKeyPool implements AIProvider {
  readonly name = 'gemini';
  private slots: Slot[] = [];
  private readonly rests = new Map<string, { until: number; kind: RestKind }>();
  private readonly speechRests = new Map<string, number>();
  private readonly liveRests = new Map<string, number>();
  private readonly requests = new Map<string, number>();
  private active: string | null = null;
  private liveKey: string | null = null;
  private day: string;
  private lastSignature = '';
  private readonly listeners: Array<() => void> = [];
  private readonly now: () => number;

  constructor(private readonly deps: PoolDeps) {
    this.now = deps.now ?? Date.now;
    this.day = utcDay(this.now());
    const saved = deps.state?.load() ?? null;
    if (saved !== null && saved.day === this.day) {
      for (const [id, rest] of Object.entries(saved.rests)) if (rest.until > this.now()) this.rests.set(id, { until: rest.until, kind: rest.kind });
      for (const [id, n] of Object.entries(saved.requests)) this.requests.set(id, n);
    }
  }

  /** Puts these keys to work, in this order. Keys that stay keep what is known about them (their rests, their counts). */
  setKeys(list: readonly PoolKey[]): void {
    const next: Slot[] = [];
    for (const k of list) {
      const id = keyId(k.key);
      if (next.some((s) => s.id === id)) continue;
      const existing = this.slots.find((s) => s.id === id);
      if (existing !== undefined) {
        existing.name = k.name;
        existing.main = k.main;
        next.push(existing);
      } else {
        next.push({ id, name: k.name, key: k.key, main: k.main, ai: this.deps.makeAi(k.key), speech: this.deps.makeSpeech(k.key) });
      }
    }
    this.slots = next;
    for (const map of [this.rests, this.speechRests, this.liveRests, this.requests] as Array<Map<string, unknown>>) {
      for (const id of [...map.keys()]) if (!next.some((s) => s.id === id)) map.delete(id);
    }
    if (this.active !== null && !next.some((s) => s.id === this.active)) this.active = null;
    this.persist();
    this.notify();
  }

  /** Called when which key answers, or how a key stands, may have changed. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  isReady(): boolean {
    return this.slots.some((s) => s.ai.isReady());
  }

  hasKey(): boolean {
    return this.slots.length > 0;
  }

  currentModel(): string | undefined {
    return (this.candidates()[0] ?? this.slots[0])?.ai.currentModel();
  }

  // ---- answering

  async complete(messages: readonly AIChatMessage[], tools: readonly AIToolSpec[], options?: CompleteOptions): Promise<AICompletion> {
    // Another key is ready to take this over: give up on this one quickly instead of walking every model and waiting for a limit.
    return this.run((ai, more) => ai.complete(messages, tools, more ? { ...options, failFast: true } : options));
  }

  transcribe(audioBase64: string, mimeType: string): Promise<string> {
    return this.run((ai) => ai.transcribe(audioBase64, mimeType));
  }

  analyzeFile(dataBase64: string, mimeType: string, question: string): Promise<string> {
    return this.run((ai) => ai.analyzeFile(dataBase64, mimeType, question));
  }

  groundedSearch(query: string): Promise<{ text: string; sources: { title: string; uri: string }[] }> {
    return this.run((ai) => ai.groundedSearch(query));
  }

  private async run<T>(op: (ai: GeminiBackend, more: boolean) => Promise<T>): Promise<T> {
    if (this.slots.length === 0) throw new Error('Gemini API key missing (add one in Settings)');
    this.rollDay();
    const order = this.candidates();
    const failed: Array<{ err: unknown; info: FailureInfo }> = [];
    for (let i = 0; i < order.length; i += 1) {
      const slot = order[i] as Slot;
      try {
        const result = await op(slot.ai, i < order.length - 1);
        this.succeeded(slot);
        return result;
      } catch (err) {
        const info = failureOf(err);
        // Only what is about THIS key moves on to the next one: its day is spent, it is rate limited, or it is refused. An overloaded
        // service or a dropped connection is the same for every key.
        if (info.kind !== 'daily' && info.kind !== 'rate' && info.kind !== 'auth') throw err;
        failed.push({ err, info });
        this.rest(slot, info);
        log.warn('key set aside, trying the next', { key: slot.name, kind: info.kind, next: i < order.length - 1 });
      }
    }
    throw this.finalError(failed);
  }

  /** The error to give up with when every key failed: a limit if any key was limited (that is what the person can act on), else the first. */
  private finalError(failed: ReadonlyArray<{ err: unknown; info: FailureInfo }>): unknown {
    const limited = failed.find((f) => f.info.kind === 'daily' || f.info.kind === 'rate');
    return (limited ?? failed[0])?.err ?? new Error('All Gemini keys failed');
  }

  // ---- the live voice

  /** The live voice's address on the first key whose live voice has not just failed. */
  liveUrl(): string | null {
    if (this.slots.length === 0) {
      this.liveKey = null;
      return null;
    }
    const now = this.now();
    const slot = this.slots.find((s) => (this.liveRests.get(s.id) ?? 0) <= now && s.ai.liveUrl() !== null) ?? this.slots[0];
    this.liveKey = slot?.id ?? null;
    return slot?.ai.liveUrl() ?? null;
  }

  /**
   * The live voice stopped or could not start on the key it was given (its allowance, a refused key, a dropped line): that key is left alone
   * for a while. True when another key is free to try right now.
   */
  liveTrouble(): boolean {
    const now = this.now();
    if (this.liveKey !== null) this.liveRests.set(this.liveKey, now + LIVE_REST_MS);
    this.notify();
    return this.slots.some((s) => (this.liveRests.get(s.id) ?? 0) <= now && s.ai.liveUrl() !== null);
  }

  // ---- speech

  /** The speech engine, with the same key rotation: a key whose speech allowance is spent is set aside and the next one is asked. */
  readonly speech: SpeechBackend = {
    hasKey: () => this.slots.length > 0,
    stream: (text, voice, onChunk, signal) => this.streamSpeech(text, voice, onChunk, signal),
  };

  private async streamSpeech(text: string, voice: string, onChunk: (pcm: Uint8Array) => void, signal: AbortSignal): Promise<{ model: string; ms: number; bytes: number }> {
    if (this.slots.length === 0) throw new Error('Gemini API key missing (add one in Settings)');
    const now = this.now();
    const free = this.slots.filter((s) => (this.speechRests.get(s.id) ?? 0) <= now);
    const order = free.length > 0 ? free : this.slots;
    let firstError: unknown;
    for (const slot of order) {
      let heard = false;
      try {
        return await slot.speech.stream(text, voice, (pcm) => {
          heard = true;
          onChunk(pcm);
        }, signal);
      } catch (err) {
        // Half a sentence was already spoken, or the caller cancelled: another key's voice for the rest would be worse than stopping.
        if (signal.aborted || heard) throw err;
        firstError ??= err;
        const info = failureOf(err);
        if (info.kind !== 'daily' && info.kind !== 'rate' && info.kind !== 'auth') throw err;
        this.speechRests.set(slot.id, this.now() + this.restMs(info));
        log.warn('key set aside for speech, trying the next', { key: slot.name, kind: info.kind });
      }
    }
    throw firstError ?? new Error('All Gemini keys failed for speech');
  }

  // ---- what is known about each key

  status(): readonly GeminiKeyEntry[] {
    this.rollDay();
    const now = this.now();
    const inUse = this.candidates().find((s) => this.restOf(s.id, now) === undefined)?.id;
    return this.slots.map((s) => {
      const rest = this.restOf(s.id, now);
      const state: GeminiKeyState = rest === undefined ? 'ready' : rest.kind === 'daily' ? 'used-up' : rest.kind === 'rate' ? 'busy' : 'refused';
      return {
        id: s.id,
        name: s.name,
        hint: keyHint(s.key),
        main: s.main,
        state,
        backAt: rest === undefined || rest.kind === 'auth' ? null : rest.until,
        requests: this.requests.get(s.id) ?? 0,
        inUse: s.id === inUse && rest === undefined,
      };
    });
  }

  /** The key (by id), for the one place that needs it: the person's own request to test it. Never sent to a page. */
  private slotById(id: string | null): Slot | undefined {
    return id === null ? undefined : this.slots.find((s) => s.id === id);
  }

  /**
   * Asks this one key a tiny question, whatever the others are doing. A key that works is put back in use at once; one that does not is set
   * aside as a real request would have set it aside. Returns what the person needs to hear.
   */
  async testKey(id: string): Promise<{ readonly ok: boolean; readonly kind: FailureInfo['kind'] | 'ok'; readonly backAt: number | null }> {
    const slot = this.slotById(id);
    if (slot === undefined) return { ok: false, kind: 'other', backAt: null };
    try {
      await slot.ai.complete(TEST_MESSAGE, [], { failFast: true });
      this.rests.delete(slot.id);
      this.speechRests.delete(slot.id);
      this.liveRests.delete(slot.id);
      this.persist();
      this.notify();
      return { ok: true, kind: 'ok', backAt: null };
    } catch (err) {
      const info = failureOf(err);
      if (info.kind === 'daily' || info.kind === 'rate' || info.kind === 'auth') this.rest(slot, info);
      return { ok: false, kind: info.kind, backAt: this.rests.get(slot.id)?.until ?? null };
    }
  }

  // ---- internals

  private restOf(id: string, now: number): { until: number; kind: RestKind } | undefined {
    const r = this.rests.get(id);
    return r !== undefined && r.until > now ? r : undefined;
  }

  private freeSlots(): Slot[] {
    const now = this.now();
    return this.slots.filter((s) => this.restOf(s.id, now) === undefined);
  }

  /**
   * The keys in the order they are tried: from the key that is answering now, on to the ones added after it, and only then back to the earlier
   * ones (a key is finished with for the day before the next is used, and an earlier one is not returned to the moment its rest ends: that made
   * the answers jump between accounts). Keys resting are skipped; if every key is resting, all of them are tried (a rest is a guess).
   */
  private candidates(): Slot[] {
    const start = Math.max(0, this.slots.findIndex((s) => s.id === this.active));
    const rotated = [...this.slots.slice(start), ...this.slots.slice(0, start)];
    const now = this.now();
    const free = rotated.filter((s) => this.restOf(s.id, now) === undefined);
    return free.length > 0 ? free : rotated;
  }

  /** How long a key that failed this way is left alone: a spent day until the day's reset (not for ever), the rest as for any provider. */
  private restMs(info: FailureInfo): number {
    if (info.kind !== 'daily') return restFor(info);
    const untilReset = nextUtcMidnight(new Date(this.now())).getTime() - this.now();
    const wanted = info.retryAfterMs !== undefined ? Math.max(5_000, info.retryAfterMs) : untilReset;
    return Math.min(DAILY_REST_CAP_MS, Math.max(5_000, Math.min(untilReset + 60_000, wanted)));
  }

  private rest(slot: Slot, info: FailureInfo): void {
    if (info.kind !== 'daily' && info.kind !== 'rate' && info.kind !== 'auth') return;
    this.rests.set(slot.id, { until: this.now() + this.restMs(info), kind: info.kind });
    this.persist();
    this.notify();
  }

  private succeeded(slot: Slot): void {
    this.requests.set(slot.id, (this.requests.get(slot.id) ?? 0) + 1);
    const wasResting = this.rests.delete(slot.id);
    const switched = this.active !== slot.id;
    this.active = slot.id;
    this.persist();
    if (wasResting || switched) this.notify();
  }

  /** A new UTC day is a new allowance: yesterday's rests and counts mean nothing now. */
  private rollDay(): void {
    const today = utcDay(this.now());
    if (today === this.day) return;
    this.day = today;
    this.rests.clear();
    this.speechRests.clear();
    this.liveRests.clear();
    this.requests.clear();
    this.active = null;
    this.persist();
    this.notify();
  }

  private persist(): void {
    const store = this.deps.state;
    if (store === undefined) return;
    try {
      store.save({
        day: this.day,
        rests: Object.fromEntries([...this.rests].map(([id, r]) => [id, { until: r.until, kind: r.kind }])),
        requests: Object.fromEntries(this.requests),
      });
    } catch (err) {
      log.warn('could not save which keys are resting', { err: String(err) });
    }
  }

  private notify(): void {
    // Who answers and how each key stands: the counts are left out so a busy chat does not announce itself on every request.
    const signature = this.status()
      .map((e) => [e.id, e.name, e.state, e.backAt ?? '', e.inUse ? 'x' : ''].join('|'))
      .join(';');
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    for (const listener of this.listeners) listener();
  }
}
