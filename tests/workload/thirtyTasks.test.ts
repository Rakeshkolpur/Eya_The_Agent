import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentEngine } from '../../src/main/agent/AgentEngine';
import { IntentRouter } from '../../src/main/agent/IntentRouter';
import { ResponseComposer } from '../../src/main/agent/ResponseComposer';
import { GeminiKeyPool } from '../../src/main/config/geminiKeyPool';
import { ConversationContext } from '../../src/main/context/ConversationContext';
import { ChainedAIProvider } from '../../src/main/providers/ai/ChainedAIProvider';
import type { ChainState } from '../../src/main/providers/ai/ChainedAIProvider';
import { GeminiAIProvider } from '../../src/main/providers/ai/GeminiAIProvider';
import { OllamaAIProvider } from '../../src/main/providers/ai/OllamaAIProvider';
import { OpenAICompatibleProvider } from '../../src/main/providers/ai/OpenAICompatibleProvider';
import type { TTSProvider } from '../../src/main/providers/tts/TTSProvider';
import type { StoreIo } from '../../src/main/privacy/communicationAccessStore';
import { TaskCompleter } from '../../src/main/tasks/TaskCompleter';
import { TaskStore } from '../../src/main/tasks/TaskStore';
import { trackRequest } from '../../src/main/tasks/trackRequest';
import { ToolRegistry } from '../../src/main/tools/ToolRegistry';
import type { Tool, ToolResult } from '../../src/main/tools/types';
import type { AgentResult } from '../../src/shared/types';

/**
 * The thirty-task workload: representative things people ask Eya, run one after another through her REAL engine (the same AgentEngine, task tracker,
 * task store, record of what was done, token counting, provider chain and key pool the app uses). Controlled, because the real world is not repeatable:
 *   - the AI services are stand-ins on this PC that answer over real HTTP, so the real Gemini, ChatGPT-style and Ollama provider classes run, and
 *     the stand-ins can be made to rate-limit, run out for the day, answer with garbage or be unreachable;
 *   - what the AI "decides" is scripted per task (the point is what Eya does with it, not how clever a model is);
 *   - the files are real, in a throwaway folder; the web and the browser are a modelled set of pages with injected slowness and failures (the real
 *     browser is exercised by the live suites in tests/live).
 * A task counts as done only when its outcome has been checked (a file on disk, a page state, a record kept), not because Eya said so.
 * The report goes to %TEMP%\eya-e2e-out\workload-report.json (or WORKLOAD_REPORT).
 */

const KEY_A = 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const KEY_B = 'AIzaSyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ============================================================================================================================ the stand-in AIs
type Part = { text: string } | { call: string; args: Record<string, unknown> };
type Mode = 'ok' | 'daily' | 'rate' | 'overloaded' | 'malformed' | 'closed';

const brain = {
  script: [] as Part[][],
  /** After this many answers have been given, every service answers with an out-of-allowance error (a provider that gives out mid-task). */
  failAfter: Infinity,
  given: 0,
  lastPrompt: '',
  next(): Part[] {
    this.given += 1;
    return this.script.shift() ?? [{ text: 'Okay.' }];
  },
  outNow(): boolean {
    return this.given >= this.failAfter;
  },
};
const modes = { gemini: new Map<string, Mode>(), openai: 'ok' as Mode, ollama: 'ok' as Mode };
const hits = { geminiA: 0, geminiB: 0, openai: 0, ollama: 0, errors: 0 };
/** What the AIs were actually sent (answered requests only), in characters: about four to a token, and the same yardstick for any version of Eya. */
const served = { chars: 0 };
const geminiMode = (key: string): Mode => (brain.outNow() ? 'daily' : modes.gemini.get(key) ?? 'ok');

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => resolve(raw));
  });
}
const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

let geminiServer: Server;
let openaiServer: Server;
let ollamaServer: Server;
const urls = { gemini: '', openai: '', ollama: '' };

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

