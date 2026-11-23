import { describe, it, expect } from 'vitest';
import { createCloseApplicationTool } from '../src/main/tools/impl/closeApplication';
import type { CloseApplicationDeps } from '../src/main/tools/impl/closeApplication';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';

interface World {
  /** Exes currently running. */
  running: Set<string>;
  explorerWindows: number;
  /** Apps that ignore a polite close (e.g. waiting on a "save changes?" box). */
  stubborn: Set<string>;
  closeRequests: string[];
  /** Subset of closeRequests that were forced. */
  forced: string[];
  explorerClosed: number;
}

function world(init: Partial<World> = {}): { w: World; deps: CloseApplicationDeps } {
  const w: World = {
    running: new Set(),
    explorerWindows: 0,
    stubborn: new Set(),
    closeRequests: [],
    forced: [],
    explorerClosed: 0,
    ...init,
  };
  const deps: CloseApplicationDeps = {
    isRunning: async (exe) => w.running.has(exe),
    requestClose: async (exe, force) => {
      w.closeRequests.push(exe);
      if (force) w.forced.push(exe);
      // A stubborn app ignores a polite request but cannot ignore being ended.
      if (force || !w.stubborn.has(exe)) w.running.delete(exe);
    },
    explorerWindowCount: async () => w.explorerWindows,
    closeExplorerWindows: async () => {
      w.explorerClosed += 1;
      w.explorerWindows = 0;
    },
    sleep: async () => undefined,
  };
  return { w, deps };
}

// The 3s grace period is real time; keep tests quick by letting it elapse only when needed.
const tool = (deps: CloseApplicationDeps) => createCloseApplicationTool(deps);

describe('close_application', () => {
  it('asks a running app to close and confirms it went away', async () => {
    const { w, deps } = world({ running: new Set(['notepad.exe']) });
    const result = await tool(deps).execute({ name: 'notepad' });
    expect(result.ok).toBe(true);
    expect(w.closeRequests).toEqual(['notepad.exe']);
  });

  it('says so when the app was not running, without touching anything', async () => {
    const { w, deps } = world();
    const result = await tool(deps).execute({ name: 'notepad' });
    expect(result.ok).toBe(true);
    expect(result.data?.['alreadyClosed']).toBe(true);
    expect(w.closeRequests).toEqual([]);
  });

  it('never force-kills: an app waiting on "save changes?" stays open and the user is told', async () => {
    const { w, deps } = world({ running: new Set(['notepad.exe']), stubborn: new Set(['notepad.exe']) });
    const started = Date.now();
    const result = await tool(deps).execute({ name: 'notepad' });
    expect(result.ok).toBe(false);
    expect(result.data).toEqual({ app: 'notepad', reason: 'still_open' });
    expect(w.closeRequests).toEqual(['notepad.exe']); // asked once, politely, and no more
    expect(w.forced).toEqual([]);
    expect(w.running.has('notepad.exe')).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900); // gave it the grace period
  }, 10_000);

  it('closes Calculator firmly, since it ignores a polite request and has nothing to save', async () => {
    const { w, deps } = world({ running: new Set(['CalculatorApp.exe']), stubborn: new Set(['CalculatorApp.exe']) });
    const result = await tool(deps).execute({ name: 'calculator' });
    expect(result.ok).toBe(true);
    expect(w.forced).toEqual(['CalculatorApp.exe']);
  });

  it('never forces a browser, which may hold unsaved forms', async () => {
    const { w, deps } = world({ running: new Set(['msedge.exe']), stubborn: new Set(['msedge.exe']) });
    const result = await tool(deps).execute({ name: 'edge' });
    expect(result.ok).toBe(false);
    expect(w.forced).toEqual([]);
  }, 10_000);

  it('closes only File Explorer windows, never explorer.exe (the taskbar and desktop)', async () => {
    const { w, deps } = world({ running: new Set(['explorer.exe']), explorerWindows: 2 });
    const result = await tool(deps).execute({ name: 'file explorer' });
    expect(result.ok).toBe(true);
    expect(w.explorerClosed).toBe(1);
    expect(w.closeRequests).toEqual([]); // explorer.exe was never sent a close
    expect(w.running.has('explorer.exe')).toBe(true); // the shell is still alive
  });

  it('with no Explorer windows open there is nothing to close, though explorer.exe is running', async () => {
    const { w, deps } = world({ running: new Set(['explorer.exe']), explorerWindows: 0 });
    const result = await tool(deps).execute({ name: 'explorer' });
    expect(result.data?.['alreadyClosed']).toBe(true);
    expect(w.explorerClosed).toBe(0);
  });

  it('reports a failure to send the close request', async () => {
    const { deps } = world({ running: new Set(['notepad.exe']) });
    const failing: CloseApplicationDeps = {
      ...deps,
      requestClose: async () => {
        throw new Error('access denied');
      },
    };
    const result = await tool(failing).execute({ name: 'notepad' });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('close failed');
  });

  it('rejects unknown apps and bad arguments', async () => {
    const { deps } = world();
    expect((await tool(deps).execute({ name: 'photoshop' })).ok).toBe(false);
    expect((await tool(deps).execute({ name: 7 as unknown as string })).ok).toBe(false);
  });
});

describe('spoken answer for a stubborn app', () => {
  it('says it may be waiting for you to save', () => {
    const say = new ResponseComposer().compose({
      userText: 'close notepad',
      intentTool: 'close_application',
      toolResult: { ok: false, summary: 'still open', error: 'x', data: { app: 'notepad', reason: 'still_open' } },
    });
    expect(say).toBe('Notepad is still open. It may be waiting for you to save something.');
  });
});
