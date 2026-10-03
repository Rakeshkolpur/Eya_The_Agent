import type {
  ActOnPageResult,
  AttachFileRequest,
  AttachFileResult,
  BrowserAutomationService,
  BrowserFileAttach,
  BrowserItemLister,
  ClickGate,
  FillOptions,
  FindOnPageResult,
  PageItem,
  ReadPageResult,
} from '../src/main/browser/BrowserAutomationService';
import { CommunicationAccessError } from '../src/main/browser/errors';
import type { PageSnapshot } from '../src/main/browser/pageSnapshot';
import { normalizeText } from '../src/main/chat/contactMatch';
import type { FileAccess } from '../src/main/tools/impl/chatTools';

export interface FakeChatRow {
  readonly name: string;
  readonly phone: string;
  /** A private message preview that must never reach the model. */
  readonly preview: string;
}

export const ROWS: readonly FakeChatRow[] = [
  { name: 'Rahul Sharma', phone: '+91 98765 00432', preview: 'See you tomorrow at the clinic' },
  { name: 'Rahul Verma', phone: '+91 91234 55987', preview: 'my password is hunter2' },
  { name: 'Priya Singh', phone: '+91 99887 70432', preview: 'Thanks for the loan' },
  { name: 'Mum', phone: '+91 90000 11111', preview: 'Call me' },
  { name: 'Amit Kumar', phone: '+91 98111 22333', preview: 'Done' },
];

export type Behaviour = 'normal' | 'no_picker' | 'never_shows' | 'fails' | 'pending' | 'no_marks' | 'old_mark_only' | 'stays_in_preview';

/**
 * A stand-in for a chat app open in the user's browser, driven through the same service interface the tools use. It
 * behaves like the mock page in tests/fixtures: a search box that filters, rows, a header, an attach step that shows a
 * preview, a Send that puts the message in the thread with a delivery mark.
 */
export class FakeChatApp implements BrowserAutomationService, BrowserItemLister, BrowserFileAttach {
  url = 'https://web.whatsapp.com/';
  title = 'WhatsApp';
  search = '';
  open: FakeChatRow | null = null;
  pickerExists = true;
  /** What the page shows for the chat that is open. */
  headerInHeadings = true;
  behaviour: Behaviour = 'normal';
  accessOff = false;
  calls: string[] = [];
  attached: { name: string; mime: string; size: number; bytes: Buffer; prefer?: string } | null = null;
  previewOpen = false;
  thread: Array<{ text: string; file?: string; mark: string | null }> = [];
  /** Delivery marks of OLDER messages already in the thread. */
  oldMarks: string[] = ['read'];

  constructor(public rows: readonly FakeChatRow[] = ROWS) {}

  private guard(): void {
    if (this.accessOff) throw new CommunicationAccessError('WhatsApp');
  }

  private visibleRows(): readonly FakeChatRow[] {
    const q = this.search.trim().toLowerCase();
    if (q === '') return this.rows;
    const digits = q.replace(/\D/g, '');
    return this.rows.filter((r) => r.name.toLowerCase().includes(q) || (digits !== '' && r.phone.replace(/\D/g, '').includes(digits)));
  }

  private marks(): string[] {
    const own = this.thread.flatMap((m) => (m.mark === null ? [] : [m.mark]));
    return [...this.oldMarks, ...own].slice(-6);
  }

  snapshot(): PageSnapshot {
    const marks = this.marks();
    return {
      url: this.url,
      title: this.open !== null && !this.headerInHeadings ? this.title : this.open !== null ? `${this.open.name} - ${this.title}` : this.title,
      headings: this.open !== null && this.headerInHeadings ? [this.open.name] : [],
      links: [],
      buttons: ['Attach', 'Send'],
      inputs: ['Search or start new chat', ...(this.open !== null ? ['Type a message'] : [])],
      dialogs: this.previewOpen && this.attached !== null ? [`Send file ${this.attached.name} Add a caption`] : [],
      truncated: false,
      ...(marks.length > 0 ? { messageStatus: marks } : {}),
    };
  }

  async openWebsite(): Promise<PageSnapshot> {
    this.calls.push('open');
    return this.snapshot();
  }

  async inspectPage(): Promise<PageSnapshot> {
    this.guard();
    this.calls.push('inspect');
    return this.snapshot();
  }

