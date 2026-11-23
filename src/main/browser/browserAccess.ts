import type { BrowserOverview } from './BrowserSessionManager';

/**
 * What the model is told about its access to a browser, in a line or two, at the start of every request that is about a website.
 *
 * Until now it was told only which tabs were open (and nothing at all when no browser was connected). A model that is not told it HAS hands in the user's
 * browser guesses, and the guess is often "I can't interact with the browser, please share your screen". So it is told, plainly, what it can do and is
 * already allowed to do — or, when no browser is connected, exactly what is missing and what to do about it (never "share your screen instead").
 */

const NAME: Readonly<Record<string, string>> = { chrome: 'Chrome', edge: 'Edge', other: 'a browser' };
const list = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** The tools that work in a web page: how the model is told it can see and use one. */
export const BROWSER_PAGE_TOOLS = ['open_website', 'inspect_page', 'find_on_page', 'click_on_page', 'fill_on_page', 'read_page'] as const;

export function browserAccessLine(o: BrowserOverview): string {
  const connected = o.browsers.filter((b) => b.connected);
  const tools = 'open_website, inspect_page, find_on_page, click_on_page, fill_on_page and read_page';
  const never = 'Never ask the user to share their screen, or send a screenshot, for anything on a web page: you can read the page yourself, and what a tool reports is what is really there.';
  if (connected.length > 0) {
    const names = list(connected.map((b) => NAME[b.browser] ?? 'a browser'));
    const where = o.workingIn === 'eya_browser' ? ' (this task is working in Eya Browser, her own window)' : '';
    return `Browser access: the user's own ${names} ${connected.length === 1 ? 'is' : 'are'} connected to Eya${where}. You can open pages, read them, find and click controls and fill in forms in it directly with ${tools}; that is already allowed, and nothing needs setting up. ${never} If a tool fails, tell them what it reported.`;
  }
  if (o.mode === 'eya_browser') {
    return `Browser access: web tasks run in Eya Browser, Eya's own window, which needs no extension. You can open pages, read them, find and click controls and fill in forms with ${tools}. ${never}`;
  }
  if (o.outdated.length > 0) {
    return `Browser access: the Eya extension in ${list(o.outdated.map((b) => NAME[b] ?? 'a browser'))} is an older version and must be reloaded once (extensions page, the reload arrow on "Eya Browser Bridge"). Until then no page can be worked in. Say that in one sentence; do not ask the user to share their screen instead.`;
  }
  if (o.waitingToPair.length > 0) {
    return `Browser access: the Eya extension is running in ${list(o.waitingToPair.map((b) => NAME[b] ?? 'a browser'))} but is not connected to Eya yet. Call connect_chrome (it links it once, and from then on it connects by itself), tell the user in one sentence, then carry on with the request. Do not ask them to share their screen instead.`;
  }
  return `Browser access: no browser is connected to Eya right now (the Eya Browser Bridge extension is not running or not added). Call browser_status or connect_chrome and tell the user in one sentence what is missing. Do not ask them to share their screen instead: pages can only be worked in once the extension is connected.`;
}
