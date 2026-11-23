import type { PageElement, PageState } from '@main/chrome/pageState';

/**
 * A read-only description of how a chat app's page is built, with nothing private in it: the kind of each control, where it sits, the
 * standard words of the app's own interface, and — for everything else (a contact's name, a preview, a number, a message) — only its SHAPE
 * (capital letters, small letters and digits, with the spaces and punctuation kept). It exists so that a chat flow can be built on how the
 * real page is made, not on a guess, without a name, a number or a message ever being written down.
 */

/** The words of the app's own interface that are safe to write down as they are (whole label, any case). */
const UI_WORDS = new RegExp(
  '^(?:' +
    [
      'select chats',
      'search name, number or @username',
      'search or start a new chat',
      'search or start new chat',
      'search',
      'search\\.\\.\\.',
      'type a message',
      'send',
      'next',
      'close',
      'cancel',
      'done',
      'back',
      'menu',
      'more',
      'new chat',
      'new group',
      'new community',
      'attach',
      'add a caption',
      'caption',
      'forward',
      'forward message to',
      'chats',
      'calls',
      'status',
      'channels',
      'communities',
      'settings',
      'profile',
      'meta ai',
      'all',
      'unread',
      'favourites',
      'favorites',
      'groups',
      'recent chats',
      'contacts',
      'contacts on whatsapp',
      'photos & videos',
      'photos and videos',
      'document',
      'camera',
      'contact',
      'poll',
      'event',
      'sticker',
      'emoji',
      'gif',
      'voice message',
      'clear search',
      'chat list',
      'lock',
      'archived',
      'starred messages',
      'select all',
      'show more',
      'mute',
      'new call',
      'invite a friend',
      'go to calls',
      'library',
      'updates',
      'filter chats by',
    ].join('|') +
    ')$',
  'i',
);

/** The shape of a text: letters become a (or A), digits 9, everything else stays — "Anna Reddy 10:42" → "Aaaa Aaaaa 99:99". */
export function shapeOf(text: string, max = 60): string {
  return text
    .slice(0, max)
    .replace(/\p{Lu}/gu, 'A')
    .replace(/\p{Ll}|\p{Lo}/gu, 'a')
    .replace(/\p{N}/gu, '9');
}

/** The words themselves when they are the app's own interface, otherwise only their shape (and length). */
export function safeLabel(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t === '') return '';
  return UI_WORDS.test(t) ? t : `‹${shapeOf(t)}${t.length > 60 ? '…' : ''}› (${t.length})`;
}

export interface ProbeElement {
  /** For a text field: the odd (non-letter, non-digit) characters of its accessible name, as code points. */
  readonly odd?: readonly string[];
  readonly role: string;
  readonly region?: string;
  readonly name: string;
  readonly primary?: string;
  readonly type?: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly inViewport: boolean;
  readonly value?: string;
}

export interface ProbeReport {
  readonly at: string;
  readonly host: string;
  readonly titleShape: string;
  readonly headings: readonly string[];
  readonly dialogs: ReadonlyArray<{ readonly length: number; readonly lines: readonly string[] }>;
  readonly inputs: readonly ProbeElement[];
  readonly fileInputs: number;
  readonly counts: Readonly<Record<string, number>>;
  /** The controls of an open popup (what can be reached while it is open). */
  readonly dialogElements: readonly ProbeElement[];
  /** The controls that are not in a popup: the first ones on the page (the app's own panes). */
  readonly pageElements: readonly ProbeElement[];
  readonly statuses: readonly string[];
  /** How the text fields and file inputs are built (filled in by the runner, from the extension's own probe). */
  readonly structure?: ProbeStructure | null;
}

/** The characters of a text that are neither letters, digits nor plain spaces, as code points (so odd characters can be found without the words). */
function oddCharacters(text: string): string[] {
  return [...text].filter((c) => !/[\p{L}\p{N} ]/u.test(c)).slice(0, 8).map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`);
}

function describe(e: PageElement): ProbeElement {
  return {
    ...(e.role === 'input' ? { odd: oddCharacters(e.name) } : {}),
    role: e.role,
    ...(e.region !== undefined ? { region: e.region } : {}),
    name: safeLabel(e.name),
    ...(e.primary !== undefined ? { primary: safeLabel(e.primary) } : {}),
    ...(e.type !== undefined ? { type: e.type } : {}),
    ...(e.checked !== undefined ? { checked: e.checked } : {}),
    ...(e.disabled === true ? { disabled: true } : {}),
    inViewport: e.inViewport,
    ...(e.value !== undefined && e.value !== '' ? { value: `‹${shapeOf(e.value, 20)}› (${e.value.length})` } : {}),
  };
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return '';
  }
}

export function probeReport(state: PageState, at: string, limits: { readonly dialog?: number; readonly page?: number } = {}): ProbeReport {
  const counts: Record<string, number> = {};
  for (const e of state.elements) {
    const key = `${e.role}${e.region !== undefined ? `@${e.region}` : ''}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const inDialog = state.elements.filter((e) => e.region === 'dialog');
  const outside = state.elements.filter((e) => e.region !== 'dialog');
  return {
    at,
    host: hostOf(state.url),
    titleShape: shapeOf(state.title, 40),
    headings: state.headings.map((h) => safeLabel(h)),
    dialogs: state.dialogs.map((d) => ({ length: d.length, lines: d.split('\n').slice(0, 8).map((l) => safeLabel(l)) })),
    inputs: state.elements.filter((e) => e.role === 'input').map(describe),
    fileInputs: state.elements.filter((e) => e.role === 'file').length,
    counts,
    dialogElements: inDialog.slice(0, limits.dialog ?? 250).map(describe),
    pageElements: outside.slice(0, limits.page ?? 120).map(describe),
    statuses: (state.statuses ?? []).map((s) => safeLabel(s)),
  };
}

