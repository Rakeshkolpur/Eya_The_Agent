import { promises as fs } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import type { BrowserContext, Download, Page } from 'playwright-core';
import { rootLogger } from '@main/logging/logger';
// The very same page script the Eya Browser Bridge extension injects. Bundled as text so there is one implementation
// of "look at a page / click / type" for both browsers, not two that drift apart.
import pageAgentSource from '../../../eya-chrome-extension/injected.js?raw';
import { redactUrl } from './redactUrl';

const log = rootLogger.child('browser.playwright');

const NAV_TIMEOUT_MS = 20_000;
const AGENT_FUNCTION = pageAgentSource.replace(/^\s*export\s+async\s+function/m, 'async function');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type HostChannel = 'chrome' | 'msedge';

export interface PlaywrightHostOptions {
  /** Profile folder for Edge (kept as it always was, so earlier sign-ins survive); Chrome gets its own sibling folder. */
  readonly profileDir: string;
  /** Where files the browser downloads are saved. */
  readonly downloadsDir: string;
  /** Browsers to try, in order. The user's Chrome first. */
  readonly channels?: readonly HostChannel[];
  /** Normally the window is visible, so the user can see and step in; only tests run it without one. */
  readonly headless?: boolean;
}

interface RawDownload {
  downloadId: number;
  filename: string;
  state: 'complete' | 'interrupted' | 'in_progress';
  bytes: number;
  mime?: string;
  error?: string;
}

interface DownloadRecord {
  readonly at: number;
  readonly done: Promise<RawDownload>;
}

type Args = Readonly<Record<string, unknown>>;

/**
 * Eya's own browser window, speaking the same request language as the extension (open_url, observe, click, fill, back,
 * list_tabs, focus_tab, search_page) so that ONE service on top works identically in both. It is a visible, persistent
 * window with its own profile — not the user's everyday one — and it is handed exactly the same page script.
 */
export class PlaywrightPageHost {
  private context: BrowserContext | null = null;
  private channel: HostChannel | null = null;
  private current: Page | null = null;
  private nextId = 1;
  private readonly ids = new WeakMap<Page, number>();
  private readonly byId = new Map<number, Page>();
  private readonly throwaway = new Set<Page>();
  private readonly navigatedAt = new WeakMap<Page, number>();
  private readonly opened: Array<{ page: Page; at: number }> = [];
  private readonly downloads: DownloadRecord[] = [];
  private nextDownloadId = 1;
  // A native alert()/confirm()/prompt() blocks the whole page until answered. It is dismissed (never accepted: a
  // confirm's OK could do something irreversible) and reported in the next look, so the model finds out it happened.
  private lastNativeDialog: string | null = null;

  constructor(private readonly options: PlaywrightHostOptions) {}

  isConnected(): boolean {
    return true; // launches on demand
  }

  // ------------------------------------------------------------------ browser
  private async launch(): Promise<BrowserContext> {
    const channels = this.options.channels ?? (['chrome', 'msedge'] as const);
    let lastErr: unknown;
    for (const channel of channels) {
      try {
        const dir = channel === 'msedge' ? this.options.profileDir : `${this.options.profileDir}-${channel}`;
        const ctx = await chromium.launchPersistentContext(dir, {
          channel,
          headless: this.options.headless === true,
          viewport: { width: 1280, height: 900 },
          acceptDownloads: true,
        });
        log.info('browser launched', { channel });
        this.channel = channel;
        ctx.on('close', () => {
          if (this.context === ctx) {
            this.context = null;
            this.current = null;
            log.info('browser window was closed');
          }
        });
        ctx.on('page', (page) => this.adopt(page, true));
        for (const page of ctx.pages()) this.adopt(page, false);
        return ctx;
      } catch (err) {
        lastErr = err;
        log.warn('could not launch', { channel, err: String(err) });
      }
    }
    throw new Error(`could not launch Chrome or Edge for browser automation: ${String(lastErr)}`);
  }

