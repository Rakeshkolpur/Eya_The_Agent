import { describe, it, expect, vi } from 'vitest';
import { classifyNavigationError, describeHttpStatus, describeRedirect } from '../src/main/browser/navigationErrors';
import { asksForEyaBrowser, asksForMyBrowser, chooseBrowser } from '../src/main/browser/browserRouter';
import { BrowserPanel, BrowserStoppedError, describeAction } from '../src/main/browser/BrowserPanel';
import { BrowserNavigationError } from '../src/main/browser/errors';
import { addressFrom, createBrowserPanelController } from '../src/main/browser/browserPanelController';
import type { BrowserPanelWiring } from '../src/main/browser/browserPanelController';
import type { HostEvent } from '../src/main/browser/EmbeddedPageHost';
import { failureToolResult } from './browserEyaHelpers';

describe('why a page would not open, in words', () => {
  it('knows the browser\'s own codes', () => {
    const cases: Array<[string, string, boolean]> = [
      ['page.goto: net::ERR_NAME_NOT_RESOLVED at https://nope.invalid/', 'dns', false],
      ['net::ERR_CONNECTION_REFUSED', 'refused', false],
      ['page.goto: Timeout 20000ms exceeded.', 'timeout', true],
      ['net::ERR_CONNECTION_TIMED_OUT', 'timeout', true],
      ['net::ERR_TOO_MANY_REDIRECTS', 'redirect_loop', false],
      ['net::ERR_CERT_AUTHORITY_INVALID', 'certificate', false],
      ['net::ERR_INTERNET_DISCONNECTED', 'offline', true],
      ['net::ERR_BLOCKED_BY_CLIENT', 'blocked', false],
      ['net::ERR_ABORTED', 'aborted', true],
      ['Target closed', 'crashed', true],
      ['something odd happened', 'other', false],
    ];
    for (const [text, kind, retryable] of cases) {
      const p = classifyNavigationError(new Error(text), 'https://records.example/cases?id=7');
      expect(p.kind, text).toBe(kind);
      expect(p.retryable, text).toBe(retryable);
      expect(p.message, text).not.toMatch(/net::/);
    }
  });

  it('names the site, never the whole address (a long query could hold something private)', () => {
    const p = classifyNavigationError(new Error('net::ERR_NAME_NOT_RESOLVED'), 'https://records.example/a/very/long/path/with/many/parts?token=SECRET-VALUE-123');
    expect(p.message).toContain('records.example');
    expect(p.message).not.toContain('SECRET-VALUE-123');
  });

  it('a site\'s own error code is a problem, a normal answer is not', () => {
    expect(describeHttpStatus(200, 'https://a.example/')).toBeNull();
    expect(describeHttpStatus(302, 'https://a.example/')).toBeNull();
    expect(describeHttpStatus(null, 'https://a.example/')).toBeNull();
    expect(describeHttpStatus(403, 'https://a.example/x')).toMatchObject({ kind: 'access_denied', retryable: false });
    expect(describeHttpStatus(401, 'https://a.example/x')?.message).toMatch(/sign-in is needed/);
    expect(describeHttpStatus(404, 'https://a.example/x')).toMatchObject({ kind: 'not_found', retryable: false });
    expect(describeHttpStatus(429, 'https://a.example/x')).toMatchObject({ kind: 'rate_limited', retryable: true });
    expect(describeHttpStatus(503, 'https://a.example/x')).toMatchObject({ kind: 'server_error', retryable: true });
  });

  it('says when an address ended up somewhere else, and loudly when it is another site', () => {
    expect(describeRedirect('https://a.example/x', 'https://a.example/x')).toBeNull();
    expect(describeRedirect('https://a.example/x?q=1', 'https://a.example/x')).toBeNull(); // only the query differs (it is shortened)
    expect(describeRedirect('https://a.example/x', 'https://www.a.example/x')).toBeNull();
    expect(describeRedirect('https://a.example/old', 'https://a.example/new')).toMatch(/redirected from a\.example\/old to a\.example\/new/);
    expect(describeRedirect('https://a.example/', 'https://b.example/landing')).toMatch(/DIFFERENT site.*b\.example/);
  });

  it('a navigation error carries the reason and what to do', async () => {
    const problem = classifyNavigationError(new Error('net::ERR_NAME_NOT_RESOLVED'), 'https://nope.invalid/');
    const e = new BrowserNavigationError(problem, 'https://nope.invalid/');
    expect(e.message).toMatch(/could not be found/);
    expect(e.message).toMatch(/typing mistake/);
    const result = await failureToolResult(e);
    expect(result).toMatchObject({ ok: false, summary: 'page did not open', data: { navigation: { problem: 'dns', canRetry: false } } });
    // not the end of the task: the failure itself tells the assistant to work the right address out, not to ask the person for it
    expect(String((result as { data?: { next?: string } }).data?.next)).toMatch(/call find_and_open_website/);
    expect(String((result as { data?: { next?: string } }).data?.next)).toMatch(/do not ask the user for the address/i);
  });
});

