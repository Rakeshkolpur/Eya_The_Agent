import { isBlockedName, isBlockedSite } from '@main/research/trust';
import { rootLogger } from '@main/logging/logger';
import { challengeMessage, isBlockingChallenge } from './challenges';
import { BrowserNavigationError, BrowserUnavailableError } from './errors';
import { classifyNavigationError } from './navigationErrors';
import type { NavigationProblem, NavigationProblemKind } from './navigationErrors';
import type { OpenWebsiteOptions } from './BrowserAutomationService';
import type { PageSnapshot } from './pageSnapshot';
import { brandLabel, contentMatch, hostOf, isThin, judgeIdentity, problemOfPage, rankCandidates, rankResults, registrableDomain, sameSite, significantTokens, suspiciousReason } from './siteIdentity';
import type { Candidate } from './siteIdentity';
import type { WebSearchHit } from './webSearchResults';

const log = rootLogger.child('browser.recovery');

/**
 * Opening a website the way a persistent person would: try the address, check the page that came up is really there and really the site,
 * and when it is not, change what is being done instead of knocking on the same door again: once more for a hiccup, then look for the
 * site's current address, check that it is the same site, and open that. Every step is bounded (a time budget, a few opens, a couple of
 * searches), and it stops at once at a CAPTCHA, a sign-in wall or a site it cannot vouch for, and says so.
 */

export interface RecoveryConfig {
  /** How long one page may take to open before it counts as not answering. */
  readonly attemptTimeoutMs: number;
  /** The whole task, from the first open to the verdict. */
  readonly maxTotalMs: number;
  /** Most pages opened in one task (the first address, its retries, and each alternative). */
  readonly maxOpens: number;
  readonly maxSearches: number;
  /** Most alternative addresses opened. */
  readonly maxCandidates: number;
  /** Extra tries of the same address, only for a problem that may pass (a timeout, a busy server). */
  readonly retries: number;
  readonly retryDelayMs: number;
  /** How long a page that is blank, or lacks what was asked for, is given to build itself (scripts, slow content). */
  readonly contentWaitMs: number;
  readonly contentPollMs: number;
}

export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  // (the whole task stays inside the 90 seconds one request is given; a longer one would be cut off by the agent's own time budget)
  attemptTimeoutMs: 30_000,
  maxTotalMs: 75_000,
  maxOpens: 6,
  maxSearches: 2,
  maxCandidates: 3,
  retries: 1,
  retryDelayMs: 1500,
  contentWaitMs: 5000,
  contentPollMs: 750,
};

export interface SiteTarget {
  /** An address the person gave or that was saved (it may be out of date). */
  readonly url?: string;
  /** What the person calls the site ("the Telangana High Court"). */
  readonly name?: string;
  /** Words that must be on the page for it to count as the right one. */
  readonly expect?: readonly string[];
  /** The person named their own browser. */
  readonly browser?: 'chrome' | 'edge';
  /** No site was named: what the person wants, in their words. The web is searched, the results opened one by one, and the first page that really has it is kept. */
  readonly keywords?: string;
}

export type RecoveryEventKind =
  | 'opening'
  | 'loaded'
  | 'redirect'
  | 'content_found'
  | 'recovering'
  | 'searching'
  | 'verifying'
  | 'needs_you'
  | 'failed'
  // (the download that follows a website being opened)
  | 'locating'
  | 'download_started'
  | 'checking'
  | 'download_completed';

/** What is happening, in words the person can read (never a log line). */
export interface RecoveryEvent {
  readonly kind: RecoveryEventKind;
  readonly message: string;
  readonly url?: string;
}

/** What recovery needs from the browser: open a page, look at it again, search the web. */
export interface RecoveryHost {
  open(url: string, options?: OpenWebsiteOptions): Promise<PageSnapshot>;
  look(): Promise<PageSnapshot>;
  search(query: string): Promise<WebSearchHit[]>;
}