beforeAll(async () => {
  const g = await listen(async (req, res) => {
    const raw = await readBody(req);
    const key = String(req.headers['x-goog-api-key'] ?? '');
    if (key === KEY_A) hits.geminiA += 1;
    else hits.geminiB += 1;
    const mode = geminiMode(key);
    if (mode === 'daily') {
      hits.errors += 1;
      return json(res, 429, { error: { code: 429, message: 'Quota exceeded for metric generate_content_free_tier_requests, limit: 20, GenerateRequestsPerDayPerProjectPerModel-FreeTier', status: 'RESOURCE_EXHAUSTED' } });
    }
    if (mode === 'rate') {
      hits.errors += 1;
      return json(res, 429, { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota). "retryDelay": "30s"', status: 'RESOURCE_EXHAUSTED' } });
    }
    if (mode === 'overloaded') {
      hits.errors += 1;
      return json(res, 503, { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } });
    }
    if (mode === 'malformed') {
      hits.errors += 1;
      res.writeHead(200, { 'content-type': 'text/html' });
      return void res.end('<html>502 gateway</html>');
    }
    brain.lastPrompt = raw;
    served.chars += raw.length;
    const parts = brain.next().map((p) => ('text' in p ? { text: p.text } : { functionCall: { name: p.call, args: p.args } }));
    json(res, 200, { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: Math.round(raw.length / 4), candidatesTokenCount: 20, totalTokenCount: Math.round(raw.length / 4) + 20 } });
  });
  geminiServer = g.server;
  urls.gemini = `${g.url}/v1beta`;
  const o = await listen(async (req, res) => {
    const raw = await readBody(req);
    hits.openai += 1;
    if (modes.openai === 'daily' || brain.outNow()) {
      hits.errors += 1;
      return json(res, 429, { error: { message: 'Rate limit reached for requests per day (RPD): Limit 200, Used 200.', type: 'requests', code: 'rate_limit_exceeded' } });
    }
    if (modes.openai === 'overloaded') {
      hits.errors += 1;
      return json(res, 500, { error: { message: 'The server had an error while processing your request.' } });
    }
    brain.lastPrompt = raw;
    served.chars += raw.length;
    const parts = brain.next();
    const text = parts.flatMap((p) => ('text' in p ? [p.text] : [])).join(' ');
    const calls = parts.flatMap((p, i) => ('call' in p ? [{ id: `call_${i}`, type: 'function', function: { name: p.call, arguments: JSON.stringify(p.args) } }] : []));
    json(res, 200, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text === '' ? null : text, ...(calls.length > 0 ? { tool_calls: calls } : {}) } }], usage: { prompt_tokens: Math.round(raw.length / 4), completion_tokens: 20, total_tokens: Math.round(raw.length / 4) + 20 } });
  });
  openaiServer = o.server;
  urls.openai = `${o.url}/v1`;
  const l = await listen(async (req, res) => {
    const raw = await readBody(req);
    if (!String(req.url).startsWith('/api/chat')) return json(res, 200, {});
    hits.ollama += 1;
    brain.lastPrompt = raw;
    served.chars += raw.length;
    const parts = brain.next();
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    for (const p of parts) {
      res.write(`${JSON.stringify('text' in p ? { message: { role: 'assistant', content: p.text }, done: false } : { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: p.call, arguments: p.args } }] }, done: false })}\n`);
    }
    res.write(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: Math.round(raw.length / 4), eval_count: 20 })}\n`);
    res.end();
  });
  ollamaServer = l.server;
  urls.ollama = l.url;
});

afterAll(async () => {
  for (const s of [geminiServer, openaiServer, ollamaServer]) {
    s?.closeAllConnections?.();
    await new Promise((r) => s?.close(() => r(undefined)));
  }
  rmSync(work, { recursive: true, force: true });
});

// ============================================================================================================================ the files and the web
const work = mkdtempSync(join(tmpdir(), 'eya-workload-'));
const at = (...p: string[]): string => join(work, ...p);
const toolLog: string[] = [];
const memories = new Map<string, string>();
let analyzeDelayMs = 0;
let analyzeRunning = 0;
let analyzePeak = 0;
let makeFolderDelayMs = 0;

interface Page {
  readonly title: string;
  readonly text: string;
  readonly links?: Record<string, string>;
  readonly form?: readonly string[];
}
const PAGES: Record<string, Page> = {
  'example.org': { title: 'Example Domain', text: 'This domain is for use in examples.' },
  'news.example': { title: 'Daily News', text: 'Headline: Floods ease in Hyderabad. Weather: clear.' },
  'shop.example': { title: 'Mug Shop', text: 'Red mug price 499 rupees. Blue mug price 450 rupees.' },
  'portal.example': { title: 'Court Portal', text: 'Welcome. Cause list. Orders.', links: { 'Cause list': 'portal.example/cause' } },
  'portal.example/cause': { title: 'Cause List', text: 'Page 1: WP 1234 of 2024, WP 2200 of 2024.', links: { 'Page 2': 'portal.example/cause?p=2' } },
  'portal.example/cause?p=2': { title: 'Cause List page 2', text: 'Page 2: WP 3001 of 2024.' },
  'forms.example': { title: 'Registration', text: 'Register here.', form: ['Name', 'Phone'] },
  'slow.example': { title: 'Slow Page', text: 'I took my time.' },
  'timeout.example': { title: 'Eventually Loaded', text: 'Heading: Eventually Loaded.' },
  'flaky.example': { title: 'Flaky Site', text: 'I work now.' },
};
const web = {
  current: '',
  /** Failures to hand out, in order, the next times a site is opened ("unreachable", "timeout"), and how long a site takes to answer. */
  faults: new Map<string, Array<'unreachable' | 'timeout'>>(),
  delays: new Map<string, number>(),
  fields: {} as Record<string, string>,
  submissions: [] as Array<Record<string, string>>,
};
const hostOf = (input: string): string => input.replace(/^https?:\/\//, '').replace(/\/$/, '');

function opened(host: string): ToolResult {
  const page = PAGES[host];
  if (page === undefined) return { ok: false, summary: 'could not open', error: `Nothing answered at ${host}.`, data: { navigation: { problem: 'unreachable' }, recovery: { reason: 'unreachable', notes: [] } } };
  web.current = host;
  toolLog.push(`opened ${host}`);
  return { ok: true, summary: `opened ${page.title}`, data: { currentPage: { url: `https://${host}/`, title: page.title, visibleText: page.text, links: Object.keys(page.links ?? {}) }, recovery: { via: 'known', verified: true, notes: [] } } };
}

async function openSite(args: Record<string, unknown>): Promise<ToolResult> {
  const host = hostOf(String(args['url'] ?? args['name'] ?? ''));
  const wait = web.delays.get(host);
  if (wait !== undefined) await sleep(wait);
  const fault = web.faults.get(host)?.shift();
  if (fault === 'unreachable') return { ok: false, summary: 'could not open', error: `${host} did not answer.`, data: { navigation: { problem: 'unreachable' }, recovery: { reason: 'unreachable', notes: [] } } };
  if (fault === 'timeout') return { ok: false, summary: 'stopped trying', error: `${host} took too long to load.`, data: { navigation: { problem: 'time_budget' }, recovery: { reason: 'time_budget', notes: [] } } };
  return opened(host);
}

const str = { type: 'string' as const };
function tool(name: string, args: string[], run: (a: Record<string, unknown>) => Promise<ToolResult> | ToolResult): Tool {
  return {
    schema: { name, description: name, args: Object.fromEntries(args.map((a) => [a, str])), status: `${name}…` },
    execute: async (a): Promise<ToolResult> => run(a as Record<string, unknown>),
  };
}