describe('which browser a task works in, by rules and never by asking', () => {
  const base = { preference: 'eya' as const, words: '', pinned: null, chatApp: false };

  it('Eya Browser is the default', () => {
    expect(chooseBrowser(base)).toMatchObject({ browser: 'eya' });
    for (const words of ['search this for me', 'research the case number', 'open this website', 'find something online', 'download the report']) {
      expect(chooseBrowser({ ...base, words }).browser, words).toBe('eya');
    }
  });

  it('their own browser, when they say so', () => {
    for (const words of [
      'use my Chrome',
      'open it in my Edge',
      'continue in my existing tab',
      'use my logged-in account',
      'do this in my personal browser',
      'in my browser please',
      'work in my current tab',
      'use my own browser',
    ]) {
      expect(asksForMyBrowser(words), words).toBe(true);
      expect(chooseBrowser({ ...base, words }).browser, words).toBe('mine');
    }
  });

  it('does not take ordinary words for a request for their browser', () => {
    for (const words of ['open my orders page on flipkart', 'what is in my account balance', 'my chrome extension list is long, search for ideas', 'search this', 'open the browser history of the case']) {
      expect(chooseBrowser({ ...base, words }).browser, words).toBe(words.includes('my chrome extension') ? 'mine' : 'eya');
    }
  });

  it('Eya Browser by name beats everything, even where the task is', () => {
    expect(asksForEyaBrowser('do it in Eya Browser')).toBe(true);
    expect(chooseBrowser({ ...base, words: 'do it in Eya Browser', pinned: 'mine', preference: 'mine' }).browser).toBe('eya');
  });

  it('a task already under way stays there unless the user says otherwise', () => {
    expect(chooseBrowser({ ...base, pinned: 'mine' })).toMatchObject({ browser: 'mine' });
    expect(chooseBrowser({ ...base, pinned: 'eya', preference: 'mine' }).browser).toBe('eya');
    expect(chooseBrowser({ ...base, pinned: 'eya', words: 'continue in my Chrome' }).browser).toBe('mine');
  });

  it('a chat app goes to their browser, and the saved preference is used when nothing else decides', () => {
    expect(chooseBrowser({ ...base, chatApp: true })).toMatchObject({ browser: 'mine' });
    expect(chooseBrowser({ ...base, preference: 'mine' }).browser).toBe('mine');
    expect(chooseBrowser({ ...base, preference: 'mine', pinned: 'eya' }).browser).toBe('eya');
  });
});