export interface OpenedOutcome {
  readonly status: 'opened';
  readonly snapshot: PageSnapshot;
  /** The address first tried (null when only a name was given). */
  readonly requested: string | null;
  /** Where the page really is. */
  readonly url: string;
  readonly via: 'known' | 'retry' | 'redirect' | 'alternative' | 'search';
  /** Whether it is confirmed to be the site that was asked for. */
  readonly verified: boolean;
  /** Whether what was asked for is on the page (null when nothing specific was asked for). */
  readonly contentFound: boolean | null;
  /** The page itself asks for a sign-in (it opened; the person signs in). */
  readonly signInNeeded: boolean;
  readonly attempts: number;
  /** What happened on the way, in plain words (for the model to tell the person). */
  readonly notes: readonly string[];
}

export interface NeedsUserOutcome {
  readonly status: 'needs_user';
  readonly why: 'challenge' | 'sign_in' | 'unverified_site';
  readonly message: string;
  readonly candidate?: { readonly url: string; readonly reason: string };
  readonly snapshot?: PageSnapshot;
  readonly attempts: number;
  readonly notes: readonly string[];
}

export interface FailedOutcome {
  readonly status: 'failed';
  readonly why: 'unreachable' | 'not_found' | 'no_content' | 'time_budget' | 'attempt_limit' | 'no_alternative' | 'blocked_site';
  readonly message: string;
  readonly problem?: NavigationProblem;
  readonly attempts: number;
  /** The hosts that were tried. */
  readonly tried: readonly string[];
  readonly notes: readonly string[];
}

export type RecoveryOutcome = OpenedOutcome | NeedsUserOutcome | FailedOutcome;

export interface RecoveryDeps {
  readonly host: RecoveryHost;
  readonly config?: Partial<RecoveryConfig>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly progress?: (event: RecoveryEvent) => void;
}

type Attempt =
  | { readonly kind: 'ok'; readonly snapshot: PageSnapshot; readonly verified: boolean; readonly contentFound: boolean | null; readonly redirected: boolean; readonly signIn: boolean }
  | { readonly kind: 'problem'; readonly problem: NavigationProblem; readonly contentMissing?: boolean }
  | { readonly kind: 'needs_user'; readonly outcome: NeedsUserOutcome }
  | { readonly kind: 'wrong'; readonly reason: string }
  | { readonly kind: 'unclear'; readonly url: string; readonly reason: string };

