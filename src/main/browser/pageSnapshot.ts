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
}

const MAX_ITEMS_PER_CATEGORY = 40;

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
): PageSnapshot {
  const headings = dedupeNonEmpty(rawHeadings);
  const links = dedupeNonEmpty(rawLinks);
  const buttons = dedupeNonEmpty(rawButtons);
  const inputs = dedupeNonEmpty(rawInputs);
  const dialogs = dedupeNonEmpty(rawDialogs);
  const truncated =
    headings.length > MAX_ITEMS_PER_CATEGORY ||
    links.length > MAX_ITEMS_PER_CATEGORY ||
    buttons.length > MAX_ITEMS_PER_CATEGORY ||
    inputs.length > MAX_ITEMS_PER_CATEGORY;
  return {
    url,
    title,
    headings: headings.slice(0, MAX_ITEMS_PER_CATEGORY),
    links: links.slice(0, MAX_ITEMS_PER_CATEGORY),
    buttons: buttons.slice(0, MAX_ITEMS_PER_CATEGORY),
    inputs: inputs.slice(0, MAX_ITEMS_PER_CATEGORY),
    dialogs: dialogs.slice(0, MAX_ITEMS_PER_CATEGORY),
    truncated,
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
  return bestIndex;
}