function buildTools(): ToolRegistry {
  const r = new ToolRegistry();
  const list: Tool[] = [
    tool('find_and_open_website', ['url', 'name', 'keywords'], (a) => openSite(a)),
    tool('open_website', ['url'], (a) => openSite(a)),
    tool('read_page', [], () => ({ ok: true, summary: 'read the page', data: { text: PAGES[web.current]?.text ?? '' } })),
    tool('click_on_page', ['text'], (a) => {
      const label = String(a['text']);
      const page = PAGES[web.current];
      if (label === 'Submit' && page?.form !== undefined) {
        web.submissions.push({ ...web.fields });
        toolLog.push('submitted the form');
        return { ok: true, summary: 'submitted', data: { currentPage: { url: `https://${web.current}/`, title: 'Thank you', visibleText: 'Registered.' } } };
      }
      const target = page?.links?.[label];
      if (target === undefined) return { ok: false, summary: 'nothing matched', error: `No link or button called "${label}" on this page.` };
      toolLog.push(`clicked ${label}`);
      return opened(target);
    }),
    tool('fill_on_page', ['label', 'value'], (a) => {
      web.fields[String(a['label'])] = String(a['value']);
      toolLog.push(`filled ${String(a['label'])}`);
      return { ok: true, summary: `filled ${String(a['label'])}` };
    }),
    tool('web_search', ['query'], (a) => ({ ok: true, summary: 'searched the web', data: { answer: String(a['query']).includes('cricket') ? 'India won the 2024 T20 World Cup, beating South Africa in the final.' : 'No clear answer.' } })),
    tool('open_application', ['name'], (a) => {
      toolLog.push(`open_application ${String(a['name'])}`);
      return { ok: true, summary: `opened ${String(a['name'])}` };
    }),
    tool('create_folder', ['path'], async (a) => {
      if (makeFolderDelayMs > 0) await sleep(makeFolderDelayMs);
      mkdirSync(at(String(a['path'])), { recursive: true });
      toolLog.push(`create_folder ${String(a['path'])}`);
      return { ok: true, summary: `made the folder ${String(a['path'])}` };
    }),
    tool('copy_file', ['from', 'to'], (a) => {
      mkdirSync(dirname(at(String(a['to']))), { recursive: true });
      copyFileSync(at(String(a['from'])), at(String(a['to'])));
      toolLog.push(`copy_file ${String(a['from'])}`);
      return { ok: true, summary: `copied ${String(a['from'])}` };
    }),
    tool('move_file', ['from', 'to'], (a) => {
      if (!existsSync(at(String(a['from'])))) return { ok: false, summary: 'not found', error: `There is no file called ${String(a['from'])}.` };
      mkdirSync(dirname(at(String(a['to']))), { recursive: true });
      renameSync(at(String(a['from'])), at(String(a['to'])));
      toolLog.push(`move_file ${String(a['from'])}`);
      return { ok: true, summary: `moved ${String(a['from'])}` };
    }),
    tool('read_file', ['path'], (a) => {
      const file = at(String(a['path']));
      return existsSync(file) ? { ok: true, summary: `read ${String(a['path'])}`, data: { text: readFileSync(file, 'utf8') } } : { ok: false, summary: 'not found', error: 'No such file.' };
    }),
    tool('find_file', ['name'], (a) => {
      const hitsFound: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          else if (entry.toLowerCase().includes(String(a['name']).toLowerCase())) hitsFound.push(full.slice(work.length + 1).split('\\').join('/'));
        }
      };
      walk(work);
      return hitsFound.length > 0 ? { ok: true, summary: `found ${hitsFound.length}`, data: { files: hitsFound } } : { ok: false, summary: 'not found', error: 'No file with that name.' };
    }),
    tool('analyze_document', ['path', 'question'], async (a) => {
      analyzeRunning += 1;
      analyzePeak = Math.max(analyzePeak, analyzeRunning);
      await sleep(analyzeDelayMs);
      analyzeRunning -= 1;
      const file = at(String(a['path']));
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      return { ok: true, summary: `read ${String(a['path'])}`, data: { text } };
    }),
    tool('download_file', ['url', 'name'], (a) => {
      const target = at(String(a['name']));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `Cause list of 12 November. First case: WP 1234 of 2024. (from ${String(a['url'])})`);
      toolLog.push(`download_file ${String(a['name'])}`);
      return { ok: true, summary: `saved ${String(a['name'])}` };
    }),
    tool('remember', ['key', 'value'], (a) => {
      memories.set(String(a['key']), String(a['value']));
      toolLog.push(`remember ${String(a['key'])}`);
      return { ok: true, summary: `remembered ${String(a['key'])}` };
    }),
    tool('list_memories', [], () => ({ ok: true, summary: `${memories.size} memories`, data: { memories: Object.fromEntries(memories) } })),
  ];
  for (const t of list) r.register(t);
  return r;
}

// ============================================================================================================================ one running Eya
function memoryIo(): StoreIo & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return { files, read: (p) => files.get(p) ?? null, write: (p, t) => void files.set(p, t) };
}
let clock = Date.now();
const quietVoice: TTSProvider = { name: 'quiet', init: async () => undefined, speak: async () => undefined, prefetch: () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };

interface World {
  readonly engine: AgentEngine;
  readonly chain: ChainedAIProvider;
  readonly completer: TaskCompleter;
  readonly store: TaskStore;
  readonly io: ReturnType<typeof memoryIo>;
  readonly tools: ToolRegistry;
}

