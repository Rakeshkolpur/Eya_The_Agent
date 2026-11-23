import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * "Work in THIS tab, of THIS browser". Eya's browser calls normally act where the task last went: the tab she is working in or the one the person is looking at, in the browser the
 * last task was routed to. That cannot be right for work that belongs somewhere of its own:
 *  - a LIVE CHAT: the person opens another tab, another chat in Eya, another app, and Eya opens a site for another request — the chat's "is it still open?" look, its typing and its Send
 *    press would all land on the wrong page (or the wrong browser), and the chat would be paused as if the person had left it;
 *  - a TASK on the Tasks page (an order on Flipkart, looking something up): two of them at once must not click in each other's page.
 * Whatever runs inside `runInTab(tab, work, home)` or `runAsTask(…)` — however many tool calls deep — is pointed at that tab and that browser; code outside it behaves exactly as
 * before. (A scope, not a setting: other requests running at the same time are not touched.)
 */
export type Home = 'chrome' | 'edge' | 'eya';

interface Scope {
  tab: number | null;
  home: Home | null;
  /** A task's scope: it starts without a tab, and fills one in when the task first opens a page (see `bindToTask`). */
  readonly task?: { readonly onBind: (tab: number | null, home: Home | null) => void };
}

const scope = new AsyncLocalStorage<Scope>();

/** Runs `work` with the browser calls pinned to a tab and/or a browser; null for both runs it unpinned (the way every other request runs). A scope inside a scope keeps what it does not set. */
export function runInTab<T>(tabId: number | null, work: () => Promise<T>, home: Home | null = null): Promise<T> {
  if (tabId === null && home === null) return work();
  const outer = scope.getStore();
  return scope.run({ tab: tabId ?? outer?.tab ?? null, home: home ?? outer?.home ?? null }, work);
}

/**
 * Runs a whole task. It has the tab and browser it already had (`had`: from an earlier run of the same task), or none yet; the first page it opens fixes them (`bindToTask`), and
 * `onBind` says so, so the next run of the same task goes on in the same place.
 */
export function runAsTask<T>(had: { readonly tab: number | null; readonly home: Home | null }, onBind: (tab: number | null, home: Home | null) => void, work: () => Promise<T>): Promise<T> {
  return scope.run({ tab: had.tab, home: had.home, task: { onBind } }, work);
}

/** Whether the current work is a task (it has a place of its own to keep). */
export function inTask(): boolean {
  return scope.getStore()?.task !== undefined;
}

/** A task opened a page: from now on all of its browser work is in that tab of that browser. Does nothing outside a task. */
export function bindToTask(tab: number | null, home: Home): void {
  const s = scope.getStore();
  if (s?.task === undefined) return;
  s.tab = tab;
  s.home = home;
  s.task.onBind(tab, home);
}

/** The tab the current work is pinned to, or null. */
export function pinnedTab(): number | null {
  return scope.getStore()?.tab ?? null;
}

/** The browser the current work is pinned to (the user's Chrome or Edge, or Eya Browser), or null. */
export function pinnedHome(): Home | null {
  return scope.getStore()?.home ?? null;
}
