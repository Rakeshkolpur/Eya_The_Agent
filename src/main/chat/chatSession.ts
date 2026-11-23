import { createHash } from 'node:crypto';

/**
 * What Eya remembers, in memory only, about the chat she is working in — just enough to say who a message is going to and
 * to check the user agreed to exactly this send. It holds a contact's NAME (which the user said), never a message; it is
 * forgotten when Communication Access is switched off, when the app closes, or after a while. The one thing that outlives the app is a
 * fingerprint of each recent send (see SendJournal): not a name, not a word, only enough to know "this was already sent or begun".
 */

export interface OpenChat {
  readonly app: string | null;
  readonly label: string;
  readonly phoneEnding?: string;
  /** True when the open chat was chosen by an exact name or a whole phone number; false for a likely match (a name that merely contains what was said). */
  readonly verified?: boolean;
  /**
   * True when the page itself showed this chat open right after it was opened: its message box named it ("Type a message to Anna") or its header showed
   * the name. False when the page showed neither, so nothing can be said about which chat is open beyond the click having been made.
   */
  readonly headerChecked?: boolean;
  /**
   * Set when the page's message box names this chat by a PHONE NUMBER rather than by its name (WhatsApp Web does that for some saved contacts) and the
   * page's header — a button named exactly as the chat is — showed it to be the chat chosen. The box must go on naming that same number: if it names
   * another, the chat that is open is not this one.
   */
  readonly composerAs?: string;
  /** What showed it: the page's message box naming the chat (strong: re-read before every send) or its header. */
  readonly proof?: 'composer' | 'header';
  /** What the choice rested on, in a few words ("exact name", "part of the name"). */
  readonly matchedBy?: string;
  /** Other chats whose names CONTAIN this one's ("Ramesh Anna", "Anna Reddy" for "Anna"): a header that shows one of those is not this chat's. */
  readonly confusableWith?: readonly string[];
}

/** What is known about a send that was begun, so that the same thing is never sent twice on a guess. */
export type SendStatus = 'attempted' | 'sent' | 'uncertain' | 'failed';

/** One send as the journal keeps it: a fingerprint of the chat and the thing sent (never either), when, and how far it got. */
export interface JournalRow {
  readonly h: string;
  readonly status: SendStatus;
  readonly at: number;
}

/** Where sends are kept across Eya closing (see FileSendJournal). Without one they are kept in memory only, as before. */
export interface SendJournal {
  load(): readonly JournalRow[];
  save(rows: readonly JournalRow[]): void;
}

export interface SendRecord {
  readonly chat: string;
  /** What was sent, as a comparable key (the message words, or the file's name), never shown. */
  readonly key: string;
  readonly status: SendStatus;
  readonly at: number;
}

export interface Choice {
  readonly choice: number;
  readonly label: string;
  readonly phoneEnding?: string;
}

export interface SendAuthorization {
  readonly chat: string;
  readonly file?: string;
}

/** What was sent, as a key that two spellings of the same words share (case and extra spaces do not make a different message). */
function sendKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
}

const RECENT_LIMIT = 5;
/** A send is looked for in the journal for this long (a restart soon after a send is what it is for), and kept a little longer. */
const JOURNAL_KEEP_MS = 24 * 60 * 60_000;
const JOURNAL_MAX = 30;

/** A short fingerprint of "this chat and this thing": the same chat and the same words (or file) give the same one, and it cannot be read back. */
function fingerprint(chat: string, key: string): string {
  return createHash('sha256').update(`${chat.trim().toLowerCase()}\u0001${key}`).digest('hex').slice(0, 16);
}
const AUTHORIZATION_MS = 3 * 60_000;