/** A fresh Eya: her own chain of the real providers, and a task keeper over `io` (pass the same `io` to start her again after a restart). */
function startEya(options: { io?: ReturnType<typeof memoryIo>; tts?: TTSProvider; chainStore?: { saved: ChainState | null } } = {}): World {
  const io = options.io ?? memoryIo();
  const pool = new GeminiKeyPool({
    makeAi: (apiKey) => new GeminiAIProvider({ apiKey, baseUrl: urls.gemini, retryDelaysMs: [], planningTimeoutMs: 1500, timeoutMs: 1500 }),
    makeSpeech: () => ({ hasKey: () => true, stream: async () => { throw new Error('no speech in the workload'); } }),
    now: () => clock,
  });
  pool.setKeys([{ name: 'Key A', key: KEY_A, main: true }, { name: 'Key B', key: KEY_B, main: false }]);
  const backup = new OpenAICompatibleProvider({ label: 'backup1', baseUrl: urls.openai, apiKey: 'k'.repeat(24), model: 'stand-in-model' });
  const ollama = new OllamaAIProvider({ baseUrl: urls.ollama, model: () => 'llama3.2:1b', firstWordMs: 1500, quietMs: 1500, totalMs: 4000 });
  const saved = options.chainStore ?? { saved: null };
  const chain = new ChainedAIProvider([pool, backup, ollama], { now: () => clock, store: { load: () => saved.saved, save: (s) => void (saved.saved = s) } });
  const tools = buildTools();
  const store = new TaskStore('tasks.json', io);
  const worked = new Set<string>();
  let completer!: TaskCompleter;
  const engine: AgentEngine = new AgentEngine({
    router: new IntentRouter(),
    tools,
    composer: new ResponseComposer(),
    tts: options.tts ?? quietVoice,
    context: new ConversationContext(),
    ai: chain,
    tasks: { tryHandle: async () => null },
    workStarted: (id) => worked.add(id),
    checkpoint: (id, progress) => completer.checkpoint(id, progress),
    shouldStop: (id) => completer.wasStopped(id),
    around: (req, run) => trackRequest(completer, req, run, { isWork: () => worked.has(req.requestId), visibleAfterMs: 40 }),
    now: () => new Date('2026-10-24T10:00:00Z'),
  });
  completer = new TaskCompleter({
    store,
    now: () => clock,
    notify: () => undefined,
    run: (task) =>
      engine.handle({ requestId: `task-${task.id}-${task.attempts}`, text: task.request, source: 'text', resume: { steps: task.steps, note: task.note, ...(task.done !== undefined && task.done.length > 0 ? { done: task.done } : {}) } }, () => undefined),
  });
  return { engine, chain, completer, store, io, tools };
}

// ============================================================================================================================ the tasks
interface Metric {
  readonly n: number;
  readonly name: string;
  ok: boolean;
  detail: string;
  ms: number;
  aiRequests: number;
  aiErrors: number;
  tokens: number;
  /** What the AIs were sent for this task, as tokens (characters / 4). */
  readonly inputTokens: number;
  recovered: boolean;
  duplicates: number;
}
const metrics: Metric[] = [];
let counter = 0;
const tokensOf = (r: AgentResult): number => r.tokens?.total ?? 0;
const aiHits = (): number => hits.geminiA + hits.geminiB + hits.openai + hits.ollama;
const text = (...t: string[]): Part[] => t.map((x) => ({ text: x }));
const call = (name: string, args: Record<string, unknown> = {}): Part => ({ call: name, args });
let rid = 0;
const ask = (w: World, input: string, extra: Record<string, unknown> = {}): Promise<AgentResult> =>
  w.engine.handle({ requestId: `wl-${(rid += 1)}`, text: input, source: 'text', mode: 'agent', ...extra }, () => undefined);
const duplicatesIn = (): number => {
  const counts = new Map<string, number>();
  for (const line of toolLog) if (/^(create_folder|copy_file|move_file|download_file|remember) /.test(line)) counts.set(line, (counts.get(line) ?? 0) + 1);
  return [...counts.values()].reduce((n, c) => n + (c > 1 ? c - 1 : 0), 0);
};

