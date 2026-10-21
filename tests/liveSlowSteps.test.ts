import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

import { runLiveTool } from '../src/main/live/liveBridge';
import type { LiveTaskKeeper } from '../src/main/live/liveBridge';
import { QuickCommands } from '../src/main/local/QuickCommands';
import type { QuickLayer } from '../src/main/local/QuickCommands';
import type { LocalCommandResult } from '../src/main/local/LocalCommands';
import { TaskCompleter } from '../src/main/tasks/TaskCompleter';
import type { TaskNotice } from '../src/main/tasks/TaskCompleter';
import { TaskStore } from '../src/main/tasks/TaskStore';
import type { StoreIo } from '../src/main/privacy/communicationAccessStore';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import type { Tool } from '../src/main/tools/types';
import type { AgentResult } from '../src/shared/types';

const parse = (content: string): { ok: boolean; summary: string; data?: Record<string, unknown> } => JSON.parse(content);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Adopted {
  request: string;
  source: string;
  work: Promise<AgentResult>;
}
function keeper(): { tasks: LiveTaskKeeper; adopted: Adopted[] } {
  const adopted: Adopted[] = [];
  return {
    adopted,
    tasks: {
      adopt: (request, source, work) => {
        adopted.push({ request, source, work });
        return `t${adopted.length}`;
      },
    },
  };
}

const slowTool = (name: string, ms: number, ok = true): ToolRegistry => {
  const tools = new ToolRegistry();
  const tool: Tool = {
    schema: { name, description: name, args: { url: { type: 'string', required: false } }, status: name },
    execute: async () => {
      await sleep(ms);
      return { ok, summary: ok ? 'opened' : 'failed' };
    },
  };
  tools.register(tool);
  return tools;
};

const quickWith = (r: LocalCommandResult | null, ms: number): QuickCommands =>
  new QuickCommands([
    {
      tryHandle: async () => {
        await sleep(ms);
        return r;
      },
    },
  ]);

const live = (heard: string | undefined, name = 'quick_command', args: Record<string, unknown> = {}) => ({ name, args, ...(heard !== undefined ? { heard } : {}), turn: 1 });

describe('a slow step in a live conversation is kept, not dropped', () => {
  it('a slow quick command is handed to the task completer, and the model is told it is going on (not that it failed)', async () => {
    const { tasks, adopted } = keeper();
    const quick = quickWith({ spoken: 'Found Akka. Send the file "bill.pdf"?', ok: true, intent: 'chat_file', tools: ['find_chat'], refs: [] }, 60);
    const out = parse((await runLiveTool(new ToolRegistry(), live('send the bill to Akka on whatsapp'), 20, undefined, quick, undefined, undefined, tasks)).content);
    expect(out).toMatchObject({ ok: true, summary: 'still working', data: { stillWorking: true } });
    expect(String(out.data?.['next'])).toMatch(/Do NOT try it again/);
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ request: 'send the bill to Akka on whatsapp', source: 'live' });
    // when the work finishes, the question it ended with is waiting for the person's yes
    expect(await adopted[0]?.work).toMatchObject({ ok: true, spoken: 'Found Akka. Send the file "bill.pdf"?', pending: { kind: 'needs_you', asks: true } });
  });

  it('a late result that could not finish yet keeps its own signal; one that is plainly done carries none; "not mine" carries nothing at all', async () => {
    const a = keeper();
    const retrying: LocalCommandResult = { spoken: 'WhatsApp is slow.', ok: false, intent: 'chat_message', tools: [], refs: [], pending: { kind: 'retry', why: 'WhatsApp is still loading' } };
    await runLiveTool(new ToolRegistry(), live('message Akka hi'), 10, undefined, quickWith(retrying, 40), undefined, undefined, a.tasks);
    expect(await a.adopted[0]?.work).toMatchObject({ ok: false, pending: { kind: 'retry', why: 'WhatsApp is still loading' } });

    const b = keeper();
    await runLiveTool(new ToolRegistry(), live('open youtube'), 10, undefined, quickWith({ spoken: 'Opened YouTube.', ok: true, intent: 'open_site', tools: [], refs: [] }, 40), undefined, undefined, b.tasks);
    const done = await b.adopted[0]?.work;
    expect(done).toMatchObject({ ok: true, spoken: 'Opened YouTube.' });
    expect(done?.pending).toBeUndefined();

    const c = keeper();
    await runLiveTool(new ToolRegistry(), live('plan my weekend'), 10, undefined, quickWith(null, 40), undefined, undefined, c.tasks);
    expect(await c.adopted[0]?.work).toMatchObject({ ok: true, spoken: '' });
  });

  it('a slow ordinary tool is kept too: when it finishes late, the request is carried on from there', async () => {
    const { tasks, adopted } = keeper();
    const out = parse((await runLiveTool(slowTool('open_website', 50), live('open whatsapp and send the file', 'open_website', { url: 'https://web.whatsapp.com/' }), 15, undefined, undefined, undefined, undefined, tasks)).content);
    expect(out).toMatchObject({ summary: 'still working', data: { stillWorking: true } });
    expect(adopted[0]).toMatchObject({ request: 'open whatsapp and send the file', source: 'live' });
    const late = await adopted[0]?.work;
    expect(late?.pending).toMatchObject({ kind: 'retry', why: 'a slow step finished', retryAfterMs: 1000, steps: ['open_website https://web.whatsapp.com/'] });
  });

  it('a step that finishes in time is untouched, and nothing is kept', async () => {
    const { tasks, adopted } = keeper();
    const out = parse((await runLiveTool(slowTool('open_website', 5), live('open whatsapp', 'open_website'), 500, undefined, undefined, undefined, undefined, tasks)).content);
    expect(out).toMatchObject({ ok: true, summary: 'opened' });
    expect(adopted).toHaveLength(0);
  });

  it('without a task completer (or without the words the person said) it stops waiting as it always did', async () => {
    const plain = parse((await runLiveTool(slowTool('open_website', 80), live('open whatsapp', 'open_website'), 15)).content);
    expect(plain).toMatchObject({ ok: false, summary: 'timed out' });
    const { tasks, adopted } = keeper();
    const noWords = parse((await runLiveTool(slowTool('open_website', 80), live(undefined, 'open_website'), 15, undefined, undefined, undefined, undefined, tasks)).content);
    expect(noWords).toMatchObject({ ok: false, summary: 'timed out' });
    expect(adopted).toHaveLength(0);
  });
});

