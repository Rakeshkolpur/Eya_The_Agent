import type { BrowserEnvironment, PageSnapshot, SnapshotTable } from './pageSnapshot';
import type { ActionEffects, BrowserTabInfo } from './pageEffects';
import type { WebSearchHit } from './webSearchResults';

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

export interface FindOnPageResult {
  readonly url: string;
  readonly title: string;
  readonly query: string;
  readonly matches: readonly { readonly name: string; readonly role: string; readonly where: string; readonly href?: string }[];
  readonly textMatches: readonly string[];
  readonly totalControls: number;
}

export interface ReadPageResult {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly offset: number;
  /** Where to continue reading from, or null when that was the end of the page. */
  readonly nextOffset: number | null;
  readonly totalChars: number;
  /** The page's tables (first rows), included with the first slice only. */
  readonly tables?: readonly SnapshotTable[];
}

/**
 * The thing Eya browses with. Two instances sit behind this: the user's own signed-in browser (through the Eya
 * Browser Bridge extension) and a separate window of Eya's own (Playwright). Both run the same page script and the same
 * service on top of it — look, pick something that is really there, act, look again.
 */
export interface OpenWebsiteOptions {
  /**
   * Use Eya's own separate browser window instead of the user's browser. Only ever for a task the user has agreed to
   * run that way: it starts signed out of everything, and is never chosen silently.
   */
  readonly isolated?: boolean;
  /** Open it in this browser (the user named one: "in Edge"), instead of choosing by where their session is. */
  readonly browser?: 'chrome' | 'edge';
}

export type ScrollDirection = 'up' | 'down' | 'top' | 'bottom';

export interface BrowserAutomationService {
  openWebsite(url: string, options?: OpenWebsiteOptions): Promise<PageSnapshot>;
  inspectPage(): Promise<PageSnapshot>;
  /** Searches the WHOLE page (showing, further down, closed menus, its text) for something, instead of only the first screenful. */
  findOnPage(query: string): Promise<FindOnPageResult>;
  /** Reads the page's text in slices, so a long page can be read through. */
  readPage(offset?: number): Promise<ReadPageResult>;
  clickOnPage(text: string, gate?: ClickGate): Promise<ActOnPageResult>;
  fillOnPage(label: string, value: string, options?: FillOptions): Promise<ActOnPageResult>;
  goBack(): Promise<ActOnPageResult>;
  goForward(): Promise<ActOnPageResult>;
  reload(): Promise<ActOnPageResult>;
  /** Scrolls the page (or the panel it scrolls inside) and reports what is showing afterwards. */
  scroll(direction: ScrollDirection, amount?: number): Promise<ActOnPageResult>;
  /** A web search read from a real results page in a throwaway tab — never touches the page currently open. */
  searchWeb(query: string): Promise<WebSearchHit[]>;
  close(): Promise<void>;
}

/** A picture of what a browser tab is showing right now. Never sent to the AI model: it is only ever saved for the user. */
export interface ScreenshotImage {
  readonly bytes: Buffer;
  readonly mime: 'image/png' | 'image/jpeg';
  readonly width?: number;
  readonly height?: number;
  /** The page's address (credential-looking query parts stripped) and title, for naming the file and telling the user. */
  readonly url: string;
  readonly title: string;
  /** Whose browser it came from. */
  readonly environment: BrowserEnvironment;
  readonly browser?: 'chrome' | 'edge' | 'other';
}

/** Taking a picture of the web page that is open — the one the user is looking at. */
export interface BrowserCapture {
  screenshot(): Promise<ScreenshotImage>;
}

/** Seeing and choosing between the user's own browser tabs — only possible through the user's real browser. */
export interface BrowserTabControl {
  /** Every tab in every connected browser (or just one browser's). */
  listTabs(browser?: 'chrome' | 'edge' | 'other'): Promise<BrowserTabInfo[]>;
  /** Tab numbers repeat across browsers, so name the browser when more than one is connected. */
  switchToTab(tabId: number, browser?: 'chrome' | 'edge' | 'other'): Promise<PageSnapshot>;
  /**
   * Closes a tab. By default only one Eya opened herself; closing one of the user's needs `allowUserTab`, which the
   * tool only passes after the user has said yes.
   */
  closeTab(tabId: number, options?: { readonly browser?: 'chrome' | 'edge' | 'other'; readonly allowUserTab?: boolean }): Promise<{ readonly closed: boolean; readonly remainingTabs: number }>;
}

/** One thing on the page that can be clicked, as seen by Eya's own code (never handed to the model as a list). */
export interface PageItem {
  /** The row's whole text. */
  readonly name: string;
  /** For a list row (a chat, a search result), its first line — what a person calls it. */
  readonly primary?: string;
  readonly role: string;
  readonly region?: string;
}

/** Listing what is clickable on the current page, for Eya's own code to choose from (e.g. matching a contact name locally). */
export interface BrowserItemLister {
  listItems(): Promise<PageItem[]>;
}

export interface AttachFileRequest {
  /** The file's name only — never its folder. */
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  /** Reads `length` bytes of the file from `offset`. */
  readonly read: (offset: number, length: number) => Promise<Buffer>;
  /** As a document (any file) or as media (a photo or video); auto picks the file picker made for this kind of file. */
  readonly prefer?: 'auto' | 'document' | 'media';
}

export type AttachFileResult =
  | { readonly ok: true; readonly snapshot: PageSnapshot }
  | { readonly ok: false; readonly reason: 'no_file_input' | 'type_not_accepted' | 'failed'; readonly message: string; readonly snapshot?: PageSnapshot };

/**
 * Putting a file on the open page's own file picker (so a chat app shows its preview). Nothing is sent: the page waits
 * for the user's Send.
 */
export interface BrowserFileAttach {
  attachFile(request: AttachFileRequest): Promise<AttachFileResult>;
}