/** Runs one task: sets it up, times it, counts what it cost, and checks the outcome. `verify` returns a plain description of what was found. */
async function task(name: string, body: (m: { recovered: () => void }) => Promise<{ result?: AgentResult; ok: boolean; detail: string }>): Promise<Metric> {
  counter += 1;
  brain.script = [];
  brain.failAfter = Infinity;
  brain.given = 0;
  const logBefore = toolLog.length;
  const hitsBefore = aiHits();
  const errorsBefore = hits.errors;
  const charsBefore = served.chars;
  let recovered = false;
  const started = performance.now();
  let outcome: { result?: AgentResult; ok: boolean; detail: string };
  try {
    outcome = await body({ recovered: () => (recovered = true) });
  } catch (err) {
    outcome = { ok: false, detail: `threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  const metric: Metric = {
    n: counter,
    name,
    ok: outcome.ok,
    detail: outcome.detail,
    ms: Math.round(performance.now() - started),
    aiRequests: aiHits() - hitsBefore,
    aiErrors: hits.errors - errorsBefore,
    tokens: outcome.result === undefined ? 0 : tokensOf(outcome.result),
    inputTokens: Math.round((served.chars - charsBefore) / 4),
    recovered,
    duplicates: 0,
  };
  void logBefore;
  metrics.push(metric);
  return metric;
}
const pass = (result: AgentResult | undefined, ok: boolean, detail: string) => ({ ...(result !== undefined ? { result } : {}), ok, detail });

describe('the thirty-task workload', () => {
  beforeAll(() => {
    writeFileSync(at('notes.txt'), 'Hearing on 12 November at 10 am.');
    writeFileSync(at('brief.txt'), 'The brief asks for an adjournment of the hearing.');
    writeFileSync(at('a.pdf'), 'pdf a');
    writeFileSync(at('f1.txt'), 'first file');
    writeFileSync(at('f2.txt'), 'second file');
    writeFileSync(at('f3.txt'), 'third file');
    memories.set('bar number', 'TS/1234/2015');
  });

  it('1. a conversational answer', async () => {
    const w = startEya();
    const m = await task('conversation', async () => {
      brain.script = [text('Hello! How can I help you today?')];
      const r = await ask(w, 'Hi', { mode: 'chat' });
      return pass(r, /Hello/.test(r.spoken), r.spoken);
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('2. opening an application (Eya\'s quick path: no AI call)', async () => {
    const w = startEya();
    const m = await task('open an application', async () => {
      const r = await ask(w, 'open notepad for me');
      return pass(r, toolLog.includes('open_application notepad') && r.spoken.length > 0, r.spoken);
    });
    expect(m.ok, m.detail).toBe(true);
    expect(m.aiRequests).toBe(0);
  });

  it('3. opening a website (Eya opens and checks it herself: no AI call)', async () => {
    const w = startEya();
    const m = await task('open a website', async () => {
      const r = await ask(w, 'Open the website example.org');
      return pass(r, r.spoken === 'I opened Example Domain.' && web.current === 'example.org', r.spoken);
    });
    expect(m.ok, m.detail).toBe(true);
    expect(m.aiRequests).toBe(0);
  });

  it('4. searching the web', async () => {
    const w = startEya();
    const m = await task('search the web', async () => {
      brain.script = [[call('web_search', { query: 'cricket world cup 2024 winner' })], text('India won the 2024 T20 World Cup.')];
      const r = await ask(w, 'who won the cricket world cup in 2024');
      return pass(r, /India/.test(r.spoken) && /South Africa/.test(brain.lastPrompt), r.spoken);
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('5. reading a webpage', async () => {
    const w = startEya();
    const m = await task('read a webpage', async () => {
      brain.script = [text('The headline says floods ease in Hyderabad.')];
      const r = await ask(w, 'open the website news.example and read me the headline');
      return pass(r, /Floods ease|floods ease/.test(r.spoken) && /Floods ease in Hyderabad/.test(brain.lastPrompt), r.spoken);
    });
    expect(m.ok, m.detail).toBe(true);
    expect(m.aiRequests).toBe(1);
  });

  it('6. extracting information from a webpage', async () => {
    const w = startEya();
    const m = await task('extract information from a page', async () => {
      brain.script = [text('The red mug costs 499 rupees.')];
      const r = await ask(w, 'open the site shop.example and tell me the price of the red mug');
      return pass(r, /499/.test(r.spoken) && /Red mug price 499/.test(brain.lastPrompt), r.spoken);
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('7. navigating through several pages, in order', async () => {
    const w = startEya();
    const m = await task('navigate several pages', async () => {
      brain.script = [[call('click_on_page', { text: 'Cause list' })], [call('click_on_page', { text: 'Page 2' })], text('I am on page 2 of the cause list.')];
      const r = await ask(w, 'open the site portal.example, go to the cause list and then to page 2');
      return pass(r, web.current === 'portal.example/cause?p=2', `ended on ${web.current}`);
    });
    expect(m.ok, m.detail).toBe(true);
    expect(toolLog.filter((l) => l.startsWith('clicked '))).toEqual(['clicked Cause list', 'clicked Page 2']);
  });

  it('8. filling in a form with test data', async () => {
    const w = startEya();
    web.submissions.length = 0;
    const m = await task('fill in a form', async () => {
      brain.script = [[call('fill_on_page', { label: 'Name', value: 'Ravi' })], [call('fill_on_page', { label: 'Phone', value: '9999999999' })], [call('click_on_page', { text: 'Submit' })], text('Registered Ravi.')];
      const r = await ask(w, 'open the site forms.example and register Ravi with phone 9999999999');
      return pass(r, web.submissions.length === 1 && web.submissions[0]?.['Name'] === 'Ravi' && web.submissions[0]?.['Phone'] === '9999999999', JSON.stringify(web.submissions));
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('9. saving a file', async () => {
    const w = startEya();
    const m = await task('save a file', async () => {
      brain.script = [[call('download_file', { url: 'https://portal.example/cause.pdf', name: 'Downloads/cause-list.pdf' })], text('Saved the cause list.')];
      const r = await ask(w, 'download the cause list pdf into my downloads');
      const file = at('Downloads', 'cause-list.pdf');
      return pass(r, existsSync(file) && statSync(file).size > 20 && /WP 1234/.test(readFileSync(file, 'utf8')), `file on disk: ${existsSync(file)}`);
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('10. reading a local file', async () => {
    const w = startEya();
    const m = await task('read a local file', async () => {
      brain.script = [[call('find_file', { name: 'notes.txt' })], [call('read_file', { path: 'notes.txt' })], text('It says the hearing is on 12 November at 10 am.')];
      const r = await ask(w, 'what does notes.txt say');
      return pass(r, /12 November/.test(r.spoken) && /Hearing on 12 November/.test(brain.lastPrompt), r.spoken);
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('11. summarising a document', async () => {
    const w = startEya();
    const m = await task('summarise a document', async () => {
      brain.script = [[call('analyze_document', { path: 'brief.txt', question: 'summary' })], text('Summary: the brief asks for an adjournment.')];
      const r = await ask(w, 'summarise this', { attachments: [{ name: 'brief.txt', path: at('brief.txt'), kind: 'document', size: 49 }] });
      return pass(r, /adjournment/.test(r.spoken) && /adjournment of the hearing/.test(brain.lastPrompt), r.spoken);
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('12. finding information in memory', async () => {
    const w = startEya();
    const m = await task('find information in memory', async () => {
      brain.script = [[call('list_memories')], text('Your bar number is TS/1234/2015.')];
      const r = await ask(w, 'what is my bar number');
      return pass(r, /TS\/1234\/2015/.test(r.spoken) && /TS\/1234\/2015/.test(brain.lastPrompt), r.spoken);
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('13. saving a memory item (once)', async () => {
    const w = startEya();
    const m = await task('save a memory item', async () => {
      brain.script = [[call('remember', { key: 'my court', value: 'Hyderabad High Court' })], text('Okay, I will remember that.')];
      const r = await ask(w, 'remember that my court is the Hyderabad High Court');
      return pass(r, memories.get('my court') === 'Hyderabad High Court' && toolLog.filter((l) => l === 'remember my court').length === 1, r.spoken);
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('14. independent reads run together', async () => {
    const w = startEya();
    analyzeDelayMs = 300;
    analyzePeak = 0;
    const m = await task('three reads at once', async () => {
      brain.script = [[call('analyze_document', { path: 'f1.txt', question: 'q' }), call('analyze_document', { path: 'f2.txt', question: 'q' }), call('analyze_document', { path: 'f3.txt', question: 'q' })], text('All three files read.')];
      const r = await ask(w, 'read these three files and tell me what they say');
      return pass(r, analyzePeak === 3 && /first file/.test(brain.lastPrompt) && /third file/.test(brain.lastPrompt), `peak ${analyzePeak} at once`);
    });
    analyzeDelayMs = 0;
    expect(m.ok, m.detail).toBe(true);
    expect(m.ms).toBeLessThan(700); // one after another: 900 and more
  });

  it('15. dependent operations, in the right order', async () => {
    const w = startEya();
    const m = await task('dependent operations', async () => {
      brain.script = [[call('create_folder', { path: 'Reports' })], [call('move_file', { from: 'a.pdf', to: 'Reports/a.pdf' })], text('Made the folder and moved the file into it.')];
      const r = await ask(w, 'make a folder called Reports and move a.pdf into it');
      const order = toolLog.filter((l) => l === 'create_folder Reports' || l === 'move_file a.pdf');
      return pass(r, existsSync(at('Reports', 'a.pdf')) && !existsSync(at('a.pdf')) && order.join() === 'create_folder Reports,move_file a.pdf', order.join());
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('16. a slow page', async () => {
    const w = startEya();
    web.delays.set('slow.example', 600);
    const m = await task('slow browser response', async () => {
      const r = await ask(w, 'open the website slow.example');
      return pass(r, r.spoken === 'I opened Slow Page.' && web.current === 'slow.example', r.spoken);
    });
    web.delays.delete('slow.example');
    expect(m.ok, m.detail).toBe(true);
    expect(m.ms).toBeGreaterThanOrEqual(550);
  });

  it('17. a navigation timeout (it is a navigation problem, and the model tries again)', async () => {
    const w = startEya();
    web.faults.set('timeout.example', ['timeout']);
    const m = await task('navigation timeout', async (t) => {
      brain.script = [[call('find_and_open_website', { url: 'https://timeout.example' })], text('The heading is Eventually Loaded.')];
      const r = await ask(w, 'open the website timeout.example and read me the heading');
      t.recovered();
      return pass(r, /Eventually Loaded/.test(r.spoken) && r.diagnosis?.[0]?.source === 'navigation' && /stopped at opening the page/.test(brain.lastPrompt), `${r.spoken} | ${JSON.stringify(r.diagnosis?.map((d) => d.source))}`);
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('18. a temporary network failure, and recovery', async () => {
    const w = startEya();
    web.faults.set('flaky.example', ['unreachable']);
    const m = await task('temporary network failure', async (t) => {
      brain.script = [[call('open_website', { url: 'https://flaky.example' })], text('It is open now.')];
      const r = await ask(w, 'open the website flaky.example');
      t.recovered();
      return pass(r, r.spoken === 'It is open now.' && web.current === 'flaky.example' && r.diagnosis?.some((d) => d.source === 'navigation') === true, r.spoken);
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('19. a Gemini rate limit: the next key answers, and the limited one is left alone', async () => {
    const w = startEya();
    modes.gemini.set(KEY_A, 'rate');
    const m = await task('Gemini rate limit', async (t) => {
      brain.script = [text('Honey never spoils.'), text('Octopuses have three hearts.')];
      const a0 = hits.geminiA;
      const first = await ask(w, 'tell me a fun fact', { mode: 'chat' });
      const aAfterFirst = hits.geminiA - a0;
      const second = await ask(w, 'and another fun fact', { mode: 'chat' });
      t.recovered();
      const aAfterSecond = hits.geminiA - a0;
      return pass(second, first.spoken.includes('Honey') && second.spoken.includes('Octopuses') && aAfterFirst >= 1 && aAfterSecond === aAfterFirst, `key A asked ${aAfterFirst} time(s) for the first, ${aAfterSecond - aAfterFirst} more for the second`);
    });
    modes.gemini.clear();
    expect(m.ok, m.detail).toBe(true);
  });

  it('20. switching to another configured provider (the exhausted one is not asked again), and a garbled answer', async () => {
    const w = startEya();
    modes.gemini.set(KEY_A, 'daily');
    modes.gemini.set(KEY_B, 'daily');
    const m = await task('switch provider', async (t) => {
      brain.script = [text('Drink water.'), text('Take a walk.')];
      const first = await ask(w, 'give me a health tip', { mode: 'chat' });
      const geminiAfterFirst = hits.geminiA + hits.geminiB;
      const openaiAfterFirst = hits.openai;
      const second = await ask(w, 'give me another health tip', { mode: 'chat' });
      t.recovered();
      const geminiAfterSecond = hits.geminiA + hits.geminiB;
      return pass(second, first.spoken.includes('Drink') && second.spoken.includes('Take a walk') && openaiAfterFirst >= 1 && geminiAfterSecond === geminiAfterFirst, `gemini asked ${geminiAfterFirst} time(s) for the first and ${geminiAfterSecond - geminiAfterFirst} for the second; backup answered both`);
    });
    expect(m.ok, m.detail).toBe(true);
    // a garbled (not JSON) answer from Gemini is a failure of that provider, not of the request
    const w2 = startEya();
    modes.gemini.set(KEY_A, 'malformed');
    modes.gemini.set(KEY_B, 'malformed');
    brain.script = [text('Answered by the backup.')];
    const garbled = await ask(w2, 'say something', { mode: 'chat' });
    modes.gemini.clear();
    expect(garbled.spoken).toContain('Answered by the backup');
  });

  // From here the tasks share one Eya, as a person's day does.
  let eya: World;
  let waiting: { id: string; state: string } | undefined;

  it('21. every provider unavailable: an honest answer at once, the request is kept, and they are not all asked again for nothing', async () => {
    eya = startEya();
    modes.gemini.set(KEY_A, 'daily');
    modes.gemini.set(KEY_B, 'daily');
    modes.openai = 'daily';
    ollamaServer.closeAllConnections();
    await new Promise((r) => ollamaServer.close(() => r(undefined)));
    modes.ollama = 'closed';
    const m = await task('all providers unavailable', async () => {
      const before = aiHits();
      const first = await ask(eya, 'create a folder called Taxes');
      const hitsFirst = aiHits() - before;
      const second = await ask(eya, 'create a folder called Taxes');
      const hitsSecond = aiHits() - before - hitsFirst;
      const items = eya.completer.snapshot().items;
      waiting = items.find((i) => i.state === 'waiting');
      return pass(first, first.pending?.kind === 'retry' && /allowance|limit|used up/i.test(first.spoken) && hitsFirst > 0 && hitsSecond === 0 && waiting !== undefined && !existsSync(at('Taxes')), `first asked the AIs ${hitsFirst} time(s), the second ${hitsSecond}; kept as: ${waiting?.state}`);
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('22. cancelling a running task: it does not go on with its steps', async () => {
    const w = startEya();
    modes.gemini.clear();
    modes.openai = 'ok';
    makeFolderDelayMs = 150;
    const m = await task('cancel a running task', async () => {
      brain.script = [[call('create_folder', { path: 'Stop1' })], [call('create_folder', { path: 'Stop2' })], [call('create_folder', { path: 'Stop3' })], text('All three made.')];
      const running = ask(w, 'make three folders called Stop1, Stop2 and Stop3');
      await sleep(90);
      const item = w.completer.snapshot().items[0];
      if (item !== undefined) w.completer.cancel(item.id);
      const r = await running;
      return pass(r, r.spoken === 'Okay, I stopped.' && !existsSync(at('Stop3')) && item !== undefined, `made: ${['Stop1', 'Stop2', 'Stop3'].filter((f) => existsSync(at(f))).join(', ') || 'none'}`);
    });
    makeFolderDelayMs = 0;
    expect(m.ok, m.detail).toBe(true);
  });

  it('23. resuming an interrupted task once an AI is back', async () => {
    expect(waiting).toBeDefined();
    modes.openai = 'ok'; // the backup is back
    const m = await task('resume an interrupted task', async (t) => {
      brain.script = [[call('create_folder', { path: 'Taxes' })], text('Created the Taxes folder.')];
      clock += 31 * 60_000; // the wait the task was told to keep has passed
      await eya.completer.tick();
      t.recovered();
      const item = eya.completer.snapshot().items.find((i) => i.id === waiting?.id);
      return pass(undefined, existsSync(at('Taxes')) && item?.state === 'done' && toolLog.filter((l) => l === 'create_folder Taxes').length === 1, `task is ${item?.state}; folder exists: ${existsSync(at('Taxes'))}`);
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('24. a retry does not repeat what was already done', async () => {
    const w = startEya();
    modes.gemini.clear();
    modes.openai = 'ok';
    const m = await task('no duplicate after a retry', async (t) => {
      // three answers are given, then every AI runs out of allowance; the model's first two steps changed things
      brain.script = [[call('create_folder', { path: 'Billing' })], [call('copy_file', { from: 'f1.txt', to: 'Billing/f1.txt' })], [call('move_file', { from: 'f2.txt', to: 'Billing/f2.txt' })], text('Billing set up.')];
      brain.failAfter = 2;
      const first = await ask(w, 'set up a Billing folder and put f1 and f2 in it');
      expect(first.pending?.kind).toBe('retry');
      // the AIs are back; the model starts over and does it all again
      brain.failAfter = Infinity;
      brain.given = 0;
      modes.gemini.clear();
      modes.openai = 'ok';
      brain.script = [[call('create_folder', { path: 'Billing' })], [call('copy_file', { from: 'f1.txt', to: 'Billing/f1.txt' })], [call('move_file', { from: 'f2.txt', to: 'Billing/f2.txt' })], text('Billing set up.')];
      clock += 31 * 60_000;
      await w.completer.tick();
      t.recovered();
      const item = w.completer.snapshot().items.find((i) => i.state === 'done');
      const count = (line: string): number => toolLog.filter((l) => l === line).length;
      return pass(first, existsSync(at('Billing', 'f1.txt')) && existsSync(at('Billing', 'f2.txt')) && item !== undefined && count('create_folder Billing') === 1 && count('copy_file f1.txt') === 1 && count('move_file f2.txt') === 1, `create_folder x${count('create_folder Billing')}, copy x${count('copy_file f1.txt')}, move x${count('move_file f2.txt')}`);
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('25. recovering from a tool failure', async () => {
    const w = startEya();
    writeFileSync(at('b.pdf'), 'pdf b');
    const m = await task('recover from a tool failure', async (t) => {
      brain.script = [[call('move_file', { from: 'missing.pdf', to: 'Reports/b.pdf' })], [call('find_file', { name: 'b.pdf' })], [call('move_file', { from: 'b.pdf', to: 'Reports/b.pdf' })], text('Moved b.pdf after finding it.')];
      const r = await ask(w, 'move b.pdf into Reports');
      t.recovered();
      return pass(r, existsSync(at('Reports', 'b.pdf')) && r.diagnosis?.some((d) => d.source === 'tool') === true, `${r.spoken} | ${JSON.stringify(r.diagnosis?.map((d) => d.source))}`);
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('26. progress survives Eya being closed and started again', async () => {
    const io = memoryIo();
    const chainStore = { saved: null as ChainState | null };
    const first = startEya({ io, chainStore });
    modes.gemini.clear();
    modes.openai = 'ok';
    const m = await task('restart in the middle of a task', async (t) => {
      brain.script = [[call('create_folder', { path: 'Archive' })], [call('copy_file', { from: 'f3.txt', to: 'Archive/f3.txt' })], text('never reached')];
      brain.failAfter = 2;
      const interrupted = await ask(first, 'archive f3 in a new folder called Archive');
      expect(interrupted.pending?.kind).toBe('retry');
      first.completer.stop(); // (closing the app writes what was still waiting)
      // --- Eya starts again, from the same files
      brain.failAfter = Infinity;
      brain.given = 0;
      brain.script = [[call('create_folder', { path: 'Archive' })], [call('copy_file', { from: 'f3.txt', to: 'Archive/f3.txt' })], text('Archived f3.')];
      const second = startEya({ io, chainStore });
      second.completer.start();
      clock += 31 * 60_000;
      await second.completer.tick();
      second.completer.stop();
      t.recovered();
      const item = second.completer.snapshot().items[0];
      const count = (line: string): number => toolLog.filter((l) => l === line).length;
      return pass(interrupted, item?.state === 'done' && existsSync(at('Archive', 'f3.txt')) && count('create_folder Archive') === 1 && count('copy_file f3.txt') === 1, `task ${item?.state}; create_folder x${count('create_folder Archive')}, copy x${count('copy_file f3.txt')}`);
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('27. the text does not wait for a slow voice', async () => {
    const spoken: string[] = [];
    const slow: TTSProvider = { ...quietVoice, speak: async (t) => { spoken.push(`start ${t}`); await sleep(900); spoken.push('end'); } };
    modes.gemini.clear();
    modes.openai = 'ok';
    const w = startEya({ tts: slow });
    const m = await task('text before the voice is finished', async () => {
      brain.script = [text('Four.')];
      const t0 = performance.now();
      const r = await ask(w, 'what is two plus two', { mode: 'chat' });
      const took = performance.now() - t0;
      return pass(r, r.spoken === 'Four.' && took < 500 && spoken.length === 1, `answer in ${Math.round(took)} ms; voice started: ${spoken.length === 1}`);
    });
    await sleep(950);
    expect(spoken).toEqual(['start Four.', 'end']);
    expect(m.ok, m.detail).toBe(true);
  });

  it('28. a complex multi-step instruction', async () => {
    const w = startEya();
    const m = await task('complex multi-step instruction', async () => {
      brain.script = [[call('create_folder', { path: 'Court' })], [call('download_file', { url: 'https://portal.example/cause.pdf', name: 'Court/cause-list.pdf' })], [call('read_file', { path: 'Court/cause-list.pdf' })], text('The first case is WP 1234 of 2024.')];
      const r = await ask(w, 'open the site portal.example, download the cause list into a new folder called Court and tell me the first case');
      return pass(r, web.current === 'portal.example' && existsSync(at('Court', 'cause-list.pdf')) && /WP 1234/.test(r.spoken), r.spoken);
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('29. a longer workflow with several tools', async () => {
    const w = startEya();
    const m = await task('longer workflow', async () => {
      brain.script = [
        [call('web_search', { query: 'cricket world cup result' })],
        [call('open_website', { url: 'https://news.example' })],
        [call('read_page')],
        [call('create_folder', { path: 'Notes' })],
        [call('download_file', { url: 'https://news.example/note.txt', name: 'Notes/result.txt' })],
        [call('copy_file', { from: 'Notes/result.txt', to: 'Notes/backup/result.txt' })],
        [call('remember', { key: 'result note', value: 'Notes/result.txt' })],
        text('Done: the result is saved in Notes, backed up, and I will remember where it is.'),
      ];
      const r = await ask(w, 'look up the cricket result, read the news site, save a note about it in a new folder called Notes, back it up and remember where it is');
      return pass(r, existsSync(at('Notes', 'result.txt')) && existsSync(at('Notes', 'backup', 'result.txt')) && memories.get('result note') === 'Notes/result.txt' && web.current === 'news.example', r.spoken);
    });
    expect(m.ok, m.detail).toBe(true);
  });

  it('30. a whole sequence: nothing from earlier is lost', async () => {
    const w = startEya();
    const m = await task('earlier results are all still there', async () => {
      brain.script = [text('Still here.')];
      const r = await ask(w, 'are you still there', { mode: 'chat' });
      const files = ['Downloads/cause-list.pdf', 'Reports/a.pdf', 'Reports/b.pdf', 'Taxes', 'Billing/f1.txt', 'Billing/f2.txt', 'Archive/f3.txt', 'Court/cause-list.pdf', 'Notes/result.txt', 'Notes/backup/result.txt'];
      const missing = files.filter((f) => !existsSync(at(f)));
      const keep = memories.get('my court') === 'Hyderabad High Court' && memories.get('result note') === 'Notes/result.txt' && memories.get('bar number') === 'TS/1234/2015';
      return pass(r, missing.length === 0 && keep && /Still here/.test(r.spoken), missing.length === 0 ? 'every file and memory from the earlier tasks is there' : `missing: ${missing.join(', ')}`);
    });
    expect(m.ok, m.detail).toBe(true);
  });

  afterAll(() => {
    metrics.forEach((m) => void m);
    const duplicates = duplicatesIn();
    const done = metrics.filter((m) => m.ok);
    const sorted = [...metrics].map((m) => m.ms).sort((a, b) => a - b);
    const pct = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
    const report = {
      at: new Date().toISOString(),
      note: 'Eya\'s real engine, task keeper, record of done calls, token counting, provider chain and key pool; stand-in AI services over HTTP (scripted decisions); real files in a throwaway folder; a modelled web. Latency here is Eya\'s own overhead plus the injected delays, not real AI or network speed.',
      attempted: metrics.length,
      completed: done.length,
      failed: metrics.filter((m) => !m.ok).map((m) => ({ n: m.n, name: m.name, detail: m.detail })),
      recovered: metrics.filter((m) => m.recovered && m.ok).length,
      duplicateActions: duplicates,
      latencyMs: { median: pct(50), p95: pct(95), max: sorted[sorted.length - 1] ?? 0 },
      aiRequestsTotal: metrics.reduce((n, m) => n + m.aiRequests, 0),
      aiRequestsPerTask: Math.round((metrics.reduce((n, m) => n + m.aiRequests, 0) / Math.max(1, metrics.length)) * 100) / 100,
      providerErrorsServed: hits.errors,
      tokensTotal: metrics.reduce((n, m) => n + m.tokens, 0),
      inputTokensSent: metrics.reduce((n, m) => n + m.inputTokens, 0),
      tasks: metrics,
    };
    const out = process.env['WORKLOAD_REPORT'] ?? join(tmpdir(), 'eya-e2e-out', 'workload-report.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 2));
    // eslint-disable-next-line no-console
    console.log(`WORKLOAD ${done.length}/${metrics.length} done, ${report.recovered} recovered, ${duplicates} duplicate actions, median ${report.latencyMs.median} ms, p95 ${report.latencyMs.p95} ms, ${report.aiRequestsPerTask} AI requests per task, ${report.inputTokensSent} input tokens sent\n${metrics.map((m) => `${String(m.n).padStart(2)} ${m.ok ? 'ok  ' : 'FAIL'} ${String(m.ms).padStart(5)} ms  ai ${m.aiRequests}  in ${String(m.inputTokens).padStart(6)} tok  ${m.name}`).join('\n')}\nreport: ${out}`);
  });
});

