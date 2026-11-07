import { redactUrl } from '@main/browser/redactUrl';
import { buildSnapshot, findBestTextMatchIndex, withExtras } from '@main/browser/pageSnapshot';
import type { BrowserEnvironment, PageChallenge, PageSnapshot, SnapshotTable } from '@main/browser/pageSnapshot';

/**
 * What the extension reports about a page, and the helpers that turn it into
 * what Eya's tools show the model. The extension is trusted to be the
 * extension, but its replies are still normalised field by field: a page can
 * influence the strings in them, so nothing is assumed about shape or size.
 */

export type ElementRole =
  | 'link'
  | 'button'
  | 'input'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'switch'
  | 'menuitem'
  | 'tab'
  | 'option'
  | 'clickable'
  | 'file';

const ROLES: readonly ElementRole[] = ['link', 'button', 'input', 'select', 'checkbox', 'radio', 'switch', 'menuitem', 'tab', 'option', 'clickable', 'file'];

export interface PageElement {
  /** Valid only against the look it came from; the page refuses it if the element has changed since. */
  readonly id: string;
  readonly role: ElementRole;
  readonly name: string;
  readonly href?: string;
  readonly type?: string;
  readonly value?: string;
  readonly options?: readonly string[];
  readonly checked?: boolean;
  readonly expanded?: boolean;
  readonly disabled?: boolean;
  /** A password / card / one-time-code field: Eya neither reads nor types into it. */
  readonly sensitive?: boolean;
  /** A sensitive field that is a one-time verification code (not a password or a card number): typed only when the user said the code. */
  readonly oneTimeCode?: boolean;
  readonly region?: string;
  /** For a list row (a chat, a search result): its first line, which is what a person calls it. `name` is the row's whole text. */
  readonly primary?: string;
  readonly inViewport: boolean;
  /** A link inside a menu that is closed until opened or hovered. It is a real link of the page, just not showing yet. */
  readonly hidden?: boolean;
  /** For a hidden item: the visible menu title it lives under. */
  readonly menu?: string;
  /** For a button that the page repeats for every item (every dish's "ADD"): the item it belongs to. */
  readonly near?: string;
}

export interface PageState {
  readonly url: string;
  readonly title: string;
  readonly epoch: number;
  readonly headings: readonly string[];
  readonly elements: readonly PageElement[];
  readonly dialogs: readonly string[];
  readonly visibleText: string;
  /** The page's whole readable text (capped), for reading it out; not part of the routine snapshot. */
  readonly bodyText: string;
  readonly tables: readonly SnapshotTable[];
  readonly focused: string | null;
  readonly scroll: { readonly y: number; readonly max: number; readonly atBottom: boolean };
  readonly challenge: PageChallenge | null;
  readonly loading: boolean;
  readonly notes: readonly string[];
  /** A browser-internal page extensions may not read. */
  readonly restricted: boolean;
  /** Delivery marks beside sent messages ("sent", "delivered", "pending", "failed to send"…) — only those words, never a message. */
  readonly statuses?: readonly string[];
}

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.slice(0, max) : '');
const strList = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, maxItems).map((x) => x.slice(0, maxLen)) : [];

function normalizeElement(raw: unknown): PageElement | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const role = ROLES.find((x) => x === r['role']);
  if (role === undefined || typeof r['id'] !== 'string') return null;
  const options = strList(r['options'], 25, 60);
  return {
    id: r['id'].slice(0, 40),
    role,
    name: str(r['name'], 120),
    ...(typeof r['href'] === 'string' ? { href: r['href'].slice(0, 200) } : {}),
    ...(typeof r['type'] === 'string' ? { type: r['type'].slice(0, 20) } : {}),
    ...(typeof r['value'] === 'string' && r['sensitive'] !== true ? { value: r['value'].slice(0, 100) } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(typeof r['checked'] === 'boolean' ? { checked: r['checked'] } : {}),
    ...(typeof r['expanded'] === 'boolean' ? { expanded: r['expanded'] } : {}),
    ...(r['disabled'] === true ? { disabled: true } : {}),
    ...(r['sensitive'] === true ? { sensitive: true } : {}),
    ...(r['sensitive'] === true && r['oneTimeCode'] === true ? { oneTimeCode: true } : {}),
    ...(typeof r['region'] === 'string' ? { region: r['region'].slice(0, 12) } : {}),
    ...(typeof r['primary'] === 'string' && r['primary'] !== '' ? { primary: r['primary'].slice(0, 80) } : {}),
    inViewport: r['inViewport'] === true,
    ...(r['hidden'] === true ? { hidden: true } : {}),
    ...(typeof r['menu'] === 'string' && r['menu'] !== '' ? { menu: r['menu'].slice(0, 40) } : {}),
    ...(typeof r['near'] === 'string' && r['near'] !== '' ? { near: r['near'].slice(0, 80) } : {}),
  };
}

