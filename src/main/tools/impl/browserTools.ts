import { parseWebUrl } from './openTools';
import type { ActOnPageResult, BrowserAutomationService, BrowserTabControl, ClickGate } from '@main/browser/BrowserAutomationService';
import { challengeMessage, isBlockingChallenge } from '@main/browser/challenges';
import { BrowserUnavailableError } from '@main/browser/errors';
import { LoopGuard, pageFingerprint } from '@main/browser/loopGuard';
import type { ActionEffects, DownloadInfo } from '@main/browser/pageEffects';
import type { PageContext } from '@main/browser/sensitiveActions';
import { sensitiveActionReason, sensitiveSubmitReason } from '@main/browser/sensitiveActions';
import type { PageSnapshot } from '@main/browser/pageSnapshot';
import type { ChromeConnector } from '@main/chrome/chromeConnector';
import { permissionRequest } from '@main/permissions/PermissionManager';
import { verifyFileExists } from '../verify';
import type { Tool, ToolArgs, ToolResult } from '../types';

/**
 * Real, DOM-aware website navigation: open a page, see what is actually on
 * it, click something by its visible text, fill a visible field. The point
 * of this file is the one rule that used to be missing — "go to Cause List"
 * must click the real Cause List link on the page that is already open, not
 * turn into a web search or an invented URL. See the system prompt's
 * "Navigating a website" section for how the model is told to use these.
 *
 * Whichever browser is behind the service (the user's own signed-in one or
 * Eya's separate window), every result is a fresh look at the page AFTER the
 * action — never a guess at what the action should have done.
 */

export interface BrowserToolOptions {
  /** Present when the user's own browser can be reached: enables listing and switching tabs. */
  readonly tabs?: BrowserTabControl;
  /** Present when the Eya Browser Bridge can be set up: enables connect_chrome. */
  readonly connector?: ChromeConnector;
  /** Whether a downloaded file is really on disk. Defaults to checking the filesystem. */
  readonly verifyDownload?: (path: string) => Promise<boolean>;
}

function stringArg(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function snapshotFields(s: PageSnapshot): Record<string, unknown> {
  return {
    url: s.url,
    title: s.title,
    headings: s.headings,
    links: s.links,
    buttons: s.buttons,
    inputs: s.inputs,
    ...(s.dialogs.length > 0 ? { dialogs: s.dialogs } : {}),
    ...(s.visibleText !== undefined ? { visibleText: s.visibleText } : {}),
    ...(s.tables !== undefined ? { tables: s.tables } : {}),
    ...(s.focused !== undefined && s.focused !== '' ? { focused: s.focused } : {}),
    ...(s.scroll !== undefined && !s.scroll.atBottom ? { moreBelow: true } : {}),
    ...(s.notes !== undefined ? { notes: s.notes } : {}),
    ...(s.truncated ? { truncated: true } : {}),
  };
}

interface PageChange {
  /** Anything the model could see on the page differs from before — including a menu that just expanded. */
  readonly stateChanged: boolean;
  /** The address itself moved, as opposed to the same page rearranging. */
  readonly navigated: boolean;
}

/** What the browser reported actually changed, in a form that is short enough to read. */
function effectsFields(effects: ActionEffects | undefined): Record<string, unknown> {
  if (effects === undefined) return {};
  const c = effects.changes;
  const changes = {
    ...(c.appearedCount > 0 ? { appeared: c.appeared, ...(c.appearedCount > c.appeared.length ? { appearedTotal: c.appearedCount } : {}) } : {}),
    ...(c.disappearedCount > 0 ? { disappeared: c.disappeared, ...(c.disappearedCount > c.disappeared.length ? { disappearedTotal: c.disappearedCount } : {}) } : {}),
    ...(c.dialogOpened !== undefined ? { dialogOpened: c.dialogOpened } : {}),
    ...(c.dialogClosed ? { dialogClosed: true } : {}),
    ...(c.textChanged ? { pageTextChanged: true } : {}),
    ...(c.titleChanged ? { titleChanged: true } : {}),
  };
  return {
    ...(Object.keys(changes).length > 0 ? { whatChanged: changes } : {}),
    ...(effects.newTab !== undefined ? { openedNewTab: true } : {}),
    ...(!effects.settled ? { pageStillChanging: true } : {}),
  };
}

/** A fresh look at the page, every time — the only state a tool result is ever built from. */
function currentPageData(
  action: string,
  target: string | null,
  change: PageChange,
  snapshot: PageSnapshot,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action,
    ...(target !== null ? { target } : {}),
    stateChanged: change.stateChanged,
    navigated: change.navigated,
    ...(snapshot.environment !== undefined ? { environment: snapshot.environment } : {}),
    currentPage: snapshotFields(snapshot),
    ...extra,
  };
}

