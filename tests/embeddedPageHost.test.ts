import { describe, it, expect } from 'vitest';
import { EmbeddedPageHost } from '../src/main/browser/EmbeddedPageHost';
import type { EmbeddedEnvironment, EmbeddedTab, HostEvent, RawDownload, TabEvent, ViewBounds } from '../src/main/browser/EmbeddedPageHost';
import { BrowserNavigationError } from '../src/main/browser/errors';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A tab with no browser behind it: it answers the page script's commands from what a test says the page looks like. */
class FakeTab implements EmbeddedTab {
  readonly listeners: Array<(e: TabEvent) => void> = [];
  currentUrl = '';
  currentTitle = '';
  closed = false;
  stopped = 0;
  history = { back: true, forward: false };
  /** How many characters of text and controls the page has (the blank-page probe reads it). */
  content = 500;
  state: Record<string, unknown> = { url: 'https://site.example/', title: 'Site', text: 'hello' };
  loads: string[] = [];
  /** What loading an address does; a test replaces it to make pages that fail. */
  onLoad: (url: string, attempt: number) => Promise<void> | void = (url) => {
    this.currentUrl = url;
    this.emit({ type: 'navigated' });
    this.emit({ type: 'status', code: 200 });
  };
  /** What the page script's commands answer; a test replaces it for a click that opens a window and so on. */
  onCommand: (command: string, params: Record<string, unknown>) => unknown = (command) => {
    if (command === 'waitQuiet') return { settled: true };
    if (command === 'observe') return { ...this.state, url: this.currentUrl };
    if (command === 'extractSearch') return [{ title: 'A result', url: 'https://result.example/' }];
    return { ok: true };
  };
  commands: string[] = [];

  emit(e: TabEvent): void {
    for (const l of this.listeners) l(e);
  }
  onEvent(l: (e: TabEvent) => void): void {
    this.listeners.push(l);
  }
  url(): string {
    return this.currentUrl;
  }
  title(): string {
    return this.currentTitle;
  }
  async load(url: string): Promise<void> {
    this.loads.push(url);
    await this.onLoad(url, this.loads.length);
  }
  async run(code: string): Promise<unknown> {
    if (code === 'document.readyState') return 'complete';

    const m = /\)\("(\w+)", (\{[\s\S]*\})\)$/.exec(code);
    if (m === null) {
      if (code.includes('innerText')) return this.content; // (the blank-page probe)
      throw new Error(`unexpected script: ${code.slice(0, 60)}`);
    }
    this.commands.push(m[1] as string);
    return this.onCommand(m[1] as string, JSON.parse(m[2] as string) as Record<string, unknown>);
  }
  stop(): void {
    this.stopped++;
  }
  reload(): void {
    this.emit({ type: 'navigated' });
  }
  back(): boolean {
    return this.history.back;
  }
  forward(): boolean {
    return this.history.forward;
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.from('png-bytes');
  }
  focus(): void {
    this.focused = true;
  }
  focused = false;
  close(): void {
    this.closed = true;
    this.emit({ type: 'closed' });
  }
  isClosed(): boolean {
    return this.closed;
  }
}

class FakeEnv implements EmbeddedEnvironment {
  readonly tabs: FakeTab[] = [];
  readonly hidden: FakeTab[] = [];
  shown: EmbeddedTab | null = null;
  bounds: ViewBounds | null | undefined;
  revealed = 0;
  createTab(): EmbeddedTab {
    const t = new FakeTab();
    this.tabs.push(t);
    return t;
  }
  createHiddenTab(): EmbeddedTab {
    const t = new FakeTab();
    this.hidden.push(t);
    return t;
  }
  show(tab: EmbeddedTab | null): void {
    this.shown = tab;
  }
  setBounds(b: ViewBounds | null): void {
    this.bounds = b;
  }
  reveal(): void {
    this.revealed++;
  }
}

function setup(options: { navTimeoutMs?: number; blankWaitMs?: number } = {}) {
  const env = new FakeEnv();
  const host = new EmbeddedPageHost({ env, navTimeoutMs: 500, blankWaitMs: 300, ...options });
  const events: HostEvent[] = [];
  host.onEvent((e) => events.push(e));
  return { env, host, events, tab: () => env.tabs[0] as FakeTab };
}

type OpenReply = { performed: { ok: boolean }; state: Record<string, unknown>; settled: boolean; navigation: { requested: string; final: string; status: number | null; blank: boolean }; download?: RawDownload };

