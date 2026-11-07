import { describe, expect, it } from 'vitest';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { AGENT_HINT, CHAT_TOOLS, chatSystemPrompt, isBlockedSiteResult, pointsToAgent, wantedAfterSite, wantsAgent } from '../src/main/agent/agentMode';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { ConversationContext } from '../src/main/context/ConversationContext';
import type { AIChatMessage, AICompletion, AIProvider, AIToolCall, AIToolSpec } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import type { Tool, ToolResult } from '../src/main/tools/types';
import type { AgentRequest, AgentResult } from '../src/shared/types';

const call = (name: string, args: Record<string, unknown> = {}): AIToolCall => ({ id: `id_${name}_${Math.random().toString(36).slice(2, 6)}`, name, args });
const step = (toolCalls: AIToolCall[]): AICompletion => ({ text: '', toolCalls });
const say = (text: string): AICompletion => ({ text, toolCalls: [] });

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

function fake(name: string, ran: string[], data: Record<string, unknown> = {}): Tool {
  return { schema: { name, description: name, args: { url: { type: 'string' }, query: { type: 'string' }, keywords: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' }, question: { type: 'string' } }, status: `${name}…` }, execute: async (): Promise<ToolResult> => (ran.push(name), { ok: true, summary: `${name} done`, data }) };
}

function setup(script: AICompletion[], worked: string[] = [], replace: Tool[] = []): { engine: AgentEngine; ai: Recording; ran: string[]; wrapped: string[]; worked: string[] } {
  const ai = new Recording(script);
  const ran: string[] = [];
  const wrapped: string[] = [];
  const tools = new ToolRegistry();
  const replaced = new Set(replace.map((r) => r.schema.name));
  for (const n of ['web_search', 'analyze_document', 'open_website', 'find_and_open_website', 'click_on_page', 'open_url', 'find_file', 'deep_research']) if (!replaced.has(n)) tools.register(fake(n, ran));
  for (const r of replace) tools.register(r);
  const engine = new AgentEngine({
    router: new IntentRouter(),
    tools,
    composer: new ResponseComposer(),
    tts: quietTTS,
    context: new ConversationContext(),
    ai,
    now: () => new Date('2026-10-24T10:00:00Z'),
    workStarted: (id) => worked.push(id),
    // the task keeper: a conversation must never reach it
    around: async (req, run) => {
      wrapped.push(req.text);
      return run();
    },
  });
  return { engine, ai, ran, wrapped, worked };
}

const send = (e: AgentEngine, text: string, extra: Partial<AgentRequest> = {}): Promise<AgentResult> => e.handle({ requestId: `r${Math.random().toString(36).slice(2, 6)}`, text, source: 'text', ...extra }, () => undefined);

describe('what Agent mode is for', () => {
  it('recognises an everyday command, and leaves questions and chat alone', () => {
    for (const text of ['open youtube', 'Open the downloads folder', 'play feel good telugu songs', 'please download this file', 'go to the high court website', 'send it to Ravi', 'take a screenshot', 'lock the screen', 'open https://example.org/x', 'google cheap flights', 'search amazon for phone cases']) {
      expect(wantsAgent(text), text).toBe(true);
    }
    for (const text of ['Hi', 'hello', 'what is two plus two', 'who won the match yesterday', 'find a good name for my dog', 'tell me a joke', 'how are you', 'explain the cause list in simple words', '']) {
      expect(wantsAgent(text), text).toBe(false);
    }
  });

  it('knows a reply that points to Agent mode', () => {
    expect(pointsToAgent('That is something I can do in Agent mode: switch it on with the Agent button.')).toBe(true);
    expect(pointsToAgent('Hello! How can I help you today?')).toBe(false);
    expect(pointsToAgent('The secret agent turned up late.')).toBe(false);
  });

  it('chat may only look a fact up and read an attached file', () => {
    expect([...CHAT_TOOLS].sort()).toEqual(['analyze_document', 'web_search']);
    const prompt = chatSystemPrompt(new Date('2026-10-24T10:00:00Z'));
    expect(prompt).toMatch(/plain chat mode/);
    expect(prompt).toMatch(/do NOT control the computer or a browser/);
    expect(prompt).toMatch(/Agent button beside the message box/);
  });
});

describe('plain chat (Agent mode off)', () => {
  it('"Hi" is answered as a conversation: no tool but the two allowed, no task, nothing worked on', async () => {
    const s = setup([say('Hello! How can I help you today?')]);
    const r = await send(s.engine, 'Hi', { mode: 'chat' });
    expect(r.spoken).toBe('Hello! How can I help you today?');
    expect(r.ok).toBe(true);
    expect(r.suggestAgent).toBeUndefined();
    expect(s.ai.tools[0]).toEqual(['web_search', 'analyze_document']);
    expect(s.ai.tools[0]).not.toContain('load_tools');
    expect(s.ai.systems[0]).toMatch(/plain chat mode/);
    expect(s.ai.systems[0]).not.toMatch(/Navigating a website/);
    expect(s.wrapped).toEqual([]); // never handed to the task keeper
    expect(s.worked).toEqual([]);
    expect(s.ran).toEqual([]);
  });

  it('an everyday command is not carried out and not guessed at: chat says it is for Agent mode, at once, with the button offered', async () => {
    const s = setup([]);
    const r = await send(s.engine, 'open youtube', { mode: 'chat' });
    expect(r.spoken).toBe(AGENT_HINT);
    expect(r.suggestAgent).toBe(true);
    expect(s.ai.systems).toEqual([]); // no AI call at all
    expect(s.ran).toEqual([]);
    expect(s.wrapped).toEqual([]);
  });

  it('a question that needs fresh facts may look them up; opening pages is not available', async () => {
    const s = setup([step([call('web_search', { query: 'who won the match' })]), say('India won by five wickets.')]);
    const r = await send(s.engine, 'who won the match yesterday', { mode: 'chat' });
    expect(r.spoken).toBe('India won by five wickets.');
    expect(s.ran).toEqual(['web_search']);
    expect(s.worked).toEqual([]);
    expect(s.wrapped).toEqual([]);
  });

  it('a tool outside the chat list is refused even if the AI asks for it', async () => {
    const s = setup([step([call('open_website', { url: 'https://example.org/' })]), say('I cannot open pages in chat. Turn on Agent and I will.')]);
    const r = await send(s.engine, 'tell me about example.org', { mode: 'chat' });
    expect(s.ran).toEqual([]);
    expect(r.suggestAgent).toBe(true);
  });

  it('an attached file can still be read in chat', async () => {
    const s = setup([step([call('analyze_document', { path: 'C:\\a.pdf', question: 'summary' })]), say('It is a short notice.')]);
    const r = await send(s.engine, 'what does this say', { mode: 'chat', attachments: [{ name: 'a.pdf', path: 'C:\\a.pdf', kind: 'document', size: 10 }] });
    expect(s.ran).toEqual(['analyze_document']);
    expect(r.spoken).toBe('It is a short notice.');
  });

  it('five attached files are read one turn after another before the answer, not cut off at four turns', async () => {
    const names = ['a.txt', 'b.docx', 'c.png', 'd.mp3', 'e.pdf'];
    const s = setup([...names.map((n) => step([call('analyze_document', { path: 'C:/' + n, question: 'summary' })])), say('All five read.')]);
    const r = await send(s.engine, 'what do these say', { mode: 'chat', attachments: names.map((n) => ({ name: n, path: 'C:/' + n, kind: 'document' as const, size: 10 })) });
    expect(s.ran).toHaveLength(5);
    expect(r.spoken).toBe('All five read.');
  });

  it('a reply that tells the person to switch Agent on carries the offer of the button', async () => {
    const s = setup([say('I can do that for you in Agent mode: switch on the Agent button next to the message box.')]);
    const r = await send(s.engine, 'could you pull up the telangana cause list', { mode: 'chat' });
    expect(r.suggestAgent).toBe(true);
  });
});

describe('a site that gives films away, asked for by name', () => {
  it('says what was wanted after the site, without the site or the words around it', () => {
    expect(wantedAfterSite('Open MovieRulz site and play Telugu HD Paradise movie.', 'MovieRulz')).toBe('Telugu HD Paradise movie');
    expect(wantedAfterSite('open movierulz and watch the paradise movie', 'Movierulz')).toBe('the paradise movie');
    expect(wantedAfterSite('go to movie rulz website then download Pushpa 2', 'movie rulz')).toBe('Pushpa 2');
    expect(wantedAfterSite('open MovieRulz site', 'MovieRulz')).toBe('');
    expect(wantedAfterSite('open MovieRulz site and tell me the time', 'MovieRulz')).toBe('');
    expect(wantedAfterSite('play Paradise', '')).toBe('');
  });

  it('knows the answer of a blocked site, and only that', () => {
    expect(isBlockedSiteResult({ ok: false, data: { navigation: { problem: 'blocked_site' } } })).toBe(true);
    expect(isBlockedSiteResult({ ok: false, data: { navigation: { problem: 'unreachable' } } })).toBe(false);
    expect(isBlockedSiteResult({ ok: true, data: { navigation: { problem: 'blocked_site' } } })).toBe(false);
    expect(isBlockedSiteResult({ ok: false })).toBe(false);
  });

  const blockedSite = (): Tool => ({ schema: { name: 'find_and_open_website', description: 'x', args: { name: { type: 'string' }, url: { type: 'string' }, keywords: { type: 'string' } }, status: 'x' }, execute: async (): Promise<ToolResult> => ({ ok: false, summary: 'could not open', error: 'I did not open MovieRulz and did not search for it.', data: { navigation: { problem: 'blocked_site' } } }) });
  const research = (asked: Record<string, unknown>[]): Tool => ({ schema: { name: 'deep_research', description: 'x', args: { question: { type: 'string' }, kind: { type: 'string' }, no_site: { type: 'boolean' } }, status: 'x' }, execute: async (args): Promise<ToolResult> => (asked.push({ ...args }), { ok: true, summary: 'researched: 2 places to watch or listen', data: { watch: [{ platform: 'Netflix', title: 'Paradise' }] } }) });

});

describe('Agent mode', () => {
  it('carries the request out with the browser tools and says work has started', async () => {
    const s = setup([step([call('find_and_open_website', { keywords: 'telangana cause list' })]), say('Here is the cause list.')]);
    const r = await send(s.engine, 'open the telangana high court cause list', { mode: 'agent' });
    expect(s.ran).toEqual(['find_and_open_website']);
    expect(s.worked).toHaveLength(1);
    expect(s.wrapped).toEqual(['open the telangana high court cause list']);
    expect(r.spoken).toBe('Here is the cause list.');
  });

  it('a request with no mode (voice, the quick panel) is an agent task as it always was', async () => {
    const s = setup([step([call('find_and_open_website', { keywords: 'x' })]), say('Done.')]);
    await send(s.engine, 'open the telangana high court cause list');
    expect(s.ran).toEqual(['find_and_open_website']);
    expect(s.wrapped).toHaveLength(1);
  });



});

const findSchema = { name: 'find_and_open_website', description: 'x', args: { name: { type: 'string' as const }, url: { type: 'string' as const }, keywords: { type: 'string' as const } }, status: 'x' };
const pageTool = (ran: string[]): Tool => ({ schema: findSchema, execute: async (): Promise<ToolResult> => (ran.push('find_and_open_website'), { ok: true, summary: 'opened Example Domain', data: { currentPage: { url: 'https://example.org/', title: 'Example Domain', visibleText: 'This domain is for use in examples.' } } }) });
const failedTool = (ran: string[], reason: string, notes: string[] = []): Tool => ({ schema: findSchema, execute: async (): Promise<ToolResult> => (ran.push('find_and_open_website'), { ok: false, summary: 'could not open', error: 'It did not open.', data: { navigation: { problem: reason }, recovery: { reason, notes } } }) });
const blockedTool = (ran: string[]): Tool => ({ schema: findSchema, execute: async (): Promise<ToolResult> => (ran.push('find_and_open_website'), { ok: false, summary: 'could not open', error: 'I did not open MovieRulz and did not search for it.', data: { navigation: { problem: 'blocked_site' } } }) });
const researchTool = (asked: Record<string, unknown>[]): Tool => ({ schema: { name: 'deep_research', description: 'x', args: { question: { type: 'string' }, kind: { type: 'string' }, no_site: { type: 'boolean' } }, status: 'x' }, execute: async (args): Promise<ToolResult> => (asked.push({ ...args }), { ok: true, summary: 'researched: 2 places to watch or listen', data: { watch: [{ platform: 'Netflix', title: 'Paradise' }] } }) });
const userTurn = (s: { ai: Recording }, n = 0): string => String(s.ai.sent[n]?.[s.ai.sent[n].length - 1]?.content ?? '');

describe('the application finds the site; the model interprets what it found', () => {
  it('opens the site itself before the model is asked anything, and the model is shown the page', async () => {
    const ran: string[] = [];
    const s = setup([say('The main heading is Example Domain.')], [], [pageTool(ran)]);
    const r = await send(s.engine, 'Open example.org and tell me the main heading.', { mode: 'agent' });
    expect(ran).toEqual(['find_and_open_website']);
    expect(s.worked).toHaveLength(1);
    expect(s.ai.sent).toHaveLength(1);
    expect(userTurn(s)).toContain('Open example.org and tell me the main heading.');
    expect(userTurn(s)).toContain("Eya's own browser step ran");
    expect(userTurn(s)).toContain('Example Domain');
    expect(userTurn(s)).toContain('tell me the main heading');
    expect(r.spoken).toBe('The main heading is Example Domain.');
    expect(r.diagnosis).toBeUndefined();
  });

  it('when opening the site is all that was asked and it is open and checked, there is nothing for the model to decide: no AI call is made', async () => {
    const ran: string[] = [];
    const s = setup([], [], [pageTool(ran)]);
    const r = await send(s.engine, 'Open the website example.org', { mode: 'agent' });
    expect(ran).toEqual(['find_and_open_website']);
    expect(s.ai.sent).toHaveLength(0);
    expect(r.spoken).toBe('I opened Example Domain.');
    expect(r.ok).toBe(true);
    expect(r.diagnosis).toBeUndefined();
    expect(r.tokens).toBeUndefined();
  });

  it('but if it did not open, the model is still asked (it explains, or tries another way)', async () => {
    const s = setup([say('It would not load.')], [], [failedTool([], 'unreachable')]);
    const r = await send(s.engine, 'open example.org', { mode: 'agent' });
    expect(s.ai.sent).toHaveLength(1);
    expect(r.spoken).toBe('It would not load.');
  });

  it('finds a site named in words ("open the telangana high court website") the same way', async () => {
    const ran: string[] = [];
    const s = setup([say('Opened.')], [], [pageTool(ran)]);
    await send(s.engine, 'please open the telangana high court website', { mode: 'agent' });
    expect(ran).toEqual(['find_and_open_website']);
  });

  it('a refusal by the model afterwards is the model\'s: it is said to be, the page is said to have opened, and it is not argued with', async () => {
    const ran: string[] = [];
    const s = setup([say("I'm sorry, I can't help with that: it is against my policy.")], [], [pageTool(ran)]);
    const r = await send(s.engine, 'open example.org and play the movie', { mode: 'agent' });
    expect(ran).toEqual(['find_and_open_website']);
    expect(s.ai.sent).toHaveLength(1);
    expect(r.spoken).toMatch(/against my policy/);
    expect(r.spoken).toMatch(/page itself did open \(Example Domain\)/);
    expect(r.spoken).toMatch(/AI model, not from the browser/);
    expect(r.diagnosis?.map((d) => d.source)).toEqual(['model_refusal']);
  });

  it('the AI being out does not undo what was done: the site is open, and the person is told', async () => {
    const ran: string[] = [];
    const s = setup([], [], [pageTool(ran)]);
    // (something is asked for after opening it, so the model is needed: and it is out)
    const r = await send(s.engine, 'open example.org and tell me the main heading', { mode: 'agent' });
    expect(ran).toEqual(['find_and_open_website']);
    expect(r.spoken).toMatch(/^I opened Example Domain\./);
    expect(r.ok).toBe(false);
    expect(r.diagnosis?.map((d) => d.source)).toEqual(['model_unavailable']);
  });

  it('a page that did not load is a navigation problem, not the model\'s, and the model is told where it stopped', async () => {
    const ran: string[] = [];
    const s = setup([say('The site did not load.')], [], [failedTool(ran, 'unreachable')]);
    const r = await send(s.engine, 'open example.org', { mode: 'agent' });
    expect(userTurn(s)).toContain('stopped at opening the page');
    expect(r.diagnosis?.map((d) => d.source)).toEqual(['navigation']);
    expect(r.spoken).toBe('The site did not load.');
  });

  it('a search that found nothing usable is a search problem', async () => {
    const s = setup([say('I could not find it.')], [], [failedTool([], 'no_alternative', ['A web search did not work.'])]);
    const r = await send(s.engine, 'open the lost portal website', { mode: 'agent' });
    expect(userTurn(s)).toContain('stopped at the search');
    expect(r.diagnosis?.map((d) => d.source)).toEqual(['search']);
  });

  it('a site that gives films away is Eya\'s own rule, said so, and the lawful options for the film are looked up at once for the model', async () => {
    const ran: string[] = [];
    const asked: Record<string, unknown>[] = [];
    const s = setup([say('I did not open MovieRulz, but Paradise is on Netflix.')], [], [blockedTool(ran), researchTool(asked)]);
    const r = await send(s.engine, 'Open MovieRulz site and play Telugu HD Paradise movie.', { mode: 'agent' });
    expect(ran).toEqual(['find_and_open_website']);
    expect(asked).toEqual([{ question: 'Telugu HD Paradise movie', kind: 'media', no_site: true }]);
    expect(userTurn(s)).toContain("Eya's own rule about that site, not a browser or search error");
    expect(userTurn(s)).toContain('legalOptions');
    expect(userTurn(s)).toContain('Netflix');
    expect(r.diagnosis?.map((d) => d.source)).toEqual(['application_policy']);
    expect(r.spoken).toMatch(/Netflix/);
  });

  it('with nothing asked for after the site there is nothing to look up, and a repeat by the model does not look it up again', async () => {
    const asked: Record<string, unknown>[] = [];
    const s = setup([say('Done.')], [], [blockedTool([]), researchTool(asked)]);
    await send(s.engine, 'open MovieRulz site', { mode: 'agent' });
    expect(asked).toEqual([]);
    const again = setup([step([call('find_and_open_website', { name: 'MovieRulz' })]), say('Done.')], [], [blockedTool([]), researchTool(asked)]);
    await send(again.engine, 'open MovieRulz site and play Paradise', { mode: 'agent' });
    expect(asked).toHaveLength(1);
  });

  it('chat never starts it, and nor does always-on listening', async () => {
    const ran: string[] = [];
    const chat = setup([say('x')], [], [pageTool(ran)]);
    await send(chat.engine, 'open example.org', { mode: 'chat' });
    const live = setup([say('x')], [], [pageTool(ran)]);
    await send(live.engine, 'open example.org', { live: true });
    expect(ran).toEqual([]);
  });
});

describe('whose "no" it was', () => {
  it('a provider\'s own safety block is the model\'s decision: said so, not retried, not worked around', async () => {
    const s = setup([{ text: '', toolCalls: [], blocked: 'the prompt was blocked (SAFETY)' }]);
    const r = await send(s.engine, 'order the annual report from the court', { mode: 'agent' });
    expect(s.ai.sent).toHaveLength(1);
    expect(r.spoken).toMatch(/safety system stopped this answer/);
    expect(r.spoken).toMatch(/AI model, not from the browser or the search/);
    expect(r.diagnosis?.map((d) => d.source)).toEqual(['model_refusal']);
  });

  it('a refusal on policy grounds is not asked again with everything switched on', async () => {
    const s = setup([say("I can't help with that, it is illegal.")]);
    const r = await send(s.engine, 'tell me how to do something forbidden', { mode: 'agent' });
    expect(s.ai.sent).toHaveLength(1);
    expect(r.diagnosis?.map((d) => d.source)).toEqual(['model_refusal']);
  });

  it('a "no" for lack of a tool is a gap in Eya\'s set-up: asked again once with every ability on', async () => {
    const s = setup([say("I don't have a tool for that."), say('Here you go.')]);
    const r = await send(s.engine, 'tell me something', { mode: 'agent' });
    expect(s.ai.sent).toHaveLength(2);
    expect(r.spoken).toBe('Here you go.');
    expect(r.diagnosis).toBeUndefined();
  });

  it('a question the AI cannot answer is not turned into a search for something to open', async () => {
    const s = setup([say("I can't tell you that: nobody knows."), say("I can't tell you that: nobody knows.")]);
    const r = await send(s.engine, 'what will the weather be like in ten years', { mode: 'agent' });
    expect(r.spoken).toMatch(/nobody knows/);
    expect(s.ran).toEqual([]);
  });

  it('a failed tool is attributed to what failed: a search tool to search, the browser to navigation', async () => {
    const bad = (name: string): Tool => ({ schema: { name, description: 'x', args: { query: { type: 'string' }, url: { type: 'string' } }, status: 'x' }, execute: async (): Promise<ToolResult> => ({ ok: false, summary: 'failed', error: 'it failed' }) });
    const s = setup([step([call('web_search', { query: 'x' })]), step([call('open_website', { url: 'https://a.example' })]), say('Neither worked.')], [], [bad('web_search'), bad('open_website')]);
    const r = await send(s.engine, 'check the news', { mode: 'agent' });
    expect(r.diagnosis?.map((d) => d.source)).toEqual(['search', 'navigation']);
  });
});
