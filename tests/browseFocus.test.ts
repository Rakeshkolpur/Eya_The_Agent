import { beforeEach, describe, expect, it } from 'vitest';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { systemPrompt } from '../src/main/agent/prompts';
import { browseFocus, PC_TOOLS, selectTools, TOOL_GROUPS, parseGroups } from '../src/main/agent/toolGroups';
import type { ToolGroup } from '../src/main/agent/toolGroups';
import { ConversationContext } from '../src/main/context/ConversationContext';
import type { AIChatMessage, AICompletion, AIProvider, AIToolSpec } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import type { Tool, ToolResult } from '../src/main/tools/types';

/**
 * Every step of an agent request carries the schemas of all its tools and the whole of the instructions. A request about a website does not need the
 * tools and instructions about the PC itself (other applications, windows, files and folders, the clipboard) on every one of its steps: once it has begun
 * working in the browser and has stayed in the web, they are set aside, and anything that shows the request is also about the PC brings them straight back.
 */

const browser: ReadonlySet<ToolGroup> = new Set(['browser']);
const base = { groups: browser, text: 'tell me how many cases listed for monday, check in high court of telangana advocate code is 21295', toolsUsed: ['find_and_open_website'], sawFile: false, pcOn: false };

describe('when a request settles into the browser', () => {
  it('is focused once it has been working only in the browser and the web, about nothing on the PC', () => {
    expect(browseFocus(base)).toBe(true);
    expect(browseFocus({ ...base, toolsUsed: ['find_and_open_website', 'click_on_page', 'fill_on_page', 'read_page', 'web_search', 'open_url'] })).toBe(true);
    expect(browseFocus({ ...base, groups: new Set<ToolGroup>(['browser', 'research']), toolsUsed: ['deep_research', 'click_on_page'] })).toBe(true);
  });

  it('never narrows the first step (nothing has been used yet)', () => {
    expect(browseFocus({ ...base, toolsUsed: [] })).toBe(false);
  });

  it('is not focused when the request is not only about the web', () => {
    for (const text of ['download the cause list pdf from the high court site', 'open the court site and save the file to my desktop', 'check the site and copy the number', 'go to the site and close the window', 'open my resume on the portal']) {
      expect(browseFocus({ ...base, text }), text).toBe(false);
    }
    for (const groups of [['browser', 'chat'], ['browser', 'files'], ['browser', 'word'], ['browser', 'screen'], ['browser', 'system'], ['browser', 'memory']] as const) {
      expect(browseFocus({ ...base, groups: new Set<ToolGroup>(groups) }), groups.join()).toBe(false);
    }
    expect(browseFocus({ ...base, groups: new Set<ToolGroup>() })).toBe(false);
  });

  it('is not focused once anything outside the web has been used, a file has turned up, or the model asked for the PC tools', () => {
    expect(browseFocus({ ...base, toolsUsed: ['find_and_open_website', 'find_file'] })).toBe(false);
    expect(browseFocus({ ...base, toolsUsed: ['find_and_open_website', 'window_control'] })).toBe(false);
    expect(browseFocus({ ...base, sawFile: true })).toBe(false);
    expect(browseFocus({ ...base, pcOn: true })).toBe(false);
  });
});

