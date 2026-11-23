import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { recordTokens, summarize, tokensSinceStart, withMeter } from '../src/main/providers/ai/tokenMeter';
import { GeminiAIProvider } from '../src/main/providers/ai/GeminiAIProvider';
import { OpenAICompatibleProvider } from '../src/main/providers/ai/OpenAICompatibleProvider';
import { OllamaAIProvider } from '../src/main/providers/ai/OllamaAIProvider';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { ConversationContext } from '../src/main/context/ConversationContext';
import type { AIChatMessage, AICompletion, AIProvider, AIToolSpec } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import type { Tool, ToolResult } from '../src/main/tools/types';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('the token count of a request', () => {
  it('adds up every AI answer that comes back while the request runs, and says who used them', async () => {
    const { tokens, owner } = await withMeter(async () => {
      recordTokens('gemini', { prompt: 1000, completion: 100, total: 1100 });
      await sleep(1);
      recordTokens('gemini', { prompt: 1200, completion: 50, total: 1300 }); // (a total that is more than the two: the thinking the answer needed)
      recordTokens('ollama', { prompt: 300, completion: 40 });
    });
    expect(owner).toBe(true);
    // (prompt 1000 + 1200 + 300; the answer side is whatever each total holds beyond its prompt: 100 + 100 + 40)
    expect(summarize(tokens)).toEqual({ calls: 3, prompt: 2500, completion: 240, total: 1100 + 1300 + 340 });
    expect(tokens.byProvider).toEqual({ gemini: 2400, ollama: 340 });
  });

  it('counts a service that gives only a total, ignores nothing-answers, and does nothing outside a request', async () => {
    const before = tokensSinceStart();
    recordTokens('gemini', { total: 500 }); // (no request running)
    expect(tokensSinceStart()).toBe(before + 500);
    const { tokens } = await withMeter(async () => {
      recordTokens('openai', { total: 700 });
      recordTokens('openai', {});
      recordTokens('openai', { prompt: Number.NaN, completion: -5, total: undefined });
    });
    expect(summarize(tokens)).toEqual({ calls: 1, prompt: 0, completion: 700, total: 700 });
    expect(tokensSinceStart()).toBe(before + 1200);
  });

  it('two requests at the same time never mix their counts', async () => {
    const one = withMeter(async () => {
      for (let i = 0; i < 5; i++) {
        recordTokens('gemini', { total: 10 });
        await sleep(2);
      }
    });
    const two = withMeter(async () => {
      for (let i = 0; i < 3; i++) {
        await sleep(3);
        recordTokens('gemini', { total: 1000 });
      }
    });
    const [a, b] = await Promise.all([one, two]);
    expect(a.tokens.total).toBe(50);
    expect(b.tokens.total).toBe(3000);
  });

  it('a request already being counted is joined, not counted twice (a spoken one is transcribed first, then handled as text)', async () => {
    const outer = await withMeter(async () => {
      recordTokens('gemini', { total: 100 }); // the transcribing
      const inner = await withMeter(async () => {
        recordTokens('gemini', { total: 400 }); // the answer
      });
      expect(inner.owner).toBe(false);
      return inner.tokens.total;
    });
    expect(outer.owner).toBe(true);
    expect(outer.result).toBe(500);
    expect(outer.tokens.total).toBe(500);
  });
});

