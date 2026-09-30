import { promises as fs } from 'node:fs';
import { checkReadablePath, isExecutablePath, resolveFolder } from '@main/security/pathPolicy';
import type { KnownFolders } from '@main/security/pathPolicy';
import type { Tool, ToolArgs, ToolResult } from '../types';

/** Opens things the way Windows would for the user (Electron's `shell`). */
export interface Opener {
  /** Resolves to '' on success, otherwise an error message. */
  openPath(path: string): Promise<string>;
  openExternal(url: string): Promise<void>;
}

export interface OpenDeps {
  readonly opener: Opener;
  launchBrowser(browser: 'chrome' | 'edge' | 'firefox', url: string): Promise<boolean>;
}

const MAX_URL_LENGTH = 2048;

function stringArg(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Only ordinary web pages: no file:, javascript:, or embedded credentials. */
export function parseWebUrl(raw: string): URL | null {
  if (raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url;
}

export function createOpenTools(folders: KnownFolders, deps: OpenDeps): Tool[] {
  const openFile: Tool = {
    schema: {
      name: 'open_file',
      status: 'Opening the file…',
      description:
        'Open (or play, for a video/audio file) a document, picture or other file in its default app, anywhere on ' +
        'the PC, not just inside the user folder. Cannot open programs or scripts.',
      args: { path: { type: 'string', required: true, description: 'Full path to the file.' } },
    },
    async execute(args): Promise<ToolResult> {
      const path = stringArg(args, 'path');
      if (path === undefined) return { ok: false, summary: 'no path', error: 'A path is required.' };
      const check = checkReadablePath(path, folders);
      if (!check.ok) return { ok: false, summary: 'not allowed', error: check.reason };
      if (isExecutablePath(check.path)) {
        return {
          ok: false,
          summary: 'program refused',
          error: 'That would run a program, which needs your confirmation, so I did not open it.',
        };
      }
      try {
        const stat = await fs.stat(check.path);
        if (stat.isDirectory()) return { ok: false, summary: 'is a folder', error: 'That is a folder; use open_folder.' };
      } catch {
        return { ok: false, summary: 'not found', error: 'That file does not exist.' };
      }
      const failure = await deps.opener.openPath(check.path);
      if (failure !== '') return { ok: false, summary: 'could not open', error: 'Windows could not open that file.' };
      return { ok: true, summary: 'opened the file', data: { path: check.path } };
    },
  };

  const openFolder: Tool = {
    schema: {
      name: 'open_folder',
      status: 'Opening the folder…',
      description: 'Open a folder in File Explorer, anywhere on the PC, not just inside the user folder.',
      args: {
        folder: {
          type: 'string',
          required: true,
          description: 'downloads, desktop, documents, pictures, videos, music, home, or a full path anywhere on the PC.',
        },
      },
    },
    async execute(args): Promise<ToolResult> {
      const folder = stringArg(args, 'folder');
      if (folder === undefined) return { ok: false, summary: 'no folder', error: 'A folder is required.' };
      const resolved = resolveFolder(folder, folders);
      if (resolved === null) return { ok: false, summary: 'unknown folder', error: `I don't know a folder called "${folder}".` };
      const check = checkReadablePath(resolved, folders);
      if (!check.ok) return { ok: false, summary: 'not allowed', error: check.reason };
      try {
        if (!(await fs.stat(check.path)).isDirectory()) {
          return { ok: false, summary: 'not a folder', error: 'That is not a folder.' };
        }
      } catch {
        return { ok: false, summary: 'not found', error: 'That folder does not exist.' };
      }
      const failure = await deps.opener.openPath(check.path);
      if (failure !== '') return { ok: false, summary: 'could not open', error: 'Windows could not open that folder.' };
      return { ok: true, summary: 'opened the folder', data: { path: check.path } };
    },
  };

  const openUrl: Tool = {
    schema: {
      name: 'open_url',
      status: 'Opening the page…',
      description:
        'Open a web page in a browser. To search Google in the browser, open https://www.google.com/search?q=<url-encoded query>. ' +
        'Only http and https addresses are allowed.',
      args: {
        url: { type: 'string', required: true, description: 'The full https:// address.' },
        browser: {
          type: 'string',
          enum: ['default', 'chrome', 'edge', 'firefox'],
          description: 'Which browser. Default uses the user\'s default browser.',
        },
      },
    },
    async execute(args): Promise<ToolResult> {
      const raw = stringArg(args, 'url');
      if (raw === undefined) return { ok: false, summary: 'no url', error: 'A URL is required.' };
      const url = parseWebUrl(raw);
      if (url === null) {
        return { ok: false, summary: 'bad url', error: 'I can only open normal http or https web addresses.' };
      }
      const browser = stringArg(args, 'browser') ?? 'default';
      let usedDefault = browser === 'default';
      if (browser === 'chrome' || browser === 'edge' || browser === 'firefox') {
        usedDefault = !(await deps.launchBrowser(browser, url.href));
      }
      if (usedDefault) {
        try {
          await deps.opener.openExternal(url.href);
        } catch {
          return { ok: false, summary: 'could not open', error: 'I could not open the browser.' };
        }
      }
      const substituted = usedDefault && browser !== 'default';
      return {
        ok: true,
        summary: 'opened the page',
        data: {
          url: url.href,
          browser: usedDefault ? 'default' : browser,
          // Say so, so the reply doesn't claim the wrong browser was used.
          ...(substituted ? { note: `${browser} is not installed, so the default browser was used instead.` } : {}),
        },
      };
    },
  };

  return [openFile, openFolder, openUrl];
}
