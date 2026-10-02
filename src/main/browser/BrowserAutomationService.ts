import type { PageSnapshot, SnapshotTable } from './pageSnapshot';
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
export interface BrowserAutomationService {
  openWebsite(url: string): Promise<PageSnapshot>;
  inspectPage(): Promise<PageSnapshot>;
  /** Searches the WHOLE page (showing, further down, closed menus, its text) for something, instead of only the first screenful. */
  findOnPage(query: string): Promise<FindOnPageResult>;
  /** Reads the page's text in slices, so a long page can be read through. */
  readPage(offset?: number): Promise<ReadPageResult>;
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
