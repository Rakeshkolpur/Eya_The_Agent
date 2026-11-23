import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOREIGN_CALL_SIGNATURE, GeminiAIProvider, toGeminiMessages, withForeignCallSignatures } from '../src/main/providers/ai/GeminiAIProvider';
import type { AIChatMessage } from '../src/main/providers/ai/AIProvider';

/**
 * A step of a request is often answered by a different AI from the one before it (the chain moves on when one is resting). The function call such an AI
 * made has no Gemini thought signature, and every Gemini 3 model then answered the NEXT step with HTTP 400 "Function call is missing a thought_signature":
 * from the second step on, the best AI was never used and each step went on to the slow free models. These tests are written the way Google behaves.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const secondStep: AIChatMessage[] = [
  { role: 'system', content: 'you are eya' },
  { role: 'user', content: 'open youtube and play a song' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'play_on_youtube', args: { query: 'feel good telugu song' } }] },
  { role: 'tool', name: 'play_on_youtube', toolCallId: 'a', content: JSON.stringify({ ok: true }) },
];

type Part = { functionCall?: unknown; thoughtSignature?: string };
const modelParts = (body: unknown): Part[] => ((body as { contents: { role: string; parts: Part[] }[] }).contents.filter((c) => c.role === 'model').flatMap((c) => c.parts));

describe('withForeignCallSignatures', () => {
  const body = { contents: toGeminiMessages(secondStep).contents };

  it('gives a Gemini 3 model the stand-in signature on a call that has none', () => {
    const out = withForeignCallSignatures('gemini-3-flash-preview', body);
    expect(modelParts(out)[0]?.thoughtSignature).toBe(FOREIGN_CALL_SIGNATURE);
    // (the request that was built is not changed: the next model of the ladder starts from it)
    expect(modelParts(body)[0]?.thoughtSignature).toBeUndefined();
  });

  it('keeps a signature the model made itself', () => {
    const own = { contents: toGeminiMessages([{ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'x', args: {}, signature: 'REAL' }] }]).contents };
    expect(withForeignCallSignatures('gemini-3.8-flash', own)).toBe(own);
  });

  it('puts it on the first call of a turn only, and on every turn that needs it', () => {
    const many = {
      contents: toGeminiMessages([
        { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'x', args: {} }, { id: 'b', name: 'y', args: {} }] },
        { role: 'tool', name: 'x', content: '{}' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'z', args: {} }] },
      ]).contents,
    };
    expect(modelParts(withForeignCallSignatures('gemini-3.1-flash-lite-preview', many)).map((p) => p.thoughtSignature)).toEqual([FOREIGN_CALL_SIGNATURE, undefined, FOREIGN_CALL_SIGNATURE]);
  });

  it('leaves older models and conversations without a call alone', () => {
    expect(withForeignCallSignatures('gemini-2.5-flash', body)).toBe(body);
    const plain = { contents: toGeminiMessages([{ role: 'user', content: 'hi' }]).contents };
    expect(withForeignCallSignatures('gemini-3-flash-preview', plain)).toBe(plain);
  });
});

describe('a Gemini 3 model asked for the step after a call another AI made', () => {
  /** Google's own behaviour: a Gemini 3 model refuses a function call with no signature; any other model takes it. */
  function google(): { requests: { model: string; status: number }[] } {
    const requests: { model: string; status: number }[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const model = /models\/([^:]+):/.exec(String(input))?.[1] ?? '';
      const body = JSON.parse(String(init?.body)) as unknown;
      const missing = /^gemini-3/.test(model) && modelParts(body).some((p) => p.functionCall !== undefined && p.thoughtSignature === undefined);
      const status = missing ? 400 : 200;
      requests.push({ model, status });
      return status === 400
        ? new Response(JSON.stringify({ error: { code: 400, message: 'Function call is missing a thought_signature in functionCall parts.' } }), { status })
        : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Playing it now.' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } }), { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { requests };
  }

  it('is answered by the first Gemini 3 model, not refused and handed on', async () => {
    const seen = google();
    const provider = new GeminiAIProvider({ apiKey: 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1', models: ['gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview'], retryDelaysMs: [] });
    const out = await provider.complete(secondStep, []);
    expect(out.text).toBe('Playing it now.');
    expect(seen.requests).toEqual([{ model: 'gemini-3-flash-preview', status: 200 }]);
  });

  it('still reaches an older model with the conversation exactly as it was', async () => {
    const seen = google();
    const provider = new GeminiAIProvider({ apiKey: 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1', models: ['gemini-2.5-flash'], retryDelaysMs: [] });
    expect((await provider.complete(secondStep, [])).text).toBe('Playing it now.');
    expect(seen.requests).toEqual([{ model: 'gemini-2.5-flash', status: 200 }]);
  });
});
