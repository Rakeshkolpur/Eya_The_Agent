import { describe, it, expect, beforeEach } from 'vitest';
import { ChromeBrowserService } from '../src/main/chrome/ChromeBrowserService';
import type { BridgeLike } from '../src/main/chrome/ChromeBrowserService';
import { BridgeError } from '../src/main/chrome/ChromeBridge';
import { BrowserUnavailableError } from '../src/main/browser/errors';

type RawEl = Record<string, unknown>;

function rawState(over: Record<string, unknown> = {}, elements: RawEl[] = []): Record<string, unknown> {
  return {
    url: 'https://site.example/',
    title: 'Site',
    epoch: 1,
    headings: ['Welcome'],
    elements: elements.map((e, i) => ({ id: `e1.${i}`, inViewport: true, ...e })),
    dialogs: [],
    visibleText: 'Welcome',
    tables: [],
    focused: null,
    scroll: { y: 0, max: 0, atBottom: true },
    challenge: null,
    loading: false,
    notes: [],
    ...over,
  };
}

class FakeBridge implements BridgeLike {
  connected = true;
  calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  private handlers = new Map<string, Array<(args: Record<string, unknown>) => unknown>>();

  /** Queue a reply for the next call of `op` (the last queued reply repeats). */
  on(op: string, ...replies: Array<unknown | ((args: Record<string, unknown>) => unknown)>): this {
    this.handlers.set(
      op,
      replies.map((r) => (typeof r === 'function' ? (r as (a: Record<string, unknown>) => unknown) : () => r)),
    );
    return this;
  }

  isConnected() {
    return this.connected;
  }

  async request<T = unknown>(op: string, args: Readonly<Record<string, unknown>> = {}): Promise<T> {
    this.calls.push({ op, args: { ...args } });
    if (!this.connected) throw new BridgeError('not_connected', 'not connected');
    const queue = this.handlers.get(op);
    if (queue === undefined || queue.length === 0) throw new Error(`unexpected request: ${op}`);
    const handler = queue.length > 1 ? queue.shift()! : queue[0]!;
    const out = handler(args);
    if (out instanceof Error) throw out;
    return out as T;
  }

  count(op: string) {
    return this.calls.filter((c) => c.op === op).length;
  }
}

let bridge: FakeBridge;
let svc: ChromeBrowserService;

beforeEach(() => {
  bridge = new FakeBridge();
  svc = new ChromeBrowserService(bridge);
});

const okReply = (state: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  performed: { ok: true },
  tabId: 7,
  state,
  settled: true,
  ...extra,
});

describe('opening and looking', () => {
  it('opens a site through the bridge and shows the page that is really there, stamped as the user\'s own browser', async () => {
    bridge.on('open_url', okReply(rawState({ title: 'Courts Portal' }, [{ role: 'link', name: 'Home' }]), { reuse: null }));
    const snap = await svc.openWebsite('https://site.example/');
    expect(bridge.calls[0]).toMatchObject({ op: 'open_url', args: { url: 'https://site.example/' } });
    expect(snap.title).toBe('Courts Portal');
    expect(snap.links).toEqual(['Home']);
    expect(snap.environment).toBe('your_browser');
  });

  it('says so when it reused a tab the user already had open', async () => {
    bridge.on('open_url', okReply(rawState(), { reuse: 'focused' }));
    const snap = await svc.openWebsite('https://site.example/');
    expect(snap.notes?.join(' ')).toMatch(/already had a tab open/);
  });

  it('inspects the current page without needing anything opened first', async () => {
    bridge.on('observe', { tabId: 3, state: rawState({}, [{ role: 'button', name: 'Search' }]) });
    const snap = await svc.inspectPage();
    expect(snap.buttons).toEqual(['Search']);
    expect(bridge.calls[0]!.op).toBe('observe');
  });

  it('turns a lost connection into BrowserUnavailableError, not a vague failure', async () => {
    bridge.connected = false;
    await expect(svc.inspectPage()).rejects.toBeInstanceOf(BrowserUnavailableError);
    await expect(svc.openWebsite('https://site.example/')).rejects.toBeInstanceOf(BrowserUnavailableError);
  });

  it('close() never touches the user\'s browser', async () => {
    await svc.close();
    expect(bridge.calls).toEqual([]);
  });
});

