import type {
  ActOnPageResult,
  AttachFileRequest,
  AttachFileResult,
  BrowserAutomationService,
  BrowserFileAttach,
  BrowserItemClicker,
  BrowserItemLister,
  BrowserKeyPress,
  ClickGate,
  FillOptions,
  FindOnPageResult,
  PageItem,
  ReadPageResult,
} from '../src/main/browser/BrowserAutomationService';
import { CommunicationAccessError } from '../src/main/browser/errors';
import type { PageSnapshot } from '../src/main/browser/pageSnapshot';
import { normalizeText } from '../src/main/chat/contactMatch';

/**
 * A stand-in for WhatsApp Web as the probe of the REAL page showed it (25 Oct 2026), driven through the same service interface the tools use:
 *  - the left search box is called "Search or start a new chat" while it is empty, and only by its generated id ("_r_a_") once something is typed in it;
 *  - the open chat's message box is called "Type a message to <name>";
 *  - with no chat open the page has one file input that takes anything; a file given to it opens a "Select chats" popup (a search box, a button and a tick
 *    box per person, section titles), and a Send button appears in the popup once someone is ticked;
 *  - Send in the popup sends the file and the app opens that person's chat, where the file shows with delivery marks;
 *  - with a chat open the only file input is the message box's (photos), which does not take a PDF.
 * Every behaviour of the real page that went wrong for the user can be switched on.
 */

export interface PickerContact {
  readonly name: string;
  readonly phone: string;
  /** What the app shows under the name in the picker (a status line); may be empty. */
  readonly about?: string;
}

export const PICKER_CONTACTS: readonly PickerContact[] = [
  { name: 'Anna', phone: '+91 92222 44444' },
  { name: 'Ramesh Anna', phone: '+91 90000 22222', about: 'Hey there!' },
  { name: 'Naveen Anna', phone: '+91 93333 55555', about: 'Busy' },
  { name: 'Srikash Anna Advocate', phone: '+91 94444 66666' },
  { name: 'Mahesh Sir Advocate', phone: '+91 98888 77777', about: "Can't talk, WhatsApp only" },
  { name: 'Mum', phone: '+91 90000 11111' },
];

export interface Bubble {
  readonly file?: string;
  readonly text?: string;
  mark: string | null;
  hiddenFor: number;
}

export class FakeWhatsAppWeb implements BrowserAutomationService, BrowserItemLister, BrowserItemClicker, BrowserFileAttach, BrowserKeyPress {
  url = 'https://web.whatsapp.com/';
  title = 'WhatsApp';
  accessOff = false;
  calls: string[] = [];

  // ---- the page's state
  search = '';
  open: PickerContact | null = null;
  picker: { search: string; ticked: Set<string>; file: { name: string; size: number } } | null = null;
  /** What was typed in the open chat's message box and not sent. */
  draft = '';
  threads = new Map<string, Bubble[]>();
  /** Delivery marks of older messages already in a chat. */
  oldMarks: string[] = ['read'];
  /** Everything ever sent (name of the person, file or text) — what a test checks: nothing arrives twice, nothing arrives in the wrong chat. */
  sentLog: Array<{ to: string; file?: string; text?: string }> = [];

  // ---- the behaviours of the real page, off unless a test turns them on
  /** Clicking a chat row in the list does nothing (what happened on the real page: the click was carried out and no chat opened). */
  rowClickDoesNothing = false;
  /** Clicking a person's row in the picker does not tick them; only their tick box does. */
  rowClickDoesNotTick = false;
  /** Clicking neither ticks anybody. */
  nothingTicks = false;
  /** Escape does not close the open chat (an extension that cannot press it, or the app kept it). */
  escapeDoesNothing = false;
  /** The page has no file input with no chat open. */
  noGlobalInput = false;
  /** After Send the popup stays open (nothing was sent). */
  sendDoesNothing = false;
  /** The marks of a sent file: 'normal' (pending, then sent), 'none' (no mark at all), 'failed'. */
  marks: 'normal' | 'none' | 'failed' | 'delivered' = 'normal';
  /** How many looks at the page before a sent file's mark shows. */
  markAfter = 1;
  /** The popup lists people twice, under "Chats" and "Contacts". */
  duplicateSections = true;
  /** The page is still loading for this many looks. */
  loadingFor = 0;
  /** The chat that is open after a reload is this one (the app restores the last chat). */
  reopenAfterReload = false;
  searchTypes = 0;
  pickerSearchTypes = 0;
  rowClicks = 0;
  sendClicks = 0;
  reloads = 0;
  escapes = 0;

