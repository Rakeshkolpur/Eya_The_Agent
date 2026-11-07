import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LocalAiDeclinedError, OllamaAIProvider, OllamaError } from '../src/main/providers/ai/OllamaAIProvider';
import { LOCAL_CORE_TOOLS, LOCAL_SYSTEM, compactForLocal, needsStrongerAI } from '../src/main/providers/ai/localPrompt';
import { ChainedAIProvider } from '../src/main/providers/ai/ChainedAIProvider';
import { NotConfiguredError } from '../src/main/providers/ai/failure';
import type { AIChatMessage, AICompletion, AIProvider, AIToolSpec } from '../src/main/providers/ai/AIProvider';
import { describeLocalAi, isModelName, modelInstalled } from '../src/shared/localAi';
import { describeAIFailure } from '../src/main/agent/AgentEngine';

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => void;
interface Fake {
  readonly url: string;
  readonly requests: Array<{ path: string; body: any }>;
  close(): Promise<void>;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r(undefined)); })));
});

/** A pretend Ollama on a free port: it records what it was asked and answers as the test says. */
async function fakeOllama(handler: Handler): Promise<Fake> {
  const requests: Fake['requests'] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      let body: any = null;
      try { body = raw === '' ? null : JSON.parse(raw); } catch { body = raw; }
      requests.push({ path: req.url ?? '', body });
      handler(req, res, body);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: async () => undefined };
}

const nd = (res: ServerResponse, ...chunks: unknown[]): void => { for (const c of chunks) res.write(`${JSON.stringify(c)}\n`); };
const say = (text: string) => ({ model: 'llama3.2:1b', message: { role: 'assistant', content: text }, done: false });
const done = { model: 'llama3.2:1b', message: { role: 'assistant', content: '' }, done: true };
const streamed = (...parts: string[]): Handler => (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  nd(res, ...parts.map(say), done);
  res.end();
};

const user = (content: string): AIChatMessage => ({ role: 'user', content });
const tool = (name: string): AIToolSpec => ({ name, description: `${name}. ${'It does a lot of things. '.repeat(30)}`, parameters: { type: 'object', properties: { name: { type: 'string', description: 'x'.repeat(300) } } } });

function provider(url: string, extra: Record<string, unknown> = {}): OllamaAIProvider {
  return new OllamaAIProvider({ baseUrl: url, model: () => 'llama3.2:1b', firstWordMs: 3000, quietMs: 3000, totalMs: 8000, ...extra });
}

