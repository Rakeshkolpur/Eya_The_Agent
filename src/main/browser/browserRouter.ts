/**
 * Which browser a task works in, decided by ONE switch, not by asking and not by guessing: "Open everything in Eya Browser" (Settings, and the Browser page). On: everything
 * — WhatsApp and every other site — opens in Eya Browser (her own, with its own sign-ins and a profile that stays). Off: everything opens in the user's own browser (My Browser).
 * Only the user's own words for THIS request ("use my Chrome") go the other way, for that request. Once a task has started it stays where it is.
 */
export type BrowserKind = 'eya' | 'mine';

export interface RouteInput {
  /** The user's saved preference (settings). */
  readonly preference: BrowserKind;
  /** The user's own words for this request. */
  readonly words: string;
  /** Where the current task already is (null when there is none, or it went stale). */
  readonly pinned: BrowserKind | null;
}

export interface RouteChoice {
  readonly browser: BrowserKind;
  readonly reason: string;
}

const MINE =
  /\b(?:use|open|continue|do (?:it|this)|run (?:it|this)|work)?\s*(?:it |this |that )?(?:in|on|with|from|using)\s+my\s+(?:own\s+|normal\s+|personal\s+|real\s+|existing\s+|current\s+)?(?:chrome|edge|browser|tab)\b|\bmy\s+(?:own\s+|normal\s+|personal\s+|real\s+)?(?:chrome|edge|browser)\b|\b(?:existing|current|already[- ]open|open)\s+tab\b|\bmy\s+logged[- ]?in\s+(?:account|session|browser)|\blogged[- ]in\s+(?:account|session)|\bpersonal\s+browser\b|\bpersonal\s+(?:chrome|edge)\b/i;
const EYA = /\b(?:eya(?:'s)?\s+(?:own\s+)?browser|your\s+(?:own\s+)?browser|in\s+(?:eya|your)\s+(?:own\s+)?(?:browser|window))\b/i;

/** The user asked, in so many words, for their own browser ("use my Chrome", "continue in my existing tab", "my logged-in account"). */
export function asksForMyBrowser(words: string): boolean {
  return MINE.test(words) && !EYA.test(words);
}

/** The user asked for Eya's own browser by name. */
export function asksForEyaBrowser(words: string): boolean {
  return EYA.test(words);
}

export function chooseBrowser(input: RouteInput): RouteChoice {
  const mine = asksForMyBrowser(input.words);
  const eya = asksForEyaBrowser(input.words);
  // What the user says outright wins, even over where the task already is.
  if (mine) return { browser: 'mine', reason: 'the user asked for their own browser' };
  if (eya) return { browser: 'eya', reason: 'the user asked for Eya Browser' };
  // A task that has started stays in the browser it started in.
  if (input.pinned !== null) return { browser: input.pinned, reason: 'the task is already under way there' };
  if (input.preference === 'mine') return { browser: 'mine', reason: 'the switch "Open everything in Eya Browser" is off' };
  return { browser: 'eya', reason: 'the switch "Open everything in Eya Browser" is on' };
}