  constructor(public contacts: readonly PickerContact[] = PICKER_CONTACTS) {}

  private guard(): void {
    if (this.accessOff) throw new CommunicationAccessError('WhatsApp');
  }

  // ------------------------------------------------------------------ what the page shows
  private pickerRows(): PickerContact[] {
    if (this.picker === null) return [];
    const q = this.picker.search.trim().toLowerCase();
    if (q === '') return [...this.contacts];
    const digits = q.replace(/\D/g, '');
    return this.contacts.filter((c) => c.name.toLowerCase().includes(q) || (digits.length >= 2 && c.phone.replace(/\D/g, '').includes(digits)));
  }

  private leftRows(): PickerContact[] {
    const q = this.search.trim().toLowerCase();
    return q === '' ? [...this.contacts] : this.contacts.filter((c) => c.name.toLowerCase().includes(q));
  }

  private rowText(c: PickerContact): string {
    return `${c.name}${c.about !== undefined ? ` ${c.about}` : ''}`;
  }

  private allMarks(): string[] {
    const own = this.open === null ? [] : (this.threads.get(this.open.name) ?? []).flatMap((b) => (b.mark === null || b.hiddenFor > 0 ? [] : [b.mark]));
    return this.open === null ? [] : [...this.oldMarks, ...own].slice(-6);
  }

  snapshot(): PageSnapshot {
    if (this.loadingFor > 0) return { url: this.url, title: this.title, headings: [], links: [], buttons: [], inputs: [], dialogs: [], truncated: false, visibleText: 'Loading your chats' };
    const inputs = [this.search === '' ? 'Search or start a new chat' : '_r_a_'];
    if (this.picker !== null) inputs.unshift('Search name, number or @username');
    if (this.open !== null) inputs.push(`Type a message to ${this.open.name}`);
    const buttons = ['Chats', 'Calls', 'Status', 'Menu', 'New chat', ...(this.picker !== null ? ['Close', ...(this.picker.ticked.size > 0 ? ['Send'] : [])] : [])];
    const marks = this.allMarks();
    return {
      url: this.url,
      // (the page's title holds the unread count, never the name of the open chat)
      title: '(1) WhatsApp',
      headings: this.picker !== null ? ['Select chats'] : [],
      links: [],
      buttons,
      inputs,
      dialogs: this.picker !== null ? [`Select chats Recent chats ${this.pickerRows().map((c) => this.rowText(c)).join(' ')}`.slice(0, 300)] : [],
      truncated: false,
      ...(marks.length > 0 ? { messageStatus: marks } : {}),
    };
  }

  private settle(): void {
    if (this.open === null) return;
    for (const b of this.threads.get(this.open.name) ?? []) if (b.hiddenFor > 0) b.hiddenFor -= 1;
  }

  // ------------------------------------------------------------------ the service interface
  async openWebsite(url?: string): Promise<PageSnapshot> {
    this.calls.push('open');
    if (url !== undefined) this.url = url;
    return this.snapshot();
  }

  async inspectPage(): Promise<PageSnapshot> {
    this.guard();
    this.calls.push('inspect');
    const seen = this.snapshot();
    if (this.loadingFor > 0) this.loadingFor -= 1;
    this.settle();
    return seen;
  }

  async findOnPage(query: string): Promise<FindOnPageResult> {
    this.guard();
    this.calls.push(`find:${query}`);
    const q = normalizeText(query);
    const bubbles = this.open === null ? [] : (this.threads.get(this.open.name) ?? []);
    const hit = bubbles.some((b) => normalizeText(`${b.text ?? ''} ${b.file ?? ''}`).includes(q));
    return { url: this.url, title: this.title, query, matches: [], textMatches: hit ? [`…${query}…`] : [], totalControls: 0 };
  }

