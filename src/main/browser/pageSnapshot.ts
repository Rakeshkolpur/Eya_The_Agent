/**
 * A simplified "what a human would see" summary of a web page — headings,
 * visible links, buttons and form fields — used so the model can navigate a
 * website by reasoning over what is actually there, rather than guessing a
 * URL or turning "go to X" into a web search.
 */
export interface PageSnapshot {
  readonly url: string;
  readonly title: string;
  readonly headings: readonly string[];
  readonly links: readonly string[];
  readonly buttons: readonly string[];
  readonly inputs: readonly string[];
  /** A visible modal/dialog/alert box's own text, if one is open — e.g. a login prompt, a warning, a cookie banner. Empty when there isn't one. */
  readonly dialogs: readonly string[];
  readonly truncated: boolean;
  /** Plain text of the page's main area (capped) — what a person would read, as opposed to what they could click. */
  readonly visibleText?: string;
  readonly tables?: readonly SnapshotTable[];
  /** The control that has keyboard focus, by name. Sensitive fields are never named. */
  readonly focused?: string;
  readonly scroll?: { readonly y: number; readonly max: number; readonly atBottom: boolean };
  /** Present when the page is showing a CAPTCHA / bot check / verification-code prompt / sign-in wall. */
  readonly challenge?: PageChallenge;
  /** Plain-language caveats about this look at the page (still loading, frames that can't be seen into, …). */
  readonly notes?: readonly string[];
  /** Which browser this is: the user's own signed-in one, or Eya's separate automation window. */
  readonly environment?: BrowserEnvironment;
  /** Links in the site's menu bar / header / footer — kept apart so they cannot crowd the page's own options out of `links`. */
  readonly navigation?: readonly string[];
  /** The menu bar is the same one as on the page before, so it is not listed again. The number is how many items it has. */
  readonly navigationSameAsPrevious?: number;
  /** Links that exist on the page but sit inside a menu that is closed until opened or hovered, grouped by the menu they live in. */
  readonly collapsedMenus?: Readonly<Record<string, readonly string[]>>;
  /** How many more links the page has than `links` shows. */
  readonly moreLinks?: number;
  /** Delivery marks beside messages that were sent ("sent", "pending", "failed to send"…), oldest first — never the messages. */
  readonly messageStatus?: readonly string[];
}

export type BrowserEnvironment = 'your_browser' | 'eya_browser';

export interface SnapshotTable {
  readonly caption?: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly totalRows: number;
}

export type ChallengeKind = 'captcha' | 'bot_check' | 'mfa' | 'login';

export interface PageChallenge {
  readonly kind: ChallengeKind;
  readonly hint: string;
}

/** Everything beyond the plain lists, all optional — only the richer browser fills these in. */
export interface SnapshotExtras {
  readonly visibleText?: string;
  readonly tables?: readonly SnapshotTable[];
  readonly focused?: string;
  readonly scroll?: { readonly y: number; readonly max: number; readonly atBottom: boolean };
  readonly challenge?: PageChallenge;
  readonly notes?: readonly string[];
  readonly environment?: BrowserEnvironment;
  readonly navigation?: readonly string[];
  readonly navigationSameAsPrevious?: number;
  readonly collapsedMenus?: Readonly<Record<string, readonly string[]>>;
  readonly messageStatus?: readonly string[];
}

const MAX_ITEMS_PER_CATEGORY = 40;
// The page's own links are the options the user is asking about, so they get the most room.
const MAX_LINKS = 80;
const MAX_NAVIGATION = 60;
const MAX_MENUS = 10;
const MAX_ITEMS_PER_MENU = 14;