describe('each provider reports what an answer used', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env['EYA_GEMINI_API_KEY'];
  });
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('Gemini: the chat, and a file read through the same service, both count', async () => {
    process.env['EYA_GEMINI_API_KEY'] = 'test-key';
    globalThis.fetch = vi.fn(async () => json({ candidates: [{ content: { parts: [{ text: 'Hello.' }] } }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 20, totalTokenCount: 900 } })) as unknown as typeof fetch;
    const provider = new GeminiAIProvider();
    const { tokens } = await withMeter(async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], []);
      await provider.analyzeFile('aGVsbG8=', 'text/plain', 'what is this?');
    });
    expect(summarize(tokens)).toEqual({ calls: 2, prompt: 1600, completion: 40 + 160, total: 1800 });
  });

  it('an OpenAI-style service: what its usage says', async () => {
    const fetchFn = (async () => json({ choices: [{ message: { content: 'Hello.' } }], usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 } })) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({ label: 'openai', baseUrl: 'https://x/v1', apiKey: 'k'.repeat(20), model: 'gpt-4o-mini', fetchFn });
    const { tokens } = await withMeter(async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], []);
    });
    expect(summarize(tokens)).toEqual({ calls: 1, prompt: 50, completion: 7, total: 57 });
    expect(tokens.byProvider).toEqual({ openai: 57 });
  });

  it('Ollama: the counts it sends with its last piece', async () => {
    const servers: Server[] = [];
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'Hi there.' }, done: false })}\n`);
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 321, eval_count: 12 })}\n`);
      res.end();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const provider = new OllamaAIProvider({ baseUrl: url, model: () => 'llama3.2:1b', firstWordMs: 3000, quietMs: 3000, totalMs: 8000 });
      const { tokens } = await withMeter(async () => {
        await provider.complete([{ role: 'user', content: 'hi' }], []);
      });
      expect(summarize(tokens)).toEqual({ calls: 1, prompt: 321, completion: 12, total: 333 });
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r(undefined)));
    }
  });
});

describe('what a request took, on the answer Eya gives', () => {
  const quietTTS: TTSProvider = { name: 'quiet', init: async () => undefined, speak: async () => undefined, prefetch: () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };

  /** An AI that reports tokens the way a real one does: each answer it gives uses some. */
  class CountingAI implements AIProvider {
    readonly name = 'counting';
    constructor(private readonly script: AICompletion[]) {}
    isReady(): boolean {
      return true;
    }
    async complete(_messages: readonly AIChatMessage[], _tools: readonly AIToolSpec[]): Promise<AICompletion> {
      recordTokens('counting', { prompt: 1000, completion: 50 });
      const next = this.script.shift();
      if (next === undefined) throw new Error('script exhausted');
      return next;
    }
  }

  // (a tool whose own work goes through the AI, like reading a file: its tokens belong to the request too)
  const readerTool: Tool = {
    schema: { name: 'analyze_document', description: 'x', args: { path: { type: 'string' } }, status: 'x' },
    execute: async (): Promise<ToolResult> => (recordTokens('counting', { prompt: 4000, completion: 200 }), { ok: true, summary: 'read' }),
  };

  function engine(script: AICompletion[]): AgentEngine {
    const tools = new ToolRegistry();
    tools.register(readerTool);
    return new AgentEngine({ router: new IntentRouter(), tools, composer: new ResponseComposer(), tts: quietTTS, context: new ConversationContext(), ai: new CountingAI(script), now: () => new Date('2026-10-24T10:00:00Z') });
  }
  const ask = (e: AgentEngine, text: string, mode: 'chat' | 'agent') => e.handle({ requestId: `r${Math.random().toString(36).slice(2, 6)}`, text, source: 'text', mode }, () => undefined);

  it('a plain chat answer: one AI answer, its tokens on the result', async () => {
    const r = await ask(engine([{ text: 'Hello there.', toolCalls: [] }]), 'Hi', 'chat');
    expect(r.tokens).toEqual({ calls: 1, prompt: 1000, completion: 50, total: 1050 });
  });

  it('an agent request that reads a file: every AI answer and the file reading, added up for the one request', async () => {
    const e = engine([{ text: '', toolCalls: [{ id: 'a', name: 'analyze_document', args: { path: 'C:/a.txt' } }] }, { text: 'It is a notice.', toolCalls: [] }]);
    const r = await ask(e, 'what does my file say', 'agent');
    expect(r.spoken).toBe('It is a notice.');
    expect(r.tokens).toEqual({ calls: 3, prompt: 1000 + 4000 + 1000, completion: 50 + 200 + 50, total: 6300 });
  });

  it('a request that needed no AI has no count, and each request has its own', async () => {
    const e = engine([{ text: 'One.', toolCalls: [] }, { text: 'Two.', toolCalls: [] }]);
    const first = await ask(e, 'Hi', 'chat');
    const second = await ask(e, 'Hello again', 'chat');
    expect(first.tokens?.total).toBe(1050);
    expect(second.tokens?.total).toBe(1050);
    const none = await ask(e, 'open the telangana cause list', 'chat'); // (chat says it is for Agent mode: no AI is asked)
    expect(none.tokens).toBeUndefined();
  });
});