function normalizeTable(raw: unknown): SnapshotTable | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as Record<string, unknown>;
  const rows = Array.isArray(t['rows']) ? t['rows'].slice(0, 6).map((row) => strList(row, 12, 60)) : [];
  const headers = strList(t['headers'], 12, 40);
  if (rows.length === 0 && headers.length === 0) return null;
  return {
    ...(typeof t['caption'] === 'string' ? { caption: t['caption'].slice(0, 80) } : {}),
    headers,
    rows,
    totalRows: typeof t['totalRows'] === 'number' ? t['totalRows'] : rows.length,
    ...(typeof t['dataRows'] === 'number' && Number.isFinite(t['dataRows']) && t['dataRows'] >= 0 ? { dataRows: Math.floor(t['dataRows']) } : {}),
  };
}

export function normalizePageState(raw: unknown): PageState {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const elements = (Array.isArray(r['elements']) ? r['elements'] : [])
    .slice(0, 800)
    .map(normalizeElement)
    .filter((e): e is PageElement => e !== null);
  const scroll = (typeof r['scroll'] === 'object' && r['scroll'] !== null ? r['scroll'] : {}) as Record<string, unknown>;
  const ch = typeof r['challenge'] === 'object' && r['challenge'] !== null ? (r['challenge'] as Record<string, unknown>) : null;
  const kind = ch !== null ? (['captcha', 'bot_check', 'mfa', 'login', 'payment'] as const).find((k) => k === ch['kind']) : undefined;
  return {
    url: redactUrl(str(r['url'], 600)),
    title: str(r['title'], 200),
    epoch: typeof r['epoch'] === 'number' ? r['epoch'] : 0,
    headings: strList(r['headings'], 25, 120),
    elements,
    dialogs: strList(r['dialogs'], 6, 320),
    visibleText: str(r['visibleText'], 1600),
    bodyText: str(r['bodyText'], 42000),
    tables: (Array.isArray(r['tables']) ? r['tables'] : []).slice(0, 3).map(normalizeTable).filter((t): t is SnapshotTable => t !== null),
    focused: typeof r['focused'] === 'string' ? r['focused'].slice(0, 80) : null,
    scroll: {
      y: typeof scroll['y'] === 'number' ? scroll['y'] : 0,
      max: typeof scroll['max'] === 'number' ? scroll['max'] : 0,
      atBottom: scroll['atBottom'] !== false,
    },
    challenge: kind !== undefined && ch !== null ? { kind, hint: str(ch['hint'], 200) } : null,
    loading: r['loading'] === true,
    notes: strList(r['notes'], 8, 200),
    restricted: r['restricted'] === true,
    statuses: strList(r['statuses'], 6, 24),
  };
}

const ACTIVATABLE: ReadonlySet<ElementRole> = new Set(['link', 'button', 'menuitem', 'tab', 'option', 'clickable', 'checkbox', 'radio', 'switch']);

const NEAR_SEPARATOR = ' — ';

/** "ADD — Paneer Tikka" → the button's words and the item it belongs to. Without the separator, only the words. */
export function splitNear(text: string): { readonly text: string; readonly near: string } {
  const at = text.indexOf(NEAR_SEPARATOR);
  return at === -1 ? { text: text.trim(), near: '' } : { text: text.slice(0, at).trim(), near: text.slice(at + NEAR_SEPARATOR.length).trim() };
}

/** The other way: a button's name with the item it belongs to, as the page snapshot lists it. */
export function withNear(name: string, near?: string): string {
  return near !== undefined && near !== '' ? name + NEAR_SEPARATOR + near : name;
}

const ADD_BUTTON = /^(?:\+\s*)?add(?:\s+item)?(?:\s+to\s+(?:the\s+)?(?:cart|bag|basket|trolley|order))?(?:\s*\+)?$|^\+$/i;
const BUY_BUTTON = /^buy\s+(?:it\s+)?now$/i;
const squash = (s: string): string => s.trim().replace(/\s+/g, ' ');

