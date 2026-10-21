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

  it('stops at a CAPTCHA or a bot check without clicking anything', async () => {
    for (const kind of ['captcha', 'bot_check']) {
      bridge.calls = [];
      bridge.on('observe', { tabId: 7, state: rawState({ challenge: { kind, hint: 'h' } }, [{ role: 'button', name: 'Continue' }]) });
      const result = await svc.clickOnPage('Continue');
      expect(result, kind).toMatchObject({ ok: false, reason: 'needs_user' });
      expect(bridge.count('click'), kind).toBe(0);
    }
  });

  it('a verification-code page does not block clicking: the Verify button can be pressed after the code is typed', async () => {
    bridge.on('observe', { tabId: 7, state: rawState({ challenge: { kind: 'mfa', hint: 'h' } }, [{ role: 'button', name: 'Verify' }]) });
    bridge.on('click', okReply(rawState()));
    expect((await svc.clickOnPage('Verify')).ok).toBe(true);
    expect(bridge.count('click')).toBe(1);
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

describe('a chat page is acted on quickly (the extension must not wait for a download or for a page that never goes quiet)', () => {
  const chat = (url: string) => rawState({ url }, [{ role: 'input', name: 'Search or start a new chat', type: 'text' }, { role: 'button', name: 'Send' }]);
  const isChat = (url: string) => url.startsWith('https://web.whatsapp.test/');

  it('tells the extension `quick` for click, fill and open on a chat address, and for nothing else', async () => {
    const quick = new ChromeBrowserService(bridge, { quickFor: isChat });
    bridge.on('observe', { tabId: 7, state: chat('https://web.whatsapp.test/') });
    bridge.on('fill', okReply(chat('https://web.whatsapp.test/')));
    bridge.on('click', okReply(chat('https://web.whatsapp.test/')));
    bridge.on('open_url', okReply(chat('https://web.whatsapp.test/'), { reuse: 'focused' }));
    await quick.fillOnPage('search', 'akka');
    await quick.clickOnPage('send');
    await quick.openWebsite('https://web.whatsapp.test/');
    expect(bridge.calls.filter((c) => c.op !== 'observe').map((c) => [c.op, c.args['quick']])).toEqual([['fill', true], ['click', true], ['open_url', true]]);

    bridge.calls = [];
    bridge.on('observe', { tabId: 7, state: chat('https://site.example/') });
    bridge.on('fill', okReply(chat('https://site.example/')));
    bridge.on('open_url', okReply(chat('https://site.example/'), { reuse: null }));
    await quick.fillOnPage('search', 'cats');
    await quick.openWebsite('https://site.example/');
    expect(bridge.calls.some((c) => 'quick' in c.args)).toBe(false); // an ordinary page behaves exactly as before
  });

  it('never sends it unless it was told how (an Eya without that knowledge acts as it always did)', async () => {
    bridge.on('observe', { tabId: 7, state: chat('https://web.whatsapp.test/') });
    bridge.on('fill', okReply(chat('https://web.whatsapp.test/')));
    await svc.fillOnPage('search', 'akka');
    expect(bridge.calls.some((c) => 'quick' in c.args)).toBe(false);
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

  describe('a verification code the user said out loud', () => {
    const otpPage = rawState({ challenge: { kind: 'mfa', hint: 'h' } }, [
      { role: 'input', name: 'Enter OTP', type: 'text', sensitive: true, oneTimeCode: true },
      { role: 'input', name: 'Account password', type: 'password', sensitive: true },
      { role: 'button', name: 'Verify' },
    ]);

    it('is typed into the code field when it is allowed (it was said), even though the page is asking for a code', async () => {
      bridge.on('observe', { tabId: 7, state: otpPage });
      bridge.on('fill', okReply(rawState()));
      const result = await svc.fillOnPage('Enter OTP', '482913', { allowCode: true });
      expect(result).toMatchObject({ ok: true, codeEntered: true });
      expect(bridge.calls[1]!.args).toMatchObject({ id: 'e1.0', value: '482913', allowCode: true });
    });

    it('is refused when it was not said (nothing is sent), with a message that asks the user to say it', async () => {
      bridge.on('observe', { tabId: 7, state: otpPage });
      const result = await svc.fillOnPage('Enter OTP', '482913');
      expect(result).toMatchObject({ ok: false, reason: 'needs_user' });
      if (!result.ok && result.reason === 'needs_user') expect(result.message).toMatch(/say the code out loud/);
      expect(bridge.count('fill')).toBe(0);
    });

    it('never opens a password field, whatever is allowed', async () => {
      bridge.on('observe', { tabId: 7, state: otpPage });
      const result = await svc.fillOnPage('Account password', 'hunter2', { allowCode: true });
      expect(result).toMatchObject({ ok: false, reason: 'needs_user' });
      expect(bridge.count('fill')).toBe(0);
      expect(JSON.stringify(bridge.calls)).not.toContain('hunter2');
    });

    it('an extension older than 0.8.0 refuses the field: the user is told to reload it, not just that they must type it', async () => {
      bridge.on('observe', { tabId: 7, state: otpPage });
      bridge.on('fill', { performed: { ok: false, reason: 'sensitive_field', detail: 'old wording' }, tabId: 7, state: otpPage, settled: true });
      const result = await svc.fillOnPage('Enter OTP', '482913', { allowCode: true });
      expect(result).toMatchObject({ ok: false, reason: 'needs_user' });
      if (!result.ok && result.reason === 'needs_user') expect(result.message).toMatch(/out of date.*0\.8\.0/);
    });

    it('a CAPTCHA still blocks everything, code or not', async () => {
      bridge.on('observe', { tabId: 7, state: rawState({ challenge: { kind: 'captcha', hint: 'h' } }, [{ role: 'input', name: 'Enter OTP', sensitive: true, oneTimeCode: true }]) });
      expect(await svc.fillOnPage('Enter OTP', '482913', { allowCode: true })).toMatchObject({ ok: false, reason: 'needs_user' });
      expect(bridge.count('fill')).toBe(0);
    });
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

describe('not stuck on the main page: what is shown after each click, and finding what is not shown', () => {
  const headerLinks = Array.from({ length: 70 }, (_, i) => ({ role: 'link', name: `Department ${i + 1}`, region: 'header' }));
  const page1 = rawState({ title: 'Portal', url: 'https://p.example/' }, [
    ...headerLinks,
    { role: 'link', name: 'Citizen Services' },
    { role: 'link', name: 'Cause List', hidden: true, menu: 'Services', inViewport: false },
  ]);
  const page2 = rawState({ title: 'Citizen Services', url: 'https://p.example/citizen' }, [
    ...headerLinks,
    { role: 'link', name: 'Track application' },
    { role: 'link', name: 'Download forms' },
  ]);

  it("shows the page's own options first; the long menu bar is separate and is not repeated on the next page", async () => {
    bridge.on('observe', { tabId: 7, state: page1 });
    bridge.on('click', okReply(page2));
    const first = await svc.inspectPage();
    expect(first.links).toEqual(['Citizen Services']);
    expect(first.navigation).toHaveLength(60);
    expect(first.collapsedMenus).toEqual({ Services: ['Cause List'] });

    const result = await svc.clickOnPage('Citizen Services');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.links).toEqual(['Track application', 'Download forms']); // the NEXT level's options, not the header again
    expect(result.snapshot.navigation).toBeUndefined();
    expect(result.snapshot.navigationSameAsPrevious).toBe(70);
  });

  it('can click a link that only a closed menu holds, by name', async () => {
    bridge.on('observe', { tabId: 7, state: page1 });
    bridge.on('click', okReply(rawState({ title: 'Cause List' })));
    const result = await svc.clickOnPage('Cause List');
    expect(result.ok).toBe(true);
    expect(bridge.calls[1]!.args).toMatchObject({ name: 'Cause List' });
  });

  it('find_on_page searches everything, including the closed menu and the page text', async () => {
    bridge.on('observe', { tabId: 7, state: { ...page1, bodyText: 'Open the Cause List for the day.' } });
    const r = await svc.findOnPage('cause list');
    expect(r.matches[0]).toMatchObject({ name: 'Cause List', role: 'link' });
    expect(r.matches[0]?.where).toContain('closed menu "Services"');
    expect(r.textMatches[0]).toContain('Cause List for the day');
    expect(r.title).toBe('Portal');
  });

  it('read_page reads the text in slices and tables only with the first one', async () => {
    const body = Array.from({ length: 300 }, (_, i) => `Paragraph ${i + 1} with some words in it.`).join('\n');
    bridge.on('observe', { tabId: 7, state: rawState({ bodyText: body, tables: [{ headers: ['A'], rows: [['1']], totalRows: 1 }] }) });
    const a = await svc.readPage();
    expect(a.text.startsWith('Paragraph 1 ')).toBe(true);
    expect(a.nextOffset).not.toBeNull();
    expect(a.tables).toHaveLength(1);
    const b = await svc.readPage(a.nextOffset ?? 0);
    expect(b.offset).toBe(a.nextOffset);
    expect(b.tables).toBeUndefined();
  });

  it('stamps whichever browser it is driving, and reports its own unavailable message', async () => {
    const own = new ChromeBrowserService(bridge, { environment: 'eya_browser', unavailableMessage: 'custom message' });
    bridge.on('observe', { tabId: 7, state: rawState() });
    expect((await own.inspectPage()).environment).toBe('eya_browser');
    bridge.connected = false;
    await expect(own.inspectPage()).rejects.toThrow('custom message');
  });
});
