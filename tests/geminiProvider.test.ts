import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GeminiAIProvider, retryDelayFor, toGeminiMessages } from '../src/main/providers/ai/GeminiAIProvider';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env['EYA_GEMINI_API_KEY'] = 'test-key';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env['EYA_GEMINI_API_KEY'];
});

describe('GeminiAIProvider', () => {
  beforeEach(() => {
    process.env['EYA_GEMINI_API_KEY'] = 'test-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env['EYA_GEMINI_API_KEY'];
  });

  it('parses a text-only response', async () => {
    globalThis.fetch = vi.fn(async () => makeResponse({
      candidates: [{ content: { parts: [{ text: 'Hello there!' }] } }],
    })) as unknown as typeof fetch;

    const provider = new GeminiAIProvider();
    const result = await provider.complete(
      [{ role: 'user', content: 'hi' }],
      [],
    );
    expect(result.text).toBe('Hello there!');
    expect(result.toolCalls).toHaveLength(0);
  });

  it('parses a function-call response', async () => {
    globalThis.fetch = vi.fn(async () => makeResponse({
      candidates: [{
        content: {
          parts: [{ functionCall: { name: 'open_application', args: { name: 'chrome' } } }],
        },
      }],
    })) as unknown as typeof fetch;

    const provider = new GeminiAIProvider();
    const result = await provider.complete(
      [{ role: 'user', content: 'open chrome' }],
      [
        {
          name: 'open_application',
          description: 'open app',
          parameters: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
      ],
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe('open_application');
    expect(result.toolCalls[0]?.args['name']).toBe('chrome');
  });

  it('falls back to the next model when the first is rate-limited', async () => {
    process.env['EYA_GEMINI_TRANSCRIBE_MODEL'] = 'model-a';
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('model-a')) return new Response('quota', { status: 429 });
      return makeResponse({ candidates: [{ content: { parts: [{ text: 'open notepad' }] } }] });
    }) as unknown as typeof fetch;

    const provider = new GeminiAIProvider();
    const text = await provider.transcribe('AAAA', 'audio/wav');
    expect(text).toBe('open notepad');
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('model-a');
    expect(urls[1]).toContain('gemini-3.6-flash');
    delete process.env['EYA_GEMINI_TRANSCRIBE_MODEL'];
  });

  it('skips a model that just failed instead of paying for it again', async () => {
    process.env['EYA_GEMINI_TRANSCRIBE_MODEL'] = 'model-a';
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('model-a')) return new Response('quota', { status: 429 });
      return makeResponse({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] });
    }) as unknown as typeof fetch;

    const provider = new GeminiAIProvider();
    await provider.transcribe('AAAA', 'audio/wav');
    urls.length = 0;
    await provider.transcribe('AAAA', 'audio/wav');
    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toContain('model-a');
    delete process.env['EYA_GEMINI_TRANSCRIBE_MODEL'];
  });

  it('throws without an API key', async () => {
    delete process.env['EYA_GEMINI_API_KEY'];
    const provider = new GeminiAIProvider();
    await expect(provider.complete([{ role: 'user', content: 'x' }], [])).rejects.toThrow(
      /API key/i,
    );
  });

  it('surfaces API errors so ChainedAIProvider can fall through', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('quota exceeded', { status: 429 }),
    ) as unknown as typeof fetch;

    const provider = new GeminiAIProvider();
    await expect(provider.complete([{ role: 'user', content: 'x' }], [])).rejects.toThrow(
      /429/,
    );
  });
});

