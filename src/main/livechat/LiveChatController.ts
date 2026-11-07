import { randomUUID } from 'node:crypto';
import type { ChatReadResult, LiveChatMessage } from '@main/browser/BrowserAutomationService';
import { BrowserUnavailableError, CommunicationAccessError } from '@main/browser/errors';
import { maskNumbersIn } from '@main/chat/recipientResolver';
import { rootLogger } from '@main/logging/logger';
import { EMPTY_LIVE_CHAT_VIEW } from '@shared/liveChat';
import type { LiveChatEnableView, LiveChatMode, LiveChatPause, LiveChatRequest, LiveChatResult, LiveChatState, LiveChatView, LiveChoiceView, LiveDraftStatus, LiveRelation } from '@shared/liveChat';
import { relationFrom } from './style';
import { autoFrom, autoGate, autoLimitsSaid, IDLE_STOP_MS } from './auto';
import { generateDraft, generateNudge, generateOpening } from './draft';
import type { DraftAI, DraftOutcome } from './draft';
import { MAX_MEDIA_PER_LOOK, summaryLine } from './media';
import { askedJustBefore, baseline, markHandled, MAX_CONTEXT, needsReply, plainText, rollContext, scan, unhandled, unmark } from './messages';
import type { MediaNote } from './messages';
import { afterRestart, canMove, isOver, MAX_MEDIA, MAX_NOTES, newSession, scrub, WATCHING } from './session';
import type { SendRecord, SendStatus, StoredDraft, StoredSession } from './session';
import type { LiveChatStore } from './LiveChatStore';

const log = rootLogger.child('livechat');

/**
 * The Live Chat Companion: ONE chat the person chose is watched (the page says when it changes), each new incoming message is read, a reply is drafted, and — only as
 * far as the person allowed — sent and then checked. It reuses what Eya already has for WhatsApp: the chat tools to open the chat and to send (and so the Send gate,
 * Communication Access and the plugin's permissions), the browser extension's events, the task journal and the send checks. This class decides WHEN; those do the work.
 *
 * What is never done: a send without a persisted record made first; a send into a chat that is not the verified one; a send of a draft that a newer message has
 * outdated; a second answer to the same messages; a repeat of a send whose outcome is not known; any reading of a chat other than the open, chosen one; any message
 * text in the logs.
 */

// ------------------------------------------------------------------------------------------------------------------------------------ dependencies
export type OpenOutcome =
  | { readonly kind: 'opened'; readonly label: string; readonly verified: boolean; readonly ending?: string }
  | { readonly kind: 'ambiguous'; readonly options: readonly { readonly label: string; readonly choice: number }[] }
  | { readonly kind: 'none' | 'failed' | 'blocked' | 'login' | 'loading' | 'unavailable'; readonly say: string };

export type SendPress =
  | { readonly kind: 'pressed' }
  /** Nothing was sent: the box was not found, the Send gate refused, or the chat was not the chosen one. */
  | { readonly kind: 'not_sent'; readonly say: string };

export interface SendCheck {
  readonly status: 'sent' | 'failed' | 'pending' | 'unconfirmed' | 'not_found';
  /** The page's own mark: sent, delivered or read. */
  readonly mark?: string;
}

export interface LiveChatActions {
  /** Finds and opens the chat (the find_chat tool). */
  open(query: string): Promise<OpenOutcome>;
  choose(choice: number): Promise<OpenOutcome>;
  /** Whether the chat with this name is the one open now, from what the page itself shows. */
  isOpen(label: string): Promise<'yes' | 'wrong' | 'no' | 'unknown'>;
  /** Puts the text in the message box (not sent). */
  typeInBox(text: string): Promise<{ readonly ok: boolean; readonly say?: string }>;
  /** Types the text and presses Send, through the same tools and gate as any send. `kind: 'pressed'` means the message may have gone, whatever comes next. */
  typeAndSend(label: string, text: string): Promise<SendPress>;
  /** Looks in the chat for what was sent (the verify_sent tool). */
  verify(text: string): Promise<SendCheck>;
}

/** A picture or document from the chat, taken into the Downloads folder (and only there), or why not (`say`: a sentence that is safe to show). */
export type MediaSaved = { readonly ok: true; readonly path: string; readonly name: string } | { readonly ok: false; readonly say: string };

/** What the live chat may do with the pictures and documents the other person sends. */
export interface LiveChatMedia {
  /** Gets the picture or document that message carries into the Downloads folder (see media.ts for what is taken and what never is). */
  save(messageId: string, kind: 'image' | 'document'): Promise<MediaSaved>;
  /** Reads the saved file and says in a sentence what it shows or says; null when it cannot be read. */
  read(path: string, kind: 'image' | 'document', name: string): Promise<string | null>;
}

export interface LiveWatcher {
  start(): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string; readonly pause: LiveChatPause | null }>;
  stop(): Promise<void>;
  read(max: number): Promise<ChatReadResult>;
  onChange(cb: (reason: string) => void): () => void;
  onLost(cb: (why: LiveChatPause) => void): () => void;
  /** The connection to the browser came back (after it was lost). Optional: a watcher without it is simply not resumed by itself. */
  onBack?(cb: () => void): () => void;
}

export interface LiveChatDeps {
  readonly store: LiveChatStore;
  readonly ai: DraftAI;
  readonly watcher: LiveWatcher;
  readonly chat: LiveChatActions;
  /** Null when the plugin may do this (see PluginManager.permitsApp); otherwise why not. */
  readonly permits: (permission: string) => string | null;
  /**
   * The one "Enable live chat" switch (see LiveChatSwitch). `standing` is true while it is on and everything it covers is still in place: the person's standing
   * confirmation that the people they live-chat with know replies are AI-assisted, so a live chat starts replying by itself with no question. Absent: no such switch.
   */
  readonly enable?: {
    view(): LiveChatEnableView;
    standing(): boolean;
    turnOn(): { readonly ok: boolean; readonly message: string };
    turnOff(): { readonly ok: boolean; readonly message: string };
    /** What Eya calls the person in the chat ("<name>'s assistant"); empty when not known. */
    ownerName(): string;
    setOwnerName(name: string): { readonly ok: boolean; readonly message: string };
  };
  /** Null while Communication Access allows the chat app; otherwise why not. */
  readonly allowed: () => string | null;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Tells something to the person outside the window (a reply is ready; auto-reply stopped). Never carries the words of a message. */
  readonly alert?: (message: string) => void;
  /**
   * Says something to the person themself, in Eya's own voice and in the chat with Eya: what the other person asked her to pass on ("Rakesh, the number ending 5 5 3 2 says: your
   * father wants to talk to you"). `spoken` is made for the voice (a number is said by its last digits), `shown` for the screen. Only ever what was said FOR the person.
   */
  readonly say?: (spoken: string, shown: string) => void;
  /** Pictures and documents the other person sends are taken into Downloads and read. Absent: they are not looked at (as before). */
  readonly media?: LiveChatMedia;
  /** How long the other person may stay silent before the live chat stops by itself (ms; fifteen minutes by default; 0 = never). */
  readonly idleStopMs?: number;
  /** Writes down WHY something stopped or could not start, as a category and counts only (see chat/chatDiagnostics.ts): never a word of a chat. */
  readonly diagnose?: (event: { readonly op: string; readonly category?: string; readonly counts?: Readonly<Record<string, number>> }) => void;
  /** The backstop look at the chat, in case an event was missed (ms; 15 s by default). 0 switches it (and the fast check) off. */
  readonly reconcileMs?: number;
  /** How often, while paused because the chosen chat was left or closed, the page is looked at to see whether that chat is open again (ms; 4 s by default; 0 = never). */
  readonly comeBackMs?: number;
  /** How often the chat is looked at once the page has been seen NOT to announce a new message (ms; 5 s by default). */
  readonly fastCheckMs?: number;
  readonly timers?: { readonly set: (fn: () => void, ms: number) => unknown; readonly clear: (t: unknown) => void };
}

/** The id the first message carries in place of the incoming messages a reply answers (it answers none: it starts the conversation). */
const OPENING_ID = 'opening';
/** The id a check-in carries (one friendly line to a person who went quiet; it answers no message, and each one has its own, so no two count as the same send). */
const CHECK_IN_ID = 'check-in';
/** A draft that is a check-in (written for a quiet chat), not a reply to anything. */
const isCheckIn = (d: { readonly basedOn: readonly string[] }): boolean => d.basedOn.some((id) => id.startsWith(CHECK_IN_ID));
/** What a draft says when the person answered in the chat themself and the draft was dropped for it. */
const YOU_REPLIED_NOTE = 'You replied in the chat yourself.';
const MIN_AI_REST_MS = 15_000;
const SEND_SETTLE_MS = 20_000;
/**
 * A reply that did not go out (WhatsApp's page would not take the text, or the Send press did not happen: nothing was sent) in AUTOMATIC mode. ONE such failure used to switch
 * automatic replies off for the rest of the conversation — seen on the real WhatsApp on 6 Nov 2026: the first reply went, the second failed 0.5 s after Send, and every later
 * message only got a draft waiting for approval in Eya while WhatsApp showed nothing. Now the same reply is tried again a few seconds later (after looking at the chat, so
 * what already went is never sent twice), and automatic replies end only when it fails this many times IN A ROW — and say why.
 */
const AUTO_SEND_RETRY_MS = 4_000;
const MAX_AUTO_SEND_FAILS = 3;
const BUSY_STATES: readonly LiveChatState[] = ['SENDING', 'VERIFYING'];
/** The chat is on and being watched, whatever it is doing at this moment (writing the first message, sending a reply, waiting for the person to approve one). */
const RUNNING: readonly LiveChatState[] = ['ACTIVE', 'PROCESSING_MESSAGE', 'DRAFT_READY', 'WAITING_FOR_APPROVAL', 'SENDING', 'VERIFYING'];

