import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { rootLogger } from '@main/logging/logger';
import type { Tool, ToolArgs, ToolResult, ToolSchema } from '../types';

const execFileAsync = promisify(execFile);
const log = rootLogger.child('tools.closeFile');
const GRACE_MS = 3000;

export interface OpenWindow {
  readonly pid: number;
  readonly title: string;
}

/**
 * Closing a document ("close report.docx") is a different question from
 * closing an application ("close Word"): several documents can share one
 * application, so this finds the specific top-level window whose title
 * mentions the file and closes only that one, by process id + title pair —
 * good enough for the common case (Word/Acrobat/Photos/Notepad put the
 * filename in the title) without needing full Windows UI Automation, which
 * would need a native module and is a bigger, separate undertaking.
 */
export interface CloseFileDeps {
  listWindows(): Promise<readonly OpenWindow[]>;
  /** Sends the close request (like clicking the window's own X); resolves to whether it accepted the request at all. */
  closeMainWindow(pid: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

async function powershell(script: string): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  return stdout;
}

const LIST_WINDOWS_SCRIPT =
  'Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object Id, MainWindowTitle | ConvertTo-Json -Compress';

function parseWindowList(stdout: string): OpenWindow[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  const parsed: unknown = JSON.parse(trimmed);
  // ConvertTo-Json returns a bare object, not a one-element array, when there is exactly one match.
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((r) => r as { Id?: unknown; MainWindowTitle?: unknown })
    .filter((r): r is { Id: number; MainWindowTitle: string } => typeof r.Id === 'number' && typeof r.MainWindowTitle === 'string')
    .map((r) => ({ pid: r.Id, title: r.MainWindowTitle }));
}

const realDeps: CloseFileDeps = {
  listWindows: async () => parseWindowList(await powershell(LIST_WINDOWS_SCRIPT)),
  closeMainWindow: async (pid) => {
    const out = await powershell(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).CloseMainWindow()`);
    return out.trim().toLowerCase() === 'true';
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const schema: ToolSchema = {
  name: 'close_file',
  status: 'Closing the document…',
  description:
    'Close the specific window a document, image or PDF is open in (e.g. "close report.docx", "close that PDF", ' +
    '"close it" after opening something) — not the whole application. Use close_application instead when the user ' +
    'means the whole app (e.g. "close Word"). It is never force-killed, so a document with unsaved changes may stay ' +
    'open and ask to save.',
  args: {
    path: {
      type: 'string',
      required: true,
      description: 'The full path or file name of the open document to close, from context or a previous tool result.',
    },
  },
};

export function createCloseFileTool(deps: CloseFileDeps = realDeps): Tool {
  return {
    schema,
    async execute(args: ToolArgs): Promise<ToolResult> {
      const pathArg = args['path'];
      if (typeof pathArg !== 'string' || pathArg.trim().length === 0) {
        return { ok: false, summary: 'no path', error: 'A file is required.' };
      }
      const fileName = basename(pathArg.trim());
      const stem = fileName.replace(/\.[^./\\]+$/, '') || fileName;

      let windows: readonly OpenWindow[];
      try {
        windows = await deps.listWindows();
      } catch (err) {
        log.warn('could not list windows', { err: String(err) });
        return { ok: false, summary: 'could not check windows', error: 'I could not check what is open.' };
      }
      const matches = windows.filter((w) => w.title.toLowerCase().includes(stem.toLowerCase()));

      if (matches.length === 0) {
        return { ok: false, summary: 'not open', error: `I don't see "${fileName}" open in any window.` };
      }
      if (matches.length > 1) {
        return {
          ok: false,
          summary: 'ambiguous',
          error: `I found ${matches.length} open windows matching "${fileName}": ${matches.map((m) => m.title).join(', ')}. Which one should I close?`,
          data: { candidates: matches },
        };
      }

      const target = matches[0];
      if (target === undefined) return { ok: false, summary: 'not open', error: `I don't see "${fileName}" open.` };

      let accepted: boolean;
      try {
        accepted = await deps.closeMainWindow(target.pid);
      } catch (err) {
        log.warn('close request failed', { title: target.title, err: String(err) });
        return { ok: false, summary: 'close failed', error: `I could not close "${target.title}".` };
      }
      if (!accepted) {
        return { ok: false, summary: 'could not close', error: `I could not close "${target.title}".` };
      }

      const deadline = Date.now() + GRACE_MS;
      let stillThere = true;
      while (Date.now() < deadline) {
        const now = await deps.listWindows();
        stillThere = now.some((w) => w.pid === target.pid && w.title === target.title);
        if (!stillThere) break;
        await deps.sleep(80);
      }

      if (!stillThere) {
        return { ok: true, summary: 'closed the document', data: { title: target.title, path: pathArg } };
      }
      return {
        ok: false,
        summary: 'still open',
        error: `"${target.title}" did not close; it may be waiting for you to save something.`,
        data: { title: target.title, reason: 'still_open' },
      };
    },
  };
}

export const closeFileTool: Tool = createCloseFileTool();