describe('multi-step message format', () => {
  it('replays the model turn and groups results into one user turn, by function name', () => {
    const { contents } = toGeminiMessages([
      { role: 'user', content: 'find and read my pdf' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', name: 'find_file', args: { extension: 'pdf' }, signature: 'SIG1' },
          { id: 'b', name: 'web_search', args: { query: 'x' } },
        ],
      },
      { role: 'tool', name: 'find_file', toolCallId: 'a', content: JSON.stringify({ ok: true, data: { n: 1 } }) },
      { role: 'tool', name: 'web_search', toolCallId: 'b', content: JSON.stringify({ ok: true }) },
    ]);

    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    const model = contents[1];
    expect(model?.parts).toEqual([
      { functionCall: { name: 'find_file', args: { extension: 'pdf' } }, thoughtSignature: 'SIG1' },
      { functionCall: { name: 'web_search', args: { query: 'x' } } },
    ]);
    const results = contents[2]?.parts ?? [];
    expect(results.map((p) => p.functionResponse?.name)).toEqual(['find_file', 'web_search']);
    expect(results[0]?.functionResponse?.response).toEqual({ ok: true, data: { n: 1 } });
  });

  it('wraps a non-object result so Gemini gets the object it requires', () => {
    const { contents } = toGeminiMessages([
      { role: 'tool', name: 't', content: '[1,2]' },
      { role: 'tool', name: 'u', content: 'plain text' },
    ]);
    const parts = contents[0]?.parts ?? [];
    expect(parts[0]?.functionResponse?.response).toEqual({ result: [1, 2] });
    expect(parts[1]?.functionResponse?.response).toEqual({ result: 'plain text' });
  });

  it('keeps text alongside calls and skips empty assistant turns', () => {
    const { contents } = toGeminiMessages([
      { role: 'assistant', content: 'On it.', toolCalls: [{ id: 'a', name: 'x', args: {} }] },
      { role: 'assistant', content: '   ' },
    ]);
    expect(contents).toHaveLength(1);
    expect(contents[0]?.parts[0]).toEqual({ text: 'On it.' });
  });

  it('reads tool calls and their signature out of a response', async () => {
    globalThis.fetch = vi.fn(async () => makeResponse({
      candidates: [{ content: { parts: [{ functionCall: { name: 'find_file', args: { extension: 'pdf' } }, thoughtSignature: 'SIG9' }] } }],
    })) as unknown as typeof fetch;
    const result = await new GeminiAIProvider().complete([{ role: 'user', content: 'x' }], []);
    expect(result.toolCalls[0]?.signature).toBe('SIG9');
    expect(result.toolCalls[0]?.args).toEqual({ extension: 'pdf' });
  });
});

describe('racing a slow model', () => {
  it('uses the next model when the first is slow, and abandons the slow one', async () => {
    process.env['EYA_GEMINI_TRANSCRIBE_MODEL'] = 'slow-model';
    let slowAborted = false;
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('slow-model')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            slowAborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }
      return makeResponse({ candidates: [{ content: { parts: [{ text: 'open notepad' }] } }] });
    }) as unknown as typeof fetch;

    const started = Date.now();
    const text = await new GeminiAIProvider({ transcribeHedgeMs: 40 }).transcribe('AAAA', 'audio/wav');
    expect(text).toBe('open notepad');
    expect(Date.now() - started).toBeLessThan(1500); // did not wait out the slow model
    expect(urls[0]).toContain('slow-model');
    expect(urls[1]).toContain('gemini-3.6-flash');
    expect(slowAborted).toBe(true);
    delete process.env['EYA_GEMINI_TRANSCRIBE_MODEL'];
  });

  it('keeps the first answer if it arrives before the hedge delay', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return makeResponse({ candidates: [{ content: { parts: [{ text: 'fast' }] } }] });
    }) as unknown as typeof fetch;
    expect(await new GeminiAIProvider({ transcribeHedgeMs: 500 }).transcribe('AAAA', 'audio/wav')).toBe('fast');
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1);
  });

  it('a hedged loser that fails does not poison the result or cool down the winner', async () => {
    process.env['EYA_GEMINI_TRANSCRIBE_MODEL'] = 'slow-model';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('slow-model')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      return makeResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    }) as unknown as typeof fetch;
    const provider = new GeminiAIProvider({ transcribeHedgeMs: 20 });
    expect(await provider.transcribe('AAAA', 'audio/wav')).toBe('ok');
    // The aborted model must not have been marked as failing.
    expect(await provider.transcribe('AAAA', 'audio/wav')).toBe('ok');
    delete process.env['EYA_GEMINI_TRANSCRIBE_MODEL'];
  });
});

