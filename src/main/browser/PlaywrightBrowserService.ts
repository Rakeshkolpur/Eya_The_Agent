import { ChromeBrowserService } from '@main/chrome/ChromeBrowserService';
import type {
  ActOnPageResult,
  BrowserAutomationService,
  ClickGate,
  FillOptions,
  FindOnPageResult,
  ReadPageResult,
  ScrollDirection,
} from './BrowserAutomationService';
import { PlaywrightPageHost } from './PlaywrightPageHost';
import type { PlaywrightHostOptions } from './PlaywrightPageHost';
import type { PageSnapshot } from './pageSnapshot';
import type { WebSearchHit } from './webSearchResults';

/**
 * Eya's own browser window: a visible, persistent Chrome (Edge as the backup) with a profile of its own — not the
 * user's everyday one, so nothing in it starts signed in. All the real work is the same service and the same page
 * script that drive the user's own browser through the extension; only the transport differs.
 */
export class PlaywrightBrowserService implements BrowserAutomationService {
  private readonly host: PlaywrightPageHost;
  private readonly inner: ChromeBrowserService;

  constructor(options: PlaywrightHostOptions) {
    this.host = new PlaywrightPageHost(options);
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
  async close(): Promise<void> {
    await this.host.close();
  }
}
