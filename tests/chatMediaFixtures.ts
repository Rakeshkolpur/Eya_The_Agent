import type { ActOnPageResult, BrowserAutomationService, BrowserItemClicker, BrowserItemLister, BrowserKeyPress, FindOnPageResult, PageItem, ReadPageResult } from '../src/main/browser/BrowserAutomationService';
import type { PageSnapshot } from '../src/main/browser/pageSnapshot';
import { CommunicationAccessError } from '../src/main/browser/errors';

/**
 * A mock of WhatsApp Web's "Media" panel (left rail → Media → Docs), shaped as the real page was found to be (read-only, 27 Oct 2026): a search box that exists only
 * while the panel is open, rows of "badge · file name · size • TYPE · caption · sender · date", a menu button per row whose name carries the file and the sender, and a
 * menu whose "Go to message" opens the chat the file is in. Mock only: nothing here proves the real page behaves so.
 */
export interface FakeDoc {
  readonly file: string;
  readonly type: string;
  readonly size: string;
  readonly caption?: string;
  /** "You" or a name. */
  readonly sender: string;
  /** As the page writes it: "Today at 09:10", "Yesterday at 18:20", "Thursday", "21/10/2026". */
  readonly when: string;
  /** The chat the file is in (what the message box names once "Go to message" opened it). */
  readonly chat: string;
}

export const DOCS: readonly FakeDoc[] = [
  { file: 'Fee receipts.xlsx', type: 'XLSX', size: '1.2 MB', sender: 'You', when: 'Today at 09:10', chat: 'Priya Singh' },
  { file: 'Resume Rakesh.pdf', type: 'PDF', size: '3 MB', sender: 'You', when: 'Thursday', chat: 'Anna Reddy' },
  { file: 'Bail petition draft.docx', type: 'DOCX', size: '48 KB', caption: 'Please check page 3 at 10:30', sender: 'Anna Reddy', when: 'Yesterday at 18:20', chat: 'Anna Reddy' },
  { file: 'Agreement final.pdf', type: 'PDF', size: '800 KB', sender: 'You', when: '21/09/2026', chat: 'Ravi Kumar' },
];

export class FakeMediaApp implements BrowserAutomationService, BrowserItemLister, BrowserItemClicker, BrowserKeyPress {
  url = 'https://web.whatsapp.com/';
  title = 'WhatsApp';
  panelOpen = false;
  tab: 'media' | 'docs' = 'media';
  searchText = '';
  chat: string | null = null;
  accessOff = false;
  loginScreen = false;
  loadingFor = 0;
  /** The panel's own search shows nothing for any word (the real one answers late and not always completely). */
  searchBroken = false;
  /** The search box takes the text but the list does not narrow (it keeps showing every row). */
  searchIgnored = false;
  /** A search for part of a name shows each file once (a list that has not filled in yet); only the whole name shows every copy. */
  hideCopiesUntilExact = false;
  /** "Go to message" is pressed but the page stays where it was (the chat does not change, the message is not shown). */
  gotoDoesNothing = false;
  /** The file whose message the page is showing (after "Go to message"). */
  focusedFile: string | null = null;
  /** How many rows were showing each time a row menu was opened. */
  rowsWhenMenuOpened: number[] = [];
  /** The menu has no "Go to message" entry. */
  noGoto = false;
  /** The chat's message box names it by its number, as the real page does for some saved contacts. */
  composerAsNumber: string | null = null;
  /** Documents in the open chat's own messages (they carry a clock time where the panel's rows carry a caption). */
  bubbles: Array<{ file: string; type: string; size: string }> = [];
  calls: string[] = [];
  /** Every menu entry that was pressed (nothing but "Go to message" may ever be). */
  pressed: string[] = [];
  private menuFor: number | null = null;

  constructor(public docs: readonly FakeDoc[] = DOCS) {}

  private guard(): void {
    if (this.accessOff) throw new CommunicationAccessError('WhatsApp');
  }

  /** The rows the panel shows now. */
  visible(): readonly FakeDoc[] {
    if (!this.panelOpen || this.tab !== 'docs') return [];
    const q = this.searchText.trim().toLowerCase();
    if (q === '' || this.searchIgnored) return this.docs;
    if (this.searchBroken) return [];
    const hits = this.docs.filter((d) => `${d.file} ${d.caption ?? ''} ${d.sender}`.toLowerCase().includes(q));
    if (this.hideCopiesUntilExact && !this.docs.some((d) => d.file.toLowerCase() === q)) return hits.filter((d, i) => hits.findIndex((x) => x.file === d.file) === i);
    return hits;
  }

