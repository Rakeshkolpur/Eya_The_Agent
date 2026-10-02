/**
 * What an action actually did to the world, as observed afterwards — not what
 * it was meant to do. Every field is something the browser reported back.
 */
export interface PageChanges {
  /** The address moved (as opposed to the same page rearranging itself). */
  readonly navigated: boolean;
  readonly urlChanged?: { readonly from: string; readonly to: string };
  readonly titleChanged: boolean;
  /** Controls that were not there before (menu items that just appeared, …), by name; capped. */
  readonly appeared: readonly string[];
  readonly appearedCount: number;
  readonly disappeared: readonly string[];
  readonly disappearedCount: number;
  /** Text of a popup/dialog/alert that was not open before. */
  readonly dialogOpened?: string;
  readonly dialogClosed: boolean;
  /** The readable text of the page differs from before. */
  readonly textChanged: boolean;
}

export interface DownloadInfo {
  /** Full local path the browser saved to. Empty until the browser has decided on one. */
  readonly path: string;
  readonly name: string;
  readonly state: 'complete' | 'in_progress' | 'interrupted';
  readonly bytes: number;
  readonly mime?: string;
  readonly error?: string;
}

export interface ActionEffects {
  readonly changes: PageChanges;
  /** The action opened another tab and Eya moved to it — like a person following the link. */
  readonly newTab?: { readonly url: string; readonly title: string };
  readonly download?: DownloadInfo;
  /** False when the page was still changing when Eya looked, so something may have appeared slightly later. */
  readonly settled: boolean;
  readonly stillBusy?: boolean;
}

export interface BrowserTabInfo {
  /** Which browser this tab is in. Tab numbers are only unique within one browser, so this always travels with `tabId`. */
  readonly browser?: 'chrome' | 'edge' | 'other';
  readonly windowId?: number;
  readonly pinned?: boolean;
  readonly loading?: boolean;
  readonly tabId: number;
  readonly title: string;
  readonly url: string;
  readonly active: boolean;
  /** Eya opened this tab herself (she only ever steers those; yours are left where they are). */
  readonly openedByEya: boolean;
  /** The tab Eya is working in right now. */
  readonly workingHere: boolean;
}