describe('EmbeddedPageHost: open_url', () => {
  it('opens the address in a tab drawn on the page, and says where it ended up and what the site answered', async () => {
    const { env, host, tab } = setup();
    const r = await host.request<OpenReply>('open_url', { url: 'https://site.example/reports?id=7' });
    expect(tab().loads).toEqual(['https://site.example/reports?id=7']);
    expect(env.shown).toBe(tab());
    expect(r.performed.ok).toBe(true);
    expect(r.navigation).toMatchObject({ final: 'https://site.example/reports?id=7', status: 200, blank: false });
    expect(r.settled).toBe(true);
  });

  it('puts what a site says about the page (403, 404) in the reply and does not try again when trying again cannot help', async () => {
    const { host, tab } = setup();
    tab(); // (created on first use)
    const first = await host.request<OpenReply>('open_url', { url: 'https://site.example/a' });
    expect(first.navigation.status).toBe(200);
    tab().onLoad = (url) => {
      tab().currentUrl = url;
      tab().emit({ type: 'status', code: 403 });
    };
    const r = await host.request<OpenReply>('open_url', { url: 'https://site.example/private' });
    expect(r.navigation.status).toBe(403);
    expect(tab().loads.filter((u) => u.endsWith('/private'))).toHaveLength(1);
  });

  it('tries once more when the site had a hiccup (a server error), and reports the good answer', async () => {
    const { host, tab } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    tab().onLoad = (url, attempt) => {
      tab().currentUrl = url;
      tab().emit({ type: 'status', code: attempt === 2 ? 503 : 200 });
    };
    // (first call of the new address: 503, second: let it be fine)
    let calls = 0;
    tab().onLoad = (url) => {
      calls++;
      tab().currentUrl = url;
      tab().emit({ type: 'status', code: calls === 1 ? 503 : 200 });
    };
    const r = await host.request<OpenReply>('open_url', { url: 'https://site.example/flaky' });
    expect(calls).toBe(2);
    expect(r.navigation.status).toBe(200);
  }, 10_000);

  it('says in words why a name that does not exist cannot be opened, and does not retry it', async () => {
    const { host, tab, events } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    tab().onLoad = () => Promise.reject(new Error('ERR_NAME_NOT_RESOLVED (-105)'));
    const before = tab().loads.length;
    await expect(host.request('open_url', { url: 'https://nope.invalid/' })).rejects.toBeInstanceOf(BrowserNavigationError);
    expect(tab().loads.length - before).toBe(1);
    expect(events.some((e) => e.type === 'problem' && e.kind === 'dns' && /could not be found/.test(e.message))).toBe(true);
  });

  it('a page the browser called ready but also reported as failed is a failure, not an opened page', async () => {
    const { host, tab } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    tab().onLoad = () => {
      tab().emit({ type: 'failed', description: 'ERR_TOO_MANY_REDIRECTS (-310)', url: 'https://loop.example/' });
    };
    const err = await host.request('open_url', { url: 'https://loop.example/' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserNavigationError);
    expect((err as BrowserNavigationError).problem.kind).toBe('redirect_loop');
  });

  it('does not retry a redirect loop or a refused connection either', async () => {
    const { host, tab } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    for (const text of ['ERR_TOO_MANY_REDIRECTS (-310)', 'ERR_CONNECTION_REFUSED (-102)']) {
      tab().onLoad = () => Promise.reject(new Error(text));
      const before = tab().loads.length;
      await expect(host.request('open_url', { url: 'https://loop.example/' })).rejects.toBeInstanceOf(BrowserNavigationError);
      expect(tab().loads.length - before).toBe(1);
    }
  });

  it('recovers from a timeout with one more try, and reports a site that never answers as slow', async () => {
    const { host, tab } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    let calls = 0;
    tab().onLoad = (url) => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('Timeout 500ms exceeded'));
      tab().currentUrl = url;
      tab().emit({ type: 'status', code: 200 });
      return undefined;
    };
    const ok = await host.request<OpenReply>('open_url', { url: 'https://slow.example/' });
    expect(ok.navigation.status).toBe(200);
    expect(tab().stopped).toBeGreaterThan(0);

    tab().onLoad = () => Promise.reject(new Error('Timeout 500ms exceeded'));
    const err = await host.request('open_url', { url: 'https://hang.example/' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserNavigationError);
    expect((err as BrowserNavigationError).problem.kind).toBe('timeout');
  }, 10_000);

  it('does not count a page that replaced itself with another one (a redirect the site made) as a failure', async () => {
    const { host, tab } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    tab().onLoad = () => {
      tab().currentUrl = 'https://site.example/landing';
      return Promise.reject(new Error('ERR_ABORTED (-3)'));
    };
    const r = await host.request<OpenReply>('open_url', { url: 'https://site.example/go' });
    expect(r.navigation.final).toBe('https://site.example/landing');
  });

  it('reports a file that downloads instead of a page as a download, not as an error', async () => {
    const { host, tab } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    tab().currentUrl = '';
    tab().onLoad = () => {
      tab().emit({ type: 'download', done: Promise.resolve({ downloadId: 1, filename: 'C:\\Downloads\\bill.pdf', state: 'complete', bytes: 1234 }) });
      return Promise.reject(new Error('ERR_ABORTED (-3)'));
    };
    const r = await host.request<OpenReply>('open_url', { url: 'https://site.example/bill.pdf' });
    expect(r.download).toMatchObject({ filename: 'C:\\Downloads\\bill.pdf', state: 'complete', bytes: 1234 });
  });

  it('calls a page blank only after it has had time to build itself', async () => {
    const { host, tab } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    tab().content = 0;
    const blank = await host.request<OpenReply>('open_url', { url: 'https://empty.example/' });
    expect(blank.navigation.blank).toBe(true);

    tab().content = 0;
    setTimeout(() => (tab().content = 400), 150);
    const late = await host.request<OpenReply>('open_url', { url: 'https://late.example/' });
    expect(late.navigation.blank).toBe(false);
  });

  it('keeps the page showing the browser it is in: a crashed page is opened again in the same tab', async () => {
    const { host, tab, env } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    let calls = 0;
    tab().onLoad = (url) => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('The page crashed'));
      tab().currentUrl = url;
      return undefined;
    };
    const r = await host.request<OpenReply>('open_url', { url: 'https://site.example/again' });
    expect(r.navigation.final).toBe('https://site.example/again');
    expect(env.shown).not.toBeNull();
  });
});

