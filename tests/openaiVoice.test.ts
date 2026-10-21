import { describe, it, expect } from 'vitest';
import { OpenAITTS, OpenAITTSError, SampleAligner } from '../src/main/providers/tts/OpenAITTS';
import { CLASSIC_OPENAI_VOICES, DEFAULT_OPENAI_VOICE, OPENAI_VOICES, isOpenAIVoice, voiceForClassicModel } from '../src/shared/openaiVoice';

/** A response whose body arrives in the given pieces (so a 16-bit sample can arrive split in two). */
function audioResponse(pieces: number[][], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(new Uint8Array(p));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'audio/pcm' } });
}

const text = (body: string, status: number): Response => new Response(body, { status });

interface Call {
  readonly url: string;
  readonly auth: string;
  readonly body: Record<string, unknown>;
  readonly signal: AbortSignal | null | undefined;
}

/** A request that never answers (as a stalled connection), but ends when it is aborted, as a real fetch does. */
const stalls = (call: Call): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    call.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });

function make(handler: (call: Call, n: number) => Response | Promise<Response>, key: string | null = 'sk-test-0123456789abcdef') {
  const calls: Call[] = [];
  const tts = new OpenAITTS({
    getKey: () => key,
    config: {
      firstChunkTimeoutMs: 400,
      totalTimeoutMs: 3000,
      fetchFn: (async (url: unknown, init?: RequestInit) => {
        const call: Call = {
          url: String(url),
          auth: String((init?.headers as Record<string, string>)['authorization']),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          signal: init?.signal,
        };
        calls.push(call);
        return handler(call, calls.length);
      }) as typeof fetch,
    },
  });
  return { tts, calls };
}

const collect = async (tts: OpenAITTS, t = 'Hello there', voice = 'coral', signal = new AbortController().signal) => {
  const chunks: Uint8Array[] = [];
  const result = await tts.stream(t, voice, (pcm) => chunks.push(pcm), signal);
  return { chunks, result };
};

describe('OpenAI voices', () => {
  it('lists the voices, knows which exist, and maps a new voice to the nearest one the older model has', () => {
    expect(OPENAI_VOICES.map((v) => v.id)).toContain(DEFAULT_OPENAI_VOICE);
    expect(isOpenAIVoice('coral')).toBe(true);
    expect(isOpenAIVoice('Kore')).toBe(false); // a Gemini voice
    expect(voiceForClassicModel('nova')).toBe('nova');
    expect(CLASSIC_OPENAI_VOICES).toContain(voiceForClassicModel('coral'));
    expect(CLASSIC_OPENAI_VOICES).toContain(voiceForClassicModel('verse'));
    expect(voiceForClassicModel('something-new')).toBe('alloy');
  });
});

describe('SampleAligner', () => {
  it('hands on whole 16-bit samples only, joining a sample that arrives split', () => {
    const a = new SampleAligner();
    expect(Array.from(a.push(new Uint8Array([1, 2, 3])) ?? [])).toEqual([1, 2]);
    // the spare byte (3) comes first in the next piece
    expect(Array.from(a.push(new Uint8Array([4, 5, 6])) ?? [])).toEqual([3, 4, 5, 6]);
    expect(a.push(new Uint8Array([7]))).toBeNull(); // a single byte is held
    expect(Array.from(a.push(new Uint8Array([8])) ?? [])).toEqual([7, 8]);
  });
});

