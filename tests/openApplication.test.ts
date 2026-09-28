import { describe, it, expect } from 'vitest';
import { createOpenApplicationTool, resolveApp } from '../src/main/tools/impl/openApplication';
import type { KnownApp, OpenApplicationDeps } from '../src/main/tools/impl/openApplication';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';

interface Fakes {
  deps: OpenApplicationDeps;
  started: string[][];
  waited: string[];
}

function fakes(installed: string[], running = true): Fakes {
  const started: string[][] = [];
  const waited: string[] = [];
  return {
    started,
    waited,
    deps: {
      isInstalled: async (app: KnownApp) => app.registeredExe === undefined || installed.includes(app.canonical),
      start: (args) => {
        started.push([...args]);
        return { ok: true };
      },
      waitForProcess: async (exe) => {
        waited.push(exe);
        return running;
      },
    },
  };
}

describe('open_application', () => {
  it('launches and verifies an installed app', async () => {
    const f = fakes(['edge']);
    const result = await createOpenApplicationTool(f.deps).execute({ name: 'edge' });
    expect(result.ok).toBe(true);
    expect(f.started).toEqual([['start', '""', 'msedge']]);
    expect(f.waited).toEqual(['msedge.exe']);
  });

  it('does not launch a browser that is not installed, and says which one is', async () => {
    const f = fakes(['edge']); // this PC: Edge yes, Chrome no
    const result = await createOpenApplicationTool(f.deps).execute({ name: 'chrome' });
    expect(result.ok).toBe(false);
    expect(result.data).toEqual({ app: 'chrome', reason: 'not_installed', alternatives: ['edge'] });
    expect(f.started).toEqual([]); // no Windows error box
    expect(f.waited).toEqual([]); // and no six-second wait
  });

  it('lists every installed alternative, and none when there are none', async () => {
    const many = await createOpenApplicationTool(fakes(['edge', 'firefox']).deps).execute({ name: 'chrome' });
    expect(many.data?.['alternatives']).toEqual(['edge', 'firefox']);
    const none = await createOpenApplicationTool(fakes([]).deps).execute({ name: 'chrome' });
    expect(none.data?.['alternatives']).toEqual([]);
  });

  it('never suggests a different kind of app as a browser alternative', async () => {
    const result = await createOpenApplicationTool(fakes([]).deps).execute({ name: 'firefox' });
    expect(result.data?.['alternatives']).toEqual([]); // notepad etc. are not browsers
  });

  it('system apps skip the install check entirely', async () => {
    const f = fakes([]);
    const result = await createOpenApplicationTool(f.deps).execute({ name: 'notepad' });
    expect(result.ok).toBe(true);
    expect(f.started).toEqual([['start', '""', 'notepad']]);
  });

  it('reports a launch that never showed up', async () => {
    const result = await createOpenApplicationTool(fakes(['edge'], false).deps).execute({ name: 'edge' });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('launched but not verified');
  });

  it('rejects unknown apps and bad arguments', async () => {
    const tool = createOpenApplicationTool(fakes([]).deps);
    expect((await tool.execute({ name: 'photoshop' })).ok).toBe(false);
    expect((await tool.execute({ name: 42 as unknown as string })).ok).toBe(false);
  });

  it('understands aliases', () => {
    expect(resolveApp('Google Chrome')?.canonical).toBe('chrome');
    expect(resolveApp('note pad')?.canonical).toBe('notepad');
  });
});

describe('spoken answer for a missing app', () => {
  const composer = new ResponseComposer();
  const say = (data: Record<string, unknown>) =>
    composer.compose({
      userText: 'open chrome',
      intentTool: 'open_application',
      toolResult: { ok: false, summary: 'not installed', error: 'x', data },
    });

  it('offers the installed alternative', () => {
    expect(say({ app: 'chrome', reason: 'not_installed', alternatives: ['edge'] })).toBe(
      "Chrome isn't installed, but Edge is. Want me to open that?",
    );
  });

  it('just says so when there is nothing to offer', () => {
    expect(say({ app: 'chrome', reason: 'not_installed', alternatives: [] })).toBe("Chrome isn't installed.");
  });

  it('keeps the plain failure wording for other failures', () => {
    expect(say({ app: 'chrome' })).toBe("I couldn't open chrome.");
  });
});