describe('EmbeddedPageHost: acting on a page', () => {
  it('a click that opens a window is followed into the new tab, and says so', async () => {
    const { host, tab, env } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    tab().onCommand = (command) => {
      if (command === 'click') {
        const child = new FakeTab();
        child.currentUrl = 'https://pay.example/checkout';
        env.tabs.push(child);
        tab().emit({ type: 'opened', tab: child });
        return { ok: true };
      }
      if (command === 'waitQuiet') return { settled: true };
      return { url: tab().currentUrl };
    };
    const r = await host.request<{ newTab?: { tabId: number; from: number }; tabId: number }>('click', { id: 3, name: 'Pay' });
    expect(r.newTab).toBeDefined();
    expect(env.shown).toBe(env.tabs[1]);
    const tabs = await host.request<{ tabs: Array<{ tabId: number; active: boolean; url: string }> }>('list_tabs');
    expect(tabs.tabs).toHaveLength(2);
    expect(tabs.tabs.find((t) => t.active)?.url).toBe('https://pay.example/checkout');
  });

  it('a window the page opens while the user is clicking in it becomes the tab shown', async () => {
    const { host, tab, env } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    const child = new FakeTab();
    env.tabs.push(child);
    tab().emit({ type: 'opened', tab: child });
    expect(env.shown).toBe(child);
  });

  it('a download a click starts is waited for and reported (a verified file, not a promise)', async () => {
    const { host, tab } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    tab().onCommand = (command) => {
      if (command === 'click') {
        tab().emit({ type: 'download', done: sleep(50).then((): RawDownload => ({ downloadId: 2, filename: 'C:\\Downloads\\report.pdf', state: 'complete', bytes: 9000 })) });
        return { ok: true };
      }
      if (command === 'waitQuiet') return { settled: true };
      return {};
    };
    const r = await host.request<{ download?: RawDownload }>('click', { id: 1, name: 'Download' });
    expect(r.download).toMatchObject({ state: 'complete', bytes: 9000 });
  });

  it('a click that starts a navigation and tears the page down is not an error', async () => {
    const { host, tab } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    tab().onCommand = (command) => {
      if (command === 'click') {
        tab().emit({ type: 'navigated' });
        throw new Error('Script failed to execute');
      }
      if (command === 'waitQuiet') return { settled: true };
      return {};
    };
    const r = await host.request<{ performed: { ok: boolean; navigated?: boolean } }>('click', { id: 1, name: 'Next' });
    expect(r.performed).toMatchObject({ ok: true, navigated: true });
  });

  it('a click that fails for a real reason is reported as that, not as success', async () => {
    const { host, tab } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    tab().onCommand = (command) => (command === 'click' ? { ok: false, reason: 'obscured', detail: 'covered by a banner' } : {});
    const r = await host.request<{ performed: { ok: boolean; reason?: string } }>('click', { id: 1, name: 'Buy' });
    expect(r.performed).toMatchObject({ ok: false, reason: 'obscured' });
  });

  it('runs the adverts helper of the page script and hands back what it reports (so a song can be started and checked here too)', async () => {
    const { host, tab } = setup();
    await host.request('open_url', { url: 'https://www.youtube.com/watch?v=abc' });
    let seen: Record<string, unknown> | null = null;
    tab().onCommand = (command, params) => {
      if (command !== 'ads') return {};
      seen = params;
      return { ok: true, onYouTube: true, adShowing: false, skipped: 1, closed: 0, watching: true, video: { paused: false, ended: false, seconds: 3, length: 200 } };
    };
    const r = await host.request<{ state: { skipped: number; video: { paused: boolean } } }>('ads', { mode: 'watch', keepPlaying: true, play: true });
    expect(seen).toEqual({ mode: 'watch', keepPlaying: true, play: true });
    expect(r.state).toMatchObject({ skipped: 1, video: { paused: false } });
    // (the options that were not asked for are not sent)
    await host.request('ads', { mode: 'once' });
    expect(seen).toEqual({ mode: 'once' });
  });

  it('fill with submit presses enter after typing', async () => {
    const { host, tab } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    await host.request('fill', { id: 2, name: 'Search', value: 'shoes', submit: true });
    expect(tab().commands).toContain('fill');
    expect(tab().commands).toContain('press');
  });

  it('a native popup is dismissed and mentioned in the looks that follow, for a few seconds', async () => {
    const { host, tab } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    tab().emit({ type: 'dialog', message: 'Are you sure?' });
    const first = await host.request<{ state: { dialogs?: string[] } }>('observe');
    expect(first.state.dialogs?.[0]).toMatch(/Are you sure\?/);
    const second = await host.request<{ state: { dialogs?: string[] } }>('observe');
    expect(second.state.dialogs?.[0]).toMatch(/Are you sure?/);
  });

  it('back with nowhere to go says so; with somewhere to go, goes', async () => {
    const { host, tab } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    tab().history.back = false;
    const none = await host.request<{ performed: { ok: boolean; reason?: string } }>('back');
    expect(none.performed).toMatchObject({ ok: false, reason: 'no_history' });
    tab().history.back = true;
    const some = await host.request<{ performed: { ok: boolean } }>('back');
    expect(some.performed.ok).toBe(true);
  });

  it('stop loading stops the page and tells the Browser page it is no longer loading', async () => {
    const { host, tab, events } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    tab().emit({ type: 'loading', loading: true });
    await host.request('stop_loading');
    expect(tab().stopped).toBeGreaterThan(0);
    const last = [...events].reverse().find((e) => e.type === 'page');
    expect(last).toMatchObject({ loading: false });
  });

  it('takes a picture of the page, and opens Eya on the browser page when asked to show it', async () => {
    const { host, tab, env } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    const shot = await host.request<{ dataUrl: string }>('screenshot');
    expect(shot.dataUrl).toBe(`data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`);
    await host.request('show_window');
    expect(env.revealed).toBe(1);
    expect(tab().focused).toBe(true);
  });

  it('reads a results page in a tab nobody sees, and closes it again', async () => {
    const { host, env } = setup();
    const r = await host.request<{ hits: Array<{ title: string }> }>('search_page', { url: 'https://duckduckgo.com/?q=x', engine: 'duckduckgo' });
    expect(r.hits[0]?.title).toBe('A result');
    expect(env.hidden).toHaveLength(1);
    expect(env.hidden[0]?.closed).toBe(true);
    expect(env.tabs).toHaveLength(0);
  });

  it('tells the page where the browser is drawn, and closes every tab when it is closed', async () => {
    const { host, env, tab } = setup();
    host.setViewBounds({ x: 1, y: 2, width: 300, height: 200 });
    expect(env.bounds).toEqual({ x: 1, y: 2, width: 300, height: 200 });
    await host.request('open_url', { url: 'https://site.example/' });
    await host.close();
    expect(tab().closed).toBe(true);
    expect(env.shown).toBeNull();
  });

  it('a request nobody knows is an error, not silence', async () => {
    const { host } = setup();
    await expect(host.request('make_coffee')).rejects.toThrow(/Unknown request/);
  });

  it('with no tab at all, looking at a page says to open a website first', async () => {
    const { host } = setup();
    await expect(host.request('observe')).rejects.toThrow(/Open a website first/);
  });
});

