import { describe, expect, it } from 'vitest';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { MAX_PARALLEL_TOOLS, canRunTogether, shortenOlderResults, shortenPageResult, startTogether } from '../src/main/agent/history';
import { systemPrompt } from '../src/main/agent/prompts';
import { OPENS_TOPIC, parseGroups, routeGroups, routeTopics } from '../src/main/agent/toolGroups';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { ConversationContext } from '../src/main/context/ConversationContext';
import type { AIChatMessage, AICompletion, AIProvider, AIToolCall, AIToolSpec } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import type { Tool, ToolResult } from '../src/main/tools/types';
import type { AgentUpdate } from '../src/shared/types';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const call = (name: string, args: Record<string, unknown> = {}): AIToolCall => ({ id: `id_${name}_${Math.random().toString(36).slice(2, 6)}`, name, args });
const step = (toolCalls: AIToolCall[]): AICompletion => ({ text: '', toolCalls });
const say = (text: string): AICompletion => ({ text, toolCalls: [] });

class Recording implements AIProvider {
  readonly name = 'recording';
  readonly sent: AIChatMessage[][] = [];
  constructor(private readonly script: AICompletion[]) {}
  isReady(): boolean {
    return true;
  }
  async complete(messages: readonly AIChatMessage[], _tools: readonly AIToolSpec[]): Promise<AICompletion> {
    this.sent.push([...messages]);
    const next = this.script.shift();
    if (next === undefined) throw new Error('script exhausted');
    return next;
  }
}

function tool(name: string, run: (args: Record<string, unknown>) => Promise<ToolResult>): Tool {
  return { schema: { name, description: name, args: { path: { type: 'string' }, text: { type: 'string' }, url: { type: 'string' } }, status: `${name}…` }, execute: run };
}

function engine(script: AICompletion[], tools: Tool[], tts?: TTSProvider): { engine: AgentEngine; ai: Recording; updates: AgentUpdate[] } {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  const ai = new Recording(script);
  const quiet: TTSProvider = { name: 'quiet', init: async () => undefined, speak: async () => undefined, prefetch: () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };
  const e = new AgentEngine({ router: new IntentRouter(), tools: registry, composer: new ResponseComposer(), tts: tts ?? quiet, context: new ConversationContext(), ai, now: () => new Date('2026-10-24T10:00:00Z') });
  return { engine: e, ai, updates: [] };
}
const ask = (e: AgentEngine, text: string, extra: Record<string, unknown> = {}, updates?: AgentUpdate[]) => e.handle({ requestId: `r${Math.random().toString(36).slice(2, 6)}`, text, source: 'text', ...extra }, (u) => updates?.push(u));