interface Run {
  readonly started: number;
  opens: number;
  searches: number;
  readonly tried: string[];
  readonly notes: string[];
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function parseHttp(raw: string | undefined): URL | null {
  if (raw === undefined) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function toProblem(err: unknown, url: string): NavigationProblem {
  if (err instanceof BrowserNavigationError) {
    return { kind: err.problem.kind as NavigationProblemKind, message: err.problem.message, retryable: err.problem.retryable, ...(err.problem.next !== undefined ? { next: err.problem.next } : {}) };
  }
  return classifyNavigationError(err, url);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout ${ms}ms exceeded`)), ms);
  });
  return Promise.race([work, limit]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export class NavigationRecovery {
  private readonly cfg: RecoveryConfig;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Tasks running right now, by what they are about: the same task asked for twice shares one loop. */
  private readonly inflight = new Map<string, Promise<RecoveryOutcome>>();

  constructor(private readonly deps: RecoveryDeps) {
    this.cfg = { ...DEFAULT_RECOVERY_CONFIG, ...deps.config };
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? realSleep;
  }

  /** Opens the site, recovering when it does not simply open. Never throws for a site's own trouble; a browser that is not available does throw. */
  open(target: SiteTarget): Promise<RecoveryOutcome> {
    const key = `${(target.url ?? '').toLowerCase()}|${(target.name ?? '').toLowerCase().trim()}|${(target.expect ?? []).join(',').toLowerCase()}|${target.browser ?? ''}|${(target.keywords ?? '').toLowerCase().trim()}`;
    const running = this.inflight.get(key);
    if (running !== undefined) return running;
    const task = this.run(target).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  private say(kind: RecoveryEventKind, message: string, url?: string): void {
    this.deps.progress?.({ kind, message, ...(url !== undefined ? { url } : {}) });
  }

  private over(run: Run): 'time_budget' | 'attempt_limit' | null {
    if (this.now() - run.started >= this.cfg.maxTotalMs) return 'time_budget';
    if (run.opens >= this.cfg.maxOpens) return 'attempt_limit';
    return null;
  }

  private async run(target: SiteTarget): Promise<RecoveryOutcome> {
    const cfg = this.cfg;
    const run: Run = { started: this.now(), opens: 0, searches: 0, tried: [], notes: [] };
    const known = parseHttp(target.url);
    // No address and no site name, only what the person wants: search for it.
    if (known === null && (target.name ?? '').trim() === '' && (target.keywords ?? '').trim() !== '') return this.discover(target, run);
    const name = (target.name ?? '').trim() || (known !== null ? brandLabel(hostOf(known.href)) : '');
    const triedHosts = new Set<string>();
    let lastProblem: NavigationProblem | null = null;
    let contentMissing = false;
    let unclear: { readonly url: string; readonly reason: string } | null = null;

    // ------------------------------------------------------------------ 1. the address that is known (and once more if it was a hiccup)
    if (known !== null) {
      triedHosts.add(hostOf(known.href));
      for (let n = 0; n <= cfg.retries; n++) {
        const limit = this.over(run);
        if (limit !== null) return this.exhausted(run, limit, lastProblem);
        const a = await this.attempt(known.href, target, 'known', run, n > 0);
        if (a.kind === 'ok') return this.opened(known.href, n > 0 ? 'retry' : a.redirected ? 'redirect' : 'known', a, run);
        if (a.kind === 'needs_user') return a.outcome;
        if (a.kind === 'unclear') unclear = { url: a.url, reason: a.reason };
        if (a.kind === 'wrong') run.notes.push(`The address went to a different site: ${a.reason}.`);
        if (a.kind === 'problem') {
          lastProblem = a.problem;
          contentMissing = a.contentMissing === true;
          if (a.problem.retryable && !contentMissing && n < cfg.retries) {
            this.say('recovering', 'The page did not answer properly. Trying once more…', known.href);
            run.notes.push(`${hostOf(known.href)} did not answer properly the first time (${a.problem.kind}); tried once more.`);
            await this.sleep(cfg.retryDelayMs * (n + 1));
            continue;
          }
        }
        break;
      }
    }

    // ------------------------------------------------------------------ 2. find where the site is now
    if (name === '') {
      return this.failed(run, 'no_alternative', lastProblem, `${lastProblem?.message ?? 'The page did not open.'} I was not told which site this is, so I cannot look for its current address.`);
    }
    if ((known !== null && isBlockedSite(known.href)) || isBlockedSite(`https://${name.replace(/\s+/g, '')}.com/`) || isBlockedName(name)) {
      // (said as it is: nothing was searched or opened here, so nothing may be claimed; and the lawful next step is named, so the answer is not a
      // bare "no" or a request for a link)
      const limit = known !== null ? `${lastProblem?.message ?? 'That address did not open.'} It looks like a site that gives films, songs or programs away without permission, and I do not go looking for new addresses of sites like that.` : `I did not open ${name} and did not search for it: it looks like a site that gives films, songs or programs away without permission, and I do not go looking for the addresses of sites like that or open them by name.`;
      return this.failed(
        run,
        'blocked_site',
        lastProblem,
        `${limit} Say that plainly and do not claim anything was searched or checked on that site. Then do what can be done lawfully: look for a legal place for what the person wants (deep_research with kind media and no_site true, or play_on_youtube for an official upload) and tell them what that finds. An exact link from the person can still be opened and looked at, but nothing is played or downloaded from such a site.`,
      );
    }
    this.say('recovering', known !== null ? 'The saved address is unavailable. Finding its current address…' : 'Finding the website…');
    const oldHost = known !== null ? hostOf(known.href) : '';
    const found = new Map<string, Candidate>();
    const queries = [`${name} official website`, oldHost !== '' ? `${name} ${oldHost} new address working` : `${name} homepage`];
    for (const q of queries.slice(0, cfg.maxSearches)) {
      if (this.over(run) === 'time_budget') break;
      run.searches += 1;
      this.say('searching', 'Looking for the right address…');
      let hits: WebSearchHit[] = [];
      try {
        hits = await withTimeout(this.deps.host.search(q), cfg.attemptTimeoutMs);
      } catch (err) {
        if (err instanceof BrowserUnavailableError) throw err;
        run.notes.push('A web search did not work.');
        continue;
      }
      for (const c of rankCandidates(hits, { name, oldHost, triedHosts })) {
        const have = found.get(c.host);
        found.set(c.host, have === undefined ? c : { ...have, score: have.score + c.score, why: [...have.why, ...c.why] });
      }
      if ([...found.values()].some((c) => c.score >= 6)) break;
    }
    const ordered = [...found.values()].sort((a, b) => b.score - a.score).slice(0, cfg.maxCandidates);

    // ------------------------------------------------------------------ 3. open the alternatives, one at a time, and check each really is the site
    for (const c of ordered) {
      if (this.over(run) !== null) break;
      triedHosts.add(c.host);
      this.say('verifying', 'Found an alternative. Verifying the page…', c.url);
      const a = await this.attempt(c.url, { ...target, name }, 'alternative', run);
      if (a.kind === 'ok') {
        const from = known !== null ? hostOf(known.href) : null;
        if (from !== null) run.notes.push(`The saved address (${from}) did not work. ${hostOf(a.snapshot.url)} is the site's current address (${c.why.join('; ')}) and the page was checked.`);
        return this.opened(known?.href ?? null, 'alternative', a, run);
      }
      if (a.kind === 'needs_user') return a.outcome;
      if (a.kind === 'wrong') run.notes.push(`${c.host} was not the site: ${a.reason}.`);
      else if (a.kind === 'unclear') unclear = unclear ?? { url: a.url, reason: a.reason };
      else if (a.kind === 'problem') {
        lastProblem = a.problem;
        contentMissing = contentMissing || a.contentMissing === true;
      }
    }

    // ------------------------------------------------------------------ 4. nothing could be confirmed
    if (unclear !== null) {
      const message = `I found ${hostOf(unclear.url)}, which may be the site you mean, but I cannot confirm it (${unclear.reason}). Do you want me to go there?`;
      this.say('needs_you', message, unclear.url);
      return { status: 'needs_user', why: 'unverified_site', message, candidate: unclear, attempts: run.opens, notes: [...run.notes] };
    }
    const limit = this.over(run);
    if (limit !== null) return this.exhausted(run, limit, lastProblem);
    if (ordered.length === 0) {
      return this.failed(run, contentMissing ? 'no_content' : lastProblem?.kind === 'not_found' ? 'not_found' : 'no_alternative', lastProblem, `${lastProblem?.message ?? 'The page did not open.'} I searched for the site's current address and found nothing I could trust.`);
    }
    return this.failed(run, contentMissing ? 'no_content' : 'no_alternative', lastProblem, `${lastProblem?.message ?? 'The page did not open.'} I tried ${ordered.length === 1 ? 'one other address' : `${ordered.length} other addresses`} and none could be confirmed as the site.`);
  }

