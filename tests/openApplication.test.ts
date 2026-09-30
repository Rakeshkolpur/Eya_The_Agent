import { describe, it, expect } from 'vitest';
import { createOpenApplicationTool, pickRunningBrowser, resolveApp } from '../src/main/tools/impl/openApplication';
import type { KnownApp, OpenApplicationDeps } from '../src/main/tools/impl/openApplication';
import type { StartMenuApp } from '../src/main/windowsApi/appDiscovery';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';

interface Fakes {
  deps: OpenApplicationDeps;
  started: string[][];
  waited: string[];
  startAppsLaunched: string[];
  opened: string[];
  browserLaunches: Array<{ browser: string; url: string }>;
}

function fakes(
  installed: string[],
  running = true,
  options: { startApps?: StartMenuApp[]; runningProcesses?: string[]; newProcessAfterLaunch?: string | null } = {},
): Fakes {
  const started: string[][] = [];
  const waited: string[] = [];
  const startAppsLaunched: string[] = [];
  const opened: string[] = [];
  const browserLaunches: Array<{ browser: string; url: string }> = [];
  const startApps = options.startApps ?? [];
  const runningProcesses = options.runningProcesses ?? [];
  const newProcessAfterLaunch = options.newProcessAfterLaunch === undefined ? 'SomeApp.exe' : options.newProcessAfterLaunch;
  return {
    started,
    waited,
    startAppsLaunched,
    opened,
    browserLaunches,
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
      listStartApps: async () => startApps,
      launchStartApp: (appId) => {
        startAppsLaunched.push(appId);
        return { ok: true };
      },
      listRunningProcessNames: async () => runningProcesses,
      waitForNewProcess: async () => newProcessAfterLaunch,
      launchBrowser: async (browser, url) => {
        browserLaunches.push({ browser, url });
        return true;
      },
      openExternal: async (url) => {
        opened.push(url);
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

describe('open_application: beyond the known list', () => {
  it('finds and launches an app via Start Menu discovery, verifying by watching for a new process', async () => {
    const f = fakes([], true, {
      startApps: [{ name: 'WhatsApp', appId: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' }],
      runningProcesses: ['explorer.exe', 'chrome.exe'],
      newProcessAfterLaunch: 'WhatsApp.exe',
    });
    const result = await createOpenApplicationTool(f.deps).execute({ name: 'whatsapp' });
    expect(result.ok).toBe(true);
    expect(f.startAppsLaunched).toEqual(['5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App']);
    expect(result.data).toEqual({ app: 'WhatsApp', exe: 'WhatsApp.exe' });
  });

  it('never matches an uninstaller or a documentation shortcut just because the name overlaps', async () => {
    const f = fakes([], true, {
      startApps: [
        { name: 'Uninstall Node.js', appId: 'Microsoft.AutoGenerated.{X}' },
        { name: 'Node.js website', appId: 'https://nodejs.org/' },
      ],
    });
    const result = await createOpenApplicationTool(f.deps).execute({ name: 'node' });
    expect(result.ok).toBe(false);
    expect(f.startAppsLaunched).toEqual([]);
  });

  it('reports a discovered app that launched but never actually showed up', async () => {
    const f = fakes([], true, {
      startApps: [{ name: 'Spotify', appId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' }],
      newProcessAfterLaunch: null,
    });
    const result = await createOpenApplicationTool(f.deps).execute({ name: 'spotify' });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('launched but not verified');
  });

  it('falls back to a known web app, reusing a browser that already looks in active use', async () => {
    const f = fakes([], true, { runningProcesses: Array(5).fill('msedge.exe') });
    const result = await createOpenApplicationTool(f.deps).execute({ name: 'WhatsApp' });
    expect(result.ok).toBe(true);
    expect(f.browserLaunches).toEqual([{ browser: 'edge', url: 'https://web.whatsapp.com/' }]);
    expect(f.opened).toEqual([]); // did not also fall through to the OS default
    expect(result.data).toEqual({ app: 'WhatsApp', usedWeb: true, browser: 'edge' });
  });

  it('opens the default browser when no browser looks genuinely in active use', async () => {
    // Two chrome.exe processes: below the "actually in use" threshold — a
    // background updater/helper, not a real open window.
    const f = fakes([], true, { runningProcesses: ['chrome.exe', 'chrome.exe'] });
    const result = await createOpenApplicationTool(f.deps).execute({ name: 'telegram' });
    expect(result.ok).toBe(true);
    expect(f.browserLaunches).toEqual([]);
    expect(f.opened).toEqual(['https://web.telegram.org/a/']);
    expect(result.data?.['browser']).toBe('default');
  });

  it('says plainly it could not find an app with no installed match and no known web version', async () => {
    const f = fakes([]);
    const result = await createOpenApplicationTool(f.deps).execute({ name: 'some made up app' });
    expect(result.ok).toBe(false);
    expect(result.data).toEqual({ app: 'some made up app', reason: 'not_found' });
    expect(f.opened).toEqual([]);
  });

  it('still tries the known web app even when Start Menu discovery itself fails', async () => {
    const f = fakes([]);
    f.deps.listStartApps = async () => {
      throw new Error('Get-StartApps unavailable');
    };
    const result = await createOpenApplicationTool(f.deps).execute({ name: 'discord' });
    expect(result.ok).toBe(true);
    expect(f.opened).toEqual(['https://discord.com/app']);
  });
});

describe('pickRunningBrowser', () => {
  it('picks a browser with enough processes to look like a real open window', () => {
    expect(pickRunningBrowser(['msedge.exe', 'msedge.exe', 'msedge.exe', 'explorer.exe'])).toBe('edge');
  });

  it('ignores a browser that only has a background/helper process running', () => {
    expect(pickRunningBrowser(['chrome.exe', 'explorer.exe'])).toBeNull();
  });

  it('picks whichever browser has the most active-looking processes when more than one qualifies', () => {
    const procs = [...Array(3).fill('firefox.exe'), ...Array(6).fill('chrome.exe')];
    expect(pickRunningBrowser(procs)).toBe('chrome');
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
