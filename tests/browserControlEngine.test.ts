import { describe, expect, it } from 'vitest';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { ConversationContext } from '../src/main/context/ConversationContext';
import type { AIChatMessage, AICompletion, AIProvider, AIToolCall, AIToolSpec } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';
import type { AgentRequest, AgentResult } from '../src/shared/types';

/**
 * "Open a website and do something" with no screen sharing: what happens when the model wrongly says it cannot use the browser, when it truly cannot, and
 * how a plain "...and click X" is carried out and judged. A scripted AI and fake browser tools; the same flows are run against a real Chrome in
 * tests/live/browserControl.live.test.ts.
 */

const call = (name: string, args: Record<string, unknown> = {}): AIToolCall => ({ id: `id_${name}_${Math.random().toString(36).slice(2, 6)}`, name, args });
const step = (...toolCalls: AIToolCall[]): AICompletion => ({ text: '', toolCalls });
const say = (text: string): AICompletion => ({ text, toolCalls: [] });
const CLAIM = "I'm sorry, I'm unable to interact with your browser directly. Could you please share your screen so I can see the page?";

class Recording implements AIProvider {
  readonly name = 'recording';
  readonly systems: string[] = [];
  readonly tools: string[][] = [];
  readonly sent: AIChatMessage[][] = [];
  constructor(private readonly script: AICompletion[]) {}
  isReady(): boolean {
    return true;
  }
  async complete(messages: readonly AIChatMessage[], tools: readonly AIToolSpec[]): Promise<AICompletion> {
    this.systems.push(String(messages[0]?.content ?? ''));
    this.tools.push(tools.map((t) => t.name));
    this.sent.push([...messages]);
    const next = this.script.shift();
    if (next === undefined) throw new Error('script exhausted');
    return next;
  }
}

const quietTTS: TTSProvider = { name: 'quiet', init: async () => undefined, speak: async () => undefined, prefetch: () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };
const SCHEMA_ARGS = { url: { type: 'string' as const }, text: { type: 'string' as const }, query: { type: 'string' as const }, keywords: { type: 'string' as const }, name: { type: 'string' as const }, label: { type: 'string' as const } };

function tool(name: string, ran: string[], respond: (args: ToolArgs) => ToolResult = () => ({ ok: true, summary: `${name} done` })): Tool {
  return { schema: { name, description: name, args: SCHEMA_ARGS, status: `${name}…` }, execute: async (args): Promise<ToolResult> => (ran.push(name), respond(args)) };
}

const OPEN_PAGE = (): ToolResult => ({ ok: true, summary: 'opened Example Domain', data: { currentPage: { url: 'https://example.org/', title: 'Example Domain', visibleText: 'This domain is for use in examples.' } } });
const CLICK_OK = (): ToolResult => ({ ok: true, summary: 'clicked "Cause List"', data: { action: 'click', navigated: true, stateChanged: true, currentPage: { url: 'https://example.org/causelist', title: 'Cause List', visibleText: 'WP 101/2026' } } });

interface Options {
  readonly script: AICompletion[];
  readonly replace?: Tool[];
  readonly access?: () => string;
}

function setup(o: Options): { engine: AgentEngine; ai: Recording; ran: string[] } {
  const ai = new Recording(o.script);
  const ran: string[] = [];
  const tools = new ToolRegistry();
  const replaced = new Set((o.replace ?? []).map((r) => r.schema.name));
  for (const n of ['web_search', 'open_website', 'find_and_open_website', 'click_on_page', 'inspect_page', 'read_page', 'fill_on_page', 'find_on_page', 'open_url', 'browser_status']) {
    if (!replaced.has(n)) tools.register(tool(n, ran));
  }
  for (const r of o.replace ?? []) tools.register(r);
  const engine = new AgentEngine({
    router: new IntentRouter(),
    tools,
    composer: new ResponseComposer(),
    tts: quietTTS,
    context: new ConversationContext(),
    ai,
    now: () => new Date('2026-10-26T10:00:00Z'),
    ...(o.access !== undefined ? { browserAccess: o.access } : {}),
  });
  return { engine, ai, ran };
}

