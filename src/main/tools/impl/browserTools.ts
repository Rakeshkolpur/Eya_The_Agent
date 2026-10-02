import { parseWebUrl } from './openTools';
import type { BrowserAutomationService } from '@main/browser/BrowserAutomationService';
import { LoopGuard, pageFingerprint } from '@main/browser/loopGuard';
import type { PageSnapshot } from '@main/browser/pageSnapshot';
import type { Tool, ToolArgs, ToolResult } from '../types';

/**
 * Real, DOM-aware website navigation: open a page, see what is actually on
 * it, click something by its visible text, fill a visible field. The point
 * of this file is the one rule that used to be missing — "go to Cause List"
 * must click the real Cause List link on the page that is already open, not
 * turn into a web search or an invented URL. See the system prompt's
 * "Navigating a website" section for how the model is told to use these.
 */

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
    ...(s.truncated ? { truncated: true } : {}),
  };
}

interface PageChange {
  /** Anything the model could see on the page differs from before — including a menu that just expanded. */
  readonly stateChanged: boolean;
  /** The address itself moved, as opposed to the same page rearranging. */
  readonly navigated: boolean;
}

/** A fresh look at the page, every time — the only state a tool result is ever built from. */
function currentPageData(action: string, target: string | null, change: PageChange, snapshot: PageSnapshot): Record<string, unknown> {
  return {
    action,
    ...(target !== null ? { target } : {}),
    stateChanged: change.stateChanged,
    navigated: change.navigated,
    currentPage: snapshotFields(snapshot),
  };
}

