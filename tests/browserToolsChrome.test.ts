import { describe, it, expect } from 'vitest';
import { createBrowserTools } from '../src/main/tools/impl/browserTools';
import type { BrowserToolOptions } from '../src/main/tools/impl/browserTools';
import { LoopGuard } from '../src/main/browser/loopGuard';
import type { ActOnPageResult, BrowserAutomationService, ClickGate, FillOptions } from '../src/main/browser/BrowserAutomationService';
import { BrowserUnavailableError } from '../src/main/browser/errors';
import type { ActionEffects, PageChanges } from '../src/main/browser/pageEffects';
import type { PageSnapshot } from '../src/main/browser/pageSnapshot';
import { refsFromToolResult } from '../src/main/agent/AgentEngine';
import type { Tool } from '../src/main/tools/types';

function snap(over: Partial<PageSnapshot> = {}): PageSnapshot {
  return { url: 'https://shop.example/cart', title: 'Cart', headings: ['Your cart'], links: ['Home'], buttons: ['Place order'], inputs: [], dialogs: [], truncated: false, ...over };
}

const noChanges: PageChanges = { navigated: false, titleChanged: false, appeared: [], appearedCount: 0, disappeared: [], disappearedCount: 0, dialogClosed: false, textChanged: false };

function effects(over: Partial<ActionEffects> = {}, changes: Partial<PageChanges> = {}): ActionEffects {
  return { changes: { ...noChanges, ...changes }, settled: true, ...over };
}

interface Fake {
  service: BrowserAutomationService;
  clicks: Array<{ text: string; gated: boolean }>;
  fills: Array<{ label: string; value: string; options: FillOptions | undefined }>;
}

function fake(over: {
  page?: PageSnapshot;
  click?: (text: string, gate?: ClickGate) => ActOnPageResult | Error;
  fill?: (label: string) => ActOnPageResult | Error;
  back?: () => ActOnPageResult | Error;
  open?: () => PageSnapshot | Error;
  inspect?: () => PageSnapshot | Error;
} = {}): Fake {
  const clicks: Fake['clicks'] = [];
  const fills: Fake['fills'] = [];
  const page = over.page ?? snap();
  const unwrap = <T>(v: T | Error): T => {
    if (v instanceof Error) throw v;
    return v;
  };
  const service: BrowserAutomationService = {
    openWebsite: async () => unwrap(over.open?.() ?? page),
    inspectPage: async () => unwrap(over.inspect?.() ?? page),
    clickOnPage: async (text, gate) => {
      clicks.push({ text, gated: gate !== undefined });
      return unwrap(over.click?.(text, gate) ?? { ok: true as const, snapshot: page });
    },
    fillOnPage: async (label, value, options) => {
      fills.push({ label, value, options });
      return unwrap(over.fill?.(label) ?? { ok: true as const, snapshot: page });
    },
    goBack: async () => unwrap(over.back?.() ?? { ok: true as const, snapshot: page }),
    goForward: async () => ({ ok: true as const, snapshot: page }),
    reload: async () => ({ ok: true as const, snapshot: page }),
    scroll: async () => ({ ok: true as const, snapshot: page }),
    findOnPage: async (query) => ({ url: '', title: '', query, matches: [], textMatches: [], totalControls: 0 }),
    readPage: async () => ({ url: '', title: '', text: '', offset: 0, nextOffset: null, totalChars: 0 }),
    searchWeb: async () => [],
    close: async () => undefined,
  };
  return { service, clicks, fills };
}

function tools(f: Fake, opts: BrowserToolOptions = {}, guard = new LoopGuard()): Record<string, Tool> {
  return Object.fromEntries(createBrowserTools(f.service, guard, opts).map((t) => [t.schema.name, t]));
}