describe('Local AI (Ollama): a chat request', () => {
  it('asks the small model, with the model kept loaded and a small context, and returns what it says', async () => {
    const f = await fakeOllama(streamed('Hello', ' there', '.'));
    const r = await provider(f.url).complete([{ role: 'system', content: 'long instructions' }, user('hi eya')], []);
    // (`local`: the answer is marked as the small local model's, so a task that can tell holds it to a firmer standard)
    expect(r).toEqual({ text: 'Hello there.', toolCalls: [], local: true });
    const body = f.requests[0]?.body;
    expect(f.requests[0]?.path).toBe('/api/chat');
    expect(body).toMatchObject({ model: 'llama3.2:1b', stream: true, keep_alive: '30m', options: { num_ctx: 2048, num_predict: 400 } });
    expect(body.options.num_thread).toBeGreaterThanOrEqual(1); // half of the PC's, so the window stays smooth
    expect(body.tools).toBeUndefined();
  });

  it('shows the answer as it is written (the text so far, growing)', async () => {
    const f = await fakeOllama(streamed('One', ' two', ' three'));
    const seen: string[] = [];
    await provider(f.url).complete([user('count')], [], { onPartial: (t) => seen.push(t) });
    expect(seen).toEqual(['One', 'One two', 'One two three']);
  });

  it('reads an answer that arrives split anywhere, even in the middle of a line', async () => {
    const f = await fakeOllama((_req, res) => {
      res.writeHead(200);
      const all = `${JSON.stringify(say('Split'))}\n${JSON.stringify(say(' answer'))}\n${JSON.stringify(done)}\n`;
      res.write(all.slice(0, 20));
      setTimeout(() => { res.write(all.slice(20, 70)); setTimeout(() => { res.write(all.slice(70)); res.end(); }, 20); }, 20);
    });
    expect((await provider(f.url).complete([user('x')], [])).text).toBe('Split answer');
  });

  it('keeps the conversation: earlier lines go with the new question, so a follow-up is understood', async () => {
    const f = await fakeOllama(streamed('Rakesh.'));
    const messages: AIChatMessage[] = [
      { role: 'system', content: 'THE LONG INSTRUCTIONS OF THE CLOUD AI '.repeat(200) },
      user('my name is Rakesh'),
      { role: 'assistant', content: 'Nice to meet you, Rakesh.' },
      user('what is my name?'),
    ];
    await provider(f.url).complete(messages, []);
    const sent = f.requests[0]?.body.messages as Array<{ role: string; content: string }>;
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent[1]?.content).toBe('my name is Rakesh');
    expect(sent[3]?.content).toBe('what is my name?');
    // the long instructions made for the cloud AIs are not sent: a short one is
    expect(sent[0]?.content.startsWith(LOCAL_SYSTEM)).toBe(true);
    expect(sent[0]?.content).toMatch(/\nNow: .*\d{4}/); // the date and time, for "what day is it"
    expect(JSON.stringify(sent).length).toBeLessThan(1100);
  });

  it('keeps only the last few earlier lines, each cut short, and leaves out old tool traffic', () => {
    const many: AIChatMessage[] = [{ role: 'system', content: 's' }];
    for (let i = 0; i < 10; i++) many.push(user(`question ${i} ${'x'.repeat(2000)}`), { role: 'assistant', content: `answer ${i}` });
    many.push({ role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'open_application', args: {} }] }, { role: 'tool', content: 'ok', name: 'open_application' });
    many.push(user('the new question'));
    const p = compactForLocal(many, []);
    const roles = p.messages.map((m) => m.role);
    expect(roles[0]).toBe('system');
    expect(roles.filter((r) => r !== 'system')).toHaveLength(7); // six earlier lines and the new question
    expect(roles.includes('tool')).toBe(false);
    expect(p.messages[p.messages.length - 1]?.content).toBe('the new question');
    expect(Math.max(...p.messages.slice(1, -1).map((m) => m.content.length))).toBeLessThanOrEqual(500);
  });

  it('says which language to answer in', async () => {
    const f = await fakeOllama(streamed('ok'));
    await provider(f.url, { languageRule: () => 'Language: always answer in English.' }).complete([user('hello')], []);
    expect(f.requests[0]?.body.messages[0].content).toContain('Language: always answer in English.');
  });
});

describe('Local AI (Ollama): tools, and what the model is allowed to do', () => {
  const everything = [...LOCAL_CORE_TOOLS, 'delete_file', 'shutdown_computer', 'word_write', 'empty_recycle_bin'].map(tool);

  it('offers only the safe everyday tools, shortened, and only for a request that asks for something to be done', async () => {
    const f = await fakeOllama(streamed('ok'));
    const p = provider(f.url);
    await p.complete([user('what is the capital of France?')], everything);
    expect(f.requests[0]?.body.tools).toBeUndefined(); // a question: no tools, a shorter prompt
    await p.complete([user('open notepad')], everything);
    const names = (f.requests[1]?.body.tools as Array<{ function: { name: string; description: string } }>).map((t) => t.function.name);
    expect(names.sort()).toEqual([...LOCAL_CORE_TOOLS].sort());
    for (const danger of ['delete_file', 'shutdown_computer', 'empty_recycle_bin', 'word_write']) expect(names).not.toContain(danger);
    expect((f.requests[1]?.body.tools[0] as { function: { description: string } }).function.description.length).toBeLessThanOrEqual(110);
  });

  it('keeps the tools while the model is finishing a tool it asked for', () => {
    const msgs: AIChatMessage[] = [
      user('what is in my downloads'),
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'find_folder', args: { name: 'downloads' } }] },
      { role: 'tool', content: '{"ok":true}', name: 'find_folder' },
    ];
    expect(compactForLocal(msgs, everything).tools.map((t) => t.name)).toContain('find_folder');
  });

  it('passes on a tool call it proposed, to Eya\'s own checked tools; a made-up or held-back tool is dropped', async () => {
    const f = await fakeOllama((_req, res) => {
      res.writeHead(200);
      nd(res, {
        message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'open_application', arguments: { name: 'notepad' } } }, { function: { name: 'delete_file', arguments: { path: 'C:\\x' } } }, { function: { name: 'format_disk', arguments: {} } }] },
        done: false,
      }, done);
      res.end();
    });
    const r = await provider(f.url).complete([user('open notepad')], everything);
    expect(r.toolCalls.map((c) => c.name)).toEqual(['open_application']);
    expect(r.toolCalls[0]?.args).toEqual({ name: 'notepad' });
  });

  it('reads tool arguments sent as a string', async () => {
    const f = await fakeOllama((_req, res) => {
      res.writeHead(200);
      nd(res, { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'open_website', arguments: '{"url":"https://example.com"}' } }] }, done: false }, done);
      res.end();
    });
    const r = await provider(f.url).complete([user('open example')], everything);
    expect(r.toolCalls[0]?.args).toEqual({ url: 'https://example.com' });
  });
});