describe('EmbeddedPageHost: what the Browser page is told', () => {
  it('reports the address and title as the page loads, without anything secret in the address', async () => {
    const { host, tab, events } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    tab().currentUrl = 'https://site.example/cb?token=abc123&page=2#frag';
    tab().currentTitle = 'Callback';
    tab().emit({ type: 'loading', loading: false });
    const last = [...events].reverse().find((e) => e.type === 'page');
    expect(last).toMatchObject({ type: 'page', loading: false, title: 'Callback' });
    expect((last as { url: string }).url).toBe('https://site.example/cb?page=2');
  });

  it('reports a page crash as a problem in words', async () => {
    const { host, tab, events } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    tab().emit({ type: 'crashed' });
    expect(events.some((e) => e.type === 'problem' && e.kind === 'crashed')).toBe(true);
  });

  it('when the shown tab is closed by the user, the last tab left is shown', async () => {
    const { host, tab, env } = setup();
    await host.request('open_url', { url: 'https://site.example/' });
    await host.request('new_tab');
    const second = env.tabs[1] as FakeTab;
    expect(env.shown).toBe(second);
    second.close();
    expect(env.shown).toBe(tab());
  });
});

describe('EmbeddedPageHost: a chat (WhatsApp Web) in Eya Browser', () => {
  async function chatTab() {
    const w = setup();
    await w.host.request('open_url', { url: 'https://web.whatsapp.com/' });
    return { ...w, t: w.tab() };
  }

  it('the chat operations run the page script\'s own commands, one for one, in the tab asked for', async () => {
    const { host, t } = await chatTab();
    t.onCommand = (command, params) => {
      if (command === 'waitQuiet') return { settled: true };
      if (command === 'observe') return { url: t.currentUrl };
      return { ok: true, command, params };
    };
    const watch = await host.request<{ tabId: number; command: string; params: Record<string, unknown> }>('chat_watch', { mode: 'start' });
    expect(watch).toMatchObject({ tabId: 1, command: 'chatWatch', params: { mode: 'start' } });
    const read = await host.request<{ command: string; params: Record<string, unknown> }>('chat_read', { max: 30, tabId: 1 });
    expect(read).toMatchObject({ command: 'chatRead', params: { max: 30 } });
    const look = await host.request<{ command: string; params: Record<string, unknown> }>('chat_media', { id: 'false_1', phase: 'look', maxBytes: 5000 });
    expect(look).toMatchObject({ command: 'chatMedia', params: { id: 'false_1', phase: 'look', maxBytes: 5000 } });
    const del = await host.request<{ command: string; params: Record<string, unknown> }>('chat_delete', { id: 'true_5', scope: 'everyone' });
    expect(del).toMatchObject({ command: 'chatDelete', params: { id: 'true_5', scope: 'everyone' } });
    const delMe = await host.request<{ params: Record<string, unknown> }>('chat_delete', { id: 'true_5', scope: 'anything else' });
    expect(delMe.params['scope']).toBe('me'); // (only "everyone" is everyone)
  });

  it('a step on a chat page waits only a moment when told it is quick, and does not wait for a download', async () => {
    const { host, t } = await chatTab();
    const quiet: Array<Record<string, unknown>> = [];
    t.onCommand = (command, params) => {
      if (command === 'waitQuiet') {
        quiet.push(params);
        return { settled: true };
      }
      if (command === 'observe') return { url: t.currentUrl };
      return { ok: true };
    };
    const started = Date.now();
    await host.request('press_key', { key: 'Escape' });
    await host.request('click', { id: 'e1', name: 'Send', quick: true });
    expect(Date.now() - started).toBeLessThan(900);
    expect(quiet.at(-1)).toEqual({ minMs: 80, quietMs: 150, timeoutMs: 500, busyExtraMs: 0 });
    // (not quick: the usual, longer wait)
    await host.request('click', { id: 'e1', name: 'Send' });
    expect(quiet.at(-1)).toEqual({});
  });

  it('a file for the page\'s file picker goes in parts, the same four steps as in the user\'s own browser', async () => {
    const { host, t } = await chatTab();
    const seen: Array<[string, Record<string, unknown>]> = [];
    t.onCommand = (command, params) => {
      seen.push([command, params]);
      if (command === 'waitQuiet') return { settled: true };
      if (command === 'observe') return { url: t.currentUrl };
      return { ok: true };
    };
    await host.request('attach_file', { phase: 'probe' });
    await host.request('attach_file', { phase: 'begin', id: 'f1', name: 'plan.pdf', mime: 'application/pdf', size: 10 });
    await host.request('attach_file', { phase: 'chunk', id: 'f1', data: 'AAAA' });
    await host.request('attach_file', { phase: 'commit', id: 'f1', prefer: 'document', quick: true });
    expect(seen.map(([c]) => c).filter((c) => c.startsWith('attach'))).toEqual(['attachProbe', 'attachBegin', 'attachChunk', 'attachCommit']);
    await expect(host.request('attach_file', { phase: 'nonsense' })).rejects.toThrow(/Unknown file transfer step/);
  });

  it('what the page\'s watcher says on its console reaches the live chat as a change in THAT tab; a closed tab and a reloaded page are told too', async () => {
    const { host, t } = await chatTab();
    const heard: Array<{ name: string; tabId: number; reason?: string; rows?: number }> = [];
    host.onBrowserEvent((e) => heard.push({ name: e.name, tabId: e.data.tabId, ...(e.data.reason !== undefined ? { reason: e.data.reason } : {}), ...(e.data.rows !== undefined ? { rows: e.data.rows } : {}) }));
    t.emit({ type: 'chat', reason: 'messages', rows: 12 });
    t.emit({ type: 'navigated' });
    t.emit({ type: 'loading', loading: false });
    t.close();
    expect(heard).toEqual([
      { name: 'chat_changed', tabId: 1, reason: 'messages', rows: 12 },
      { name: 'navigation_completed', tabId: 1 },
      { name: 'tab_removed', tabId: 1 },
    ]);
  });

  it('a listener can stop listening', async () => {
    const { host, t } = await chatTab();
    let n = 0;
    const off = host.onBrowserEvent(() => (n += 1));
    t.emit({ type: 'chat', reason: 'messages', rows: 1 });
    off();
    t.emit({ type: 'chat', reason: 'messages', rows: 2 });
    expect(n).toBe(1);
  });
});

