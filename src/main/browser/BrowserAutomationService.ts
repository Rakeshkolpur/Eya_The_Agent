import { chromium } from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';
import { rootLogger } from '@main/logging/logger';
import { buildSnapshot, findBestTextMatchIndex } from './pageSnapshot';
import type { PageSnapshot } from './pageSnapshot';
import type { ActionEffects, BrowserTabInfo } from './pageEffects';
import { SEARCH_ENGINE_URLS } from './searchEngines';
import { cleanSearchHits } from './webSearchResults';
import type { RawSearchHit, WebSearchHit } from './webSearchResults';

const log = rootLogger.child('browser.automation');

const NAV_TIMEOUT_MS = 20_000;
const SETTLE_TIMEOUT_MS = 5000;
const CLICK_TIMEOUT_MS = 10_000;

/** The control a click resolved to, as the user would read it. */
export interface ClickTarget {
  readonly name: string;
  readonly role: string;
}

/** Given what a click would hit, says why it needs the user's yes first — or null to go ahead. */
export type ClickGate = (target: ClickTarget) => string | null;

export interface FillOptions {
  /** Press Enter after typing (for search boxes that have no button). */
  readonly submit?: boolean;
}

export type ActOnPageResult =
  | { readonly ok: true; readonly snapshot: PageSnapshot; readonly effects?: ActionEffects }
  | { readonly ok: false; readonly reason: 'not_found'; readonly snapshot: PageSnapshot }
  /** The control is something the user must approve first (a purchase, a send, a delete…). Nothing was clicked. */
  | { readonly ok: false; readonly reason: 'needs_confirmation'; readonly why: string; readonly target: string; readonly snapshot: PageSnapshot }
  /** Only the user can do this part (a CAPTCHA, a verification code, a password field). Nothing was done. */
  | { readonly ok: false; readonly reason: 'needs_user'; readonly message: string; readonly snapshot: PageSnapshot }
  /** The page would not let it happen (something covering the control, a disabled button, an option that isn't there). */
  | { readonly ok: false; readonly reason: 'could_not'; readonly message: string; readonly snapshot: PageSnapshot };

/**
 * The thing Eya browses with. Two implementations sit behind this: the user's
 * own signed-in browser (through the Eya Browser Bridge extension) and a
 * separate Playwright-driven window of Eya's own. Both work from the live page
 * — look, pick something that is really there, act, look again.
 */
export interface BrowserAutomationService {
  openWebsite(url: string): Promise<PageSnapshot>;
  inspectPage(): Promise<PageSnapshot>;
  clickOnPage(text: string, gate?: ClickGate): Promise<ActOnPageResult>;
  fillOnPage(label: string, value: string, options?: FillOptions): Promise<ActOnPageResult>;
  goBack(): Promise<ActOnPageResult>;
  /** A web search read from a real results page in a throwaway tab — never touches the page currently open. */
  searchWeb(query: string): Promise<WebSearchHit[]>;
  close(): Promise<void>;
}

/** Seeing and choosing between the user's own browser tabs — only possible through the user's real browser. */
export interface BrowserTabControl {
  listTabs(): Promise<BrowserTabInfo[]>;
  switchToTab(tabId: number): Promise<PageSnapshot>;
}

// Tried in order: DuckDuckGo's plain-HTML page first (simple, stable markup,
// real destination in the link), Bing as the backup if that comes back empty
// or gets challenged. Both selectors were confirmed against the live pages.
interface SearchEngine {
  readonly name: string;
  url(query: string): string;
  extract(): RawSearchHit[];
}

const ENGINE_URL = (name: string) => {
  const found = SEARCH_ENGINE_URLS.find((e) => e.name === name);
  if (found === undefined) throw new Error(`unknown search engine ${name}`);
  return (q: string) => found.url(q);
};

const SEARCH_ENGINES: readonly SearchEngine[] = [
  {
    name: 'duckduckgo',
    url: ENGINE_URL('duckduckgo'),
    extract: () =>
      Array.from(document.querySelectorAll('.result')).map((r) => ({
        title: r.querySelector('a.result__a')?.textContent,
        href: r.querySelector('a.result__a')?.getAttribute('href'),
        snippet: r.querySelector('.result__snippet')?.textContent,
      })),
  },
  {
    name: 'bing',
    url: ENGINE_URL('bing'),
    extract: () =>
      Array.from(document.querySelectorAll('li.b_algo')).map((li) => ({
        title: li.querySelector('h2 a')?.textContent,
        href: li.querySelector('h2 a')?.getAttribute('href'),
        snippet: li.querySelector('.b_caption p, p')?.textContent,
      })),
  },
];