describe('Local AI (Ollama): when it cannot answer', () => {
  it('Ollama not running: says so, and how to start it', async () => {
    const f = await fakeOllama(streamed('x'));
    const dead = f.url.replace(/:\d+$/, ':1'); // nothing listens there
    const p = provider(dead);
    const err = await p.complete([user('hi')], []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OllamaError);
    expect((err as OllamaError).kind).toBe('not-running');
    expect((err as OllamaError).userMessage).toMatch(/not running/);
    expect((err as OllamaError).userMessage).toMatch(/ollama serve/);
    expect(p.isReady()).toBe(false);
    expect(describeAIFailure(err)).toBe((err as OllamaError).userMessage); // the person is told exactly this
  });

  it('model not installed (HTTP 404): names the model and the command to get it', async () => {
    const f = await fakeOllama((_req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'model "llama3.2:1b" not found, try pulling it first' })); });
    const err = (await provider(f.url).complete([user('hi')], []).catch((e: unknown) => e)) as OllamaError;
    expect(err.kind).toBe('model-missing');
    expect(err.userMessage).toContain('llama3.2:1b is not installed');
    expect(err.userMessage).toContain('ollama pull llama3.2:1b');
  });

  it('model not installed (an error inside the stream) is told the same way', async () => {
    const f = await fakeOllama((_req, res) => { res.writeHead(200); nd(res, { error: "model 'llama3.2:1b' not found" }); res.end(); });
    const err = (await provider(f.url).complete([user('hi')], []).catch((e: unknown) => e)) as OllamaError;
    expect(err.kind).toBe('model-missing');
  });

  it('other HTTP errors carry their status (so the chain knows how long to leave it alone)', async () => {
    const f = await fakeOllama((_req, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'out of memory' })); });
    const err = (await provider(f.url).complete([user('hi')], []).catch((e: unknown) => e)) as OllamaError;
    expect(err.kind).toBe('http');
    expect(err.status).toBe(500);
    expect(err.userMessage).toContain('out of memory');
  });

  it('timeout: nothing comes back at all', async () => {
    const f = await fakeOllama(() => undefined); // never answers
    const t0 = Date.now();
    const err = (await provider(f.url, { firstWordMs: 250 }).complete([user('hi')], []).catch((e: unknown) => e)) as OllamaError;
    expect(err.kind).toBe('timeout');
    expect(err.userMessage).toMatch(/did not start answering/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('timeout: the answer starts and then goes quiet', async () => {
    const f = await fakeOllama((_req, res) => { res.writeHead(200); nd(res, say('Half an ans')); /* then silence */ });
    const err = (await provider(f.url, { quietMs: 250 }).complete([user('hi')], []).catch((e: unknown) => e)) as OllamaError;
    expect(err.kind).toBe('timeout');
    expect(err.userMessage).toMatch(/went quiet/);
  });

  it('timeout: an answer that never ends is cut off', async () => {
    const f = await fakeOllama((_req, res) => { res.writeHead(200); const t = setInterval(() => nd(res, say('and on ')), 40); res.on('close', () => clearInterval(t)); });
    const err = (await provider(f.url, { totalMs: 400 }).complete([user('hi')], []).catch((e: unknown) => e)) as OllamaError;
    expect(err.kind).toBe('timeout');
    expect(err.userMessage).toMatch(/took too long/);
  });

  it('malformed response: something that is not JSON', async () => {
    const f = await fakeOllama((_req, res) => { res.writeHead(200); res.write('this is not json\n'); res.end(); });
    const err = (await provider(f.url).complete([user('hi')], []).catch((e: unknown) => e)) as OllamaError;
    expect(err.kind).toBe('protocol');
  });

  it('a stream that stops without finishing still gives what was written; with nothing written it is an error; an empty answer is an error', async () => {
    const half = await fakeOllama((_req, res) => { res.writeHead(200); nd(res, say('Partly')); res.end(); });
    expect((await provider(half.url).complete([user('hi')], [])).text).toBe('Partly');
    const none = await fakeOllama((_req, res) => { res.writeHead(200); res.end(); });
    expect(((await provider(none.url).complete([user('hi')], []).catch((e: unknown) => e)) as OllamaError).kind).toBe('protocol');
    const empty = await fakeOllama((_req, res) => { res.writeHead(200); nd(res, done); res.end(); });
    const err = (await provider(empty.url).complete([user('hi')], []).catch((e: unknown) => e)) as OllamaError;
    expect(err.kind).toBe('protocol');
    expect(err.userMessage).toMatch(/empty answer/);
  });

  it('the local AI is ready again as soon as it answers', async () => {
    const f = await fakeOllama(streamed('ok'));
    const p = provider(f.url);
    expect(p.isReady()).toBe(false); // not looked at yet
    await p.complete([user('hi')], []);
    expect(p.isReady()).toBe(true);
  });
});

describe('Local AI (Ollama): too much for the small model', () => {
  it('judges from the words alone', () => {
    expect(needsStrongerAI('hello, how are you?')).toBe(false);
    expect(needsStrongerAI('open notepad')).toBe(false);
    expect(needsStrongerAI('what is the capital of France?')).toBe(false);
    expect(needsStrongerAI('research the latest cause list rules and summarize them')).toBe(true);
    expect(needsStrongerAI('send a message on whatsapp to Amma')).toBe(true);
    expect(needsStrongerAI('draft a petition for bail')).toBe(true);
    expect(needsStrongerAI('x'.repeat(2000))).toBe(true);
  });

  it('hands such a request to the other AI (without counting a failure) while one is ready and the person has not chosen "only"', async () => {
    const f = await fakeOllama(streamed('answered locally'));
    const p = provider(f.url);
    const err = await p.complete([user('research the rules and summarize them')], [], { failFast: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalAiDeclinedError);
    expect(err).toBeInstanceOf(NotConfiguredError); // the chain skips it without resting it
    expect(f.requests).toHaveLength(0);
    // nothing else ready (no failFast): it answers as well as it can
    expect((await p.complete([user('research the rules and summarize them')], [])).text).toBe('answered locally');
    // "Local AI only": it answers, even with another AI ready
    const only = provider(f.url, { mayHandOver: () => false });
    expect((await only.complete([user('research the rules and summarize them')], [], { failFast: true })).text).toBe('answered locally');
  });
});

describe('Local AI (Ollama): a task in progress is not carried on by the small model', () => {
  const tool: AIToolSpec = { name: 'click_on_page', description: 'click', parameters: { type: 'object', properties: {} } };
  const midTask: AIChatMessage[] = [
    user('login flipkart and order a phone'),
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'fill_on_page', args: { label: 'Search', value: 'phone' } }] },
    { role: 'tool', name: 'fill_on_page', toolCallId: 'c1', content: '{"ok":true}' },
  ];

  it('declines with a plain sentence for the person (it used to answer "I cannot access the account", end the task, and take 30 s a step)', async () => {
    const f = await fakeOllama(streamed('I cannot access the user account'));
    const err = await provider(f.url).complete(midTask, [tool]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalAiDeclinedError);
    expect((err as LocalAiDeclinedError).userMessage).toMatch(/cloud AI did not answer in time/);
    expect(f.requests).toHaveLength(0);
  });

  it('"login flipkart and order …" with the browser tools asked for is declined at the FIRST step too (it answered "a website that may be illegal or harmful" after 40 s)', async () => {
    const f = await fakeOllama(streamed('I cannot assist with this request as it may be illegal'));
    const spec = (name: string): AIToolSpec => ({ name, description: name, parameters: { type: 'object', properties: {} } });
    const browserTools: AIToolSpec[] = [spec('click_on_page'), spec('fill_on_page'), spec('open_website')];
    const err = await provider(f.url).complete([user('login flipkart and order POCO M7 Pro 5G 6GB 128GB')], browserTools).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalAiDeclinedError);
    expect((err as LocalAiDeclinedError).userMessage).toMatch(/small local AI cannot work a website/);
    expect(f.requests).toHaveLength(0);
    // a plain open, the same tools: the small model may do that; no browser-work tools asked: nothing to decline; "local only": answered
    expect((await provider(f.url).complete([user('open youtube')], browserTools)).text).toContain('cannot assist');
    expect((await provider(f.url).complete([user('login flipkart and order a phone')], [spec('open_website')])).text).toContain('cannot assist');
    expect((await provider(f.url, { mayHandOver: () => false }).complete([user('login flipkart and order a phone')], browserTools)).text).toContain('cannot assist');
  });

  it('but a plain chat, and a request with no tool results yet, are still answered locally; and "local only" is honoured', async () => {
    const f = await fakeOllama(streamed('fine'));
    expect((await provider(f.url).complete([user('hello there')], [tool])).text).toBe('fine');
    expect((await provider(f.url).complete(midTask, [])).text).toBe('fine');
    expect((await provider(f.url, { mayHandOver: () => false }).complete(midTask, [tool])).text).toBe('fine');
  });

  it('in the chain: the cloud AI own error is the one reported; with nothing else asked, the plain sentence is', async () => {
    const f = await fakeOllama(streamed('should not be used'));
    const cloud: AIProvider = { name: 'gemini', isReady: () => true, complete: async () => Promise.reject(new Error('This operation was aborted')) } as unknown as AIProvider;
    const local = provider(f.url);
    const both = new ChainedAIProvider([cloud, Object.assign(local, { name: 'ollama' }) as unknown as AIProvider]);
    await expect(both.complete(midTask, [tool])).rejects.toThrow(/aborted/);
    const alone = new ChainedAIProvider([Object.assign(provider(f.url), { name: 'ollama' }) as unknown as AIProvider]);
    await expect(alone.complete(midTask, [tool])).rejects.toThrow(/cloud AI did not answer in time/);
    expect(f.requests).toHaveLength(0);
  });
});

