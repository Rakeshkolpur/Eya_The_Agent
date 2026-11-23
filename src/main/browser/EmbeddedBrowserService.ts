import { ChromeBrowserService } from '@main/chrome/ChromeBrowserService';
import type {
  ActOnPageResult,
  AdsMode,
  AdsState,
  AttachFileRequest,
  AttachFileResult,
  BrowserAdHelper,
  BrowserAutomationService,
  BrowserCapture,
  BrowserChatLive,
  BrowserFileAttach,
  BrowserItemClicker,
  BrowserItemLister,
  BrowserKeyPress,
  ChatDeleteResult,
  ChatMediaResult,
  ChatReadResult,
  ChatWatchResult,
  ClickGate,
  FillOptions,
  FindOnPageResult,
  OpenWebsiteOptions,
  PageItem,
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
export interface EmbeddedServiceOptions extends EmbeddedHostOptions {
  /** Whether an address is a chat app (those pages never go quiet and download nothing: a step on one only waits a moment). */
  readonly quickFor?: (url: string) => boolean;
}

export class EmbeddedBrowserService implements BrowserAutomationService, BrowserCapture, BrowserAdHelper, BrowserItemLister, BrowserItemClicker, BrowserKeyPress, BrowserFileAttach, BrowserChatLive {
  /** Its tabs: the Browser page shows them, watches their events and drives its address bar through this. */
  readonly host: EmbeddedPageHost;
  private readonly inner: ChromeBrowserService;

  constructor(options: EmbeddedServiceOptions) {
    this.host = new EmbeddedPageHost(options);
    // ('other': what a live chat in Eya Browser is told it is in — neither Chrome nor Edge)
    this.inner = new ChromeBrowserService(this.host, { environment: 'eya_browser', browserName: 'other', ...(options.quickFor !== undefined ? { quickFor: options.quickFor } : {}) });
  }

  openWebsite(url: string, options?: OpenWebsiteOptions): Promise<PageSnapshot> {
    return this.inner.openWebsite(url, options);
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
  // ---- what a chat app needs on top (WhatsApp Web works here as it does in the user's own browser: the same service, the same page script)
  listItems(): Promise<PageItem[]> {
    return this.inner.listItems();
  }
  clickItem(want: { readonly primary?: string; readonly name?: string; readonly region?: string; readonly role?: string }, gate?: ClickGate): Promise<ActOnPageResult> {
    return this.inner.clickItem(want, gate);
  }
  pressEscape(): ReturnType<BrowserKeyPress['pressEscape']> {
    return this.inner.pressEscape();
  }
  attachFile(request: AttachFileRequest): Promise<AttachFileResult> {
    return this.inner.attachFile(request);
  }
  chatWatch(mode: 'start' | 'stop' | 'status', tabId?: number): Promise<ChatWatchResult> {
    return this.inner.chatWatch(mode, tabId);
  }
  chatRead(max?: number, tabId?: number): Promise<ChatReadResult> {
    return this.inner.chatRead(max, tabId);
  }
  chatMedia(messageId: string, step: 'look' | 'download', tabId?: number): Promise<ChatMediaResult> {
    return this.inner.chatMedia(messageId, step, tabId);
  }
  chatDelete(messageId: string, scope: 'me' | 'everyone', tabId?: number): Promise<ChatDeleteResult> {
    return this.inner.chatDelete(messageId, scope, tabId);
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
