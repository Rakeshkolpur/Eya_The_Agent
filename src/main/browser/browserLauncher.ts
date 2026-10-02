import type { BrowserName } from '@main/chrome/protocol';
import type { BrowserLauncher } from './BrowserSessionManager';

/**
 * Finds and starts the user's NORMAL Chrome / Edge — their own profile, with their sign-ins — never a separate
 * automation profile. Opening an address in a browser that is already running just adds a tab to it.
 */
export interface LauncherDeps {
  /** Where Windows says this program is installed (App Paths), or null. */
  findExe(exeName: string): Promise<string | null>;
  /** Opens the address in the named browser. False if it could not be started. */
  launch(browser: 'chrome' | 'edge', url: string): Promise<boolean>;
  /** Image names of every running process. */
  listProcessNames(): Promise<string[]>;
}

const EXE: Readonly<Record<'chrome' | 'edge', string>> = { chrome: 'chrome.exe', edge: 'msedge.exe' };
const ORDER: readonly ('chrome' | 'edge')[] = ['chrome', 'edge'];
// A browser keeps one or two background helpers alive even with no window open; a handful of processes means it is really in use.
const MIN_PROCESSES_FOR_RUNNING = 3;

export function createBrowserLauncher(deps: LauncherDeps): BrowserLauncher {
  return {
    async installed(): Promise<BrowserName[]> {
      const found = await Promise.all(ORDER.map(async (b) => ((await deps.findExe(EXE[b])) !== null ? b : null)));
      return found.filter((b): b is 'chrome' | 'edge' => b !== null);
    },

    async running(): Promise<BrowserName[]> {
      const names = (await deps.listProcessNames()).map((n) => n.toLowerCase());
      return ORDER.filter((b) => names.filter((n) => n === EXE[b]).length >= MIN_PROCESSES_FOR_RUNNING);
    },

    async launch(browser: BrowserName, url: string): Promise<boolean> {
      if (browser !== 'chrome' && browser !== 'edge') return false;
      return deps.launch(browser, url);
    },
  };
}