describe('Local AI (Ollama): looking at it, and loading the model', () => {
  const tags = (names: string[]): Handler => (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: names.map((name) => ({ name })) })); };

  it('says connected when it is running and has the model', async () => {
    const f = await fakeOllama(tags(['llama3.2:1b', 'qwen3:1.7b']));
    const s = await provider(f.url).status();
    expect(s).toMatchObject({ state: 'connected', model: 'llama3.2:1b', models: ['llama3.2:1b', 'qwen3:1.7b'], fix: null });
  });

  it('says the model is missing when Ollama is running without it', async () => {
    const f = await fakeOllama(tags(['qwen3:1.7b']));
    const p = provider(f.url);
    const s = await p.status();
    expect(s.state).toBe('model-missing');
    expect(s.fix).toBe('Run: ollama pull llama3.2:1b');
    expect(p.isReady()).toBe(false);
  });

  it('says it is not running when nothing answers', async () => {
    const f = await fakeOllama(tags([]));
    const s = await provider(f.url.replace(/:\d+$/, ':1')).status();
    expect(s.state).toBe('not-running');
    expect(s.fix).toMatch(/ollama serve/);
  });

  it('tells whoever is listening when it comes and goes', async () => {
    let up = true;
    const f = await fakeOllama((req, res, body) => (up ? tags(['llama3.2:1b'])(req, res, body) : res.destroy()));
    const p = provider(f.url);
    let changes = 0;
    p.onChange(() => changes++);
    await p.status();
    expect(p.isReady()).toBe(true);
    up = false;
    await p.status();
    expect(p.isReady()).toBe(false);
    expect(changes).toBe(2);
  });

  it('loads the model once ahead of the first question, with the same context size as a chat (or Ollama would load it again)', async () => {
    const f = await fakeOllama((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    const p = provider(f.url);
    await p.warm();
    await p.warm();
    const warms = f.requests.filter((r) => r.path === '/api/generate');
    expect(warms).toHaveLength(1);
    expect(warms[0]?.body).toMatchObject({ model: 'llama3.2:1b', keep_alive: '30m', options: { num_ctx: 2048 } });
    expect(warms[0]?.body.options.num_thread).toBe(f.requests.length > 0 ? warms[0]?.body.options.num_thread : 0);
  });

  it('a model change is a new model to load', async () => {
    const f = await fakeOllama((_req, res) => { res.writeHead(200); res.end('{}'); });
    let model = 'llama3.2:1b';
    const p = provider(f.url, { model: () => model });
    await p.warm();
    model = 'qwen3:1.7b';
    await p.warm();
    expect(f.requests.filter((r) => r.path === '/api/generate').map((r) => r.body.model)).toEqual(['llama3.2:1b', 'qwen3:1.7b']);
  });
});

