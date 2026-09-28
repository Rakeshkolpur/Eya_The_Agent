import { rootLogger } from '@main/logging/logger';
import type {
  AIChatMessage,
  AICompletion,
  AIProvider,
  AIToolCall,
  AIToolSpec,
} from './AIProvider';

const log = rootLogger.child('ai.ollama');

export interface OllamaConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly keepAlive: string;
}

const DEFAULT_CONFIG: OllamaConfig = {
  baseUrl: 'http://127.0.0.1:11434',
  model: 'llama3.1',
  timeoutMs: 30_000,
  keepAlive: '15m',
};

interface OllamaToolCall {
  readonly function?: { readonly name?: string; readonly arguments?: unknown };
}

interface OllamaResponse {
  readonly message?: {
    readonly role?: string;
    readonly content?: string;
    readonly tool_calls?: readonly OllamaToolCall[];
  };
  readonly done?: boolean;
  readonly error?: string;
}

/**
 * Ollama chat provider. Talks to a local Ollama server (default port 11434).
 * Handles tool-calling via Ollama's OpenAI-compatible tool schema. Model can
 * be overridden with EYA_OLLAMA_MODEL. Default llama3.1 — for DeepSeek R1
 * set EYA_OLLAMA_MODEL=deepseek-r1:7b.
 */
export class OllamaAIProvider implements AIProvider {
  readonly name = 'ollama';
  private readonly cfg: OllamaConfig;
  private cachedAvailability: boolean | null = null;

  constructor(overrides?: Partial<OllamaConfig>) {
    this.cfg = {
      ...DEFAULT_CONFIG,
      baseUrl: process.env['EYA_OLLAMA_URL'] ?? DEFAULT_CONFIG.baseUrl,
      model: process.env['EYA_OLLAMA_MODEL'] ?? DEFAULT_CONFIG.model,
      ...overrides,
    };
  }

  isReady(): boolean {
    return this.cachedAvailability === true;
  }

  async checkAvailability(): Promise<boolean> {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`${this.cfg.baseUrl}/api/tags`, {
        signal: controller.signal,
      });
      this.cachedAvailability = res.ok;
      if (res.ok) log.info('ollama available', { model: this.cfg.model });
      else log.warn('ollama not available', { status: res.status });
      return res.ok;
    } catch (err) {
      log.warn('ollama unreachable', { err: String(err) });
      this.cachedAvailability = false;
      return false;
    } finally {
      clearTimeout(to);
    }
  }

  async complete(
    messages: readonly AIChatMessage[],
    tools: readonly AIToolSpec[],
  ): Promise<AICompletion> {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    const body = {
      model: this.cfg.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls !== undefined && m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                function: { name: c.name, arguments: c.args },
              })),
            }
          : {}),
        ...(m.role === 'tool' && m.name !== undefined ? { tool_name: m.name } : {}),
      })),
      stream: false,
      keep_alive: this.cfg.keepAlive,
      tools:
        tools.length === 0
          ? undefined
          : tools.map((t) => ({
              type: 'function',
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            })),
      options: {
        temperature: 0.2,
        num_predict: 256,
      },
    };

    try {
      const res = await fetch(`${this.cfg.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`ollama chat http ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as OllamaResponse;
      if (data.error !== undefined) throw new Error(data.error);

      const text = data.message?.content?.trim() ?? '';
      const rawCalls = data.message?.tool_calls ?? [];
      const toolCalls: AIToolCall[] = [];
      for (let i = 0; i < rawCalls.length; i += 1) {
        const call = rawCalls[i];
        const name = call?.function?.name;
        if (typeof name !== 'string' || name.length === 0) continue;
        const args = normalizeArgs(call?.function?.arguments);
        toolCalls.push({ id: `oc_${i}_${Date.now()}`, name, args });
      }

      log.debug('ollama completion', { textLen: text.length, tools: toolCalls.length });
      return { text, toolCalls };
    } finally {
      clearTimeout(to);
    }
  }
}

function normalizeArgs(raw: unknown): Readonly<Record<string, unknown>> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}
