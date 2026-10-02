import { parseWebUrl } from './openTools';
import type { ActOnPageResult, BrowserAutomationService, BrowserTabControl, ClickGate } from '@main/browser/BrowserAutomationService';
import { challengeMessage, isBlockingChallenge } from '@main/browser/challenges';
import { BrowserUnavailableError } from '@main/browser/errors';
import { LoopGuard, pageFingerprint } from '@main/browser/loopGuard';
import type { ActionEffects, DownloadInfo } from '@main/browser/pageEffects';
import type { PageContext } from '@main/browser/sensitiveActions';
import { sensitiveActionReason, sensitiveSubmitReason } from '@main/browser/sensitiveActions';
import type { PageSnapshot } from '@main/browser/pageSnapshot';
import type { BrowserOverview, WaitForUserResult } from '@main/browser/BrowserSessionManager';
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

/** What the status and "wait for the user" tools need from the session manager. */
export interface BrowserSessionTools {
  describe(): BrowserOverview;
  waitForUserChange(timeoutMs?: number): Promise<WaitForUserResult>;
}

export interface BrowserToolOptions {
  /** Present when the user's own browser can be reached: enables listing and switching tabs. */
  readonly tabs?: BrowserTabControl;
  /** Present when the Eya Browser Bridge can be set up: enables connect_chrome. */
  readonly connector?: ChromeConnector;
  /** Present with the session manager: enables browser_status and wait_for_user_in_browser. */
  readonly session?: BrowserSessionTools;
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
    ...(s.moreLinks !== undefined ? { moreLinks: s.moreLinks } : {}),
    // The site's own menu bar / header / footer, apart from the page's links (and not repeated when unchanged).
    ...(s.navigation !== undefined ? { navigation: s.navigation } : {}),
    ...(s.navigationSameAsPrevious !== undefined ? { navigationSameAsPreviousPage: `${s.navigationSameAsPrevious} menu items, unchanged` } : {}),
    // Real links that only a closed (hover / click-to-open) menu is holding, by menu.
    ...(s.collapsedMenus !== undefined ? { linksInsideClosedMenus: s.collapsedMenus } : {}),
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

function unavailable(err: BrowserUnavailableError): ToolResult {
  return {
    ok: false,
    summary: 'browser not connected',
    error: err.message,
    data: {
      browserUnavailable: true,
      ...(err.detail.why !== undefined ? { why: err.detail.why } : {}),
      ...(err.detail.needsPairing !== undefined ? { needsPairing: err.detail.needsPairing } : {}),
    },
  };
}

function failure(summary: string, prefix: string, err: unknown): ToolResult {
  if (err instanceof BrowserUnavailableError) return unavailable(err);
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
        'URL — never invent one, and never treat opening a site as the same thing as searching for it. This always ' +
        "happens in the user's OWN browser (Chrome or Edge), reusing a tab they already have open on that site if there is " +
        "one, else a new tab in the same browser — so their sign-ins are already there. If their browser is not connected " +
        'the result says why and what to do (usually: call connect_chrome); in that case do NOT retry with isolated. ' +
        "isolated: true opens Eya's own separate window instead, which starts signed out of everything — only ever set it " +
        'after the user has said that is fine.',
      args: {
        url: { type: 'string', required: true, description: 'The exact http(s) address to open, e.g. from a web_search result.' },
        isolated: { type: 'boolean', description: "Open in Eya's own separate, signed-out window instead of the user's browser. Only after the user agreed to that." },
      },
    },
    async execute(args): Promise<ToolResult> {
      const raw = stringArg(args, 'url');
      if (raw === undefined) return { ok: false, summary: 'no url', error: 'A URL is required.' };
      const url = parseWebUrl(raw);
      if (url === null) return { ok: false, summary: 'bad url', error: 'That is not a normal http or https address.' };
      try {
        const snapshot = await service.openWebsite(url.href, args['isolated'] === true ? { isolated: true } : undefined);
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
        'See what is actually on the currently open web page right now: its headings, the page\'s own links (`links`), the ' +
        'site menu bar apart from them (`navigation`), links held by closed menus (`linksInsideClosedMenus`), buttons and ' +
        'form fields, plus a short piece of its text and any table. Use this before click_on_page or fill_on_page whenever ' +
        'you have not just seen the current page, or to look again after the user has done something themselves (signed in, ' +
        'solved a CAPTCHA). The lists show the first screenful only — if the option you need is not there, use ' +
        'find_on_page (search the whole page) or read_page (read its text) rather than concluding it does not exist.',
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
        if (err instanceof BrowserUnavailableError) return unavailable(err);
        return { ok: false, summary: 'no page open', error: 'No website is open yet. Use open_website first.' };
      }
    },
  };

  const findOnPage: Tool = {
    schema: {
      name: 'find_on_page',
      status: 'Looking through the page…',
      description:
        'Search the WHOLE current page for something by its words — everything showing, everything further down, links that ' +
        "sit inside menus that are closed until opened or hovered, and the page's own text — and say where each match is. " +
        'Use it whenever the option you need is not in the lists inspect_page / the last result showed (those only list the ' +
        'first screenful: a long page, a big menu bar or a hover menu can hold the link you want beyond them), or to check ' +
        'where a word appears before deciding. It never clicks anything: once you have the exact name, use click_on_page.',
      args: { query: { type: 'string', required: true, description: 'What to look for, e.g. "cause list", "orders", "advocate code".' } },
    },
    async execute(args): Promise<ToolResult> {
      const query = stringArg(args, 'query');
      if (query === undefined) return { ok: false, summary: 'no query', error: 'Something to look for is required.' };
      try {
        const r = await service.findOnPage(query);
        const none = r.matches.length === 0 && r.textMatches.length === 0;
        return {
          ok: true,
          summary: none ? `nothing on the page matches "${query}"` : `found ${r.matches.length} match${r.matches.length === 1 ? '' : 'es'} for "${query}"`,
          data: {
            action: 'find',
            query,
            url: r.url,
            title: r.title,
            matches: r.matches,
            ...(r.textMatches.length > 0 ? { pageTextMentions: r.textMatches } : {}),
            controlsOnPage: r.totalControls,
            ...(none
              ? { hint: 'Nothing matches those words. Try other words for the same thing, look at the options the page does have (inspect_page), or ask the user — do not invent an address.' }
              : {}),
          },
        };
      } catch (err) {
        if (err instanceof BrowserUnavailableError) return unavailable(err);
        return { ok: false, summary: 'no page open', error: 'No website is open yet. Use open_website first.' };
      }
    },
  };

  const readPage: Tool = {
    schema: {
      name: 'read_page',
      status: 'Reading the page…',
      description:
        "Read the current page's actual text, a slice at a time, so you can answer questions about what it says (a notice, " +
        'a list of results, a policy, a price, a status) instead of only knowing its link names. The first slice also carries ' +
        "the page's tables. If the result has nextOffset, call read_page again with that offset to carry on reading; stop " +
        'as soon as you have what you need.',
      args: { offset: { type: 'number', description: 'Where to start reading, from the previous result\'s nextOffset. Omit to start at the top.' } },
    },
    async execute(args): Promise<ToolResult> {
      const offset = typeof args['offset'] === 'number' && Number.isFinite(args['offset']) ? args['offset'] : 0;
      try {
        const r = await service.readPage(offset);
        return {
          ok: true,
          summary: r.text === '' ? 'the page has no readable text' : `read ${r.text.length} characters of ${r.totalChars}`,
          data: {
            action: 'read',
            url: r.url,
            title: r.title,
            text: r.text,
            offset: r.offset,
            totalChars: r.totalChars,
            ...(r.nextOffset !== null ? { nextOffset: r.nextOffset } : { endOfPage: true }),
            ...(r.tables !== undefined ? { tables: r.tables } : {}),
          },
        };
      } catch (err) {
        if (err instanceof BrowserUnavailableError) return unavailable(err);
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

  /** Back, forward and reload are the same kind of step: move in the browser, then look at where it landed. */
  function historyTool(name: string, status: string, description: string, action: string, verb: string, run: () => Promise<ActOnPageResult>): Tool {
    return {
      schema: { name, status, description, args: {} },
      async execute(): Promise<ToolResult> {
        const before = await lookBefore(service);
        try {
          const result = await run();
          if (!result.ok) return declined(result, action, action, verb);
          return succeeded(action, null, verb, before, result);
        } catch (err) {
          return failure(`${verb} failed`, `I could not ${verb}`, err);
        }
      },
    };
  }

  const goBack = historyTool(
    'go_back',
    'Going back…',
    "Go back one page in the browser history of the page Eya is working in — the same as the browser's Back button. Use it when a " +
      'click took the wrong way, instead of guessing a URL. The result is the page you land on.',
    'back',
    'went back',
    () => service.goBack(),
  );
  const goForward = historyTool(
    'go_forward',
    'Going forward…',
    "Go forward one page in the browser history (the browser's Forward button), after going back. The result is the page you land on.",
    'forward',
    'went forward',
    () => service.goForward(),
  );
  const reloadPage = historyTool(
    'reload_page',
    'Reloading the page…',
    'Reload the current page and look at it again — for a page that looks stuck, stale or half-loaded.',
    'reload',
    'reloaded the page',
    () => service.reload(),
  );

  const scrollPage: Tool = {
    schema: {
      name: 'scroll_page',
      status: 'Scrolling…',
      description:
        'Scroll the current page (or the panel it scrolls inside) and look at what is showing afterwards: down or up by a screenful, ' +
        'or straight to the top or bottom. Use it to move through a long page, or to load more of an endless list. To find a specific ' +
        'option on a long page use find_on_page instead. If the result says the page did not move, there is nothing more that way.',
      args: {
        direction: { type: 'string', required: true, enum: ['down', 'up', 'top', 'bottom'], description: 'Which way to go.' },
        amount: { type: 'number', description: 'How far, in pixels. Omit for about one screenful.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const direction = args['direction'];
      if (direction !== 'down' && direction !== 'up' && direction !== 'top' && direction !== 'bottom') {
        return { ok: false, summary: 'no direction', error: 'A direction (down, up, top or bottom) is required.' };
      }
      const amount = typeof args['amount'] === 'number' && args['amount'] > 0 ? args['amount'] : undefined;
      const before = await lookBefore(service);
      try {
        const result = await service.scroll(direction, amount);
        if (!result.ok) return declined(result, 'scroll', direction, 'scroll');
        return succeeded('scroll', direction, `scrolled ${direction}`, before, result);
      } catch (err) {
        return failure('scroll failed', 'I could not scroll', err);
      }
    },
  };

  const tools: Tool[] = [openWebsite, inspectPage, findOnPage, readPage, clickOnPage, fillOnPage, scrollPage, goBack, goForward, reloadPage];

  const tabs = options.tabs;
  if (tabs !== undefined) {
    tools.push(
      {
        schema: {
          name: 'list_browser_tabs',
          status: 'Checking your open tabs…',
          description:
            "List the tabs open in the user's own browser(s) — Chrome and/or Edge, each tab with the browser it is in, its title and its " +
            'address — so you can switch to one they already have open, e.g. "go to my Gmail tab". Only works when a browser is connected. ' +
            'Only call it when the request needs it.',
          args: { browser: { type: 'string', enum: ['chrome', 'edge'], description: 'Only this browser\'s tabs. Omit for all connected browsers.' } },
        },
        async execute(args): Promise<ToolResult> {
          const which = args['browser'] === 'chrome' || args['browser'] === 'edge' ? args['browser'] : undefined;
          try {
            const list = await tabs.listTabs(which);
            return {
              ok: true,
              summary: `${list.length} tab${list.length === 1 ? '' : 's'} open`,
              data: {
                tabs: list.map((t) => ({
                  ...(t.browser !== undefined ? { browser: t.browser } : {}),
                  tabId: t.tabId,
                  title: t.title,
                  url: t.url,
                  ...(t.active ? { activeInBrowser: true } : {}),
                  ...(t.workingHere ? { eyaIsHere: true } : {}),
                  ...(t.openedByEya ? { openedByEya: true } : {}),
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
            "Switch to one of the user's already-open browser tabs (the tabId, and its browser, from list_browser_tabs) and look at it. " +
            'Eya then works in that tab. Tab numbers repeat across browsers, so say which browser when both Chrome and Edge are connected.',
          args: {
            tab_id: { type: 'number', required: true, description: 'The tabId from list_browser_tabs.' },
            browser: { type: 'string', enum: ['chrome', 'edge'], description: 'The browser that tab is in (needed when more than one is connected).' },
          },
        },
        async execute(args): Promise<ToolResult> {
          const id = args['tab_id'];
          if (typeof id !== 'number' || !Number.isInteger(id)) return { ok: false, summary: 'no tab', error: 'A tab_id from list_browser_tabs is required.' };
          const which = args['browser'] === 'chrome' || args['browser'] === 'edge' ? args['browser'] : undefined;
          try {
            const snapshot = await tabs.switchToTab(id, which);
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
      {
        schema: {
          name: 'close_browser_tab',
          status: 'Closing the tab…',
          description:
            'Close a browser tab (the tabId, and its browser, from list_browser_tabs). A tab Eya opened herself closes straight away. ' +
            "A tab the USER opened is not closed on the first call — you get a question to put to them, and only after they clearly say " +
            'yes do you call again with confirm: true, because closing it can lose what they were doing there.',
          args: {
            tab_id: { type: 'number', required: true, description: 'The tabId from list_browser_tabs.' },
            browser: { type: 'string', enum: ['chrome', 'edge'], description: 'The browser that tab is in (needed when more than one is connected).' },
            confirm: { type: 'boolean', description: 'Set true ONLY after the user has clearly agreed to closing this tab of theirs.' },
          },
        },
        async execute(args): Promise<ToolResult> {
          const id = args['tab_id'];
          if (typeof id !== 'number' || !Number.isInteger(id)) return { ok: false, summary: 'no tab', error: 'A tab_id from list_browser_tabs is required.' };
          const which = args['browser'] === 'chrome' || args['browser'] === 'edge' ? args['browser'] : undefined;
          try {
            const listed = (await tabs.listTabs(which)).find((t) => t.tabId === id && (which === undefined || t.browser === which));
            if (listed === undefined) return { ok: false, summary: 'no such tab', error: 'That tab is not open (any more). Use list_browser_tabs to see the current ones.' };
            if (!listed.openedByEya && args['confirm'] !== true) {
              return {
                ok: false,
                summary: 'needs confirmation',
                error: `That tab ("${listed.title}") was opened by the user, so it was not closed. Ask them plainly whether to close it, and only if they clearly say yes call close_browser_tab again with confirm: true.`,
                data: permissionRequest('close_browser_tab', listed.title || listed.url, 'Closing a tab of yours can lose what you were doing in it.'),
              };
            }
            const closed = await tabs.closeTab(id, { ...(which !== undefined ? { browser: which } : {}), allowUserTab: !listed.openedByEya });
            return {
              ok: closed.closed,
              summary: closed.closed ? `closed the tab "${listed.title}"` : 'the tab did not close',
              data: { closed: closed.closed, remainingTabs: closed.remainingTabs },
            };
          } catch (err) {
            return failure('could not close', 'I could not close that tab', err);
          }
        },
      },
    );
  }

  const session = options.session;
  if (session !== undefined) {
    tools.push(
      {
        schema: {
          name: 'browser_status',
          status: 'Checking the browsers…',
          description:
            "Report which of the user's browsers (Chrome, Edge) are connected to Eya, whether one has the Eya Browser Bridge extension " +
            'running but not yet connected, how many tabs each has, which one is in use, and which one Eya is working in. Use it to ' +
            'diagnose why a browser task cannot start, or to answer "is my browser connected?".',
          args: {},
        },
        async execute(): Promise<ToolResult> {
          const o = session.describe();
          const connected = o.browsers.filter((b) => b.connected);
          return {
            ok: true,
            summary: connected.length > 0 ? `${connected.map((b) => b.browser).join(' and ')} connected` : 'no browser connected',
            data: {
              mode: o.mode,
              browsers: o.browsers,
              ...(o.waitingToPair.length > 0 ? { extensionRunningButNotConnected: o.waitingToPair, hint: 'Ask the user whether to connect it, then call connect_chrome.' } : {}),
              ...(o.workingIn !== null ? { workingIn: o.workingIn, ...(o.workingBrowser !== undefined ? { workingBrowser: o.workingBrowser } : {}) } : {}),
              ...(connected.length === 0 && o.waitingToPair.length === 0 ? { hint: 'No extension is connected. Call connect_chrome to help the user add or connect it.' } : {}),
            },
          };
        },
      },
      {
        schema: {
          name: 'wait_for_user_in_browser',
          status: 'Waiting for you in the browser…',
          description:
            'Use this right after telling the user that a page needs THEM — signing in, a CAPTCHA, a verification code. It waits (up to ~30 ' +
            'seconds per call) for the page to change, and then returns the page as it now is, so you can carry on with their ORIGINAL request ' +
            'without them having to repeat it. If it returns changed: true, look at the page and continue the task. If it returns ' +
            'stillWaiting: true, they have not finished yet: call it again once or twice, then say you will carry on when they tell you.',
          args: { seconds: { type: 'number', description: 'How long to wait this time, up to 30. Default 25.' } },
        },
        async execute(args): Promise<ToolResult> {
          const seconds = typeof args['seconds'] === 'number' && args['seconds'] > 0 ? Math.min(30, args['seconds']) : 25;
          try {
            const r = await session.waitForUserChange(seconds * 1000);
            if (!r.changed) {
              return {
                ok: true,
                summary: 'still waiting for the user',
                data: { stillWaiting: true, ...currentPageData('wait', null, { stateChanged: false, navigated: false }, r.snapshot) },
              };
            }
            return applyChallenge(
              {
                ok: true,
                summary: r.cleared !== undefined ? 'the user finished — the page has moved on' : 'the page changed',
                data: {
                  userFinished: true,
                  ...(r.cleared !== undefined ? { cleared: r.cleared } : {}),
                  ...currentPageData('wait', null, { stateChanged: true, navigated: true }, r.snapshot),
                },
              },
              r.snapshot,
            );
          } catch (err) {
            return failure('could not wait', 'I could not watch the page', err);
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
          "Connect Eya to the user's own browser(s) — Chrome and/or Edge, the ones they are already signed in to — so she can open and use their " +
          'real tabs. Call this when the user asks to connect or use their own browser, when a result says a browser extension is running but ' +
          'not connected, or when a task needs their signed-in accounts and no browser is connected. The first time, the user has to add the ' +
          'Eya Browser Bridge extension themselves (the result says exactly how); after that it connects on its own. Every browser whose ' +
          'extension is running is connected in one go. It does NOT keep opening the extensions page and the extension folder: that happens ' +
          'only when the extension has never been seen, and once per run. Set showExtensionFolder only when the user asks to see the folder ' +
          'or says the extension is not installed in their browser.',
        args: {
          showExtensionFolder: {
            type: 'boolean',
            description: "Open the browser's extensions page and the extension folder. Only when the user asked for it, or says the extension is missing from their browser.",
          },
        },
      },
      async execute(args): Promise<ToolResult> {
        try {
          const r = await connector.connect(undefined, { showInstallHelp: args['showExtensionFolder'] === true });
          if (r.connected) {
            return {
              ok: true,
              summary: r.alreadyConnected ? 'already connected' : `connected ${r.browsers.join(' and ')}`,
              data: {
                connected: true,
                browsers: r.browsers,
                ...(r.stillWaiting.length > 0 ? { notYetConnected: r.stillWaiting, hint: 'Another browser has the extension running but did not connect in time; ask again if the user wants it too.' } : {}),
              },
            };
          }
          if (r.extensionSeen && !r.helpOpened) {
            // Set up before, just not answering now: nothing is missing, so nothing was opened and nothing needs installing again.
            return {
              ok: false,
              summary: 'extension not answering',
              error:
                'The Eya Browser Bridge extension was set up before, so nothing needs installing again — it just is not answering right now. ' +
                'I did not open the extensions page or the folder. Ask the user to check three things: the browser is open; the extension is switched on ' +
                'and Developer mode is on at its extensions page; and, if the extension says it needs an update, to click its reload button (a newer Eya ' +
                'needs the extension reloaded once). Then they can say "connect my browser" again. If the extension is not in the browser at all, ' +
                'say so and I will open its folder.',
              data: {
                connected: false,
                extensionInstalled: true,
                steps: [
                  'Make sure the browser (Chrome or Edge) is open.',
                  'At chrome://extensions or edge://extensions, make sure Developer mode is on and "Eya Browser Bridge" is switched on.',
                  'If it says it needs an update, or after updating Eya, click its reload button.',
                  'Say "connect my browser" again.',
                ],
              },
            };
          }
          return {
            ok: false,
            summary: 'waiting for you',
            error:
              'Your browser has not connected yet. ' +
              (r.helpOpened
                ? "I opened the browser's extensions page and the extension folder. One time only: turn on Developer mode (and leave it on — the browser switches an unpacked extension off at its next restart if it is off), click Load unpacked, and choose the folder called eya-chrome-extension. "
                : 'I already opened the extensions page and the extension folder earlier, so I did not open them again; the extension still has to be added once. ') +
              'Once that is done it connects by itself — tell me and I will check.',
            data: {
              connected: false,
              extensionFolder: r.extensionFolder,
              steps: [
                'Open the browser extensions page (chrome://extensions or edge://extensions).',
                'Turn on Developer mode, and leave it on (with it off, the browser disables the extension at its next restart).',
                'Click Load unpacked and choose the folder eya-chrome-extension.',
                'If the extension is already there but switched off, switch it on; if it says it needs an update, click its reload button.',
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
