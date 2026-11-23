/**
 * What the Browser page of the Eya app shows and can do: which browser a task is working in, the page it is on, what it is trying to do, what it
 * has done, what is holding it up, and the controls the user has over it (pause, stop, take over, hand back). Plain data, so the main process and
 * the page agree on it.
 */
export type BrowserKind = 'eya' | 'mine';

export type PanelStatus = 'idle' | 'working' | 'waiting_you' | 'paused' | 'taken_over' | 'stopped' | 'done' | 'problem';

export interface PanelTab {
  readonly id: number;
  readonly title: string;
  readonly url: string;
  readonly active: boolean;
}

export interface PanelStep {
  readonly text: string;
  readonly ok: boolean;
  readonly at: number;
}

export interface PanelLogLine {
  readonly at: number;
  readonly kind: 'action' | 'info' | 'warn' | 'user';
  readonly text: string;
}

export interface BrowserPanelState {
  /** Where the current (or last) task works; null before anything was opened. */
  readonly where: BrowserKind | null;
  /** "Chrome" or "Edge" when the task is in My Browser. */
  readonly browserName: string | null;
  /** The user's saved choice: used when nothing else decides. */
  readonly preference: BrowserKind;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  /** The page problem in words (a site that cannot be reached, a crash), when there is one. */
  readonly error: string | null;
  readonly status: PanelStatus;
  readonly statusText: string;
  /** What the user asked for, as the task's goal. */
  readonly goal: string;
  /** What Eya is doing at this moment. */
  readonly current: string;
  readonly steps: readonly PanelStep[];
  /** What is holding the task up (a sign-in, a check, a question for the user). */
  readonly blockers: readonly string[];
  readonly log: readonly PanelLogLine[];
  readonly paused: boolean;
  readonly takenOver: boolean;
  readonly tabs: readonly PanelTab[];
  /** The user's own browsers that are connected to Eya (My Browser). */
  readonly myBrowsers: readonly string[];
  /** My Browser was needed but is not connected (so the page offers to connect it). */
  readonly needsMyBrowser: boolean;
}

export type BrowserPanelAction =
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'stop' }
  | { readonly type: 'take_over' }
  | { readonly type: 'hand_back' }
  | { readonly type: 'navigate'; readonly url: string }
  | { readonly type: 'back' }
  | { readonly type: 'forward' }
  | { readonly type: 'reload' }
  | { readonly type: 'stop_loading' }
  | { readonly type: 'new_tab' }
  | { readonly type: 'focus_tab'; readonly id: number }
  | { readonly type: 'open_in_my_browser' }
  | { readonly type: 'connect_my_browser' }
  | { readonly type: 'disconnect_my_browser' }
  | { readonly type: 'show_window' };

export interface BrowserPanelResult {
  readonly ok: boolean;
  readonly message: string;
  readonly state: BrowserPanelState;
}

/** Where Eya Browser is drawn: the rectangle of the Browser page's view area, in the app window's own pixels. */
export interface BrowserViewBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const EMPTY_PANEL: BrowserPanelState = {
  where: null,
  browserName: null,
  preference: 'eya',
  url: '',
  title: '',
  loading: false,
  error: null,
  status: 'idle',
  statusText: 'Nothing is open yet',
  goal: '',
  current: '',
  steps: [],
  blockers: [],
  log: [],
  paused: false,
  takenOver: false,
  tabs: [],
  myBrowsers: [],
  needsMyBrowser: false,
};
