import { describe, expect, it } from 'vitest';
import { DEFAULT_RECOVERY_CONFIG, NavigationRecovery } from '../src/main/browser/navigationRecovery';
import type { RecoveryEvent, RecoveryHost } from '../src/main/browser/navigationRecovery';
import { BrowserNavigationError, BrowserUnavailableError } from '../src/main/browser/errors';
import { classifyNavigationError } from '../src/main/browser/navigationErrors';
import type { PageSnapshot } from '../src/main/browser/pageSnapshot';
import type { WebSearchHit } from '../src/main/browser/webSearchResults';

function snap(url: string, title: string, text = 'Welcome. This page has enough ordinary text on it to count as a real page.', over: Partial<PageSnapshot> = {}): PageSnapshot {
  return { url, title, headings: title === '' ? [] : [title], links: ['Home', 'About', 'Contact'], buttons: [], inputs: [], dialogs: [], truncated: false, visibleText: text, ...over };
}

const dnsFailure = (url: string): BrowserNavigationError => new BrowserNavigationError(classifyNavigationError(new Error('net::ERR_NAME_NOT_RESOLVED'), url), url);
const timeoutFailure = (url: string): BrowserNavigationError => new BrowserNavigationError(classifyNavigationError(new Error('net::ERR_CONNECTION_TIMED_OUT'), url), url);

type Step = PageSnapshot | Error;

/** A pretend browser: each address answers from its own script (the last answer repeats), and every call takes a little pretend time. */
class FakeHost implements RecoveryHost {
  readonly opened: string[] = [];
  readonly searched: string[] = [];
  readonly clock = { t: 0 };
  looks: PageSnapshot[] = [];
  private current: PageSnapshot | null = null;
  constructor(
    private readonly script: Record<string, Step[]>,
    private readonly results: WebSearchHit[] = [],
    private readonly openMs = 100,
  ) {}

  async open(url: string): Promise<PageSnapshot> {
    this.opened.push(url);
    this.clock.t += this.openMs;
    const steps = this.script[url];
    if (steps === undefined || steps.length === 0) throw dnsFailure(url);
    const step = steps.length > 1 ? (steps.shift() as Step) : (steps[0] as Step);
    if (step instanceof Error) throw step;
    this.current = step;
    return step;
  }

  async look(): Promise<PageSnapshot> {
    const next = this.looks.length > 1 ? (this.looks.shift() as PageSnapshot) : (this.looks[0] ?? this.current);
    if (next === undefined || next === null) throw new Error('nothing is open');
    this.current = next;
    return next;
  }

  async search(query: string): Promise<WebSearchHit[]> {
    this.searched.push(query);
    return this.results;
  }
}

function recovery(host: FakeHost, config: Partial<typeof DEFAULT_RECOVERY_CONFIG> = {}): { r: NavigationRecovery; events: RecoveryEvent[] } {
  const events: RecoveryEvent[] = [];
  const r = new NavigationRecovery({
    host,
    config,
    now: () => host.clock.t,
    sleep: async (ms) => {
      host.clock.t += ms;
    },
    progress: (e) => events.push(e),
  });
  return { r, events };
}

const hit = (title: string, url: string, snippet = ''): WebSearchHit => ({ title, url, snippet });

describe('a website that opens on the first attempt', () => {
  it('opens it, checks the page is there, and says so step by step', async () => {
    const host = new FakeHost({ 'https://example.org/': [snap('https://example.org/', 'Example Org')] });
    const { r, events } = recovery(host);
    const out = await r.open({ url: 'https://example.org/' });
    expect(out.status).toBe('opened');
    if (out.status !== 'opened') return;
    expect(out.via).toBe('known');
    expect(out.verified).toBe(true);
    expect(out.attempts).toBe(1);
    expect(out.contentFound).toBeNull();
    expect(host.searched).toEqual([]);
    expect(events.map((e) => e.kind)).toEqual(['opening', 'loaded']);
    expect(events[0]?.message).toBe('Opening the requested website…');
  });

  it('waits for a page that builds itself with scripts, and does not call a blank page success', async () => {
    const blank: PageSnapshot = { url: 'https://spa.example/', title: '', headings: [], links: [], buttons: [], inputs: [], dialogs: [], truncated: false };
    const host = new FakeHost({ 'https://spa.example/': [blank] });
    host.looks = [blank, snap('https://spa.example/', 'Spa Example', 'The application has loaded and shows its content now, at last.')];
    const { r } = recovery(host);
    const out = await r.open({ url: 'https://spa.example/' });
    expect(out.status).toBe('opened');
    if (out.status === 'opened') expect(out.snapshot.title).toBe('Spa Example');
  });
});