function dedupeNonEmpty(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const t = r.trim().replace(/\s+/g, ' ');
    if (t.length === 0) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Cleans, dedupes and caps raw text pulled from the page into a snapshot the model can read. */
export function buildSnapshot(
  url: string,
  title: string,
  rawHeadings: readonly string[],
  rawLinks: readonly string[],
  rawButtons: readonly string[],
  rawInputs: readonly string[],
  rawDialogs: readonly string[] = [],
  extras: SnapshotExtras = {},
): PageSnapshot {
  const headings = dedupeNonEmpty(rawHeadings);
  const links = dedupeNonEmpty(rawLinks);
  const buttons = dedupeNonEmpty(rawButtons);
  const inputs = dedupeNonEmpty(rawInputs);
  const dialogs = dedupeNonEmpty(rawDialogs);
  const navigation = dedupeNonEmpty(extras.navigation ?? []);
  const truncated =
    headings.length > MAX_ITEMS_PER_CATEGORY ||
    links.length > MAX_LINKS ||
    buttons.length > MAX_ITEMS_PER_CATEGORY ||
    inputs.length > MAX_ITEMS_PER_CATEGORY;
  const menuEntries = Object.entries(extras.collapsedMenus ?? {})
    .map(([menu, items]): [string, string[]] => [menu, dedupeNonEmpty(items).slice(0, MAX_ITEMS_PER_MENU)])
    .filter(([, items]) => items.length > 0)
    .slice(0, MAX_MENUS);
  return {
    url,
    title,
    headings: headings.slice(0, MAX_ITEMS_PER_CATEGORY),
    links: links.slice(0, MAX_LINKS),
    buttons: buttons.slice(0, MAX_ITEMS_PER_CATEGORY),
    inputs: inputs.slice(0, MAX_ITEMS_PER_CATEGORY),
    dialogs: dialogs.slice(0, MAX_ITEMS_PER_CATEGORY),
    truncated,
    ...(links.length > MAX_LINKS ? { moreLinks: links.length - MAX_LINKS } : {}),
    ...(navigation.length > 0 && extras.navigationSameAsPrevious === undefined ? { navigation: navigation.slice(0, MAX_NAVIGATION) } : {}),
    ...(extras.navigationSameAsPrevious !== undefined ? { navigationSameAsPrevious: extras.navigationSameAsPrevious } : {}),
    ...(menuEntries.length > 0 ? { collapsedMenus: Object.fromEntries(menuEntries) } : {}),
    ...(extras.visibleText !== undefined && extras.visibleText !== '' ? { visibleText: extras.visibleText } : {}),
    ...(extras.tables !== undefined && extras.tables.length > 0 ? { tables: extras.tables } : {}),
    ...(extras.focused !== undefined ? { focused: extras.focused } : {}),
    ...(extras.scroll !== undefined ? { scroll: extras.scroll } : {}),
    ...(extras.challenge !== undefined ? { challenge: extras.challenge } : {}),
    ...(extras.notes !== undefined && extras.notes.length > 0 ? { notes: extras.notes } : {}),
    ...(extras.environment !== undefined ? { environment: extras.environment } : {}),
    ...(extras.messageStatus !== undefined && extras.messageStatus.length > 0 ? { messageStatus: extras.messageStatus } : {}),
  };
}

/** The same snapshot with extra notes appended and/or the environment stamped on. */
export function withExtras(snapshot: PageSnapshot, extras: { notes?: readonly string[]; environment?: BrowserEnvironment }): PageSnapshot {
  const notes = [...(snapshot.notes ?? []), ...(extras.notes ?? [])];
  return {
    ...snapshot,
    ...(notes.length > 0 ? { notes } : {}),
    ...(extras.environment !== undefined ? { environment: extras.environment } : {}),
  };
}

function normalizeText(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Index of the best visible candidate matching a spoken/typed target, or null
 * if nothing plausible does — exact (normalized) match wins, else the
 * shortest text containing the query as a substring, so a short query like
 * "Sent" doesn't latch onto some unrelated longer label that happens to
 * contain the same letters.
 *
 * Returns an INDEX into the given array, not the matched string itself, on
 * purpose: a real page's link/button text often comes padded with enclosing
 * whitespace and newlines from its markup (`"\n\t\t\tCause List\n\t\t"`), and
 * re-querying Playwright with that raw text via `getByRole(..., {name})`
 * does not reliably equal the ACCESSIBLE NAME the browser itself computes
 * for that element (whitespace normalization and ARIA overrides can differ
 * from a plain `.textContent()` read) — confirmed live against a real page,
 * where this mismatch made a click silently hang until timeout instead of
 * failing fast. Re-selecting by index on the exact same locator avoids ever
 * needing the two systems to agree on what counts as "the same name".
 */
export function findBestTextMatchIndex(query: string, candidates: readonly string[]): number | null {
  const q = normalizeText(query);
  if (q.length === 0) return null;
  const exactIndex = candidates.findIndex((c) => normalizeText(c) === q);
  if (exactIndex !== -1) return exactIndex;
  let bestIndex: number | null = null;
  let bestLength = Infinity;
  candidates.forEach((c, i) => {
    const norm = normalizeText(c);
    if (norm.length === 0) return;
    if (norm.includes(q) && norm.length < bestLength) {
      bestIndex = i;
      bestLength = norm.length;
    }
  });
  if (bestIndex !== null) return bestIndex;

  // A long name is shown shortened with a trailing "…", and the model may quote it shortened (or lengthen it a little
  // from the page's own text). Two names that are the same up to where one was cut off are the same thing.
  const qStem = stripTrailingEllipsis(q);
  if (qStem.length >= 15) {
    let prefixIndex: number | null = null;
    let prefixLength = Infinity;
    candidates.forEach((c, i) => {
      const stem = stripTrailingEllipsis(normalizeText(c));
      if (stem.length < 15) return;
      if ((stem.startsWith(qStem) || qStem.startsWith(stem)) && stem.length < prefixLength) {
        prefixIndex = i;
        prefixLength = stem.length;
      }
    });
    return prefixIndex;
  }
  return null;
}

function stripTrailingEllipsis(s: string): string {
  return s.replace(/(…|\.{3})\s*$/, '').trim();
}