describe('clicking: look, choose what is really there, act, look again', () => {
  const menuClosed = rawState({}, [{ role: 'button', name: 'Open menu', expanded: false }, { role: 'link', name: 'Home' }]);
  const menuOpen = rawState({}, [
    { role: 'button', name: 'Open menu', expanded: true },
    { role: 'link', name: 'Home' },
    { role: 'link', name: 'Cause List' },
  ]);

  it('observes first, clicks the element it found by id (and name), and reports what the page looks like afterwards', async () => {
    bridge.on('observe', { tabId: 7, state: menuClosed });
    bridge.on('click', okReply(menuOpen));
    const result = await svc.clickOnPage('open menu');
    expect(bridge.calls.map((c) => c.op)).toEqual(['observe', 'click']);
    expect(bridge.calls[1]!.args).toMatchObject({ tabId: 7, id: 'e1.0', name: 'Open menu' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.links).toContain('Cause List');
    expect(result.effects?.changes.appeared).toEqual(['link: Cause List']);
    expect(result.effects?.changes.navigated).toBe(false);
  });

  it('does not click anything when nothing on the page matches, and shows what IS there', async () => {
    bridge.on('observe', { tabId: 7, state: menuClosed });
    const result = await svc.clickOnPage('Cause List');
    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
    expect(bridge.count('click')).toBe(0);
    if (!result.ok) expect(result.snapshot.links).toEqual(['Home']);
  });

  it('asks about the control it actually resolved to, not the words it was given, before touching it', async () => {
    bridge.on('observe', { tabId: 7, state: rawState({}, [{ role: 'button', name: 'Place order' }]) });
    const seen: Array<{ name: string; role: string }> = [];
    const result = await svc.clickOnPage('order', (t) => {
      seen.push(t);
      return 'completing a purchase';
    });
    expect(seen).toEqual([{ name: 'Place order', role: 'button' }]);
    expect(result).toMatchObject({ ok: false, reason: 'needs_confirmation', why: 'completing a purchase', target: 'Place order' });
    expect(bridge.count('click')).toBe(0);
  });

  it('stops at a CAPTCHA, a bot check or a verification-code prompt without clicking anything', async () => {
    for (const kind of ['captcha', 'bot_check', 'mfa']) {
      bridge.calls = [];
      bridge.on('observe', { tabId: 7, state: rawState({ challenge: { kind, hint: 'h' } }, [{ role: 'button', name: 'Continue' }]) });
      const result = await svc.clickOnPage('Continue');
      expect(result, kind).toMatchObject({ ok: false, reason: 'needs_user' });
      expect(bridge.count('click'), kind).toBe(0);
    }
  });

  it('a plain sign-in page does not block clicking (the user may be mid-task)', async () => {
    bridge.on('observe', { tabId: 7, state: rawState({ challenge: { kind: 'login', hint: 'h' } }, [{ role: 'link', name: 'Forgot password' }]) });
    bridge.on('click', okReply(rawState()));
    expect((await svc.clickOnPage('Forgot password')).ok).toBe(true);
  });

  it('re-looks and retries once when the element went stale between looking and clicking', async () => {
    bridge.on('observe', { tabId: 7, state: menuClosed }, { tabId: 7, state: rawState({ epoch: 2 }, [{ role: 'button', name: 'Open menu' }]) });
    bridge.on(
      'click',
      { performed: { ok: false, reason: 'stale_element', detail: 'changed' }, tabId: 7, state: menuClosed, settled: true },
      okReply(menuOpen),
    );
    const result = await svc.clickOnPage('Open menu');
    expect(result.ok).toBe(true);
    expect(bridge.count('observe')).toBe(2);
    expect(bridge.count('click')).toBe(2);
  });

  it('gives up honestly if the page keeps changing under it', async () => {
    bridge.on('observe', { tabId: 7, state: menuClosed });
    bridge.on('click', { performed: { ok: false, reason: 'stale_element', detail: 'changed' }, tabId: 7, state: menuClosed, settled: true });
    const result = await svc.clickOnPage('Open menu');
    expect(result).toMatchObject({ ok: false, reason: 'could_not' });
    expect(bridge.count('click')).toBe(2);
  });

  it('passes on what the page said when something is covering the control', async () => {
    bridge.on('observe', { tabId: 7, state: menuClosed });
    bridge.on('click', {
      performed: { ok: false, reason: 'obscured', detail: 'Something else is covering it ("Accept cookies")' },
      tabId: 7,
      state: rawState({ dialogs: ['We use cookies'] }, [{ role: 'button', name: 'Accept cookies' }]),
      settled: true,
    });
    const result = await svc.clickOnPage('Home');
    expect(result).toMatchObject({ ok: false, reason: 'could_not' });
    if (!result.ok && result.reason === 'could_not') {
      expect(result.message).toMatch(/covering/);
      expect(result.snapshot.dialogs).toEqual(['We use cookies']);
    }
  });

  it('follows a new tab and a download, and says so', async () => {
    bridge.on('observe', { tabId: 7, state: rawState({}, [{ role: 'link', name: 'Download report' }]) });
    bridge.on(
      'click',
      okReply(rawState({ url: 'https://site.example/orders', title: 'Orders' }), {
        tabId: 9,
        newTab: { tabId: 9, from: 7 },
        download: { downloadId: 4, filename: 'C:\\Users\\Rakesh\\Downloads\\eya-test-report.txt', state: 'complete', bytes: 18, mime: 'text/plain' },
      }),
    );
    const result = await svc.clickOnPage('Download report');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effects?.newTab).toEqual({ url: 'https://site.example/orders', title: 'Orders' });
    expect(result.effects?.download).toMatchObject({ name: 'eya-test-report.txt', state: 'complete', bytes: 18, path: 'C:\\Users\\Rakesh\\Downloads\\eya-test-report.txt' });
    expect(result.snapshot.notes?.join(' ')).toMatch(/new tab/);
  });

  it('flags a page that was still changing when it looked', async () => {
    bridge.on('observe', { tabId: 7, state: menuClosed });
    bridge.on('click', okReply(menuOpen, { settled: false }));
    const result = await svc.clickOnPage('Open menu');
    expect(result.ok && result.effects?.settled).toBe(false);
    expect(result.ok && result.snapshot.notes?.join(' ')).toMatch(/still changing/);
  });
});