describe('a temporary timeout', () => {
  it('is tried once more, and the second try opens it', async () => {
    const host = new FakeHost({ 'https://example.org/': [timeoutFailure('https://example.org/'), snap('https://example.org/', 'Example Org')] });
    const { r, events } = recovery(host);
    const out = await r.open({ url: 'https://example.org/' });
    expect(out.status).toBe('opened');
    if (out.status !== 'opened') return;
    expect(out.via).toBe('retry');
    expect(out.attempts).toBe(2);
    expect(host.opened).toEqual(['https://example.org/', 'https://example.org/']);
    expect(host.searched).toEqual([]);
    expect(events.some((e) => e.kind === 'recovering' && /once more/.test(e.message))).toBe(true);
    expect(out.notes.join(' ')).toMatch(/tried once more/);
  });

  it('a site that answers with a server error is also given one more try', async () => {
    const bad = snap('https://example.org/', 'Error', 'Server hiccup text that is long enough to count as text.', { notes: ['example.org answered "503": the site itself has an error.'] });
    const host = new FakeHost({ 'https://example.org/': [bad, snap('https://example.org/', 'Example Org')] });
    const { r } = recovery(host);
    const out = await r.open({ url: 'https://example.org/' });
    expect(out.status === 'opened' && out.via === 'retry').toBe(true);
  });
});

describe('an outdated address with a verified alternative', () => {
  it('does not knock on the broken door again: it looks for the current address, checks the page, and opens it', async () => {
    const host = new FakeHost(
      {
        'https://old-example.com/': [dnsFailure('https://old-example.com/')],
        'https://example-new.org/': [snap('https://example-new.org/', 'Example — official site')],
      },
      [hit('Example — official site', 'https://example-new.org/', 'The home of Example'), hit('Example forum', 'https://forum.net/example', 'chat about example')],
    );
    const { r, events } = recovery(host);
    const out = await r.open({ url: 'https://old-example.com/', name: 'Example' });
    expect(out.status).toBe('opened');
    if (out.status !== 'opened') return;
    expect(out.via).toBe('alternative');
    expect(out.url).toBe('https://example-new.org/');
    expect(out.verified).toBe(true);
    // the dead address was tried once (a missing name is not a hiccup) and then left alone
    expect(host.opened.filter((u) => u === 'https://old-example.com/')).toHaveLength(1);
    expect(host.searched.length).toBeGreaterThan(0);
    expect(events.map((e) => e.message)).toEqual(
      expect.arrayContaining(['Opening the requested website…', 'The saved address is unavailable. Finding its current address…', 'Found an alternative. Verifying the page…', 'The page is open.']),
    );
    expect(out.notes.join(' ')).toMatch(/old-example\.com\) did not work/);
  });

  it('works from a name alone, with no saved address at all', async () => {
    const host = new FakeHost({ 'https://example.org/': [snap('https://example.org/', 'Example')] }, [hit('Example', 'https://example.org/', 'Example')]);
    const out = await recovery(host).r.open({ name: 'Example' });
    expect(out.status).toBe('opened');
    expect(host.opened).toEqual(['https://example.org/']);
  });
});