  async readPage(): Promise<ReadPageResult> {
    this.guard();
    return { url: this.url, title: this.title, text: '', offset: 0, nextOffset: null, totalChars: 0 };
  }

  async clickOnPage(text: string, gate?: ClickGate): Promise<ActOnPageResult> {
    this.guard();
    this.calls.push(`click:${text}`);
    const here = (): ActOnPageResult => ({ ok: true, snapshot: this.snapshot() });
    if (text === 'Close' && this.picker !== null) {
      this.picker = null;
      return here();
    }
    if (text === 'Send') {
      const why = gate?.({ name: 'Send', role: 'button' }) ?? null;
      if (why !== null) return { ok: false, reason: 'needs_confirmation', why, target: 'Send', snapshot: this.snapshot() };
      this.sendClicks += 1;
      if (this.picker !== null) {
        if (this.picker.ticked.size === 0 || this.sendDoesNothing) return this.picker.ticked.size === 0 ? { ok: false, reason: 'not_found', snapshot: this.snapshot() } : here();
        this.sendFromPicker();
        return here();
      }
      if (this.open !== null && this.draft !== '') {
        this.addBubble(this.open, { text: this.draft });
        this.draft = '';
        return here();
      }
      return { ok: false, reason: 'not_found', snapshot: this.snapshot() };
    }
    return { ok: false, reason: 'not_found', snapshot: this.snapshot() };
  }

  /** The row of the chat list, or of the picker, whose first line this is. */
  async clickItem(want: { readonly primary?: string; readonly name?: string; readonly region?: string; readonly role?: string }): Promise<ActOnPageResult> {
    this.guard();
    const label = normalizeText(want.primary ?? want.name ?? '');
    this.calls.push(`clickItem:${want.region ?? 'page'}:${want.role ?? 'row'}:${want.primary ?? want.name ?? ''}`);
    const here = (): ActOnPageResult => ({ ok: true, snapshot: this.snapshot() });
    if (want.region === 'dialog') {
      if (this.picker === null) return { ok: false, reason: 'not_found', snapshot: this.snapshot() };
      const row = this.pickerRows().find((c) => normalizeText(c.name) === label);
      if (row === undefined) return { ok: false, reason: 'not_found', snapshot: this.snapshot() };
      const viaBox = want.role === 'checkbox';
      if (!this.nothingTicks && (viaBox || !this.rowClickDoesNotTick)) {
        if (this.picker.ticked.has(row.name)) this.picker.ticked.delete(row.name);
        else this.picker.ticked.add(row.name);
      }
      return here();
    }
    const row = this.leftRows().find((c) => normalizeText(c.name) === label);
    if (row === undefined) return { ok: false, reason: 'not_found', snapshot: this.snapshot() };
    this.rowClicks += 1;
    if (!this.rowClickDoesNothing) {
      this.open = row;
      this.search = '';
    }
    return here();
  }

  async fillOnPage(label: string, value: string, _options?: FillOptions): Promise<ActOnPageResult> {
    this.guard();
    this.calls.push(`fill:${label}=${value}`);
    if (/number or @username/i.test(label)) {
      if (this.picker === null) return { ok: false, reason: 'not_found', snapshot: this.snapshot() };
      this.picker.search = value;
      this.pickerSearchTypes += 1;
    } else if (/search/i.test(label)) {
      this.search = value;
      this.searchTypes += 1;
    } else if (/message/i.test(label) && this.open !== null) {
      this.draft = value;
    } else return { ok: false, reason: 'not_found', snapshot: this.snapshot() };
    return { ok: true, snapshot: this.snapshot() };
  }