  // ------------------------------------------------------------------------------- nobody named the site: search for what was asked
  private async discover(target: SiteTarget, run: Run): Promise<RecoveryOutcome> {
    const cfg = this.cfg;
    const words = (target.keywords ?? '').trim();
    const tokens = significantTokens(words).slice(0, 8);
    // What a page must have to count: the words that were asked for, or the person's own "expect" words.
    const needed = target.expect !== undefined && target.expect.length > 0 ? target.expect : tokens;
    const tried = new Set<string>();
    const found = new Map<string, Candidate>();
    let blocked: NeedsUserOutcome | null = null;
    let lastProblem: NavigationProblem | null = null;
    const queries = [words, `${words} official site`];
    this.say('searching', 'Searching the web for what you asked…');
    for (const q of queries.slice(0, cfg.maxSearches)) {
      if (this.over(run) === 'time_budget') break;
      run.searches += 1;
      let hits: WebSearchHit[] = [];
      try {
        hits = await withTimeout(this.deps.host.search(q), cfg.attemptTimeoutMs);
      } catch (err) {
        if (err instanceof BrowserUnavailableError) throw err;
        run.notes.push('A web search did not work.');
        continue;
      }
      for (const c of rankResults(hits, tokens, tried)) {
        const have = found.get(c.url);
        found.set(c.url, have === undefined ? c : { ...have, score: have.score + c.score, why: [...have.why, ...c.why] });
      }
      // (a strong result in the first search is enough: no second search for it)
      if ([...found.values()].some((c) => c.score >= 6)) break;
    }
    const ordered = [...found.values()].sort((a, b) => b.score - a.score).slice(0, cfg.maxCandidates + 1);
    for (const c of ordered) {
      if (this.over(run) !== null) break;
      tried.add(c.url);
      this.say('verifying', 'Checking a result…', c.url);
      const a = await this.attempt(c.url, { ...target, expect: needed }, 'discovered', run);
      if (a.kind === 'ok') {
        run.notes.push(`Found through a web search for "${words.slice(0, 80)}": ${hostOf(a.snapshot.url)} (${c.why.join('; ') || 'the best match'}), and the page was checked.`);
        return this.opened(null, 'search', a, run);
      }
      if (a.kind === 'needs_user') {
        blocked = blocked ?? a.outcome;
        run.notes.push(`${c.host} asked for a human check, so another result was tried.`);
      } else if (a.kind === 'problem') {
        lastProblem = a.problem;
        run.notes.push(`${c.host}: ${a.contentMissing === true ? 'it opened but did not have what was asked for' : a.problem.message}`);
      } else if (a.kind === 'wrong' || a.kind === 'unclear') run.notes.push(`${c.host} was not a good match.`);
    }
    if (blocked !== null) return blocked;
    const limit = this.over(run);
    if (limit !== null) return this.exhausted(run, limit, lastProblem);
    return this.failed(
      run,
      'no_alternative',
      lastProblem,
      ordered.length === 0
        ? `I searched the web for "${words.slice(0, 80)}" and found nothing I could use.`
        : `I searched the web for "${words.slice(0, 80)}" and checked ${ordered.length === 1 ? 'one result' : `${ordered.length} results`}, but none of them had it.`,
    );
  }