describe('a redirect', () => {
  it('to the correct destination is followed, checked and accepted', async () => {
    const host = new FakeHost({ 'https://example.com/': [snap('https://www.example.org/home', 'Example')] });
    const { r, events } = recovery(host);
    const out = await r.open({ url: 'https://example.com/' });
    expect(out.status).toBe('opened');
    if (out.status !== 'opened') return;
    expect(out.via).toBe('redirect');
    expect(out.verified).toBe(true);
    expect(events.some((e) => e.kind === 'redirect' && /example\.org/.test(e.message))).toBe(true);
    expect(out.notes.join(' ')).toMatch(/redirected to example\.org/);
  });

  it('to a link-shortener or an unrelated site is not accepted without asking', async () => {
    const shortened = new FakeHost({ 'https://example.com/': [snap('https://bit.ly/x1', 'Redirecting')] });
    const a = await recovery(shortened).r.open({ url: 'https://example.com/' });
    expect(a.status).toBe('needs_user');
    if (a.status === 'needs_user') expect(a.why).toBe('unverified_site');
    const elsewhere = new FakeHost({ 'https://example.com/': [snap('https://shopdeals.net/', 'Best deals', 'Cheap shoes and bags and more of them for sale here, today.')] });
    const b = await recovery(elsewhere, { maxSearches: 0 }).r.open({ url: 'https://example.com/' });
    expect(b.status).toBe('failed');
  });
});

describe('a page that loads but does not have what was asked for', () => {
  it('waits for it, and accepts it when scripts bring it in', async () => {
    const bare = snap('https://court.example/', 'Court Example', 'Welcome to the court website. Nothing else is shown here for now.');
    const full = snap('https://court.example/', 'Court Example', 'Welcome. Cause list for today is below. Judgments and orders too.', { links: ['Cause List', 'Orders'] });
    const host = new FakeHost({ 'https://court.example/': [bare] });
    host.looks = [bare, full];
    const out = await recovery(host).r.open({ url: 'https://court.example/', expect: ['cause list'] });
    expect(out.status).toBe('opened');
    if (out.status === 'opened') expect(out.contentFound).toBe(true);
  });

  it('is not success when it never appears: it is reported as missing, after one search for another address', async () => {
    const bare = snap('https://court.example/', 'Court Example', 'Welcome to the court website. Nothing else is shown here for now.');
    const host = new FakeHost({ 'https://court.example/': [bare] }, []);
    host.looks = [bare];
    const out = await recovery(host).r.open({ url: 'https://court.example/', expect: ['cause list'] });
    expect(out.status).toBe('failed');
    if (out.status !== 'failed') return;
    expect(out.why).toBe('no_content');
    expect(out.message).toMatch(/could not find "cause list"/);
    expect(host.searched.length).toBeGreaterThan(0);
  });
});

describe('a search result that points to the wrong website', () => {
  it('is opened, found to be something else, and not used', async () => {
    const host = new FakeHost(
      { 'https://old-example.com/': [dnsFailure('https://old-example.com/')], 'https://shopdeals.com/e': [snap('https://shopdeals.com/e', 'Best Shop Deals', 'Cheap shoes and bags for sale in our shop today and tomorrow.')] },
      [hit('Example discount codes', 'https://shopdeals.com/e', 'codes for example')],
    );
    const out = await recovery(host).r.open({ url: 'https://old-example.com/', name: 'Example' });
    expect(out.status).toBe('failed');
    if (out.status !== 'failed') return;
    expect(out.why).toBe('no_alternative');
    expect(out.notes.join(' ')).toMatch(/shopdeals\.com was not the site/);
  });

  it('one that might be the site but cannot be confirmed is put to the person, not taken', async () => {
    const host = new FakeHost(
      { 'https://old-example.com/': [dnsFailure('https://old-example.com/')], 'https://deals.org/e': [snap('https://deals.org/e', 'Deals', 'Today we review Example Corp products and compare them with others in detail.')] },
      [hit('Example Corp reviewed', 'https://deals.org/e', 'about example corp')],
    );
    const out = await recovery(host).r.open({ url: 'https://old-example.com/', name: 'Example Corp' });
    expect(out.status).toBe('needs_user');
    if (out.status !== 'needs_user') return;
    expect(out.why).toBe('unverified_site');
    expect(out.candidate?.url).toBe('https://deals.org/e');
    expect(out.message).toMatch(/cannot confirm it/);
  });
});