const send = (e: AgentEngine, text: string, extra: Partial<AgentRequest> = {}): Promise<AgentResult> => e.handle({ requestId: `r${Math.random().toString(36).slice(2, 6)}`, text, source: 'text', mode: 'agent', ...extra }, () => undefined);
const lastUser = (ai: Recording, n: number): string => String(ai.sent[n]?.[(ai.sent[n]?.length ?? 1) - 1]?.content ?? '');

describe('the model says it cannot use the browser, or asks for the screen to be shared', () => {
  it('is told what is true and asked again — and then does the job with the tools; the person never sees the false "no"', async () => {
    const ran: string[] = [];
    const s = setup({
      script: [say(CLAIM), step(call('inspect_page')), say('The main heading is Example Domain.')],
      replace: [tool('find_and_open_website', ran, OPEN_PAGE), tool('inspect_page', ran, () => ({ ok: true, summary: 'inspected', data: { currentPage: { title: 'Example Domain', headings: ['Example Domain'] } } }))],
    });
    const r = await send(s.engine, 'Open example.org and tell me the main heading.');
    expect(r.spoken).toBe('The main heading is Example Domain.');
    expect(r.spoken).not.toMatch(/share your screen|unable to interact/i);
    expect(ran).toEqual(['find_and_open_website', 'inspect_page']);
    expect(s.ai.sent).toHaveLength(3);
    const note = lastUser(s.ai, 1);
    expect(note).toMatch(/^\(Eya\) What you just said is not right\. You DO have the user's own browser/);
    expect(note).toContain('inspect_page');
    expect(note).toMatch(/Do not ask the user to share their screen/);
  });

  it('is told at most twice: a model that will not stop gets no endless loop', async () => {
    const ran: string[] = [];
    const s = setup({ script: [say(CLAIM), say(CLAIM), say(CLAIM)], replace: [tool('find_and_open_website', ran, OPEN_PAGE)] });
    const r = await send(s.engine, 'Open example.org and tell me the main heading.');
    expect(s.ai.sent).toHaveLength(3); // the first answer, and two more asks
    expect(r.spoken).toContain('share your screen'); // after that it is the model's answer, honestly its own
  });

  it('is NOT argued with when a browser step has really reported that no browser is there: then it may be true', async () => {
    const down = (): ToolResult => ({ ok: false, summary: 'browser not connected', error: 'None of the user\'s browsers is connected to Eya.', data: { browserUnavailable: true, why: 'not_connected' } });
    const s = setup({
      script: [step(call('open_website', { url: 'https://example.org' })), say("I can't interact with your browser right now because it is not connected.")],
      replace: [tool('open_website', [], down)],
    });
    const r = await send(s.engine, 'go and check the website example.org for me please');
    expect(s.ai.sent).toHaveLength(2);
    expect(r.spoken).toContain('not connected');
  });

  it('is NOT argued with when the request is itself about the screen', async () => {
    const s = setup({ script: [say('Please share your screen first, then I can tell you what is on it.')] });
    const r = await send(s.engine, 'what is on my screen right now');
    expect(s.ai.sent).toHaveLength(1);
    expect(r.spoken).toContain('share your screen');
  });

  it('switches the browser abilities on when they were not offered, then tells the model it has them', async () => {
    const s = setup({ script: [say("I can't open websites for you, sorry."), say('Okay, done.')] });
    await send(s.engine, 'hmm check that out again for me');
    expect(s.ai.tools[0]).not.toContain('click_on_page'); // the request's words did not point at the browser, so it was not offered
    expect(s.ai.tools[1]).toEqual(expect.arrayContaining(['open_website', 'click_on_page', 'inspect_page']));
    expect(lastUser(s.ai, 1)).toContain('You DO have the user\'s own browser');
  });
});

describe('what the model is told about its access', () => {
  const LINE = "Browser access: the user's own Chrome is connected to Eya. SAMPLE-ACCESS-LINE";

  it('is in the instructions of a request about a website', async () => {
    const s = setup({ script: [say('ok')], access: () => LINE });
    await send(s.engine, 'open the court website and click cause list please, and do not stop');
    expect(s.ai.systems[0]).toContain('SAMPLE-ACCESS-LINE');
  });

  it('is not carried by a request that is not about a website (no tokens spent on it)', async () => {
    const s = setup({ script: [say('hello')], access: () => LINE });
    await send(s.engine, 'hello there');
    expect(s.ai.systems[0]).not.toContain('SAMPLE-ACCESS-LINE');
  });
});

describe('"open a site and click X": one plain click is made by Eya, and judged only by the page', () => {
  it('a click the page showed to work, with nothing else asked, is the answer: no AI call at all', async () => {
    const ran: string[] = [];
    const clicked: ToolArgs[] = [];
    const s = setup({
      script: [],
      replace: [tool('find_and_open_website', ran, OPEN_PAGE), tool('click_on_page', ran, (args) => (clicked.push(args), CLICK_OK()))],
    });
    const r = await send(s.engine, 'Open example.org and click Cause List');
    expect(ran).toEqual(['find_and_open_website', 'click_on_page']);
    expect(clicked).toEqual([{ text: 'Cause List' }]);
    expect(s.ai.sent).toHaveLength(0);
    expect(r.ok).toBe(true);
    expect(r.spoken).toBe('I opened Example Domain. I clicked "Cause List" and the page changed. It now shows "Cause List".');
  });

  it('a click after which the page is the same is NOT claimed as done: the model is asked, and told the click did nothing', async () => {
    const ran: string[] = [];
    const nothing = (): ToolResult => ({ ok: true, summary: 'clicked "Cause List" — but nothing on the page changed, so it may not have done anything', data: { navigated: false, stateChanged: false, nothingChanged: true, currentPage: { title: 'Example Domain' } } });
    const s = setup({
      script: [say('I clicked it but the page did not change, so I am not sure it worked.')],
      replace: [tool('find_and_open_website', ran, OPEN_PAGE), tool('click_on_page', ran, nothing)],
    });
    const r = await send(s.engine, 'Open example.org and click Cause List');
    expect(s.ai.sent).toHaveLength(1);
    expect(lastUser(s.ai, 0)).toContain('Nothing on the page changed');
    expect(lastUser(s.ai, 0)).toContain('do not repeat the same click');
    expect(r.spoken).not.toMatch(/^I opened Example Domain\. I clicked/);
  });

  it('a click that needs the person\'s yes is not made behind their back: it goes to the model with the question', async () => {
    const ran: string[] = [];
    const ask = (): ToolResult => ({ ok: false, summary: 'needs confirmation', error: 'This would pay. Ask the user first.', data: { needsConfirmation: true } });
    const s = setup({ script: [say('That would place an order. Shall I go ahead?')], replace: [tool('find_and_open_website', ran, OPEN_PAGE), tool('click_on_page', ran, ask)] });
    const r = await send(s.engine, 'Open example.org and click Pay now');
    expect(s.ai.sent).toHaveLength(1);
    expect(lastUser(s.ai, 0)).toContain('It did not work');
    expect(r.spoken).toContain('Shall I go ahead?');
  });

  it('anything more than one click is the model\'s, with the page: Eya makes no click of her own', async () => {
    const ran: string[] = [];
    const s = setup({ script: [say('Done.')], replace: [tool('find_and_open_website', ran, OPEN_PAGE)] });
    await send(s.engine, 'Open example.org and click Cause List and then read out the first row');
    expect(ran).toEqual(['find_and_open_website']);
    expect(s.ai.sent).toHaveLength(1);
  });

  it('a site that did not open is not clicked on', async () => {
    const ran: string[] = [];
    const failed = (): ToolResult => ({ ok: false, summary: 'could not open', error: 'It did not open.', data: { navigation: { problem: 'dns' } } });
    const s = setup({ script: [say('The site did not open.')], replace: [tool('find_and_open_website', ran, failed)] });
    await send(s.engine, 'Open example.org and click Cause List');
    expect(ran).toEqual(['find_and_open_website']);
  });
});