describe('transient failures', () => {
  const ok = (text = 'fine') => makeResponse({ candidates: [{ content: { parts: [{ text }] } }] });
  // Pinned to three models so the expected call counts don't depend on how many fallbacks exist.
  const fast = { retryDelaysMs: [5, 5], models: ['m1', 'm2', 'm3'] };

  it('tries again shortly when every model is overloaded, then succeeds', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return calls <= 3 ? new Response('high demand', { status: 503 }) : ok('recovered');
    }) as unknown as typeof fetch;
    const result = await new GeminiAIProvider(fast).complete([{ role: 'user', content: 'x' }], []);
    expect(result.text).toBe('recovered');
    expect(calls).toBe(4); // three models failed, then the retry round worked
  });

  it('retries a retryable model even though it was just put on cool-down', async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return urls.length <= 3 ? new Response('busy', { status: 503 }) : ok();
    }) as unknown as typeof fetch;
    await new GeminiAIProvider(fast).complete([{ role: 'user', content: 'x' }], []);
    expect(urls[3]).toBe(urls[0]); // round two starts with the primary again
  });

  it("waits out a short rate limit using Google's own hint", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls <= 3) {
        return new Response(JSON.stringify({ error: { code: 429, details: [{ retryDelay: '0.05s' }] } }), { status: 429 });
      }
      return ok('after the wait');
    }) as unknown as typeof fetch;
    const started = Date.now();
    const result = await new GeminiAIProvider(fast).complete([{ role: 'user', content: 'x' }], []);
    expect(result.text).toBe('after the wait');
    expect(Date.now() - started).toBeGreaterThanOrEqual(200); // hint + margin
  });

  it('does not wait on a rate limit with no short hint (a quota, not a blip)', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response('quota exceeded', { status: 429 });
    }) as unknown as typeof fetch;
    await expect(new GeminiAIProvider(fast).complete([{ role: 'user', content: 'x' }], [])).rejects.toThrow(/429/);
    expect(calls).toBe(3); // each model once, no further rounds
  });

  it('gives up after the allowed retries and reports the primary error', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls += 1;
      // The primary is overloaded; the backups are gone. The primary's is the real story.
      return String(input).includes('/m1:')
        ? new Response('primary overloaded', { status: 503 })
        : new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    await expect(new GeminiAIProvider(fast).complete([{ role: 'user', content: 'x' }], [])).rejects.toThrow(/503/);
    // Round one tries all three; the two retries skip the retired ones and re-ask only the primary.
    expect(calls).toBe(5);
  });

  it('retries a dropped connection but never a bad request', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls <= 3) throw new TypeError('fetch failed');
      return ok('back online');
    }) as unknown as typeof fetch;
    expect((await new GeminiAIProvider(fast).complete([{ role: 'user', content: 'x' }], [])).text).toBe('back online');

    calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response('bad request', { status: 400 });
    }) as unknown as typeof fetch;
    await expect(new GeminiAIProvider(fast).complete([{ role: 'user', content: 'x' }], [])).rejects.toThrow(/400/);
    expect(calls).toBe(3);
  });
});