/** What changed enough to be worth writing again: the kinds of control present and whether a popup is open. */
export function probeSignature(report: ProbeReport): string {
  const ticked = report.dialogElements.filter((e) => e.checked === true).length;
  const words = report.dialogElements.filter((e) => !e.name.startsWith('‹')).map((e) => `${e.role}:${e.name}`);
  const built = report.structure === undefined || report.structure === null ? null : [report.structure.fields.length, report.structure.files.map((f) => `${f.accept}|${f.inMain}|${f.inFooter}|${f.inDialog}`)];
  return JSON.stringify([report.dialogs.map((d) => d.lines[0]), ticked, words, report.inputs.map((i) => i.name), Object.entries(report.counts).sort(), built]);
}

// ------------------------------------------------------------------------------------------ how the fields and file inputs are built
/** What the extension's `probe` op says about one text field or file input (see injected.js `probeOp`). */
export interface RawProbeField {
  readonly tag?: string;
  readonly type?: string;
  readonly editable?: boolean;
  readonly role?: string;
  readonly ariaLabel?: string;
  readonly labelledby?: boolean;
  readonly placeholder?: string;
  readonly title?: string;
  readonly nameAttr?: boolean;
  readonly idShape?: string;
  readonly labels?: number;
  readonly accName?: string;
  readonly accept?: string;
  readonly multiple?: boolean;
  readonly visible?: boolean;
  readonly inDialog?: boolean;
  readonly inMain?: boolean;
  readonly inFooter?: boolean;
  readonly inHeader?: boolean;
  readonly chain?: readonly string[];
}

export interface RawProbe {
  readonly fields?: readonly RawProbeField[];
  readonly files?: readonly RawProbeField[];
  readonly roleCounts?: Readonly<Record<string, number>>;
  readonly landmarks?: Readonly<Record<string, unknown>>;
  readonly focused?: string;
}

export interface ProbeField {
  readonly tag: string;
  readonly type: string;
  readonly editable: boolean;
  readonly role: string;
  readonly ariaLabel: string;
  readonly labelledby: boolean;
  readonly placeholder: string;
  readonly title: string;
  readonly idShape: string;
  readonly accName: string;
  readonly accept: string;
  readonly visible: boolean;
  readonly inDialog: boolean;
  readonly inMain: boolean;
  readonly inFooter: boolean;
  readonly inHeader: boolean;
  readonly chain: readonly string[];
}

export interface ProbeStructure {
  readonly fields: readonly ProbeField[];
  readonly files: readonly ProbeField[];
  readonly roleCounts: Readonly<Record<string, number>>;
  readonly landmarks: Readonly<Record<string, unknown>>;
  readonly focused: string;
}

const flag = (v: unknown): boolean => v === true;
const text = (v: unknown, max = 60): string => (typeof v === 'string' ? v.slice(0, max) : '');

function maskField(f: RawProbeField): ProbeField {
  return {
    tag: text(f.tag, 20),
    type: text(f.type, 20),
    editable: flag(f.editable),
    role: text(f.role, 20),
    ariaLabel: safeLabel(text(f.ariaLabel, 100)),
    labelledby: flag(f.labelledby),
    placeholder: safeLabel(text(f.placeholder, 100)),
    title: safeLabel(text(f.title, 100)),
    idShape: text(f.idShape, 24),
    accName: safeLabel(text(f.accName, 100)),
    accept: text(f.accept, 80),
    visible: flag(f.visible),
    inDialog: flag(f.inDialog),
    inMain: flag(f.inMain),
    inFooter: flag(f.inFooter),
    inHeader: flag(f.inHeader),
    chain: Array.isArray(f.chain) ? f.chain.filter((c): c is string => typeof c === 'string').slice(0, 5).map((c) => c.slice(0, 40)) : [],
  };
}

/** The extension's answer with every text in it made safe (the app's own words kept, anything else reduced to its shape). */
export function maskStructure(raw: RawProbe | null | undefined): ProbeStructure | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  return {
    fields: (raw.fields ?? []).slice(0, 14).map(maskField),
    files: (raw.files ?? []).slice(0, 14).map(maskField),
    roleCounts: raw.roleCounts ?? {},
    landmarks: raw.landmarks ?? {},
    focused: text(raw.focused, 40),
  };
}
