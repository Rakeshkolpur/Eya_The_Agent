import type { BrowserName } from '@main/chrome/protocol';

/**
 * Which of the user's connected browsers a piece of work belongs in. Pure, so the whole policy is testable:
 *
 *   1. a browser that already has this site open (that is where the user's session for it lives) —
 *      the one holding the exact address first, then the one the user is in front of;
 *   2. otherwise the browser the current task is already being done in;
 *   3. otherwise the browser the user is actively using;
 *   4. otherwise the browser the user has said they prefer;
 *   5. otherwise any connected browser (Chrome before Edge).
 *
 * Never "whichever happens to be first": Chrome and Edge each hold their own sessions, and picking the wrong one
 * would show a signed-out page that the user's real browser would not.
 */
export interface OpenTabOnSite {
  readonly browser: BrowserName;
  readonly url: string;
  readonly active: boolean;
}

export interface SelectionInput {
  readonly connected: readonly BrowserName[];
  /** Open tabs on the same site as the address being opened (empty when no address is being opened). */
  readonly tabsOnSite: readonly OpenTabOnSite[];
  /** The browser the current task is already running in. */
  readonly taskBrowser?: BrowserName | null;
  /** The browser the user used most recently. */
  readonly activeBrowser?: BrowserName | null;
  readonly preferred?: BrowserName | null;
  /** The address being opened, if any. */
  readonly url?: string;
}

export type SelectionReason = 'matching_tab' | 'task' | 'active' | 'preferred' | 'only_one' | 'available';

export interface Selection {
  readonly browser: BrowserName;
  readonly reason: SelectionReason;
}

const FALLBACK_ORDER: readonly BrowserName[] = ['chrome', 'edge', 'other'];

function sameAddress(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '') && x.search === y.search;
  } catch {
    return false;
  }
}

export function selectBrowser(input: SelectionInput): Selection | null {
  const { connected } = input;
  if (connected.length === 0) return null;
  if (connected.length === 1 && connected[0] !== undefined) {
    // Even with one choice, say why: a matching tab there is worth knowing about.
    const only = connected[0];
    return { browser: only, reason: input.tabsOnSite.some((t) => t.browser === only) ? 'matching_tab' : 'only_one' };
  }
  const usable = (b: BrowserName | null | undefined): b is BrowserName => b !== null && b !== undefined && connected.includes(b);

  const matching = input.tabsOnSite.filter((t) => connected.includes(t.browser));
  if (matching.length > 0) {
    const exact = input.url === undefined ? undefined : matching.find((t) => sameAddress(t.url, input.url as string));
    if (exact !== undefined) return { browser: exact.browser, reason: 'matching_tab' };
    const inFront = matching.find((t) => t.active && t.browser === input.activeBrowser);
    if (inFront !== undefined) return { browser: inFront.browser, reason: 'matching_tab' };
    const inTask = matching.find((t) => t.browser === input.taskBrowser);
    if (inTask !== undefined) return { browser: inTask.browser, reason: 'matching_tab' };
    const inActive = matching.find((t) => t.browser === input.activeBrowser);
    if (inActive !== undefined) return { browser: inActive.browser, reason: 'matching_tab' };
    const first = FALLBACK_ORDER.find((b) => matching.some((t) => t.browser === b));
    if (first !== undefined) return { browser: first, reason: 'matching_tab' };
  }
  if (usable(input.taskBrowser)) return { browser: input.taskBrowser, reason: 'task' };
  if (usable(input.activeBrowser)) return { browser: input.activeBrowser, reason: 'active' };
  if (usable(input.preferred)) return { browser: input.preferred, reason: 'preferred' };
  const any = FALLBACK_ORDER.find((b) => connected.includes(b));
  return any !== undefined ? { browser: any, reason: 'available' } : null;
}
