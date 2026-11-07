import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { WebContentsView, session } from 'electron';
import type { BrowserWindow, Session, WebContents } from 'electron';
import { rootLogger } from '@main/logging/logger';
import type { EmbeddedEnvironment, EmbeddedTab, RawDownload, TabEvent, ViewBounds } from './EmbeddedPageHost';

/** How long a download may stay interrupted before it is cancelled and reported as failed. */
const INTERRUPTED_GRACE_MS = 4000;

const log = rootLogger.child('browser.view');

/** Where a page nobody should see is parked: far outside the window, but still "shown" so it keeps painting and its timers keep running. */
const PARKED = { x: -30_000, y: -30_000 } as const;
const DEFAULT_SIZE = { width: 1100, height: 720 } as const;
/** A script that never comes back (the page was replaced while it ran) must not hold a task for ever. */
const RUN_TIMEOUT_MS = 30_000;

const WEB_PROTOCOL = /^https?:\/\//i;

/** The browser's name as sites see it: Chrome, not "Electron" or the app. A site that is told it is Electron may serve a broken page. */
function chromeUserAgent(ses: Session): string {
  return ses.getUserAgent().replace(/\s(?:Electron|eya)\/\S+/gi, '').replace(/\s+/g, ' ').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function uniqueSync(path: string): string {
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? path : `${stem} (${n})${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/** One tab: a WebContentsView of Eya's own Chromium. Everything the host needs from a page, nothing else. */
class ElectronTab implements EmbeddedTab {
  private readonly listeners: Array<(e: TabEvent) => void> = [];
  private closedFlag = false;
  private readonly wc: WebContents;

  constructor(
    readonly view: WebContentsView,
    private readonly env: ElectronBrowserEnvironment,
  ) {
    this.wc = view.webContents;
    this.wire();
  }

  emit(e: TabEvent): void {
    for (const l of this.listeners) l(e);
  }

  onEvent(listener: (e: TabEvent) => void): void {
    this.listeners.push(listener);
  }

  private wire(): void {
    const wc = this.wc;
    wc.setUserAgent(chromeUserAgent(wc.session));
    wc.setAudioMuted(true);
    wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) this.emit({ type: 'navigated' });
    });
    wc.on('dom-ready', () => log.debug('page ready', { frame: wc.mainFrame.url.slice(0, 40) }));
    wc.on('did-navigate', (_e, url, httpResponseCode) => {
      log.debug('page committed', { httpResponseCode, url: url.slice(0, 80) });
      if (httpResponseCode > 0) this.emit({ type: 'status', code: httpResponseCode });
    });
    wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => {
      if (isMainFrame) this.emit({ type: 'title' });
    });
    wc.on('did-start-loading', () => this.emit({ type: 'loading', loading: true }));
    wc.on('did-stop-loading', () => this.emit({ type: 'loading', loading: false }));
    wc.on('page-title-updated', () => this.emit({ type: 'title' }));
    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      log.debug('page failed to load', { errorCode, errorDescription, isMainFrame });
      if (isMainFrame && errorCode !== -3) this.emit({ type: 'failed', description: `${errorDescription} (${errorCode})`, url: validatedUrl });
    });
    wc.on('render-process-gone', (_e, details) => {
      log.warn('a page process is gone', { reason: details.reason });
      this.emit({ type: 'crashed' });
    });
    // A page may only go to a web address: never a file on this computer, a program, or a browser-internal page.
    const onlyWeb = (e: { preventDefault: () => void }, url: string): void => {
      if (!WEB_PROTOCOL.test(url) && url !== 'about:blank') {
        log.info('blocked a navigation that is not a web address', { scheme: url.split(':')[0] });
        e.preventDefault();
      }
    };
    wc.on('will-navigate', (e, url) => onlyWeb(e, url));
    wc.on('will-redirect', (e, url) => onlyWeb(e, url));
    // A page that opens a window (target=_blank, window.open) opens a new tab here, never a window of its own.
    wc.setWindowOpenHandler(({ url }) => {
      if (WEB_PROTOCOL.test(url)) {
        const child = this.env.openChild(url);
        if (child !== null) this.emit({ type: 'opened', tab: child });
      }
      return { action: 'deny' };
    });
    // A native alert/confirm/prompt is dismissed (never accepted: a confirm's OK could do something irreversible) and reported. Leaving a page
    // that asks "are you sure you want to leave" is allowed, since Eya only leaves a page on purpose.
    try {
      wc.debugger.attach('1.3');
      void wc.debugger.sendCommand('Page.enable').catch(() => undefined);
      wc.debugger.on('message', (_e, method, params: { type?: string; message?: string }) => {
        if (method !== 'Page.javascriptDialogOpening') return;
        const type = params.type ?? 'alert';
        void wc.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: type === 'beforeunload' }).catch(() => undefined);
        if (type !== 'beforeunload') this.emit({ type: 'dialog', message: String(params.message ?? '').slice(0, 200) });
      });
    } catch (err) {
      log.warn('page dialogs cannot be intercepted', { err: String(err) });
    }
    wc.once('destroyed', () => this.markClosed());
  }

  private markClosed(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.env.forget(this);
    this.emit({ type: 'closed' });
  }

  url(): string {
    return this.closedFlag ? '' : this.wc.getURL();
  }

  title(): string {
    return this.closedFlag ? '' : this.wc.getTitle();
  }

  isClosed(): boolean {
    return this.closedFlag || this.wc.isDestroyed();
  }

  /** Lets the page before this one finish announcing itself (a failed page is followed by the browser's error page, which loads a moment later). */
  private async untilIdle(maxMs: number): Promise<void> {
    const end = Date.now() + maxMs;
    while (!this.isClosed() && this.wc.isLoading() && Date.now() < end) await sleep(25);
    await sleep(25);
  }

  async load(url: string, timeoutMs: number): Promise<void> {
    if (!WEB_PROTOCOL.test(url)) throw new Error('ERR_BLOCKED_BY_CLIENT (-20): only web addresses (http or https) can be opened here');
    await this.untilIdle(1500);
    const wc = this.wc;
    return new Promise<void>((resolve, reject) => {
      let finished = false;
      let started = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        wc.off('did-start-navigation', onStart);
        wc.off('dom-ready', onReady);
        wc.off('did-fail-load', onFail);
        wc.off('render-process-gone', onGone);
      };
      const finish = (err?: Error): void => {
        if (finished) return;
        finished = true;
        cleanup();
        if (err !== undefined) reject(err);
        else resolve();
      };
      // Only what happens after THIS navigation began counts: the page before it (an error page the browser put up for the last failure, say)
      // may still be announcing that it is ready.
      const onStart = (_e: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
        if (isMainFrame && !isInPlace) started = true;
      };
      const onReady = (): void => {
        if (started) finish();
      };
      const onFail = (_e: unknown, code: number, description: string, _validated: string, isMainFrame: boolean): void => {
        if (isMainFrame && started) finish(new Error(`${description} (${code})`));
      };
      const onGone = (): void => finish(new Error('The page crashed'));
      const timer = setTimeout(() => {
        wc.stop();
        finish(new Error(`Timeout ${timeoutMs}ms exceeded`));
      }, timeoutMs);
      wc.on('did-start-navigation', onStart);
      wc.on('dom-ready', onReady);
      wc.on('did-fail-load', onFail);
      wc.on('render-process-gone', onGone);
      // (the promise loadURL returns settles when the page has finished loading, or fails; the events above are what is waited on)
      wc.loadURL(url).catch((err: unknown) => {
        const text = err instanceof Error ? err.message : String(err);
        // Navigations a page replaces itself (a redirect it makes) end the first one with ERR_ABORTED: only the host can tell if that is a problem.
        finish(new Error(text));
      });
    });
  }

  run(code: string): Promise<unknown> {
    if (this.isClosed()) return Promise.reject(new Error('Target closed'));
    return Promise.race([
      this.wc.executeJavaScript(code, true),
      sleep(RUN_TIMEOUT_MS).then(() => {
        throw new Error(`Timeout ${RUN_TIMEOUT_MS}ms exceeded`);
      }),
    ]);
  }

  stop(): void {
    if (!this.isClosed()) this.wc.stop();
  }

  reload(): void {
    if (!this.isClosed()) this.wc.reload();
  }

  back(): boolean {
    if (this.isClosed()) return false;
    const h = this.wc.navigationHistory;
    if (!h.canGoBack()) return false;
    h.goBack();
    return true;
  }

  forward(): boolean {
    if (this.isClosed()) return false;
    const h = this.wc.navigationHistory;
    if (!h.canGoForward()) return false;
    h.goForward();
    return true;
  }

  async screenshot(): Promise<Buffer> {
    const image = await this.wc.capturePage();
    if (image.isEmpty()) throw new Error('The page has not drawn anything to take a picture of yet.');
    return image.toPNG();
  }

  focus(): void {
    if (!this.isClosed()) this.wc.focus();
  }

  close(): void {
    if (this.isClosed()) {
      this.markClosed();
      return;
    }
    this.env.detach(this);
    try {
      this.wc.close({ waitForBeforeUnload: false });
    } catch {
      // already going
    }
    this.markClosed();
  }

  setAudio(on: boolean): void {
    if (!this.isClosed()) this.wc.setAudioMuted(!on);
  }
}

export interface ElectronEnvironmentOptions {
  /** The Eya window the browser is drawn in (null/destroyed: the tabs still work, they are just not on screen). */
  readonly getWindow: () => BrowserWindow | null;
  /** A profile name: "persist:…" keeps sign-ins between runs; a plain name lives only in memory. */
  readonly partition: string;
  /** Where downloaded files are saved. */
  readonly downloadsDir: string;
  /** Opens the Eya window on the Browser page. */
  readonly reveal: () => void;
  /** A browser nobody ever sees (for reading results pages): its tabs are never put on the window. */
  readonly hidden?: boolean;
}

/**
 * Eya Browser's tabs, as views of the Chromium that is already inside Eya: nothing else is installed or started. Tabs share one profile of their
 * own (kept between runs). The current tab is drawn on the Browser page, at the rectangle that page reports; while the page is not open it stays
 * parked outside the window, still alive.
 */
export class ElectronBrowserEnvironment implements EmbeddedEnvironment {
  private readonly ses: Session;
  private readonly tabs = new Set<ElectronTab>();
  private readonly byContents = new Map<number, ElectronTab>();
  private current: ElectronTab | null = null;
  private bounds: ViewBounds | null = null;
  private lastSize: { width: number; height: number } = DEFAULT_SIZE;
  private downloadSeq = 0;

  constructor(private readonly options: ElectronEnvironmentOptions) {
    this.ses = session.fromPartition(options.partition);
    this.ses.setUserAgent(chromeUserAgent(this.ses));
    // A page may not ask for the camera, microphone, location, notifications, or anything else: Eya Browser is for reading and filling pages.
    this.ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    this.ses.setPermissionCheckHandler(() => false);
    this.ses.on('will-download', (_e, item, wc) => {
      const tab = wc !== undefined ? this.byContents.get(wc.id) : undefined;
      if (options.hidden === true || tab === undefined) {
        item.cancel();
        return;
      }
      try {
        mkdirSync(options.downloadsDir, { recursive: true });
      } catch {
        // the save below fails and says so
      }
      const name = basename((item.getFilename() || 'download').replace(/[\\/:*?"<>|]+/g, '_'));
      const target = uniqueSync(join(options.downloadsDir, name));
      item.setSavePath(target);
      const downloadId = ++this.downloadSeq;
      const done = new Promise<RawDownload>((resolve) => {
        // A connection that drops half-way leaves the download "interrupted" for good without ever finishing it: resume once, then give it up.
        let resumed = false;
        let broken = false;
        let giveUp: ReturnType<typeof setTimeout> | null = null;
        item.on('updated', (_ev, state) => {
          if (state === 'progressing') {
            if (giveUp !== null) clearTimeout(giveUp);
            giveUp = null;
            return;
          }
          if (giveUp !== null) return;
          if (!resumed && item.canResume()) {
            resumed = true;
            item.resume();
          }
          giveUp = setTimeout(() => {
            broken = true;
            item.cancel();
          }, INTERRUPTED_GRACE_MS);
        });
        item.once('done', (_ev, state) => {
          if (giveUp !== null) clearTimeout(giveUp);
          if (state === 'completed') {
            let bytes = item.getReceivedBytes();
            try {
              bytes = statSync(target).size;
            } catch {
              // keep the received count
            }
            resolve({ downloadId, filename: target, state: 'complete', bytes, mime: item.getMimeType() });
          } else {
            resolve({ downloadId, filename: '', state: 'interrupted', bytes: -1, error: broken ? 'the connection was interrupted' : state });
          }
        });
      });
      tab.emit({ type: 'download', done });
    });
  }

  private makeView(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition: this.options.partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        // A page nobody is looking at at the moment still runs its timers: Eya works in it while the user is on another page of the app.
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    return view;
  }

  private build(): ElectronTab {
    const view = this.makeView();
    const tab = new ElectronTab(view, this);
    this.tabs.add(tab);
    this.byContents.set(view.webContents.id, tab);
    return tab;
  }

  private attach(tab: ElectronTab): void {
    const win = this.options.getWindow();
    if (this.options.hidden === true || win === null || win.isDestroyed()) return;
    tab.view.setBounds({ ...PARKED, ...this.lastSize });
    tab.view.setVisible(false);
    win.contentView.addChildView(tab.view);
  }

  /** A tab opened by a page (a link that opens in a new window). */
  openChild(url: string): ElectronTab | null {
    try {
      const tab = this.build();
      this.attach(tab);
      void tab.load(url, 30_000).catch(() => undefined);
      return tab;
    } catch (err) {
      log.warn('could not open a page that asked for a new window', { err: String(err) });
      return null;
    }
  }

  createTab(): EmbeddedTab {
    const tab = this.build();
    this.attach(tab);
    return tab;
  }

  /** A tab that is not on the window at all (a results page read in passing). */
  createHiddenTab(): EmbeddedTab {
    return this.build();
  }

  forget(tab: ElectronTab): void {
    this.tabs.delete(tab);
    for (const [id, t] of this.byContents) if (t === tab) this.byContents.delete(id);
    if (this.current === tab) this.current = null;
  }

  /** Takes a tab's view off the window (before it is closed). */
  detach(tab: ElectronTab): void {
    const win = this.options.getWindow();
    if (win === null || win.isDestroyed()) return;
    try {
      win.contentView.removeChildView(tab.view);
    } catch {
      // it was never on the window
    }
  }

  show(tab: EmbeddedTab | null): void {
    this.current = tab instanceof ElectronTab ? tab : null;
    this.layout();
  }

  setBounds(bounds: ViewBounds | null): void {
    this.bounds = bounds;
    if (bounds !== null && bounds.width > 20 && bounds.height > 20) this.lastSize = { width: Math.round(bounds.width), height: Math.round(bounds.height) };
    this.layout();
  }

  reveal(): void {
    this.options.reveal();
  }

  /** Puts every view where it belongs: the current one at the Browser page's rectangle (or parked), the others hidden. */
  private layout(): void {
    for (const tab of this.tabs) {
      if (tab.isClosed()) continue;
      if (tab === this.current) {
        const b = this.bounds;
        tab.view.setBounds(b !== null ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) } : { ...PARKED, ...this.lastSize });
        tab.view.setVisible(true);
        // Raised above the page's own controls: it was added after them, and a tab shown again goes back on top.
        const win = this.options.getWindow();
        if (b !== null && win !== null && !win.isDestroyed()) {
          try {
            win.contentView.addChildView(tab.view);
          } catch {
            // already there
          }
        }
        tab.setAudio(b !== null);
      } else {
        tab.view.setVisible(false);
        tab.setAudio(false);
      }
    }
  }

  /** Closes every tab (Eya is shutting down). */
  dispose(): void {
    for (const tab of [...this.tabs]) tab.close();
  }
}