/** Visible on-page modal/alert boxes — a login prompt, a cookie banner, a warning — as opposed to a native browser dialog (see `lastNativeDialog`, which these never cover). */
async function collectDialogTexts(page: Page): Promise<string[]> {
  return page
    .locator('[role="dialog"]:visible, [role="alertdialog"]:visible, dialog[open]:visible')
    .allTextContents()
    .catch(() => []);
}

/** Everything a visible, interactive, labelled form control exposes to a user looking at the page. */
async function collectInputLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const els = document.querySelectorAll('input, textarea, select');
    els.forEach((el) => {
      const e = el as HTMLInputElement;
      if (e.type === 'hidden') return;
      const style = window.getComputedStyle(e);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const rect = e.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      let label = e.getAttribute('aria-label') ?? '';
      if (label === '' && e.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(e.id)}"]`);
        if (lab !== null) label = lab.textContent?.trim() ?? '';
      }
      if (label === '') label = e.getAttribute('placeholder') ?? '';
      if (label === '') label = e.getAttribute('name') ?? '';
      if (label !== '') out.push(label);
    });
    return out;
  });
}

export class PlaywrightBrowserService implements BrowserAutomationService {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  // A native alert()/confirm()/prompt() is modal at the OS/browser level and
  // would otherwise hang every subsequent Playwright call on this page
  // forever — there is no "leave it open and ask the user" option the way
  // there is for an on-page (DOM) dialog. Auto-dismissed (never accepted: a
  // confirm() OK could trigger something irreversible) and surfaced in the
  // next snapshot instead, so the model at least finds out it happened.
  private lastNativeDialog: string | null = null;

  constructor(private readonly profileDir: string) {}

  private async launchContext(): Promise<BrowserContext> {
    // Edge first (this is the vast majority of real Windows machines' actual
    // default browser), Chrome as the fallback — never Playwright's own
    // bundled Chromium, so this reuses a browser the user actually trusts
    // and already has, not an extra download.
    const channels: Array<'msedge' | 'chrome'> = ['msedge', 'chrome'];
    let lastErr: unknown;
    for (const channel of channels) {
      try {
        const ctx = await chromium.launchPersistentContext(this.profileDir, {
          channel,
          headless: false,
          viewport: { width: 1280, height: 900 },
        });
        log.info('browser automation launched', { channel });
        // The user can close this window themselves. Forget the dead context,
        // so the next website action opens a fresh window instead of failing
        // on the old one until Eya is restarted.
        ctx.on('close', () => {
          if (this.context === ctx) {
            this.context = null;
            this.page = null;
            log.info('browser automation window was closed');
          }
        });
        return ctx;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`could not launch Edge or Chrome for browser automation: ${String(lastErr)}`);
  }

  private async ensurePage(): Promise<Page> {
    if (this.page !== null && !this.page.isClosed()) return this.page;
    this.context ??= await this.launchContext();
    const pages = this.context.pages();
    this.page = pages[0] ?? (await this.context.newPage());
    this.page.on('dialog', (dialog) => {
      this.lastNativeDialog = dialog.message();
      log.info('native browser dialog auto-dismissed', { type: dialog.type(), message: dialog.message() });
      void dialog.dismiss();
    });
    return this.page;
  }

  private currentPageOrThrow(): Page {
    if (this.page === null || this.page.isClosed()) {
      throw new Error('no website is open yet');
    }
    return this.page;
  }

  private async settle(page: Page): Promise<void> {
    await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined);
  }

