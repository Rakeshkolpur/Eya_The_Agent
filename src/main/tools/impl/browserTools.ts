import { parseWebUrl } from './openTools';
import type { BrowserAutomationService } from '@main/browser/BrowserAutomationService';
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

function snapshotData(s: PageSnapshot): Record<string, unknown> {
  return {
    url: s.url,
    title: s.title,
    headings: s.headings,
    links: s.links,
    buttons: s.buttons,
    inputs: s.inputs,
    ...(s.truncated ? { truncated: true } : {}),
  };
}

export function createBrowserTools(service: BrowserAutomationService): Tool[] {
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
        return { ok: true, summary: `opened ${snapshot.title || url.hostname}`, data: snapshotData(snapshot) };
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
        return { ok: true, summary: `looked at ${snapshot.title || snapshot.url}`, data: snapshotData(snapshot) };
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
        'never guess a URL instead.',
      args: { text: { type: 'string', required: true, description: 'The visible text of the link, button or menu item to click.' } },
    },
    async execute(args): Promise<ToolResult> {
      const text = stringArg(args, 'text');
      if (text === undefined) return { ok: false, summary: 'no text', error: 'Text to click is required.' };
      try {
        const result = await service.clickOnPage(text);
        if (!result.ok) {
          return {
            ok: false,
            summary: 'not found',
            error: `"${text}" isn't visible on the current page.`,
            data: snapshotData(result.snapshot),
          };
        }
        return { ok: true, summary: `clicked "${text}"`, data: snapshotData(result.snapshot) };
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
      try {
        const result = await service.fillOnPage(label, value);
        if (!result.ok) {
          return {
            ok: false,
            summary: 'not found',
            error: `No field matching "${label}" is visible on the current page.`,
            data: snapshotData(result.snapshot),
          };
        }
        return { ok: true, summary: `filled "${label}"`, data: snapshotData(result.snapshot) };
      } catch (err) {
        return { ok: false, summary: 'fill failed', error: `I could not fill that in: ${describeError(err)}` };
      }
    },
  };

  return [openWebsite, inspectPage, clickOnPage, fillOnPage];
}