describe('a site that needs a person', () => {
  it('stops at a CAPTCHA and does not try anything else', async () => {
    const host = new FakeHost({ 'https://example.org/': [snap('https://example.org/', 'Just a moment…', 'Checking that you are a human.', { challenge: { kind: 'captcha', hint: 'recaptcha' } })] }, [hit('Example', 'https://example.net/', 'Example')]);
    const { r, events } = recovery(host);
    const out = await r.open({ url: 'https://example.org/', name: 'Example' });
    expect(out.status).toBe('needs_user');
    if (out.status !== 'needs_user') return;
    expect(out.why).toBe('challenge');
    expect(out.message).toMatch(/will not try to get past it/);
    expect(host.opened).toHaveLength(1);
    expect(host.searched).toEqual([]);
    expect(events.some((e) => e.kind === 'needs_you')).toBe(true);
  });

  it('a sign-in wall in front of what was asked for is the person\'s to open; a plain sign-in page is simply reported', async () => {
    const login = snap('https://example.org/members', 'Sign in', 'Please sign in to continue to your account here.', { challenge: { kind: 'login', hint: 'password field' } });
    const walled = new FakeHost({ 'https://example.org/members': [login] });
    walled.looks = [login];
    const a = await recovery(walled).r.open({ url: 'https://example.org/members', expect: ['invoices'] });
    expect(a.status).toBe('needs_user');
    if (a.status === 'needs_user') expect(a.why).toBe('sign_in');
    const plain = new FakeHost({ 'https://example.org/members': [login] });
    const b = await recovery(plain).r.open({ url: 'https://example.org/members' });
    expect(b.status === 'opened' && b.signInNeeded).toBe(true);
  });
});

