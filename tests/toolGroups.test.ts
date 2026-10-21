import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { systemPrompt } from '../src/main/agent/prompts';
import {
  classifiedTools,
  groupOfTool,
  parseGroups,
  routeGroups,
  selectTools,
  TOOL_GROUPS,
} from '../src/main/agent/toolGroups';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { ConversationContext } from '../src/main/context/ConversationContext';
import type { AIChatMessage, AICompletion, AIProvider, AIToolSpec } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import type { Tool, ToolResult } from '../src/main/tools/types';

describe('every tool has a group', () => {
  it('lists each tool name written in src/main/tools/impl in the group table', () => {
    const dir = join(__dirname, '..', 'src', 'main', 'tools', 'impl');
    const names = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(dir, file), 'utf8');
      for (const m of src.matchAll(/\bname: '([a-z][a-z_]+)'/g)) names.add(m[1] as string);
    }
    expect(names.size).toBeGreaterThan(60);
    const known = new Set(classifiedTools());
    const missing = [...names].filter((n) => !known.has(n));
    expect(missing).toEqual([]);
  });

  it('knows no tool that does not exist (typos would silently make a tool core)', () => {
    const dir = join(__dirname, '..', 'src', 'main', 'tools', 'impl');
    const all = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    const stale = classifiedTools().filter((n) => !all.includes(`name: '${n}'`));
    expect(stale).toEqual([]);
  });

  it('treats an unclassified tool as core, so it is never hidden', () => {
    expect(groupOfTool('some_new_tool')).toBe('core');
  });
});

describe('routeGroups', () => {
  it('sends only the core when the words point at nothing in particular', () => {
    expect([...routeGroups('find the invoice pdf from yesterday')]).toEqual([]);
    expect([...routeGroups('what is the weather like')]).toEqual([]);
  });

  it('knows tidying a folder is file work', () => {
    expect([...routeGroups('organise my downloads folder')]).toEqual(['files']);
  });

  it('sends only Word for Word work', () => {
    expect([...routeGroups('fill the running index in my writ')]).toEqual(['word']);
    expect([...routeGroups('go to page 10')]).toEqual(['word']);
    expect([...routeGroups('make the heading bold and centre it')]).toEqual(['word']);
    expect([...routeGroups('add page numbers')]).toEqual(['word']);
  });

  it('sends only the PC controls for volume and the like', () => {
    expect([...routeGroups('turn the volume down')]).toEqual(['system']);
    expect([...routeGroups('lock the screen')].sort()).toEqual(['screen', 'system']);
  });

  it('brings the browser along with chat apps, which are web apps', () => {
    expect([...routeGroups('send hello to Akka on whatsapp')].sort()).toEqual(['browser', 'chat']);
  });

  it('adds the memory tools for a short yes/no answer and for the area the last turn used', () => {
    expect(routeGroups('yes').has('memory')).toBe(true);
    expect(routeGroups('find my pdf').has('memory')).toBe(false);
    const g = routeGroups('now make it italic too', { recentTools: ['word_write', 'find_file'] });
    expect(g.has('word')).toBe(true);
    const h = routeGroups('thanks', { recentTools: ['screen_click'] });
    expect(h.has('screen')).toBe(true);
  });

  it('sends everything for a job that spans four or more areas', () => {
    const g = routeGroups('send my word petition on whatsapp and lock the screen and remember it');
    expect([...g].sort()).toEqual([...TOOL_GROUPS].sort());
  });
});

describe('parseGroups', () => {
  it('reads names separated by commas, spaces or "and", singular or plural', () => {
    expect([...parseGroups('word, files').groups].sort()).toEqual(['files', 'word']);
    expect([...parseGroups('browser and chat').groups].sort()).toEqual(['browser', 'chat']);
    expect([...parseGroups('screens').groups]).toEqual(['screen']);
  });
  it('understands all, a few everyday synonyms, and returns what it could not place', () => {
    expect(parseGroups('all').groups.size).toBe(TOOL_GROUPS.length);
    expect([...parseGroups('whatsapp').groups]).toEqual(['chat']);
    const r = parseGroups('banana');
    expect(r.groups.size).toBe(0);
    expect(r.unknown).toEqual(['banana']);
  });
});

describe('selectTools', () => {
  it('keeps core always and a group only when it is switched on', () => {
    const all = [{ name: 'find_file' }, { name: 'open_website' }, { name: 'word_read' }, { name: 'set_volume' }];
    expect(selectTools(all, new Set()).map((t) => t.name)).toEqual(['find_file']);
    expect(selectTools(all, new Set(['word'] as const)).map((t) => t.name)).toEqual(['find_file', 'word_read']);
  });
});