describe('EmbeddedPageHost: a chat app\'s tab is never navigated away by another request', () => {
  function guarded() {
    const env = new FakeEnv();
    const host = new EmbeddedPageHost({ env, navTimeoutMs: 500, blankWaitMs: 300, protect: (u) => /(^|\.)whatsapp\.com/.test(new URL(u).hostname) });
    return { env, host, tab: (i: number) => env.tabs[i] as FakeTab };
  }
  type Reply = { reuse: string | null; navigation: { final: string } };

  it('opening another site while the chat app is in front uses a tab of its own; the chat\'s tab is untouched and still running', async () => {
    const { env, host, tab } = guarded();
    await host.request('open_url', { url: 'https://web.whatsapp.com/' });
    const chat = tab(0);
    const r = await host.request<Reply>('open_url', { url: 'https://news.example/today' });
    expect(env.tabs).toHaveLength(2);
    expect(chat.loads).toEqual(['https://web.whatsapp.com/']); // (not loaded again, not navigated away)
    expect(chat.closed).toBe(false);
    expect(tab(1).loads).toEqual(['https://news.example/today']);
    expect(r.navigation.final).toBe('https://news.example/today');
    expect(env.shown).toBe(tab(1)); // (the browser page shows the new one)
  });

  it('opening the chat app again shows its tab as it is: no load, no new tab — the chat that is open stays open', async () => {
    const { env, host, tab } = guarded();
    await host.request('open_url', { url: 'https://web.whatsapp.com/' });
    await host.request('open_url', { url: 'https://news.example/today' });
    const r = await host.request<Reply>('open_url', { url: 'https://web.whatsapp.com/' });
    expect(env.tabs).toHaveLength(2);
    expect(tab(0).loads).toEqual(['https://web.whatsapp.com/']);
    expect(r.reuse).toBe('focused');
    expect(env.shown).toBe(tab(0));
  });

  it('a try again after a failure (fresh) does load the chat app\'s tab again', async () => {
    const { host, tab } = guarded();
    await host.request('open_url', { url: 'https://web.whatsapp.com/' });
    await host.request('open_url', { url: 'https://web.whatsapp.com/', fresh: true });
    expect(tab(0).loads).toEqual(['https://web.whatsapp.com/', 'https://web.whatsapp.com/']);
  });

  it('a page that is not a chat app is reused as before: one tab for a task', async () => {
    const { env, host, tab } = guarded();
    await host.request('open_url', { url: 'https://a.example/' });
    await host.request('open_url', { url: 'https://b.example/' });
    expect(env.tabs).toHaveLength(1);
    expect(tab(0).loads).toEqual(['https://a.example/', 'https://b.example/']);
  });

  it('a step asked of the chat\'s own tab (by its number) goes to it even while another tab is in front', async () => {
    const { host, tab } = guarded();
    await host.request('open_url', { url: 'https://web.whatsapp.com/' });
    const chatTab = tab(0);
    await host.request('open_url', { url: 'https://news.example/today' });
    chatTab.onCommand = (command) => (command === 'waitQuiet' ? { settled: true } : command === 'observe' ? { url: chatTab.currentUrl } : { ok: true, command });
    const r = await host.request<{ tabId: number; command: string }>('chat_read', { max: 5, tabId: 1 });
    expect(r).toMatchObject({ tabId: 1, command: 'chatRead' });
    expect(tab(1).commands).not.toContain('chatRead');
  });

  it('without the guard (the usual tests, the look-up browser) nothing changes', async () => {
    const { env, host } = setup();
    await host.request('open_url', { url: 'https://web.whatsapp.com/' });
    await host.request('open_url', { url: 'https://news.example/' });
    expect(env.tabs).toHaveLength(1);
  });
});