describe('Local AI in the chain of AIs', () => {
  class Scripted implements AIProvider {
    calls = 0;
    constructor(readonly name: string, private readonly reply: AICompletion | Error, private readonly ready = true) {}
    isReady(): boolean { return this.ready; }
    async complete(): Promise<AICompletion> { this.calls++; if (this.reply instanceof Error) throw this.reply; return this.reply; }
  }
  const said = (text: string): AICompletion => ({ text, toolCalls: [] });

  it('"Local AI only" asks nobody else, even when the local AI fails', async () => {
    const cloud = new Scripted('gemini', said('cloud'));
    const local = new Scripted('ollama', new OllamaError('not-running', 'Ollama is not running (x). Open the Ollama app, or run: ollama serve'));
    const chain = new ChainedAIProvider([cloud, local]);
    chain.restrictTo(local);
    const err = await chain.complete([user('hi')], []).catch((e: unknown) => e);
    expect((err as OllamaError).kind).toBe('not-running');
    expect(cloud.calls).toBe(0);
    chain.restrictTo(null);
    expect((await chain.complete([user('hi')], [])).text).toBe('cloud');
  });

  it('"Local AI first" asks it first and falls to the cloud AI when it cannot answer', async () => {
    const cloud = new Scripted('gemini', said('cloud'));
    const local = new Scripted('ollama', said('local'));
    const chain = new ChainedAIProvider([cloud, local]);
    chain.setPreferred(local);
    expect((await chain.complete([user('hi')], [])).text).toBe('local');
    expect(cloud.calls).toBe(0);
    const broken = new Scripted('ollama', new OllamaError('not-running', 'Ollama is not running'));
    const chain2 = new ChainedAIProvider([cloud, broken]);
    chain2.setPreferred(broken);
    expect((await chain2.complete([user('hi')], [])).text).toBe('cloud');
  });

  it('a request handed over by the local AI goes to the cloud AI and the local AI is not rested', async () => {
    const cloud = new Scripted('gemini', said('cloud'));
    const local = new Scripted('ollama', new LocalAiDeclinedError());
    const chain = new ChainedAIProvider([cloud, local]);
    chain.setPreferred(local);
    expect((await chain.complete([user('research this')], [])).text).toBe('cloud');
    expect(chain.route().find((e) => e.name === 'ollama')?.restingUntil).toBeUndefined();
  });

  it('passes the "answer so far" callback on to the provider that is answering', async () => {
    let got: ((t: string) => void) | undefined;
    const spy: AIProvider = { name: 'ollama', isReady: () => true, async complete(_m, _t, o) { got = o?.onPartial; o?.onPartial?.('so far'); return { text: 'so far', toolCalls: [] }; } };
    const chain = new ChainedAIProvider([spy]);
    const seen: string[] = [];
    await chain.complete([user('hi')], [], { onPartial: (t) => seen.push(t) });
    expect(got).toBeDefined();
    expect(seen).toEqual(['so far']);
  });
});

