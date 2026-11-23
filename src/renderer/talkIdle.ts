/**
 * When a hands-free conversation ("Hey Eya") ends itself for being quiet. The rule: while Eya is WORKING for the person the quiet is not "nothing happening" — the
 * person may well be silent for minutes, busy with their own work, while she researches, downloads or waits on a page — so she does not go off; after the work ends
 * she waits a while for the person (who has to come back to it) before she does; and with no work at all she goes quiet after a short silence, as she always did.
 * Pure: the page asks it every couple of seconds.
 */

/** The silence after which a conversation in which nothing was being done ends (ms). */
export const QUIET_MS = 45_000;
/** The silence after which a conversation ends once the work she was doing is over (ms): she told them how it went, and they were busy. */
export const AFTER_WORK_QUIET_MS = 2 * 60_000;
/** Work that has gone on this long without a break is taken to be stuck, not working, and no longer keeps the conversation open (ms). */
export const STUCK_WORK_MS = 3 * 60 * 60_000;

export interface QuietState {
  /** The last time something happened: the person spoke, she answered or spoke, or she was working. */
  readonly lastActive: number;
  /** She has been working for the person in this exchange (so the longer wait after it applies). */
  readonly hadWork: boolean;
  /** When the work in progress began, or null when none is. */
  readonly workSince: number | null;
}

export const freshQuiet = (now: number): QuietState => ({ lastActive: now, hadWork: false, workSince: null });

/** The person spoke: a new exchange begins, with no work yet. */
export const personSpoke = (_state: QuietState, now: number): QuietState => freshQuiet(now);

/** She finished an answer: the quiet time starts again from now; what is known about work in this exchange is kept. */
export const answered = (state: QuietState, now: number): QuietState => ({ ...state, lastActive: now });

export interface QuietLook {
  readonly now: number;
  /** She is doing something for the person: a request she is carrying out, a task she is keeping, a page she is waiting on. */
  readonly working: boolean;
  /** She is speaking or thinking of her answer. */
  readonly busy: boolean;
}

/** One look: the new state, and whether the conversation should end now. */
export function nextQuiet(state: QuietState, look: QuietLook): { readonly state: QuietState; readonly end: boolean } {
  const stuck = state.workSince !== null && look.now - state.workSince > STUCK_WORK_MS;
  if (look.working && !stuck) {
    return { state: { lastActive: look.now, hadWork: true, workSince: state.workSince ?? look.now }, end: false };
  }
  const resting: QuietState = { ...state, workSince: look.working ? state.workSince : null };
  if (look.busy) return { state: { ...resting, lastActive: look.now }, end: false };
  const limit = state.hadWork ? AFTER_WORK_QUIET_MS : QUIET_MS;
  return { state: resting, end: look.now - state.lastActive > limit };
}
