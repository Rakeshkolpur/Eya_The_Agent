import { findAppExe, launchBrowser as launchBrowserByExe } from '@main/windowsApi/appPaths';
import type { BrowserName } from '@main/windowsApi/appPaths';
import { findStartApp, launchStartApp, listStartApps } from '@main/windowsApi/appDiscovery';
import type { StartMenuApp } from '@main/windowsApi/appDiscovery';
import { listRunningProcesses, startDetached, waitForProcess } from '@main/windowsApi/processes';
import type { StartResult } from '@main/windowsApi/processes';
import type { Tool, ToolArgs, ToolResult, ToolSchema } from '../types';

/**
 * Known application registry. Names are canonical, lowercased, no spaces.
 * exe: the image name tasklist reports (verification).
 * startArgs: launched through the Windows `start` shim, which uses the
 * registered launcher rather than a specific install path.
 * registeredExe: for apps that may simply not be installed, the name they
 * register under in Windows' App Paths, so we can check before launching.
 */
export interface KnownApp {
  readonly canonical: string;
  readonly aliases: readonly string[];
  readonly exe: string;
  readonly startArgs: readonly string[];
  readonly registeredExe?: string;
  readonly category?: 'browser';
  /**
   * Safe to close firmly: it has nothing to save, and (like Calculator, a Store
   * app) it ignores a polite close request. Everything else is only asked nicely.
   */
  readonly forceClose?: boolean;
}

const KNOWN_APPS: readonly KnownApp[] = [
  {
    canonical: 'chrome',
    aliases: ['google chrome', 'google-chrome'],
    exe: 'chrome.exe',
    startArgs: ['start', '""', 'chrome'],
    registeredExe: 'chrome.exe',
    category: 'browser',
  },
  {
    canonical: 'edge',
    aliases: ['microsoft edge', 'msedge'],
    exe: 'msedge.exe',
    startArgs: ['start', '""', 'msedge'],
    registeredExe: 'msedge.exe',
    category: 'browser',
  },
  {
    canonical: 'firefox',
    aliases: ['mozilla firefox'],
    exe: 'firefox.exe',
    startArgs: ['start', '""', 'firefox'],
    registeredExe: 'firefox.exe',
    category: 'browser',
  },
  {
    canonical: 'notepad',
    aliases: ['note pad', 'windows notepad'],
    exe: 'notepad.exe',
    startArgs: ['start', '""', 'notepad'],
  },
  {
    canonical: 'explorer',
    aliases: ['file explorer', 'files', 'windows explorer'],
    exe: 'explorer.exe',
    startArgs: ['start', '""', 'explorer'],
  },
  {
    canonical: 'calculator',
    aliases: ['calc'],
    exe: 'CalculatorApp.exe',
    startArgs: ['start', '""', 'calc'],
    forceClose: true,
  },
];

export function knownAppNames(): readonly string[] {
  return KNOWN_APPS.map((a) => a.canonical);
}

export function resolveApp(name: string): KnownApp | undefined {
  const q = name.trim().toLowerCase();
  for (const app of KNOWN_APPS) {
    if (app.canonical === q) return app;
    if (app.aliases.some((a) => a === q)) return app;
  }
  return undefined;
}

/** A handful of apps with a genuine, well-known official web client — not a guess at "every app has a web version". */
interface WebApp {
  readonly name: string;
  readonly url: string;
}
const KNOWN_WEB_APPS: Readonly<Record<string, WebApp>> = {
  whatsapp: { name: 'WhatsApp', url: 'https://web.whatsapp.com/' },
  telegram: { name: 'Telegram', url: 'https://web.telegram.org/a/' },
  discord: { name: 'Discord', url: 'https://discord.com/app' },
  spotify: { name: 'Spotify', url: 'https://open.spotify.com/' },
};

