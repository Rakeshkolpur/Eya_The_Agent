import { appendFileSync } from 'node:fs';
import type { AIChatMessage, AICompletion, AIProvider, AIToolSpec, CompleteOptions } from '@main/providers/ai/AIProvider';
import type { ToolRegistry } from '@main/tools/ToolRegistry';
import type { ToolArgs, ToolResult } from '@main/tools/types';
import { onTokens } from '@main/providers/ai/tokenMeter';

/**
 * For diagnosing what Eya really did with a request (testing only): when EYA_TRACE_FILE names a file, every answer the AI gave (its raw
 * words and every tool call in them) and every tool that was run (its arguments and what it returned) is written there, one JSON line each.
 * Without that variable none of this runs and nothing is written.
 */
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…[${s.length} chars]` : s);

function write(file: string, kind: string, data: Record<string, unknown>): void {
  try {
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), kind, ...data })}\n`);
  } catch {
    /* a trace that cannot be written must never stop Eya */
  }
}

export function traceFileFromEnv(): string | null {
  const file = process.env['EYA_TRACE_FILE']?.trim();
  return file !== undefined && file !== '' ? file : null;
}

/** The AI, with every request's last messages and every raw answer written to the trace. */
export function traceAI(inner: AIProvider, file: string): AIProvider {
  // (what each answer used, as it arrives: who gave it, the prompt, the answer, and how much of the prompt came from the provider's cache)
  onTokens((e) => write(file, 'usage', { ...e }));
  return {
    get name() {
      return inner.name;
    },
    isReady: () => inner.isReady(),
    ...(inner.currentModel !== undefined ? { currentModel: () => inner.currentModel?.() } : {}),
    async complete(messages: readonly AIChatMessage[], tools: readonly AIToolSpec[], options?: CompleteOptions): Promise<AICompletion> {
      const last = messages.filter((m) => m.role !== 'system').slice(-2);
      write(file, 'ai-request', {
        systemChars: String(messages[0]?.role === 'system' ? messages[0].content : '').length,
        system: clip(String(messages[0]?.role === 'system' ? messages[0].content : ''), 300),
        tools: tools.map((t) => t.name),
        // (how big what is sent is: the tool schemas, and every message after the instructions: the size is what costs tokens)
        toolChars: JSON.stringify(tools).length,
        messageChars: messages.slice(1).reduce((n, m) => n + m.content.length + JSON.stringify(m.toolCalls ?? []).length, 0),
        messages: messages.length,
        last: last.map((m) => ({ role: m.role, ...(m.name !== undefined ? { name: m.name } : {}), content: clip(m.content, 600), ...(m.toolCalls !== undefined ? { toolCalls: m.toolCalls.map((c) => ({ name: c.name, args: c.args })) } : {}) })),
      });
      const askedAt = Date.now();
      try {
        const done = await inner.complete(messages, tools, options);
        write(file, 'ai-response', { ms: Date.now() - askedAt, model: inner.currentModel?.() ?? null, text: clip(done.text, 4000), toolCalls: done.toolCalls.map((c) => ({ name: c.name, args: c.args })), ...(done.blocked !== undefined ? { blocked: done.blocked } : {}) });
        return done;
      } catch (err) {
        write(file, 'ai-error', { ms: Date.now() - askedAt, error: clip(err instanceof Error ? err.message : String(err), 600) });
        throw err;
      }
    },
  };
}

/** Every tool run, with what it was given and what it returned, written to the trace. */
export function traceTools(registry: ToolRegistry, file: string): void {
  const run = registry.invoke.bind(registry);
  registry.invoke = async (name: string, args: ToolArgs, options?: { readonly lenient?: boolean }): Promise<ToolResult> => {
    write(file, 'tool-call', { name, args: clip(JSON.stringify(args) ?? '', 1500) });
    const startedAt = Date.now();
    const result = await run(name, args, options);
    write(file, 'tool-result', { name, ms: Date.now() - startedAt, ok: result.ok, summary: clip(result.summary ?? '', 300), ...(result.error !== undefined ? { error: clip(result.error, 800) } : {}), ...(result.data !== undefined ? { data: clip(JSON.stringify(result.data) ?? '', 600) } : {}) });
    return result;
  };
}

/** Anything else worth writing down (what the application's own browser step did, where a failure came from). Does nothing without EYA_TRACE_FILE. */
export function traceEvent(kind: string, data: Record<string, unknown>): void {
  const file = traceFileFromEnv();
  if (file !== null) write(file, kind, data);
}

/** What the person asked and how it was taken in (the mode the window sent). */
export function traceRequest(file: string, text: string, mode: string | undefined): void {
  write(file, 'request', { text, mode: mode ?? null });
}