describe('the limits', () => {
  it('a task that keeps failing stops at the time budget instead of going on', async () => {
    const host = new FakeHost({ 'https://example.org/': [timeoutFailure('https://example.org/')] }, [hit('Example', 'https://example.net/', 'Example')], 70_000);
    const out = await recovery(host, { maxTotalMs: 100_000 }).r.open({ url: 'https://example.org/', name: 'Example' });
    expect(out.status).toBe('failed');
    if (out.status !== 'failed') return;
    expect(out.why).toBe('time_budget');
    expect(out.message).toMatch(/ran out of the time/);
    expect(host.opened.length).toBeLessThanOrEqual(2);
  });

  it('never opens more pages than the limit, however many addresses turn up', async () => {
    const script: Record<string, Step[]> = { 'https://old.example/': [dnsFailure('https://old.example/')] };
    const results: WebSearchHit[] = [];
    for (let i = 1; i <= 8; i++) {
      const url = `https://example${i}.org/`;
      script[url] = [snap(url, 'Something else', 'Unrelated page with plenty of ordinary text on it for the reader.')];
      results.push(hit('Example', url, 'example'));
    }
    const host = new FakeHost(script, results);
    const out = await recovery(host, { maxOpens: 3, maxCandidates: 5 }).r.open({ url: 'https://old.example/', name: 'Example' });
    expect(host.opened.length).toBeLessThanOrEqual(3);
    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect(out.why).toBe('attempt_limit');
  });

  it('searches no more than the limit', async () => {
    const host = new FakeHost({}, []);
    const out = await recovery(host, { maxSearches: 1 }).r.open({ url: 'https://gone.example/', name: 'Gone' });
    expect(host.searched).toHaveLength(1);
    expect(out.status).toBe('failed');
  });

  it('does not hunt for new addresses of a site that gives things away without permission, but still says why', async () => {
    const host = new FakeHost({ 'https://movierulz.ink/': [dnsFailure('https://movierulz.ink/')] }, [hit('Movierulz', 'https://movierulz.example/', 'movierulz')]);
    const out = await recovery(host).r.open({ url: 'https://movierulz.ink/' });
    expect(out.status).toBe('failed');
    if (out.status !== 'failed') return;
    expect(out.why).toBe('blocked_site');
    expect(host.searched).toEqual([]);
    expect(out.message).toMatch(/do not go looking for new addresses/);
  });

  it('a blocked site asked for by name alone is not searched or opened, and the result says exactly that and names the lawful next step', async () => {
    const host = new FakeHost({}, [hit('Movierulz', 'https://movierulz.example/', 'movierulz')]);
    const out = await recovery(host).r.open({ name: 'MovieRulz' });
    expect(out.status).toBe('failed');
    if (out.status !== 'failed') return;
    expect(out.why).toBe('blocked_site');
    expect(host.searched).toEqual([]);
    expect(host.opened).toEqual([]);
    expect(out.message).toMatch(/did not open MovieRulz and did not search for it/);
    expect(out.message).toMatch(/do not claim anything was searched or checked/);
    expect(out.message).toMatch(/deep_research/);
    expect(out.message).not.toMatch(/send me the exact link/i);
  });

  it('a blocked site misspelled by name ("movieruz") is not searched for or opened either', async () => {
    const host = new FakeHost({}, [hit('Watch Movies Online Free in HD', 'https://movieruzel.example/', 'movieruzel')]);
    const out = await recovery(host).r.open({ name: 'movieruz' });
    expect(out.status).toBe('failed');
    if (out.status !== 'failed') return;
    expect(out.why).toBe('blocked_site');
    expect(host.searched).toEqual([]);
    expect(host.opened).toEqual([]);
  });

  it('does nothing twice at once: the same task asked for again while it runs shares the one loop', async () => {
    const host = new FakeHost({ 'https://example.org/': [snap('https://example.org/', 'Example Org')] });
    const { r } = recovery(host);
    const [a, b] = await Promise.all([r.open({ url: 'https://example.org/' }), r.open({ url: 'https://example.org/' })]);
    expect(host.opened).toHaveLength(1);
    expect(a).toBe(b);
    // and once it is over, asking again is a new task
    await r.open({ url: 'https://example.org/' });
    expect(host.opened).toHaveLength(2);
  });

  it('a browser that is not available is not a site problem: it is passed up, not retried', async () => {
    const host: RecoveryHost = {
      open: async () => {
        throw new BrowserUnavailableError('The user pressed Stop.', { why: 'stopped' });
      },
      look: async () => snap('https://x.org/', 'X'),
      search: async () => [],
    };
    const r = new NavigationRecovery({ host, sleep: async () => undefined });
    await expect(r.open({ url: 'https://example.org/' })).rejects.toBeInstanceOf(BrowserUnavailableError);
  });

  it('says in the failure what was tried, in plain words and without codes', async () => {
    const host = new FakeHost({}, []);
    const out = await recovery(host).r.open({ url: 'https://gone.example/', name: 'Gone' });
    expect(out.status).toBe('failed');
    if (out.status !== 'failed') return;
    expect(out.message).not.toMatch(/ERR_|net::/);
    expect(out.message).toMatch(/could not be found/);
    expect(out.tried).toContain('gone.example');
  });
});