/** Asking to put something in the cart, bag or basket, however a shop words it ("Add to cart", "Add to bag", "ADD", "Buy now"). */
export function isAddRequest(text: string): boolean {
  const t = squash(text);
  return ADD_BUTTON.test(t) || BUY_BUTTON.test(t);
}

const NEAR_FILLER: ReadonlySet<string> = new Set(['the', 'a', 'an', 'of', 'and', 'with', 'for', 'to']);
const keyOf = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Whether a button's item is the one asked for: one name contains the other, or most of the asked-for words are in it. */
function nearMatches(near: string, wanted: string): boolean {
  const a = keyOf(near);
  const b = keyOf(wanted);
  if (a === '' || b === '') return false;
  if (a.includes(b) || b.includes(a)) return true;
  const have = new Set(a.split(' '));
  const need = b.split(' ').filter((t) => !NEAR_FILLER.has(t));
  return need.length > 0 && need.filter((t) => have.has(t)).length / need.length >= 0.75;
}

export type ClickChoice =
  | { readonly kind: 'target'; readonly element: PageElement }
  /** The same button is on the page for several items and the request did not say which: the items, so the right one can be named. */
  | { readonly kind: 'ambiguous'; readonly options: readonly string[]; readonly name: string }
  | { readonly kind: 'none' };

/** The letters and digits of a text and nothing else: "Cause List", "cause-list" and "CauseList" are the same. */
const compact = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const MEANING_FILLER: ReadonlySet<string> = new Set(['the', 'a', 'an', 'on', 'of', 'to', 'button', 'link', 'tab', 'menu', 'option', 'page', 'section', 'icon', 'please']);
const meaningWords = (s: string): string[] => keyOf(s).split(' ').filter((t) => t !== '' && !MEANING_FILLER.has(t));