  private async snapshot(page: Page): Promise<PageSnapshot> {
    const [title, headings, links, buttonTexts, inputButtonValues, inputs, domDialogs] = await Promise.all([
      page.title(),
      page.locator('h1:visible, h2:visible, h3:visible').allTextContents(),
      page.locator('a:visible').allTextContents(),
      page.locator('button:visible, [role="button"]:visible').allTextContents(),
      page
        .locator('input[type="submit"]:visible, input[type="button"]:visible')
        .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value ?? '')),
      collectInputLabels(page),
      collectDialogTexts(page),
    ]);
    const nativeDialog = this.lastNativeDialog;
    this.lastNativeDialog = null; // report it once, in the very next snapshot, then stop
    const dialogs = nativeDialog === null ? domDialogs : [`(a browser popup appeared and was dismissed: "${nativeDialog}")`, ...domDialogs];
    return buildSnapshot(page.url(), title, headings, links, [...buttonTexts, ...inputButtonValues], inputs, dialogs);
  }

  async openWebsite(url: string): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await this.settle(page);
    return this.snapshot(page);
  }

  async inspectPage(): Promise<PageSnapshot> {
    return this.snapshot(this.currentPageOrThrow());
  }

  async clickOnPage(text: string, gate?: ClickGate): Promise<ActOnPageResult> {
    const page = this.currentPageOrThrow();
    // Each candidate pool keeps its own locator, so a match is re-selected by
    // INDEX on that exact same locator (`.nth(i)`) rather than re-queried by
    // name — see findBestTextMatchIndex's own comment for why a name re-query
    // is unreliable against a real page's markup.
    const linksLocator = page.locator('a:visible');
    const buttonsLocator = page.locator('button:visible, [role="button"]:visible');
    const inputButtonsLocator = page.locator('input[type="submit"]:visible, input[type="button"]:visible');
    const [linkTexts, buttonTexts, inputButtonValues] = await Promise.all([
      linksLocator.allTextContents(),
      buttonsLocator.allTextContents(),
      inputButtonsLocator.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value ?? '')),
    ]);

    let target = null as ReturnType<typeof linksLocator.nth> | null;
    let matched: ClickTarget | null = null;
    const linkIndex = findBestTextMatchIndex(text, linkTexts);
    if (linkIndex !== null) {
      target = linksLocator.nth(linkIndex);
      matched = { name: linkTexts[linkIndex] ?? text, role: 'link' };
    } else {
      const buttonIndex = findBestTextMatchIndex(text, buttonTexts);
      if (buttonIndex !== null) {
        target = buttonsLocator.nth(buttonIndex);
        matched = { name: buttonTexts[buttonIndex] ?? text, role: 'button' };
      } else {
        const inputIndex = findBestTextMatchIndex(text, inputButtonValues);
        if (inputIndex !== null) {
          target = inputButtonsLocator.nth(inputIndex);
          matched = { name: inputButtonValues[inputIndex] ?? text, role: 'button' };
        }
      }
    }
    if (target === null || matched === null) {
      return { ok: false, reason: 'not_found', snapshot: await this.snapshot(page) };
    }
    const cleanName = matched.name.replace(/\s+/g, ' ').trim();
    const why = gate?.({ name: cleanName, role: matched.role }) ?? null;
    if (why !== null) {
      return { ok: false, reason: 'needs_confirmation', why, target: cleanName, snapshot: await this.snapshot(page) };
    }
    await target.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => undefined);
    await target.click({ timeout: CLICK_TIMEOUT_MS });
    await this.settle(page);
    return { ok: true, snapshot: await this.snapshot(page) };
  }

  async goBack(): Promise<ActOnPageResult> {
    const page = this.currentPageOrThrow();
    const response = await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => null);
    await this.settle(page);
    const snapshot = await this.snapshot(page);
    if (response === null) return { ok: false, reason: 'could_not', message: 'There is nothing to go back to in this window.', snapshot };
    return { ok: true, snapshot };
  }

  async fillOnPage(label: string, value: string, options: FillOptions = {}): Promise<ActOnPageResult> {
    const page = this.currentPageOrThrow();
    const byLabel = page.getByLabel(label, { exact: false });
    const byPlaceholder = page.getByPlaceholder(label, { exact: false });
    const target = (await byLabel.count()) > 0 ? byLabel.first() : (await byPlaceholder.count()) > 0 ? byPlaceholder.first() : null;
    if (target === null) {
      return { ok: false, reason: 'not_found', snapshot: await this.snapshot(page) };
    }
    const tag = await target.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'select') {
      await target.selectOption({ label: value }).catch(() => target.selectOption(value));
    } else {
      const type = ((await target.getAttribute('type')) ?? '').toLowerCase();
      if (type === 'password') {
        return {
          ok: false,
          reason: 'needs_user',
          message: 'That is a password field. Eya never types passwords — the user has to enter it themselves.',
          snapshot: await this.snapshot(page),
        };
      }
      await target.fill(value);
      if (options.submit === true) {
        await target.press('Enter');
        await this.settle(page);
      }
    }
    return { ok: true, snapshot: await this.snapshot(page) };
  }

  async searchWeb(query: string): Promise<WebSearchHit[]> {
    this.context ??= await this.launchContext();
    // A throwaway tab, closed afterwards: searching must never navigate away
    // from (or steal the "current page" of) whatever site is open for the user.
    const tab = await this.context.newPage();
    try {
      for (const engine of SEARCH_ENGINES) {
        try {
          await tab.goto(engine.url(query), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
          await this.settle(tab);
          const hits = cleanSearchHits(await tab.evaluate(engine.extract));
          log.info('browser web search', { engine: engine.name, hits: hits.length });
          if (hits.length > 0) return hits;
        } catch (err) {
          log.warn('browser web search engine failed', { engine: engine.name, err: String(err) });
        }
      }
      return [];
    } finally {
      await tab.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.context !== null) {
      await this.context.close().catch(() => undefined);
      this.context = null;
      this.page = null;
    }
  }
}
