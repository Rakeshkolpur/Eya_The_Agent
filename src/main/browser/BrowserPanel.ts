import { rootLogger } from '@main/logging/logger';
import { EMPTY_PANEL } from '@shared/browserPanel';
import type { BrowserKind, BrowserPanelState, PanelLogLine, PanelStatus, PanelStep, PanelTab } from '@shared/browserPanel';
import { BrowserUnavailableError } from './errors';

const log = rootLogger.child('browser.panel');

const MAX_LOG = 120;
const MAX_STEPS = 60;
/** How long a paused or handed-over task waits for the user before it gives up (so nothing waits for ever). */
const MAX_HOLD_MS = 20 * 60_000;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const host = (url: string): string => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return clip(url, 40);
  }
};

/** What is being done, in the words the panel shows. Never includes anything typed into a field. */
export function describeAction(op: string, detail?: string): string {
  const d = detail ?? '';
  switch (op) {
    case 'open':
      return `Opening ${host(d) || 'the page'}`;
    case 'click':
      return `Clicking “${clip(d, 60)}”`;
    case 'fill':
      return `Typing into “${clip(d, 50)}”`;
    case 'scroll':
      return `Scrolling ${d || 'down'}`;
    case 'back':
      return 'Going back';
    case 'forward':
      return 'Going forward';
    case 'reload':
      return 'Reloading the page';
    case 'inspect':
      return 'Looking at the page';
    case 'read':
      return 'Reading the page';
    case 'find':
      return `Looking for “${clip(d, 50)}”`;
    case 'screenshot':
      return 'Taking a picture of the page';
    case 'wait':
      return 'Waiting for you to finish in the browser';
    default:
      return clip(`${op}${d ? ` ${d}` : ''}`, 80);
  }
}

/** The actions that change something (the others are only looking): these are the steps the panel lists. */
const STEP_OPS: ReadonlySet<string> = new Set(['open', 'click', 'fill', 'scroll', 'back', 'forward', 'reload']);

export interface ActionOutcome {
  readonly op: string;
  readonly detail?: string;
  readonly ok: boolean;
  /** For a failure that is not an error: why (needs_user, needs_confirmation, ambiguous, not_found, could_not). */
  readonly reason?: string;
  readonly message?: string;
  readonly url?: string;
  readonly title?: string;
  /** A sign-in, CAPTCHA, code or payment page is showing. */
  readonly challenge?: string;
  readonly notes?: readonly string[];
}

export class BrowserStoppedError extends BrowserUnavailableError {
  constructor() {
    super(
      'The user pressed Stop in Eya\'s Browser panel, so this task was stopped. Do not carry on and do not start it again by yourself; tell the user in a few words that you stopped.',
      { why: 'stopped' },
    );
  }
}

/**
 * The state behind the Browser page: the goal, what is being done, the steps, what is holding the task up, and the user's controls over it.
 * The browser tools run through it: before each action it waits while the user has paused the task or taken the browser over, and refuses
 * after Stop; after each one it records what happened. Nothing typed into a field is ever recorded here.
 */