  async findOnPage(query: string): Promise<FindOnPageResult> {
    this.guard();
    this.calls.push(`find:${query}`);
    const q = normalizeText(query);
    const hit = this.thread.some((m) => normalizeText(`${m.text} ${m.file ?? ''}`).includes(q));
    return { url: this.url, title: this.title, query, matches: [], textMatches: hit ? [`…${query}…`] : [], totalControls: 0 };
  }

  async readPage(): Promise<ReadPageResult> {
    this.guard();
    return { url: this.url, title: this.title, text: '', offset: 0, nextOffset: null, totalChars: 0 };
  }

  async clickOnPage(text: string, gate?: ClickGate): Promise<ActOnPageResult> {
    this.guard();
    this.calls.push(`click:${text}`);
    const row = this.rows.find((r) => text.startsWith(r.name));
    if (row !== undefined) {
      this.open = row;
      return { ok: true, snapshot: this.snapshot() };
    }
    if (text === 'Send') {
      const why = gate?.({ name: 'Send', role: 'button' }) ?? null;
      if (why !== null) return { ok: false, reason: 'needs_confirmation', why, target: 'Send', snapshot: this.snapshot() };
      this.send();
      return { ok: true, snapshot: this.snapshot() };
    }
    if (text === 'Attach') {
      this.pickerExists = true;
      return { ok: true, snapshot: this.snapshot() };
    }
    return { ok: false, reason: 'not_found', snapshot: this.snapshot() };
  }

  async fillOnPage(label: string, value: string, options?: FillOptions): Promise<ActOnPageResult> {
    this.guard();
    this.calls.push(`fill:${label}=${value}${options?.submit === true ? '+enter' : ''}`);
    if (/search/i.test(label)) this.search = value;
    return { ok: true, snapshot: this.snapshot() };
  }

  async goBack(): Promise<ActOnPageResult> {
    return { ok: true, snapshot: this.snapshot() };
  }
  async goForward(): Promise<ActOnPageResult> {
    return { ok: true, snapshot: this.snapshot() };
  }
  async reload(): Promise<ActOnPageResult> {
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

  async listItems(): Promise<PageItem[]> {
    this.guard();
    this.calls.push('list');
    return [
      { name: 'Chats', role: 'clickable', region: 'nav' },
      { name: 'Attach', role: 'button' },
      ...this.visibleRows().map((r): PageItem => ({ name: `${r.name} ${r.preview} 10:42`, primary: r.name, role: 'clickable' })),
    ];
  }

  async attachFile(request: AttachFileRequest): Promise<AttachFileResult> {
    this.guard();
    this.calls.push(`attach:${request.name}`);
    if (!this.pickerExists || this.behaviour === 'no_picker') {
      this.pickerExists = false;
      return { ok: false, reason: 'no_file_input', message: 'This page has no file picker right now. Open its attach menu first.' };
    }
    const parts: Buffer[] = [];
    for (let offset = 0; offset < request.size; offset += 4) parts.push(await request.read(offset, Math.min(4, request.size - offset)));
    this.attached = { name: request.name, mime: request.mime, size: request.size, bytes: Buffer.concat(parts), ...(request.prefer !== undefined ? { prefer: request.prefer } : {}) };
    this.previewOpen = this.behaviour !== 'never_shows';
    return { ok: true, snapshot: this.snapshot() };
  }

  /** The user's (or Eya's) Send. */
  private send(): void {
    if (this.behaviour === 'stays_in_preview') return;
    const file = this.attached?.name;
    const text = file === undefined ? 'a typed message' : '';
    const mark = this.behaviour === 'fails' ? 'failed to send' : this.behaviour === 'pending' ? 'pending' : this.behaviour === 'no_marks' || this.behaviour === 'old_mark_only' ? null : 'sent';
    this.thread.push({ text, ...(file !== undefined ? { file } : {}), mark });
    if (this.behaviour === 'no_marks') this.oldMarks = [];
    this.previewOpen = false;
  }
}

/** Files on a pretend disk. */
export class FakeDisk implements FileAccess {
  constructor(public entries: Record<string, { isFile: boolean; isDirectory: boolean; size: number; content?: Buffer }> = {}) {}
  async stat(path: string) {
    return this.entries[path] ?? null;
  }
  async read(path: string, offset: number, length: number): Promise<Buffer> {
    const e = this.entries[path];
    return (e?.content ?? Buffer.alloc(0)).subarray(offset, offset + length);
  }
}