// (without emoji: the page draws an emoji as a picture, so the text it gives back for a message has none)
const same = (a: string, b: string): boolean => plainText(a) === plainText(b);
const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export class LiveChatController {
  private s: StoredSession;
  private readonly listeners = new Set<(v: LiveChatView) => void>();
  private prompt: { confirm: string | null; choices: LiveChoiceView[] } = { confirm: null, choices: [] };
  private subs: Array<() => void> = [];
  private chain: Promise<unknown> = Promise.resolve();
  private busy = false;
  private dirty = false;
  private sendLock = false;
  private inflight: Promise<unknown> | null = null;
  private afterSend: 'pause' | 'stop' | null = null;
  private watching = false;
  private reconcileTimer: unknown = null;
  private autoTimer: unknown = null;
  private autoWait: unknown = null;
  private aiRestUntil = 0;
  private aiRetries = 0;
  private retryTimer: unknown = null;
  private comeBackTimer: unknown = null;
  /** A paused live chat does not wait for ever either (see `armPausedLimit`). */
  private pausedTimer: unknown = null;
  /** Watches for the other person going quiet (see IDLE_STOP_MS). */
  private idleTimer: unknown = null;
  /** The last moment something happened in the conversation: it began, the other person wrote, or a message went out. The silence is counted from here. */
  private turnAt = 0;
  /** The last time someone SPOKE in the conversation (they wrote, or a message went out): not set by connecting. */
  private talkAt = 0;
  /** The last thing Eya sent was a check-in (see `checkIn`): if they stay quiet after it, the chat ends; anything else she sends, or anything they write, gives a new chance. */
  private checkedIn = false;
  /** Automatic replies that did not go out one after another (see MAX_AUTO_SEND_FAILS): a reply that goes, a pause and resume, or switching automatic mode on starts the count again. */
  private autoSendFails = 0;
  private readFailures = 0;
  /** The page announced a change since the chat was last read. */
  private announced = false;
  /** The page let a new message through without announcing it: the chat is then looked at every few seconds instead (for the rest of the session). */
  private fast = false;
  private lastCheckAt: number | null = null;
  private backSub: (() => void) | null = null;
  private titleSeen: string | null = null;
  private query = '';
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: LiveChatDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? ((): string => randomUUID().replace(/-/g, '').slice(0, 16));
    this.s = newSession(this.newId(), this.now());
  }

  // ------------------------------------------------------------------------------------------------------------------------------------ reading
  onChange(listener: (v: LiveChatView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get state(): LiveChatState {
    return this.s.state;
  }

  view(): LiveChatView {
    const s = this.s;
    if (s.state === 'IDLE') return { ...EMPTY_LIVE_CHAT_VIEW, sendAllowed: this.sendAllowed(), enable: this.enableView() };
    const d = s.draft;
    return {
      active: !isOver(s.state),
      sessionId: s.id,
      app: s.app,
      chat: s.chat === null ? null : maskNumbersIn(s.chat.label).slice(0, 80),
      verified: s.chat?.verified ?? false,
      state: s.state,
      mode: s.mode,
      purpose: s.purpose,
      auto: s.auto === null ? null : { maxReplies: s.auto.maxReplies, repliesSent: s.auto.repliesSent, minGapSeconds: Math.round(s.auto.minGapMs / 1000), until: s.auto.until, holdBack: s.auto.holdBack },
      startedAt: s.startedAt,
      replies: s.replyCount,
      draft: d === null || d.status === 'discarded' ? null : { id: d.id, text: d.text, status: d.status, createdAt: d.createdAt, answers: d.basedOn.length, by: d.by, confidence: d.confidence, commitment: d.commitment, note: d.note },
      // (a picture or document that was looked at is shown by what became of it: its file name, and that it is in Downloads)
      recent: s.context.slice(-8).map((m) => {
        const file = s.media[m.id];
        const text = m.kind !== 'text' && file !== undefined && file.name !== '' && file.status !== 'failed' && file.status !== 'skipped' ? `${file.name} (saved in Downloads)` : m.text;
        return { id: m.id, dir: m.dir, kind: m.kind, text, at: m.at, handled: m.dir === 'out' || s.tracker.handled.includes(m.id) };
      }),
      error: s.error,
      notice: s.notice,
      pause: s.pause,
      choices: this.prompt.choices,
      confirmChat: this.prompt.confirm,
      monitoring: !this.watching ? 'off' : this.fast ? 'checking' : 'event',
      lastCheckAt: this.lastCheckAt,
      sendAllowed: this.sendAllowed(),
      enable: this.enableView(),
      forYou: s.forYou.map((n) => ({ id: n.id, at: n.at, text: n.text })),
      idleStopMinutes: this.idleMs() > 0 ? Math.max(1, Math.round(this.idleMs() / 60_000)) : null,
      relation: s.relation,
    };
  }

  /** How long the other person may stay silent before the live chat stops by itself (ms; 0 = never). */
  private idleMs(): number {
    return this.deps.idleStopMs ?? IDLE_STOP_MS;
  }

  private ownerName(): string {
    return this.deps.enable?.ownerName() ?? '';
  }

  private enableView(): LiveChatEnableView {
    return this.deps.enable?.view() ?? EMPTY_LIVE_CHAT_VIEW.enable;
  }

  /** Something the view depends on changed outside the controller (a plugin permission, Chats): the page is told. */
  refresh(): void {
    this.emit();
  }

  private standing(): boolean {
    return this.deps.enable?.standing() === true;
  }

  private sendAllowed(): boolean {
    return this.deps.permits('messages.send') === null && this.deps.allowed() === null;
  }

  // -------------------------------------------------------------------------------------------------------------------------------------- state
  private patch(change: Partial<StoredSession>, strict = false): void {
    this.s = { ...this.s, ...change };
    try {
      this.deps.store.save(this.s);
    } catch (err) {
      if (strict) throw err;
    }
    this.emit();
  }

  private emit(): void {
    const v = this.view();
    for (const l of this.listeners) {
      try {
        l(v);
      } catch {
        // a listener's trouble is its own
      }
    }
  }

  /** Moves to a state if that is allowed from here. A move that is not is refused and logged — and never changes anything. */
  private go(to: LiveChatState, change: Partial<StoredSession> = {}): boolean {
    if (!canMove(this.s.state, to)) {
      log.warn('refused a state change', { from: this.s.state, to });
      return false;
    }
    if (this.s.state !== to) log.info('live chat state', { from: this.s.state, to, mode: this.s.mode });
    this.patch({ ...change, state: to });
    return true;
  }

  private setNotice(notice: string | null, alert = false): void {
    this.patch({ notice });
    if (alert && notice !== null) this.deps.alert?.(notice);
  }

  // ------------------------------------------------------------------------------------------------------------------------------------ restore
  /** At start-up: a session that was running comes back PAUSED with nothing watched and nothing sent. Returns whether one was restored. */
  restore(): boolean {
    const saved = this.deps.store.load();
    if (saved === null || isOver(saved.state)) return false;
    // A live chat that was last written longer ago than the quiet limit (or by a version that did not write the time) is over: it is not brought back as a chat that is "running".
    const at = this.deps.store.savedAt?.();
    const limit = this.idleMs();
    if (limit > 0 && (at === null || (typeof at === 'number' && this.now() - at >= limit))) {
      log.info('a saved live chat is too old to bring back: ended', { minutesAgo: at === null || at === undefined ? null : Math.round((this.now() - at) / 60_000) });
      this.s = scrub({ ...saved, state: 'STOPPED', pause: null, error: null, stoppedAt: this.now(), notice: null });
      try {
        this.deps.store.save(this.s);
      } catch {
        // kept in memory
      }
      this.emit();
      return false;
    }
    this.s = afterRestart(saved);
    this.armPausedLimit('restart');
    this.titleSeen = null;
    try {
      this.deps.store.save(this.s);
    } catch {
      // kept in memory
    }
    log.info('live chat restored paused', { hasDraft: this.s.draft !== null, unsettled: this.s.sends.filter((x) => x.status === 'attempted' || x.status === 'uncertain').length });
    this.emit();
    return true;
  }

  // --------------------------------------------------------------------------------------------------------------------------------- requests
  /** The one way in for the page, the tool and the voice command. Never throws: what went wrong is the result. */
  async handle(request: LiveChatRequest): Promise<LiveChatResult> {
    try {
      switch (request.kind) {
        case 'start':
          return await this.start(request.name, request.mode, request.purpose, request.opening, request.knows, request.relation);
        case 'focus':
          return this.result(false, 'There is only one live chat running.');
        case 'enable_live':
          return this.setSwitch(true);
        case 'disable_live':
          return this.setSwitch(false);
        case 'set_owner_name': {
          const done = this.deps.enable?.setOwnerName(request.name) ?? { ok: false, message: 'There is no live chat switch here.' };
          this.emit();
          return this.result(done.ok, done.message);
        }
        case 'clear_notes':
          this.patch({ forYou: [] });
          return this.result(true, 'Cleared.');
        case 'relay':
          return await this.serial(() => this.relay(request.text));
        case 'stop':
          return await this.stop();
        case 'pause':
          return await this.pause('user');
        case 'resume':
          return await this.resume();
        case 'set_mode':
          return this.setMode(request.mode);
        case 'enable_auto':
          return this.enableAuto(request);
        case 'disable_auto':
          return this.endAuto('Automatic replies are off.', true);
        case 'edit_draft':
          return await this.serial(() => this.editDraft(request.text));
        case 'approve':
          return await this.serial(() => this.approve());
        case 'send':
          return await this.serial(() => this.send('user'));
        case 'discard':
          return await this.serial(() => this.discard());
        case 'regenerate':
          return await this.serial(() => this.regenerate());
        case 'confirm_chat':
          return await this.serial(() => this.confirmChat());
        case 'choose':
          return await this.serial(() => this.choose(request.choice));
      }
    } catch (err) {
      log.warn('a live chat request failed', { kind: request.kind, err: String(err) });
      return this.result(false, `That did not work: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private result(ok: boolean, message: string): LiveChatResult {
    return { ok, message, view: this.view() };
  }

  /** Requests that change the draft or the chat run one after another, never interleaved. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private gate(): string | null {
    return this.deps.allowed() ?? this.deps.permits('chats.live');
  }

  // ----------------------------------------------------------------------------------------------------------------------------------- start
  /** `purpose`: what the person said they want from this chat (it guides every reply). `opening`: they asked Eya to write the first message, once automatic replies are on. */
  async start(name: string, mode?: LiveChatMode, purpose?: string, opening?: boolean, knows?: boolean, relation?: LiveRelation): Promise<LiveChatResult> {
    let replaced = '';
    const blocked = this.gate();
    if (blocked !== null) return this.result(false, `${blocked} Nothing was started.`);
    if (!isOver(this.s.state)) {
      // A try that only got as far as asking WHICH chat (nothing is watched yet) is replaced by the new one; anything that is really running has to be stopped first.
      if (this.s.state === 'WAITING_FOR_USER' && (this.prompt.choices.length > 0 || this.prompt.confirm !== null)) await this.stop();
      else if (this.s.state === 'PAUSED' || (this.turnAt > 0 && this.now() - this.turnAt >= this.idleMs() && this.idleMs() > 0)) {
        // (a chat that is paused, or has done nothing for the whole quiet time, is not "running": it is ended, and the new one starts)
        const old = maskNumbersIn(this.s.chat?.label ?? 'a chat');
        const wasPaused = this.s.state === 'PAUSED';
        await this.stop();
        replaced = `I ended the earlier live chat with ${old} (it was ${wasPaused ? 'paused' : 'not active any more'}). `;
      } else {
        const label = maskNumbersIn(this.s.chat?.label ?? 'a chat');
        const ago = this.turnAt > 0 ? Math.max(0, Math.round((this.now() - this.turnAt) / 60_000)) : null;
        return this.result(false, `A live chat with ${label} is running${ago !== null ? ` (the last message was ${ago} minute${ago === 1 ? '' : 's'} ago)` : ''}. I can run one live chat at a time: say "stop live chat" and ask again, and the new one starts at once. (It also ends by itself when they stay quiet for ${Math.max(1, Math.round(this.idleMs() / 60_000))} minutes.)`);
      }
    }
    const fresh = newSession(this.newId(), this.now());
    this.s = { ...fresh, relation: relation ?? relationFrom(purpose ?? ''), mode: mode === 'assisted' ? 'assisted' : 'draft', purpose: (purpose ?? '').replace(/\s+/g, ' ').trim().slice(0, 300), openingWanted: false, autoBasis: knows === true ? 'said' : knows === false ? null : this.standing() ? 'switch' : null };
    // Eya introduces herself in the chat first whenever she is to reply by herself (the person asked for the first message, or automatic replies are coming).
    this.s = { ...this.s, openingWanted: opening === false ? false : opening === true || this.s.autoBasis !== null };
    this.prompt = { confirm: null, choices: [] };
    this.dirty = false;
    this.readFailures = 0;
    this.titleSeen = null;
    this.fast = false;
    this.announced = false;
    this.aiRetries = 0;
    this.aiRestUntil = 0;
    this.lastCheckAt = null;
    this.query = name;
    this.go('RESOLVING_CONTACT');
    return this.serial(async () => {
      await this.resolve(() => this.deps.chat.open(name));
      return this.result(this.s.state !== 'FAILED', `${replaced}${this.summary()}`);
    });
  }

  /**
   * The one "Enable live chat" switch. Only the person's own click on the Live chat page reaches this (a tool, a voice command or a web page cannot). Switching it off
   * also ends automatic replies that were running on its word: the standing confirmation is gone.
   */
  private setSwitch(on: boolean): LiveChatResult {
    const sw = this.deps.enable;
    if (sw === undefined) return this.result(false, 'There is no live chat switch here.');
    const done = on ? sw.turnOn() : sw.turnOff();
    if (!on && done.ok) {
      if (this.s.autoBasis === 'switch') this.patch({ autoBasis: null });
      if (this.s.mode === 'auto' && this.s.auto !== null) this.endAuto('Live chat was switched off.', false);
    }
    this.emit();
    return this.result(done.ok, done.message);
  }

  /**
   * The chat is confirmed and watched: if automatic replies were asked for — in so many words ("she knows") or by the one switch — they start now, with the person's
   * confirmation that the other person knows given by whichever of those it was. Never for a chat that is not the confirmed one (this runs only after it is).
   */
  private autoOnConnect(): void {
    const basis = this.s.autoBasis;
    if (basis === null || this.s.auto !== null) return;
    if (basis === 'switch' && !this.standing()) return; // the switch was turned off since: its standing yes is gone
    // (whether Eya introduces herself was decided when the chat was started — `openingWanted` — so it is not decided again here)
    const r = this.enableAuto({ kind: 'enable_auto', confirmedAware: true, introduce: false });
    if (!r.ok) this.patch({ notice: `I could not switch on automatic replies: ${r.message}` });
  }

  /** Opens the chat and, when it is the right one, connects. A chat that is only a likely match, or several that fit, is the person's to settle. */
  private async resolve(open: () => Promise<OpenOutcome>): Promise<void> {
    this.go('RESOLVING_CONTACT');
    let out: OpenOutcome;
    try {
      out = await open();
    } catch (err) {
      await this.failWith(this.explain(err));
      return;
    }
    if (this.s.state !== 'RESOLVING_CONTACT') return; // stopped meanwhile
    switch (out.kind) {
      case 'opened': {
        this.patch({ chat: { label: out.label, verified: out.verified, ...(out.ending !== undefined ? { ending: out.ending } : {}) }, error: null });
        if (!out.verified) {
          this.prompt = { confirm: maskNumbersIn(out.label), choices: [] };
          this.go('WAITING_FOR_USER', { notice: `I found ${maskNumbersIn(out.label)}, but it is only a likely match for "${this.query}". Confirm it is the right chat.` });
          this.deps.alert?.('Confirm which chat the live chat is for.');
          return;
        }
        this.prompt = { confirm: null, choices: [] };
        await this.connect(false);
        return;
      }
      case 'ambiguous':
        this.prompt = { confirm: null, choices: out.options.slice(0, 6).map((o) => ({ choice: o.choice, label: maskNumbersIn(o.label) })) };
        this.note('livechat_start', 'several_chats', { offered: out.options.length });
        this.go('WAITING_FOR_USER', { notice: `Several chats fit "${this.query}". Choose the right one.` });
        this.deps.alert?.('Choose which chat the live chat is for.');
        return;
      default:
        await this.failWith(out.say);
    }
  }

  private async confirmChat(): Promise<LiveChatResult> {
    if (this.s.state !== 'WAITING_FOR_USER' || this.prompt.confirm === null || this.s.chat === null) return this.result(false, 'There is no chat waiting to be confirmed.');
    this.patch({ chat: { ...this.s.chat, verified: true }, notice: null });
    this.prompt = { confirm: null, choices: [] };
    await this.connect(false);
    return this.result(RUNNING.includes(this.state), this.summary());
  }

  private async choose(choice: number): Promise<LiveChatResult> {
    if (this.s.state !== 'WAITING_FOR_USER' || this.prompt.choices.length === 0) return this.result(false, 'There is no choice waiting to be made.');
    if (!this.prompt.choices.some((c) => c.choice === choice)) return this.result(false, 'That number is not one of the chats offered.');
    this.prompt = { confirm: null, choices: [] };
    await this.resolve(() => this.deps.chat.choose(choice));
    return this.result(RUNNING.includes(this.state), this.summary());
  }

  // --------------------------------------------------------------------------------------------------------------------------------- connect
  /** Starts watching the open chat and takes the first look. `resuming`: the session already began, so what arrived while it was paused is answered. */
  private async connect(resuming: boolean): Promise<void> {
    this.go('CONNECTING', { pause: null, error: null });
    const label = this.s.chat?.label ?? '';
    let started: Awaited<ReturnType<LiveWatcher['start']>>;
    try {
      started = await this.deps.watcher.start();
    } catch (err) {
      await this.failWith(this.explain(err), this.pauseFor(err));
      return;
    }
    if (!started.ok) {
      await this.failWith(started.message, started.pause);
      return;
    }
    let first: ChatReadResult;
    try {
      first = await this.deps.watcher.read(MAX_CONTEXT);
    } catch (err) {
      await this.deps.watcher.stop().catch(() => undefined);
      await this.failWith(this.explain(err), this.pauseFor(err));
      return;
    }
    if (!first.ok) {
      await this.deps.watcher.stop().catch(() => undefined);
      await this.failWith(first.message, 'extension_old');
      return;
    }
    if (!first.hasMain) {
      await this.deps.watcher.stop().catch(() => undefined);
      await this.failWith(`The chat with ${maskNumbersIn(label)} is not open on the page, so there is nothing to watch.`, 'chat_closed');
      return;
    }
    if (!first.reliable) {
      await this.deps.watcher.stop().catch(() => undefined);
      log.warn('the chat page was called unreadable', { ...first.diagnostics });
      this.note('livechat_start', 'unreadable', first.ok && first.diagnostics !== undefined ? { rows: first.diagnostics.rows, other: first.diagnostics.otherRows, marks: first.diagnostics.messageLike, unknown_side: first.diagnostics.unknownSide ?? 0 } : undefined);
      await this.failWith(`This WhatsApp page is built in a way Eya cannot read reliably, so the live chat was not started. Nothing was watched, drafted or sent.${this.countsOf(first)}`, 'unreadable');
      return;
    }
    const open = await this.deps.chat.isOpen(label).catch(() => 'unknown' as const);
    if (open !== 'yes') {
      await this.deps.watcher.stop().catch(() => undefined);
      await this.failWith(`The page does not show the chat with ${maskNumbersIn(label)} open, so I did not start watching it.`, 'chat_switched');
      return;
    }
    this.titleSeen = norm(first.title);
    // (how the sides of the messages were told — counts only — so that a chat that read oddly can be traced afterwards even though it started)
    if (first.diagnostics !== undefined) this.note('livechat_read', 'start_ok', { rows: first.diagnostics.rows, other: first.diagnostics.otherRows, marks: first.diagnostics.messageLike, ...(first.diagnostics.sides ?? {}) });
    // The first look: everything there is old and is never answered. When resuming, the earlier record stays, and what is new since is answered.
    const tracker = resuming && this.s.startedAt !== null ? scan(this.s.tracker, first.messages).next : baseline(first.messages);
    this.patch({ tracker, context: rollContext(this.s.context, first.messages), startedAt: this.s.startedAt ?? this.now() });
    this.subscribe();
    this.watching = true;
    this.armReconcile();
    this.go('ACTIVE');
    this.checkedIn = false;
    this.touch(false); // (connecting is not the conversation: the silence is counted from now, but nobody has spoken)
    this.autoOnConnect();
    await this.reconcile(first);
    // A reply that was waiting for the person when the session was paused is still waiting (and is checked again before it is ever sent).
    const waiting = this.s.draft;
    if (waiting !== null && this.alive(waiting)) this.go('WAITING_FOR_APPROVAL');
    await this.processNow();
    this.emit();
  }

  private subscribe(): void {
    this.unsubscribeAll();
    this.subs.push(
      this.deps.watcher.onChange(() => this.onEvent()),
      this.deps.watcher.onLost((why) => {
        void this.serial(() => this.pause(why).then(() => undefined));
      }),
    );
  }

  private unsubscribeAll(): void {
    for (const u of this.subs) u();
    this.subs = [];
  }

  // ------------------------------------------------------------------------------------------------------------------------------- new messages
  private onEvent(): void {
    if (!WATCHING.includes(this.s.state)) return;
    this.announced = true;
    void this.processNow('event');
  }

  /** Looks at the chat now. One look at a time: a change that arrives during one is looked at straight after it, never in parallel. */
  private async processNow(trigger: 'event' | 'check' = 'event'): Promise<void> {
    if (this.busy || this.sendLock) {
      this.dirty = true;
      return;
    }
    this.busy = true;
    try {
      let why = trigger;
      do {
        this.dirty = false;
        if (!WATCHING.includes(this.s.state)) break;
        await this.processOnce(why);
        why = 'event'; // (what arrived during a look is looked at straight after, as an announced change)
      } while (this.dirty && WATCHING.includes(this.s.state));
    } catch (err) {
      log.warn('looking at the chat failed', { err: String(err) });
    } finally {
      this.busy = false;
    }
  }

  /** What the reader found, as numbers (never a word of the chat), so "cannot read this page" can be told apart from "nothing in this chat yet". */
  private countsOf(read: ChatReadResult): string {
    if (!read.ok || read.diagnostics === undefined) return '';
    const d = read.diagnostics;
    const side = d.unknownSide !== undefined && d.unknownSide > 0 ? ` I could not tell which side ${d.unknownSide} of them were on.` : '';
    // (the page's shape: kinds of elements and masked ids, no words — enough to see how the page is built)
    const shape = d.shape !== undefined ? ` How the page is built: ${d.shape}` : '';
    return ` (I understood ${d.rows} message rows${d.how !== undefined ? ` by ${d.how}` : ''}; the page shows ${d.otherRows} rows in all and ${d.messageLike} message marks.${side})${shape}`;
  }

  /** Writes down why something stopped (a category and counts, never a word of a chat), for the next time it has to be traced. */
  private note(op: string, category: string, counts?: Readonly<Record<string, number>>): void {
    try {
      this.deps.diagnose?.({ op, category, ...(counts !== undefined ? { counts } : {}) });
    } catch {
      // writing it down must never get in the way
    }
  }

  private async readChat(): Promise<ChatReadResult | null> {
    try {
      const r = await this.deps.watcher.read(MAX_CONTEXT);
      this.readFailures = 0;
      this.lastCheckAt = this.now();
      return r;
    } catch (err) {
      const why = this.pauseFor(err);
      if (why !== null || ++this.readFailures >= 3) {
        await this.pause(why ?? 'unreadable', this.explain(err));
        return null;
      }
      return null;
    }
  }

  private async processOnce(trigger: 'event' | 'check' = 'event'): Promise<void> {
    const heard = this.announced;
    this.announced = false;
    const read = await this.readChat();
    if (read === null || !WATCHING.includes(this.s.state)) return;
    if (!read.ok) {
      await this.pause('extension_old', read.message);
      return;
    }
    if (!read.hasMain) {
      await this.pause('chat_closed', `The chat with ${maskNumbersIn(this.s.chat?.label ?? 'the chat')} was closed, so I stopped watching. I carry on by myself when it is open again.`);
      return;
    }
    if (!read.reliable) {
      log.warn('the chat page was called unreadable', { ...read.diagnostics });
      this.note('livechat_read', 'unreadable', read.diagnostics !== undefined ? { rows: read.diagnostics.rows, other: read.diagnostics.otherRows, marks: read.diagnostics.messageLike, unknown_side: read.diagnostics.unknownSide ?? 0 } : undefined);
      await this.pause('unreadable', `The page's layout changed in a way Eya cannot read, so watching is paused.${this.countsOf(read)}`);
      return;
    }
    // The chat on the page is still the chosen one. The page's title is checked cheaply every time; when it changed, the page itself is asked.
    const title = norm(read.title);
    if (this.titleSeen !== null && title !== this.titleSeen) {
      const open = await this.deps.chat.isOpen(this.s.chat?.label ?? '').catch(() => 'unknown' as const);
      if (open !== 'yes') {
        await this.pause('chat_switched', `The open chat is not the chat with ${maskNumbersIn(this.s.chat?.label ?? '')} any more, so I stopped watching. Nothing was drafted or sent. I carry on by myself when that chat is open again.`);
        return;
      }
      this.titleSeen = title;
    }
    if (!WATCHING.includes(this.s.state)) return;

    // A message this look found that the page never announced: events cannot be relied on for this page, so from now on the chat is looked at every few seconds.
    if (trigger === 'check' && !heard && !this.fast && read.messages.some((m) => m.dir === 'in' && this.s.tracker.hashes[m.id] === undefined && !this.s.tracker.handled.includes(m.id))) {
      this.fast = true;
      this.armReconcile();
      log.warn('a new message was found that the page did not announce: checking the chat often from now on');
      this.patch({ notice: 'WhatsApp did not announce a new message by itself, so I now check the chat every few seconds. Replies may take a few seconds longer.' });
    }
    // (the other person wrote something that was not there before, or the person wrote in the chat themself: the conversation is alive, so the silence starts again from now)
    const wroteNew = read.messages.some((m) => m.dir === 'in' && this.s.tracker.hashes[m.id] === undefined);
    const found = scan(this.s.tracker, read.messages);
    if (wroteNew || found.outgoing.length > 0) this.touch();
    if (wroteNew) this.checkedIn = false; // (they are back: a later silence gets its own check-in)
    let tracker = found.next;
    // An edit to a message that a waiting draft answers makes the draft out of date: the message is looked at again, and the reply written again.
    const live = this.s.draft;
    const editedBasis = live !== null && this.alive(live) && live.status !== 'in_box' ? found.edited.filter((m) => live.basedOn.includes(m.id)) : [];
    if (live !== null && editedBasis.length > 0) tracker = unmark(tracker, editedBasis.map((m) => m.id));
    this.patch({ tracker, context: rollContext(this.s.context, read.messages), ...(live !== null && editedBasis.length > 0 ? { draft: { ...live, status: 'stale' as const, note: 'An earlier message was edited.' } } : {}) });

    // The person typed a draft into the box themself and sent it: what they sent is seen, and the draft is done.
    await this.noticeOwnSend(found.outgoing);

    // The person answered in the chat themselves (from the phone, say) after the draft was made: the draft is not wanted.
    const d = this.s.draft;
    if (d !== null && this.alive(d) && found.outgoing.some((m) => !this.ownSend(m))) {
      this.patch({ draft: { ...d, status: 'discarded', note: YOU_REPLIED_NOTE }, notice: 'You replied in the chat yourself, so the drafted reply was dropped.' });
      if (this.s.state === 'WAITING_FOR_APPROVAL' || this.s.state === 'DRAFT_READY') this.go('ACTIVE');
    }
    const fresh = unhandled(tracker, read.messages);
    if (fresh.length === 0) {
      // Nothing new to answer: this is when the first message the person asked for is written (never while a message is waiting to be answered).
      await this.openIfWanted();
      return;
    }
    if (this.now() < this.aiRestUntil) {
      this.setNotice('The AI could not answer a moment ago; I will try again shortly or when you press Regenerate.');
      return;
    }
    // A picture or a document the other person sent is taken into Downloads and read first, so that the reply can say what it is and ask why it was sent.
    await this.takeMedia(fresh);
    if (!WATCHING.includes(this.s.state)) return;
    await this.draftFor(fresh, editedBasis.length > 0 ? 'An earlier message was edited, so the reply was written again.' : null);
  }

  private alive(d: StoredDraft): boolean {
    return d.status === 'ready' || d.status === 'edited' || d.status === 'approved' || d.status === 'in_box';
  }

  /** Which of the account's outgoing lines in the chat Eya sent (the others the person typed themself): the model is told, so that she does not mistake the person's words for hers. */
  private eyaSentIds(): string[] {
    return this.s.context.filter((m) => m.dir === 'out' && this.ownSend(m)).map((m) => m.id);
  }

  /** Is this outgoing message one that Eya sent for the person (a send record has its text)? */
  private ownSend(m: LiveChatMessage): boolean {
    return this.s.sends.some((x) => x.text !== '' && same(x.text, m.text) && x.at <= this.now()) || (this.s.draft?.status === 'in_box' && same(this.s.draft.text, m.text));
  }

  private async noticeOwnSend(outgoing: readonly LiveChatMessage[]): Promise<void> {
    const d = this.s.draft;
    if (d === null || d.status !== 'in_box') return;
    const hit = outgoing.find((m) => m.kind === 'text' && same(m.text, d.text));
    if (hit === undefined) return;
    const rec: SendRecord = { id: this.newId(), draftId: d.id, triggerKey: d.basedOn.join('|'), text: d.text, at: this.now(), status: 'visibly_sent', pressed: false, lastOutId: null, by: 'user', evidence: hit.id };
    this.patch({ draft: { ...d, status: 'sent', note: 'Sent by you from WhatsApp.' }, sends: [...this.s.sends, rec].slice(-60), replyCount: this.s.replyCount + 1 });
    if (this.s.state === 'WAITING_FOR_APPROVAL' || this.s.state === 'DRAFT_READY') this.go('ACTIVE');
  }

  // ------------------------------------------------------------------------------------------------------------------------------------ drafting
  /** Drafts one reply for a burst of new incoming messages — or decides, and says why, that none is needed. */
  private async draftFor(fresh: readonly LiveChatMessage[], note: string | null, force = false): Promise<void> {
    const need = needsReply(fresh, { media: this.deps.media !== undefined, afterQuestion: askedJustBefore(this.s.context, fresh) });
    const ids = fresh.map((m) => m.id);
    if (!need.needed && !force) {
      this.patch({ tracker: markHandled(this.s.tracker, ids), notice: `No reply needed: ${need.why}.` });
      this.touch(); // (nothing to answer: it is the other person's turn now)
      return;
    }
    const before = this.s.state;
    if (!this.go('PROCESSING_MESSAGE')) return;
    let outcome: DraftOutcome;
    try {
      outcome = await generateDraft(this.deps.ai, { context: this.s.context, fresh, summary: this.s.summary, tone: this.s.tone, relation: this.s.relation, purpose: this.s.purpose, knows: this.s.auto !== null, answerByItself: this.s.auto !== null && !this.s.auto.holdBack, ownerName: this.ownerName(), asEya: this.s.auto !== null, introduce: this.s.auto !== null && !this.s.introduced, media: this.s.media, eyaSentIds: this.eyaSentIds() });
    } catch (err) {
      this.aiRestUntil = this.now() + MIN_AI_REST_MS;
      log.warn('the AI could not draft a reply', { err: String(err) });
      // Paused or stopped while the model was thinking: nothing is made of it.
      if (this.s.state !== 'PROCESSING_MESSAGE') return;
      // The messages stay unanswered (not marked handled): they are drafted again on the next change or on Regenerate.
      this.go(before === 'DRAFT_READY' ? 'WAITING_FOR_APPROVAL' : before);
      this.patch({ error: 'The AI could not write a reply just now (its limit may be used up). The new message is still waiting; press Regenerate to try again.' });
      this.deps.alert?.('The AI could not draft a reply to a new message.');
      // Tried again by itself shortly (a few times at most): a message that is waiting does not wait for the slow check or for the person to press Regenerate.
      this.armAiRetry();
      return;
    }
    this.aiRetries = 0;
    if (this.s.state !== 'PROCESSING_MESSAGE') return; // paused or stopped while the model was thinking: nothing is made of it
    this.patch({ error: null, summary: outcome.summary.slice(0, 400), tracker: markHandled(this.s.tracker, ids) });
    this.noteForOwner(outcome.forOwner);
    const old = this.s.draft;
    if (old !== null && this.alive(old)) this.patch({ draft: { ...old, status: 'stale', note: 'A newer message arrived.' } });
    switch (outcome.kind) {
      case 'none':
        this.patch({ notice: `No reply needed: ${outcome.reason}.` });
        this.go('ACTIVE');
        this.touch();
        return;
      case 'ask_user':
        this.patch({ draft: null, notice: `I need you for this one: ${outcome.reason}` });
        this.go('WAITING_FOR_USER');
        this.deps.alert?.('A new message needs your own reply.');
        return;
      case 'draft': {
        const draft: StoredDraft = { id: this.newId(), text: outcome.text, status: 'ready', createdAt: this.now(), by: 'eya', confidence: outcome.confidence, commitment: outcome.commitment, note, basedOn: ids };
        // (the other person wrote first: the conversation has begun, so there is no first message left to write)
        this.patch({ draft, notice: null, ...(this.s.openingWanted ? { openingDone: true } : {}), ...(this.s.auto !== null ? { introduced: true } : {}) });
        this.go('DRAFT_READY');
        await this.afterDraft();
      }
    }
  }

  /**
   * The other person asked for something, or has something the person should know: Eya took it down (one sentence). It is kept on the Live chat page, and the person is
   * told with a sound — but the notification itself never carries what was said.
   */
  private noteForOwner(text: string, kind: 'said' | 'file' = 'said'): void {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t === '') return;
    const note = { id: this.newId(), at: this.now(), text: t.slice(0, 240) };
    this.patch({ forYou: [...this.s.forYou, note].slice(-MAX_NOTES) });
    this.deps.alert?.('Someone in your live chat has something for you. Open Live chat in Eya.');
    this.sayToOwner(note.text, kind);
  }

  /** The chat as a person says it aloud: a name as it is; a phone number by the last digits only ("the number ending 5 5 3 2"), never in full. */
  private spokenChat(): string {
    const label = (this.s.chat?.label ?? '').trim();
    const digits = label.replace(/\D/g, '');
    if (digits.length >= 7 && /^[+\d][\d\s()+-]*$/.test(label)) return `the number ending ${digits.slice(-4).split('').join(' ')}`;
    return label === '' ? 'someone in your live chat' : label;
  }

  /**
   * What the other person said for the person, said TO the person: in Eya's voice when voice is on (or by the live conversation), and in the chat with Eya on the screen —
   * "Rakesh, Priya says: she asks you to call her tonight." A file note reads "Rakesh, Priya sent a document…". It ends by saying how to answer: the person's own words,
   * "tell them I will call at six", are sent back to that chat (see `relay`).
   */
  private sayToOwner(text: string, kind: 'said' | 'file'): void {
    if (this.deps.say === undefined) return;
    const owner = this.ownerName();
    const lead = owner !== '' ? `${owner}, ` : '';
    // (the note's own full stop is dropped: one is added after it, and "people.. Tell me" would be read out and shown with two)
    const said = text.replace(/[.!?…]+$/u, '');
    const body = (who: string): string => (kind === 'file' ? `${who} ${said}` : `${who} says: ${said}`);
    const spoken = `${lead}${body(this.spokenChat())}. Tell me what to answer, if you like.`;
    const shown = `${lead}${body(maskNumbersIn(this.s.chat?.label ?? 'someone in your live chat'))}. To answer, say or type for example "tell them I will call at 6" and I will send it in the chat.`;
    try {
      this.deps.say(spoken, shown);
    } catch {
      // a listener's trouble is its own
    }
  }

  // ------------------------------------------------------------------------------------------------------------------------------ pictures and documents
  private setMedia(id: string, note: MediaNote): void {
    const next = { ...this.s.media, [id]: note };
    const keys = Object.keys(next);
    const kept = keys.length > MAX_MEDIA ? Object.fromEntries(keys.slice(-MAX_MEDIA).map((k) => [k, next[k] as MediaNote])) : next;
    this.patch({ media: kept });
  }

  /**
   * A picture or a document the other person sent: it is taken into the Downloads folder (and nowhere else), read, and what it is becomes part of what the reply is written
   * from — so the reply can say it got it and ask why it was sent and what they want done with it — and the person is told about it. Only incoming pictures and documents
   * not looked at before, at most a few at a time. It never opens anything that is not a picture or an ordinary document, never changes or forwards a file, and never fails the
   * live chat: a file that could not be got at is said so ("I could not open it") and the chat goes on.
   */
  private async takeMedia(fresh: readonly LiveChatMessage[]): Promise<void> {
    const media = this.deps.media;
    if (media === undefined) return;
    const todo = fresh.filter((m): m is LiveChatMessage & { kind: 'image' | 'document' } => m.dir === 'in' && (m.kind === 'image' || m.kind === 'document') && this.s.media[m.id] === undefined);
    if (todo.length === 0) return;
    const doing = `Looking at what ${maskNumbersIn(this.s.chat?.label ?? 'they')} sent…`;
    this.patch({ notice: doing });
    for (const [i, m] of todo.entries()) {
      if (!WATCHING.includes(this.s.state)) return; // paused or stopped meanwhile
      const kind = m.kind;
      const word = kind === 'image' ? 'a picture' : 'a document';
      if (i >= MAX_MEDIA_PER_LOOK) {
        this.setMedia(m.id, { kind, name: '', status: 'skipped', summary: '' });
        continue;
      }
      let saved: Awaited<ReturnType<LiveChatMedia['save']>>;
      try {
        saved = await media.save(m.id, kind);
      } catch (err) {
        saved = { ok: false, say: this.explain(err) };
      }
      if (!WATCHING.includes(this.s.state)) return;
      if (!saved.ok) {
        this.setMedia(m.id, { kind, name: '', status: 'failed', summary: '' });
        this.note('livechat_media', 'not_taken');
        this.noteForOwner(`sent ${word}, but I could not open it: ${saved.say}`, 'file');
        continue;
      }
      let summary = '';
      try {
        summary = summaryLine((await media.read(saved.path, kind, saved.name)) ?? '');
      } catch {
        summary = '';
      }
      if (!WATCHING.includes(this.s.state)) return;
      this.setMedia(m.id, { kind, name: saved.name, status: summary !== '' ? 'read' : 'saved', summary });
      this.note('livechat_media', summary !== '' ? 'read' : 'saved');
      const called = kind === 'document' ? ` called ${saved.name}` : '';
      this.noteForOwner(`sent ${word}${called}. It is saved in your Downloads folder.${summary !== '' ? ` It ${kind === 'image' ? 'shows' : 'says'}: ${summary.slice(0, 140)}` : ' I could not read it.'}`, 'file');
    }
    if (this.s.notice === doing) this.patch({ notice: null });
  }

  // ------------------------------------------------------------------------------------------------------------------------------------ relaying
  /**
   * The person's own words for the other person ("tell her I will call at 6"): sent to them in the chat as the person's message — "Rakesh says: I will call at 6". The person
   * saying it IS the approval, so it is not held for one; every other check stays (the chat is the chosen one, Send is permitted, a record is kept before Send is pressed, and
   * what was sent is looked for in the chat). Draft mode never sends: there the words are put in WhatsApp's message box for the person to press Send.
   */
  private async relay(raw: string): Promise<LiveChatResult> {
    const words = raw.replace(/\s+/g, ' ').trim();
    if (words === '') return this.result(false, 'There is nothing to send.');
    if (words.length > 600) return this.result(false, 'That is too long for one chat message. Say it shorter.');
    if (!['ACTIVE', 'PROCESSING_MESSAGE', 'DRAFT_READY', 'WAITING_FOR_APPROVAL', 'WAITING_FOR_USER'].includes(this.s.state) || this.s.chat === null) {
      return this.result(false, this.s.state === 'PAUSED' ? 'The live chat is paused, so nothing was sent. Resume it first.' : 'There is no live chat running, so nothing was sent.');
    }
    if (this.sendLock) return this.result(false, 'I am sending something right now. Say it again in a moment.');
    const owner = this.ownerName();
    const text = owner !== '' ? `${owner} says: ${words}` : words;
    if (this.s.mode === 'draft') {
      const open = await this.deps.chat.isOpen(this.s.chat.label).catch(() => 'unknown' as const);
      if (open !== 'yes') return this.result(false, 'The chat is not the one that is open, so I did not type anything.');
      const typed = await this.deps.chat.typeInBox(text).catch(() => ({ ok: false as const }));
      if (!typed.ok) return this.result(false, 'I could not put it in the WhatsApp message box.');
      return this.result(true, 'Draft mode never sends by itself, so your words are in the WhatsApp message box: press Send there.');
    }
    // (a reply that was waiting is replaced: the person has answered, in their own words)
    const old = this.s.draft;
    const mine: StoredDraft = { id: this.newId(), text, status: 'approved', createdAt: this.now(), by: 'you', confidence: 'high', commitment: false, note: `${owner !== '' ? owner : 'Your'} message, relayed.`, basedOn: [`relay:${this.newId()}`] };
    this.patch({ draft: mine, notice: null });
    if (!this.go('WAITING_FOR_APPROVAL')) {
      this.patch({ draft: old });
      return this.result(false, 'The live chat is not ready to send right now. Try again in a moment.');
    }
    const sent = await this.sendNow('user', true);
    // (not sent: the words are not left waiting to be sent later by something else)
    if (!sent.ok && this.s.draft?.id === mine.id && (this.s.draft.status === 'approved' || this.s.draft.status === 'ready')) this.patch({ draft: { ...mine, status: 'discarded', note: sent.message } });
    return sent;
  }

  /** Tried again by itself shortly (a few times at most): what is waiting does not wait for the slow check or for the person to press Regenerate. */
  private armAiRetry(): void {
    if (this.aiRetries < 3 && this.retryTimer === null) {
      this.aiRetries += 1;
      this.retryTimer = this.timer(() => {
        this.retryTimer = null;
        if (WATCHING.includes(this.s.state)) void this.processNow('check');
      }, MIN_AI_REST_MS + 500);
    }
  }

  /**
   * The first message, when the person asked Eya to write first ("make her happy", "say hi"): written ONCE, from what the person said they want, and then it goes the
   * way any reply goes — an automatic reply only through the same gate as every other (a plain, high-confidence message with nothing promised, no figures or links),
   * otherwise it waits for the person. `manual`: the person pressed Regenerate (it may then be written in any mode). Returns whether it did something.
   */
  private async openIfWanted(manual = false): Promise<boolean> {
    const s = this.s;
    if (!s.openingWanted || s.openingDone || s.state !== 'ACTIVE') return false;
    if (!manual && (s.mode !== 'auto' || this.now() < this.aiRestUntil || this.aiRetries >= 3)) return false;
    if (s.draft !== null && this.alive(s.draft)) return false;
    if (!this.go('PROCESSING_MESSAGE')) return false;
    let outcome: DraftOutcome;
    try {
      outcome = await generateOpening(this.deps.ai, { context: this.s.context, summary: this.s.summary, tone: this.s.tone, relation: this.s.relation, purpose: this.s.purpose, knows: this.s.auto !== null, ownerName: this.ownerName(), asEya: this.s.auto !== null, eyaSentIds: this.eyaSentIds() });
    } catch (err) {
      this.aiRestUntil = this.now() + MIN_AI_REST_MS;
      log.warn('the AI could not write the first message', { err: String(err) });
      if (this.s.state !== 'PROCESSING_MESSAGE') return true; // paused or stopped while the model was thinking
      this.go('ACTIVE');
      this.patch({ error: 'The AI could not write the first message just now (its limit may be used up). I will try again shortly, or press Regenerate.' });
      this.deps.alert?.('The AI could not write the first message.');
      this.armAiRetry();
      return true;
    }
    this.aiRetries = 0;
    if (this.s.state !== 'PROCESSING_MESSAGE') return true;
    this.patch({ error: null, summary: outcome.summary.slice(0, 400), openingDone: true });
    this.noteForOwner(outcome.forOwner);
    switch (outcome.kind) {
      case 'none':
        this.patch({ notice: `I did not write a first message: ${outcome.reason}.` });
        this.go('ACTIVE');
        return true;
      case 'ask_user':
        this.patch({ draft: null, notice: `I need you for the first message: ${outcome.reason}` });
        this.go('WAITING_FOR_USER');
        this.deps.alert?.('The first message needs your own words.');
        return true;
      case 'draft': {
        const draft: StoredDraft = { id: this.newId(), text: outcome.text, status: 'ready', createdAt: this.now(), by: 'eya', confidence: outcome.confidence, commitment: outcome.commitment, note: 'The first message you asked me to write.', basedOn: [OPENING_ID] };
        this.patch({ draft, notice: null, ...(this.s.auto !== null ? { introduced: true } : {}) });
        this.go('DRAFT_READY');
        await this.afterDraft();
        return true;
      }
    }
  }

  private async afterDraft(): Promise<void> {
    if (this.s.mode === 'auto') {
      await this.tryAuto();
      return;
    }
    this.go('WAITING_FOR_APPROVAL');
    this.deps.alert?.('A reply is ready for you to review.');
  }

  private async tryAuto(): Promise<void> {
    const d = this.s.draft;
    if (d === null || !this.alive(d) || this.s.mode !== 'auto') return;
    const decision = autoGate(this.s.auto, d, this.now());
    if (decision.ok) {
      await this.sendNow('auto');
      return;
    }
    if ('wait' in decision) {
      this.go('WAITING_FOR_APPROVAL');
      this.clearTimer('autoWait');
      this.autoWait = this.timer(() => void this.serial(() => this.tryAuto()), decision.wait + 50);
      return;
    }
    if ('hold' in decision) {
      // This one reply waits for the person (and says why); automatic replies stay on, so the next message is answered as usual.
      this.go('WAITING_FOR_APPROVAL');
      this.setNotice(decision.hold, true);
      return;
    }
    this.endAuto(decision.stop, true);
  }

  // ----------------------------------------------------------------------------------------------------------------------------- the draft's life
  private async editDraft(text: string): Promise<LiveChatResult> {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t === '' || t.length > 1500) return this.result(false, 'The reply is empty or too long.');
    if (!WATCHING.includes(this.s.state)) return this.result(false, 'The live chat is not running, so there is nothing to edit.');
    const d = this.s.draft;
    if (d !== null && this.alive(d) && d.status !== 'in_box') {
      this.patch({ draft: { ...d, text: t, status: 'edited', by: 'you', note: null }, notice: null });
      return this.result(true, 'The reply is changed. It is yours now, so it is never sent automatically.');
    }
    if (d !== null && d.status === 'in_box') return this.result(false, 'That reply is already in the WhatsApp message box. Change it there, or discard it first.');
    // No draft: the person writes the reply themselves, for what is waiting.
    const lastIn = [...this.s.context].reverse().find((m) => m.dir === 'in');
    const mine: StoredDraft = { id: this.newId(), text: t, status: 'edited', createdAt: this.now(), by: 'you', confidence: 'low', commitment: true, note: null, basedOn: lastIn === undefined ? [] : [lastIn.id] };
    this.patch({ draft: mine, notice: null });
    if (this.s.state === 'ACTIVE' || this.s.state === 'WAITING_FOR_USER') this.go('WAITING_FOR_APPROVAL');
    return this.result(true, 'Your reply is ready to approve.');
  }

  private async approve(): Promise<LiveChatResult> {
    const d = this.s.draft;
    if (d === null || !this.alive(d) || d.status === 'in_box') return this.result(false, 'There is no reply waiting for approval.');
    if (this.s.mode === 'draft') {
      // Draft mode never sends: approving puts the words in WhatsApp's own message box, and the person presses Send there.
      const open = await this.deps.chat.isOpen(this.s.chat?.label ?? '').catch(() => 'unknown' as const);
      if (open !== 'yes') return this.result(false, 'The chat is not the one open, so I did not type anything.');
      const typed = await this.deps.chat.typeInBox(d.text).catch(() => ({ ok: false as const }));
      if (!typed.ok) return this.result(false, `I could not put the reply in the message box.${'say' in typed && typed.say !== undefined ? ` ${typed.say}` : ''}`);
      this.patch({ draft: { ...d, status: 'in_box', note: 'Typed in the WhatsApp message box. Press Send in WhatsApp to send it.' } });
      return this.result(true, 'The reply is in the WhatsApp message box. Press Send there when you are happy with it; Eya does not send in Draft mode.');
    }
    this.patch({ draft: { ...d, status: 'approved' } });
    return this.result(true, 'Approved. Press Send to send it.');
  }

  private async discard(): Promise<LiveChatResult> {
    const d = this.s.draft;
    if (d === null || d.status === 'sent' || d.status === 'sending') return this.result(false, 'There is no reply to discard.');
    this.patch({ draft: { ...d, status: 'discarded' }, notice: 'The reply was discarded.' });
    this.clearTimer('autoWait');
    if (this.s.state === 'WAITING_FOR_APPROVAL' || this.s.state === 'DRAFT_READY' || this.s.state === 'WAITING_FOR_USER') {
      this.go('ACTIVE');
      this.touch(); // (the person dealt with it: it is the other person's turn now, and their silence is counted from here, not from a message that may be long ago)
    }
    return this.result(true, 'Discarded. I will draft again for the next message.');
  }

  private async regenerate(): Promise<LiveChatResult> {
    if (!WATCHING.includes(this.s.state)) return this.result(false, 'The live chat is not running.');
    if (this.sendLock) return this.result(false, 'A send is in progress.');
    this.aiRestUntil = 0;
    const read = await this.readChat();
    if (read === null || !read.ok) return this.result(false, 'I could not read the chat to write the reply again.');
    this.patch({ context: rollContext(this.s.context, read.messages) });
    const d = this.s.draft;
    // A first message waiting (not yet in WhatsApp's box or sent) is written again as a first message.
    if (d !== null && this.alive(d) && d.status !== 'in_box' && d.basedOn.length === 1 && d.basedOn[0] === OPENING_ID) {
      this.patch({ draft: { ...d, status: 'stale', note: 'Written again.' }, openingDone: false });
      if (this.s.state === 'WAITING_FOR_APPROVAL' || this.s.state === 'DRAFT_READY') this.go('ACTIVE');
      await this.openIfWanted(true);
      return this.result(this.s.error === null, this.summary());
    }
    // The messages to answer: the ones the last reply answered, or — when there were none — the unanswered messages at the end of the chat.
    const ids = new Set(d?.basedOn ?? []);
    let fresh = read.messages.filter((m) => m.dir === 'in' && ids.has(m.id));
    if (fresh.length === 0) {
      const tail: LiveChatMessage[] = [];
      for (const m of [...read.messages].reverse()) {
        if (m.dir === 'out') break;
        tail.unshift(m);
      }
      fresh = tail;
    }
    if (fresh.length === 0) {
      // Nothing to answer: if the person asked Eya to write first and that has not happened (for example the AI was out of reach), it is written now.
      if (await this.openIfWanted(true)) return this.result(this.s.error === null, this.summary());
      return this.result(false, 'There is nothing waiting for a reply.');
    }
    await this.draftFor(fresh, null, true);
    return this.result(this.s.error === null, this.summary());
  }

  // -------------------------------------------------------------------------------------------------------------------------------- modes
  private setMode(mode: 'draft' | 'assisted'): LiveChatResult {
    if (!WATCHING.includes(this.s.state) && this.s.state !== 'PAUSED') return this.result(false, 'The live chat is not running.');
    this.clearTimer('autoWait');
    this.clearTimer('autoTimer');
    this.patch({ mode, auto: null, notice: mode === 'draft' ? 'Draft mode: replies are suggested, never sent by Eya.' : 'Assisted mode: a reply is sent only when you approve it.' });
    return this.result(true, this.s.notice ?? '');
  }

  private enableAuto(r: Extract<LiveChatRequest, { kind: 'enable_auto' }>): LiveChatResult {
    if (!r.confirmedAware) return this.result(false, "Automatic replies need you to confirm that the other person knows and agrees that replies in this chat are AI-assisted. Nothing was switched on.");
    if (!WATCHING.includes(this.s.state)) return this.result(false, 'Automatic replies can only be switched on while the live chat is running.');
    if (this.s.chat === null || !this.s.chat.verified) return this.result(false, 'Automatic replies need a chat that has been confirmed as the right one.');
    const blocked = this.deps.permits('messages.send') ?? this.deps.allowed();
    if (blocked !== null) return this.result(false, `${blocked} Automatic replies were not switched on.`);
    const auto = autoFrom(this.now(), r);
    this.autoSendFails = 0;
    this.patch({
      mode: 'auto',
      auto,
      notice: `Automatic replies are ON for this chat: ${autoLimitsSaid(auto, this.now())}, at least ${Math.round(auto.minGapMs / 1000)} seconds apart. ${auto.holdBack ? 'Replies that promise something or mention figures or links wait for you.' : 'Each reply goes out as the message comes in.'} Pause or stop it whenever you like.`,
    });
    this.clearTimer('autoTimer');
    if (auto.until !== null) this.autoTimer = this.timer(() => void this.serial(() => Promise.resolve(this.endAuto('The time you allowed for automatic replies has run out.', true))), auto.until - this.now());
    // Eya introduces herself in the chat once, when she starts replying by herself (the very first thing she says is who she is) — unless she already has.
    if (r.introduce !== false && !this.s.introduced && !this.s.openingDone && this.s.replyCount === 0 && !this.s.openingWanted) this.patch({ openingWanted: true });
    // The first message is written, and (if the gate allows) sent, at the next look at the chat.
    if (this.s.openingWanted && !this.s.openingDone) {
      this.aiRetries = 0;
      void this.processNow('check');
    }
    return this.result(true, this.s.notice ?? '');
  }

  /** Automatic replies end; the chat goes on in Assisted mode, with whatever draft there is waiting for the person. */
  private endAuto(why: string, alert: boolean): LiveChatResult {
    this.clearTimer('autoWait');
    this.clearTimer('autoTimer');
    if (this.s.mode === 'auto' || this.s.auto !== null) {
      this.patch({ mode: this.s.mode === 'auto' ? 'assisted' : this.s.mode, auto: null, notice: `${why} Control is back with you.` });
      if (alert) this.deps.alert?.('Automatic replies stopped. Control is back with you.');
      if (this.s.state === 'DRAFT_READY') this.go('WAITING_FOR_APPROVAL');
    }
    return this.result(true, this.s.notice ?? why);
  }

  // ---------------------------------------------------------------------------------------------------------------------------------- sending
  private async send(by: 'user' | 'auto'): Promise<LiveChatResult> {
    return this.sendNow(by);
  }

  /**
   * Sends the draft — after checking, one more time and against the page as it is now, that it is still right to: this is still the chosen chat, no newer message has
   * made the draft out of date, the person has not answered themself, and these messages have not been answered or begun to be. The record of the send is saved BEFORE
   * Send is pressed. What came back is said as what it is; a send whose outcome is not known is never repeated.
   */
  private async sendNow(by: 'user' | 'auto', relay = false): Promise<LiveChatResult> {
    if (this.sendLock) return this.result(false, 'A send is already in progress.');
    const d0 = this.s.draft;
    if (d0 === null || !(d0.status === 'ready' || d0.status === 'edited' || d0.status === 'approved')) return this.result(false, 'There is no reply waiting to be sent.');
    if (this.s.mode === 'draft') return this.result(false, 'Draft mode never sends. Approve the reply to put it in the WhatsApp box and press Send there, or switch to Assisted mode.');
    if (this.s.state !== 'WAITING_FOR_APPROVAL' && this.s.state !== 'DRAFT_READY') return this.result(false, 'The live chat is not ready to send right now.');
    const blocked = this.deps.permits('messages.send') ?? this.deps.allowed();
    if (blocked !== null) return this.result(false, `${blocked} Nothing was sent.`);
    const label = this.s.chat?.label ?? '';
    if (label === '') return this.result(false, 'There is no chat to send to.');
    this.sendLock = true;
    const whole = (async (): Promise<LiveChatResult> => {
      try {
        return await this.sendLocked(by, d0, label, relay);
      } finally {
        this.sendLock = false;
        const wanted = this.afterSend;
        this.afterSend = null;
        if (wanted === 'stop') await this.finishStop();
        else if (wanted === 'pause') await this.pauseNow('user');
        else if (this.dirty && WATCHING.includes(this.s.state)) void this.processNow();
        this.inflight = null;
      }
    })();
    this.inflight = whole;
    return whole;
  }

  /** True while the live chat may still send: stopped or paused during the checks means nothing is sent. */
  private mayStillSend(): boolean {
    return this.s.state === 'WAITING_FOR_APPROVAL' || this.s.state === 'DRAFT_READY';
  }

  /**
   * `relay`: the draft is the person's own words for the other person (see `relay`). A newer message from the other person, or one the person typed in the chat themself, does not
   * make it out of date — it is not an answer to anything — so those two checks are skipped; the messages that arrived are answered afterwards, as usual. Everything else is checked.
   */
  private async sendLocked(by: 'user' | 'auto', draft: StoredDraft, label: string, relay = false): Promise<LiveChatResult> {
    // 1. The chat as it is now.
    const read = await this.readChat();
    if (read === null || !read.ok || !read.hasMain || !read.reliable) {
      const say = 'I could not read the chat to check it before sending, so nothing was sent.';
      // (in automatic mode the reply would otherwise sit ready, with nothing to send it, until another message happened to arrive)
      if (by === 'auto' && !isCheckIn(draft) && this.mayStillSend()) this.autoSendFailed(say);
      return this.result(false, say);
    }
    if (!this.mayStillSend()) return this.result(false, 'The live chat was paused or stopped before sending, so nothing was sent.');
    const found = scan(this.s.tracker, read.messages);
    if (relay && found.fresh.length > 0) this.dirty = true; // (what arrived is looked at, and answered, as soon as this send has ended)
    if (!relay && found.outgoing.some((m) => !this.ownSend(m))) {
      this.patch({ tracker: found.next, draft: { ...draft, status: 'discarded', note: YOU_REPLIED_NOTE } });
      this.go('ACTIVE');
      return this.result(false, 'You have already replied in the chat yourself, so I did not send the drafted reply.');
    }
    const editedBasis = found.edited.filter((m) => draft.basedOn.includes(m.id));
    if (!relay && (found.fresh.length > 0 || editedBasis.length > 0)) {
      // A newer message (or an edit to one the reply answers) makes this reply out of date. It is not sent: the messages are looked at again, a new reply is
      // written, and the person reviews that one.
      const tracker = editedBasis.length > 0 ? unmark(found.next, editedBasis.map((m) => m.id)) : this.s.tracker;
      this.patch({ tracker, draft: { ...draft, status: 'stale', note: 'A newer message arrived.' }, notice: 'A new message arrived, so the reply is being written again. Nothing was sent.' });
      this.go('ACTIVE');
      this.dirty = true; // (looked at again as soon as this send attempt has ended)
      return this.result(false, 'A new message arrived, so I will write the reply again instead of sending the old one. Please review the new one.');
    }
    this.patch({ tracker: found.next, context: rollContext(this.s.context, read.messages) });
    // 2. Still the chosen chat.
    const open = await this.deps.chat.isOpen(label).catch(() => 'unknown' as const);
    if (!this.mayStillSend()) return this.result(false, 'The live chat was paused or stopped before sending, so nothing was sent.');
    if (open !== 'yes') {
      await this.pauseNow('chat_switched', `The open chat is not the chat with ${maskNumbersIn(label)}, so nothing was sent.`);
      return this.result(false, `The open chat is not the chat with ${maskNumbersIn(label)}, so nothing was sent.`);
    }
    // 3. These messages have not been answered, or begun to be.
    const triggerKey = draft.basedOn.join('|');
    const prior = this.s.sends.find((x) => x.triggerKey === triggerKey && x.status !== 'failed' && x.status !== 'not_seen');
    if (prior !== undefined) {
      return this.result(false, prior.status === 'attempted' || prior.status === 'uncertain' ? 'An earlier send for these messages did not show whether it went. I will not send again until you have looked at the chat.' : 'These messages have already been answered.');
    }
    // 4. The record is saved BEFORE Send is pressed. (No waiting between this check and the move to SENDING: a stop cannot slip in between.)
    if (!this.mayStillSend()) return this.result(false, 'The live chat was paused or stopped before sending, so nothing was sent.');
    const lastOut = [...read.messages].reverse().find((m) => m.dir === 'out')?.id ?? null;
    const record: SendRecord = { id: this.newId(), draftId: draft.id, triggerKey, text: draft.text, at: this.now(), status: 'attempted', pressed: false, lastOutId: lastOut, by, evidence: null };
    try {
      this.patch({ sends: [...this.s.sends, record].slice(-60), draft: { ...draft, status: 'sending', note: null } }, true);
    } catch {
      this.patch({ draft });
      return this.result(false, 'I could not save the record of this send, so nothing was sent.');
    }
    if (!this.go('SENDING')) {
      this.setRecord(record.id, { status: 'failed', pressed: false });
      this.patch({ draft });
      return this.result(false, 'The live chat is not in a state to send, so nothing was sent.');
    }
    // 5. Send.
    let press: Awaited<ReturnType<LiveChatActions['typeAndSend']>>;
    try {
      press = await this.deps.chat.typeAndSend(label, draft.text);
    } catch (err) {
      // (the connection dropped part-way: whether Send was pressed is not known, so it is treated as pressed)
      log.warn('sending was interrupted', { err: String(err) });
      this.setRecord(record.id, { status: 'uncertain', pressed: true });
      return this.uncertain(draft, 'The connection to the browser dropped while sending. The message may or may not have gone: look at the chat. I will not send it again.');
    }
    if (press.kind === 'not_sent') {
      this.setRecord(record.id, { status: 'failed', pressed: false });
      // (the reason is in the log — never the message — so that a failure seen on a real page can be told from the next one)
      log.warn('a send did not go', { by, why: press.say });
      // A press that said it failed may still have gone. The chat is looked at before anything is said or tried again: what is already there is never sent twice.
      if (await this.wentAnyway(record) && this.go('VERIFYING')) return this.applyCheck(by, draft, record.id, { status: 'sent' });
      this.patch({ draft: { ...draft, status: draft.status === 'sending' ? 'ready' : draft.status, note: press.say } });
      this.go('WAITING_FOR_APPROVAL');
      // (a check-in is not a reply to anything: if it cannot go, it is dropped by its own code — it never ends the replies, and is not tried again)
      if (by === 'auto' && !isCheckIn(draft)) this.autoSendFailed(press.say);
      return this.result(false, `${press.say} Nothing was sent.`);
    }
    this.setRecord(record.id, { pressed: true });
    // 6. Check what the page shows.
    this.go('VERIFYING');
    let check: SendCheck;
    try {
      check = await this.deps.chat.verify(draft.text);
    } catch {
      return this.uncertain(draft, 'Send was pressed, but I lost the connection before I could check. Look at the chat; I will not send it again.');
    }
    return this.applyCheck(by, draft, record.id, await this.confirmByChat(check, record));
  }

  /** After a press that reported failure: is a message with these words in the chat after the last one that was there before? Then it went. */
  private async wentAnyway(record: SendRecord): Promise<boolean> {
    const read = await this.readChat();
    if (read === null || !read.ok || !read.hasMain) return false;
    const outs = read.messages.filter((m) => m.dir === 'out' && m.kind === 'text');
    const from = record.lastOutId === null ? -1 : outs.findIndex((m) => m.id === record.lastOutId);
    return outs.slice(from + 1).some((m) => same(m.text, record.text));
  }

  /**
   * An automatic reply did not go out. The same reply is tried again in a few seconds; only a few failures one after another end the automatic replies — and the person is told
   * what failed, and that it was tried. (The reply waits for the person in the meantime, as before.)
   */
  private autoSendFailed(say: string): void {
    this.autoSendFails += 1;
    if (this.autoSendFails >= MAX_AUTO_SEND_FAILS) {
      const times = this.autoSendFails;
      this.autoSendFails = 0;
      this.endAuto(`Automatic reply stopped: ${say} It failed ${times} times in a row.`, true);
      return;
    }
    this.setNotice(`I could not send the reply just now. ${say} I will try again in a few seconds.`);
    this.clearTimer('autoWait');
    this.autoWait = this.timer(() => void this.serial(() => this.tryAuto()), AUTO_SEND_RETRY_MS);
  }

  /**
   * "The message is in the chat, but no NEW delivery mark could be told from the ones already there" must not stop a live chat that is meant to wait until the person pauses it:
   * the marks are only the last few on the page and are often all the same (a chat where everything is already read). The chat itself is read, and an outgoing message with
   * these words that was not there before is the page showing it. A mark that says pending or failed, or a message that is not in the chat, stays exactly as it was found.
   */
  private async confirmByChat(check: SendCheck, record: SendRecord): Promise<SendCheck> {
    if (check.status !== 'unconfirmed') return check;
    const read = await this.readChat();
    if (read === null || !read.ok || !read.hasMain) return check;
    const outs = read.messages.filter((m) => m.dir === 'out' && m.kind === 'text');
    const from = record.lastOutId === null ? -1 : outs.findIndex((m) => m.id === record.lastOutId);
    return outs.slice(from + 1).some((m) => same(m.text, record.text)) ? { status: 'sent' } : check;
  }

  private setRecord(id: string, change: Partial<SendRecord>): void {
    this.patch({ sends: this.s.sends.map((x) => (x.id === id ? { ...x, ...change } : x)) });
  }

  private uncertain(draft: StoredDraft, say: string): LiveChatResult {
    this.patch({ draft: { ...draft, status: 'uncertain', note: say }, error: say });
    if (this.s.mode === 'auto') this.endAuto('A send did not show whether it went.', false);
    this.go('WAITING_FOR_USER');
    this.deps.alert?.('A reply was sent but I cannot confirm it. Please check the chat.');
    return this.result(false, say);
  }

  private applyCheck(by: 'user' | 'auto', draft: StoredDraft, recordId: string, check: SendCheck): LiveChatResult {
    if (check.status === 'sent') {
      const status: SendStatus = check.mark === 'delivered' ? 'delivered' : check.mark === 'read' ? 'read' : 'visibly_sent';
      this.setRecord(recordId, { status, evidence: check.mark ?? 'seen in the chat' });
      const auto = this.s.auto === null || by !== 'auto' ? this.s.auto : { ...this.s.auto, repliesSent: this.s.auto.repliesSent + 1, lastSentAt: this.now() };
      this.patch({ draft: { ...draft, status: 'sent', note: null }, replyCount: this.s.replyCount + 1, auto, error: null, notice: null });
      this.autoSendFails = 0; // (a reply went: whatever failed before is not "in a row" any more)
      this.go('ACTIVE');
      this.checkedIn = isCheckIn(draft); // (a check-in is the one thing sent that is followed by "if they still say nothing, it ends")
      this.touch(); // (a message went out: now it is the other person's turn, and the silence is counted from here)
      const shown = check.mark === 'delivered' ? ' WhatsApp shows it as delivered.' : check.mark === 'read' ? ' WhatsApp shows it as read.' : check.mark === undefined ? ' It is shown in the chat.' : ' WhatsApp shows it as sent, not yet delivered.';
      // (Automatic replies end when their number is reached, here, so that the next message is not answered by a send that was already used up.)
      if (this.s.auto !== null && this.s.auto.maxReplies !== null && this.s.auto.repliesSent >= this.s.auto.maxReplies) this.endAuto(`The ${this.s.auto.maxReplies} automatic replies you allowed have been sent.`, true);
      return this.result(true, `Sent.${shown}`);
    }
    if (check.status === 'failed') {
      this.setRecord(recordId, { status: 'failed', pressed: true });
      this.patch({ draft: { ...draft, status: 'failed', note: 'WhatsApp shows the message as failed to send.' }, error: 'WhatsApp shows the message as failed to send.' });
      if (this.s.mode === 'auto') this.endAuto('A send failed.', true);
      this.go('WAITING_FOR_USER');
      return this.result(false, 'WhatsApp shows the message as failed to send.');
    }
    this.setRecord(recordId, { status: 'uncertain', pressed: true });
    const say =
      check.status === 'pending'
        ? 'The message is in the chat but WhatsApp still shows it as sending, so I cannot say it went yet. I will not send it again.'
        : check.status === 'not_found'
          ? 'I pressed Send but cannot see the message in the chat, so I cannot say it was sent. I will not send it again without you checking the chat.'
          : 'The message is in the chat but WhatsApp has not shown that it was sent. I will not send it again.';
    return this.uncertain(draft, say);
  }

  /**
   * Looks in the chat for sends that were begun and not seen to finish (the connection dropped, or Eya was closed): an outgoing message with the same words, after the
   * last one that was there before, settles it. Never by sending again.
   */
  private async reconcile(known?: ChatReadResult): Promise<void> {
    const open = this.s.sends.filter((x) => x.status === 'attempted' || x.status === 'uncertain');
    if (open.length === 0) return;
    const read = known ?? (await this.readChat());
    if (read === null || !read.ok || !read.hasMain) return;
    let sends = [...this.s.sends];
    let draft = this.s.draft;
    let replies = this.s.replyCount;
    for (const x of open) {
      const outs = read.messages.filter((m) => m.dir === 'out' && m.kind === 'text');
      const from = x.lastOutId === null ? -1 : outs.findIndex((m) => m.id === x.lastOutId);
      const hit = outs.slice(from + 1).find((m) => same(m.text, x.text));
      if (hit !== undefined) {
        sends = sends.map((y) => (y.id === x.id ? { ...y, status: 'visibly_sent', evidence: hit.id } : y));
        if (draft !== null && draft.id === x.draftId) draft = { ...draft, status: 'sent', note: null };
        replies += 1;
      } else if (x.pressed && this.now() - x.at > SEND_SETTLE_MS) {
        sends = sends.map((y) => (y.id === x.id ? { ...y, status: 'not_seen', evidence: 'not in the chat when looked at' } : y));
        if (draft !== null && draft.id === x.draftId) draft = { ...draft, status: 'failed', note: 'The message is not in the chat. It was not sent again.' };
      } else if (!x.pressed && x.status === 'attempted') {
        sends = sends.map((y) => (y.id === x.id ? { ...y, status: 'failed' } : y));
        if (draft !== null && draft.id === x.draftId && draft.status === 'sending') draft = { ...draft, status: 'ready', note: 'The send did not happen. You can send it again.' };
      }
    }
    this.patch({ sends, draft, replyCount: replies });
  }

  // ------------------------------------------------------------------------------------------------------------------------- pause / resume / stop
  async pause(why: LiveChatPause, message?: string): Promise<LiveChatResult> {
    if (isOver(this.s.state) || this.s.state === 'PAUSED') return this.result(this.s.state === 'PAUSED', 'The live chat is paused.');
    if (BUSY_STATES.includes(this.s.state)) {
      // A send is in flight: it is not cut off half-way. The pause takes effect, and its real outcome is reported, when it ends.
      this.afterSend = this.afterSend === 'stop' ? 'stop' : 'pause';
      return this.result(true, 'A send is in progress. I will pause as soon as it has finished and tell you what happened.');
    }
    return this.pauseNow(why, message);
  }

  /** Pauses now (the caller has made sure no send is in flight): nothing is watched, drafted or sent until the person resumes. */
  private async pauseNow(why: LiveChatPause, message?: string): Promise<LiveChatResult> {
    if (isOver(this.s.state) || this.s.state === 'PAUSED') return this.result(this.s.state === 'PAUSED', 'The live chat is paused.');
    if (!canMove(this.s.state, 'PAUSED')) return this.result(false, 'The live chat cannot be paused from here.');
    this.clearTimer('autoWait');
    this.stopWatching();
    this.backSub?.();
    this.backSub = null;
    // A live chat that only lost its connection to the browser (the extension restarted, the browser was busy) carries on by itself when it is back — through the
    // same checks as the person's own Resume (the chat must be the chosen one, and Chats must still be on).
    if (why === 'browser_lost' && this.deps.watcher.onBack !== undefined) {
      this.backSub = this.deps.watcher.onBack(() => {
        this.backSub?.();
        this.backSub = null;
        if (this.s.state === 'PAUSED' && this.s.pause === 'browser_lost') void this.resume();
      });
    }
    this.note('livechat_paused', why);
    this.armPausedLimit(why);
    this.go('PAUSED', { pause: why, ...(message !== undefined ? { notice: message } : why === 'user' ? { notice: 'Paused. Nothing is watched or sent until you resume.' } : {}) });
    await this.deps.watcher.stop().catch(() => undefined);
    // Left or closed by the PERSON'S use of WhatsApp (not by their own Pause): the live chat waits, and carries on by itself when the chosen chat is open again.
    if (why === 'chat_switched' || why === 'chat_closed') this.armComeBack();
    if (why !== 'user' && why !== 'standby') this.deps.alert?.('The live chat was paused.');
    return this.result(true, this.s.notice ?? 'Paused.');
  }

  async resume(): Promise<LiveChatResult> {
    const blocked = this.gate();
    if (blocked !== null) return this.result(false, `${blocked} The live chat stays paused.`);
    if (this.s.state !== 'PAUSED' && this.s.state !== 'WAITING_FOR_USER') return this.result(false, 'The live chat is not paused.');
    return this.serial(async () => {
      const label = this.s.chat?.label ?? '';
      if (label === '') return this.result(false, 'There is no chat to resume.');
      this.autoSendFails = 0; // (a fresh start: what failed before the pause is not "in a row" with what fails after it)
      this.stopWatching();
      this.go('CONNECTING', { pause: null, error: null, notice: null });
      // The chat has to be the chosen one before anything is watched: opened again by its name if the page moved away from it.
      const open = await this.deps.chat.isOpen(label).catch(() => 'unknown' as const);
      if (open !== 'yes') {
        this.go('RESOLVING_CONTACT');
        this.query = label;
        let out: OpenOutcome;
        try {
          out = await this.deps.chat.open(label);
        } catch (err) {
          await this.failWith(this.explain(err));
          return this.result(false, this.s.error ?? 'Could not resume.');
        }
        if (out.kind !== 'opened' || !out.verified || norm(out.label) !== norm(label)) {
          await this.failWith(out.kind === 'opened' ? `I could not confirm the chat with ${maskNumbersIn(label)} to resume.` : 'say' in out ? out.say : `I could not find the chat with ${maskNumbersIn(label)} to resume.`);
          return this.result(false, this.s.error ?? 'Could not resume.');
        }
      }
      await this.connect(true);
      return this.result(RUNNING.includes(this.s.state), this.summary());
    });
  }

  /** Stops for good: nothing more is looked at, drafted or sent. A send in flight is let finish, and its real outcome is what is reported. */
  async stop(): Promise<LiveChatResult> {
    if (isOver(this.s.state)) return this.result(true, 'There is no live chat running.');
    this.clearTimer('autoWait');
    this.clearTimer('autoTimer');
    if (BUSY_STATES.includes(this.s.state)) {
      // A send is in flight: it is let finish (never cut off half-way), and what really happened is what is reported.
      this.afterSend = 'stop';
      if (canMove(this.s.state, 'STOPPING')) this.go('STOPPING');
      const settled = this.inflight;
      let outcome = '';
      if (settled !== null) outcome = await settled.then((r) => (r as LiveChatResult).message, () => '');
      return this.result(true, `Stopped.${outcome !== '' ? ` The send that was in progress: ${outcome}` : ''}`);
    }
    // Nothing is in flight; but a send that is still being CHECKED (before Send) must not go ahead: its next step finds the state changed, and sends nothing.
    await this.finishStop();
    return this.result(true, 'Stopped. Nothing more will be read, drafted or sent.');
  }

  private async finishStop(notice = 'Stopped.'): Promise<void> {
    this.stopWatching();
    await this.deps.watcher.stop().catch(() => undefined);
    if (this.s.state !== 'STOPPING' && canMove(this.s.state, 'STOPPING')) this.go('STOPPING');
    const unsettled = this.s.sends.some((x) => x.status === 'attempted' || x.status === 'uncertain');
    this.s = scrub({ ...this.s, state: 'STOPPING' });
    this.go('STOPPED', { stoppedAt: this.now(), pause: null, error: null, notice: unsettled ? `${notice} One send did not show whether it went: look at the chat.` : notice });
    this.prompt = { confirm: null, choices: [] };
  }

  private async failWith(message: string, pause: LiveChatPause | null = null): Promise<void> {
    this.stopWatching();
    await this.deps.watcher.stop().catch(() => undefined);
    this.note('livechat_failed', pause ?? 'failed');
    this.patch({ error: message, pause });
    this.go('FAILED');
    this.deps.alert?.('The live chat could not start or had to stop.');
  }

  private stopWatching(): void {
    this.unsubscribeAll();
    this.watching = false;
    this.clearTimer('reconcileTimer');
    this.clearTimer('retryTimer');
    this.clearTimer('comeBackTimer');
    this.clearTimer('idleTimer');
    this.clearTimer('pausedTimer');
    this.backSub?.();
    this.backSub = null;
  }

  // ---------------------------------------------------------------------------------------------------------------------------------- timers
  private timer(fn: () => void, ms: number): unknown {
    return this.deps.timers !== undefined ? this.deps.timers.set(fn, ms) : setTimeout(fn, Math.max(0, ms));
  }

  private clearTimer(which: 'reconcileTimer' | 'autoTimer' | 'autoWait' | 'retryTimer' | 'comeBackTimer' | 'idleTimer' | 'pausedTimer'): void {
    const t = this[which];
    if (t === null) return;
    if (this.deps.timers !== undefined) this.deps.timers.clear(t);
    else clearTimeout(t as ReturnType<typeof setTimeout>);
    this[which] = null;
  }

  /**
   * "Until I pause it, it should wait." A live chat that stopped watching only because the person went to another chat (or closed it) comes back by itself when the chosen
   * chat is open again — through the same checks as their own Resume (it must be the chosen chat, and Chats must still be on). The person's own Pause, Chats being switched
   * off, an old extension or an unreadable page are never undone this way.
   */
  private armComeBack(): void {
    this.clearTimer('comeBackTimer');
    const every = this.deps.comeBackMs ?? 4_000;
    if (every <= 0) return;
    const waiting = (): boolean => this.s.state === 'PAUSED' && (this.s.pause === 'chat_switched' || this.s.pause === 'chat_closed');
    const tick = (): void => {
      this.comeBackTimer = null;
      if (!waiting()) return;
      void this.checkComeBack().finally(() => {
        if (waiting() && this.comeBackTimer === null) this.comeBackTimer = this.timer(tick, every);
      });
    };
    this.comeBackTimer = this.timer(tick, every);
  }

  private async checkComeBack(): Promise<void> {
    if (this.gate() !== null) return; // Chats off, or the permission is gone: it stays paused
    const label = this.s.chat?.label ?? '';
    if (label === '') return;
    const open = await this.deps.chat.isOpen(label).catch(() => 'unknown' as const);
    if (open !== 'yes') return;
    // (the page must also read as a chat Eya can follow: carrying on into a page it cannot read would end the live chat instead of waiting for the person)
    const look = await this.deps.watcher.read(1).catch(() => null);
    if (look === null || !look.ok || !look.hasMain || !look.reliable) return;
    if (this.s.state !== 'PAUSED' || (this.s.pause !== 'chat_switched' && this.s.pause !== 'chat_closed')) return;
    log.info('the chosen chat is open again: carrying on by itself');
    await this.resume();
  }

  /**
   * "Unlimited messages until I stop it — or until the other person has been silent for fifteen minutes." Something just happened in the conversation (it began, they wrote, a
   * message went out): the silence is counted from now.
   */
  private touch(talk = true): void {
    this.turnAt = this.now();
    if (talk) this.talkAt = this.now();
    this.armIdle();
  }

  private armIdle(wait?: number): void {
    this.clearTimer('idleTimer');
    const ms = this.idleMs();
    if (ms <= 0 || !this.watching) return;
    const after = wait ?? Math.max(1_000, this.turnAt + ms - this.now());
    this.idleTimer = this.timer(() => {
      this.idleTimer = null;
      void this.serial(() => this.idleCheck());
    }, after);
  }

  /**
   * Has the other person been silent long enough to end it? Only when it is really THEIR turn: nothing of theirs is waiting for an answer, no reply is waiting for the person,
   * nothing is being written or sent, and the first message that was asked for has gone. (A person who takes ten minutes to approve a reply has not made the other person
   * silent.) Otherwise it looks again in half a minute.
   */
  private async idleCheck(): Promise<void> {
    const ms = this.idleMs();
    if (ms <= 0 || !this.watching) return;
    if (this.now() - this.turnAt < ms) {
      this.armIdle();
      return;
    }
    const s = this.s;
    const theirTurn =
      s.state === 'ACTIVE' && !this.busy && !this.sendLock && !(s.draft !== null && this.alive(s.draft)) && unhandled(s.tracker, s.context).length === 0 && !(s.openingWanted && !s.openingDone);
    if (!theirTurn) {
      // Not their turn, but nothing is moving either: an AI that is out of allowance cannot answer their message, a reply nobody approved, a step that never finished. Left to wait
      // this goes on for ever (a chat was found "running" after 15 hours, answering nothing). Twice the quiet time without any movement ends it; a reply that waits for the person's
      // own approval is given four times.
      const waitingForPerson = s.draft !== null && this.alive(s.draft);
      if (this.now() - this.turnAt >= (waitingForPerson ? ms * 4 : ms * 2)) {
        const why = waitingForPerson ? 'a reply was waiting for your approval' : unhandled(s.tracker, s.context).length > 0 ? 'a message of theirs was waiting and I could not answer it (the AI may be out of allowance)' : 'it was not moving';
        await this.stuckStop(why);
        return;
      }
      this.armIdle(Math.min(30_000, ms));
      return;
    }
    // One last look before ending it: a message that arrived a moment ago and was not announced yet (or one the person typed in the chat) is not silence.
    const look = await this.readChat();
    if (look === null || !this.watching) return;
    if (look.ok && look.hasMain) {
      const found = scan(this.s.tracker, look.messages);
      if (found.fresh.length > 0 || found.outgoing.some((m) => !this.ownSend(m))) {
        this.armIdle(Math.min(30_000, ms));
        void this.processNow('check');
        return;
      }
    }
    if (this.s.state !== 'ACTIVE') return; // (the read itself paused it, or something happened meanwhile)
    // Eya does not just let a quiet chat disappear: when she may answer by herself, she first checks in ONCE, with a friendly line that keeps the chat going. Only if they
    // stay quiet after that (a whole silence again) does it end.
    if (!this.checkedIn) {
      if (await this.checkIn()) return;
      // Something was announced on the page while she was writing it (and no check-in went out): that is looked at before the chat is ended, never after.
      if (this.dirty && this.watching && this.s.state === 'ACTIVE') {
        this.armIdle(Math.min(30_000, ms));
        void this.processNow('check');
        return;
      }
    }
    if (this.s.state !== 'ACTIVE') return;
    await this.idleStop();
  }

  /**
   * One friendly line to a person who has gone quiet ("anything else you want me to tell Rakesh?"), written and sent the way every automatic reply is (the same gate, the
   * same checks, the same record). Only while automatic replies are on — otherwise a check-in would sit waiting for the person to approve it. Returns true when the chat
   * should NOT be ended now (the check-in went out, or something else took over); false when nothing was sent (the AI could not write one, or the gate said no).
   */
  private async checkIn(): Promise<boolean> {
    const auto = this.s.auto;
    if (this.s.mode !== 'auto' || auto === null || this.now() < this.aiRestUntil) return false;
    if (!this.go('PROCESSING_MESSAGE')) return false;
    // While she writes it, a change on the page is not drafted for in the middle of this (it would write its own reply and collide with the check-in): it is noted, and
    // looked at the moment this is over.
    let outcome: DraftOutcome | null = null;
    this.busy = true;
    this.dirty = false;
    try {
      outcome = await generateNudge(this.deps.ai, { context: this.s.context, summary: this.s.summary, tone: this.s.tone, relation: this.s.relation, purpose: this.s.purpose, ownerName: this.ownerName(), minutes: this.idleMs() / 60_000, eyaSentIds: this.eyaSentIds() });
    } catch (err) {
      log.warn('the AI could not write a check-in', { err: String(err) });
    } finally {
      this.busy = false;
    }
    if (this.s.state !== 'PROCESSING_MESSAGE') return true; // (paused or stopped while the model was thinking)
    if (outcome === null || outcome.kind !== 'draft') {
      this.go('ACTIVE');
      return false;
    }
    const draft: StoredDraft = { id: this.newId(), text: outcome.text, status: 'ready', createdAt: this.now(), by: 'eya', confidence: outcome.confidence, commitment: outcome.commitment, note: 'A friendly check-in: they had gone quiet.', basedOn: [`${CHECK_IN_ID}:${this.newId()}`] };
    if (!autoGate(auto, draft, this.now()).ok) {
      this.go('ACTIVE');
      return false;
    }
    this.patch({ draft, notice: null });
    this.go('DRAFT_READY');
    this.note('livechat_check_in', 'quiet', { minutes: Math.round(this.idleMs() / 60_000) });
    const sent = await this.sendNow('auto');
    const left = this.s.draft;
    const stateNow = (): LiveChatState => this.s.state; // (read afresh: the send changed it)
    // A message of theirs (or one the person typed in the chat) arrived while the check-in was being sent and made it out of date: they are not quiet. That message is looked at
    // and answered; the chat is not ended.
    if (!sent.ok && left !== null && left.id === draft.id && (left.status === 'stale' || left.note === YOU_REPLIED_NOTE)) {
      this.touch(); // (the conversation moved: the silence is counted from now, and the watch for it is set again)
      return true;
    }
    // A check-in that did not go out (the page would not take it) is not left waiting for the person: it was never a reply to anything.
    if (!sent.ok && left !== null && left.id === draft.id && this.alive(left)) {
      this.patch({ draft: { ...left, status: 'discarded', note: 'The check-in was not sent.' } });
      if (stateNow() === 'WAITING_FOR_APPROVAL' || stateNow() === 'DRAFT_READY') this.go('ACTIVE');
    }
    return sent.ok || stateNow() !== 'ACTIVE';
  }

  private async stuckStop(why: string): Promise<void> {
    const chat = maskNumbersIn(this.s.chat?.label ?? 'the chat');
    const minutes = Math.max(1, Math.round((this.now() - this.turnAt) / 60_000));
    this.note('livechat_stopped', 'stuck', { minutes });
    await this.stop();
    if (this.s.state === 'STOPPED') this.patch({ notice: `Stopped by itself: nothing happened in the chat with ${chat} for ${minutes} minutes (${why}). Say "do live chat" to start it again.` });
    this.deps.alert?.(`The live chat with ${chat} stopped: nothing happened for ${minutes} minutes (${why}).`);
  }

  private async idleStop(): Promise<void> {
    const chat = maskNumbersIn(this.s.chat?.label ?? 'the chat');
    const minutes = Math.max(1, Math.round(this.idleMs() / 60_000));
    this.note('livechat_stopped', 'idle', { minutes });
    if (this.checkedIn) {
      await this.finishStop(`Stopped by itself: ${chat} did not write back, even after I checked in, for ${minutes} more minutes. Say "do live chat" to start it again.`);
      this.deps.alert?.(`The live chat with ${chat} stopped: they stayed quiet after my check-in.`);
      return;
    }
    await this.finishStop(`Stopped by itself: ${chat} did not write for ${minutes} minutes. Say "do live chat" to start it again.`);
    this.deps.alert?.(`The live chat with ${chat} stopped: they did not write for ${minutes} minutes.`);
  }

  /**
   * A paused live chat is not "running" for ever. Paused by itself (the chat was closed or left, the browser was lost, Eya was restarted) it ends after the same quiet time
   * a silent chat does (15 minutes); paused by the person's own word it is given four times as long (they chose to hold it). It was found alive after 15 hours, restored "paused"
   * after a restart and never ended, and it refused to let a new live chat start.
   */
  private armPausedLimit(why: string | null): void {
    this.clearTimer('pausedTimer');
    const ms = this.idleMs();
    if (ms <= 0) return;
    // (a chat on standby is brought forward again by its turn, which comes round well inside this)
    const limit = why === 'user' ? ms * 4 : why === 'standby' ? ms * 2 : ms;
    this.pausedTimer = this.timer(() => {
      this.pausedTimer = null;
      void this.serial(async () => {
        if (this.s.state !== 'PAUSED') return;
        const chat = maskNumbersIn(this.s.chat?.label ?? 'the chat');
        const minutes = Math.max(1, Math.round(limit / 60_000));
        this.note('livechat_stopped', 'paused_too_long', { minutes });
        await this.finishStop(`Stopped by itself: the live chat with ${chat} was paused for ${minutes} minutes. Say "do live chat" to start it again.`);
        this.deps.alert?.(`The live chat with ${chat} stopped: it had been paused for ${minutes} minutes.`);
      });
    }, limit);
  }

  /**
   * Nothing is going on in this chat right now: it is watching, no message of theirs is waiting for a reply, nothing is being written or sent, no reply waits for the person, and the first
   * message that was asked for has gone. Only such a chat can give its turn to another (see LiveChatHub).
   */
  settled(): boolean {
    const s = this.s;
    return s.state === 'ACTIVE' && !this.busy && !this.sendLock && !(s.draft !== null && this.alive(s.draft)) && unhandled(s.tracker, s.context).length === 0 && !(s.openingWanted && !s.openingDone);
  }

  /** How long since something happened in the conversation (they wrote, a message went out): Infinity before anything has. */
  quietMs(): number {
    return this.talkAt === 0 ? Number.POSITIVE_INFINITY : this.now() - this.talkAt;
  }

  /** Puts this chat on standby (not watched, nothing written or sent, no word to the person) if nothing is going on in it; false if it is not the moment. */
  async standby(): Promise<boolean> {
    if (!this.settled()) return false;
    await this.pauseNow('standby');
    return this.s.state === 'PAUSED';
  }

  /** The backstop: an occasional look at the chat in case an event was missed. Never the main way — events are. */
  private armReconcile(): void {
    this.clearTimer('reconcileTimer');
    const slow = this.deps.reconcileMs ?? 15_000;
    if (slow <= 0) return;
    const ms = this.fast ? Math.min(slow, this.deps.fastCheckMs ?? 5_000) : slow;
    const tick = (): void => {
      this.reconcileTimer = null;
      if (!this.watching) return;
      if (WATCHING.includes(this.s.state)) void this.processNow('check');
      this.reconcileTimer = this.timer(tick, ms);
    };
    this.reconcileTimer = this.timer(tick, ms);
  }

  // -------------------------------------------------------------------------------------------------------------------------------- helpers
  private pauseFor(err: unknown): LiveChatPause | null {
    if (err instanceof CommunicationAccessError) return 'access_off';
    if (err instanceof BrowserUnavailableError) return 'browser_lost';
    return null;
  }

  private explain(err: unknown): string {
    if (err instanceof CommunicationAccessError) return 'Chats are switched off in Eya, so the live chat cannot look at WhatsApp.';
    if (err instanceof BrowserUnavailableError) return 'Eya lost the connection to your browser.';
    return `Something went wrong in the browser: ${err instanceof Error ? err.message : String(err)}`;
  }

  /** One sentence for the person about where things stand. */
  private summary(): string {
    const chat = maskNumbersIn(this.s.chat?.label ?? 'the chat');
    switch (this.s.state) {
      // (the first message being written, a reply being sent or checked: the chat is on all the same, and that is what the person is told)
      case 'ACTIVE':
      case 'PROCESSING_MESSAGE':
      case 'DRAFT_READY':
      case 'SENDING':
      case 'VERIFYING':
        if (this.s.mode === 'auto' && this.s.auto !== null) {
          return `Live chat is on with ${chat}. Automatic replies are ON: I answer each new message as it comes in, ${autoLimitsSaid(this.s.auto, this.now())}.${this.s.openingWanted && !this.s.openingDone ? ' I am introducing myself in the chat now.' : ''} Say "pause live chat" to hold it or "stop live chat" to end it.`;
        }
        return `Live chat is on with ${chat} in ${this.s.mode === 'draft' ? 'Draft' : this.s.mode === 'assisted' ? 'Assisted' : 'Auto-reply'} mode. I am watching for new messages and will draft replies${this.s.mode === 'draft' ? ' for you to review; I will not send anything' : ''}.${this.s.notice !== null && /could not switch on automatic/.test(this.s.notice) ? ` ${this.s.notice}` : ''}`;
      case 'WAITING_FOR_APPROVAL':
        return `A reply for ${chat} is waiting for you.`;
      case 'WAITING_FOR_USER':
        return this.s.error ?? this.s.notice ?? 'I need you for something.';
      case 'PAUSED':
        return this.s.notice ?? 'The live chat is paused.';
      case 'FAILED':
        return this.s.error ?? 'The live chat could not start.';
      case 'STOPPED':
        return 'Stopped.';
      default:
        return `Live chat: ${this.s.state.toLowerCase().replace(/_/g, ' ')}.`;
    }
  }

  /** For tests and shutdown: stops timers and listeners without touching the chat. */
  dispose(): void {
    this.stopWatching();
    this.clearTimer('autoWait');
    this.clearTimer('autoTimer');
    this.listeners.clear();
  }

  /** What the draft's status would be called for a person (used by the tool and the voice reply). */
  describeDraft(status: LiveDraftStatus): string {
    return status === 'in_box' ? 'typed in the WhatsApp box' : status;
  }
}