function changeBetween(before: PageSnapshot | null, after: PageSnapshot, effects?: ActionEffects): PageChange {
  if (effects !== undefined) {
    const c = effects.changes;
    const any =
      c.navigated || c.titleChanged || c.appearedCount > 0 || c.disappearedCount > 0 || c.dialogOpened !== undefined || c.dialogClosed || c.textChanged;
    return { stateChanged: any || effects.newTab !== undefined || effects.download !== undefined, navigated: c.navigated || effects.newTab !== undefined };
  }
  if (before === null) return { stateChanged: true, navigated: true };
  return { stateChanged: pageFingerprint(before) !== pageFingerprint(after), navigated: before.url !== after.url };
}

/**
 * Best-effort look at the page just before an action — used only to tell
 * whether the action changed anything and whether it is a repeat of one that
 * already went nowhere, never to decide what to click.
 */
async function lookBefore(service: BrowserAutomationService): Promise<PageSnapshot | null> {
  try {
    return await service.inspectPage();
  } catch {
    return null;
  }
}

function contextOf(s: PageSnapshot | null): PageContext | undefined {
  return s === null ? undefined : { url: s.url, title: s.title, headings: s.headings };
}

/** Handed back instead of repeating an action that has already gone nowhere: the live page, so the model can choose something genuinely different. */
function loopResult(verb: string, display: string, action: string, snapshot: PageSnapshot, tries: number): ToolResult {
  return {
    ok: false,
    summary: 'repeating itself',
    error:
      `I've already tried ${verb} "${display}" ${tries} times from this exact page and it either did nothing or came ` +
      'straight back here. Doing it again will not help — pick a genuinely different link, button or wording from what ' +
      'is on the page below, or tell the user plainly what you are seeing and ask.',
    data: { ...currentPageData(action, display, { stateChanged: false, navigated: false }, snapshot), loopDetected: true },
  };
}

/** A CAPTCHA / bot check / verification-code prompt stops everything; a plain sign-in page is reported but does not. */
function applyChallenge(base: ToolResult, snapshot: PageSnapshot): ToolResult {
  const challenge = snapshot.challenge;
  if (challenge === undefined) return base;
  const message = challengeMessage(challenge.kind);
  const data = { ...(base.data ?? {}), needsUser: true, userAction: message, challengeKind: challenge.kind };
  if (isBlockingChallenge(challenge.kind)) return { ok: false, summary: 'needs you', error: message, data };
  return { ...base, data };
}

function failure(summary: string, prefix: string, err: unknown): ToolResult {
  if (err instanceof BrowserUnavailableError) return { ok: false, summary: 'browser not connected', error: err.message };
  return { ok: false, summary, error: `${prefix}: ${describeError(err)}` };
}

/** A finished download is only reported as one once the file is really on disk. */
async function downloadFields(download: DownloadInfo | undefined, verify: (path: string) => Promise<boolean>): Promise<Record<string, unknown>> {
  if (download === undefined) return {};
  const info: Record<string, unknown> = { name: download.name, state: download.state, ...(download.bytes >= 0 ? { bytes: download.bytes } : {}) };
  if (download.state === 'interrupted') return { download: { ...info, ...(download.error !== undefined ? { error: download.error } : {}) } };
  if (download.state === 'in_progress' || download.path === '') {
    return { download: { ...info, note: 'The browser is still downloading it; check the browser, or ask again in a moment.' } };
  }
  if (await verify(download.path)) return { path: download.path, download: { ...info, verified: true } };
  return { download: { ...info, verified: false, note: 'The browser says it finished, but I could not find the file on disk.' } };
}