describe('systemPrompt with groups', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  it('without groups is the whole prompt (what Talk mode and older callers get)', () => {
    const full = systemPrompt(now);
    expect(full).toContain('Navigating a website');
    expect(full).toContain('Microsoft Word (the document');
    expect(full).not.toContain('switched off');
  });
  it('leaves out the parts that were not asked for, and says what can be switched on', () => {
    const p = systemPrompt(now, new Set(['word'] as const));
    expect(p).toContain('Microsoft Word (the document');
    expect(p).not.toContain('Navigating a website');
    expect(p).not.toContain('The Recycle Bin');
    expect(p).toContain('load_tools');
    expect(p).toContain('browser = ');
    expect(p).not.toContain('word = ');
    expect(p).toContain('How to act');
    expect(p).toContain('Now: ');
    expect(p.length).toBeLessThan(systemPrompt(now).length * 0.5);
  });
  it('has no switched-off line when every group is on', () => {
    expect(systemPrompt(now, new Set(TOOL_GROUPS))).toBe(systemPrompt(now));
  });
});

// ---- the engine: only the asked-for tools are sent, and load_tools switches more on -----------------------------------------------------

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

const quietTTS: TTSProvider = {
  name: 'quiet',
  init: async () => undefined,
  speak: async () => undefined,
  prefetch: () => undefined,
  stop: () => undefined,
  isReady: () => true,
  dispose: async () => undefined,
};

function fake(name: string, onRun?: () => void): Tool {
  return {
    schema: { name, description: name, args: {}, status: name },
    async execute(): Promise<ToolResult> {
      onRun?.();
      return { ok: true, summary: `${name} done` };
    },
  };
}

describe('engine: tools per request', () => {
  let tools: ToolRegistry;
  let ran: string[];
  beforeEach(() => {
    tools = new ToolRegistry();
    ran = [];
    for (const n of ['find_file', 'open_website', 'word_read', 'set_volume', 'describe_screen', 'remember']) {
      tools.register(fake(n, () => ran.push(n)));
    }
  });
  const engine = (ai: AIProvider): AgentEngine =>
    new AgentEngine({
      router: new IntentRouter(),
      tools,
      composer: new ResponseComposer(),
      tts: quietTTS,
      context: new ConversationContext(),
      ai,
      now: () => new Date('2026-10-10T12:00:00Z'),
    });
  const ask = (e: AgentEngine, text: string) => e.handle({ requestId: 'r', text, source: 'text' }, () => undefined);

  it('sends the core and the asked-for group plus load_tools, not the rest', async () => {
    const ai = new RecordingAI([{ text: 'Done.', toolCalls: [] }]);
    await ask(engine(ai), 'go to page 10 in the petition');
    const sent = ai.toolNames[0] ?? [];
    expect(sent).toContain('find_file');
    expect(sent).toContain('word_read');
    expect(sent).toContain('load_tools');
    expect(sent).not.toContain('set_volume');
    expect(sent).not.toContain('open_website');
    expect(ai.systems[0]).not.toContain('Navigating a website');
  });

  it('load_tools adds the group from the next step, and is not counted as a step the user asked for', async () => {
    const ai = new RecordingAI([
      { text: '', toolCalls: [{ id: 'a', name: 'load_tools', args: { groups: 'system' } }] },
      { text: '', toolCalls: [{ id: 'b', name: 'set_volume', args: {} }] },
      { text: 'Volume is lower.', toolCalls: [] },
    ]);
    const result = await ask(engine(ai), 'open the cause list pdf');
    expect(ai.toolNames[0]).not.toContain('set_volume');
    expect(ai.toolNames[1]).toContain('set_volume');
    expect(ai.systems[1]).toContain('System power actions');
    expect(ran).toEqual(['set_volume']);
    expect(result.spoken).toContain('Volume is lower');
  });

  it('asks again with everything on when the model says it cannot while abilities are off', async () => {
    const ai = new RecordingAI([
      { text: "Sorry, I can't change the volume.", toolCalls: [] },
      { text: '', toolCalls: [{ id: 'a', name: 'set_volume', args: {} }] },
      { text: 'Done, volume changed.', toolCalls: [] },
    ]);
    const result = await ask(engine(ai), 'banana please');
    expect(ai.toolNames[0]).not.toContain('set_volume');
    expect(ai.toolNames[1]).toContain('set_volume');
    expect(ai.toolNames[1]).not.toContain('load_tools');
    expect(ran).toEqual(['set_volume']);
    expect(result.spoken).toContain('volume changed');
  });

  it('does not offer load_tools once everything is on', async () => {
    const ai = new RecordingAI([{ text: 'ok', toolCalls: [] }]);
    await ask(engine(ai), 'send my word petition on whatsapp and lock the screen and remember it');
    expect(ai.toolNames[0]).not.toContain('load_tools');
    expect(ai.toolNames[0]).toContain('set_volume');
  });

  it('answers an unknown group name with the list of choices instead of failing the request', async () => {
    const ai = new RecordingAI([
      { text: '', toolCalls: [{ id: 'a', name: 'load_tools', args: { groups: 'banana' } }] },
      { text: 'No such thing.', toolCalls: [] },
    ]);
    const result = await ask(engine(ai), 'banana please');
    expect(result.spoken).toContain('No such thing');
    expect(ran).toEqual([]);
  });
});