  // -------------------------------------------------------------------------------------------- one page
  private async attempt(url: string, target: SiteTarget, role: 'known' | 'alternative' | 'discovered', run: Run, fresh = false): Promise<Attempt> {
    run.opens += 1;
    run.tried.push(hostOf(url) || url);
    this.say('opening', role === 'known' ? 'Opening the requested website…' : role === 'discovered' ? 'Opening a result…' : 'Opening the alternative address…', url);
    let snapshot: PageSnapshot;
    try {
      // (a try after a failure loads the address again, even if a tab is already showing it: otherwise the tab showing the error is only brought to the front)
      const options = { ...(target.browser !== undefined ? { browser: target.browser } : {}), ...(fresh ? { fresh: true as const } : {}) };
      snapshot = await withTimeout(this.deps.host.open(url, Object.keys(options).length > 0 ? options : undefined), this.cfg.attemptTimeoutMs);
    } catch (err) {
      if (err instanceof BrowserUnavailableError) throw err;
      const problem = toProblem(err, url);
      log.info('a page did not open', { host: hostOf(url), kind: problem.kind });
      return { kind: 'problem', problem };
    }

    // A page that is blank or still building itself is given a little time: scripts fill in many sites late.
    snapshot = await this.settle(snapshot, (s) => !isThin(s));

    const challenge = snapshot.challenge;
    if (challenge !== undefined && isBlockingChallenge(challenge.kind)) {
      const message = challengeMessage(challenge.kind);
      this.say('needs_you', 'The site is showing a check that only a person can pass.', snapshot.url);
      return { kind: 'needs_user', outcome: { status: 'needs_user', why: 'challenge', message, snapshot, attempts: run.opens, notes: [...run.notes] } };
    }

    const problem = problemOfPage(snapshot, url);
    if (problem !== null) return { kind: 'problem', problem };

    const redirected = !sameSite(url, snapshot.url);
    if (redirected) {
      this.say('redirect', `The site moved to ${hostOf(snapshot.url)}. Checking it is the right place…`, snapshot.url);
      const risky = suspiciousReason(snapshot.url, url);
      if (risky !== null) {
        const message = `The address redirected to ${hostOf(snapshot.url)}, and I did not follow it because ${risky}. Do you want me to go there anyway?`;
        this.say('needs_you', message, snapshot.url);
        return { kind: 'needs_user', outcome: { status: 'needs_user', why: 'unverified_site', message, candidate: { url: snapshot.url, reason: risky }, snapshot, attempts: run.opens, notes: [...run.notes] } };
      }
    }

    // Who is it? An address on the same site as the one the person gave is theirs; anything else has to prove it.
    let verified = true;
    if (role === 'discovered' && redirected) {
      // (any good page will do, so a redirect to somewhere else is only another page to judge: it is judged by what is on it, below)
      verified = true;
    } else if (role === 'alternative' || redirected) {
      const judged = judgeIdentity(snapshot, { ...(target.name !== undefined ? { name: target.name } : {}), ...(target.url !== undefined ? { url: target.url } : {}) });
      if (judged.identity === 'mismatch') return { kind: 'wrong', reason: judged.reason };
      if (judged.identity === 'unclear') {
        // (a redirect from the person's own address is kept as unclear too: they are asked before the browser stays somewhere unproven)
        return { kind: 'unclear', url: snapshot.url, reason: judged.reason };
      }
      verified = true;
    }
    this.say('loaded', 'The page is open.', snapshot.url);

    // Is what was asked for on it?
    let contentFound: boolean | null = null;
    const expect = target.expect ?? [];
    if (expect.length > 0) {
      const strict = role === 'discovered' && (target.keywords ?? '').trim() !== '';
      snapshot = await this.settle(snapshot, (s) => contentMatch(s, expect, strict).ok);
      const match = contentMatch(snapshot, expect, strict);
      contentFound = match.ok;
      if (match.ok) this.say('content_found', 'Found what was asked for on the page.', snapshot.url);
      else if (snapshot.challenge?.kind === 'login') {
        const message = `${hostOf(snapshot.url)} opened, but it asks you to sign in before it shows "${expect.join(' ')}". Please sign in yourself and I will carry on.`;
        this.say('needs_you', message, snapshot.url);
        return { kind: 'needs_user', outcome: { status: 'needs_user', why: 'sign_in', message, snapshot, attempts: run.opens, notes: [...run.notes] } };
      } else {
        return { kind: 'problem', contentMissing: true, problem: { kind: 'other', retryable: false, message: `${hostOf(snapshot.url)} opened, but I could not find "${expect.join(' ')}" on it.` } };
      }
    }
    return { kind: 'ok', snapshot, verified, contentFound, redirected, signIn: snapshot.challenge?.kind === 'login' };
  }

