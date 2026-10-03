import type { BrowserTabInfo } from '@main/browser/pageEffects';
import type { BrowserName } from '@main/chrome/protocol';
import { rootLogger } from '@main/logging/logger';
import { WINDOW_ACTIONS } from '@main/windowsApi/windowControl';
import type { WindowAction, WindowControl, WindowInfo } from '@main/windowsApi/windowControl';
import { appLabel, isActable, matchWindows } from '@main/windowsApi/windowMatch';
import type { Tool, ToolArgs, ToolResult } from '../types';

const log = rootLogger.child('tools.windows');

/**
 * Controlling other applications' windows: list what is open; minimise, maximise, restore, close or switch to one.
 * Each action is done through Windows and then CHECKED by reading the window's real state back — "Done" is only said when
 * the window really is minimised / maximised / in front / gone. Eya's own windows are never listed or touched.
 */
export interface WindowToolDeps {
  readonly control: WindowControl;
  /** Process ids of Eya's own windows: never listed, never acted on. */
  readonly ownPids: () => readonly number[];
  /** How a window's title is shown to the model. The default is the title itself; the privacy layer hides a private app's title. */
  readonly describeTitle?: (w: WindowInfo) => string;
  /** "Switch to WhatsApp" when it is a browser tab rather than a window of its own. */
  readonly tabs?: {
    listTabs(): Promise<readonly BrowserTabInfo[]>;
    switchToTab(tabId: number, browser?: BrowserName): Promise<unknown>;
  };
}

const MAX_LISTED = 30;
const BROWSER_PROCESSES = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera']);

const VERBS: Readonly<Record<WindowAction, { past: string; wasAlready: string; failed: string }>> = {
  minimize: { past: 'Minimized', wasAlready: 'was already minimized', failed: 'did not minimize' },
  maximize: { past: 'Maximized', wasAlready: 'was already maximized', failed: 'did not maximize' },
  restore: { past: 'Restored', wasAlready: 'was already in its normal size', failed: 'did not restore' },
  focus: { past: 'Switched to', wasAlready: 'was already in front', failed: 'could not be brought to the front' },
  close: { past: 'Closed', wasAlready: 'was already closed', failed: 'did not close' },
};

