import { createHash } from 'node:crypto';
import type { PageSnapshot } from './pageSnapshot';

/**
 * What a page "is" for the purpose of telling whether an action changed it:
 * where it is and everything the model could see on it. Not a security hash.
 * Covers menus that expand without the URL or title moving, which a plain
 * url/title comparison would miss.
 */
export function pageFingerprint(s: PageSnapshot): string {
  return createHash('sha1')
    // Text and tables count too: a search that only swaps the results text (no new links) is still a change.
    .update(JSON.stringify([s.url, s.title, s.headings, s.links, s.buttons, s.inputs, s.dialogs, s.visibleText ?? '', s.tables ?? []]))
    .digest('hex');
}

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

// An attempt that finishes in the same place it started — or that keeps
// returning to a page already seen — is the signature of a stall, whether
// the page "did nothing" or bounced straight back (click A, land on B, go
// back, click A, ...). Two tries are always allowed (the first may simply
// have raced a slow page); the third identical attempt from the identical
// page state is where it's no longer persistence, it's a loop.
const MAX_REPEATS = 2;
const WINDOW_ATTEMPTS = 12;
// A person asking again a couple of minutes later is a fresh try, not a loop.
const WINDOW_MS = 120_000;

interface Attempt {
  readonly key: string;
  readonly at: number;
}

export class LoopGuard {
  private attempts: Attempt[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  private keyFor(fingerprint: string, action: string, detail: string): string {
    return `${fingerprint}|${action}|${normalize(detail)}`;
  }

  private recent(): Attempt[] {
    const cutoff = this.now() - WINDOW_MS;
    this.attempts = this.attempts.filter((a) => a.at >= cutoff).slice(-WINDOW_ATTEMPTS);
    return this.attempts;
  }

  /** True once this exact action, from this exact page state, has already been tried enough times recently. */
  isLoop(fingerprint: string, action: string, detail: string): boolean {
    const key = this.keyFor(fingerprint, action, detail);
    return this.recent().filter((a) => a.key === key).length >= MAX_REPEATS;
  }

  record(fingerprint: string, action: string, detail: string): void {
    this.recent();
    this.attempts.push({ key: this.keyFor(fingerprint, action, detail), at: this.now() });
  }

  get maxRepeats(): number {
    return MAX_REPEATS;
  }
}
