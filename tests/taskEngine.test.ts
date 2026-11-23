import { describe, expect, it } from 'vitest';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { bindToTask, pinnedHome, pinnedTab, runAsTask } from '../src/main/browser/tabScope';
import { ConversationContext } from '../src/main/context/ConversationContext';
import type { AIChatMessage, AICompletion, AIProvider } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';
import type { AgentRequest } from '../src/shared/types';

/**
 * Two tasks of the Tasks page at the same time, through the real engine: each runs in a place of its own (its tab), however many steps and tool calls deep, and neither sees the other's.
 * A plain request is not scoped at all.
 */

const quietTTS: TTSProvider = {
  name: 'quiet',
  init: async () => undefined,
  speak: async () => undefined,
  prefetch: () => undefined,
  stop: () => undefined,
  isReady: () => true,
  dispose: async () => undefined,
};

const ARGS = { url: { type: 'string' as const }, text: { type: 'string' as const } };
const tool = (name: string, respond: (args: ToolArgs) => Promise<ToolResult>): Tool => ({ schema: { name, description: name, args: ARGS, status: name }, execute: respond });

/** Step 1: open the site named in the request; step 2: click; then say it is done. (Decided by what the conversation holds, so two requests at once do not disturb each other.) */
class Steps implements AIProvider {
  readonly name = 'steps';
  isReady(): boolean {
    return true;
  }
  async complete(messages: readonly AIChatMessage[]): Promise<AICompletion> {
    const asked = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const done = messages.filter((m) => m.role === 'tool').length;
    const site = /site(\w+)/.exec(asked)?.[0] ?? 'siteX';
    await new Promise((r) => setTimeout(r, 3));
    if (done === 0) return { text: '', toolCalls: [{ id: `o-${site}`, name: 'open_website', args: { url: `https://${site}.example/` } }] };
    if (done === 1) return { text: '', toolCalls: [{ id: `c-${site}`, name: 'click_on_page', args: { text: 'Go' } }] };
    return { text: `Finished ${site}.`, toolCalls: [] };
  }
}

function setup() {
  const places = new Map<string, { tab: number | null; home: 'chrome' | 'edge' | 'eya' | null }>();
  const clicked: Array<{ site: string; tab: number | null; home: string | null }> = [];
  let nextTab = 100;
  const tools = new ToolRegistry();
  tools.register(
    tool('open_website', async (a) => {
      await new Promise((r) => setTimeout(r, 2));
      // (what the browser does when a task opens its first page: it gets a tab and keeps it)
      if (pinnedTab() === null) bindToTask((nextTab += 1), 'eya');
      return { ok: true, summary: `opened ${String(a['url'])}` };
    }),
  );
  tools.register(
    tool('click_on_page', async () => {
      await new Promise((r) => setTimeout(r, 2));
      clicked.push({ site: '', tab: pinnedTab(), home: pinnedHome() });
      return { ok: true, summary: 'clicked' };
    }),
  );
  const engine = new AgentEngine({
    router: new IntentRouter(),
    tools,
    composer: new ResponseComposer(),
    tts: quietTTS,
    context: new ConversationContext(),
    ai: new Steps(),
    scope: (req, run) => {
      const id = req.task?.id as string;
      return runAsTask(places.get(id) ?? { tab: null, home: null }, (tab, home) => places.set(id, { tab, home }), run);
    },
    now: () => new Date('2026-11-09T10:00:00Z'),
  });
  return { engine, places, clicked };
}

const task = (id: string, text: string): AgentRequest => ({ requestId: `r-${id}`, text, source: 'text', mode: 'agent', task: { id } });

describe('tasks at the same time through the engine', () => {
  it('each task works in its own tab, all through its steps, and the places are remembered for the task', async () => {
    const { engine, places, clicked } = setup();
    const [a, b] = await Promise.all([
      engine.handle(task('a', 'do the job on siteOne now please'), () => undefined),
      engine.handle(task('b', 'do the job on siteTwo now please'), () => undefined),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(places.get('a')).toMatchObject({ home: 'eya' });
    expect(places.get('b')).toMatchObject({ home: 'eya' });
    expect(places.get('a')?.tab).not.toBe(places.get('b')?.tab);
    // (the click of each task landed in that task's tab)
    const tabs = clicked.map((c) => c.tab).sort();
    expect(tabs).toEqual([places.get('a')?.tab, places.get('b')?.tab].sort());
    expect(clicked.every((c) => c.home === 'eya')).toBe(true);
  });

  it('a task that runs again (a retry, an answer) goes on in the tab it had', async () => {
    const { engine, places, clicked } = setup();
    await engine.handle(task('a', 'do the job on siteOne now please'), () => undefined);
    const first = places.get('a')?.tab;
    await engine.handle({ ...task('a', 'do the job on siteOne now please'), requestId: 'r-a-2' }, () => undefined);
    expect(places.get('a')?.tab).toBe(first);
    expect(clicked.map((c) => c.tab)).toEqual([first, first]);
  });

  it('a plain request (not a task) is not scoped: its browser work is pinned to nothing', async () => {
    const { engine, clicked } = setup();
    await engine.handle({ requestId: 'plain', text: 'do the job on siteOne now please', source: 'text', mode: 'agent' }, () => undefined);
    expect(clicked.map((c) => c.tab)).toEqual([null]);
  });
});