/** What a control IS for, when sites word it differently: the words a person may use for one thing, grouped. */
const CONCEPTS: ReadonlyArray<readonly [string, RegExp]> = [
  ['login', /^(?:log ?in|sign ?in|log ?on|member login|user login)$/],
  ['logout', /^(?:log ?out|sign ?out|log ?off)$/],
  ['register', /^(?:register|sign ?up|create (?:an? )?account|join(?: now| us)?|new user)$/],
  ['cart', /^(?:cart|my cart|view cart|basket|my basket|bag|my bag|shopping (?:cart|bag)|trolley)$/],
  ['contact', /^(?:contact|contact us|contact info|reach us|get in touch)$/],
  ['help', /^(?:help|help ?(?:centre|center)|support|customer (?:care|support|service)|faqs?)$/],
  ['home', /^(?:home|home ?page|main page|back to home)$/],
  ['next', /^(?:next|continue|proceed|next step)$/],
  ['previous', /^(?:back|previous|go back)$/],
  ['search', /^(?:search|find|search now|go)$/],
  ['about', /^(?:about|about us|who we are)$/],
];
const conceptOf = (s: string): string | null => {
  const k = keyOf(s);
  return CONCEPTS.find(([, re]) => re.test(k))?.[0] ?? null;
};
const hrefPath = (href: string): string => {
  try {
    return new URL(href, 'http://x.invalid').pathname;
  } catch {
    return href.split(/[?#]/)[0] ?? '';
  }
};

/**
 * The control that MEANS what was asked for, when no control carries those exact words: the same letters however the spaces and hyphens fall ("cause list"
 * for "CauseList"), all the words in any order ("list of cause" for "Cause List"), the same purpose under another name ("sign in" for "Log in", "basket" for
 * "Cart"), or an address that says it (/causelist for "cause list"). Each step is used only when it points at exactly ONE control: a meaning shared by two is
 * never a reason to pick one of them.
 */
function findByMeaning(candidates: readonly PageElement[], text: string): PageElement | null {
  const only = (hits: readonly PageElement[]): PageElement | null => (hits.length === 1 ? (hits[0] ?? null) : null);
  const qc = compact(text);
  if (qc.length >= 4) {
    const same = only(candidates.filter((e) => compact(e.name) === qc));
    if (same !== null) return same;
    const containing = candidates.filter((e) => compact(e.name).includes(qc));
    const shortest = Math.min(...containing.map((e) => compact(e.name).length));
    const closest = only(containing.filter((e) => compact(e.name).length === shortest));
    if (closest !== null) return closest;
  }
  const wanted = meaningWords(text);
  if (wanted.length >= 2) {
    const all = only(candidates.filter((e) => {
      const have = new Set(meaningWords(e.name));
      return wanted.every((w) => have.has(w));
    }));
    if (all !== null) return all;
  }
  const purpose = conceptOf(text);
  if (purpose !== null) {
    const same = only(candidates.filter((e) => conceptOf(e.primary ?? e.name) === purpose));
    if (same !== null) return same;
  }
  if (qc.length >= 5) {
    const byAddress = only(candidates.filter((e) => e.href !== undefined && compact(hrefPath(e.href)).includes(qc)));
    if (byAddress !== null) return byAddress;
  }
  return null;
}

function pickByWords(candidates: readonly PageElement[], text: string): PageElement | null {
  const index = findBestTextMatchIndex(text, candidates.map((e) => e.name));
  if (index !== null) return candidates[index] ?? null;
  // "Add to cart" on a page whose button says "ADD" (or "Add to bag", or "+"): the same thing in a shop's other words.
  if (isAddRequest(text)) {
    const buy = BUY_BUTTON.test(squash(text));
    const add = candidates.find((c) => ADD_BUTTON.test(squash(c.name)));
    const buyNow = candidates.find((c) => BUY_BUTTON.test(squash(c.name)));
    return (buy ? (buyNow ?? add) : (add ?? buyNow)) ?? null;
  }
  return findByMeaning(candidates, text);
}

/**
 * What a click on "this text" should do: land on an element (enabled ones first, exact text before partial, what is on screen before what is
 * not, "Add to cart" also finding "ADD"), land on the one belonging to a named item ("ADD — Paneer Tikka"), or — when the page has the same
 * button for several items and none was named — say so instead of quietly choosing the first.
 */
export function chooseClickTarget(state: PageState, rawText: string): ClickChoice {
  const { text, near } = splitNear(rawText);
  const pool = state.elements.filter((e) => ACTIVATABLE.has(e.role) && e.name !== '');
  const enabled = pool.filter((e) => e.disabled !== true);
  // What is showing wins over an identically-named link that only a closed menu is holding.
  for (const candidates of [enabled.filter((e) => e.hidden !== true), enabled, pool]) {
    let scoped = near === '' ? candidates : candidates.filter((e) => e.near !== undefined && nearMatches(e.near, near));
    // An item named exactly beats one whose name merely contains the words ("Veg Biryani" over "Veg Biryani Special").
    const exact = near === '' ? [] : scoped.filter((e) => keyOf(e.near ?? '') === keyOf(near));
    if (exact.length > 0) scoped = exact;
    const hit = pickByWords(scoped, text);
    if (hit === null) continue;
    // Only for the buttons that repeat once per item in a list of dishes or products (ADD, Add to cart, Buy): another repeated button, such as the
    // Send of a chat (one in the message box, one in a file preview), is not a choice between items and is clicked as it always was.
    if (hit.near !== undefined && isAddRequest(text)) {
      // The same button for several items and the words did not settle which one: do not guess, name the items.
      const same = scoped.filter((e) => e.near !== undefined && keyOf(e.name) === keyOf(hit.name));
      const items = [...new Set(same.map((e) => e.near as string))];
      if (items.length > 1) return { kind: 'ambiguous', options: items.slice(0, 12), name: hit.name };
    }
    return { kind: 'target', element: hit };
  }
  return { kind: 'none' };
}

export type ListItemChoice = { readonly kind: 'target'; readonly element: PageElement } | { readonly kind: 'none' };

/**
 * The row of a list (a chat, a search result) whose first line is this, in the page as it is NOW: what is showing before what is not, a row of
 * the list before the app's own menus, the first of several that carry the same first line (the same chat shown in two sections of a search).
 */
export function findListItem(state: PageState, want: { readonly primary?: string; readonly name?: string; readonly region?: string; readonly role?: string }): ListItemChoice {
  const wanted = keyOf(want.primary ?? want.name ?? '');
  if (wanted === '') return { kind: 'none' };
  // A tick box is not a row to open, whatever its name (unless a tick box is what is asked for); and when a region is asked for (a popup's rows), only
  // that region's rows are looked at.
  const pool = state.elements.filter(
    (e) =>
      ACTIVATABLE.has(e.role) &&
      (want.role === undefined ? e.role !== 'checkbox' : e.role === want.role) &&
      e.name !== '' &&
      e.hidden !== true &&
      e.disabled !== true &&
      e.region !== 'nav' &&
      e.region !== 'footer' &&
      (want.region === undefined || e.region === want.region),
  );
  // (a tick box's name is the whole row's: its first line is what a person calls it)
  const byFirstLine = pool.filter((e) => keyOf(e.primary ?? e.name) === wanted || (want.role === 'checkbox' && keyOf(e.name).startsWith(`${wanted} `)));
  const byWholeText = want.name === undefined ? [] : pool.filter((e) => keyOf(e.name) === keyOf(want.name ?? ''));
  const found = byFirstLine.length > 0 ? byFirstLine : byWholeText;
  const best = found.find((e) => e.inViewport) ?? found[0];
  return best === undefined ? { kind: 'none' } : { kind: 'target', element: best };
}

/** The element a click on "this text" should land on, or null (also when it would be a guess between several items). */
export function findClickTarget(state: PageState, text: string): PageElement | null {
  const choice = chooseClickTarget(state, text);
  return choice.kind === 'target' ? choice.element : null;
}

/** The field a fill on "this label" should land on. Unlabelled fields cannot be addressed by a person's words, so they are not candidates. */
export function findFillTarget(state: PageState, label: string): PageElement | null {
  const pool = state.elements.filter((e) => (e.role === 'input' || e.role === 'select') && e.name !== '');
  const index = findBestTextMatchIndex(label, pool.map((e) => e.name));
  return index === null ? null : (pool[index] ?? null);
}

export interface FoundItem {
  readonly name: string;
  readonly role: string;
  /** Where on the page it is, in words: showing now, further down, or inside a closed menu. */
  readonly where: string;
  readonly href?: string;
  /** For a button the page repeats for every item: the item this one belongs to. */
  readonly near?: string;
}

export interface FindResult {
  readonly matches: readonly FoundItem[];
  /** Snippets of the page's own text around the query. */
  readonly textMatches: readonly string[];
  /** How many named controls the page has in all, so "nothing found" can be weighed. */
  readonly totalControls: number;
}

const REGION_WORDS: Readonly<Record<string, string>> = { nav: 'in the navigation menu', header: 'in the header', footer: 'in the footer', dialog: 'in the open popup' };

function whereIs(e: PageElement): string {
  if (e.hidden === true) return e.menu !== undefined ? `inside the closed menu "${e.menu}" (not showing until that menu is opened or hovered)` : 'inside a closed menu (not showing yet)';
  const place = REGION_WORDS[e.region ?? ''];
  const visibility = e.inViewport ? 'showing now' : 'further down the page';
  return place !== undefined ? `${visibility}, ${place}` : visibility;
}

/**
 * Looks for something across EVERYTHING the page has — what is showing, what is further down, links held by closed menus
 * and the page's own text — rather than only the first screenful the routine snapshot lists.
 */
export function findInPage(state: PageState, query: string): FindResult {
  const q = query.toLowerCase().replace(/\s+/g, ' ').trim();
  const tokens = q.split(' ').filter((t) => t.length > 0);
  const scored: Array<{ item: FoundItem; score: number; order: number }> = [];
  state.elements.forEach((e, order) => {
    if (e.name === '' || q === '') return;
    const name = e.name.toLowerCase().replace(/\s+/g, ' ');
    const href = (e.href ?? '').toLowerCase();
    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (tokens.length > 1 && tokens.every((t) => name.includes(t))) score = 40;
    else if (tokens.length > 0 && tokens.every((t) => href.includes(t))) score = 20;
    if (score === 0) return;
    scored.push({
      item: { name: e.name, role: e.role, where: whereIs(e), ...(e.near !== undefined ? { near: e.near } : {}), ...(e.href !== undefined && e.href !== '' ? { href: e.href } : {}) },
      score: score + (e.hidden === true ? 0 : 5),
      order,
    });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);

  const textMatches: string[] = [];
  const lower = state.bodyText.toLowerCase();
  if (q !== '') {
    let from = 0;
    while (textMatches.length < 5) {
      const at = lower.indexOf(q, from);
      if (at === -1) break;
      const snippet = state.bodyText.slice(Math.max(0, at - 70), at + q.length + 90).replace(/\s+/g, ' ').trim();
      if (!textMatches.includes(snippet)) textMatches.push(snippet);
      from = at + q.length + 90;
    }
  }
  return { matches: scored.slice(0, 15).map((s) => s.item), textMatches, totalControls: state.elements.filter((e) => e.name !== '').length };
}

export interface ReadChunk {
  readonly text: string;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly totalChars: number;
}

const READ_CHUNK = 4000;

/** A slice of the page's readable text, cut at a line break so a sentence is not split, with where the next slice starts. */
export function readChunk(state: PageState, offset: number): ReadChunk {
  const start = Math.max(0, Math.min(Math.floor(offset), state.bodyText.length));
  let end = Math.min(start + READ_CHUNK, state.bodyText.length);
  if (end < state.bodyText.length) {
    const lineBreak = state.bodyText.lastIndexOf('\n', end);
    if (lineBreak > start + READ_CHUNK / 2) end = lineBreak;
  }
  return {
    text: state.bodyText.slice(start, end).trim(),
    offset: start,
    nextOffset: end < state.bodyText.length ? end : null,
    totalChars: state.bodyText.length,
  };
}

const LINK_ROLES: readonly ElementRole[] = ['link', 'menuitem', 'tab', 'clickable'];
const SITE_FRAME_REGIONS = new Set(['nav', 'header', 'footer']);

/** The names in the site's own menu bar / header / footer (what repeats on every page), not including closed menus. */
export function navigationNames(state: PageState): string[] {
  return state.elements
    .filter((e) => LINK_ROLES.includes(e.role) && e.hidden !== true && e.name !== '' && SITE_FRAME_REGIONS.has(e.region ?? ''))
    .map((e) => e.name);
}

export interface SnapshotOptions {
  readonly notes?: readonly string[];
  readonly environment?: BrowserEnvironment;
  /** Names of the menu bar the model was last shown. If this page's is (nearly) the same one it is not repeated. */
  readonly previousNavigation?: ReadonlySet<string>;
}

/**
 * What the model is shown. The page's OWN links come first and get most of the room; the site's menu bar and footer
 * are listed separately (and skipped when they are the same as on the previous page), so a long header can never push
 * the options that matter off the list; links that live in closed menus are listed under the menu that holds them.
 */
export function stateToSnapshot(state: PageState, extras: SnapshotOptions = {}): PageSnapshot {
  const named = (roles: readonly ElementRole[]) => state.elements.filter((e) => roles.includes(e.role) && e.name !== '');
  const shown = named(LINK_ROLES).filter((e) => e.hidden !== true);
  const pageLinks = shown.filter((e) => !SITE_FRAME_REGIONS.has(e.region ?? '')).map((e) => withNear(e.name, e.near));
  const navLinks = navigationNames(state);

  const collapsed: Record<string, string[]> = {};
  for (const e of named(LINK_ROLES).filter((x) => x.hidden === true)) {
    (collapsed[e.menu ?? 'other menus'] ??= []).push(e.name);
  }

  const buttons = named(['button', 'checkbox', 'radio', 'switch', 'option']).filter((e) => e.hidden !== true).map((e) => withNear(e.name, e.near));
  const inputs = state.elements.filter((e) => (e.role === 'input' || e.role === 'select') && e.name !== '').map((e) => e.name);

  const prev = extras.previousNavigation;
  const sameNav =
    prev !== undefined && prev.size > 0 && navLinks.length > 0 && navLinks.filter((n) => prev.has(n)).length / navLinks.length >= 0.8;

  const base = buildSnapshot(state.url, state.title, state.headings, pageLinks, buttons, inputs, state.dialogs, {
    visibleText: state.visibleText,
    tables: state.tables,
    ...(state.focused !== null ? { focused: state.focused } : {}),
    scroll: state.scroll,
    ...(state.challenge !== null ? { challenge: state.challenge } : {}),
    notes: state.notes,
    ...(state.statuses !== undefined && state.statuses.length > 0 ? { messageStatus: state.statuses } : {}),
    ...(extras.environment !== undefined ? { environment: extras.environment } : {}),
    navigation: navLinks,
    ...(sameNav ? { navigationSameAsPrevious: navLinks.length } : {}),
    collapsedMenus: collapsed,
  });
  return extras.notes !== undefined && extras.notes.length > 0 ? withExtras(base, { notes: extras.notes }) : base;
}