describe('the free tier daily limit', () => {
  const dailyBody = JSON.stringify({
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          violations: [{ quotaMetric: 'generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
          retryDelay: '45s',
        },
      ],
    },
  });

  it('recognizes it, says so, and does not wait a minute for something that resets tomorrow', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response(dailyBody, { status: 429 });
    }) as unknown as typeof fetch;
    const started = Date.now();
    await expect(new GeminiAIProvider({ retryDelaysMs: [5, 5], models: ['m1', 'm2', 'm3'] }).complete([{ role: 'user', content: 'x' }], [])).rejects.toThrow(/daily quota/);
    expect(calls).toBe(3); // every model once, then no waiting rounds
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('stops calling models whose day is spent, and fails instantly once all are', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response(dailyBody, { status: 429 });
    }) as unknown as typeof fetch;
    const provider = new GeminiAIProvider({ retryDelaysMs: [5, 5], models: ['m1', 'm2', 'm3'] });
    await expect(provider.complete([{ role: 'user', content: 'x' }], [])).rejects.toThrow(/daily quota/);
    calls = 0;
    await expect(provider.complete([{ role: 'user', content: 'x' }], [])).rejects.toThrow(/daily quota/);
    expect(calls).toBe(0); // no request was even sent
  });

  it('keeps using the models that still have quota', async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (String(input).includes('gemini-3.8-flash:')) return new Response(dailyBody, { status: 429 });
      return makeResponse({ candidates: [{ content: { parts: [{ text: 'still works' }] } }] });
    }) as unknown as typeof fetch;
    const provider = new GeminiAIProvider();
    expect((await provider.complete([{ role: 'user', content: 'x' }], [])).text).toBe('still works');
    urls.length = 0;
    await provider.complete([{ role: 'user', content: 'x' }], []);
    expect(urls.some((u) => u.includes('gemini-3.8-flash:'))).toBe(false);
  });
});

describe('retryDelayFor', () => {
  it('only retries what waiting can fix', () => {
    expect(retryDelayFor(new TypeError('fetch failed'), 0)).toBe(1200);
    expect(retryDelayFor(new TypeError('fetch failed'), 1)).toBe(2500);
    expect(retryDelayFor(new TypeError('fetch failed'), 2)).toBeNull(); // out of retries
    expect(retryDelayFor(new Error('something else'), 0)).toBeNull();
  });
});

describe('documents and web search', () => {
  it('sends a document with the question and returns the text', async () => {
    let body: { contents: { parts: Array<Record<string, unknown>> }[] } | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return makeResponse({ candidates: [{ content: { parts: [{ text: 'It is case 42.' }] } }] });
    }) as unknown as typeof fetch;
    const answer = await new GeminiAIProvider().analyzeFile('QUJD', 'application/pdf', 'What case?');
    expect(answer).toBe('It is case 42.');
    const parts = body?.contents[0]?.parts ?? [];
    expect(parts[0]).toEqual({ inline_data: { mime_type: 'application/pdf', data: 'QUJD' } });
    expect(parts[1]).toEqual({ text: 'What case?' });
  });

  it('asks for Google Search grounding and returns unique sources', async () => {
    let body: { tools?: unknown } | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return makeResponse({
        candidates: [
          {
            content: { parts: [{ text: 'The hearing moved.' }] },
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: 'https://a.example', title: 'A' } },
                { web: { uri: 'https://a.example', title: 'A again' } },
                { web: { uri: 'https://b.example' } },
                {},
              ],
            },
          },
        ],
      });
    }) as unknown as typeof fetch;
    const result = await new GeminiAIProvider().groundedSearch('latest order');
    expect(body?.tools).toEqual([{ google_search: {} }]);
    expect(result.text).toBe('The hearing moved.');
    expect(result.sources).toEqual([
      { title: 'A', uri: 'https://a.example' },
      { title: 'https://b.example', uri: 'https://b.example' },
    ]);
  });
});

function makeResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('when every model is limited: the error says the real best case', () => {
  type LimitError = Error & { retryAfterMs?: number; dailyQuota?: boolean };
  const complete = async (provider: GeminiAIProvider): Promise<LimitError> => {
    try {
      await provider.complete([{ role: 'user', content: 'x' }], []);
    } catch (e) {
      return e as LimitError;
    }
    throw new Error('expected the call to fail');
  };
  const perMinute = (seconds: number) =>
    new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${seconds}s` }] } }), { status: 429 });
  // Like the real API's: the daily cap's answer also says how long to wait (measured: 26755 s, ending at midnight UTC).
  const daily = (seconds = 26755) =>
    new Response(
      JSON.stringify({ error: { code: 429, details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${seconds}s` }] } }),
      { status: 429 },
    );
  const unnamed = () => new Response('You exceeded your current quota, please check your plan and billing details.', { status: 429 });
  const opts = { retryDelaysMs: [5, 5], models: ['m1', 'm2', 'm3'] };

  it('the first model is out for the day but the others only need a moment: it says how long, not "tomorrow"', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => (String(input).includes('/m1:') ? daily() : perMinute(40))) as unknown as typeof fetch;
    const err = await complete(new GeminiAIProvider(opts));
    expect(err.message).not.toMatch(/daily quota/);
    expect(err.dailyQuota).toBe(false);
    expect(err.retryAfterMs).toBeGreaterThan(38_000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(40_000);
  });

  it('uses the soonest any model will be back', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      return u.includes('/m1:') ? perMinute(55) : u.includes('/m2:') ? perMinute(20) : perMinute(90);
    }) as unknown as typeof fetch;
    const err = await complete(new GeminiAIProvider(opts));
    expect(err.retryAfterMs).toBeGreaterThan(18_000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(20_000);
  });

  it('with no wait named by Google, says so (nothing invented)', async () => {
    globalThis.fetch = vi.fn(async () => unnamed()) as unknown as typeof fetch;
    const err = await complete(new GeminiAIProvider(opts));
    expect(err.message).toMatch(/429/);
    expect(err.retryAfterMs).toBeUndefined();
    expect(err.dailyQuota).toBe(false);
  });

  it('every model out for the day: the daily error, flagged, and an instant answer next time', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return daily();
    }) as unknown as typeof fetch;
    const provider = new GeminiAIProvider(opts);
    const err = await complete(provider);
    expect(err.message).toMatch(/daily quota exhausted/);
    expect(err.dailyQuota).toBe(true);
    calls = 0;
    const again = await complete(provider);
    expect(again.message).toMatch(/daily quota exhausted/);
    expect(calls).toBe(0);
  });

  it('the daily error carries the wait Google gave — the soonest any model is back — even on the instant repeat answer', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      return u.includes('/m1:') ? daily(26755) : u.includes('/m2:') ? daily(20000) : daily(26000);
    }) as unknown as typeof fetch;
    const provider = new GeminiAIProvider(opts);
    const first = await complete(provider);
    expect(first.dailyQuota).toBe(true);
    expect(first.retryAfterMs).toBeGreaterThan(19_000_000);
    expect(first.retryAfterMs).toBeLessThanOrEqual(20_000_000);
    const again = await complete(provider); // no request is sent now, and it still knows
    expect(again.dailyQuota).toBe(true);
    expect(again.retryAfterMs).toBeGreaterThan(19_000_000);
    expect(again.retryAfterMs).toBeLessThanOrEqual(first.retryAfterMs as number);
  });

  it('a daily limit that Google names no wait for gives the daily error with no wait (nothing invented)', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('{"error":{"code":429,"details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}', { status: 429 }),
    ) as unknown as typeof fetch;
    const err = await complete(new GeminiAIProvider(opts));
    expect(err.dailyQuota).toBe(true);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('a model that is merely overloaded is not reported as a limit: the first model\'s own error stands', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => (String(input).includes('/m1:') ? new Response('overloaded', { status: 503 }) : perMinute(30))) as unknown as typeof fetch;
    const err = await complete(new GeminiAIProvider(opts));
    expect(err.message).toMatch(/503/);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('the wording the user hears follows from it', async () => {
    const { describeAIFailure } = await import('../src/main/agent/AgentEngine');
    const now = new Date('2026-10-02T15:00:00Z');
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => (String(input).includes('/m1:') ? daily() : perMinute(40))) as unknown as typeof fetch;
    expect(describeAIFailure(await complete(new GeminiAIProvider(opts)), now)).toMatch(/Try again in about \d+ seconds/);
    globalThis.fetch = vi.fn(async () => daily()) as unknown as typeof fetch;
    expect(describeAIFailure(await complete(new GeminiAIProvider(opts)), now)).toMatch(/comes back at .+ (today|tomorrow)/);
  });
});