function changeBetween(before: PageSnapshot | null, after: PageSnapshot): PageChange {
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

export function createBrowserTools(service: BrowserAutomationService, guard: LoopGuard = new LoopGuard()): Tool[] {
  const openWebsite: Tool = {
    schema: {
      name: 'open_website',
      status: 'Opening the website…',
      description:
        'Open a website by its exact https:// URL. This becomes the current page for inspect_page, click_on_page ' +
        "and fill_on_page. If you don't already know a site's exact official URL (e.g. for \"the High Court of " +
        'Telangana\" or \"my bank\"), use web_search first to find and confirm it, then call this with that exact ' +
        'URL — never invent one, and never treat opening a site as the same thing as searching for it.',
      args: { url: { type: 'string', required: true, description: 'The exact http(s) address to open, e.g. from a web_search result.' } },
    },
    async execute(args): Promise<ToolResult> {
      const raw = stringArg(args, 'url');
      if (raw === undefined) return { ok: false, summary: 'no url', error: 'A URL is required.' };
      const url = parseWebUrl(raw);
      if (url === null) return { ok: false, summary: 'bad url', error: 'That is not a normal http or https address.' };
      try {
        const snapshot = await service.openWebsite(url.href);
        return {
          ok: true,
          summary: `opened ${snapshot.title || url.hostname}`,
          data: currentPageData('open', url.href, { stateChanged: true, navigated: true }, snapshot),
        };
      } catch (err) {
        return { ok: false, summary: 'could not open', error: `I could not open that website: ${describeError(err)}` };
      }
    },
  };

  const inspectPage: Tool = {
    schema: {
      name: 'inspect_page',
      status: 'Looking at the page…',
      description:
        'See what is actually on the currently open web page right now: its headings, visible links, buttons and ' +
        'form fields. Use this before click_on_page or fill_on_page whenever you have not just seen the current ' +
        'page, or to find out what options a page genuinely offers instead of assuming or remembering from training.',
      args: {},
    },
    async execute(): Promise<ToolResult> {
      try {
        const snapshot = await service.inspectPage();
        return {
          ok: true,
          summary: `looked at ${snapshot.title || snapshot.url}`,
          data: currentPageData('inspect', null, { stateChanged: false, navigated: false }, snapshot),
        };
      } catch {
        return { ok: false, summary: 'no page open', error: 'No website is open yet. Use open_website first.' };
      }
    },
  };

  const clickOnPage: Tool = {
    schema: {
      name: 'click_on_page',
      status: 'Clicking that…',
      description:
        'Click a link, button or menu item that is actually visible on the web page that is currently open, by its ' +
        'visible text (e.g. "Cause List", "Sent", "My Orders", "Sign in", "Search"). Use this to navigate WITHIN a ' +
        'website that is already open — never web_search or open_url for that: those search the internet or load an ' +
        'unrelated page, not the thing the user is pointing at on the page in front of them. If nothing on the page ' +
        'matches, the result tells you what actually IS there, so you can try different wording or ask the user — ' +
        'never guess a URL instead. The result always reflects the page exactly as it is after this click, including ' +
        'anything unexpected that appeared (a popup, a login prompt, a different page than you might have guessed) — ' +
        'read it fresh each time rather than assuming what should be there.',
      args: { text: { type: 'string', required: true, description: 'The visible text of the link, button or menu item to click.' } },
    },
    async execute(args): Promise<ToolResult> {
      const text = stringArg(args, 'text');
      if (text === undefined) return { ok: false, summary: 'no text', error: 'Text to click is required.' };
      const before = await lookBefore(service);
      if (before !== null) {
        const fingerprint = pageFingerprint(before);
        if (guard.isLoop(fingerprint, 'click', text)) return loopResult('clicking', text, 'click', before, guard.maxRepeats);
        guard.record(fingerprint, 'click', text);
      }
      try {
        const result = await service.clickOnPage(text);
        if (!result.ok) {
          return {
            ok: false,
            summary: 'not found',
            error: `"${text}" isn't visible on the current page.`,
            data: currentPageData('click', text, { stateChanged: false, navigated: false }, result.snapshot),
          };
        }
        return {
          ok: true,
          summary: `clicked "${text}"`,
          data: currentPageData('click', text, changeBetween(before, result.snapshot), result.snapshot),
        };
      } catch (err) {
        return { ok: false, summary: 'click failed', error: `I could not click that: ${describeError(err)}` };
      }
    },
  };

  const fillOnPage: Tool = {
    schema: {
      name: 'fill_on_page',
      status: 'Filling that in…',
      description:
        'Fill a visible form field on the currently open page by its label or placeholder (e.g. "Advocate Code", ' +
        '"Email", "Search"). Use this instead of guessing how a form works. To then submit, use click_on_page with ' +
        "the visible text of the submit/search button — there is no separate submit tool. If the field can't be " +
        'found, the result shows what fields actually ARE on the page.',
      args: {
        label: { type: 'string', required: true, description: "The field's visible label or placeholder." },
        value: { type: 'string', required: true, description: 'What to type into it.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const label = stringArg(args, 'label');
      const value = stringArg(args, 'value');
      if (label === undefined || value === undefined) {
        return { ok: false, summary: 'missing arguments', error: 'A field label and a value are required.' };
      }
      const before = await lookBefore(service);
      if (before !== null) {
        const fingerprint = pageFingerprint(before);
        // The value is part of what makes this attempt "the same one": typing a different value is a new try.
        if (guard.isLoop(fingerprint, 'fill', `${label}=${value}`)) {
          return loopResult('filling in', label, 'fill', before, guard.maxRepeats);
        }
        guard.record(fingerprint, 'fill', `${label}=${value}`);
      }
      try {
        const result = await service.fillOnPage(label, value);
        if (!result.ok) {
          return {
            ok: false,
            summary: 'not found',
            error: `No field matching "${label}" is visible on the current page.`,
            data: currentPageData('fill', label, { stateChanged: false, navigated: false }, result.snapshot),
          };
        }
        return {
          ok: true,
          summary: `filled "${label}"`,
          data: currentPageData('fill', label, changeBetween(before, result.snapshot), result.snapshot),
        };
      } catch (err) {
        return { ok: false, summary: 'fill failed', error: `I could not fill that in: ${describeError(err)}` };
      }
    },
  };

  return [openWebsite, inspectPage, clickOnPage, fillOnPage];
}