describe('what is set aside', () => {
  const all = [...PC_TOOLS, 'find_and_open_website', 'open_url', 'web_search', 'download_file', 'analyze_document', 'read_file', 'click_on_page', 'delete_file'].map((name) => ({ name }));

  it('is the tools about the PC itself; the web, the downloads and the reading of a file stay', () => {
    const names = selectTools(all, new Set<ToolGroup>(['browser']), undefined, true).map((t) => t.name);
    for (const gone of PC_TOOLS) expect(names, gone).not.toContain(gone);
    for (const kept of ['find_and_open_website', 'open_url', 'web_search', 'download_file', 'analyze_document', 'read_file', 'click_on_page']) expect(names, kept).toContain(kept);
  });

  it('is nothing at all unless it is asked for', () => {
    expect(selectTools(all, new Set<ToolGroup>(['browser'])).map((t) => t.name)).toContain('find_file');
    expect(selectTools(all, new Set<ToolGroup>(['browser']), undefined, false).map((t) => t.name)).toContain('window_control');
  });

  it('the instructions about it go too, and the model is told how to get it back', () => {
    const now = new Date('2026-10-24T10:00:00Z');
    const groups = new Set<ToolGroup>(['browser']);
    const full = systemPrompt(now, groups);
    const focused = systemPrompt(now, groups, undefined, true);
    expect(full).toContain('Finding and opening files anywhere on the PC');
    expect(full).toContain('Windows and applications that are already open');
    expect(focused).not.toContain('Finding and opening files anywhere on the PC');
    expect(focused).not.toContain('When several files could match');
    expect(focused).not.toContain('Opening applications: the real app');
    expect(focused).not.toContain('Windows and applications that are already open');
    expect(focused).toContain('pc = ');
    expect(focused).toContain('load_tools');
    // what stays: the rules about destructive actions, honesty, the web
    expect(focused).toContain('Destructive or overwriting actions');
    expect(focused).toContain('Acting like a capable human assistant on the web');
    expect(focused.length).toBeLessThan(full.length - 3000);
  });

  it('is asked for with load_tools pc (and "all" brings it too)', () => {
    expect(parseGroups('pc').pc).toBe(true);
    expect(parseGroups('browser, pc').pc).toBe(true);
    expect(parseGroups('all').pc).toBe(true);
    expect(parseGroups('browser').pc).toBe(false);
    expect(parseGroups('all').groups.size).toBe(TOOL_GROUPS.length);
  });
});

// ---- the engine ------------------------------------------------------------------------------------------------------------------------

class RecordingAI implements AIProvider {
  readonly name = 'recording';
  readonly toolNames: string[][] = [];
  readonly systems: string[] = [];
  constructor(private readonly script: AICompletion[]) {}
  isReady(): boolean {
    return true;
  }
  async complete(messages: readonly AIChatMessage[], tools: readonly AIToolSpec[]): Promise<AICompletion> {
    this.toolNames.push(tools.map((t) => t.name));
    this.systems.push(String(messages[0]?.content ?? ''));
    const next = this.script.shift();
    if (next === undefined) throw new Error('script exhausted');
    return next;
  }
}

const quietTTS: TTSProvider = { name: 'quiet', init: async () => undefined, speak: async () => undefined, prefetch: () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };

describe('engine: a request about a website', () => {
  let tools: ToolRegistry;
  let answers: Record<string, ToolResult>;
  beforeEach(() => {
    tools = new ToolRegistry();
    answers = {};
    const names = ['find_file', 'open_file', 'window_control', 'clipboard_read', 'web_search', 'read_file', 'find_and_open_website', 'open_website', 'click_on_page', 'fill_on_page', 'read_page', 'download_from_site', 'set_volume'];
    for (const name of names) {
      const tool: Tool = { schema: { name, description: name, args: {}, status: name }, execute: async () => answers[name] ?? { ok: true, summary: `${name} done` } };
      tools.register(tool);
    }
  });
  const ask = (ai: AIProvider, text: string) =>
    new AgentEngine({ router: new IntentRouter(), tools, composer: new ResponseComposer(), tts: quietTTS, context: new ConversationContext(), ai, now: () => new Date('2026-10-24T12:00:00Z') }).handle({ requestId: 'r', text, source: 'text' }, () => undefined);
  const call = (name: string, args: Record<string, string> = {}): AICompletion => ({ text: '', toolCalls: [{ id: name, name, args }] });
  const COURT = 'tell me how many cases listed for monday, check in high court of telangana advocate code is 21295';

  it('chooses from everything on the first step, then goes on without the PC tools and their instructions', async () => {
    const ai = new RecordingAI([call('find_and_open_website', { name: 'High Court of Telangana' }), call('click_on_page'), call('fill_on_page'), { text: 'Twelve cases are listed.', toolCalls: [] }]);
    const result = await ask(ai, COURT);
    expect(ai.toolNames[0]).toContain('find_file');
    expect(ai.toolNames[0]).toContain('window_control');
    for (const step of [1, 2, 3]) {
      for (const gone of ['find_file', 'open_file', 'window_control', 'clipboard_read']) expect(ai.toolNames[step], `${gone} at step ${step}`).not.toContain(gone);
      expect(ai.toolNames[step]).toContain('click_on_page');
      expect(ai.toolNames[step]).toContain('web_search');
      expect(ai.toolNames[step]).toContain('read_file');
      expect(ai.toolNames[step]).toContain('load_tools');
      expect(ai.systems[step]).not.toContain('Finding and opening files anywhere on the PC');
      expect(ai.systems[step]).toContain('pc = ');
    }
    expect(ai.systems[0]).toContain('Finding and opening files anywhere on the PC');
    expect(result.spoken).toContain('Twelve cases');
  });

  it('every step after the first is smaller for it', async () => {
    const ai = new RecordingAI([call('find_and_open_website'), call('click_on_page'), { text: 'ok', toolCalls: [] }]);
    await ask(ai, COURT);
    const size = (step: number): number => (ai.systems[step] ?? '').length + (ai.toolNames[step] ?? []).join('').length;
    expect(size(1)).toBeLessThan(size(0) - 3000);
  });

  it('the model can ask for the PC tools back with load_tools pc, and gets them with their instructions', async () => {
    const ai = new RecordingAI([call('find_and_open_website'), call('click_on_page'), call('load_tools', { groups: 'pc' }), call('find_file'), { text: 'Found it.', toolCalls: [] }]);
    await ask(ai, COURT);
    expect(ai.toolNames[1]).not.toContain('find_file');
    expect(ai.toolNames[3]).toContain('find_file');
    expect(ai.systems[3]).toContain('Finding and opening files anywhere on the PC');
    expect(ai.systems[3]).not.toContain('pc = ');
    // (and it stays back for the rest of the request)
    expect(ai.toolNames[4]).toContain('find_file');
  });

  it('a request with a PC word in it is never narrowed', async () => {
    const ai = new RecordingAI([call('find_and_open_website'), call('click_on_page'), { text: 'ok', toolCalls: [] }]);
    await ask(ai, 'open the high court site and save the monday cause list pdf');
    for (const step of [0, 1, 2]) expect(ai.toolNames[step], `step ${step}`).toContain('find_file');
  });

  it('a file that turns up (a finished download) brings the PC tools back for the next step', async () => {
    answers['download_from_site'] = { ok: true, summary: 'downloaded', data: { name: 'list.pdf', path: 'C:\\Users\\x\\Downloads\\list.pdf', verified: true } };
    const ai = new RecordingAI([call('find_and_open_website'), call('click_on_page'), call('download_from_site'), { text: 'Saved.', toolCalls: [] }]);
    await ask(ai, 'find the monday cause list of the telangana high court and count the cases');
    expect(ai.toolNames[1]).not.toContain('find_file');
    expect(ai.toolNames[2]).not.toContain('find_file');
    expect(ai.toolNames[3]).toContain('find_file');
    expect(ai.toolNames[3]).toContain('open_file');
  });

  it('a request that is not about the web is not touched', async () => {
    const ai = new RecordingAI([call('find_file'), call('open_file'), { text: 'Done.', toolCalls: [] }]);
    await ask(ai, 'find my latest invoice and open it');
    for (const step of [0, 1, 2]) expect(ai.toolNames[step], `step ${step}`).toContain('find_file');
  });

  it('"I can\'t do that" at the very first answer still switches everything on and asks again, with the PC tools', async () => {
    const ai = new RecordingAI([{ text: "I'm sorry, I can't do that.", toolCalls: [] }, { text: 'Done.', toolCalls: [] }]);
    await ask(ai, 'check the high court website for monday');
    expect(ai.toolNames[1]).toContain('find_file');
    expect(ai.toolNames[1]).toContain('set_volume');
  });
});
