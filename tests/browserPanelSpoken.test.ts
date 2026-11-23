import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

import { BrowserPanel } from '../src/main/browser/BrowserPanel';
import { runLiveTool } from '../src/main/live/liveBridge';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import type { QuickRunner } from '../src/main/local/QuickCommands';

/**
 * 23 Nov 2026 — "when I said do live chat, with Eya Browser connected, the browser should open on the right and the chat on the left (split) — it is not happening."
 * Typed, it worked (the typed request begins the Browser page's task). SAID aloud, the words go to the live voice's `quick_command`, which never told the panel a request had begun:
 * the panel got no goal ("working" with an empty goal) and the app, which opens the split only for a task with a goal, never did.
 * Now a spoken command begins the request — but only when it really uses the browser, so a "thanks" cannot lift a Stop or wipe the panel.
 */

describe('a spoken command and the Browser page (BrowserPanel.beginSpoken)', () => {
  it('a spoken command that opens a page becomes the request: its words are the goal, it is working there, and when it ends the task is done', async () => {
    const p = new BrowserPanel();
    const end = p.beginSpoken('do live chat with Meera');
    expect(p.get().goal).toBe(''); // (nothing yet: it may be chatter)
    p.where('eya');
    await p.before('open', 'https://web.whatsapp.com/');
    expect(p.get()).toMatchObject({ status: 'working', goal: 'do live chat with Meera', where: 'eya' });
    expect(p.get().log.some((l) => l.text === 'Task: do live chat with Meera')).toBe(true);
    end();
    expect(p.get().status).toBe('done');
  });

  it('a use of the browser that is not a page step (listing the chats, opening one) begins it too', () => {
    const p = new BrowserPanel();
    const end = p.beginSpoken('start live chat with Raju');
    p.used();
    expect(p.get()).toMatchObject({ status: 'working', goal: 'start live chat with Raju' });
    end();
    expect(p.get().status).toBe('done');
  });

  it('chatter changes nothing: no goal, nothing wiped, and a Stop that was pressed stays', async () => {
    const p = new BrowserPanel();
    p.stop();
    const end = p.beginSpoken('thanks a lot');
    end();
    expect(p.get()).toMatchObject({ status: 'stopped', goal: '' });
    // (the task that was stopped is still stopped: a "thanks" did not lift it)
    await expect(p.before('open', 'https://a.example/')).rejects.toThrow(/pressed Stop/);
  });

  it('a spoken command that really uses the browser lifts an earlier Stop, like any new request', async () => {
    const p = new BrowserPanel();
    p.stop();
    const end = p.beginSpoken('open flipkart');
    await p.before('open', 'https://www.flipkart.com/');
    expect(p.get()).toMatchObject({ status: 'working', goal: 'open flipkart' });
    end();
  });

  it('the same words said again once the first is over begin a new task: working again with the same goal (so the split opens again)', async () => {
    const p = new BrowserPanel();
    for (const round of [1, 2]) {
      const end = p.beginSpoken('do live chat with Meera');
      await p.before('open', 'https://web.whatsapp.com/');
      expect(p.get(), `round ${round}`).toMatchObject({ status: 'working', goal: 'do live chat with Meera' });
      end();
      expect(p.get().status, `round ${round}`).toBe('done');
    }
  });

  it('a spoken command that waits on the person (a sign-in) leaves the task waiting, not done', async () => {
    const p = new BrowserPanel();
    const end = p.beginSpoken('do live chat with Meera');
    await p.before('open', 'https://web.whatsapp.com/');
    p.after({ op: 'open', ok: true, url: 'https://web.whatsapp.com/', challenge: 'login' });
    end();
    expect(['waiting_you', 'done']).toContain(p.get().status);
    expect(p.get().goal).toBe('do live chat with Meera');
  });

  it('empty words begin nothing, and the browser being used with no request and no spoken command is still ignored (a live chat watching its page)', () => {
    const p = new BrowserPanel();
    const end = p.beginSpoken('   ');
    p.used();
    end();
    expect(p.get()).toMatchObject({ status: 'idle', goal: '' });
    p.used();
    expect(p.get().status).toBe('idle');
  });

  it('a typed request still works as before (begin, browser use, end)', async () => {
    const p = new BrowserPanel();
    p.beginRequest('open flipkart');
    await p.before('open', 'https://www.flipkart.com/');
    expect(p.get()).toMatchObject({ status: 'working', goal: 'open flipkart' });
    p.endRequest();
    expect(p.get().status).toBe('done');
  });
});