  private adopt(page: Page, isNew: boolean): void {
    if (this.ids.has(page)) return;
    const id = this.nextId++;
    this.ids.set(page, id);
    this.byId.set(id, page);
    if (isNew && !this.throwaway.has(page)) this.opened.push({ page, at: Date.now() });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.navigatedAt.set(page, Date.now());
    });
    page.on('dialog', (dialog) => {
      this.lastNativeDialog = dialog.message();
      log.info('native browser dialog auto-dismissed', { type: dialog.type(), message: dialog.message() });
      void dialog.dismiss();
    });
    page.on('download', (download) => {
      this.downloads.push({ at: Date.now(), done: this.saveDownload(download) });
    });
    page.on('close', () => {
      this.byId.delete(id);
      if (this.current === page) this.current = [...this.byId.values()].filter((p) => !this.throwaway.has(p) && !p.isClosed()).at(-1) ?? null;
    });
  }

  private async ensurePage(): Promise<Page> {
    this.context ??= await this.launch();
    if (this.current !== null && !this.current.isClosed()) return this.current;
    const existing = this.context.pages().find((p) => !p.isClosed() && !this.throwaway.has(p));
    this.current = existing ?? (await this.context.newPage());
    return this.current;
  }

  private pageFor(tabId: unknown): Page {
    if (typeof tabId === 'number') {
      const p = this.byId.get(tabId);
      if (p !== undefined && !p.isClosed()) return p;
    }
    if (this.current === null || this.current.isClosed()) throw new Error('There is no browser tab to look at. Open a website first.');
    return this.current;
  }

  async close(): Promise<void> {
    const ctx = this.context;
    this.context = null;
    this.current = null;
    if (ctx !== null) await ctx.close().catch(() => undefined);
  }

  // -------------------------------------------------------------------- page
  /** Runs one command of the shared page script inside a page. */
  private async agent(page: Page, command: string, params: Args = {}): Promise<unknown> {
    return page.evaluate(`(${AGENT_FUNCTION})(${JSON.stringify(command)}, ${JSON.stringify(params)})`);
  }

  private navigatedSince(page: Page, since: number): boolean {
    return (this.navigatedAt.get(page) ?? 0) >= since;
  }

  private async observe(page: Page): Promise<Record<string, unknown>> {
    let state: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 3 && state === null; attempt++) {
      try {
        state = (await this.agent(page, 'observe')) as Record<string, unknown>;
      } catch (err) {
        // The page was replaced under us (a navigation finished): wait for the new one and look again.
        if (attempt === 2) throw err;
        await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
        await sleep(150);
      }
    }
    const result: Record<string, unknown> = { ...(state ?? {}) };
    const note = this.lastNativeDialog;
    this.lastNativeDialog = null; // reported once, in the very next look
    if (note !== null) {
      const dialogs = Array.isArray(result['dialogs']) ? (result['dialogs'] as unknown[]) : [];
      result['dialogs'] = [`(a browser popup appeared and was dismissed: "${note}")`, ...dialogs];
    }
    return result;
  }

  /** Wait until the page has finished loading AND stopped changing (the page script's own notion of quiet). */
  private async settle(page: Page, since: number): Promise<{ settled: boolean; busy?: boolean }> {
    await sleep(180); // a click that navigates starts a moment later
    if (this.navigatedSince(page, since)) {
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
      await page.waitForLoadState('load', { timeout: 8000 }).catch(() => undefined);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = (await this.agent(page, 'waitQuiet')) as { settled?: boolean; busy?: boolean };
        return { settled: r?.settled !== false, ...(r?.busy ? { busy: true } : {}) };
      } catch {
        await page.waitForLoadState('domcontentloaded', { timeout: 12_000 }).catch(() => undefined);
      }
    }
    return { settled: false };
  }

  private async saveDownload(download: Download): Promise<RawDownload> {
    const downloadId = this.nextDownloadId++;
    try {
      await fs.mkdir(this.options.downloadsDir, { recursive: true });
      const target = await this.uniquePath(join(this.options.downloadsDir, basename(download.suggestedFilename())));
      await download.saveAs(target);
      const failure = await download.failure();
      if (failure !== null) return { downloadId, filename: '', state: 'interrupted', bytes: -1, error: failure };
      const stat = await fs.stat(target);
      return { downloadId, filename: target, state: 'complete', bytes: stat.size };
    } catch (err) {
      return { downloadId, filename: '', state: 'interrupted', bytes: -1, error: String(err) };
    }
  }

  private async uniquePath(path: string): Promise<string> {
    const ext = extname(path);
    const stem = path.slice(0, path.length - ext.length);
    for (let n = 0; n < 1000; n++) {
      const candidate = n === 0 ? path : `${stem} (${n})${ext}`;
      try {
        await fs.access(candidate);
      } catch {
        return candidate;
      }
    }
    return `${stem}-${Date.now()}${ext}`;
  }

  private async awaitDownload(since: number): Promise<RawDownload | null> {
    const start = Date.now();
    let found = this.downloads.find((d) => d.at >= since);
    while (found === undefined && Date.now() - start < 2200) {
      await sleep(100);
      found = this.downloads.find((d) => d.at >= since);
    }
    if (found === undefined) return null;
    const result = await Promise.race([found.done, sleep(25_000).then((): RawDownload => ({ downloadId: 0, filename: '', state: 'in_progress', bytes: -1 }))]);
    return result;
  }

  /** Everything every action replies with: how it went, and the page as it is now. */
  private async reply(page: Page, performed: unknown, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return { performed, tabId: this.ids.get(page) ?? null, state: await this.observe(page), settled: true, ...extra };
  }

  /** After an action: wait for the page to settle, follow a tab it opened, wait for a download it started, look again. */
  private async afterAction(page: Page, performed: unknown, startedAt: number): Promise<Record<string, unknown>> {
    const settle = await this.settle(page, startedAt);
    let active = page;
    let newTab: { tabId: number; from: number } | null = null;
    for (const entry of [...this.opened].reverse()) {
      if (entry.at < startedAt || entry.page === page || entry.page.isClosed()) continue;
      await entry.page.waitForLoadState('domcontentloaded', { timeout: 12_000 }).catch(() => undefined);
      await this.settle(entry.page, startedAt);
      await entry.page.bringToFront().catch(() => undefined);
      this.current = entry.page;
      active = entry.page;
      newTab = { tabId: this.ids.get(entry.page) ?? 0, from: this.ids.get(page) ?? 0 };
      break;
    }
    const download = await this.awaitDownload(startedAt);
    return this.reply(active, performed, {
      settled: settle.settled,
      ...(settle.busy ? { stillBusy: true } : {}),
      ...(newTab !== null ? { newTab } : {}),
      ...(download !== null ? { download } : {}),
    });
  }

  private async act(page: Page, perform: () => Promise<unknown>): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    let performed: unknown;
    try {
      performed = await perform();
    } catch (err) {
      // A click that starts a navigation can tear the page down before its result comes back.
      await sleep(120);
      if (!this.navigatedSince(page, startedAt)) throw err;
      performed = { ok: true, navigated: true };
    }
    if ((performed as { ok?: boolean } | undefined)?.ok === false) return this.reply(page, performed);
    return this.afterAction(page, performed, startedAt);
  }

  // ------------------------------------------------------------------ requests
  async request<T = unknown>(op: string, args: Args = {}, _timeoutMs?: number): Promise<T> {
    void _timeoutMs;
    return (await this.dispatch(op, args)) as T;
  }

  private async dispatch(op: string, args: Args): Promise<unknown> {
    switch (op) {
      case 'ping':
        return { browser: this.channel ?? 'chrome', version: 'eya-window' };

      case 'open_url': {
        const url = String(args['url'] ?? '');
        const page = await this.ensurePage();
        const startedAt = Date.now();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        const settle = await this.settle(page, startedAt);
        return this.reply(page, { ok: true, opened: true }, { settled: settle.settled, ...(settle.busy ? { stillBusy: true } : {}), reuse: null });
      }

      case 'observe': {
        const page = this.pageFor(args['tabId']);
        return { tabId: this.ids.get(page) ?? null, state: await this.observe(page) };
      }

      case 'click': {
        const page = this.pageFor(args['tabId']);
        return this.act(page, () => this.agent(page, 'click', { id: args['id'], expectName: args['name'] }));
      }

      case 'fill': {
        const page = this.pageFor(args['tabId']);
        return this.act(page, async () => {
          const filled = (await this.agent(page, 'fill', { id: args['id'], expectName: args['name'], value: args['value'] })) as { ok?: boolean };
          if (filled?.ok && args['submit'] === true) {
            const pressed = (await this.agent(page, 'press', { id: args['id'], expectName: args['name'] })) as { ok?: boolean };
            return { ...filled, submitted: pressed?.ok === true };
          }
          return filled;
        });
      }

      case 'back': {
        const page = this.pageFor(args['tabId']);
        const startedAt = Date.now();
        const before = page.url();
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => null);
        await sleep(150);
        if (page.url() === before && !this.navigatedSince(page, startedAt)) {
          return this.reply(page, { ok: false, reason: 'no_history', detail: 'There is nothing to go back to in this tab.' });
        }
        return this.afterAction(page, { ok: true }, startedAt);
      }

      case 'forward': {
        const page = this.pageFor(args['tabId']);
        const startedAt = Date.now();
        const before = page.url();
        await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => null);
        await sleep(150);
        if (page.url() === before && !this.navigatedSince(page, startedAt)) {
          return this.reply(page, { ok: false, reason: 'no_history', detail: 'There is nothing to go forward to in this tab.' });
        }
        return this.afterAction(page, { ok: true }, startedAt);
      }

      case 'reload': {
        const page = this.pageFor(args['tabId']);
        const startedAt = Date.now();
        await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => null);
        return this.afterAction(page, { ok: true }, startedAt);
      }

      case 'scroll': {
        const page = this.pageFor(args['tabId']);
        return this.act(page, () => this.agent(page, 'scroll', { direction: args['direction'], amount: args['amount'] }));
      }

      case 'list_tabs': {
        const open = [...this.byId.entries()].filter(([, p]) => !p.isClosed() && !this.throwaway.has(p));
        return {
          tabs: await Promise.all(
            open.map(async ([tabId, p]) => ({
              tabId,
              title: (await p.title().catch(() => '')).slice(0, 90),
              url: redactUrl(p.url()),
              active: p === this.current,
              openedByEya: true,
              workingHere: p === this.current,
            })),
          ),
        };
      }

      case 'focus_tab': {
        const page = this.pageFor(args['tabId']);
        await page.bringToFront().catch(() => undefined);
        this.current = page;
        return this.reply(page, { ok: true });
      }

      case 'screenshot': {
        const page = this.pageFor(args['tabId']);
        const png = await page.screenshot({ type: 'png', timeout: 15_000 });
        return {
          tabId: this.ids.get(page) ?? null,
          url: redactUrl(page.url()),
          title: (await page.title().catch(() => '')).slice(0, 200),
          dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        };
      }

      case 'search_page': {
        this.context ??= await this.launch();
        const tab = await this.context.newPage();
        this.throwaway.add(tab);
        // The context announced this tab as "new" before it could be marked; it is not one Eya should follow.
        for (let i = this.opened.length - 1; i >= 0; i--) if (this.opened[i]?.page === tab) this.opened.splice(i, 1);
        try {
          // A results page can redirect once more after it first loads (which destroys the page context mid-read);
          // look again after it settles. A bot-check page simply yields no hits, and the caller tries the next engine.
          const lookup = async (): Promise<unknown> => {
            await tab.goto(String(args['url'] ?? ''), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                await this.agent(tab, 'waitQuiet', { minMs: 200, timeoutMs: 3000 });
                return (await this.agent(tab, 'extractSearch', { engine: args['engine'] })) ?? [];
              } catch {
                await tab.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => undefined);
              }
            }
            return [];
          };
          const hits = await Promise.race([lookup(), sleep(30_000).then(() => [])]);
          return { hits };
        } finally {
          await tab.close().catch(() => undefined);
          this.throwaway.delete(tab);
        }
      }

      default:
        throw new Error(`Unknown request: ${op}`);
    }
  }
}