describe('OpenAITTS', () => {
  it('asks for raw 24 kHz PCM with the chosen voice and a tone, using the key, and hands the audio on as it arrives', async () => {
    const { tts, calls } = make(() => audioResponse([[1, 2, 3, 4], [5, 6], [7, 8, 9, 10]]));
    const { chunks, result } = await collect(tts);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(calls[0]?.auth).toBe('Bearer sk-test-0123456789abcdef');
    expect(calls[0]?.body).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'coral', input: 'Hello there', response_format: 'pcm' });
    expect(String(calls[0]?.body['instructions'])).toMatch(/warm/);
    expect(chunks.every((c) => c.length % 2 === 0)).toBe(true);
    expect(chunks.reduce((n, c) => n + c.length, 0)).toBe(10);
    expect(result).toMatchObject({ model: 'gpt-4o-mini-tts', bytes: 10 });
  });

  it('a sample split between two pieces is never handed on in halves', async () => {
    const { tts } = make(() => audioResponse([[1, 2, 3], [4, 5, 6, 7], [8]]));
    const { chunks } = await collect(tts);
    expect(chunks.every((c) => c.length % 2 === 0)).toBe(true);
    expect(chunks.flatMap((c) => Array.from(c))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('falls back to the older model (with a voice it has, and no tone) when the newer one is not available to the account', async () => {
    const { tts, calls } = make((call) => (call.body['model'] === 'gpt-4o-mini-tts' ? text('{"error":{"message":"model not found"}}', 404) : audioResponse([[1, 2, 3, 4]])));
    const { result } = await collect(tts, 'Hi', 'coral');
    expect(calls.map((c) => c.body['model'])).toEqual(['gpt-4o-mini-tts', 'tts-1']);
    expect(calls[1]?.body['voice']).toBe('nova'); // coral does not exist on tts-1
    expect(calls[1]?.body).not.toHaveProperty('instructions');
    expect(result.model).toBe('tts-1');
    // and the model that is not available is left alone for the next phrase
    await collect(tts, 'Again', 'coral');
    expect(calls.map((c) => c.body['model']).slice(2)).toEqual(['tts-1']);
  });

  it('a refused key (401) stops at once: no other model would say different', async () => {
    const { tts, calls } = make(() => text('{"error":{"message":"Incorrect API key provided"}}', 401));
    await expect(collect(tts)).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
  });

  it('an account with no credit stops at once, and is not asked again for a few minutes (the voice falls back without a wait)', async () => {
    const empty = '{"error":{"message":"You have no credits remaining. Add credits to continue using the API.","type":"insufficient_quota","code":"credit_balance_exhausted"}}';
    const { tts, calls } = make(() => text(empty, 429));
    await expect(collect(tts)).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(1); // not the older model as well: it is the same account
    await expect(collect(tts)).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(1); // and not asked at all the second time
  });

  it('a plain rate limit is not taken for an empty account: the older model is still tried', async () => {
    const { tts, calls } = make((_c, n) => (n === 1 ? text('{"error":{"message":"Rate limit reached for requests per minute"}}', 429) : audioResponse([[1, 2, 3, 4]])));
    const out = await collect(tts);
    expect(out.result.model).toBe('tts-1');
    expect(calls).toHaveLength(2);
  });

  it('no key is said plainly and asks nothing', async () => {
    const { tts, calls } = make(() => audioResponse([[1, 2]]), null);
    expect(tts.hasKey()).toBe(false);
    await expect(collect(tts)).rejects.toBeInstanceOf(OpenAITTSError);
    expect(calls).toHaveLength(0);
  });

  it('a model that sends nothing in time is given up on for the next', async () => {
    const { tts, calls } = make((call) => (call.body['model'] === 'gpt-4o-mini-tts' ? stalls(call) : audioResponse([[1, 2, 3, 4]])));
    const { result } = await collect(tts);
    expect(result.model).toBe('tts-1');
    expect(calls).toHaveLength(2);
  });

  it('does not switch to another model after audio has started playing', async () => {
    let n = 0;
    const { tts, calls } = make(() => {
      n += 1;
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        // (An error raised at once would discard the audio queued before it, so the drop comes on the second read.)
        pull(controller) {
          pulls += 1;
          if (pulls === 1) controller.enqueue(new Uint8Array([1, 2, 3, 4]));
          else controller.error(new Error('connection dropped'));
        },
      });
      return new Response(stream, { status: 200 });
    });
    const heard: number[] = [];
    await expect(tts.stream('x', 'coral', (p) => heard.push(p.length), new AbortController().signal)).rejects.toBeTruthy();
    expect(n).toBe(1);
    expect(calls).toHaveLength(1);
    expect(heard).toEqual([4]);
  });

  it('is cancelled by the caller', async () => {
    const controller = new AbortController();
    const { tts } = make((call) => stalls(call));
    const promise = tts.stream('x', 'coral', () => undefined, controller.signal);
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await expect(promise).rejects.toBeTruthy();
  });
});
