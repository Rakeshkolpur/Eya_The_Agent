import { cpus } from 'node:os';
import { recordTokens } from './tokenMeter';
import { StoppedError, wasAborted } from '@main/agent/stopping';
import { rootLogger } from '@main/logging/logger';
import { ATTACHMENTS_MARKER } from '@shared/attachments';
import { DEFAULT_LOCAL_MODEL, DEFAULT_OLLAMA_ADDRESS, describeLocalAi, modelInstalled } from '@shared/localAi';
import type { LocalAiStatus } from '@shared/localAi';
import type { AIChatMessage, AICompletion, AIProvider, AIToolCall, AIToolSpec, CompleteOptions } from './AIProvider';
import { NotConfiguredError } from './failure';
import { compactForLocal, needsStrongerAI } from './localPrompt';

const log = rootLogger.child('ai.ollama');

export interface OllamaConfig {
  readonly baseUrl: string;
  /** The model to ask for. A function so a change in Settings applies to the next request without a restart. */
  readonly model: () => string;
  /** How long Ollama keeps the model in memory after a request: loading it again costs seconds on a laptop. */
  readonly keepAlive: string;
  /** The context size. Small, so the model stays small in memory; it must be the same for every request or Ollama reloads the model. */
  readonly numContext: number;
  readonly maxTokens: number;
  /** How many threads the model may use: half of the PC's (about its real cores: more only slows it down and starves the window; measured on a 2-core laptop: 2 threads answer as fast as 3). The same for every request, or Ollama reloads the model. */
  readonly threads: number;
  /** Nothing at all has come back this long after asking (a model that has to be loaded first is slow on a laptop). */
  readonly firstWordMs: number;
  /** The answer started, then went quiet this long. */
  readonly quietMs: number;
  /** An answer that is still being written after this long is cut off. */
  readonly totalMs: number;
  /** The sentence about which language to answer in. */
  readonly languageRule: () => string;
  /** Whether a request that is too much for the small model may be handed to another AI (not while the person chose "Local AI only"). */
  readonly mayHandOver: () => boolean;
  readonly fetchFn: typeof fetch;
}

const DEFAULT_CONFIG: OllamaConfig = {
  baseUrl: DEFAULT_OLLAMA_ADDRESS,
  model: () => DEFAULT_LOCAL_MODEL,
  keepAlive: '30m',
  numContext: 2048,
  maxTokens: 400,
  threads: Math.max(1, Math.floor(cpus().length / 2)),
  firstWordMs: 90_000,
  quietMs: 30_000,
  totalMs: 180_000,
  languageRule: () => '',
  mayHandOver: () => true,
  fetchFn: (...args) => fetch(...args),
};

export type OllamaErrorKind = 'not-running' | 'model-missing' | 'timeout' | 'protocol' | 'http' | 'cannot-read-files';

/** Why Ollama could not answer, in words the person can act on (these are shown to them as they are). */
export class OllamaError extends Error {
  constructor(
    readonly kind: OllamaErrorKind,
    message: string,
    /** The HTTP status when there was one (0 otherwise): the chain reads it to decide how long to leave this AI alone. */
    readonly status = 0,
  ) {
    super(message);
    this.name = 'OllamaError';
  }
  /** What to tell the person. */
  get userMessage(): string {
    return this.message;
  }
}

/** The small local model is not the one for this request: another AI is asked, and the local one is not counted as having failed. */
export class LocalAiDeclinedError extends NotConfiguredError {
  /** What to tell the person when no other AI could answer either (only set when the local AI would have made things worse, not merely slower). */
  readonly userMessage: string | undefined;
  constructor(userMessage?: string) {
    super('The local AI for this request');
    this.name = 'LocalAiDeclined';
    this.userMessage = userMessage;
    if (userMessage !== undefined) this.message = userMessage;
  }
}

/**
 * A website task is in progress (the page's answers are in the conversation) and the small local model is asked for the next step. Measured on a real
 * Flipkart order: it answered "I cannot access the user's account" (ending the task), took 30-35 s a step, and wrote tool calls as plain text. It is
 * not asked to carry a task on; the person is told the truth and the cloud AI is tried again by the next request.
 */
export const LOCAL_CANNOT_CARRY_TASK =
  "My cloud AI did not answer in time, and the small local AI cannot work a website step by step. Say \"continue\" in a few seconds and I'll carry on from where the page is.";