describe('what the Browser page keeps track of', () => {
  const panel = (): BrowserPanel => new BrowserPanel({ now: () => 1000 });

  it('the goal is what the user asked for; steps and the current action follow what is done; it ends done', async () => {
    const p = panel();
    p.beginRequest('Download the report from the portal');
    await p.before('open', 'https://portal.example/reports');
    expect(p.get()).toMatchObject({ status: 'working', goal: 'Download the report from the portal', current: 'Opening portal.example' });
    p.after({ op: 'open', detail: 'https://portal.example/reports', ok: true, url: 'https://portal.example/reports', title: 'Reports' });
    await p.before('click', 'Download');
    p.after({ op: 'click', detail: 'Download', ok: true, url: 'https://portal.example/reports', title: 'Reports' });
    p.endRequest();
    expect(p.get()).toMatchObject({ status: 'done', current: '', url: 'https://portal.example/reports', title: 'Reports' });
    expect(p.get().steps.map((s) => s.text)).toEqual(['Opening portal.example', 'Clicking “Download”']);
    expect(p.get().log.map((l) => l.text)).toEqual(expect.arrayContaining(['Task: Download the report from the portal', 'Opening portal.example', 'Clicking “Download”']));
  });

  it('what was typed into a field is never written down: only which field', async () => {
    const p = panel();
    p.beginRequest('Log in');
    await p.before('fill', 'Password');
    p.after({ op: 'fill', detail: 'Password', ok: true, url: 'https://a.example/login', title: 'Sign in' });
    const everything = JSON.stringify(p.get());
    expect(everything).toContain('Typing into “Password”');
    expect(describeAction('fill', 'Search')).toBe('Typing into “Search”');
  });

  it('a step that needs the user (a sign-in, a check, a yes, a choice) is a blocker, and the task waits for them', async () => {
    const p = panel();
    p.beginRequest('Buy it');
    await p.before('click', 'Place order');
    p.after({ op: 'click', detail: 'Place order', ok: false, reason: 'needs_confirmation', message: 'purchase "Place order"' });
    expect(p.get()).toMatchObject({ status: 'waiting_you' });
    expect(p.get().blockers[0]).toMatch(/Waiting for your OK/);
    await p.before('click', 'ADD');
    p.after({ op: 'click', detail: 'ADD', ok: false, reason: 'ambiguous', message: 'Veg Biryani, Masala Dosa' });
    expect(p.get().blockers[0]).toMatch(/Which one\? Veg Biryani, Masala Dosa/);
    await p.before('click', 'Continue');
    p.after({ op: 'click', detail: 'Continue', ok: false, reason: 'needs_user', message: 'Enter the verification code' });
    expect(p.get().blockers[0]).toBe('Enter the verification code');
  });

  it('something Eya cannot find on the page waits for the user to say where to click, and what they say carries the same task on', async () => {
    const p = panel();
    p.beginRequest('Open the portal and download the report');
    await p.before('click', 'Reports');
    p.after({ op: 'click', detail: 'Reports', ok: false, reason: 'not_found', message: 'not on the page' });
    p.endRequest();
    expect(p.get()).toMatchObject({ status: 'waiting_you', goal: 'Open the portal and download the report' });
    expect(p.get().blockers[0]).toMatch(/Could not find .Reports. on this page: tell Eya what to click/);
    p.beginRequest('click Services in the menu');
    await p.before('click', 'Services');
    expect(p.get()).toMatchObject({ status: 'working', goal: 'Open the portal and download the report', blockers: [] });
    expect(p.get().log.some((l) => /You said: click Services in the menu/.test(l.text))).toBe(true);
  });

  it('a CAPTCHA, a code, a payment step or a sign-in showing is named for what it is, and resolves when the page moves on', async () => {
    const p = panel();
    p.beginRequest('Find the record');
    await p.before('open', 'https://records.example/');
    p.after({ op: 'open', ok: true, url: 'https://records.example/', title: 'Verify', challenge: 'captcha' });
    expect(p.get()).toMatchObject({ status: 'waiting_you' });
    expect(p.get().blockers[0]).toMatch(/human check is showing.*carries on by herself/);
    await p.before('inspect');
    p.after({ op: 'inspect', ok: true, url: 'https://records.example/results', title: 'Results' });
    expect(p.get().blockers).toEqual([]);
    expect(p.get().status).toBe('working');
  });

  it('a sign-in wall on a site the task was already working in says the session probably expired', async () => {
    const p = panel();
    p.beginRequest('Get my statement');
    await p.before('open', 'https://bank.example/account');
    p.after({ op: 'open', ok: true, url: 'https://bank.example/account', title: 'Account' });
    await p.before('click', 'View statement');
    p.after({ op: 'click', detail: 'View statement', ok: true, url: 'https://bank.example/login', title: 'Sign in', challenge: 'login' });
    expect(p.get().blockers[0]).toMatch(/sign in again.*session there has probably expired/);
    // the first sign-in of a task is just a sign-in
    const fresh = panel();
    fresh.beginRequest('Get my statement');
    await fresh.before('open', 'https://bank.example/login');
    fresh.after({ op: 'open', ok: true, url: 'https://bank.example/login', title: 'Sign in', challenge: 'login' });
    expect(fresh.get().blockers[0]).toMatch(/sign-in is needed/);
  });

  it('a reply to what Eya was waiting for carries the same task on, with what the user said kept in view; anything else is a new task', async () => {
    const p = panel();
    p.beginRequest('Open the portal and download the report');
    await p.before('open', 'https://portal.example/');
    p.after({ op: 'open', ok: true, url: 'https://portal.example/', title: 'Portal' });
    await p.before('click', 'Reports');
    p.after({ op: 'click', detail: 'Reports', ok: false, reason: 'could_not', message: 'not found' });
    p.endRequest();
    // she is stuck and asked the user: the page stays as it is
    p.note('info', 'asked the user for guidance');
    p.beginRequest('click Reports in the left menu');
    // (not waiting_you yet: she failed, not blocked) -> make it a real wait
    const w = panel();
    w.beginRequest('Open the portal and download the report');
    void w.before('open', 'https://portal.example/');
    w.after({ op: 'open', ok: false, reason: 'needs_user', message: 'Which section is the report in?' });
    w.endRequest();
    expect(w.get().status).toBe('waiting_you');
    w.beginRequest('click Reports in the left menu');
    void w.before('click', 'Reports');
    expect(w.get().goal).toBe('Open the portal and download the report'); // the same task
    expect(w.get().log.some((l) => l.kind === 'user' && /You said: click Reports/.test(l.text))).toBe(true);
    expect(w.get().blockers).toEqual([]);
    // a different request once it is done is a new task
    w.after({ op: 'click', detail: 'Reports', ok: true, url: 'https://portal.example/reports', title: 'Reports' });
    w.endRequest();
    expect(w.get().status).toBe('done');
    w.beginRequest('book me a cab');
    void w.before('open', 'https://cabs.example/');
    expect(w.get().goal).toBe('book me a cab');
    expect(w.get().steps).toEqual([]);
  });

  it('pause holds the next action until resume; stop refuses it; hand back after taking over lets it go on', async () => {
    const p = panel();
    p.beginRequest('Do the thing');
    p.pause();
    expect(p.get()).toMatchObject({ paused: true, status: 'paused' });
    const ran = vi.fn();
    const pending = p.before('click', 'Go').then(ran);
    await new Promise((r) => setTimeout(r, 40));
    expect(ran).not.toHaveBeenCalled();
    p.resume();
    await pending;
    expect(ran).toHaveBeenCalledTimes(1);
    expect(p.get().paused).toBe(false);

    p.takeOver();
    expect(p.get()).toMatchObject({ takenOver: true, status: 'taken_over' });
    const ran2 = vi.fn();
    const pending2 = p.before('click', 'Go').then(ran2);
    await new Promise((r) => setTimeout(r, 40));
    expect(ran2).not.toHaveBeenCalled();
    p.handBack();
    await pending2;
    expect(ran2).toHaveBeenCalledTimes(1);

    p.pause();
    const refused = p.before('click', 'Go').catch((e: unknown) => e);
    p.stop();
    expect(await refused).toBeInstanceOf(BrowserStoppedError);
    await expect(p.before('click', 'Go')).rejects.toBeInstanceOf(BrowserStoppedError);
    expect(p.get().status).toBe('stopped');
    // the next thing the user asks is a fresh start
    p.beginRequest('Try something else');
    await expect(p.before('open', 'https://a.example/')).resolves.toBeUndefined();
  });

  it('what the user does themselves (the address bar, back) is neither held by a pause nor listed as Eya\'s step', async () => {
    const p = panel();
    p.beginRequest('x');
    p.pause();
    let ran = false;
    await p.asUser(async () => {
      await p.before('open', 'https://a.example/');
      p.after({ op: 'open', ok: true, url: 'https://a.example/', title: 'A' });
      ran = true;
    });
    expect(ran).toBe(true);
    expect(p.get().steps).toEqual([]);
  });

  it('says where it is working, and offers to connect My Browser only when that is what is needed', () => {
    const p = panel();
    p.setWhere('eya');
    expect(p.get()).toMatchObject({ where: 'eya', needsMyBrowser: false });
    p.setWhere('mine', 'Chrome');
    expect(p.get().log.map((l) => l.text)).toEqual(expect.arrayContaining(['Working in Eya Browser', 'Working in your Chrome (My Browser)']));
    p.needMyBrowser('Your Chrome is not connected to Eya');
    expect(p.get()).toMatchObject({ needsMyBrowser: true, status: 'waiting_you' });
    p.setMyBrowsers(['Chrome']);
    expect(p.get().needsMyBrowser).toBe(false);
  });

  it('keeps a bounded log, without repeating itself', () => {
    const p = panel();
    for (let i = 0; i < 300; i++) p.note('info', `line ${i}`);
    p.note('info', 'line 299');
    expect(p.get().log.length).toBeLessThanOrEqual(120);
    expect(p.get().log.filter((l) => l.text === 'line 299')).toHaveLength(1);
  });
});