describe('sensitive clicks need the user\'s yes', () => {
  // Stand-in for the real browser: resolves the click to the control named "Place order" and applies the gate to it.
  const resolvesToPlaceOrder = (_text: string, gate?: ClickGate): ActOnPageResult => {
    const why = gate?.({ name: 'Place order', role: 'button' }) ?? null;
    return why !== null
      ? { ok: false, reason: 'needs_confirmation', why, target: 'Place order', snapshot: snap() }
      : { ok: true, snapshot: snap({ url: 'https://shop.example/thanks', title: 'Thank you' }) };
  };

  it('does not click, and hands back exactly the question to ask', async () => {
    const f = fake({ click: resolvesToPlaceOrder });
    const r = await tools(f)['click_on_page']!.execute({ text: 'the green button' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('needs confirmation');
    expect(r.error).toMatch(/Ask the user/);
    expect(r.data).toMatchObject({ status: 'permission_required', action: 'browser_sensitive_click', target: 'Place order' });
    expect((r.data?.['currentPage'] as { url: string }).url).toBe('https://shop.example/cart');
  });

  it('goes ahead only on a retry with confirm: true', async () => {
    const f = fake({ click: resolvesToPlaceOrder });
    const t = tools(f);
    await t['click_on_page']!.execute({ text: 'order' });
    const second = await t['click_on_page']!.execute({ text: 'order', confirm: true });
    expect(second.ok).toBe(true);
    expect(f.clicks).toEqual([
      { text: 'order', gated: true },
      { text: 'order', gated: false },
    ]);
  });

  it('asking the user is not counted as a stalled attempt, however many times it has to be asked', async () => {
    const f = fake({ click: resolvesToPlaceOrder });
    const t = tools(f);
    for (let i = 0; i < 5; i += 1) expect((await t['click_on_page']!.execute({ text: 'order' })).summary).toBe('needs confirmation');
  });

  it('ordinary clicks are not gated at all', async () => {
    const f = fake({ click: (_t, gate) => ({ ok: true as const, snapshot: snap({ title: String(gate?.({ name: 'Cause List', role: 'link' })) }) }) });
    const r = await tools(f)['click_on_page']!.execute({ text: 'Cause List' });
    expect((r.data?.['currentPage'] as { title: string }).title).toBe('null');
  });

  it('judges a vague "Confirm" by the page it is on', async () => {
    const f = fake({
      page: snap({ url: 'https://shop.example/checkout', title: 'Checkout' }),
      click: (_t, gate) => {
        const why = gate?.({ name: 'Confirm', role: 'button' }) ?? null;
        return why !== null ? { ok: false, reason: 'needs_confirmation', why, target: 'Confirm', snapshot: snap() } : { ok: true, snapshot: snap() };
      },
    });
    expect((await tools(f)['click_on_page']!.execute({ text: 'Confirm' })).summary).toBe('needs confirmation');
  });
});

describe('typing: submit and password rules', () => {
  it('pressing Enter in a message or comment box needs the yes first; in a search box it does not', async () => {
    const f = fake();
    const t = tools(f);
    const blocked = await t['fill_on_page']!.execute({ label: 'Message', value: 'hi', submit: true });
    expect(blocked.summary).toBe('needs confirmation');
    expect(f.fills).toEqual([]);
    expect((await t['fill_on_page']!.execute({ label: 'Message', value: 'hi', submit: true, confirm: true })).ok).toBe(true);
    expect((await t['fill_on_page']!.execute({ label: 'Search', value: 'orders', submit: true })).ok).toBe(true);
    expect(f.fills.map((x) => x.options)).toEqual([{ submit: true }, { submit: true }]);
  });

  it('tells the model plainly that a password is the user\'s to type', async () => {
    const f = fake({ fill: () => ({ ok: false, reason: 'needs_user', message: 'That is a password field. Eya never types passwords.', snapshot: snap() }) });
    const r = await tools(f)['fill_on_page']!.execute({ label: 'Password', value: 'x' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('needs you');
    expect(r.data?.['needsUser']).toBe(true);
  });

  it('a request for the user to act is not counted as a stalled attempt either', async () => {
    const f = fake({ fill: () => ({ ok: false, reason: 'needs_user', message: 'm', snapshot: snap() }) });
    const t = tools(f);
    for (let i = 0; i < 5; i += 1) expect((await t['fill_on_page']!.execute({ label: 'Password', value: 'x' })).summary).toBe('needs you');
  });
});

describe('challenges: stop and ask, never get past', () => {
  const captcha = snap({ challenge: { kind: 'captcha', hint: 'h' } });

  it('opening a page that turns out to be a CAPTCHA reports ok:false with what the user has to do', async () => {
    const r = await tools(fake({ open: () => captcha }))['open_website']!.execute({ url: 'https://site.example' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('needs you');
    expect(r.error).toMatch(/CAPTCHA/);
    expect(r.data).toMatchObject({ needsUser: true, challengeKind: 'captcha' });
  });

  it('a click that lands on a bot check or verification-code page is reported the same way', async () => {
    for (const kind of ['bot_check', 'mfa'] as const) {
      const f = fake({ click: () => ({ ok: true, snapshot: snap({ challenge: { kind, hint: 'h' } }) }) });
      const r = await tools(f)['click_on_page']!.execute({ text: 'Search' });
      expect(r.ok, kind).toBe(false);
      expect(r.data?.['challengeKind'], kind).toBe(kind);
    }
  });

  it('a sign-in page is information, not a wall: ok:true, but flagged for the user', async () => {
    const r = await tools(fake({ inspect: () => snap({ challenge: { kind: 'login', hint: 'h' } }) }))['inspect_page']!.execute({});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ needsUser: true, challengeKind: 'login' });
  });

  it('looking at an ordinary page raises nothing', async () => {
    const r = await tools(fake())['inspect_page']!.execute({});
    expect(r.data?.['needsUser']).toBeUndefined();
  });
});

describe('what the browser reports back', () => {
  it('a menu expanding in place is a change but not a navigation, and says what appeared', async () => {
    const f = fake({
      page: snap({ links: ['Home'] }),
      click: () => ({
        ok: true,
        snapshot: snap({ links: ['Home', 'Cause List'] }),
        effects: effects({}, { appeared: ['link: Cause List'], appearedCount: 1 }),
      }),
    });
    const r = await tools(f)['click_on_page']!.execute({ text: 'Open menu' });
    expect(r.data).toMatchObject({ stateChanged: true, navigated: false, whatChanged: { appeared: ['link: Cause List'] } });
  });

  it('a click that opened a new tab counts as a navigation and says so', async () => {
    const f = fake({ click: () => ({ ok: true, snapshot: snap({ url: 'https://shop.example/orders' }), effects: effects({ newTab: { url: 'https://shop.example/orders', title: 'Orders' } }) }) });
    const r = await tools(f)['click_on_page']!.execute({ text: 'Orders' });
    expect(r.data).toMatchObject({ navigated: true, stateChanged: true, openedNewTab: true });
  });

  it('flags a page that was still changing', async () => {
    const f = fake({ click: () => ({ ok: true, snapshot: snap(), effects: effects({ settled: false }) }) });
    expect((await tools(f)['click_on_page']!.execute({ text: 'Load more' })).data?.['pageStillChanging']).toBe(true);
  });

  it('reports no change when the browser saw none', async () => {
    const f = fake({ click: () => ({ ok: true, snapshot: snap(), effects: effects() }) });
    expect((await tools(f)['click_on_page']!.execute({ text: 'x' })).data).toMatchObject({ stateChanged: false, navigated: false });
  });

  it('shows the page\'s readable text and tables, plus the browser it happened in', async () => {
    const page = snap({ visibleText: 'No records found', tables: [{ headers: ['Court'], rows: [['1']], totalRows: 1 }], environment: 'your_browser', notes: ['careful'] });
    const r = await tools(fake({ page }))['inspect_page']!.execute({});
    const current = r.data?.['currentPage'] as Record<string, unknown>;
    expect(current['visibleText']).toBe('No records found');
    expect(current['tables']).toHaveLength(1);
    expect(current['notes']).toEqual(['careful']);
    expect(r.data?.['environment']).toBe('your_browser');
  });
});

describe('downloads are only reported once the file is really there', () => {
  const done = { path: 'C:\\Users\\R\\Downloads\\report.pdf', name: 'report.pdf', state: 'complete' as const, bytes: 1234 };
  const clickWith = (download: NonNullable<ActionEffects['download']>) =>
    fake({ click: () => ({ ok: true, snapshot: snap(), effects: effects({ download }) }) });

  it('verified: data.path is set, so "open it" / "move it" knows which file', async () => {
    const r = await tools(clickWith(done), { verifyDownload: async () => true })['click_on_page']!.execute({ text: 'Download' });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ path: done.path, download: { name: 'report.pdf', verified: true, bytes: 1234 } });
    expect(r.summary).toMatch(/downloaded report\.pdf/);
    expect(refsFromToolResult('click_on_page', r)).toEqual([{ kind: 'file', value: done.path }]);
  });

  it('the browser says done but the file is not on disk: no path, no claim of success', async () => {
    const r = await tools(clickWith(done), { verifyDownload: async () => false })['click_on_page']!.execute({ text: 'Download' });
    expect(r.data?.['path']).toBeUndefined();
    expect(r.data?.['download']).toMatchObject({ verified: false });
    expect(r.summary).not.toMatch(/downloaded/);
    expect(refsFromToolResult('click_on_page', r)).toEqual([]);
  });

  it('still downloading and interrupted downloads are described honestly', async () => {
    const pending = await tools(clickWith({ ...done, state: 'in_progress', path: '' }), { verifyDownload: async () => true })['click_on_page']!.execute({ text: 'D' });
    expect(pending.data?.['path']).toBeUndefined();
    expect(pending.data?.['download']).toMatchObject({ state: 'in_progress' });
    const failed = await tools(clickWith({ ...done, state: 'interrupted', error: 'NETWORK_FAILED' }), { verifyDownload: async () => true })['click_on_page']!.execute({ text: 'D' });
    expect(failed.data?.['download']).toMatchObject({ state: 'interrupted', error: 'NETWORK_FAILED' });
    expect(failed.data?.['path']).toBeUndefined();
  });
});

describe('go_back', () => {
  it('goes back and shows where it landed', async () => {
    const f = fake({ inspect: () => snap({ url: 'https://s.example/b' }), back: () => ({ ok: true, snapshot: snap({ url: 'https://s.example/a' }) }) });
    const r = await tools(f)['go_back']!.execute({});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ action: 'back', navigated: true });
  });

  it('says plainly when there is nothing to go back to', async () => {
    const f = fake({ back: () => ({ ok: false, reason: 'could_not', message: 'There is nothing to go back to.', snapshot: snap() }) });
    const r = await tools(f)['go_back']!.execute({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nothing to go back/);
  });
});

describe('page-side refusals', () => {
  it('passes on why a control could not be clicked (covered, disabled, stale)', async () => {
    const f = fake({ click: () => ({ ok: false, reason: 'could_not', message: 'Something else is covering it ("Accept cookies").', snapshot: snap({ dialogs: ['We use cookies'] }) }) });
    const r = await tools(f)['click_on_page']!.execute({ text: 'Continue' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/covering/);
    expect((r.data?.['currentPage'] as { dialogs: string[] }).dialogs).toEqual(['We use cookies']);
  });
});

describe('a browser that is not connected', () => {
  const gone = () => new BrowserUnavailableError('Eya lost her connection to the user\'s own browser.');
  it('every tool says so in the same plain way, instead of "no website open"', async () => {
    const f = fake({ open: gone, inspect: gone, click: gone, fill: gone, back: gone });
    const t = tools(f);
    for (const [name, args] of [
      ['open_website', { url: 'https://s.example' }],
      ['inspect_page', {}],
      ['click_on_page', { text: 'x' }],
      ['fill_on_page', { label: 'a', value: 'b' }],
      ['go_back', {}],
    ] as const) {
      const r = await t[name]!.execute(args);
      expect(r.ok, name).toBe(false);
      expect(r.summary, name).toBe('browser not connected');
      expect(r.error, name).toMatch(/lost her connection/);
    }
  });
});

describe('optional tools', () => {
  const tabsStub = {
    listTabs: async () => [],
    switchToTab: async () => snap(),
    closeTab: async () => ({ closed: true, remainingTabs: 0 }),
  };
  const connectorStub = {
    connect: async () => ({ connected: true, alreadyConnected: true, browsers: ['chrome' as const], stillWaiting: [], extensionFolder: 'x', helpOpened: false, extensionSeen: true }),
  };

  it('tab, status and connect tools exist only when the user\'s browser can be reached', () => {
    const f = fake();
    const bare = Object.keys(tools(f));
    expect(bare).toEqual(['open_website', 'inspect_page', 'find_on_page', 'read_page', 'click_on_page', 'fill_on_page', 'scroll_page', 'go_back', 'go_forward', 'reload_page']);
    const full = Object.keys(
      tools(f, {
        tabs: tabsStub,
        connector: connectorStub,
        session: { describe: () => ({ mode: 'user_browser', browsers: [], waitingToPair: [], pairingOpen: false, workingIn: null }), waitForUserChange: async () => ({ changed: false, snapshot: snap() }) },
      }),
    );
    expect(full).toEqual(
      expect.arrayContaining(['list_browser_tabs', 'switch_browser_tab', 'close_browser_tab', 'browser_status', 'wait_for_user_in_browser', 'connect_chrome']),
    );
  });

  it('lists tabs with the browser each is in, and switches by id (and browser)', async () => {
    const f = fake();
    const switched: Array<[number, string | undefined]> = [];
    const t = tools(f, {
      tabs: {
        ...tabsStub,
        listTabs: async () => [
          { browser: 'chrome', tabId: 3, title: 'Inbox', url: 'https://mail.example/', active: true, openedByEya: false, workingHere: false },
          { browser: 'edge', tabId: 4, title: 'Docs', url: 'https://docs.example/', active: false, openedByEya: true, workingHere: true },
        ],
        switchToTab: async (id, browser) => {
          switched.push([id, browser]);
          return snap({ title: `tab ${id}` });
        },
      },
    });
    const listed = await t['list_browser_tabs']!.execute({});
    expect(listed.summary).toBe('2 tabs open');
    expect(listed.data?.['tabs']).toEqual([
      { browser: 'chrome', tabId: 3, title: 'Inbox', url: 'https://mail.example/', activeInBrowser: true },
      { browser: 'edge', tabId: 4, title: 'Docs', url: 'https://docs.example/', eyaIsHere: true, openedByEya: true },
    ]);
    const result = await t['switch_browser_tab']!.execute({ tab_id: 4, browser: 'edge' });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('switched to tab 4');
    expect(switched).toEqual([[4, 'edge']]);
    expect((await t['switch_browser_tab']!.execute({})).ok).toBe(false);
  });

  it('connect_chrome reports every browser it connected, or exactly what the user still has to do', async () => {
    const f = fake();
    const both = tools(f, { connector: { connect: async () => ({ connected: true, alreadyConnected: false, browsers: ['chrome' as const, 'edge' as const], stillWaiting: [], extensionFolder: 'x', helpOpened: true, extensionSeen: true }) } });
    expect(await both['connect_chrome']!.execute({})).toMatchObject({ ok: true, summary: 'connected chrome and edge', data: { connected: true, browsers: ['chrome', 'edge'] } });

    const partial = tools(f, { connector: { connect: async () => ({ connected: true, alreadyConnected: false, browsers: ['chrome' as const], stillWaiting: ['edge' as const], extensionFolder: 'x', helpOpened: false, extensionSeen: true }) } });
    expect((await partial['connect_chrome']!.execute({})).data).toMatchObject({ notYetConnected: ['edge'] });

    const waiting = tools(f, { connector: { connect: async () => ({ connected: false, alreadyConnected: false, browsers: [], stillWaiting: [], extensionFolder: 'C:\\app\\eya-chrome-extension', helpOpened: true, extensionSeen: false }) } });
    const r = await waiting['connect_chrome']!.execute({});
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('waiting for you');
    expect(r.error).toMatch(/Load unpacked/);
    expect(r.error).toMatch(/eya-chrome-extension/);
    expect(r.data).toMatchObject({ connected: false, extensionFolder: 'C:\\app\\eya-chrome-extension' });
  });

  it('connect_chrome, for an extension that was set up before but is not answering: says nothing needs installing, opens nothing, tells what to check', async () => {
    const f = fake();
    const t = tools(f, { connector: { connect: async () => ({ connected: false, alreadyConnected: false, browsers: [], stillWaiting: [], extensionFolder: 'C:\\app\\eya-chrome-extension', helpOpened: false, extensionSeen: true }) } });
    const r = await t['connect_chrome']!.execute({});
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('extension not answering');
    expect(r.error).toMatch(/nothing needs installing again/);
    expect(r.error).toMatch(/did not open/);
    expect(r.error).toMatch(/reload/i);
    expect(r.error).not.toMatch(/choose the folder/i);
    expect(r.data).toMatchObject({ connected: false, extensionInstalled: true });
    expect(JSON.stringify(r.data?.['steps'])).not.toMatch(/Load unpacked/);
  });

  it('connect_chrome tells the user the folder was already shown this run instead of pretending it just opened it', async () => {
    const f = fake();
    const t = tools(f, { connector: { connect: async () => ({ connected: false, alreadyConnected: false, browsers: [], stillWaiting: [], extensionFolder: 'x', helpOpened: false, extensionSeen: false }) } });
    const r = await t['connect_chrome']!.execute({});
    expect(r.error).toMatch(/already opened/);
    expect(r.error).toMatch(/did not open them again/);
  });

  it('connect_chrome opens the folder only when asked: showExtensionFolder is passed through, and is false by default', async () => {
    const f = fake();
    const seen: unknown[] = [];
    const t = tools(f, {
      connector: {
        connect: async (_wait?: number, options?: unknown) => {
          seen.push(options);
          return { connected: true, alreadyConnected: true, browsers: ['chrome' as const], stillWaiting: [], extensionFolder: 'x', helpOpened: false, extensionSeen: true };
        },
      },
    });
    await t['connect_chrome']!.execute({});
    await t['connect_chrome']!.execute({ showExtensionFolder: true });
    await t['connect_chrome']!.execute({ showExtensionFolder: 'yes' });
    expect(seen).toEqual([{ showInstallHelp: false }, { showInstallHelp: true }, { showInstallHelp: false }]);
  });
});

describe('the user\'s browser is the default; Eya\'s own window only when asked for', () => {
  it('open_website passes isolated only when the model sets it (after the user agreed), and says why a browser is unavailable', async () => {
    const calls: Array<{ url: string; options: unknown }> = [];
    const f = fake();
    const service: BrowserAutomationService = {
      ...f.service,
      openWebsite: async (url, options) => {
        calls.push({ url, options });
        if (calls.length === 3) throw new BrowserUnavailableError('The extension in the user\'s Chrome is running but is not connected.', { why: 'needs_pairing', needsPairing: ['chrome'] });
        return snap({ url });
      },
    };
    const open = createBrowserTools(service)[0]!;
    await open.execute({ url: 'https://a.example' });
    await open.execute({ url: 'https://b.example', isolated: true });
    const blocked = await open.execute({ url: 'https://c.example' });
    expect(calls.map((c) => c.options)).toEqual([undefined, { isolated: true }, undefined]);
    expect(blocked.ok).toBe(false);
    expect(blocked.summary).toBe('browser not connected');
    expect(blocked.data).toMatchObject({ browserUnavailable: true, why: 'needs_pairing', needsPairing: ['chrome'] });
  });
});

describe('scroll, forward, reload and closing tabs', () => {
  it('scroll_page needs a direction, scrolls, and reports the page that is showing afterwards', async () => {
    const scrolled: Array<[string, number | undefined]> = [];
    const f = fake();
    const service: BrowserAutomationService = {
      ...f.service,
      scroll: async (direction, amount) => {
        scrolled.push([direction, amount]);
        return { ok: true, snapshot: snap({ visibleText: 'further down' }) };
      },
    };
    const t = Object.fromEntries(createBrowserTools(service).map((x) => [x.schema.name, x]));
    expect((await t['scroll_page']!.execute({})).ok).toBe(false);
    const r = await t['scroll_page']!.execute({ direction: 'down', amount: 400 });
    expect(r.ok).toBe(true);
    expect(scrolled).toEqual([['down', 400]]);
    expect((r.data?.['currentPage'] as Record<string, unknown>)['visibleText']).toBe('further down');
  });

  it('go_forward and reload_page act and show the resulting page', async () => {
    const f = fake();
    const t = tools(f);
    expect((await t['go_forward']!.execute({})).data).toMatchObject({ action: 'forward' });
    expect((await t['reload_page']!.execute({})).data).toMatchObject({ action: 'reload' });
  });

  it('a tab Eya opened closes at once; one the user opened asks first, and only a yes (confirm) closes it', async () => {
    const closed: Array<{ id: number; allowUserTab: boolean | undefined }> = [];
    const f = fake();
    const t = tools(f, {
      tabs: {
        listTabs: async () => [
          { browser: 'chrome', tabId: 1, title: 'My bank', url: 'https://bank.example/', active: true, openedByEya: false, workingHere: false },
          { browser: 'chrome', tabId: 2, title: 'Search results', url: 'https://s.example/', active: false, openedByEya: true, workingHere: true },
        ],
        switchToTab: async () => snap(),
        closeTab: async (id, options) => {
          closed.push({ id, allowUserTab: options?.allowUserTab });
          return { closed: true, remainingTabs: 1 };
        },
      },
    });
    const own = await t['close_browser_tab']!.execute({ tab_id: 2 });
    expect(own.ok).toBe(true);
    expect(closed).toEqual([{ id: 2, allowUserTab: false }]);

    const theirs = await t['close_browser_tab']!.execute({ tab_id: 1 });
    expect(theirs.ok).toBe(false);
    expect(theirs.summary).toBe('needs confirmation');
    expect(theirs.data).toMatchObject({ status: 'permission_required', action: 'close_browser_tab' });
    expect(closed).toHaveLength(1); // nothing more was closed

    const agreed = await t['close_browser_tab']!.execute({ tab_id: 1, confirm: true });
    expect(agreed.ok).toBe(true);
    expect(closed[1]).toEqual({ id: 1, allowUserTab: true });

    expect((await t['close_browser_tab']!.execute({ tab_id: 99 })).summary).toBe('no such tab');
  });
});

describe('browser_status and wait_for_user_in_browser', () => {
  const overview = {
    mode: 'user_browser' as const,
    browsers: [
      { browser: 'chrome' as const, connected: true, paired: true, extensionVersion: '0.2.0', tabs: 5, inUse: true },
      { browser: 'edge' as const, connected: false, paired: true },
    ],
    waitingToPair: [],
    pairingOpen: false,
    workingIn: 'your_browser' as const,
    workingBrowser: 'chrome' as const,
  };

  it('browser_status says which browsers are connected, and what to do when none is', async () => {
    const f = fake();
    const ok = tools(f, { session: { describe: () => overview, waitForUserChange: async () => ({ changed: false, snapshot: snap() }) } });
    const r = await ok['browser_status']!.execute({});
    expect(r.summary).toBe('chrome connected');
    expect(r.data).toMatchObject({ workingIn: 'your_browser', workingBrowser: 'chrome' });

    const none = tools(f, { session: { describe: () => ({ ...overview, browsers: [], workingIn: null }), waitForUserChange: async () => ({ changed: false, snapshot: snap() }) } });
    const r2 = await none['browser_status']!.execute({});
    expect(r2.summary).toBe('no browser connected');
    expect(String(r2.data?.['hint'])).toMatch(/connect_chrome/);

    const knocking = tools(f, { session: { describe: () => ({ ...overview, browsers: [], waitingToPair: ['edge'], workingIn: null }), waitForUserChange: async () => ({ changed: false, snapshot: snap() }) } });
    expect((await knocking['browser_status']!.execute({})).data).toMatchObject({ extensionRunningButNotConnected: ['edge'] });
  });

  it('wait_for_user_in_browser returns the page as it now is when the user finishes, or says it is still waiting', async () => {
    const f = fake();
    const waits: number[] = [];
    let finished = false;
    const t = tools(f, {
      session: {
        describe: () => overview,
        waitForUserChange: async (ms) => {
          waits.push(ms ?? 0);
          return finished
            ? { changed: true, cleared: 'login', snapshot: snap({ title: 'My account', url: 'https://x.example/account' }) }
            : { changed: false, snapshot: snap({ challenge: { kind: 'login', hint: 'h' } }) };
        },
      },
    });
    const waiting = await t['wait_for_user_in_browser']!.execute({});
    expect(waiting.ok).toBe(true);
    expect(waiting.data).toMatchObject({ stillWaiting: true });

    finished = true;
    const done = await t['wait_for_user_in_browser']!.execute({ seconds: 99 });
    expect(done.data).toMatchObject({ userFinished: true, cleared: 'login' });
    expect((done.data?.['currentPage'] as { title: string }).title).toBe('My account');
    expect(waits).toEqual([25_000, 30_000]); // default 25s, never more than 30s per call
  });
});

describe('find_on_page and read_page', () => {
  it('find_on_page reports where each match is, never clicks, and tells the model what to do when nothing matches', async () => {
    const f = fake();
    const withFind: BrowserAutomationService = {
      ...f.service,
      findOnPage: async (query) => ({
        url: 'https://p.example/',
        title: 'Portal',
        query,
        matches: query === 'cause list' ? [{ name: 'Cause List', role: 'link', where: 'inside the closed menu "Services"' }] : [],
        textMatches: [],
        totalControls: 180,
      }),
    };
    const t = Object.fromEntries(createBrowserTools(withFind).map((x) => [x.schema.name, x]));
    const hit = await t['find_on_page']!.execute({ query: 'cause list' });
    expect(hit.ok).toBe(true);
    expect(hit.summary).toBe('found 1 match for "cause list"');
    expect(hit.data?.['matches']).toEqual([{ name: 'Cause List', role: 'link', where: 'inside the closed menu "Services"' }]);
    expect(f.clicks).toEqual([]);

    const none = await t['find_on_page']!.execute({ query: 'nothing' });
    expect(none.ok).toBe(true);
    expect(none.summary).toMatch(/nothing on the page matches/);
    expect(String(none.data?.['hint'])).toMatch(/do not invent an address/);
    expect(none.data?.['controlsOnPage']).toBe(180);
    expect((await t['find_on_page']!.execute({})).ok).toBe(false);
  });

  it('read_page returns the text with where to carry on, and says when it is the end', async () => {
    const f = fake();
    const reading: BrowserAutomationService = {
      ...f.service,
      readPage: async (offset) =>
        offset === undefined || offset === 0
          ? { url: 'u', title: 't', text: 'first part', offset: 0, nextOffset: 4000, totalChars: 5000, tables: [{ headers: ['A'], rows: [['1']], totalRows: 1 }] }
          : { url: 'u', title: 't', text: 'last part', offset, nextOffset: null, totalChars: 5000 },
    };
    const t = Object.fromEntries(createBrowserTools(reading).map((x) => [x.schema.name, x]));
    const first = await t['read_page']!.execute({});
    expect(first.data).toMatchObject({ text: 'first part', nextOffset: 4000, totalChars: 5000 });
    expect(first.data?.['tables']).toHaveLength(1);
    const last = await t['read_page']!.execute({ offset: 4000 });
    expect(last.data).toMatchObject({ text: 'last part', endOfPage: true });
    expect(last.data?.['nextOffset']).toBeUndefined();
  });

  it('both say so plainly when no page is open or the browser is not connected', async () => {
    const f = fake();
    const closed: BrowserAutomationService = {
      ...f.service,
      findOnPage: async () => {
        throw new Error('no tab');
      },
      readPage: async () => {
        throw new BrowserUnavailableError('lost the browser');
      },
    };
    const t = Object.fromEntries(createBrowserTools(closed).map((x) => [x.schema.name, x]));
    expect((await t['find_on_page']!.execute({ query: 'x' })).summary).toBe('no page open');
    expect((await t['read_page']!.execute({})).summary).toBe('browser not connected');
  });

  it('inspect_page shows the menu bar, closed-menu links and the unchanged-menu note when the page has them', async () => {
    const page = snap({ links: ['Track application'], navigation: ['Department 1'], collapsedMenus: { Services: ['Cause List'] }, moreLinks: 12 });
    const r = await tools(fake({ page }))['inspect_page']!.execute({});
    const current = r.data?.['currentPage'] as Record<string, unknown>;
    expect(current['navigation']).toEqual(['Department 1']);
    expect(current['linksInsideClosedMenus']).toEqual({ Services: ['Cause List'] });
    expect(current['moreLinks']).toBe(12);

    const same = snap({ links: ['Track application'], navigationSameAsPrevious: 70 });
    const r2 = await tools(fake({ page: same }))['inspect_page']!.execute({});
    const c2 = r2.data?.['currentPage'] as Record<string, unknown>;
    expect(c2['navigation']).toBeUndefined();
    expect(c2['navigationSameAsPreviousPage']).toBe('70 menu items, unchanged');
  });
});