// ----------------------------------------------------------------------------------------------------------------------------- the voice
describe('the text does not wait for the voice', () => {
  const slowVoice = (ms: number, log: string[]): TTSProvider => ({
    name: 'slow',
    init: async () => undefined,
    speak: async () => {
      log.push('speaking');
      await sleep(ms);
      log.push('spoken');
    },
    prefetch: () => undefined,
    stop: () => undefined,
    isReady: () => true,
    dispose: async () => undefined,
  });

  it('a typed request gets its answer back at once, and the voice goes on afterwards (then the state goes idle)', async () => {
    const log: string[] = [];
    const updates: AgentUpdate[] = [];
    const { engine: e } = engine([say('Here is your answer.')], [], slowVoice(400, log));
    const started = Date.now();
    const result = await ask(e, 'what is two plus two', { mode: 'chat' }, updates);
    const took = Date.now() - started;
    expect(result.spoken).toBe('Here is your answer.');
    expect(took).toBeLessThan(300);
    expect(log).toEqual(['speaking']); // the voice has begun and is not finished
    expect(updates.some((u) => u.state === 'idle')).toBe(false);
    await sleep(500);
    expect(log).toEqual(['speaking', 'spoken']);
    expect(updates.filter((u) => u.state === 'idle').length).toBe(1);
  });

  it('a spoken request still waits until Eya has finished talking, so the listening never starts over her own voice', async () => {
    const log: string[] = [];
    const { engine: e } = engine([say('Here is your answer.')], [], slowVoice(300, log));
    const started = Date.now();
    await ask(e, 'what is two plus two', { source: 'voice' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    expect(log).toEqual(['speaking', 'spoken']);
  });

  it('a voice that fails does not break the answer or leave the state stuck', async () => {
    const updates: AgentUpdate[] = [];
    const broken: TTSProvider = { name: 'broken', init: async () => undefined, speak: async () => { throw new Error('no audio device'); }, prefetch: () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };
    const { engine: e } = engine([say('Fine.')], [], broken);
    const result = await ask(e, 'hello there', { mode: 'chat' }, updates);
    expect(result.spoken).toBe('Fine.');
    await sleep(50);
    expect(updates.some((u) => u.state === 'idle')).toBe(true);
  });
});

// ----------------------------------------------------------------------------------------------------------------------------- the history
describe('older page results are cut down; nothing else is', () => {
  const big = (n: number): string => JSON.stringify({ ok: true, summary: `opened page ${n}`, data: { url: `https://example.org/${n}`, title: `Page ${n}`, currentPage: { url: `https://example.org/${n}`, title: `Page ${n}`, visibleText: 'x'.repeat(9000) } } });
  const conversation = (): AIChatMessage[] => [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', content: '', toolCalls: [call('open_website')] },
    { role: 'tool', name: 'open_website', toolCallId: 'a', content: big(1) },
    { role: 'assistant', content: '', toolCalls: [call('find_file')] },
    { role: 'tool', name: 'find_file', toolCallId: 'b', content: JSON.stringify({ ok: true, summary: 'found', data: { files: Array.from({ length: 60 }, (_, i) => `C:\\Users\\x\\file${i}.pdf`) } }) },
    { role: 'assistant', content: '', toolCalls: [call('read_page')] },
    { role: 'tool', name: 'read_page', toolCallId: 'c', content: big(2) },
    { role: 'assistant', content: '', toolCalls: [call('click_on_page')] },
    { role: 'tool', name: 'click_on_page', toolCallId: 'd', content: big(3) },
    { role: 'assistant', content: '', toolCalls: [call('read_page')] },
    { role: 'tool', name: 'read_page', toolCallId: 'e', content: big(4) },
  ];

  it('the two latest results stay whole, an older page result is cut to where it was and what it was called', () => {
    const before = conversation();
    const copy = structuredClone(before);
    const after = shortenOlderResults(before);
    const tools = after.filter((m) => m.role === 'tool');
    expect(tools[0]?.content.length).toBeLessThan(900); // page 1
    expect(JSON.parse(tools[0]?.content ?? '{}')).toMatchObject({ ok: true, summary: 'opened page 1', data: { url: 'https://example.org/1', title: 'Page 1', currentPage: { url: 'https://example.org/1', title: 'Page 1' } } });
    expect(tools[0]?.content).toContain('read it again');
    expect(tools[2]?.content.length).toBeLessThan(900); // page 2 (read_page, older than the last two)
    expect(tools[3]?.content).toBe(big(3)); // the second to last, whole
    expect(tools[4]?.content).toBe(big(4)); // the last, whole
    expect(before).toEqual(copy); // what was given is not changed
  });

  it('a result of any other tool is never cut (a list of files holds the paths she must not invent)', () => {
    const original = conversation();
    const after = shortenOlderResults(original);
    const list = after.find((m) => m.name === 'find_file');
    expect(list?.content).toBe(original.find((m) => m.name === 'find_file')?.content);
    expect(list?.content).toContain('file59.pdf');
  });

  it('the conversation itself is untouched, and small results are left alone', () => {
    const original = conversation();
    const after = shortenOlderResults(original);
    expect(after.filter((m) => m.role !== 'tool')).toEqual(original.filter((m) => m.role !== 'tool'));
    const small = [{ role: 'tool' as const, name: 'read_page', toolCallId: 'z', content: '{"ok":true,"summary":"small"}' }, ...original.slice(-4)];
    expect(shortenOlderResults(small)[0]?.content).toBe('{"ok":true,"summary":"small"}');
  });

  it('a result that is not JSON is cut by length, and a short list is returned as it was', () => {
    expect(shortenPageResult('y'.repeat(5000), 1000)).toMatch(/^y{1000} …\[an earlier result, cut from 5000 characters/);
    const few: AIChatMessage[] = [{ role: 'user', content: 'x' }, { role: 'tool', name: 'read_page', toolCallId: 'a', content: big(1) }];
    expect(shortenOlderResults(few)).toBe(few);
  });

  it('what the model is sent in the real loop carries the shortened pages, and costs much less for it', async () => {
    const pages = ['open_website', 'read_page', 'click_on_page', 'read_page'].map((name, i) =>
      tool(name, async () => ({ ok: true, summary: `page ${i + 1}`, data: { url: `https://example.org/${i + 1}`, title: `Page ${i + 1}`, currentPage: { url: `https://example.org/${i + 1}`, title: `Page ${i + 1}`, visibleText: 'z'.repeat(9000) } } })),
    );
    // (read_page is registered twice above: keep one)
    const unique = pages.filter((t, i, all) => all.findIndex((x) => x.schema.name === t.schema.name) === i);
    const { engine: e, ai } = engine(
      [step([call('open_website', { url: 'https://example.org' })]), step([call('read_page')]), step([call('click_on_page', { text: 'next' })]), step([call('read_page')]), say('Done.')],
      unique,
    );
    await ask(e, 'go through the pages', { mode: 'agent' });
    const size = (n: number): number => ai.sent[n]?.filter((m) => m.role !== 'system').reduce((total, m) => total + m.content.length, 0) ?? 0;
    // the fifth request carries four page results of about 9,300 characters; with the older two cut down it holds the latest two whole and little more
    expect(size(4)).toBeLessThan(2 * 9500 + 3000);
    expect(size(4)).toBeLessThan(0.65 * 4 * 9300);
    const last = ai.sent[4] ?? [];
    expect(last.filter((m) => m.role === 'tool' && m.content.includes('read it again')).length).toBeGreaterThanOrEqual(1);
    expect(last.filter((m) => m.role === 'tool').length).toBe(4);
  });
});

// ----------------------------------------------------------------------------------------------------------------------------- doing things together
describe('independent reads run together, everything else in order', () => {
  it('decides which turns may run together: several calls, all of them reads that need no page', () => {
    expect(canRunTogether([{ name: 'analyze_document' }, { name: 'analyze_document' }])).toBe(true);
    expect(canRunTogether([{ name: 'analyze_document' }, { name: 'find_file' }, { name: 'read_file' }])).toBe(true);
    expect(canRunTogether([{ name: 'analyze_document' }])).toBe(false);
    expect(canRunTogether([{ name: 'analyze_document' }, { name: 'click_on_page' }])).toBe(false);
    expect(canRunTogether([{ name: 'web_search' }, { name: 'web_search' }])).toBe(false);
    expect(canRunTogether([{ name: 'move_file' }, { name: 'move_file' }])).toBe(false);
    expect(canRunTogether([])).toBe(false);
  });

  it('starts them together, keeps the order of the results, runs at most four at a time, and a failure stops no one', async () => {
    let running = 0;
    let peak = 0;
    const work = (n: number, fails = false) => async (): Promise<ToolResult> => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(80);
      running -= 1;
      if (fails) throw new Error('boom');
      return { ok: true, summary: `result ${n}` };
    };
    const started = Date.now();
    const results = await Promise.all(startTogether([work(1), work(2), work(3, true), work(4), work(5), work(6)]));
    const took = Date.now() - started;
    expect(results.map((r) => r.summary)).toEqual(['result 1', 'result 2', 'tool failed', 'result 4', 'result 5', 'result 6']);
    expect(results[2]?.ok).toBe(false);
    expect(peak).toBe(MAX_PARALLEL_TOOLS);
    expect(took).toBeGreaterThanOrEqual(150); // six at four a time: two rounds, not one and not six
    expect(took).toBeLessThan(400);
  });

  it('in the loop: three attached files read in one turn take about as long as one, and the results come back in the order asked', async () => {
    const order: string[] = [];
    const reader = tool('analyze_document', async (args) => {
      order.push(`start ${String(args['path'])}`);
      await sleep(200);
      order.push(`end ${String(args['path'])}`);
      return { ok: true, summary: `read ${String(args['path'])}` };
    });
    const { engine: e, ai } = engine([step([call('analyze_document', { path: 'a' }), call('analyze_document', { path: 'b' }), call('analyze_document', { path: 'c' })]), say('All three read.')], [reader]);
    const started = Date.now();
    const result = await ask(e, 'read these three files', { mode: 'agent' });
    const took = Date.now() - started;
    expect(result.spoken).toBe('All three read.');
    expect(took).toBeLessThan(500); // one after another it would be 600 and more
    expect(order.slice(0, 3)).toEqual(['start a', 'start b', 'start c']);
    const answers = (ai.sent[1] ?? []).filter((m) => m.role === 'tool').map((m) => (JSON.parse(m.content) as { summary: string }).summary);
    expect(answers).toEqual(['read a', 'read b', 'read c']);
  });

  it('in the loop: things that touch a page or change something are never started together', async () => {
    const events: string[] = [];
    const slow = (name: string) =>
      tool(name, async (args) => {
        events.push(`start ${name} ${String(args['text'])}`);
        await sleep(60);
        events.push(`end ${name} ${String(args['text'])}`);
        return { ok: true, summary: 'done' };
      });
    const { engine: e } = engine([step([call('click_on_page', { text: '1' }), call('click_on_page', { text: '2' })]), say('Clicked.')], [slow('click_on_page')]);
    await ask(e, 'click the first and the second link', { mode: 'agent' });
    expect(events).toEqual(['start click_on_page 1', 'end click_on_page 1', 'start click_on_page 2', 'end click_on_page 2']);
  });
});

// ----------------------------------------------------------------------------------------------------------------------------- what is sent
describe('only what a request is about is sent', () => {
  const now = new Date('2026-10-24T10:00:00Z');
  const browser = new Set(['browser'] as const);

  it('the rules for adverts, and for ordering, are sent only when the request is about them; the rules for working in the browser always are', () => {
    const plain = systemPrompt(now, browser, new Set());
    const all = systemPrompt(now, browser);
    expect(plain).toContain("Working in the user's own browser");
    expect(plain).toContain('Acting like a capable human assistant on the web');
    expect(plain).not.toContain('Adverts and pop-ups');
    expect(plain).not.toContain('Ordering things and booking tickets');
    expect(plain).toMatch(/More browser guidance, switched off for now: ads = .*orders = /);
    expect(all).toContain('Adverts and pop-ups');
    expect(all).toContain('Ordering things and booking tickets');
    expect(all.length - plain.length).toBeGreaterThan(3000);
    const ads = systemPrompt(now, browser, new Set(['ads'] as const));
    expect(ads).toContain('Adverts and pop-ups');
    expect(ads).not.toContain('Ordering things and booking tickets');
    expect(ads).toMatch(/orders = /);
    expect(ads).not.toMatch(/ads = /);
  });

  it('nothing is said about held-back guidance when there is no browser part at all, or when everything is on', () => {
    expect(systemPrompt(now, new Set(), new Set())).not.toContain('More browser guidance');
    expect(systemPrompt(now, browser, new Set(['ads', 'orders'] as const))).not.toContain('More browser guidance');
  });

  it('routes the topics by what the request is about, and by what was just done', () => {
    expect([...routeTopics('open example.org and tell me the heading')]).toEqual([]);
    expect([...routeTopics('play some telugu songs on youtube')]).toEqual(['ads']);
    expect([...routeTopics('book two tickets for tonight on bookmyshow')]).toEqual(['orders']);
    expect([...routeTopics('order a phone case from flipkart and then watch a video')].sort()).toEqual(['ads', 'orders']);
    expect([...routeTopics('and the next one', { recentTools: ['play_on_youtube'] })]).toEqual(['ads']);
    expect(OPENS_TOPIC['skip_ads']).toBe('ads');
  });

  it('load_tools understands the topic names, and everything means everything', () => {
    const asked = parseGroups('browser, ads and orders');
    expect([...asked.groups]).toEqual(['browser']);
    expect([...asked.topics].sort()).toEqual(['ads', 'orders']);
    expect(asked.unknown).toEqual([]);
    expect([...parseGroups('all').topics].sort()).toEqual(['ads', 'orders']);
    expect(parseGroups('pop-ups').topics.has('ads')).toBe(true);
    expect(parseGroups('nonsense').unknown).toEqual(['nonsense']);
  });

  it('a heading, a font or an index sends the Word tools only when the request is not about a website', () => {
    expect(routeGroups('Open the website example.org and tell me what the main heading says.').has('word')).toBe(false);
    expect(routeGroups('go to https://example.org and read the heading').has('word')).toBe(false);
    expect(routeGroups('make the heading bold').has('word')).toBe(true);
    expect(routeGroups('make the heading bold in my petition').has('word')).toBe(true);
    expect(routeGroups('add page numbers to this document').has('word')).toBe(true);
    expect(routeGroups('open the website of the high court, find the petition and make the heading bold in word').has('word')).toBe(true);
  });
});
