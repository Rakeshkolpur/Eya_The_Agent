import type { SocialSiteId } from './socialSites';

/**
 * How much Eya may publish for the person, and how fast. These limits are not a courtesy: a site that sees a burst of posts or comments from one account restricts it, and the person's
 * name is on every one. They are checked in code at the moment of publishing (see PublishGate), so no instruction from any page, message or model can raise them. The person changes them in
 * Eya's own settings file, never by asking a model.
 */
export type PublishAction = 'post' | 'comment' | 'reply' | 'apply' | 'proposal';

export interface PacingSettings {
  /** The most of each kind in one local day, per site. */
  readonly caps: Readonly<Record<PublishAction, number>>;
  /** The shortest time between two of the same kind on one site. */
  readonly minGapMinutes: Readonly<Record<PublishAction, number>>;
  /** Nothing goes out from this hour (0-23) until the other: a person does not post at three in the morning. */
  readonly quiet: { readonly from: number; readonly to: number };
  /** The same text is never published twice within this many days. */
  readonly duplicateDays: number;
}

export const DEFAULT_PACING: PacingSettings = {
  caps: { post: 2, comment: 15, reply: 20, apply: 10, proposal: 10 },
  minGapMinutes: { post: 20, comment: 2, reply: 2, apply: 3, proposal: 3 },
  quiet: { from: 23, to: 6 },
  duplicateDays: 30,
};

export interface LedgerEntry {
  readonly at: number;
  readonly site: SocialSiteId;
  readonly action: PublishAction;
  /** Only a fingerprint of the text: the ledger never keeps what was written. */
  readonly hash: string;
}

export type Allowance = { readonly ok: true } | { readonly ok: false; readonly why: string; readonly retryAt?: number };

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const sameLocalDay = (a: number, b: number): boolean => {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
};

const inQuiet = (hour: number, q: PacingSettings['quiet']): boolean => (q.from === q.to ? false : q.from < q.to ? hour >= q.from && hour < q.to : hour >= q.from || hour < q.to);

/** Whether one more of this kind may go out now, and if not, why (in words the person can read) and when it may. */
export function allowance(ledger: readonly LedgerEntry[], site: SocialSiteId, action: PublishAction, hash: string, now: number, settings: PacingSettings = DEFAULT_PACING): Allowance {
  const hour = new Date(now).getHours();
  if (inQuiet(hour, settings.quiet)) {
    const next = new Date(now);
    next.setHours(settings.quiet.to, 0, 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    return { ok: false, why: `It is quiet time (${settings.quiet.from}:00 to ${settings.quiet.to}:00): nothing is published then.`, retryAt: next.getTime() };
  }
  const dup = ledger.find((e) => e.site === site && e.hash === hash && now - e.at < settings.duplicateDays * DAY);
  if (dup !== undefined) return { ok: false, why: `This exact text was already published on ${new Date(dup.at).toLocaleDateString('en-GB')}. The same text is not published twice.` };
  const mine = ledger.filter((e) => e.site === site && e.action === action);
  const today = mine.filter((e) => sameLocalDay(e.at, now)).length;
  if (today >= settings.caps[action]) {
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    next.setHours(settings.quiet.to, 0, 0, 0);
    return { ok: false, why: `The limit for today is reached (${settings.caps[action]} ${action}${settings.caps[action] === 1 ? '' : 's'} a day on one site, to keep the account safe).`, retryAt: next.getTime() };
  }
  const last = mine.reduce((m, e) => Math.max(m, e.at), 0);
  const gap = settings.minGapMinutes[action] * MIN;
  if (last > 0 && now - last < gap) return { ok: false, why: `Too soon after the last one: at least ${settings.minGapMinutes[action]} minutes between two of them.`, retryAt: last + gap };
  return { ok: true };
}

/** How many of each kind are left today on one site (for "what may Eya still do today"). */
export function remainingToday(ledger: readonly LedgerEntry[], site: SocialSiteId, now: number, settings: PacingSettings = DEFAULT_PACING): Readonly<Record<PublishAction, number>> {
  const left = (a: PublishAction): number => Math.max(0, settings.caps[a] - ledger.filter((e) => e.site === site && e.action === a && sameLocalDay(e.at, now)).length);
  return { post: left('post'), comment: left('comment'), reply: left('reply'), apply: left('apply'), proposal: left('proposal') };
}