  async goBack(): Promise<ActOnPageResult> {
    return { ok: true, snapshot: this.snapshot() };
  }
  async goForward(): Promise<ActOnPageResult> {
    return { ok: true, snapshot: this.snapshot() };
  }
  async reload(): Promise<ActOnPageResult> {
    this.calls.push('reload');
    this.reloads += 1;
    this.picker = null;
    if (!this.reopenAfterReload) this.open = null;
    this.search = '';
    return { ok: true, snapshot: this.snapshot() };
  }
  async scroll(): Promise<ActOnPageResult> {
    return { ok: true, snapshot: this.snapshot() };
  }
  async searchWeb(): Promise<[]> {
    return [];
  }
  async close(): Promise<void> {
    // nothing to close
  }

  async pressEscape(): Promise<{ readonly ok: true; readonly snapshot: PageSnapshot } | { readonly ok: false; readonly message: string }> {
    this.guard();
    this.calls.push('escape');
    this.escapes += 1;
    if (this.picker !== null) this.picker = null;
    else if (!this.escapeDoesNothing) this.open = null;
    return { ok: true, snapshot: this.snapshot() };
  }

  async listItems(): Promise<PageItem[]> {
    this.guard();
    this.calls.push('list');
    if (this.loadingFor > 0) return [];
    const left: PageItem[] = this.leftRows().map((c) => ({ name: `${c.name} ${c.about ?? 'ok'} Thursday`, primary: c.name, role: 'clickable' }));
    if (this.picker === null) return [{ name: 'Chats', role: 'button', region: 'header' }, ...left];
    const rows = this.pickerRows();
    const shown = this.duplicateSections ? [...rows, ...rows] : rows;
    const dialog: PageItem[] = [
      { name: 'Close', role: 'button', region: 'dialog' },
      { name: 'Recent chats', role: 'clickable', region: 'dialog' },
      ...shown.flatMap((c): PageItem[] => [
        { name: this.rowText(c), role: 'checkbox', region: 'dialog', checked: this.picker?.ticked.has(c.name) === true },
        { name: this.rowText(c), ...(c.about !== undefined ? { primary: c.name } : {}), role: 'button', region: 'dialog' },
      ]),
      ...(this.picker.ticked.size > 0 ? [{ name: 'Send', role: 'button', region: 'dialog' } as PageItem] : []),
    ];
    return [...dialog, ...left];
  }

  async attachFile(request: AttachFileRequest): Promise<AttachFileResult> {
    this.guard();
    this.calls.push(`attach:${request.name}`);
    const parts: Buffer[] = [];
    for (let offset = 0; offset < request.size; offset += 4) parts.push(await request.read(offset, Math.min(4, request.size - offset)));
    if (this.open !== null) {
      // the only file input is the message box's, for photos and videos
      if (!/^(image|video)\//.test(request.mime)) return { ok: false, reason: 'type_not_accepted', message: 'None of this page\'s file pickers accepts that kind of file.' };
      return { ok: true, snapshot: this.snapshot() };
    }
    if (this.noGlobalInput) return { ok: false, reason: 'no_file_input', message: 'This page has no file picker right now.' };
    this.picker = { search: '', ticked: new Set(), file: { name: request.name, size: request.size } };
    return { ok: true, snapshot: this.snapshot() };
  }

  // ------------------------------------------------------------------ what Send does
  private addBubble(to: PickerContact, bubble: { file?: string; text?: string }): void {
    const mark = this.marks === 'none' ? null : this.marks === 'failed' ? 'failed to send' : this.marks === 'delivered' ? 'delivered' : 'sent';
    const list = this.threads.get(to.name) ?? [];
    list.push({ ...bubble, mark, hiddenFor: this.markAfter });
    this.threads.set(to.name, list);
    // (a page that shows no mark for a message shows none at all: the older ones are not left behind as if they were this one's)
    if (this.marks === 'none') this.oldMarks = [];
    this.sentLog.push({ to: to.name, ...bubble });
  }

  private sendFromPicker(): void {
    if (this.picker === null) return;
    const file = this.picker.file.name;
    for (const name of this.picker.ticked) {
      const to = this.contacts.find((c) => c.name === name);
      if (to !== undefined) this.addBubble(to, { file });
    }
    const last = [...this.picker.ticked].pop();
    this.open = this.contacts.find((c) => c.name === last) ?? null; // the app opens the chat of the person it went to
    this.picker = null;
    this.search = '';
  }
}