export class BrowserPanel {
  private state: BrowserPanelState = EMPTY_PANEL;
  private readonly listeners = new Set<(s: BrowserPanelState) => void>();
  private readonly now: () => number;
  private stopped = false;
  private waiters: Array<() => void> = [];
  private requestText = '';
  private requestUsedBrowser = false;
  private byUser = 0;
  /** Sites where this task has already got past any sign-in, so a sign-in wall that appears there now means the session ended. */
  private workedOn = new Set<string>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: { readonly now?: () => number; readonly preference?: BrowserKind } = {}) {
    this.now = options.now ?? Date.now;
    if (options.preference !== undefined) this.state = { ...EMPTY_PANEL, preference: options.preference };
  }

  // ------------------------------------------------------------------ reading
  get(): BrowserPanelState {
    return this.state;
  }

  onChange(listener: (s: BrowserPanelState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<BrowserPanelState>): void {
    this.state = { ...this.state, ...patch };
    if (this.pushTimer !== null) return;
    // Many small changes in a burst go out as one.
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      for (const l of this.listeners) l(this.state);
    }, 60);
  }

  private append(kind: PanelLogLine['kind'], text: string): void {
    const last = this.state.log[this.state.log.length - 1];
    if (last !== undefined && last.text === text && last.kind === kind) return;
    this.set({ log: [...this.state.log, { at: this.now(), kind, text }].slice(-MAX_LOG) });
  }

  private statusFor(status: PanelStatus): { status: PanelStatus; statusText: string } {
    const texts: Record<PanelStatus, string> = {
      idle: 'Nothing is open yet',
      working: 'Working…',
      waiting_you: 'Waiting for you',
      paused: 'Paused',
      taken_over: 'You have the browser',
      stopped: 'Stopped',
      done: 'Done',
      problem: 'A problem came up',
    };
    return { status, statusText: texts[status] };
  }

  // ------------------------------------------------------------------ requests
  /** A request from the user has started. A reply to something Eya was waiting on carries the same task on; anything else is a new one. */
  beginRequest(text: string): void {
    this.requestText = text.trim();
    this.requestUsedBrowser = false;
    this.stopped = false;
    if (this.state.status === 'stopped') this.set(this.statusFor('idle'));
  }

  /** The request is over. If the browser was used and nothing is holding it up, the task is done. */
  endRequest(): void {
    if (!this.requestUsedBrowser) return;
    if (this.state.status === 'working') {
      this.set({ ...this.statusFor(this.state.blockers.length > 0 ? 'waiting_you' : 'done'), current: '' });
    }
  }

  private noteBrowserUse(): void {
    if (this.requestUsedBrowser) return;
    this.requestUsedBrowser = true;
    const waiting = this.state.status === 'waiting_you' && this.state.goal !== '';
    if (waiting) {
      // The user answered what Eya was waiting for: the same task goes on, with what they said kept in view.
      if (this.requestText !== '') this.append('user', `You said: ${clip(this.requestText, 140)}`);
      this.set({ ...this.statusFor('working'), blockers: [] });
      return;
    }
    this.workedOn = new Set();
    this.set({ ...this.statusFor('working'), goal: clip(this.requestText, 200), steps: [], blockers: [], error: null, current: '' });
    if (this.requestText !== '') this.append('user', `Task: ${clip(this.requestText, 160)}`);
  }

  // ------------------------------------------------------------------ the tools' side
  /** Called before every browser action. Waits while paused or handed over; refuses after Stop. */
  async before(op: string, detail?: string): Promise<void> {
    if (this.byUser > 0) return;
    this.noteBrowserUse();
    await this.holdIfAsked();
    // Waiting for the user to finish something (a sign-in, a check) is not Eya working: the task stays 'waiting for you' until it is done.
    if (op === 'wait') this.set({ current: describeAction(op, detail) });
    else this.set({ ...this.statusFor('working'), current: describeAction(op, detail) });
  }

  private async holdIfAsked(): Promise<void> {
    const started = this.now();
    while (this.state.paused || this.state.takenOver) {
      if (this.stopped) break;
      if (this.now() - started > MAX_HOLD_MS) {
        throw new BrowserUnavailableError('The browser was paused for a long time and Eya stopped waiting. Tell the user, and carry on when they ask.', { why: 'stopped' });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (this.stopped) throw new BrowserStoppedError();
  }

  /**
   * Waits while the task is paused or the browser has been taken over, so that the WHOLE request holds still (no new AI step, no new tool), not only the
   * browser steps. Ends at once when Stop is pressed or the request's signal is aborted.
   */
  async waitWhilePaused(signal?: AbortSignal): Promise<void> {
    const started = this.now();
    while ((this.state.paused || this.state.takenOver) && !this.stopped && signal?.aborted !== true) {
      if (this.now() - started > MAX_HOLD_MS) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        const wake = (): void => {
          clearTimeout(timer);
          resolve();
        };
        this.waiters.push(wake);
        signal?.addEventListener('abort', wake, { once: true });
      });
    }
  }

  /** Called after every browser action, with how it went. */
  after(outcome: ActionOutcome): void {
    if (this.byUser > 0) return;
    const text = describeAction(outcome.op, outcome.detail);
    const page: Partial<BrowserPanelState> = {
      ...(outcome.url !== undefined ? { url: outcome.url } : {}),
      ...(outcome.title !== undefined ? { title: outcome.title } : {}),
    };
    if (STEP_OPS.has(outcome.op)) {
      const step: PanelStep = { text, ok: outcome.ok, at: this.now() };
      this.set({ steps: [...this.state.steps, step].slice(-MAX_STEPS) });
    }
    let blockers: string[] = [];
    let status: PanelStatus = 'working';
    let kind: PanelLogLine['kind'] = outcome.ok ? 'action' : 'warn';
    let line = outcome.ok ? text : `${text}: ${outcome.message ?? outcome.reason ?? 'did not work'}`;
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'needs_user':
          blockers = [clip(outcome.message ?? 'A step only the user can do (a sign-in, a check or a code)', 200)];
          status = 'waiting_you';
          line = `Waiting for you: ${blockers[0]}`;
          break;
        case 'needs_confirmation':
          blockers = [clip(`Waiting for your OK: ${outcome.message ?? outcome.detail ?? 'a step that needs your yes'}`, 200)];
          status = 'waiting_you';
          line = blockers[0] ?? line;
          break;
        case 'ambiguous':
          blockers = [clip(`Which one? ${outcome.message ?? ''}`.trim(), 200)];
          status = 'waiting_you';
          line = blockers[0] ?? line;
          break;
        case 'not_found':
          // Eya cannot find what she was told to click: the page stays as it is and the user says where to go (or does it), and the task goes on from there.
          blockers = [clip(`Could not find “${outcome.detail ?? 'that'}” on this page: tell Eya what to click, or do it in the browser.`, 200)];
          status = 'waiting_you';
          line = blockers[0] ?? line;
          break;
        default:
          break;
      }
    }
    const site = outcome.url !== undefined ? host(outcome.url) : '';
    if (outcome.ok && outcome.challenge === undefined && site !== '') this.workedOn.add(site);
    if (outcome.challenge === 'login' && site !== '' && this.workedOn.has(site)) {
      // A sign-in wall on a site the task was already working in: the session ended (it expired, or the site ended it).
      blockers = ["The site is asking you to sign in again: your session there has probably expired. Sign in on the page and Eya carries on from here."];
      status = 'waiting_you';
      kind = 'warn';
      line = blockers[0] ?? line;
    } else if (outcome.challenge !== undefined) {
      const wording = outcome.challenge === 'captcha' || outcome.challenge === 'bot_check' ? 'A human check is showing' : outcome.challenge === 'payment' ? 'A payment step is showing' : outcome.challenge === 'mfa' ? 'A verification code is needed' : 'A sign-in is needed';
      blockers = [`${wording}: do it in the browser and Eya carries on by herself.`];
      status = 'waiting_you';
      kind = 'warn';
      line = blockers[0] ?? line;
    }
    for (const note of outcome.notes ?? []) if (/redirect|DIFFERENT site|answered "|could not be found|blank/i.test(note)) this.append('warn', clip(note, 220));
    this.append(kind, line);
    this.set({ ...page, ...this.statusFor(status), current: '', blockers, ...(outcome.ok ? { error: null } : {}) });
  }

  /**
   * What a longer job (finding a site's new address, a download) is doing, in plain words: "now" is the line being worked on, "done" a step that
   * went well, "warn" one that did not (and is being worked around). Only ever words, never an address with a secret in it.
   */
  progress(kind: 'now' | 'done' | 'warn', text: string): void {
    if (this.byUser > 0) return;
    this.noteBrowserUse();
    const line = clip(text, 160);
    if (kind === 'now') {
      this.set({ ...this.statusFor('working'), current: line });
      this.append('info', line);
      return;
    }
    const step: PanelStep = { text: line, ok: kind === 'done', at: this.now() };
    this.set({ steps: [...this.state.steps, step].slice(-MAX_STEPS), ...this.statusFor('working'), current: '' });
    this.append(kind === 'done' ? 'action' : 'warn', line);
  }

  /** Something only the person can decide (a site that could not be confirmed, a check only a human passes): the panel says what it waits for. */
  blocked(text: string): void {
    if (this.byUser > 0) return;
    const line = clip(text, 200);
    this.append('warn', line);
    this.set({ ...this.statusFor('waiting_you'), blockers: [line], current: '' });
  }

  /** A browser action threw: say so, and where the task stands. */
  failed(op: string, detail: string | undefined, message: string): void {
    if (this.byUser > 0) return;
    this.append('warn', `${describeAction(op, detail)}: ${clip(message, 200)}`);
    this.set({ ...this.statusFor(this.stopped ? 'stopped' : 'problem'), current: '', error: clip(message, 240) });
  }

  // ------------------------------------------------------------------ the page
  setPage(page: { readonly url?: string; readonly title?: string; readonly loading?: boolean; readonly error?: string | null }): void {
    this.set({
      ...(page.url !== undefined ? { url: page.url } : {}),
      ...(page.title !== undefined ? { title: page.title } : {}),
      ...(page.loading !== undefined ? { loading: page.loading } : {}),
      ...(page.error !== undefined ? { error: page.error } : {}),
    });
  }

  setTabs(tabs: readonly PanelTab[]): void {
    this.set({ tabs });
  }

  /** (the manager's name for it) */
  where(kind: BrowserKind | null, browserName: string | null = null): void {
    this.setWhere(kind, browserName);
  }

  setWhere(where: BrowserKind | null, browserName: string | null = null): void {
    if (where === this.state.where && browserName === this.state.browserName) return;
    this.set({ where, browserName, needsMyBrowser: false });
    if (where !== null) this.append('info', where === 'eya' ? 'Working in Eya Browser' : `Working in your ${browserName ?? 'browser'} (My Browser)`);
  }

  setPreference(preference: BrowserKind): void {
    this.set({ preference });
  }

  setMyBrowsers(names: readonly string[]): void {
    const same = names.length === this.state.myBrowsers.length && names.every((n, i) => n === this.state.myBrowsers[i]);
    if (!same) this.set({ myBrowsers: names, ...(names.length > 0 ? { needsMyBrowser: false } : {}) });
  }

  /** My Browser was needed and is not connected: the page offers to connect it. */
  needMyBrowser(reason: string): void {
    this.append('warn', clip(reason, 200));
    this.set({ ...this.statusFor('waiting_you'), needsMyBrowser: true, blockers: [clip(reason, 200)], current: '' });
  }

  note(kind: PanelLogLine['kind'], text: string): void {
    this.append(kind, text);
  }

  // ------------------------------------------------------------------ the user's controls
  pause(): void {
    if (this.state.paused) return;
    this.append('user', 'You paused the task');
    this.set({ paused: true, ...this.statusFor('paused'), current: '' });
  }

  resume(): void {
    if (!this.state.paused && !this.state.takenOver) return;
    this.append('user', 'You resumed the task');
    this.set({ paused: false, takenOver: false, ...this.statusFor('working') });
    this.release();
  }

  stop(): void {
    this.stopped = true;
    this.append('user', 'You stopped the task');
    this.set({ paused: false, takenOver: false, ...this.statusFor('stopped'), current: '' });
    this.release();
  }

  takeOver(): void {
    this.append('user', 'You took over the browser');
    this.set({ takenOver: true, paused: false, ...this.statusFor('taken_over'), current: '' });
  }

  handBack(): void {
    if (!this.state.takenOver) return;
    this.append('user', 'You handed the browser back to Eya');
    this.set({ takenOver: false, ...this.statusFor('working') });
    this.release();
  }

  /** Runs something the user did themselves (the address bar, the back button): it is neither held nor recorded as Eya's step. */
  async asUser<T>(run: () => Promise<T>): Promise<T> {
    this.byUser += 1;
    try {
      return await run();
    } finally {
      this.byUser -= 1;
    }
  }

  isHeld(): boolean {
    return this.state.paused || this.state.takenOver;
  }

  private release(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w();
    log.debug('released', { count: waiting.length });
  }
}