describe('asking again while the first is still going waits for the same answer', () => {
  it('does the thing once, even when the model calls again in the same turn while it is slow', async () => {
    let runs = 0;
    const quick = new QuickCommands([
      {
        tryHandle: async () => {
          runs += 1;
          await sleep(40);
          return { spoken: 'Found Akka. Send it?', ok: true, intent: 'chat_message', tools: [], refs: [] };
        },
      },
    ]);
    const [a, b] = await Promise.all([quick.run('message Akka hi', 3), quick.run('message Akka hi', 3)]);
    expect(runs).toBe(1);
    expect(a).toEqual(b);
  });

  it('a failure is not remembered: asking again tries again', async () => {
    let runs = 0;
    const quick = new QuickCommands([
      {
        tryHandle: async () => {
          runs += 1;
          if (runs === 1) throw new Error('boom');
          return { spoken: 'ok', ok: true, intent: 'x', tools: [], refs: [] };
        },
      },
    ]);
    await expect(quick.run('open youtube', 1)).rejects.toThrow('boom');
    expect((await quick.run('open youtube', 1)).handled).toBe(true);
    expect(runs).toBe(2);
  });
});

describe('from a slow step to a notification, through the real task completer', () => {
  it('the person is told, aloud and by notification, what the slow step came to - and the question still waits for their yes', async () => {
    const files = new Map<string, string>();
    const io: StoreIo = { read: (p) => files.get(p) ?? null, write: (p, t) => void files.set(p, t) };
    const notices: TaskNotice[] = [];
    const said: Array<[string, string]> = [];
    const completer = new TaskCompleter({
      store: new TaskStore('t.json', io),
      run: async () => ({ requestId: 'x', ok: true, spoken: 'x' }),
      notify: (n) => void notices.push(n),
      say: (t, k) => void said.push([t, k]),
    });
    const quick = quickWith({ spoken: 'Found Akka. Send the file "bill.pdf"?', ok: true, intent: 'chat_file', tools: [], refs: [] }, 50);
    const out = parse((await runLiveTool(new ToolRegistry(), live('send my bill to Akka'), 15, undefined, quick, undefined, undefined, completer)).content);
    expect(out.summary).toBe('still working');
    expect(completer.snapshot().items[0]).toMatchObject({ request: 'send my bill to Akka', state: 'running' });
    await sleep(120);
    expect(completer.snapshot().items[0]).toMatchObject({ state: 'needs_you', asks: true, note: 'Found Akka. Send the file "bill.pdf"?' });
    expect(said).toEqual([['Found Akka. Send the file "bill.pdf"?', 'ask']]);
    expect(notices).toEqual([expect.objectContaining({ kind: 'needs_you', title: 'Eya has a question' })]);
  });
});