describe('EmbeddedPageHost: a task of the Tasks page works in a tab of its own', () => {
  type Opened = OpenReply & { tabId: number };

  it('a task with no tab yet gets a new one, and says which; the page another task is on is left alone', async () => {
    const { host, env } = setup();
    const first = await host.request<Opened>('open_url', { url: 'https://one.example/', newTab: true });
    const second = await host.request<Opened>('open_url', { url: 'https://two.example/', newTab: true });
    expect(env.tabs).toHaveLength(2);
    expect(first.tabId).not.toBe(second.tabId);
    expect(env.tabs.map((t) => t.loads)).toEqual([['https://one.example/'], ['https://two.example/']]);
  });

  it('a task that has its tab goes on in it, whatever the other task did since', async () => {
    const { host, env } = setup();
    const a = await host.request<Opened>('open_url', { url: 'https://one.example/', newTab: true });
    const b = await host.request<Opened>('open_url', { url: 'https://two.example/', newTab: true });
    const a2 = await host.request<Opened>('open_url', { url: 'https://one.example/next', tabId: a.tabId });
    expect(a2.tabId).toBe(a.tabId);
    expect(env.tabs).toHaveLength(2);
    expect(env.tabs[0]?.loads).toEqual(['https://one.example/', 'https://one.example/next']);
    expect(env.tabs[1]?.loads).toEqual(['https://two.example/']);
    expect(b.tabId).not.toBe(a.tabId);
  });

  it('a task whose tab was closed gets a new one (it does not take over another task\'s page)', async () => {
    const { host, env } = setup();
    const a = await host.request<Opened>('open_url', { url: 'https://one.example/', newTab: true });
    await host.request<Opened>('open_url', { url: 'https://two.example/', newTab: true });
    env.tabs[0]?.close();
    const again = await host.request<Opened>('open_url', { url: 'https://one.example/back', tabId: a.tabId });
    expect(again.tabId).not.toBe(a.tabId);
    expect(env.tabs).toHaveLength(3);
    expect(env.tabs[1]?.loads).toEqual(['https://two.example/']);
  });

  it('a request with neither goes on in the current tab, as before', async () => {
    const { host, env } = setup();
    await host.request('open_url', { url: 'https://one.example/' });
    await host.request('open_url', { url: 'https://two.example/' });
    expect(env.tabs).toHaveLength(1);
  });
});
