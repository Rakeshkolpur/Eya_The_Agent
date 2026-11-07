import type { BrowserEnvironment, PageSnapshot, SnapshotTable } from './pageSnapshot';
import type { ActionEffects, BrowserTabInfo, DownloadInfo } from './pageEffects';
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
  /** The value is a one-time verification code the user said out loud: it may be typed into a one-time-code field (never a password or card). */
  readonly allowCode?: boolean;
}

export type ActOnPageResult =
  | { readonly ok: true; readonly snapshot: PageSnapshot; readonly effects?: ActionEffects; /** A one-time verification code the user said was typed into a code field. */ readonly codeEntered?: boolean }
  | { readonly ok: false; readonly reason: 'not_found'; readonly snapshot: PageSnapshot }
  /** The same button is on the page for several items and the request did not say which. Nothing was clicked. */
  | { readonly ok: false; readonly reason: 'ambiguous'; readonly name: string; readonly options: readonly string[]; readonly snapshot: PageSnapshot }
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
  /**
   * Load the address again even if a tab is already showing exactly it. For trying a page again after it failed (a 503, a blank page): without it the
   * tab showing the error was only brought to the front, and the retry saw the same error again.
   */
  readonly fresh?: boolean;
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

/** What the adverts on the open page are doing (YouTube's skippable adverts and its overlay adverts). */
export interface AdsState {
  readonly onYouTube: boolean;
  readonly title: string;
  /** An advert is playing right now. */
  readonly adShowing: boolean;
  /** An advert is playing that offers no Skip button (yet): Eya waits through it. */
  readonly waitingForAd: boolean;
  /** How many Skip buttons have been pressed, and overlay adverts closed, since the helper was started on this page. */
  readonly skipped: number;
  readonly closed: number;
  /** The helper keeps checking by itself (until the page goes away or it is stopped). */
  readonly watching: boolean;
  readonly video: { readonly paused: boolean; readonly ended: boolean; readonly seconds: number; readonly length: number | null } | null;
}

export type AdsMode = 'once' | 'watch' | 'stop';

/** Pressing a page's own Skip / close buttons on adverts (only in the user's own browser, with the Eya extension 0.7.0 or later). */
export interface BrowserAdHelper {
  ads(mode: AdsMode, options?: { readonly keepPlaying?: boolean; readonly play?: boolean }): Promise<AdsState>;
}

/** One thing on the page that can be clicked, as seen by Eya's own code (never handed to the model as a list). */
export interface PageItem {
  /** The row's whole text. */
  readonly name: string;
  /** For a list row (a chat, a search result), its first line — what a person calls it. */
  readonly primary?: string;
  readonly role: string;
  readonly region?: string;
  /** For a tick box: whether it is ticked (a chat picker's rows). */
  readonly checked?: boolean;
}

/** Listing what is clickable on the current page, for Eya's own code to choose from (e.g. matching a contact name locally). */
export interface BrowserItemLister {
  listItems(): Promise<PageItem[]>;
}

/**
 * Opening one row of a list (a chat, a search result) by what it IS — its first line — looked up in the page as it is at the moment of the click.
 * Clicking by the row's whole text (name, last message, time, unread count) needed every word of it to be unchanged between the listing and the
 * click, and a chat row changes whenever a message arrives or the minute turns: the chat was found and then "could not be opened".
 */
export interface BrowserItemClicker {
  /** `region`: only a row in that part of the page ("dialog": the rows of an open popup, never the list behind it). */
  clickItem(want: { readonly primary?: string; readonly name?: string; readonly region?: string; readonly role?: string }, gate?: ClickGate): Promise<ActOnPageResult>;
}

/**
 * Pressing the Escape key, and no other (it closes the open chat or popup, as a person's keyboard does). Only in the user's own browser, with an
 * extension that offers it (`press_key`).
 */
export interface BrowserKeyPress {
  pressEscape(): Promise<{ readonly ok: true; readonly snapshot: PageSnapshot } | { readonly ok: false; readonly message: string }>;
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

/** One message of the OPEN chat, as the page shows it. `id` is the page's own message id; `text` is empty for a sticker, a voice note and the like. */
export interface LiveChatMessage {
  readonly id: string;
  /** `out`: sent by the account itself (by the user, or by Eya for them). `in`: received. */
  readonly dir: 'in' | 'out';
  readonly kind: 'text' | 'deleted' | 'sticker' | 'audio' | 'video' | 'image' | 'document' | 'other';
  readonly text: string;
  /** The time the page printed for it ("10:42, 27/10/2026"), or empty. */
  readonly at: string;
}

export type ChatLiveFailure = { readonly ok: false; readonly reason: 'extension_old' | 'unsupported'; readonly message: string };

export type ChatWatchResult =
  | { readonly ok: true; readonly watching: boolean; readonly tabId: number | null; readonly browser?: 'chrome' | 'edge' | 'other'; readonly hasMain?: boolean; readonly rows?: number; readonly title?: string }
  | ChatLiveFailure;

export type ChatReadResult =
  | {
      readonly ok: true;
      readonly tabId: number | null;
      readonly browser?: 'chrome' | 'edge' | 'other';
      /** A chat is open on the page. */
      readonly hasMain: boolean;
      /** The open chat's title as the page shows it (a name, or a number). */
      readonly title: string;
      readonly messages: readonly LiveChatMessage[];
      /** False when the page has message rows this reader does not recognise (so "no messages" cannot be told from "cannot read them"). */
      readonly reliable: boolean;
      /** How many message rows the reader recognised and how many it did not: counts only, never a word of the chat (for saying WHY a page was called unreadable). */
      readonly diagnostics?: { readonly rows: number; readonly otherRows: number; readonly messageLike: number; readonly how?: string; readonly unknownSide?: number; readonly sides?: Readonly<Record<string, number>>; readonly shape?: string };
    }
  | ChatLiveFailure;

/**
 * Live chat: a watcher inside the open chat's page that says THAT something changed (the event itself carries no content), and a read of the open chat's last
 * messages. Only in the user's own browser, with an extension that has `chat_watch` and `chat_read`; and only while the chat app is allowed.
 */
export interface BrowserChatLive {
  chatWatch(mode: 'start' | 'stop' | 'status', tabId?: number): Promise<ChatWatchResult>;
  chatRead(max?: number, tabId?: number): Promise<ChatReadResult>;
  /**
   * Takes a picture or a document out of the open chat (only a message the OTHER person sent). `look`: a picture's own bytes when the page holds them, or what a document
   * bubble offers (its name, whether it has a download control) — nothing is pressed. `download`: presses the document's own download control and waits for the browser's
   * download. Optional: a browser connection without it cannot take files out of a chat.
   */
  chatMedia?(messageId: string, step: 'look' | 'download', tabId?: number): Promise<ChatMediaResult>;
}

export type ChatMediaResult =
  /** A picture's own bytes, as the page holds them. */
  | { readonly ok: true; readonly via: 'bytes'; readonly mime: string; readonly data: Uint8Array }
  /** A document bubble: the file name the page shows (empty when it shows none) and whether it has a download control. */
  | { readonly ok: true; readonly via: 'document'; readonly name: string; readonly hasControl: boolean; readonly icons?: readonly string[] }
  /** The download control was pressed: what the browser did (null: nothing started). */
  | { readonly ok: true; readonly via: 'download'; readonly download: DownloadInfo | null }
  | { readonly ok: false; readonly reason: 'extension_old' | 'not_found' | 'not_incoming' | 'not_media' | 'not_loaded' | 'too_big' | 'no_control' | 'failed'; readonly message: string };