describe('the Browser page\'s controls', () => {
  function wiring() {
    const events: Array<(e: HostEvent) => void> = [];
    const requests: Array<{ op: string; args?: unknown }> = [];
    const opened: string[] = [];
    let connection: () => void = () => undefined;
    const connected: string[] = [];
    const forgotten: unknown[] = [];
    const external: string[] = [];
    const sent: Array<[string, unknown]> = [];
    const live: string[] = [];
    const host = {
      request: vi.fn(async (op: string, args?: unknown) => {
        requests.push({ op, args });
        if (op === 'list_tabs') return { tabs: [{ tabId: 1, title: 'Portal', url: 'https://portal.example/', active: true }] };
        return { ok: true };
      }),
      onEvent: (l: (e: HostEvent) => void) => {
        events.push(l);
        return () => undefined;
      },
      setViewBounds: vi.fn((b: unknown) => void live.push(b === null ? 'hide' : 'show')),
    };
    const eya = {
      host,
      openWebsite: vi.fn(async (url: string) => {
        opened.push(url);
        if (url.includes('nope.invalid')) throw new Error('The name could not be found');
        return {};
      }),
    };
    const panel = new BrowserPanel({ now: () => 1000 });
    const w = {
      panel,
      eya,
      bridge: {
        connectedBrowsers: () => connected as never,
        onConnectionChange: (l: () => void) => ((connection = l), () => undefined),
        forgetPairing: (b?: unknown) => void forgotten.push(b ?? 'all'),
      },
      connector: {
        connect: vi.fn(async () => {
          connected.push('chrome');
          connection();
          return { connected: true, alreadyConnected: false, browsers: ['chrome'], stillWaiting: [], outdated: [], extensionFolder: 'x', helpOpened: false, extensionSeen: true };
        }),
      },
      openExternal: (u: string) => void external.push(u),
      send: (c: string, p: unknown) => void sent.push([c, p]),
      setPreference: () => undefined,
    } as unknown as BrowserPanelWiring;
    const controller = createBrowserPanelController(w);
    return { controller, panel, host, eya, events, requests, opened, connected, forgotten, external, sent, live };
  }

  it('Pause, Stop, Take over and Hand back are the panel\'s own, and taking over brings the window to the front', async () => {
    const w = wiring();
    await w.controller.act({ type: 'pause' });
    expect(w.panel.get().paused).toBe(true);
    await w.controller.act({ type: 'resume' });
    await w.controller.act({ type: 'take_over' });
    expect(w.panel.get().takenOver).toBe(true);
    expect(w.requests.map((r) => r.op)).toContain('show_window');
    await w.controller.act({ type: 'hand_back' });
    expect(w.panel.get().takenOver).toBe(false);
    await w.controller.act({ type: 'stop' });
    expect(w.panel.get().status).toBe('stopped');
  });

  it('the address bar opens exactly what was typed (a bare site name gets https, words become a search) and shows a failure in words', async () => {
    const w = wiring();
    await w.controller.act({ type: 'navigate', url: 'records.example/cases?id=7' });
    await w.controller.act({ type: 'navigate', url: 'https://portal.example/a b' });
    await w.controller.act({ type: 'navigate', url: 'high court cause list' });
    expect(w.opened).toEqual(['https://records.example/cases?id=7', 'https://portal.example/a b', 'https://duckduckgo.com/?q=high%20court%20cause%20list']);
    expect((await w.controller.act({ type: 'navigate', url: 'ftp://files.example/' })).ok).toBe(false);
    expect((await w.controller.act({ type: 'navigate', url: '   ' })).ok).toBe(false);
    await w.controller.act({ type: 'navigate', url: 'nope.invalid' });
    expect(w.panel.get().error).toMatch(/could not be found/);
    expect(addressFrom('localhost:3000/x')).toBe('https://localhost:3000/x');
  });

  it('back, forward, reload, stop loading, a new tab and switching tabs go to the window', async () => {
    const w = wiring();
    for (const type of ['back', 'forward', 'reload', 'stop_loading', 'new_tab'] as const) await w.controller.act({ type });
    await w.controller.act({ type: 'focus_tab', id: 4 });
    expect(w.requests.filter((r) => r.op !== 'list_tabs').map((r) => r.op)).toEqual(['back', 'forward', 'reload', 'stop_loading', 'new_tab', 'focus_tab']);
  });

  it('the window\'s page events feed the address, the title, the loading mark, a problem and the tab list', async () => {
    const w = wiring();
    const fire = (e: HostEvent) => w.events.forEach((l) => l(e));
    fire({ type: 'page', url: 'https://portal.example/reports', title: 'Reports', loading: true });
    expect(w.panel.get()).toMatchObject({ url: 'https://portal.example/reports', title: 'Reports', loading: true });
    fire({ type: 'page', url: 'https://portal.example/reports', title: 'Reports', loading: false });
    expect(w.panel.get()).toMatchObject({ loading: false, error: null });
    fire({ type: 'problem', kind: 'dns', message: 'nope.invalid could not be found' });
    expect(w.panel.get().error).toMatch(/could not be found/);
    // the error page the browser puts up finishes loading: the problem is still there to read
    fire({ type: 'page', url: 'http://nope.invalid/', title: '', loading: false });
    expect(w.panel.get().error).toMatch(/could not be found/);
    // the next page starting to load clears it
    fire({ type: 'page', url: 'https://portal.example/', title: 'Portal', loading: true });
    expect(w.panel.get().error).toBeNull();
    fire({ type: 'closed' });
    expect(w.panel.get().log.map((l) => l.text).join(' ')).toMatch(/Eya Browser was closed/);
    await w.controller.get();
    expect(w.panel.get().tabs).toEqual([{ id: 1, title: 'Portal', url: 'https://portal.example/', active: true }]);
  });

  it('Open in my browser hands the page to their normal browser (only a web page), and does nothing else', async () => {
    const w = wiring();
    expect((await w.controller.act({ type: 'open_in_my_browser' })).ok).toBe(false); // nothing open yet
    w.panel.setPage({ url: 'https://portal.example/reports' });
    expect((await w.controller.act({ type: 'open_in_my_browser' })).ok).toBe(true);
    expect(w.external).toEqual(['https://portal.example/reports']);
  });

  it('connecting My Browser asks the connector and shows the result; disconnecting forgets the pairing and says Eya will not use it', async () => {
    const w = wiring();
    const connected = await w.controller.act({ type: 'connect_my_browser' });
    expect(connected.ok).toBe(true);
    expect(connected.message).toMatch(/Connected: Chrome.*only when you ask her to/);
    expect(w.panel.get().myBrowsers).toEqual(['Chrome']);
    const gone = await w.controller.act({ type: 'disconnect_my_browser' });
    expect(gone.ok).toBe(true);
    expect(w.forgotten).toEqual(['all']);
    expect(gone.message).toMatch(/will not use your browser until you connect it again/);
  });

  it('the browser is drawn where the Browser page says, and put away when the page leaves', () => {
    const w = wiring();
    expect(w.live).toEqual([]);
    w.controller.setView({ x: 10, y: 20, width: 800, height: 500 });
    w.controller.setView(null);
    expect(w.host.setViewBounds).toHaveBeenNthCalledWith(1, { x: 10, y: 20, width: 800, height: 500 });
    expect(w.host.setViewBounds).toHaveBeenNthCalledWith(2, null);
    expect(w.live).toEqual(['show', 'hide']);
  });

  it('pushes the state to the page whenever it changes', async () => {
    const w = wiring();
    w.panel.note('info', 'hello');
    await new Promise((r) => setTimeout(r, 120));
    expect(w.sent.some(([channel]) => channel === 'eya:browserpanel:changed')).toBe(true);
  });
});