  /** Looks at the page again, for a while, until `ready` says it has what is needed. Returns the latest look. */
  private async settle(first: PageSnapshot, ready: (s: PageSnapshot) => boolean): Promise<PageSnapshot> {
    let snapshot = first;
    const until = this.now() + this.cfg.contentWaitMs;
    while (!ready(snapshot) && this.now() < until) {
      await this.sleep(this.cfg.contentPollMs);
      try {
        snapshot = await this.deps.host.look();
      } catch (err) {
        if (err instanceof BrowserUnavailableError) throw err;
        break;
      }
    }
    return snapshot;
  }

  private opened(requested: string | null, via: OpenedOutcome['via'], a: Extract<Attempt, { kind: 'ok' }>, run: Run): OpenedOutcome {
    const notes = [...run.notes];
    if (a.redirected && via !== 'alternative') notes.push(`The address redirected to ${hostOf(a.snapshot.url)}, and that page was checked: it is the site.`);
    if (a.signIn) notes.push('The page asks for a sign-in: that part is the person\'s to do.');
    return {
      status: 'opened',
      snapshot: a.snapshot,
      requested,
      url: a.snapshot.url,
      via,
      verified: a.verified,
      contentFound: a.contentFound,
      signInNeeded: a.signIn,
      attempts: run.opens,
      notes,
    };
  }

  private exhausted(run: Run, why: 'time_budget' | 'attempt_limit', problem: NavigationProblem | null): FailedOutcome {
    const reason = why === 'time_budget' ? 'I ran out of the time I allow for this' : `I reached the limit of ${this.cfg.maxOpens} pages for this`;
    return this.failed(run, why, problem, `${problem !== null ? `${problem.message} ` : ''}${reason}, so I stopped instead of trying again and again.`);
  }

  private failed(run: Run, why: FailedOutcome['why'], problem: NavigationProblem | null, message: string): FailedOutcome {
    this.say('failed', message);
    return { status: 'failed', why, message, ...(problem !== null ? { problem } : {}), attempts: run.opens, tried: [...new Set(run.tried)], notes: [...run.notes] };
  }
}

export { registrableDomain };
