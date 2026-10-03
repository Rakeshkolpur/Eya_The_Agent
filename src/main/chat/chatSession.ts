/**
 * What Eya remembers, in memory only, about the chat she is working in — just enough to say who a message is going to and
 * to check the user agreed to exactly this send. It holds a contact's NAME (which the user said), never a message; it is
 * never written to disk and is forgotten when Communication Access is switched off, when the app closes, or after a while.
 */

export interface OpenChat {
  readonly app: string | null;
  readonly label: string;
  readonly phoneEnding?: string;
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

const RECENT_LIMIT = 5;
const AUTHORIZATION_MS = 3 * 60_000;

export class ChatSession {
  private opened: (OpenChat & { at: number }) | null = null;
  private choices: readonly Choice[] = [];
  private recentChats: string[] = [];
  private file: { name: string; at: number } | null = null;
  private marks: { list: readonly string[]; at: number } | null = null;
  private sent: { name: string; at: number } | null = null;
  private authorization: (SendAuthorization & { at: number }) | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    /** How long a remembered chat, attachment or agreement stays good. */
    private readonly ttlMs = 10 * 60_000,
  ) {}

  private fresh(at: number): boolean {
    return this.now() - at <= this.ttlMs;
  }

  // ------------------------------------------------------------- the open chat
  openedChat(chat: OpenChat): void {
    const changed = this.opened === null || this.opened.label !== chat.label;
    this.opened = { ...chat, at: this.now() };
    this.recentChats = [chat.label, ...this.recentChats.filter((l) => l !== chat.label)].slice(0, RECENT_LIMIT);
    this.choices = [];
    if (changed) {
      // An attachment, an agreement and the marks seen before a send belong to the chat they were made for.
      this.file = null;
      this.marks = null;
      this.sent = null;
      this.authorization = null;
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

  // ------------------------------------------------------- "which one did you mean?"
  offerChoices(list: ReadonlyArray<{ label: string; phoneEnding?: string }>): readonly Choice[] {
    this.choices = list.map((c, i) => ({ choice: i + 1, label: c.label, ...(c.phoneEnding !== undefined ? { phoneEnding: c.phoneEnding } : {}) }));
    return this.choices;
  }

  pick(choice: number): Choice | null {
    return this.choices.find((c) => c.choice === choice) ?? null;
  }

  // --------------------------------------------------------------- the attachment
  attached(name: string): void {
    this.file = { name, at: this.now() };
  }

  attachment(): string | null {
    return this.file !== null && this.fresh(this.file.at) ? this.file.name : null;
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
    if (this.file !== null) this.sent = { name: this.file.name, at: this.now() };
    this.file = null;
  }

  /** The user backed out (cancelled the preview, closed it): the yes and the attachment are withdrawn. */
  sendCancelled(): void {
    this.authorization = null;
    this.file = null;
  }

  /** The file whose send was just made and has not been checked yet. */
  lastSent(): string | null {
    return this.sent !== null && this.fresh(this.sent.at) ? this.sent.name : null;
  }

  /** Called once a send has been checked (or given up on): everything about it is forgotten. */
  spent(): void {
    this.authorization = null;
    this.file = null;
    this.marks = null;
    this.sent = null;
  }

  // ----------------------------------------------------------------------- forget
  clear(): void {
    this.opened = null;
    this.choices = [];
    this.recentChats = [];
    this.file = null;
    this.marks = null;
    this.sent = null;
    this.authorization = null;
  }
}