describe('no site named: only what the person wants', () => {
  const results = (list: Array<[string, string, string]>): WebSearchHit[] => list.map(([title, url, snippet]) => hit(title, url, snippet));
  const cause = (url: string, text = 'Cause list for today, Telangana High Court. Judgments and orders are listed below with their case numbers and dates.'): PageSnapshot => snap(url, 'Cause List — Telangana High Court', text, { links: ['Cause List', 'Orders'] });

  it('searches the web with the words, opens the relevant result, checks it really has what was asked for, and keeps it', async () => {
    const host = new FakeHost({ 'https://tshc.gov.in/causelist': [cause('https://tshc.gov.in/causelist')] }, results([['Cause List — Telangana High Court', 'https://tshc.gov.in/causelist', 'Today\'s cause list of the Telangana High Court']]));
    const { r, events } = recovery(host);
    const out = await r.open({ keywords: 'telangana high court cause list today' });
    expect(out.status).toBe('opened');
    if (out.status !== 'opened') return;
    expect(out.via).toBe('search');
    expect(out.contentFound).toBe(true);
    expect(host.searched[0]).toBe('telangana high court cause list today');
    expect(out.notes.join(' ')).toMatch(/Found through a web search/);
    expect(events.map((e) => e.message)).toEqual(expect.arrayContaining(['Searching the web for what you asked…', 'Checking a result…']));
  });

  it('tries the next result when the first does not have it, instead of giving up or asking', async () => {
    // (the official-looking result ranks first, but its page turns out to be about something else)
    const host = new FakeHost(
      {
        'https://tshc.gov.in/home': [snap('https://tshc.gov.in/home', 'Telangana High Court', 'Welcome to the Telangana High Court. This page has the history of the court and the names of its judges, nothing else for now.')],
        'https://lawnews.example/causelist': [cause('https://lawnews.example/causelist')],
      },
      results([
        ['Telangana High Court cause list', 'https://tshc.gov.in/home', 'Telangana High Court'],
        ['Cause List — Telangana High Court today', 'https://lawnews.example/causelist', 'cause list Telangana High Court'],
      ]),
    );
    const out = await recovery(host).r.open({ keywords: 'telangana high court cause list' });
    expect(out.status).toBe('opened');
    if (out.status !== 'opened') return;
    expect(out.url).toBe('https://lawnews.example/causelist');
    expect(host.opened).toEqual(['https://tshc.gov.in/home', 'https://lawnews.example/causelist']);
    expect(out.notes.join(' ')).toMatch(/tshc.gov.in: it opened but did not have what was asked for/);
  });

  it('a CAPTCHA on one result is not the end: another result is tried; only when every one is blocked does it hand the problem to the person', async () => {
    const blocked = (u: string): PageSnapshot => snap(u, 'Cause list check', 'Checking that you are a human before the cause list.', { challenge: { kind: 'captcha', hint: 'x' } });
    const ok = new FakeHost(
      { 'https://a.example/cause-list': [blocked('https://a.example/cause-list')], 'https://tshc.gov.in/causelist': [cause('https://tshc.gov.in/causelist')] },
      results([['Cause list Telangana High Court', 'https://a.example/cause-list', 'cause list'], ['Cause List — Telangana High Court', 'https://tshc.gov.in/causelist', 'cause list Telangana High Court']]),
    );
    expect((await recovery(ok).r.open({ keywords: 'telangana high court cause list' })).status).toBe('opened');
    const all = new FakeHost({ 'https://a.example/cause-list': [blocked('https://a.example/cause-list')] }, results([['Cause list Telangana High Court', 'https://a.example/cause-list', 'cause list']]));
    const out = await recovery(all).r.open({ keywords: 'telangana high court cause list' });
    expect(out.status).toBe('needs_user');
    if (out.status === 'needs_user') expect(out.why).toBe('challenge');
  });

  it('says what it tried when nothing had it, and never offers a site that gives things away without permission', async () => {
    const host = new FakeHost(
      { 'https://other.example/': [snap('https://other.example/', 'Something else', 'An unrelated page with plenty of ordinary text on it for the reader to read.')] },
      results([
        ['Telangana High Court cause list', 'https://other.example/', 'cause list'],
        ['Telangana High Court cause list free download', 'https://movierulz.example-mirror.com/', 'cause list'],
      ]),
    );
    const out = await recovery(host).r.open({ keywords: 'telangana high court cause list' });
    expect(out.status).toBe('failed');
    if (out.status !== 'failed') return;
    expect(out.message).toMatch(/checked one result, but none of them had it/);
    expect(host.opened).toEqual(['https://other.example/']);
    const nothing = await recovery(new FakeHost({}, [])).r.open({ keywords: 'zxqv unfindable thing' });
    expect(nothing.status === 'failed' && /found nothing I could use/.test(nothing.message)).toBe(true);
  });

  it('stays inside the limits however many results there are', async () => {
    const script: Record<string, Step[]> = {};
    const list: Array<[string, string, string]> = [];
    for (let i = 1; i <= 9; i++) {
      const url = `https://site${i}.example/`;
      script[url] = [snap(url, 'Unrelated', 'An unrelated page with plenty of ordinary text on it for the reader to read.')];
      list.push(['Telangana High Court cause list', url, 'cause list']);
    }
    const host = new FakeHost(script, results(list));
    const out = await recovery(host, { maxCandidates: 3, maxOpens: 6 }).r.open({ keywords: 'telangana high court cause list' });
    expect(host.opened.length).toBeLessThanOrEqual(4);
    expect(out.status).toBe('failed');
  });
});
