import { ChromeBrowserService } from '@main/chrome/ChromeBrowserService';
import type {
  ActOnPageResult,
  AdsMode,
  AdsState,
  BrowserAdHelper,
  BrowserAutomationService,
  BrowserCapture,
  ClickGate,
  FillOptions,
  FindOnPageResult,
  ReadPageResult,
  ScreenshotImage,
  ScrollDirection,
} from './BrowserAutomationService';
import { EmbeddedPageHost } from './EmbeddedPageHost';
import type { EmbeddedHostOptions } from './EmbeddedPageHost';
import type { PageSnapshot } from './pageSnapshot';
import type { WebSearchHit } from './webSearchResults';

/**
 * Eya Browser: Eya's own browser, drawn inside the Eya window by the Chromium that is already part of Eya (nothing to install, no other browser
 * needed). It has a profile of its own, so nothing in it starts signed in, and what the user signs in to stays for the next task. All the real
 * work is the same service and the same page script that drive the user's own browser through the extension; only the transport differs.
 */
export class EmbeddedBrowserService implements BrowserAutomationService, BrowserCapture, BrowserAdHelper {
  /** Its tabs: the Browser page shows them, watches their events and drives its address bar through this. */
  readonly host: EmbeddedPageHost;
  private readonly inner: ChromeBrowserService;

  constructor(options: EmbeddedHostOptions) {
    this.host = new EmbeddedPageHost(options);
    this.inner = new ChromeBrowserService(this.host, { environment: 'eya_browser' });
  }

  openWebsite(url: string): Promise<PageSnapshot> {
    return this.inner.openWebsite(url);
  }
  inspectPage(): Promise<PageSnapshot> {
    return this.inner.inspectPage();
  }
  findOnPage(query: string): Promise<FindOnPageResult> {
    return this.inner.findOnPage(query);
  }
  readPage(offset?: number): Promise<ReadPageResult> {
    return this.inner.readPage(offset);
  }
  clickOnPage(text: string, gate?: ClickGate): Promise<ActOnPageResult> {
    return this.inner.clickOnPage(text, gate);
  }
  fillOnPage(label: string, value: string, options?: FillOptions): Promise<ActOnPageResult> {
    return this.inner.fillOnPage(label, value, options);
  }
  goBack(): Promise<ActOnPageResult> {
    return this.inner.goBack();
  }
  goForward(): Promise<ActOnPageResult> {
    return this.inner.goForward();
  }
  reload(): Promise<ActOnPageResult> {
    return this.inner.reload();
  }
  scroll(direction: ScrollDirection, amount?: number): Promise<ActOnPageResult> {
    return this.inner.scroll(direction, amount);
  }
  searchWeb(query: string): Promise<WebSearchHit[]> {
    return this.inner.searchWeb(query);
  }
  ads(mode: AdsMode, options?: { readonly keepPlaying?: boolean; readonly play?: boolean }): Promise<AdsState> {
    return this.inner.ads(mode, options);
  }
  screenshot(): Promise<ScreenshotImage> {
    return this.inner.screenshot();
  }
  async close(): Promise<void> {
    await this.host.close();
  }
}