describe('Local AI: names and status words', () => {
  it('knows whether a model is installed ("llama3.2" is "llama3.2:latest")', () => {
    expect(modelInstalled(['llama3.2:1b'], 'llama3.2:1b')).toBe(true);
    expect(modelInstalled(['llama3.2:latest'], 'llama3.2')).toBe(true);
    expect(modelInstalled(['llama3.2:3b'], 'llama3.2:1b')).toBe(false);
    expect(modelInstalled([], 'llama3.2:1b')).toBe(false);
  });

  it('only passes on something that looks like a model name', () => {
    expect(isModelName('llama3.2:1b')).toBe(true);
    expect(isModelName('library/qwen3:1.7b')).toBe(true);
    for (const bad of ['', ' ', 'a b', 'x;rm -rf', '../x', 12, null, 'a'.repeat(100)]) expect(isModelName(bad)).toBe(false);
  });

  it('describes the three states, with what to do', () => {
    expect(describeLocalAi({ running: false, installed: [], model: 'llama3.2:1b' }).fix).toMatch(/Ollama app/);
    expect(describeLocalAi({ running: true, installed: ['qwen3:1.7b'], model: 'llama3.2:1b' })).toMatchObject({ state: 'model-missing', fix: 'Run: ollama pull llama3.2:1b' });
    expect(describeLocalAi({ running: true, installed: ['llama3.2:1b'], model: 'llama3.2:1b' })).toMatchObject({ state: 'connected', fix: null });
  });
});

