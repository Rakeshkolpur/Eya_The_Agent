import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isProcessRunning } from '@main/windowsApi/processes';
import { resolveApp } from './openApplication';
import type { Tool, ToolArgs, ToolResult, ToolSchema } from '../types';
import { rootLogger } from '@main/logging/logger';

const execFileAsync = promisify(execFile);
const log = rootLogger.child('tools.close');

const IMAGE_RE = /^[A-Za-z0-9_.\-]+\.exe$/;
const GRACE_MS = 3000;

/** What closing an app needs from Windows; swapped for fakes in tests. */
export interface CloseApplicationDeps {
  isRunning(exe: string): Promise<boolean>;
  /**
   * Ask the app to close, like clicking its X. It may refuse (e.g. "save
   * changes?"). `force` ends it outright and is only used for apps with nothing to save.
   */
  requestClose(exe: string, force: boolean): Promise<void>;
  /** File Explorer windows currently open. The shell itself is not counted. */
  explorerWindowCount(): Promise<number>;
  closeExplorerWindows(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

async function powershell(script: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true },
  );
  return stdout;
}

// explorer.exe is also the taskbar and desktop: killing it would take those down.
// Only its windows may be closed.
const EXPLORER_WINDOWS =
  "(New-Object -ComObject Shell.Application).Windows() | Where-Object { $_.Name -eq 'File Explorer' }";

const realDeps: CloseApplicationDeps = {
  isRunning: isProcessRunning,
  // Without /F Windows asks each window to close, and the app can ask the user
  // to save first. /F force-kills and throws away unsaved work.
  requestClose: async (exe, force) => {
    await execFileAsync('taskkill', force ? ['/IM', exe, '/F'] : ['/IM', exe], { windowsHide: true });
  },
  explorerWindowCount: async () => {
    const out = await powershell(`@(${EXPLORER_WINDOWS}).Count`);
    return Number.parseInt(out.trim(), 10) || 0;
  },
  closeExplorerWindows: async () => {
    await powershell(`${EXPLORER_WINDOWS} | ForEach-Object { $_.Quit() }`);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const schema: ToolSchema = {
  name: 'close_application',
  status: 'Closing the app…',
  description:
    'Ask a running Windows application to close, like clicking its X. It is never force-killed, so an app with ' +
    'unsaved work may stay open and ask the user to save.',
  args: {
    name: { type: 'string', required: true, description: 'Application canonical name or alias' },
  },
};

export function createCloseApplicationTool(deps: CloseApplicationDeps = realDeps): Tool {
  async function waitUntil(done: () => Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + GRACE_MS;
    while (Date.now() < deadline) {
      if (await done()) return true;
      await deps.sleep(60);
    }
    return done();
  }

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
      if (!IMAGE_RE.test(app.exe)) return { ok: false, summary: 'unsafe image name', error: 'refused' };

      const isExplorer = app.canonical === 'explorer';
      const isOpen = isExplorer
        ? async (): Promise<boolean> => (await deps.explorerWindowCount()) > 0
        : async (): Promise<boolean> => deps.isRunning(app.exe);

      if (!(await isOpen())) {
        return {
          ok: true,
          summary: `${app.canonical} was not running`,
          data: { app: app.canonical, exe: app.exe, alreadyClosed: true },
        };
      }

      try {
        if (isExplorer) await deps.closeExplorerWindows();
        else await deps.requestClose(app.exe, app.forceClose === true);
      } catch (err) {
        log.warn('close request failed', { app: app.canonical, err: String(err) });
        return { ok: false, summary: 'close failed', error: String(err) };
      }

      if (await waitUntil(async () => !(await isOpen()))) {
        return {
          ok: true,
          summary: `${app.canonical} closed`,
          data: { app: app.canonical, exe: app.exe },
        };
      }
      // Still there: most likely asking the user whether to save. Don't force it.
      return {
        ok: false,
        summary: 'still open',
        error: `${app.canonical} did not close; it may be waiting for you to save something.`,
        data: { app: app.canonical, reason: 'still_open' },
      };
    },
  };
}

export const closeApplicationTool: Tool = createCloseApplicationTool();
