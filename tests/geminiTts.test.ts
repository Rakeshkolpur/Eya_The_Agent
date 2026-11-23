import { describe, it, expect, afterEach, vi } from 'vitest';
import { GeminiTTS, extractAudio, parseSse, stripWavHeader } from '../src/main/providers/tts/GeminiTTS';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64');
const audioEvent = (bytes: number[], mime = 'audio/l16; rate=24000; channels=1'): string =>
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: mime, data: b64(bytes) } }] } }] })}\r\n\r\n`;

function sseResponse(events: string[], delayMs = 0): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const e of events) {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(encoder.encode(e));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('parseSse', () => {
  it('splits complete events and keeps the unfinished tail', () => {
    const { payloads, rest } = parseSse('data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\ndata: {"c"');
    expect(payloads).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('data: {"c"');
  });

  it('handles an event split across reads, including a CRLF cut in half', () => {
    const first = parseSse('data: {"a":1}\r');
    expect(first.payloads).toEqual([]);
    const second = parseSse(first.rest + '\n\r\n');
    expect(second.payloads).toEqual(['{"a":1}']);
  });
});

describe('extractAudio', () => {
  it('decodes raw PCM parts', () => {
    const out = extractAudio(
      JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/l16', data: b64([1, 2, 3, 4]) } }] } }] }),
    );
    expect(out).toHaveLength(1);
    expect([...(out[0] ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it('ignores events with no audio (usage metadata, empty text)', () => {
    expect(extractAudio(JSON.stringify({ usageMetadata: { totalTokenCount: 5 } }))).toEqual([]);
    expect(extractAudio('not json')).toEqual([]);
  });

  it('throws on an in-stream API error so the caller can fall back', () => {
    expect(() => extractAudio(JSON.stringify({ error: { code: 429, message: 'quota' } }))).toThrow(/quota/);
  });

  it('strips a WAV header if a model returns a wav part', () => {
    const wav = [...Buffer.from('RIFF'), 36, 0, 0, 0, ...Buffer.from('WAVE'), ...Buffer.from('fmt '), 16, 0, 0, 0, 1, 0, 1, 0, 0xc0, 0x5d, 0, 0, 0x80, 0xbb, 0, 0, 2, 0, 16, 0, ...Buffer.from('data'), 4, 0, 0, 0, 9, 8, 7, 6];
    const out = extractAudio(
      JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: b64(wav) } }] } }] }),
    );
    expect([...(out[0] ?? [])]).toEqual([9, 8, 7, 6]);
  });
});

describe('stripWavHeader', () => {
  it('leaves plain PCM untouched', () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    expect(stripWavHeader(pcm)).toBe(pcm);
  });
});

describe('GeminiTTS.stream', () => {
  const make = (overrides = {}) =>
    new GeminiTTS({ apiKey: 'k', models: ['fast', 'backup'], firstChunkTimeoutMs: 200, totalTimeoutMs: 5000, ...overrides });

  it('streams chunks in order as they arrive', async () => {
    globalThis.fetch = vi.fn(async () => sseResponse([audioEvent([1, 1]), audioEvent([2, 2]), audioEvent([3, 3])])) as unknown as typeof fetch;
    const got: number[][] = [];
    const result = await make().stream('hi', 'Aoede', (c) => got.push([...c]), new AbortController().signal);
    expect(got).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect(result.model).toBe('fast');
    expect(result.bytes).toBe(6);
  });

  it('falls back to the next model when the first errors before any audio', async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (String(input).includes('/fast:')) return new Response('quota', { status: 429 });
      return sseResponse([audioEvent([5, 5])]);
    }) as unknown as typeof fetch;
    const got: number[][] = [];
    const result = await make().stream('hi', 'Aoede', (c) => got.push([...c]), new AbortController().signal);
    expect(result.model).toBe('backup');
    expect(got).toEqual([[5, 5]]);
    expect(urls).toHaveLength(2);
  });

  it('abandons a model that stalls before its first audio', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/fast:')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      return sseResponse([audioEvent([7, 7])]);
    }) as unknown as typeof fetch;
    const result = await make().stream('hi', 'Aoede', () => undefined, new AbortController().signal);
    expect(result.model).toBe('backup');
  });

  it('skips a model that just failed on the next phrase', async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (String(input).includes('/fast:')) return new Response('quota', { status: 429 });
      return sseResponse([audioEvent([1, 1])]);
    }) as unknown as typeof fetch;
    const tts = make();
    await tts.stream('one', 'Aoede', () => undefined, new AbortController().signal);
    urls.length = 0;
    await tts.stream('two', 'Aoede', () => undefined, new AbortController().signal);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/backup:');
  });

  it('does not switch voices mid-sentence after audio has started', async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return sseResponse([audioEvent([1, 1]), `data: ${JSON.stringify({ error: { code: 503, message: 'overloaded' } })}\n\n`]);
    }) as unknown as typeof fetch;
    const got: number[][] = [];
    await expect(make().stream('hi', 'Aoede', (c) => got.push([...c]), new AbortController().signal)).rejects.toThrow(/overloaded/);
    expect(got).toEqual([[1, 1]]);
    expect(urls).toHaveLength(1);
  });

  it('stops cleanly when cancelled', async () => {
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    const pending = make({ firstChunkTimeoutMs: 5000 }).stream('hi', 'Aoede', () => undefined, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  it('stops asking a voice model whose daily quota is spent, and fails instantly when all are', async () => {
    const dailyBody = JSON.stringify({
      error: { code: 429, details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] },
    });
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response(dailyBody, { status: 429 });
    }) as unknown as typeof fetch;
    const tts = make();
    await expect(tts.stream('one', 'Aoede', () => undefined, new AbortController().signal)).rejects.toThrow(/daily quota/);
    expect(calls).toBe(2); // both models tried once
    calls = 0;
    await expect(tts.stream('two', 'Aoede', () => undefined, new AbortController().signal)).rejects.toThrow(/daily quota/);
    expect(calls).toBe(0);
  });

  it('refuses without an API key', async () => {
    await expect(make({ apiKey: '' }).stream('hi', 'Aoede', () => undefined, new AbortController().signal)).rejects.toThrow(/key/i);
  });
});