export function asksToWorkAWebsite(userText: string, tools: readonly AIToolSpec[]): boolean {
  return tools.some((t) => t.name === 'click_on_page' || t.name === 'fill_on_page') && needsStrongerAI(userText);
}

export function isTaskInProgress(messages: readonly AIChatMessage[], tools: readonly AIToolSpec[]): boolean {
  return tools.length > 0 && messages.some((m) => m.role === 'tool');
}

interface OllamaToolCall {
  readonly function?: { readonly name?: string; readonly arguments?: unknown };
}

interface OllamaChunk {
  readonly message?: { readonly role?: string; readonly content?: string; readonly tool_calls?: readonly OllamaToolCall[] };
  readonly done?: boolean;
  readonly error?: string;
  /** On the last piece: how many tokens the prompt took, and how many the answer took. */
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
}

/**
 * The AI that runs on this PC, through Ollama (no key, nothing leaves the computer). The answer is read as it is written, so the page can
 * show it growing; the model is kept loaded between requests; the prompt it is given is short (see localPrompt.ts); and it never runs
 * anything: tool calls it proposes are handed to Eya's own checked tools, and only tools that were offered to it are passed on.
 */
export class OllamaAIProvider implements AIProvider {
  readonly name = 'ollama';
  private readonly cfg: OllamaConfig;
  /** What the last look at Ollama found: null before the first look. */
  private reachable: boolean | null = null;
  private modelThere: boolean | null = null;
  private installed: readonly string[] = [];
  private warmed: { readonly model: string; readonly at: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners: Array<() => void> = [];

  constructor(overrides?: Partial<OllamaConfig>) {
    const envModel = process.env['EYA_OLLAMA_MODEL']?.trim();
    this.cfg = {
      ...DEFAULT_CONFIG,
      baseUrl: process.env['EYA_OLLAMA_URL']?.trim() || DEFAULT_CONFIG.baseUrl,
      ...(envModel !== undefined && envModel !== '' ? { model: () => envModel } : {}),
      ...overrides,
    };
  }

  /** Called when whether Ollama is reachable (or has the model) changes, so the badge in the interface can follow. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private note(reachable: boolean, modelThere: boolean | null): void {
    const changed = reachable !== this.reachable || modelThere !== this.modelThere;
    this.reachable = reachable;
    this.modelThere = modelThere;
    if (!changed) return;
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // a listener's trouble is its own
      }
    }
  }

  isReady(): boolean {
    return this.reachable === true && this.modelThere !== false;
  }

  currentModel(): string | undefined {
    return this.cfg.model();
  }

  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  /** Looks at Ollama now: is it running, and which models does it have. Never throws. */
  async status(): Promise<LocalAiStatus> {
    const model = this.cfg.model();
    let running = false;
    let installed: string[] = [];
    try {
      const res = await this.cfg.fetchFn(`${this.cfg.baseUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        running = true;
        const body = (await res.json().catch(() => ({}))) as { models?: ReadonlyArray<{ name?: unknown; model?: unknown }> };
        installed = (body.models ?? []).map((m) => (typeof m.name === 'string' ? m.name : typeof m.model === 'string' ? m.model : '')).filter((n) => n !== '');
      }
    } catch {
      running = false;
    }
    this.installed = installed;
    this.note(running, running ? modelInstalled(installed, model) : null);
    return describeLocalAi({ running, installed, model, address: this.cfg.baseUrl });
  }

  /** Keeps an eye on whether Ollama is there (cheap: one small request), so the interface says so without being asked. */
  startMonitoring(everyMs = 30_000): void {
    if (this.timer !== null) return;
    void this.status();
    this.timer = setInterval(() => void this.status(), everyMs);
    this.timer.unref?.();
  }

  stopMonitoring(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Loads the model into memory ahead of the first question, so that one is not the slow one. Only when the local AI is the one being used:
   * a 1.3 GB model sitting in memory for nothing is a cost on a small laptop. Once per model per keep-alive period; never throws.
   */
  async warm(): Promise<void> {
    const model = this.cfg.model();
    const now = Date.now();
    if (this.warmed !== null && this.warmed.model === model && now - this.warmed.at < 20 * 60_000) return;
    this.warmed = { model, at: now };
    try {
      const res = await this.cfg.fetchFn(`${this.cfg.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: this.cfg.keepAlive, options: { num_ctx: this.cfg.numContext, num_thread: this.cfg.threads } }),
        signal: AbortSignal.timeout(this.cfg.firstWordMs),
      });
      if (!res.ok) this.warmed = null;
      else log.info('local model loaded', { model, ms: Date.now() - now });
    } catch {
      this.warmed = null;
    }
  }

  async complete(messages: readonly AIChatMessage[], tools: readonly AIToolSpec[], options?: CompleteOptions): Promise<AICompletion> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    // Files attached to the message: the small model cannot read them (it is not given the tool that does), and must not make up what is in them.
    if (messages.some((m) => m.role === 'system' && m.content.includes(ATTACHMENTS_MARKER))) {
      if (options?.failFast === true && this.cfg.mayHandOver()) throw new LocalAiDeclinedError();
      throw new OllamaError('cannot-read-files', 'The local AI cannot read attached files. Choose "Local AI first" or Automatic in the AI list (a cloud AI reads the file), or ask without the file.');
    }
    // A structured task (a drafted chat reply) is already made small for this model; and the words in it are another person's, so they do not decide which AI answers.
    const structured = options?.structured;
    // A task with tool results in it, or a request to work a website or an account ("login flipkart and order …") when the browser's tools are the ones asked for: not for the
    // small model, unless the person chose "local only". Measured: with the cloud AIs out it answered "I cannot assist … a website that may be illegal or harmful" after 40 s.
    if (options?.structured === undefined && this.cfg.mayHandOver() && (isTaskInProgress(messages, tools) || (lastUser !== undefined && asksToWorkAWebsite(lastUser.content, tools)))) {
      log.info('the small local AI does not carry a task on', { tools: tools.length });
      throw new LocalAiDeclinedError(LOCAL_CANNOT_CARRY_TASK);
    }
    // Too much for the small model, and another AI is ready (and may be used): hand it over without counting this as a failure.
    if (structured === undefined && options?.failFast === true && this.cfg.mayHandOver() && lastUser !== undefined && needsStrongerAI(lastUser.content)) {
      log.info('handed over to a stronger AI', { chars: lastUser.content.length });
      throw new LocalAiDeclinedError();
    }

    const model = this.cfg.model();
    // (a structured task keeps its OWN instructions: the generic prompt would replace them with "reply in plain text", and the answer would never be the JSON that was asked for)
    const prompt: { readonly messages: readonly AIChatMessage[]; readonly tools: readonly AIToolSpec[] } =
      structured !== undefined ? { messages: structured.local ?? messages, tools: [] } : compactForLocal(messages, tools, this.cfg.languageRule(), new Date());
    const offered = new Set(prompt.tools.map((t) => t.name));
    const body = {
      model,
      messages: prompt.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls !== undefined && m.toolCalls.length > 0 ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })) } : {}),
        ...(m.role === 'tool' && m.name !== undefined ? { tool_name: m.name } : {}),
      })),
      stream: true,
      keep_alive: this.cfg.keepAlive,
      // (held to the shape that was asked for: the answer always parses, whatever the small model would have written)
      ...(structured !== undefined ? { format: structured.schema } : {}),
      ...(prompt.tools.length === 0 ? {} : { tools: prompt.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }),
      options: { temperature: 0.3, num_ctx: this.cfg.numContext, num_thread: this.cfg.threads, num_predict: this.cfg.maxTokens },
    };

    const controller = new AbortController();
    // The person stopped the request: the request to Ollama is cancelled at once.
    const stopSignal = options?.signal;
    if (stopSignal?.aborted === true) throw new StoppedError();
    const onStop = (): void => controller.abort();
    stopSignal?.addEventListener('abort', onStop, { once: true });
    let cutOff: 'first' | 'quiet' | 'total' | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number, why: 'first' | 'quiet'): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        cutOff = why;
        controller.abort();
      }, ms);
    };
    const total = setTimeout(() => {
      cutOff = 'total';
      controller.abort();
    }, this.cfg.totalMs);
    const started = Date.now();
    arm(this.cfg.firstWordMs, 'first');

    try {
      let res: Response;
      try {
        res = await this.cfg.fetchFn(`${this.cfg.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if (wasAborted(stopSignal)) throw new StoppedError();
        if (cutOff !== null) throw this.timeoutError(cutOff);
        this.note(false, null);
        throw new OllamaError('not-running', `Ollama is not running (nothing answered at ${this.cfg.baseUrl}), so the local AI cannot answer. Open the Ollama app, or run: ollama serve`);
      }
      if (!res.ok) throw await this.httpError(res, model);
      if (res.body === null) throw new OllamaError('protocol', 'Ollama answered with nothing Eya could read. Try again.');

      let text = '';
      let sawDone = false;
      const rawCalls: OllamaToolCall[] = [];
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      const handle = (line: string): void => {
        if (line.trim() === '') return;
        let chunk: OllamaChunk;
        try {
          chunk = JSON.parse(line) as OllamaChunk;
        } catch {
          throw new OllamaError('protocol', 'Ollama sent something Eya could not read. Try again.');
        }
        if (typeof chunk.error === 'string') throw this.mapError(chunk.error, model);
        const piece = chunk.message?.content;
        if (typeof piece === 'string' && piece !== '') {
          text += piece;
          options?.onPartial?.(text.trim());
        }
        if (chunk.message?.tool_calls !== undefined) rawCalls.push(...chunk.message.tool_calls);
        if (chunk.done === true) {
          sawDone = true;
          recordTokens('ollama', { prompt: chunk.prompt_eval_count, completion: chunk.eval_count });
        }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm(this.cfg.quietMs, 'quiet');
          pending += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = pending.indexOf('\n')) >= 0) {
            handle(pending.slice(0, nl));
            pending = pending.slice(nl + 1);
          }
        }
        handle(pending);
      } catch (err) {
        if (wasAborted(stopSignal)) throw new StoppedError();
        if (err instanceof OllamaError) throw err;
        if (cutOff !== null) throw this.timeoutError(cutOff);
        throw new OllamaError('protocol', 'The connection to Ollama broke while it was answering. Try again.');
      }

      const toolCalls: AIToolCall[] = [];
      for (let i = 0; i < rawCalls.length; i += 1) {
        const name = rawCalls[i]?.function?.name;
        // Only tools that were offered: a name the model made up, or a tool that was held back, is not passed on.
        if (typeof name !== 'string' || !offered.has(name)) continue;
        toolCalls.push({ id: `oc_${i}_${Date.now()}`, name, args: normalizeArgs(rawCalls[i]?.function?.arguments) });
      }
      const answer = text.trim();
      if (answer === '' && toolCalls.length === 0) {
        throw new OllamaError('protocol', sawDone ? 'The local AI sent an empty answer. Try asking in other words.' : 'Ollama stopped without answering. Try again.');
      }
      this.note(true, true);
      log.info('local answer', { model, ms: Date.now() - started, chars: answer.length, tools: toolCalls.length, promptChars: JSON.stringify(body.messages).length });
      return { text: answer, toolCalls, local: true };
    } finally {
      clearTimeout(timer);
      clearTimeout(total);
      stopSignal?.removeEventListener('abort', onStop);
    }
  }

  private timeoutError(why: 'first' | 'quiet' | 'total'): OllamaError {
    const s = (ms: number): number => Math.round(ms / 1000);
    return new OllamaError(
      'timeout',
      why === 'first'
        ? `The local AI did not start answering within ${s(this.cfg.firstWordMs)} seconds (Ollama may still be loading the model, or this PC is busy). Try again in a moment.`
        : why === 'quiet'
          ? `The local AI went quiet in the middle of its answer (nothing for ${s(this.cfg.quietMs)} seconds). Try again.`
          : `The local AI took too long to finish (over ${s(this.cfg.totalMs)} seconds). Try a shorter question.`,
    );
  }

  private async httpError(res: Response, model: string): Promise<OllamaError> {
    const raw = await res.text().catch(() => '');
    let message = raw;
    try {
      const j = JSON.parse(raw) as { error?: unknown };
      if (typeof j.error === 'string') message = j.error;
    } catch {
      // not JSON: use the text as it is
    }
    if (res.status === 404 || /not found/i.test(message)) return this.mapError(message || 'model not found', model, res.status);
    return new OllamaError('http', `Ollama answered with an error (${res.status}): ${message.slice(0, 160) || 'no details'}`, res.status);
  }

  private mapError(message: string, model: string, status = 0): OllamaError {
    if (/not found|pull/i.test(message)) {
      this.note(true, false);
      return new OllamaError('model-missing', `The model ${model} is not installed in Ollama. Run: ollama pull ${model}`, status);
    }
    return new OllamaError('http', `Ollama could not answer: ${message.slice(0, 160)}`, status);
  }
}

function normalizeArgs(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}
