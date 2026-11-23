/**
 * A stand-in for Eya Browser's Electron layer that drives a REAL Chromium page over its debugging protocol. Eya Browser is the same page script run inside a page by
 * `EmbeddedPageHost` (it evaluates the script with `tab.run(code)`, with no extension and no `chrome.runtime`); this gives the host real pages instead of fakes, so a
 * test can see the page script, the host's operations and the services on top of them work together in a real browser. What it does not cover is Electron itself
 * (WebContentsView, its sessions and window): that is the thin layer in ElectronBrowserEnvironment.
 */
import type { EmbeddedEnvironment, EmbeddedTab, TabEvent, ViewBounds } from '../../src/main/browser/EmbeddedPageHost';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

async function browserSocketUrl(port: number): Promise<string> {
  const version = (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json())) as { webSocketDebuggerUrl: string };
  return version.webSocketDebuggerUrl;
}

/** One request to the browser as a whole (a new page, closing one), on a socket of its own. */
async function browserCall<T = unknown>(port: number, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const socket = new WebSocket(await browserSocketUrl(port));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('debugging socket failed')));
  });
  const reply = await new Promise<{ result?: T; error?: { message?: string } }>((resolve) => {
    socket.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: T; error?: { message?: string } };
      if (m.id === 1) resolve(m);
    });
    socket.send(JSON.stringify({ id: 1, method, params }));
  });
  socket.close();
  if (reply.error !== undefined) throw new Error(`${method}: ${reply.error.message ?? 'failed'}`);
  return reply.result as T;
}

export class CdpTab implements EmbeddedTab {
  private ws!: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners: Array<(e: TabEvent) => void> = [];
  private readonly loadWaiters: Array<() => void> = [];
  private currentUrl = 'about:blank';
  private currentTitle = '';
  private closedFlag = false;
  private targetId = '';
  /** How many times an address was loaded in this tab (a page that was shown as it is has none). */
  loads: string[] = [];
  private readonly ready: Promise<void>;

  constructor(private readonly port: number) {
    this.ready = this.connect();
  }

  private async connect(): Promise<void> {
    const created = await browserCall<{ targetId: string }>(this.port, 'Target.createTarget', { url: 'about:blank' });
    this.targetId = created.targetId;
    const list = (await fetch(`http://127.0.0.1:${this.port}/json/list`).then((r) => r.json())) as Array<{ id: string; webSocketDebuggerUrl: string }>;
    const mine = list.find((t) => t.id === created.targetId);
    if (mine === undefined) throw new Error('the new page was not found');
    this.ws = new WebSocket(mine.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('page socket failed')));
    });
    this.ws.addEventListener('message', (e) => this.onMessage(String(e.data)));
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    // (Eya Browser's pages are set not to be throttled in the background: the stand-in asks for the same)
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
  }

  private onMessage(raw: string): void {
    const m = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown> };
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (p === undefined) return;
      this.pending.delete(m.id);
      if (m.error !== undefined) p.reject(new Error(m.error.message ?? 'failed'));
      else p.resolve(m.result);
      return;
    }
    const params = m.params ?? {};
    switch (m.method) {
      case 'Page.frameStartedLoading':
        this.emit({ type: 'navigated' });
        this.emit({ type: 'loading', loading: true });
        break;
      case 'Page.frameNavigated': {
        const frame = params['frame'] as { parentId?: string; url?: string } | undefined;
        if (frame !== undefined && frame.parentId === undefined && typeof frame.url === 'string') {
          this.currentUrl = frame.url;
          this.emit({ type: 'status', code: 200 });
        }
        break;
      }
      case 'Page.navigatedWithinDocument':
        if (typeof params['url'] === 'string') this.currentUrl = params['url'];
        this.emit({ type: 'title' });
        break;
      case 'Page.loadEventFired':
        this.emit({ type: 'loading', loading: false });
        for (const w of this.loadWaiters.splice(0)) w();
        break;
      case 'Runtime.consoleAPICalled': {
        const args = params['args'] as Array<{ value?: unknown }> | undefined;
        const text = typeof args?.[0]?.value === 'string' ? args[0].value : '';
        const chat = /^__EYA_CHAT_EVENT__ (\w{1,12}) (\d{1,6})/.exec(text);
        if (chat?.[1] !== undefined && chat[2] !== undefined) this.emit({ type: 'chat', reason: chat[1], rows: Number(chat[2]) });
        break;
      }
      case 'Inspector.targetCrashed':
        this.emit({ type: 'crashed' });
        break;
    }
  }

  private async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  emit(e: TabEvent): void {
    for (const l of this.listeners) l(e);
  }
  onEvent(listener: (e: TabEvent) => void): void {
    this.listeners.push(listener);
  }
  url(): string {
    return this.closedFlag ? '' : this.currentUrl;
  }
  title(): string {
    return this.currentTitle;
  }
  async load(url: string, timeoutMs: number): Promise<void> {
    await this.ready;
    this.loads.push(url);
    const loaded = new Promise<void>((resolve) => this.loadWaiters.push(resolve));
    const nav = await this.send<{ errorText?: string }>('Page.navigate', { url });
    if (nav.errorText !== undefined) throw new Error(nav.errorText);
    await Promise.race([loaded, sleep(timeoutMs).then(() => Promise.reject(new Error('ERR_TIMED_OUT (-7)')))]);
    this.currentTitle = String(await this.run('document.title').catch(() => ''));
  }
  async run(code: string): Promise<unknown> {
    await this.ready;
    const out = await this.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails !== undefined) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text ?? 'the page script failed');
    return out.result?.value;
  }
  stop(): void {
    void this.send('Page.stopLoading').catch(() => undefined);
  }
  reload(): void {
    this.emit({ type: 'navigated' });
    void this.send('Page.reload').catch(() => undefined);
  }
  back(): boolean {
    return false;
  }
  forward(): boolean {
    return false;
  }
  async screenshot(): Promise<Buffer> {
    const shot = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(shot.data, 'base64');
  }
  focus(): void {
    void this.send('Page.bringToFront').catch(() => undefined);
  }
  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.emit({ type: 'closed' });
    void browserCall(this.port, 'Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
    try {
      this.ws.close();
    } catch {
      // already gone
    }
  }
  isClosed(): boolean {
    return this.closedFlag;
  }
}

export class CdpEnv implements EmbeddedEnvironment {
  readonly tabs: CdpTab[] = [];
  shown: EmbeddedTab | null = null;
  constructor(private readonly port: number) {}
  createTab(): EmbeddedTab {
    const t = new CdpTab(this.port);
    this.tabs.push(t);
    return t;
  }
  createHiddenTab(): EmbeddedTab {
    return new CdpTab(this.port);
  }
  show(tab: EmbeddedTab | null): void {
    this.shown = tab;
  }
  setBounds(_bounds: ViewBounds | null): void {
    // (nothing is drawn: the tabs are pages of a browser nobody is looking at)
  }
  reveal(): void {
    // (no window to bring forward)
  }
}
