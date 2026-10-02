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
  readonly region?: string;
  readonly inViewport: boolean;
}

export interface PageState {
  readonly url: string;
  readonly title: string;
  readonly epoch: number;
  readonly headings: readonly string[];
  readonly elements: readonly PageElement[];
  readonly dialogs: readonly string[];
  readonly visibleText: string;
  readonly tables: readonly SnapshotTable[];
  readonly focused: string | null;
  readonly scroll: { readonly y: number; readonly max: number; readonly atBottom: boolean };
  readonly challenge: PageChallenge | null;
  readonly loading: boolean;
  readonly notes: readonly string[];
  /** A browser-internal page extensions may not read. */
  readonly restricted: boolean;
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
    ...(typeof r['region'] === 'string' ? { region: r['region'].slice(0, 12) } : {}),
    inViewport: r['inViewport'] === true,
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
  };
}

export function normalizePageState(raw: unknown): PageState {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const elements = (Array.isArray(r['elements']) ? r['elements'] : [])
    .slice(0, 600)
    .map(normalizeElement)
    .filter((e): e is PageElement => e !== null);
  const scroll = (typeof r['scroll'] === 'object' && r['scroll'] !== null ? r['scroll'] : {}) as Record<string, unknown>;
  const ch = typeof r['challenge'] === 'object' && r['challenge'] !== null ? (r['challenge'] as Record<string, unknown>) : null;
  const kind = ch !== null ? (['captcha', 'bot_check', 'mfa', 'login'] as const).find((k) => k === ch['kind']) : undefined;
  return {
    url: str(r['url'], 300),
    title: str(r['title'], 200),
    epoch: typeof r['epoch'] === 'number' ? r['epoch'] : 0,
    headings: strList(r['headings'], 25, 120),
    elements,
    dialogs: strList(r['dialogs'], 6, 320),
    visibleText: str(r['visibleText'], 1600),
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
  };
}

const ACTIVATABLE: ReadonlySet<ElementRole> = new Set(['link', 'button', 'menuitem', 'tab', 'option', 'clickable', 'checkbox', 'radio', 'switch']);

/** The element a click on "this text" should land on — enabled ones first, exact text before partial, what is on screen before what is not. */
export function findClickTarget(state: PageState, text: string): PageElement | null {
  const pool = state.elements.filter((e) => ACTIVATABLE.has(e.role) && e.name !== '');
  const enabled = pool.filter((e) => e.disabled !== true);
  for (const candidates of [enabled, pool]) {
    const index = findBestTextMatchIndex(text, candidates.map((e) => e.name));
    if (index !== null) return candidates[index] ?? null;
  }
  return null;
}

/** The field a fill on "this label" should land on. Unlabelled fields cannot be addressed by a person's words, so they are not candidates. */
export function findFillTarget(state: PageState, label: string): PageElement | null {
  const pool = state.elements.filter((e) => (e.role === 'input' || e.role === 'select') && e.name !== '');
  const index = findBestTextMatchIndex(label, pool.map((e) => e.name));
  return index === null ? null : (pool[index] ?? null);
}

/** What the model is shown: the same simple lists as always, plus the richer detail the browser bridge can see. */
export function stateToSnapshot(state: PageState, extras: { notes?: readonly string[]; environment?: BrowserEnvironment } = {}): PageSnapshot {
  const named = (roles: readonly ElementRole[]) => state.elements.filter((e) => roles.includes(e.role) && e.name !== '');
  const links = named(['link', 'menuitem', 'tab', 'clickable']).map((e) => e.name);
  const buttons = named(['button', 'checkbox', 'radio', 'switch', 'option']).map((e) => e.name);
  const inputs = state.elements.filter((e) => (e.role === 'input' || e.role === 'select') && e.name !== '').map((e) => e.name);
  const base = buildSnapshot(state.url, state.title, state.headings, links, buttons, inputs, state.dialogs, {
    visibleText: state.visibleText,
    tables: state.tables,
    ...(state.focused !== null ? { focused: state.focused } : {}),
    scroll: state.scroll,
    ...(state.challenge !== null ? { challenge: state.challenge } : {}),
    notes: state.notes,
    ...(extras.environment !== undefined ? { environment: extras.environment } : {}),
  });
  return extras.notes !== undefined && extras.notes.length > 0 ? withExtras(base, { notes: extras.notes }) : base;
}