describe('Local AI (Ollama): a structured task (a drafted chat reply, answered as one JSON object)', () => {
  const schema = { type: 'object', properties: { for_owner: { type: 'string' }, reply: { type: 'string' } }, required: ['for_owner', 'reply'] };
  const local: AIChatMessage[] = [{ role: 'system', content: 'You are Eya. Answer with JSON only.' }, user('Them: hi')];

  it('keeps the task\'s own instructions (the generic prompt used to REPLACE them, so no JSON ever came back) and holds the answer to the shape asked for', async () => {
    const f = await fakeOllama(streamed('{"for_owner": "", "reply": "Hi!"}'));
    const r = await provider(f.url).complete([{ role: 'system', content: 'THE LONG CLOUD PROMPT '.repeat(50) }, user('the long cloud user message')], [], { structured: { schema, local } });
    const body = f.requests[0]?.body;
    expect(body.messages).toEqual(local); // (exactly what the task wrote for the small model: not LOCAL_SYSTEM, not clipped, not the cloud prompt)
    expect(body.messages[0].content).not.toBe(LOCAL_SYSTEM);
    expect(body.format).toEqual(schema);
    expect(body.tools).toBeUndefined();
    expect(r).toEqual({ text: '{"for_owner": "", "reply": "Hi!"}', toolCalls: [], local: true });
  });

  it('without `local` messages it sends the task\'s own messages as they are (still not replaced)', async () => {
    const f = await fakeOllama(streamed('{"reply": "ok"}'));
    const own: AIChatMessage[] = [{ role: 'system', content: 'Own instructions' }, user('Own question')];
    await provider(f.url).complete(own, [], { structured: { schema } });
    expect(f.requests[0]?.body.messages).toEqual(own);
    expect(f.requests[0]?.body.format).toEqual(schema);
  });

  it('an ordinary request still gets the short generic prompt and no `format`', async () => {
    const f = await fakeOllama(streamed('Hello'));
    await provider(f.url).complete([{ role: 'system', content: 'long instructions' }, user('hi eya')], []);
    expect(f.requests[0]?.body.messages[0].content).toContain(LOCAL_SYSTEM);
    expect(f.requests[0]?.body.format).toBeUndefined();
  });

  it('the other person\'s words (an email, a purchase) do not make the local model hand a structured task over to a cloud AI; an ordinary request with the same words still is', async () => {
    const f = await fakeOllama(streamed('{"reply": "ok"}'));
    const words = [user('Them: please email the report and buy the tickets on whatsapp')];
    await expect(provider(f.url).complete(words, [], { failFast: true, structured: { schema } })).resolves.toMatchObject({ local: true });
    await expect(provider(f.url).complete(words, [], { failFast: true })).rejects.toBeInstanceOf(LocalAiDeclinedError);
  });

  it('the chain passes the structured task on to the provider that answers — also to the next one after a failure (the local AI needs it)', async () => {
    const seen: unknown[] = [];
    const task = { schema, local };
    const failing: AIProvider = { name: 'gemini', isReady: () => true, complete: async (_m, _t, o) => { seen.push(o?.structured); throw new Error('boom'); } };
    const second: AIProvider = { name: 'ollama', isReady: () => true, complete: async (_m, _t, o): Promise<AICompletion> => { seen.push(o?.structured); return { text: 'x', toolCalls: [] }; } };
    await new ChainedAIProvider([failing, second]).complete([user('x')], [], { structured: task });
    expect(seen).toEqual([task, task]);
    // (and a request that is not a structured task is passed on as before: nothing added)
    let plain: unknown = 'unset';
    const only: AIProvider = { name: 'only', isReady: () => true, complete: async (_m, _t, o): Promise<AICompletion> => { plain = o; return { text: 'x', toolCalls: [] }; } };
    await new ChainedAIProvider([only]).complete([user('x')], []);
    expect(plain).toBeUndefined();
  });
});