describe('filling', () => {
  const form = rawState({}, [
    { role: 'input', name: 'Case number', type: 'text' },
    { role: 'input', name: 'Account password', type: 'password', sensitive: true },
    { role: 'select', name: 'Year', options: ['2024', '2025'] },
  ]);

  it('fills a field it found by label, asking the page to press Enter only when told to', async () => {
    bridge.on('observe', { tabId: 7, state: form });
    bridge.on('fill', okReply(rawState({ visibleText: 'Submitted' })));
    const result = await svc.fillOnPage('case number', 'WP 12/2026', { submit: true });
    expect(result.ok).toBe(true);
    expect(bridge.calls[1]!.args).toMatchObject({ tabId: 7, id: 'e1.0', name: 'Case number', value: 'WP 12/2026', submit: true });
  });

  it('refuses a password / card / code field without ever sending the value anywhere', async () => {
    bridge.on('observe', { tabId: 7, state: form });
    const result = await svc.fillOnPage('password', 'hunter2');
    expect(result).toMatchObject({ ok: false, reason: 'needs_user' });
    expect(bridge.count('fill')).toBe(0);
    expect(JSON.stringify(bridge.calls)).not.toContain('hunter2');
  });

  it('lists the real choices when a drop-down has no such option', async () => {
    bridge.on('observe', { tabId: 7, state: form });
    bridge.on('fill', { performed: { ok: false, reason: 'no_such_option', detail: 'That option is not in the list.', options: ['2024', '2025'] }, tabId: 7, state: form, settled: true });
    const result = await svc.fillOnPage('year', '1999');
    expect(result).toMatchObject({ ok: false, reason: 'could_not' });
    if (!result.ok && result.reason === 'could_not') expect(result.message).toContain('2024, 2025');
  });

  it('reports a field that is not there, and stops at a CAPTCHA', async () => {
    bridge.on('observe', { tabId: 7, state: form });
    expect(await svc.fillOnPage('nonexistent', 'x')).toMatchObject({ ok: false, reason: 'not_found' });
    bridge.on('observe', { tabId: 7, state: rawState({ challenge: { kind: 'captcha', hint: 'h' } }, [{ role: 'input', name: 'Case number' }]) });
    expect(await svc.fillOnPage('Case number', 'x')).toMatchObject({ ok: false, reason: 'needs_user' });
  });

  it('turns a page-side refusal to type into a file or sensitive field into a needs_user', async () => {
    bridge.on('observe', { tabId: 7, state: rawState({}, [{ role: 'input', name: 'Attachment' }]) });
    bridge.on('fill', { performed: { ok: false, reason: 'file_input', detail: 'That is a file-upload field.' }, tabId: 7, state: form, settled: true });
    expect(await svc.fillOnPage('Attachment', 'x')).toMatchObject({ ok: false, reason: 'needs_user' });
  });
});