const defaultVerify = async (path: string): Promise<boolean> => (await verifyFileExists(path)).verified;

export function createBrowserTools(
  service: BrowserAutomationService,
  guard: LoopGuard = new LoopGuard(),
  options: BrowserToolOptions = {},
): Tool[] {
  const verifyDownload = options.verifyDownload ?? defaultVerify;

  const openWebsite: Tool = {
    schema: {
      name: 'open_website',
      status: 'Opening the website…',
      description:
        'Open a website by its exact https:// URL. This becomes the current page for inspect_page, click_on_page ' +
        "and fill_on_page. If you don't already know a site's exact official URL (e.g. for \"the High Court of " +
        'Telangana\" or \"my bank\"), use web_search first to find and confirm it, then call this with that exact ' +
        'URL — never invent one, and never treat opening a site as the same thing as searching for it. If the ' +
        "user's own browser is connected this happens in THEIR browser (reusing a tab they already have open on " +
        "that site if there is one), so their sign-ins are already there; the result's `environment` says which browser it was.",
      args: { url: { type: 'string', required: true, description: 'The exact http(s) address to open, e.g. from a web_search result.' } },
    },
    async execute(args): Promise<ToolResult> {
      const raw = stringArg(args, 'url');
      if (raw === undefined) return { ok: false, summary: 'no url', error: 'A URL is required.' };
      const url = parseWebUrl(raw);
      if (url === null) return { ok: false, summary: 'bad url', error: 'That is not a normal http or https address.' };
      try {
        const snapshot = await service.openWebsite(url.href);
        return applyChallenge(
          {
            ok: true,
            summary: `opened ${snapshot.title || url.hostname}`,
            data: currentPageData('open', url.href, { stateChanged: true, navigated: true }, snapshot),
          },
          snapshot,
        );
      } catch (err) {
        return failure('could not open', 'I could not open that website', err);
      }
    },
  };

  const inspectPage: Tool = {
    schema: {
      name: 'inspect_page',
      status: 'Looking at the page…',
      description:
        'See what is actually on the currently open web page right now: its headings, visible links, buttons and ' +
        'form fields, plus the readable text and any table on it. Use this before click_on_page or fill_on_page whenever ' +
        'you have not just seen the current page, to read what a page says, to look again after the user has done ' +
        'something themselves (signed in, solved a CAPTCHA), or to find out what options a page genuinely offers instead ' +
        'of assuming or remembering from training.',
      args: {},
    },
    async execute(): Promise<ToolResult> {
      try {
        const snapshot = await service.inspectPage();
        return applyChallenge(
          {
            ok: true,
            summary: `looked at ${snapshot.title || snapshot.url}`,
            data: currentPageData('inspect', null, { stateChanged: false, navigated: false }, snapshot),
          },
          snapshot,
        );
      } catch (err) {
        if (err instanceof BrowserUnavailableError) return { ok: false, summary: 'browser not connected', error: err.message };
        return { ok: false, summary: 'no page open', error: 'No website is open yet. Use open_website first.' };
      }
    },
  };

  /** Turns a service's non-success outcome into the tool result the model should see. */
  function declined(result: Exclude<ActOnPageResult, { ok: true }>, action: string, text: string, verbForError: string): ToolResult {
    const idle = { stateChanged: false, navigated: false };
    switch (result.reason) {
      case 'not_found':
        return {
          ok: false,
          summary: 'not found',
          error: action === 'fill' ? `No field matching "${text}" is visible on the current page.` : `"${text}" isn't visible on the current page.`,
          data: currentPageData(action, text, idle, result.snapshot),
        };
      case 'needs_confirmation':
        return {
          ok: false,
          summary: 'needs confirmation',
          error:
            `That would be ${result.why}: "${result.target}". Nothing was clicked. Ask the user plainly whether to go ahead, ` +
            'and only if they clearly say yes, call click_on_page again with confirm: true.',
          // The permission request goes last: its own `action` and `target` (what would be clicked) must win.
          data: { ...currentPageData(action, text, idle, result.snapshot), ...permissionRequest('browser_sensitive_click', result.target, `This would be ${result.why}.`) },
        };
      case 'needs_user':
        return applyChallenge(
          {
            ok: false,
            summary: 'needs you',
            error: result.message,
            data: { ...currentPageData(action, text, idle, result.snapshot), needsUser: true, userAction: result.message },
          },
          result.snapshot,
        );
      default:
        return {
          ok: false,
          summary: `${verbForError} failed`,
          error: `${result.message}`,
          data: currentPageData(action, text, idle, result.snapshot),
        };
    }
  }

  /** What a successful action reports: the page after it, what changed, and any verified download. */
  async function succeeded(action: string, target: string | null, summary: string, before: PageSnapshot | null, result: Extract<ActOnPageResult, { ok: true }>): Promise<ToolResult> {
    const extra = { ...effectsFields(result.effects), ...(await downloadFields(result.effects?.download, verifyDownload)) };
    const downloaded = typeof extra['path'] === 'string' ? ` — downloaded ${(extra['download'] as { name?: string }).name ?? 'a file'}` : '';
    return applyChallenge(
      {
        ok: true,
        summary: `${summary}${downloaded}`,
        data: currentPageData(action, target, changeBetween(before, result.snapshot, result.effects), result.snapshot, extra),
      },
      result.snapshot,
    );
  }

  const clickOnPage: Tool = {
    schema: {
      name: 'click_on_page',
      status: 'Clicking that…',
      description:
        'Click a link, button, tab, checkbox or menu item that is actually visible on the web page that is currently open, ' +
        'by its visible text (e.g. "Cause List", "Sent", "My Orders", "Sign in", "Search"). Use this to navigate WITHIN a ' +
        'website that is already open — never web_search or open_url for that: those search the internet or load an ' +
        'unrelated page, not the thing the user is pointing at on the page in front of them. If nothing on the page ' +
        'matches, the result tells you what actually IS there, so you can try different wording or ask the user — ' +
        'never guess a URL instead. The result always reflects the page exactly as it is after this click, including ' +
        'what appeared or disappeared, a new tab it opened, a file it downloaded, and anything unexpected (a popup, a ' +
        'login prompt, a different page than you might have guessed) — read it fresh each time rather than assuming what ' +
        'should be there. A click that would buy something, send or publish something, delete something or change an ' +
        'account setting is NOT done on the first call: you get a question to put to the user, and only after they ' +
        'clearly say yes do you call again with confirm: true.',
      args: {
        text: { type: 'string', required: true, description: 'The visible text of the link, button or menu item to click.' },
        confirm: { type: 'boolean', description: 'Set true ONLY after the user has clearly agreed to this exact action when asked.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const text = stringArg(args, 'text');
      if (text === undefined) return { ok: false, summary: 'no text', error: 'Text to click is required.' };
      const before = await lookBefore(service);
      const fingerprint = before !== null ? pageFingerprint(before) : null;
      if (before !== null && fingerprint !== null && guard.isLoop(fingerprint, 'click', text)) {
        return loopResult('clicking', text, 'click', before, guard.maxRepeats);
      }
      const context = contextOf(before);
      const gate: ClickGate | undefined = args['confirm'] === true ? undefined : (t) => sensitiveActionReason(t.name, t.role, context);
      const record = () => {
        if (fingerprint !== null) guard.record(fingerprint, 'click', text);
      };
      let result: ActOnPageResult;
      try {
        result = await service.clickOnPage(text, gate);
      } catch (err) {
        record();
        return failure('click failed', 'I could not click that', err);
      }
      // Asking the user is not an attempt that "went nowhere", so it does not count towards the loop limit.
      if (result.ok || (result.reason !== 'needs_confirmation' && result.reason !== 'needs_user')) record();
      if (!result.ok) return declined(result, 'click', text, 'click');
      return succeeded('click', text, `clicked "${text}"`, before, result);
    },
  };

  const fillOnPage: Tool = {
    schema: {
      name: 'fill_on_page',
      status: 'Filling that in…',
      description:
        'Fill a visible form field or drop-down on the currently open page by its label or placeholder (e.g. "Advocate Code", ' +
        '"Email", "Search", "Year"). Use this instead of guessing how a form works. To then submit, use click_on_page with ' +
        'the visible text of the submit/search button, or set submit: true to press Enter for a search box that has no ' +
        "button. If the field can't be found, the result shows what fields actually ARE on the page. To tick a checkbox use " +
        'click_on_page. Passwords, card numbers and one-time codes are never typed by Eya — the result will say the user ' +
        'has to do it.',
      args: {
        label: { type: 'string', required: true, description: "The field's visible label or placeholder." },
        value: { type: 'string', required: true, description: 'What to type into it (or the option to choose, for a drop-down).' },
        submit: { type: 'boolean', description: 'Press Enter after typing, for search boxes with no button.' },
        confirm: { type: 'boolean', description: 'Set true ONLY after the user has agreed, when submitting would send or publish what was typed.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const label = stringArg(args, 'label');
      const value = stringArg(args, 'value');
      if (label === undefined || value === undefined) {
        return { ok: false, summary: 'missing arguments', error: 'A field label and a value are required.' };
      }
      const submit = args['submit'] === true;
      const before = await lookBefore(service);
      const fingerprint = before !== null ? pageFingerprint(before) : null;
      // The value is part of what makes this attempt "the same one": typing a different value is a new try.
      const key = `${label}=${value}${submit ? '+enter' : ''}`;
      if (before !== null && fingerprint !== null && guard.isLoop(fingerprint, 'fill', key)) {
        return loopResult('filling in', label, 'fill', before, guard.maxRepeats);
      }
      if (submit && args['confirm'] !== true) {
        const why = sensitiveSubmitReason(label);
        if (why !== null) {
          return {
            ok: false,
            summary: 'needs confirmation',
            error: `Pressing Enter there would be ${why}. Nothing was typed. Ask the user plainly whether to go ahead, and only if they clearly say yes, call fill_on_page again with confirm: true.`,
            data: permissionRequest('browser_sensitive_click', label, `This would be ${why}.`),
          };
        }
      }
      const record = () => {
        if (fingerprint !== null) guard.record(fingerprint, 'fill', key);
      };
      let result: ActOnPageResult;
      try {
        result = await service.fillOnPage(label, value, { submit });
      } catch (err) {
        record();
        return failure('fill failed', 'I could not fill that in', err);
      }
      if (result.ok || result.reason !== 'needs_user') record();
      if (!result.ok) return declined(result, 'fill', label, 'fill');
      return succeeded('fill', label, `filled "${label}"${submit ? ' and pressed Enter' : ''}`, before, result);
    },
  };

  const goBack: Tool = {
    schema: {
      name: 'go_back',
      status: 'Going back…',
      description:
        'Go back one page in the browser history of the page Eya is working in — the same as the browser\'s Back button. Use it when a ' +
        'click took the wrong way, instead of guessing a URL. The result is the page you land on.',
      args: {},
    },
    async execute(): Promise<ToolResult> {
      const before = await lookBefore(service);
      try {
        const result = await service.goBack();
        if (!result.ok) return declined(result, 'back', 'back', 'go back');
        return succeeded('back', null, 'went back', before, result);
      } catch (err) {
        return failure('go back failed', 'I could not go back', err);
      }
    },
  };

  const tools: Tool[] = [openWebsite, inspectPage, clickOnPage, fillOnPage, goBack];

  const tabs = options.tabs;
  if (tabs !== undefined) {
    tools.push(
      {
        schema: {
          name: 'list_browser_tabs',
          status: 'Checking your open tabs…',
          description:
            "List the tabs open in the user's own browser (title and address only) so you can switch to one they already have open, " +
            'e.g. "go to my Gmail tab". Only works when their browser is connected. Only call it when the request needs it.',
          args: {},
        },
        async execute(): Promise<ToolResult> {
          try {
            const list = await tabs.listTabs();
            return {
              ok: true,
              summary: `${list.length} tab${list.length === 1 ? '' : 's'} open`,
              data: {
                tabs: list.map((t) => ({
                  tabId: t.tabId,
                  title: t.title,
                  url: t.url,
                  ...(t.active ? { activeInBrowser: true } : {}),
                  ...(t.workingHere ? { eyaIsHere: true } : {}),
                })),
              },
            };
          } catch (err) {
            return failure('could not list tabs', 'I could not list the tabs', err);
          }
        },
      },
      {
        schema: {
          name: 'switch_browser_tab',
          status: 'Switching tab…',
          description:
            "Switch to one of the user's already-open browser tabs (use the tabId from list_browser_tabs) and look at it. Eya then works in that tab.",
          args: { tab_id: { type: 'number', required: true, description: 'The tabId from list_browser_tabs.' } },
        },
        async execute(args): Promise<ToolResult> {
          const id = args['tab_id'];
          if (typeof id !== 'number' || !Number.isInteger(id)) return { ok: false, summary: 'no tab', error: 'A tab_id from list_browser_tabs is required.' };
          try {
            const snapshot = await tabs.switchToTab(id);
            return applyChallenge(
              {
                ok: true,
                summary: `switched to ${snapshot.title || snapshot.url}`,
                data: currentPageData('switch_tab', null, { stateChanged: true, navigated: true }, snapshot),
              },
              snapshot,
            );
          } catch (err) {
            return failure('could not switch', 'I could not switch to that tab', err);
          }
        },
      },
    );
  }

  const connector = options.connector;
  if (connector !== undefined) {
    tools.push({
      schema: {
        name: 'connect_chrome',
        status: 'Connecting to your browser…',
        description:
          "Connect Eya to the user's own browser (Edge or Chrome) — the one they are already signed in to — so she can open and use their " +
          'real tabs. Call this when the user asks to connect or use their own browser, or when a task needs their signed-in accounts ' +
          'and a result says their browser is not connected. The first time, the user has to add the Eya Browser Bridge extension ' +
          'themselves (the result says exactly how); after that it connects on its own.',
        args: {},
      },
      async execute(): Promise<ToolResult> {
        try {
          const r = await connector.connect();
          if (r.connected) {
            return {
              ok: true,
              summary: r.alreadyConnected ? 'already connected' : 'connected',
              data: { connected: true, ...(r.browser !== undefined ? { browser: r.browser } : {}) },
            };
          }
          return {
            ok: false,
            summary: 'waiting for you',
            error:
              'Your browser has not connected yet. ' +
              (r.helpOpened
                ? "I opened the browser's extensions page and the extension folder. One time only: turn on Developer mode (and leave it on — the browser switches an unpacked extension off at its next restart if it is off), click Load unpacked, and choose the folder called eya-chrome-extension. "
                : '') +
              'Once that is done it connects by itself — tell me and I will check.',
            data: {
              connected: false,
              extensionFolder: r.extensionFolder,
              steps: [
                'Open the browser extensions page (edge://extensions or chrome://extensions).',
                'Turn on Developer mode, and leave it on (with it off, the browser disables the extension at its next restart).',
                'Click Load unpacked and choose the folder eya-chrome-extension.',
                'If the extension is already there but switched off, switch it on.',
                'Say "connect my browser" again.',
              ],
            },
          };
        } catch (err) {
          return failure('could not connect', 'I could not connect to your browser', err);
        }
      },
    });
  }

  return tools;
}