function stringArg(args: ToolArgs, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** Whether the window ended up where the action should have put it (judged from Windows' own report, not from the request). */
export function reachedState(action: WindowAction, before: WindowInfo, after: WindowInfo | null): boolean {
  if (action === 'close') return after === null;
  if (after === null) return false;
  switch (action) {
    case 'minimize':
      return after.state === 'minimized';
    case 'maximize':
      return after.state === 'maximized';
    case 'restore':
      // A minimised window comes back to wherever it was (maybe maximised); a normal one stays normal.
      return after.state === 'normal' || (before.state === 'minimized' && after.state === 'maximized');
    case 'focus':
      return after.foreground && after.state !== 'minimized';
  }
}

function alreadyThere(action: WindowAction, w: WindowInfo): boolean {
  if (action === 'minimize') return w.state === 'minimized';
  if (action === 'maximize') return w.state === 'maximized';
  if (action === 'restore') return w.state === 'normal';
  if (action === 'focus') return w.foreground && w.state !== 'minimized';
  return false;
}

export function createWindowTools(deps: WindowToolDeps): Tool[] {
  const show = deps.describeTitle ?? ((w: WindowInfo) => w.title);

  async function openWindows(): Promise<WindowInfo[]> {
    const own = new Set(deps.ownPids());
    return (await deps.control.list()).filter((w) => isActable(w, own));
  }

  /** "Switch to WhatsApp" when it lives in a browser tab: bring that tab (and its window) to the front, then check. */
  async function focusTab(query: string): Promise<ToolResult | null> {
    if (deps.tabs === undefined) return null;
    const q = query.trim().toLowerCase().replace(/\s+/g, '');
    if (q.length < 3) return null;
    let tabs: readonly BrowserTabInfo[];
    try {
      tabs = await deps.tabs.listTabs();
    } catch {
      return null; // no browser connected: nothing to switch to
    }
    const hits = tabs.filter((t) => {
      let host = '';
      try {
        host = new URL(t.url).hostname.toLowerCase();
      } catch {
        // not a web address
      }
      return t.title.toLowerCase().replace(/\s+/g, '').includes(q) || host.replace(/\./g, '').includes(q);
    });
    const tab = hits.find((t) => t.active) ?? hits[0];
    if (tab === undefined) return null;
    try {
      await deps.tabs.switchToTab(tab.tabId, tab.browser); // its return value is the page's content: never passed on
    } catch (err) {
      return { ok: false, summary: 'could not switch', error: `I found a browser tab for "${query}" but could not switch to it: ${err instanceof Error ? err.message : String(err)}` };
    }
    const [tabsAfter, windows] = await Promise.all([deps.tabs.listTabs().catch(() => [] as readonly BrowserTabInfo[]), deps.control.list().catch(() => [] as readonly WindowInfo[])]);
    const tabNowActive = tabsAfter.some((t) => t.tabId === tab.tabId && (tab.browser === undefined || t.browser === tab.browser) && t.active);
    const front = windows.find((w) => w.foreground);
    const browserInFront = front !== undefined && BROWSER_PROCESSES.has(front.process.toLowerCase());
    const verified = tabNowActive && browserInFront;
    const name = tab.browser === 'edge' ? 'Edge' : tab.browser === 'chrome' ? 'Chrome' : 'your browser';
    return verified
      ? { ok: true, summary: `switched to the ${query} tab in ${name}`, data: { action: 'focus', via: 'browser tab', browser: tab.browser, verified: true } }
      : {
          ok: false,
          summary: 'could not bring it to the front',
          error: `I switched to the ${query} tab in ${name}, but ${name} did not come to the front${tabNowActive ? '' : ' and the tab did not become the active one'}.`,
          data: { action: 'focus', via: 'browser tab', verified: false },
        };
  }

  const listTool: Tool = {
    schema: {
      name: 'list_windows',
      status: 'Checking what is open…',
      description:
        'List the applications and windows currently open on the user\'s PC (each with its application, state — normal, minimized or maximized — and whether it is in front). ' +
        'Use it to answer "what\'s open?", or to see what is there before switching or closing something. Eya\'s own window is never listed.',
      args: {},
    },
    async execute(): Promise<ToolResult> {
      let windows: WindowInfo[];
      try {
        windows = await openWindows();
      } catch (err) {
        log.warn('could not list windows', { err: String(err) });
        return { ok: false, summary: 'could not check windows', error: 'I could not check what is open.' };
      }
      const shown = windows.slice(0, MAX_LISTED).map((w) => ({ app: appLabel(w), title: show(w), state: w.state, inFront: w.foreground }));
      const front = windows.find((w) => w.foreground);
      return {
        ok: true,
        summary: `${windows.length} window${windows.length === 1 ? '' : 's'} open`,
        data: {
          windows: shown,
          ...(windows.length > MAX_LISTED ? { more: windows.length - MAX_LISTED } : {}),
          ...(front !== undefined ? { inFront: { app: appLabel(front), title: show(front) } } : {}),
        },
      };
    },
  };

  const controlTool: Tool = {
    schema: {
      name: 'window_control',
      status: 'Working on the window…',
      description:
        'Actually minimize, maximize, restore, close, or switch to (focus) an open application window, then confirm from Windows that it really happened. ' +
        'Say which one in `window` — the application ("Chrome", "Word", "Notepad") or part of the window\'s title. If several windows of that application are open, minimize/maximize/restore/focus ' +
        'act on the one in front, and close asks which. "Switch to WhatsApp" also works when WhatsApp is a tab in the user\'s browser. ' +
        'Close is polite, like the X button: a document with unsaved changes will stay open and ask. Do not use it to open an application (use open_application) or for Eya herself.',
      args: {
        action: { type: 'string', required: true, enum: [...WINDOW_ACTIONS], description: 'minimize, maximize, restore, close, or focus (switch to it).' },
        window: { type: 'string', required: true, description: 'The application or part of the window title, e.g. "Chrome", "Word", "report.docx".' },
        exact: { type: 'boolean', description: 'Require the whole window title to match, not just part of it.' },
      },
    },
    async execute(args: ToolArgs): Promise<ToolResult> {
      const action = stringArg(args, 'action') as WindowAction | undefined;
      const query = stringArg(args, 'window');
      if (action === undefined || !WINDOW_ACTIONS.includes(action)) return { ok: false, summary: 'unknown action', error: `The action must be one of: ${WINDOW_ACTIONS.join(', ')}.` };
      if (query === undefined) return { ok: false, summary: 'which window?', error: 'Say which application or window — for example "Chrome" or "Word".' };

      let windows: WindowInfo[];
      try {
        windows = await openWindows();
      } catch (err) {
        log.warn('could not list windows', { err: String(err) });
        return { ok: false, summary: 'could not check windows', error: 'I could not check what is open.' };
      }
      const found = matchWindows(windows, query, { exact: args['exact'] === true });

      if (found.best === null) {
        if (action === 'focus') {
          const viaTab = await focusTab(query);
          if (viaTab !== null) return viaTab;
        }
        const apps = [...new Set(windows.map((w) => appLabel(w)))].slice(0, 12);
        return {
          ok: false,
          summary: 'not open',
          error: `I don't see "${query}" open${apps.length > 0 ? `. What is open: ${apps.join(', ')}` : ''}. Ask the user which one they mean, or use open_application if it needs opening.`,
          data: { openApps: apps },
        };
      }

      // Closing the wrong one of several is not undoable: ask which instead of picking.
      const distinct = new Map(found.matches.map((w) => [w.title, w]));
      if (action === 'close' && distinct.size > 1) {
        return {
          ok: false,
          summary: 'which one?',
          error: `${distinct.size} windows match "${query}". Ask the user which one to close.`,
          data: { candidates: [...distinct.values()].map((w) => ({ app: appLabel(w), title: show(w), state: w.state, inFront: w.foreground })) },
        };
      }

      const target = found.best;
      const label = appLabel(target);
      const verb = VERBS[action];
      if (alreadyThere(action, target)) {
        return { ok: true, summary: `${label} ${verb.wasAlready}`, data: { action, app: label, title: show(target), stateBefore: target.state, stateAfter: target.state, verified: true, alreadyThere: true } };
      }

      let result;
      try {
        result = await deps.control.act(target.handle, action);
      } catch (err) {
        log.warn('window action failed', { action, err: String(err) });
        return { ok: false, summary: `${action} failed`, error: `I could not ${action} ${label}.` };
      }
      const verified = result.sent && reachedState(action, target, result.after);
      const others = found.matches.length - 1;
      const data = {
        action,
        app: label,
        title: show(target),
        stateBefore: target.state,
        stateAfter: result.after === null ? 'closed' : result.after.state,
        verified,
        ...(others > 0 ? { otherWindowsOfThisApp: others } : {}),
      };
      if (verified) return { ok: true, summary: `${verb.past} ${label}`, data };
      if (action === 'close') {
        return { ok: false, summary: 'still open', error: `${label} did not close; it may be waiting for the user to save something.`, data: { ...data, reason: 'still_open' } };
      }
      return { ok: false, summary: `${action} did not take effect`, error: `${label} ${verb.failed}. Windows would not do it (it may belong to a program running with higher rights).`, data };
    },
  };

  return [listTool, controlTool];
}
