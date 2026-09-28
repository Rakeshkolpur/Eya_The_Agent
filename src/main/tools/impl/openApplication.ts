import { findAppExe } from '@main/windowsApi/appPaths';
import { startDetached, waitForProcess } from '@main/windowsApi/processes';
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

/** What launching needs from Windows; swapped for fakes in tests. */
export interface OpenApplicationDeps {
  isInstalled(app: KnownApp): Promise<boolean>;
  start(args: readonly string[]): StartResult;
  waitForProcess(exe: string, timeoutMs: number): Promise<boolean>;
}

const realDeps: OpenApplicationDeps = {
  isInstalled: async (app) =>
    app.registeredExe === undefined ? true : (await findAppExe(app.registeredExe)) !== null,
  start: (args) => startDetached('cmd.exe', ['/c', ...args]),
  waitForProcess: (exe, timeoutMs) => waitForProcess(exe, timeoutMs),
};

const schema: ToolSchema = {
  name: 'open_application',
  status: 'Opening the app…',
  description: `Launch a Windows application. Known applications: ${knownAppNames().join(', ')}.`,
  args: {
    name: { type: 'string', required: true, description: 'Application canonical name or alias' },
  },
};

export function createOpenApplicationTool(deps: OpenApplicationDeps = realDeps): Tool {
  return {
    schema,
    async execute(args: ToolArgs): Promise<ToolResult> {
      const nameArg = args['name'];
      if (typeof nameArg !== 'string') {
        return { ok: false, summary: 'invalid name', error: 'name must be a string' };
      }
      const app = resolveApp(nameArg);
      if (app === undefined) {
        return {
          ok: false,
          summary: 'unknown application',
          error: `No known application matching '${nameArg}'`,
        };
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

export const openApplicationTool: Tool = createOpenApplicationTool();