describe('going back, searching, tabs', () => {
  it('goes back and reports the page it lands on, or says there is nothing to go back to', async () => {
    bridge.on('observe', { tabId: 7, state: rawState({ url: 'https://site.example/b' }) });
    bridge.on('back', okReply(rawState({ url: 'https://site.example/a' })));
    const back = await svc.goBack();
    expect(back.ok && back.effects?.changes.urlChanged).toEqual({ from: 'https://site.example/b', to: 'https://site.example/a' });

    bridge.on('back', { performed: { ok: false, reason: 'no_history', detail: 'There is nothing to go back to in this tab.' }, tabId: 7, state: rawState(), settled: true });
    expect(await svc.goBack()).toMatchObject({ ok: false, reason: 'could_not' });
  });

  const hit = { title: 'High Court for the State of Telangana', href: '//duckduckgo.com/l/?uddg=https%3A%2F%2Ftshc.gov.in%2F&rut=abc', snippet: 'Official website' };

  it('searches through a background tab of the user\'s browser and decodes the real destinations', async () => {
    bridge.on('search_page', { hits: [hit] });
    const hits = await svc.searchWeb('telangana high court');
    expect(hits[0]!.url).toBe('https://tshc.gov.in/');
    expect(bridge.calls[0]!.args['url']).toContain('duckduckgo');
    expect(bridge.calls[0]!.args['engine']).toBe('duckduckgo');
  });

  it('tries the next engine when the first finds nothing, and throws only if every engine failed', async () => {
    bridge.on('search_page', { hits: [] }, { hits: [{ title: 'T', href: 'https://example.org/', snippet: 's' }] });
    expect((await svc.searchWeb('x'))).toHaveLength(1);
    expect(bridge.count('search_page')).toBe(2);

    bridge.calls = [];
    bridge.on('search_page', () => new Error('tab failed'));
    await expect(svc.searchWeb('x')).rejects.toThrow(/tab failed/);

    bridge.on('search_page', { hits: [] });
    expect(await svc.searchWeb('x')).toEqual([]);
  });

  it('lists tabs and switches to one', async () => {
    bridge.on('list_tabs', {
      tabs: [
        { tabId: 3, title: 'Inbox', url: 'https://mail.example/', active: true, openedByEya: false, workingHere: false },
        { tabId: 'bad' },
        { tabId: 4, title: 'Docs', url: 'https://docs.example/', active: false, openedByEya: true, workingHere: true },
      ],
    });
    const tabs = await svc.listTabs();
    expect(tabs.map((t) => t.tabId)).toEqual([3, 4]);
    expect(tabs[1]).toMatchObject({ openedByEya: true, workingHere: true });

    bridge.on('focus_tab', okReply(rawState({ title: 'Inbox' })));
    expect((await svc.switchToTab(3)).title).toBe('Inbox');
    expect(bridge.calls.at(-1)).toMatchObject({ op: 'focus_tab', args: { tabId: 3 } });
  });
});