export class ChatSession {
  private opened: (OpenChat & { at: number }) | null = null;
  private choices: readonly Choice[] = [];
  private recentChats: string[] = [];
  /** The same chats with when each was last opened (names and times only, in memory), for "him" or "the person I messaged a while ago". */
  private recentLog: Array<{ label: string; at: number; app: string | null }> = [];
  private file: { name: string; at: number; shown?: 'name_visible' | 'preview_opened' } | null = null;
  private marks: { list: readonly string[]; at: number } | null = null;
  private sent: { name: string; at: number } | null = null;
  private authorization: (SendAuthorization & { at: number }) | null = null;
  private sends: SendRecord[] = [];
  private queued: { file: string; at: number } | null = null;
  /** The message last typed into a chat app's message box (so the question can show it, and a yes can be carried out). */
  private typedText: { text: string; at: number } | null = null;
  /** A question "Send this message to this chat?" was put to the person (by the send gate): the chat and the app. A later yes is carried out by the application, not left to the AI to ask again. */
  private asked: { label: string; app: string; at: number } | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    /** How long a remembered chat, attachment or agreement stays good. */
    private readonly ttlMs = 10 * 60_000,
    /** Where sends are kept across Eya closing, so that a repeat after a restart is looked at, not sent again. */
    private readonly journal?: SendJournal,
  ) {
    const at = now();
    this.journalRows = (journal?.load() ?? []).filter((r) => at - r.at <= JOURNAL_KEEP_MS).slice(-JOURNAL_MAX);
  }

  private journalRows: JournalRow[];

  private fresh(at: number): boolean {
    return this.now() - at <= this.ttlMs;
  }

  // ------------------------------------------------------------- the open chat
  openedChat(chat: OpenChat): void {
    const changed = this.opened === null || this.opened.label !== chat.label;
    this.opened = { ...chat, at: this.now() };
    this.recentChats = [chat.label, ...this.recentChats.filter((l) => l !== chat.label)].slice(0, RECENT_LIMIT);
    this.recentLog = [{ label: chat.label, at: this.now(), app: chat.app }, ...this.recentLog.filter((r) => r.label !== chat.label)].slice(0, RECENT_LIMIT);
    this.choices = [];
    if (changed) {
      // An attachment, an agreement and the marks seen before a send belong to the chat they were made for.
      this.file = null;
      this.marks = null;
      this.sent = null;
      this.authorization = null;
      this.typedText = null;
      this.asked = null;
    }
  }

  chat(): OpenChat | null {
    if (this.opened === null || !this.fresh(this.opened.at)) return null;
    const { at: _at, ...chat } = this.opened;
    return chat;
  }

  /** Chats used earlier in this conversation (most recent first), to settle a tie between two names. */
  recent(): readonly string[] {
    return this.recentChats;
  }

  /** Chats opened in this conversation and when (most recent first): who "him" or "the last person" can mean. Names and times only, in memory. */
  recentRecipients(): ReadonlyArray<{ readonly label: string; readonly at: number; readonly app: string | null }> {
    return this.recentLog;
  }

  // ------------------------------------------------------- "which one did you mean?"
  offerChoices(list: ReadonlyArray<{ label: string; phoneEnding?: string }>): readonly Choice[] {
    this.choices = list.map((c, i) => ({ choice: i + 1, label: c.label, ...(c.phoneEnding !== undefined ? { phoneEnding: c.phoneEnding } : {}) }));
    return this.choices;
  }

  pick(choice: number): Choice | null {
    return this.choices.find((c) => c.choice === choice) ?? null;
  }

  // --------------------------------------------------------------- the attachment
  /** `shown`: how the page showed the attachment when it was checked — its name, or just a preview that opened. */
  attached(name: string, shown?: 'name_visible' | 'preview_opened'): void {
    this.file = { name, at: this.now(), ...(shown !== undefined ? { shown } : {}) };
  }

  attachment(): string | null {
    return this.file !== null && this.fresh(this.file.at) ? this.file.name : null;
  }

  /** How the page showed the attachment when it was checked, if it is still the one being sent. */
  attachedAs(): 'name_visible' | 'preview_opened' | null {
    return this.file !== null && this.fresh(this.file.at) ? (this.file.shown ?? null) : null;
  }

  // ------------------------------------------- the delivery marks before a send
  /** The delivery marks showing before something is sent, so a mark that appears afterwards can be told apart from an old one. */
  markBaseline(marks: readonly string[]): void {
    this.marks = { list: marks, at: this.now() };
  }

  /** The marks seen before the send, or null when none were taken (or they are too old to trust). */
  baseline(): readonly string[] | null {
    return this.marks !== null && this.fresh(this.marks.at) ? this.marks.list : null;
  }

  // ---------------------------------------------- the user's yes to a particular send
  /** The user has said yes to sending `file` (or a typed message) to `chat`. */
  authorize(send: SendAuthorization): void {
    this.authorization = { ...send, at: this.now() };
  }

  /** True only if the user agreed to exactly this: the same chat, and the same file if there is one. */
  isAuthorized(chat: string, file?: string): boolean {
    const a = this.authorization;
    // A yes is good for a few minutes — long enough to attach and click Send, not long enough to be forgotten about.
    if (a === null || this.now() - a.at > Math.min(this.ttlMs, AUTHORIZATION_MS)) return false;
    return a.chat === chat && (a.file ?? null) === (file ?? null);
  }

  /**
   * The Send click that the user's yes covered has been made: the yes is used up (the next send asks again), and the file now counts
   * as the one that was just sent — waiting to be checked — rather than one that is still waiting to go.
   */
  sendMade(): void {
    this.authorization = null;
    this.typedText = null;
    this.asked = null;
    if (this.file !== null) this.sent = { name: this.file.name, at: this.now() };
    this.file = null;
  }

  /** The user backed out (cancelled the preview, closed it): the yes and the attachment are withdrawn. */
  sendCancelled(): void {
    this.authorization = null;
    this.file = null;
    this.typedText = null;
    this.asked = null;
  }

  /** A message was typed into the message box of the open chat. */
  typed(text: string): void {
    this.typedText = { text, at: this.now() };
  }

  typedMessage(): string | null {
    return this.typedText !== null && this.fresh(this.typedText.at) ? this.typedText.text : null;
  }

  /** The person was asked whether to send the typed message to this chat. */
  askedToSend(label: string, app: string): void {
    this.asked = { label, app, at: this.now() };
  }

  /** The send that was asked about and not answered yet (the chat, the app and the text), while it is fresh and the message is still the one typed. */
  askedSend(): { readonly label: string; readonly app: string; readonly text: string } | null {
    const typed = this.typedMessage();
    return this.asked !== null && this.fresh(this.asked.at) && typed !== null ? { label: this.asked.label, app: this.asked.app, text: typed } : null;
  }

  /** The file whose send was just made and has not been checked yet. */
  lastSent(): string | null {
    return this.sent !== null && this.fresh(this.sent.at) ? this.sent.name : null;
  }

  /** Called once a send has been checked (or given up on): everything about it is forgotten. */
  spent(): void {
    this.typedText = null;
    this.asked = null;
    this.authorization = null;
    this.file = null;
    this.marks = null;
    this.sent = null;
  }

  // ----------------------------------------------------- what was sent (never sent twice on a guess)
  /** Notes a send: begun (attempted), seen in the chat (sent), begun but not seen either way (uncertain), or shown to have failed. */
  noteSend(chat: string, key: string, status: SendStatus): void {
    const k = sendKey(key);
    this.sends = [...this.sends.filter((s) => !(s.chat === chat && s.key === k)), { chat, key: k, status, at: this.now() }].slice(-20);
    if (this.journal === undefined) return;
    const h = fingerprint(chat, k);
    const at = this.now();
    this.journalRows = [...this.journalRows.filter((r) => r.h !== h && at - r.at <= JOURNAL_KEEP_MS), { h, status, at }].slice(-JOURNAL_MAX);
    // (written at once: a send that was begun must be on disk before the check that follows it, or a restart in between would forget it)
    this.journal.save(this.journalRows);
  }

  /** The latest record of this very thing sent to this chat, if it is recent enough to matter. */
  lastSend(chat: string, key: string): SendRecord | null {
    const k = sendKey(key);
    const found = this.sends.find((s) => s.chat === chat && s.key === k);
    if (found !== undefined) return this.fresh(found.at) ? found : null;
    // Not in memory (Eya was closed since): the journal remembers that it was sent, or begun and never seen.
    const h = fingerprint(chat, k);
    const row = this.journalRows.find((r) => r.h === h);
    return row !== undefined && this.fresh(row.at) ? { chat, key: k, status: row.status, at: row.at } : null;
  }

  // ------------------------------------------- a file waiting in the app's "who to send it to" step
  /** A file has been given to the app's "Select chats" step: it is waiting there, to go to whoever is ticked. Nothing has been sent. */
  shareQueued(file: string): void {
    this.queued = { file, at: this.now() };
  }

  /** The file waiting in that step, if it is recent enough to still be the one (an old, forgotten step is not trusted). */
  queuedShare(): string | null {
    return this.queued !== null && this.now() - this.queued.at <= Math.min(this.ttlMs, 5 * 60_000) ? this.queued.file : null;
  }

  shareDone(): void {
    this.queued = null;
  }

  // ----------------------------------------------------------------------- forget
  clear(): void {
    this.queued = null;
    this.sends = [];
    this.opened = null;
    this.choices = [];
    this.recentChats = [];
    this.recentLog = [];
    this.journalRows = [];
    this.journal?.save([]);
    this.file = null;
    this.marks = null;
    this.sent = null;
    this.authorization = null;
    this.typedText = null;
    this.asked = null;
  }
}