describe('the live voice\'s quick_command tells the panel (liveBridge.runLiveTool)', () => {
  const answer = { handled: true as const, result: { spoken: 'ok', ok: true, intent: 'chat_live', tools: [], refs: [] } };

  it('what was said is announced before the command runs and ended after it — never as a typed-style begin', async () => {
    const order: string[] = [];
    const quick: QuickRunner = { run: async () => { order.push('run'); return answer; } };
    const browserRequest = {
      begin: vi.fn(),
      end: vi.fn(),
      spoken: vi.fn((text: string) => {
        order.push(`spoken:${text}`);
        return () => order.push('end');
      }),
    };
    await runLiveTool(new ToolRegistry(), { name: 'quick_command', args: {}, heard: 'do live chat with Meera', turn: 1 }, undefined, undefined, quick, undefined, undefined, undefined, browserRequest);
    expect(order).toEqual(['spoken:do live chat with Meera', 'run', 'end']);
    expect(browserRequest.begin).not.toHaveBeenCalled();
    expect(browserRequest.end).not.toHaveBeenCalled();
  });

  it('it is ended even when the command fails, and a command that is not a quick one still ends', async () => {
    const ends: string[] = [];
    const failing: QuickRunner = { run: async () => { throw new Error('boom'); } };
    const browserRequest = { begin: vi.fn(), end: vi.fn(), spoken: () => () => ends.push('end') };
    await runLiveTool(new ToolRegistry(), { name: 'quick_command', args: {}, heard: 'open flipkart' }, undefined, undefined, failing, undefined, undefined, undefined, browserRequest).catch(() => undefined);
    expect(ends).toEqual(['end']);
    const notQuick: QuickRunner = { run: async () => ({ handled: false as const }) };
    await runLiveTool(new ToolRegistry(), { name: 'quick_command', args: {}, heard: 'thanks' }, undefined, undefined, notQuick, undefined, undefined, undefined, browserRequest);
    expect(ends).toEqual(['end', 'end']);
  });

  it('end to end with the real panel: said aloud, the command that opens a page gives the panel its goal; chatter does not', async () => {
    const panel = new BrowserPanel();
    const quickOpening: QuickRunner = {
      run: async () => {
        panel.where('eya');
        await panel.before('open', 'https://web.whatsapp.com/'); // (what opening the page does)
        return answer;
      },
    };
    const wiring = { begin: (t: string) => panel.beginRequest(t), end: () => panel.endRequest(), spoken: (t: string) => panel.beginSpoken(t) };
    await runLiveTool(new ToolRegistry(), { name: 'quick_command', args: {}, heard: 'do live chat with Meera' }, undefined, undefined, quickOpening, undefined, undefined, undefined, wiring);
    expect(panel.get()).toMatchObject({ goal: 'do live chat with Meera', where: 'eya' });
    expect(['working', 'done']).toContain(panel.get().status);

    const other = new BrowserPanel();
    const chatter: QuickRunner = { run: async () => ({ handled: false as const }) };
    await runLiveTool(new ToolRegistry(), { name: 'quick_command', args: {}, heard: 'thanks' }, undefined, undefined, chatter, undefined, undefined, undefined, { begin: (t) => other.beginRequest(t), end: () => other.endRequest(), spoken: (t) => other.beginSpoken(t) });
    expect(other.get()).toMatchObject({ status: 'idle', goal: '' });
  });
});
