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
  it('tab tools and connect_chrome exist only when the user\'s browser can be reached', () => {
    const f = fake();
    const bare = Object.keys(tools(f));
    expect(bare).toEqual(['open_website', 'inspect_page', 'find_on_page', 'read_page', 'click_on_page', 'fill_on_page', 'go_back']);
    const full = Object.keys(
      tools(f, {
        tabs: { listTabs: async () => [], switchToTab: async () => snap() },
        connector: { connect: async () => ({ connected: true, alreadyConnected: true, extensionFolder: 'x', helpOpened: false }) },
      }),
    );
    expect(full).toEqual(expect.arrayContaining(['list_browser_tabs', 'switch_browser_tab', 'connect_chrome']));
  });

  it('lists tabs by id, title and address, and switches by id', async () => {
    const f = fake();
    const t = tools(f, {
      tabs: {
        listTabs: async () => [
          { tabId: 3, title: 'Inbox', url: 'https://mail.example/', active: true, openedByEya: false, workingHere: false },
          { tabId: 4, title: 'Docs', url: 'https://docs.example/', active: false, openedByEya: true, workingHere: true },
        ],
        switchToTab: async (id) => snap({ title: `tab ${id}` }),
      },
    });
    const listed = await t['list_browser_tabs']!.execute({});
    expect(listed.summary).toBe('2 tabs open');
    expect(listed.data?.['tabs']).toEqual([
      { tabId: 3, title: 'Inbox', url: 'https://mail.example/', activeInBrowser: true },
      { tabId: 4, title: 'Docs', url: 'https://docs.example/', eyaIsHere: true },
    ]);
    const switched = await t['switch_browser_tab']!.execute({ tab_id: 4 });
    expect(switched.ok).toBe(true);
    expect(switched.summary).toBe('switched to tab 4');
    expect((await t['switch_browser_tab']!.execute({})).ok).toBe(false);
  });

  it('connect_chrome reports connection, or exactly what the user still has to do', async () => {
    const f = fake();
    const connected = tools(f, { connector: { connect: async () => ({ connected: true, alreadyConnected: false, browser: 'edge', extensionFolder: 'x', helpOpened: true }) } });
    expect(await connected['connect_chrome']!.execute({})).toMatchObject({ ok: true, summary: 'connected', data: { connected: true, browser: 'edge' } });

    const waiting = tools(f, { connector: { connect: async () => ({ connected: false, alreadyConnected: false, extensionFolder: 'C:\\app\\eya-chrome-extension', helpOpened: true }) } });
    const r = await waiting['connect_chrome']!.execute({});
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('waiting for you');
    expect(r.error).toMatch(/Load unpacked/);
    expect(r.error).toMatch(/eya-chrome-extension/);
    expect(r.data).toMatchObject({ connected: false, extensionFolder: 'C:\\app\\eya-chrome-extension' });
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