function normalizeAppQuery(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

const BROWSER_EXE_NAMES: Readonly<Record<BrowserName, string>> = {
  chrome: 'chrome.exe',
  edge: 'msedge.exe',
  firefox: 'firefox.exe',
};
// A modern browser keeps several background/helper processes alive even when
// no window is open (update checkers, "startup boost", widgets); requiring a
// handful of them before calling a browser "actually in use" avoids wrongly
// picking one over the browser the user is really looking at.
const MIN_PROCESSES_FOR_ACTIVE_BROWSER = 3;

/** Which browser (if any) looks genuinely in use right now, to reuse instead of opening a different one. */
export function pickRunningBrowser(processImageNames: readonly string[]): BrowserName | null {
  const lower = processImageNames.map((n) => n.toLowerCase());
  let best: { browser: BrowserName; count: number } | null = null;
  for (const [browser, exe] of Object.entries(BROWSER_EXE_NAMES) as Array<[BrowserName, string]>) {
    const count = lower.filter((n) => n === exe).length;
    if (count >= MIN_PROCESSES_FOR_ACTIVE_BROWSER && (best === null || count > best.count)) {
      best = { browser, count };
    }
  }
  return best?.browser ?? null;
}

/** What launching needs from Windows; swapped for fakes in tests. */
export interface OpenApplicationDeps {
  isInstalled(app: KnownApp): Promise<boolean>;
  start(args: readonly string[]): StartResult;
  waitForProcess(exe: string, timeoutMs: number): Promise<boolean>;
  /** Beyond the short well-known list: whatever Windows' own Start Menu search would find. */
  listStartApps(): Promise<StartMenuApp[]>;
  launchStartApp(appId: string): StartResult;
  listRunningProcessNames(): Promise<string[]>;
  /** Polls for a process that wasn't in `beforeNames`; null on timeout. For an app discovered dynamically, its eventual exe name isn't known in advance. */
  waitForNewProcess(beforeNames: readonly string[], timeoutMs: number): Promise<string | null>;
  launchBrowser(browser: BrowserName, url: string): Promise<boolean>;
  /** The user's default browser/handler — supplied by main.ts (Electron's `shell.openExternal`), not imported here. */
  openExternal(url: string): Promise<void>;
}

/** Everything except `openExternal`, which only main.ts can supply (it needs Electron's `shell`). */
export const defaultOpenApplicationDeps: Omit<OpenApplicationDeps, 'openExternal'> = {
  isInstalled: async (app) =>
    app.registeredExe === undefined ? true : (await findAppExe(app.registeredExe)) !== null,
  start: (args) => startDetached('cmd.exe', ['/c', ...args]),
  waitForProcess: (exe, timeoutMs) => waitForProcess(exe, timeoutMs),
  listStartApps: () => listStartApps(),
  launchStartApp: (appId) => launchStartApp(appId),
  listRunningProcessNames: async () => (await listRunningProcesses()).map((p) => p.imageName),
  waitForNewProcess: async (beforeNames, timeoutMs) => {
    const before = new Set(beforeNames.map((n) => n.toLowerCase()));
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const after = await listRunningProcesses();
      const fresh = after.find((p) => !before.has(p.imageName.toLowerCase()));
      if (fresh !== undefined) return fresh.imageName;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return null;
  },
  launchBrowser: (browser, url) => launchBrowserByExe(browser, url),
};

const schema: ToolSchema = {
  name: 'open_application',
  status: 'Opening the app…',
  description:
    `Launch a real, actually-installed Windows application — never treat "open X" as a web search. Common apps ` +
    `(${knownAppNames().join(', ')}) launch directly; any other name is looked up the way Windows' own Start Menu ` +
    `search would (installed Win32 and Microsoft Store/UWP apps alike), and the real app is launched if found. Only ` +
    `if nothing is genuinely installed does this fall back to a known official web app (e.g. WhatsApp, Telegram, ` +
    'Discord, Spotify) in a browser — reusing a browser that already looks in active use rather than switching to a ' +
    "different one. If neither an installed app nor a known web app exists, this says so plainly rather than guessing.",
  args: {
    name: { type: 'string', required: true, description: 'Application name as the user said it.' },
  },
};

/** Beyond the short well-known list: Start Menu discovery, then a known web app, in that order. */
async function resolveBeyondKnownApps(nameArg: string, deps: OpenApplicationDeps): Promise<ToolResult> {
  let discovered: StartMenuApp[];
  try {
    discovered = await deps.listStartApps();
  } catch {
    discovered = []; // discovery unavailable — fall through to a known web app, same as "not found"
  }
  const found = findStartApp(nameArg, discovered);
  if (found !== null) {
    const before = await deps.listRunningProcessNames();
    const spawn = deps.launchStartApp(found.appId);
    if (!spawn.ok) {
      return { ok: false, summary: 'launch failed', error: spawn.error ?? 'unknown spawn error' };
    }
    const newProcess = await deps.waitForNewProcess(before, 6000);
    if (newProcess === null) {
      return {
        ok: false,
        summary: 'launched but not verified',
        error: `Started ${found.name} but did not see it actually appear within timeout.`,
        data: { app: found.name },
      };
    }
    return { ok: true, summary: `${found.name} is running`, data: { app: found.name, exe: newProcess } };
  }

  const web = KNOWN_WEB_APPS[normalizeAppQuery(nameArg)];
  if (web === undefined) {
    return {
      ok: false,
      summary: 'not found',
      error: `I couldn't find "${nameArg}" installed, and I don't know of a web version of it.`,
      data: { app: nameArg, reason: 'not_found' },
    };
  }
  const runningBrowser = pickRunningBrowser(await deps.listRunningProcessNames());
  if (runningBrowser !== null && (await deps.launchBrowser(runningBrowser, web.url))) {
    return { ok: true, summary: `opened ${web.name} in ${runningBrowser}`, data: { app: web.name, usedWeb: true, browser: runningBrowser } };
  }
  try {
    await deps.openExternal(web.url);
  } catch (err) {
    return { ok: false, summary: 'could not open', error: `I could not open ${web.name}: ${String(err)}` };
  }
  return { ok: true, summary: `opened ${web.name} in the default browser`, data: { app: web.name, usedWeb: true, browser: 'default' } };
}

export function createOpenApplicationTool(deps: OpenApplicationDeps): Tool {
  return {
    schema,
    async execute(args: ToolArgs): Promise<ToolResult> {
      const nameArg = args['name'];
      if (typeof nameArg !== 'string') {
        return { ok: false, summary: 'invalid name', error: 'name must be a string' };
      }
      const app = resolveApp(nameArg);
      if (app === undefined) {
        return resolveBeyondKnownApps(nameArg, deps);
      }

      // Launching something that isn't installed just makes Windows show an
      // error box, and we'd then wait out the whole verification timeout.
      if (!(await deps.isInstalled(app))) {
        const alternatives: string[] = [];
        for (const other of KNOWN_APPS) {
          if (other === app || other.category === undefined || other.category !== app.category) continue;
          if (await deps.isInstalled(other)) alternatives.push(other.canonical);
        }
        return {
          ok: false,
          summary: 'not installed',
          error: `${app.canonical} is not installed on this PC.`,
          data: { app: app.canonical, reason: 'not_installed', alternatives },
        };
      }

      const spawn = deps.start(app.startArgs);
      if (!spawn.ok) {
        return { ok: false, summary: 'launch failed', error: spawn.error ?? 'unknown spawn error' };
      }

      const verified = await deps.waitForProcess(app.exe, 6000);
      if (!verified) {
        return {
          ok: false,
          summary: 'launched but not verified',
          error: `Started ${app.canonical} but did not observe ${app.exe} within timeout`,
          data: { app: app.canonical, exe: app.exe },
        };
      }

      return {
        ok: true,
        summary: `${app.canonical} is running`,
        data: { app: app.canonical, exe: app.exe },
      };
    },
  };
}
