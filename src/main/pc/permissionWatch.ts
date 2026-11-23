/**
 * Telling the person that Windows' permission box is waiting for their Yes. Pure apart from the timing it is given.
 *
 * Windows draws that box on its own screen, and a person who is not told does not know that Eya is waiting for them. While a job that may stop at the box runs, the box is looked for every
 * second; the moment it is there the person is told to click Yes (once; again only if it comes back, at most three times). `stillWaiting` is said once when nothing has appeared for a while
 * (for a job where the box is expected at once).
 */

/** At most this many "the box is open" notes for one job (a job that asks again and again is not read out each time). */
export const MAX_BOX_NOTES = 3;

/** What a question says, before anything starts, about Windows' permission box: it is Windows' own, the person answers it, and Eya never sees a password. */
export const BOX_WARNING = (admin: boolean): string =>
  `Windows will probably show its own permission box ("Do you want to allow this app to make changes to your device?"): click Yes on it${admin ? '' : ', and it will ask for an administrator\'s password, which I never see'}. I will tell you when it appears.`;

export interface WatchDeps {
  /** Whether Windows' permission box is on the screen right now. */
  readonly box: () => Promise<boolean>;
  readonly say: (text: string) => void;
  readonly pollMs: number;
  readonly stillWaitingMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface WatchWords {
  readonly opened: string;
  readonly again: string;
  readonly stillWaiting?: string;
}

/** Runs `work`, looking for the permission box while it runs; `sawBox` says whether it was ever seen. */
export async function whileWatching<T>(deps: WatchDeps, work: Promise<T>, words: WatchWords): Promise<{ readonly value: T; readonly sawBox: boolean }> {
  let finished = false;
  let sawBox = false;
  let open = false;
  let told = 0;
  let waited = 0;
  let toldWaiting = false;
  const settled = work.finally(() => {
    finished = true;
  });
  const watch = (async (): Promise<void> => {
    while (!finished) {
      await deps.sleep(deps.pollMs);
      waited += deps.pollMs;
      if (finished) return;
      const now = await deps.box().catch(() => false);
      if (now && !open) {
        sawBox = true;
        told += 1;
        if (told <= MAX_BOX_NOTES) deps.say(told === 1 ? words.opened : words.again);
      } else if (!now && !sawBox && !toldWaiting && words.stillWaiting !== undefined && waited >= deps.stillWaitingMs) {
        toldWaiting = true;
        deps.say(words.stillWaiting);
      }
      open = now;
    }
  })();
  const value = await settled;
  await watch;
  return { value, sawBox };
}