  snapshot(): PageSnapshot {
    if (this.loginScreen) return { url: this.url, title: this.title, headings: ['Use WhatsApp on your phone'], links: [], buttons: [], inputs: [], dialogs: [], truncated: false, visibleText: 'Scan the QR code to log in' };
    if (this.loadingFor > 0) return { url: this.url, title: this.title, headings: [], links: [], buttons: [], inputs: [], dialogs: [], truncated: false, visibleText: 'Loading your chats' };
    const composer = this.chat === null ? [] : [`Type a message to ${this.composerAsNumber ?? this.chat}`];
    return {
      url: this.url,
      title: this.title,
      headings: this.panelOpen ? ['Media — from all chats'] : [],
      links: [],
      buttons: ['Chats', 'Media', ...(this.panelOpen ? ['Docs', 'Close'] : [])],
      inputs: ['Search or start a new chat', ...(this.panelOpen ? ['Search by sender, caption or filename'] : []), ...composer],
      dialogs: [],
      truncated: false,
    };
  }

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
    return seen;
  }

  async readPage(): Promise<ReadPageResult> {
    this.guard();
    this.calls.push('read');
    const lines: string[] = ['WhatsApp', 'Chats', 'Anna Reddy', 'see you', 'Priya Singh', 'thanks'];
    if (this.panelOpen) lines.push('Media — from all chats', 'Docs', 'Links', 'Search');
    for (const d of this.visible()) lines.push(d.type, d.file, `${d.size} • ${d.type}`, d.caption ?? 'No caption', d.sender, d.when);
    if (this.chat !== null) {
      for (const b of this.bubbles) lines.push(b.file, `${b.size} • ${b.type}`, '21:14');
      if (this.bubbles.length > 0) lines.push('TODAY', 'thanks');
    }
    const text = lines.join('\n');
    return { url: this.url, title: this.title, text, offset: 0, nextOffset: null, totalChars: text.length };
  }

  async listItems(): Promise<PageItem[]> {
    this.guard();
    this.calls.push('items');
    const items: PageItem[] = [
      { name: 'Chats', role: 'button', region: 'nav' },
      { name: 'Media', role: 'button', region: 'nav' },
    ];
    // (as on the real page: each row has a "Download" button and a menu button named only "Message's context menu", all in the panel)
    this.visible().forEach((d) => items.push({ name: `Download "${d.file}"`, role: 'button', region: 'dialog' }, { name: "Message's context menu", role: 'button', region: 'dialog' }));
    if (this.menuFor !== null) {
      for (const entry of ['Reply', 'Forward', 'Star', ...(this.noGoto ? [] : ['Go to message']), 'Delete']) items.push({ name: entry, role: 'button' });
    }
    return items;
  }

  private ok(): ActOnPageResult {
    return { ok: true, snapshot: this.snapshot() };
  }

  private notFound(): ActOnPageResult {
    return { ok: false, reason: 'not_found', snapshot: this.snapshot() };
  }

  async clickOnPage(text: string): Promise<ActOnPageResult> {
    this.guard();
    this.calls.push(`click:${text}`);
    if (text === 'Media') {
      this.panelOpen = true;
      this.tab = 'media';
      this.searchText = '';
      return this.ok();
    }
    if (text === 'Docs' && this.panelOpen) {
      this.tab = 'docs';
      return this.ok();
    }
    if (text === 'Close' && this.panelOpen) {
      this.panelOpen = false;
      this.searchText = '';
      this.menuFor = null;
      return this.ok();
    }
    if (text === "Message's context menu") return this.openMenu();
    if (this.menuFor !== null && ['Reply', 'Forward', 'Star', 'Delete', 'Go to message'].includes(text)) {
      this.pressed.push(text);
      const doc = this.visible()[this.menuFor] as FakeDoc;
      this.menuFor = null;
      if (text === 'Go to message' && !this.gotoDoesNothing) {
        this.chat = doc.chat;
        this.focusedFile = doc.file;
        this.panelOpen = false;
      }
      return this.ok();
    }
    return this.notFound();
  }

  private openMenu(): ActOnPageResult {
    const rows = this.visible();
    if (rows.length === 0) return this.notFound();
    this.rowsWhenMenuOpened.push(rows.length);
    this.menuFor = 0; // the first one showing
    return this.ok();
  }

  async clickItem(want: { readonly primary?: string; readonly name?: string; readonly region?: string; readonly role?: string }): Promise<ActOnPageResult> {
    this.guard();
    this.calls.push(`item:${want.name ?? want.primary ?? ''}`);
    if (want.name === "Message's context menu" && want.region === 'dialog' && want.role === 'button') return this.openMenu();
    return this.notFound();
  }

  async fillOnPage(label: string, value: string): Promise<ActOnPageResult> {
    this.guard();
    this.calls.push(`fill:${value}`);
    if (!/search by sender/i.test(label) || !this.panelOpen) return this.notFound();
    this.searchText = value;
    return this.ok();
  }

  async pressEscape(): Promise<{ readonly ok: true; readonly snapshot: PageSnapshot }> {
    this.calls.push('escape');
    this.menuFor = null;
    return { ok: true, snapshot: this.snapshot() };
  }

  async findOnPage(query: string): Promise<FindOnPageResult> {
    this.guard();
    this.calls.push(`find:${query}`);
    // the file's own message is in the page only once "Go to message" took the page to it (and the list's panel is not covering it)
    const shown = this.focusedFile === query && !this.panelOpen;
    return { url: this.url, title: this.title, query, matches: [], textMatches: shown ? [query] : [], totalControls: 0 };
  }

  // (not used by finding a file)
  async goBack(): Promise<ActOnPageResult> {
    return this.ok();
  }
  async goForward(): Promise<ActOnPageResult> {
    return this.ok();
  }
  async reload(): Promise<ActOnPageResult> {
    return this.ok();
  }
  async scroll(): Promise<ActOnPageResult> {
    return this.ok();
  }
  async searchWeb(): Promise<never[]> {
    return [];
  }
  async close(): Promise<void> {}
}