describe('what a longer job (a page that moved, a download) shows in "Your Agent at Work"', () => {
  const panel = (): BrowserPanel => new BrowserPanel({ now: () => 1000 });

  it('the line being worked on is the current one, a good step is ticked, a trouble crossed, and the task is marked working', () => {
    const p = panel();
    p.beginRequest('go to the reports site and download the annual report');
    p.progress('now', 'Opening the requested website…');
    expect(p.get().status).toBe('working');
    expect(p.get().current).toBe('Opening the requested website…');
    expect(p.get().goal).toMatch(/download the annual report/);
    p.progress('warn', 'The saved address is unavailable. Finding its current address…');
    p.progress('done', 'The page is open.');
    const steps = p.get().steps;
    expect(steps.map((s) => [s.text, s.ok])).toEqual([
      ['The saved address is unavailable. Finding its current address…', false],
      ['The page is open.', true],
    ]);
    expect(p.get().log.map((l) => l.text)).toEqual(expect.arrayContaining(['Opening the requested website…', 'The page is open.']));
    expect(p.get().current).toBe('');
  });

  it('what only the person can settle is what the task waits for', () => {
    const p = panel();
    p.beginRequest('open the site');
    p.progress('now', 'Opening the requested website…');
    p.blocked('I found example.org, which may be the site you mean, but I cannot confirm it. Do you want me to go there?');
    expect(p.get().status).toBe('waiting_you');
    expect(p.get().blockers[0]).toMatch(/cannot confirm it/);
  });

  it('what the person does by hand is not recorded as Eya\'s steps, and steps never grow without limit', async () => {
    const p = panel();
    p.beginRequest('x');
    await p.asUser(async () => p.progress('done', 'ignored'));
    expect(p.get().steps).toEqual([]);
    for (let i = 0; i < 100; i++) p.progress('done', `step ${i}`);
    expect(p.get().steps.length).toBeLessThanOrEqual(60);
    expect(p.get().steps[p.get().steps.length - 1]?.text).toBe('step 99');
  });
});
