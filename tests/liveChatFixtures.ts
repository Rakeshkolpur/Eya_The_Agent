import type { ChatReadResult, LiveChatMessage } from '../src/main/browser/BrowserAutomationService';
import type { DraftAI } from '../src/main/livechat/draft';
import { LiveChatController } from '../src/main/livechat/LiveChatController';
import type { LiveChatActions, LiveChatDeps, LiveWatcher, OpenOutcome, SendCheck, SendPress } from '../src/main/livechat/LiveChatController';
import { LiveChatStore } from '../src/main/livechat/LiveChatStore';
import { plainText } from '../src/main/livechat/messages';
import type { LiveChatPause } from '../src/shared/liveChat';

/**
 * A mock WhatsApp chat for the live chat's tests: a message list the test adds to, a watcher that says when it changed, and the actions (open, type, send, check)
 * over it. Mock only — it proves how the controller behaves, not how the real page does.
 */
export class FakeChat {
  messages: LiveChatMessage[] = [];
  title = 'Rahul Sharma';
  hasMain = true;
  reliable = true;
  /** What the reader says about how it read the page (counts only), when a test wants it. */
  diagnostics: Extract<ChatReadResult, { ok: true }>['diagnostics'] | undefined = undefined;
  /** The chat the page shows open (what `isOpen` reports on). */
  open: string | null = 'Rahul Sharma';
  /** What `isOpen` says when it cannot tell. */
  unknownIdentity = false;
  box = '';
  /** Every text Send was pressed for. */
  pressed: string[] = [];
  reads = 0;
  starts = 0;
  stops = 0;
  watcherFails: { message: string; pause: LiveChatPause | null } | null = null;
  readError: Error | null = null;
  /** Reading is held until `release()` (to test two things at once). */
  hold: Promise<void> | null = null;
  openOutcome: OpenOutcome = { kind: 'opened', label: 'Rahul Sharma', verified: true };
  chooseOutcome: OpenOutcome = { kind: 'opened', label: 'Rahul Verma', verified: true };
  /** Pressing Send puts the message in the chat as sent, unless a test turns that off. */
  sendAppears = true;
  /** WhatsApp draws an emoji as a little picture: the text the page gives back for a sent message has none. */
  drawsEmojiAsPictures = false;
  /** What verify_sent says; null = look in the chat. */
  verifyAs: SendCheck | null = null;
  sendThrows: Error | null = null;
  notSent: string | null = null;
  /** The next this-many presses of Send fail (nothing is sent), then Send works again. */
  failSends = 0;
  failSendsSay = "I couldn't press Send.";
  /** The next press puts the message in the chat, but the press is reported as failed (the page said no, and was wrong). */
  saysNotSentButSent = false;
  /** The read with this number (counting from the first one: see `reads`) says the page cannot be read reliably, once. */
  unreliableOnRead: number | null = null;
  /** Called at the moment Send is pressed (to look at what is saved by then). */
  atSend: ((text: string) => void) | null = null;
  /** Sending takes this long (held until `releaseSend()`). */
  holdSend: Promise<void> | null = null;
  private n = 0;
  private listeners = new Set<(reason: string) => void>();
  private lostListeners = new Set<(why: LiveChatPause) => void>();
  private backListeners = new Set<() => void>();

  incoming(text: string, kind: LiveChatMessage['kind'] = 'text'): LiveChatMessage {
    const m: LiveChatMessage = { id: `false_${++this.n}`, dir: 'in', kind, text, at: '10:00' };
    this.messages.push(m);
    return m;
  }

  /** A message the account itself sent (from the phone, say). */
  outgoing(text: string): LiveChatMessage {
    const m: LiveChatMessage = { id: `true_${++this.n}`, dir: 'out', kind: 'text', text, at: '10:01' };
    this.messages.push(m);
    return m;
  }

  edit(id: string, text: string): void {
    this.messages = this.messages.map((m) => (m.id === id ? { ...m, text } : m));
  }

  /** The page says the chat changed. */
  changed(reason = 'messages'): void {
    for (const l of [...this.listeners]) l(reason);
  }

  lost(why: LiveChatPause = 'browser_lost'): void {
    for (const l of [...this.lostListeners]) l(why);
  }

  /** The connection to the browser comes back. */
  back(): void {
    for (const l of [...this.backListeners]) l();
  }

  get watching(): boolean {
    return this.listeners.size > 0;
  }

  watcher: LiveWatcher = {
    start: async () => {
      this.starts += 1;
      return this.watcherFails === null ? { ok: true } : { ok: false, message: this.watcherFails.message, pause: this.watcherFails.pause };
    },
    stop: async () => {
      this.stops += 1;
    },
    read: async (max): Promise<ChatReadResult> => {
      this.reads += 1;
      if (this.hold !== null) await this.hold;
      if (this.readError !== null) throw this.readError;
      const unreliableNow = this.unreliableOnRead !== null && this.reads === this.unreliableOnRead;
      return { ok: true, tabId: 1, hasMain: this.hasMain, title: this.title, messages: this.messages.slice(-max), reliable: this.reliable && !unreliableNow, ...(this.diagnostics !== undefined ? { diagnostics: this.diagnostics } : {}) };
    },
    onChange: (cb) => {
      this.listeners.add(cb);
      return () => this.listeners.delete(cb);
    },
    onLost: (cb) => {
      this.lostListeners.add(cb);
      return () => this.lostListeners.delete(cb);
    },
    onBack: (cb) => {
      this.backListeners.add(cb);
      return () => this.backListeners.delete(cb);
    },
  };

  actions: LiveChatActions = {
    open: async () => this.openOutcome,
    choose: async () => this.chooseOutcome,
    isOpen: async (label) => (this.unknownIdentity ? 'unknown' : this.open === null ? 'no' : this.open === label ? 'yes' : 'wrong'),
    typeInBox: async (text) => {
      this.box = text;
      return { ok: true };
    },
    typeAndSend: async (label, text): Promise<SendPress> => {
      if (this.notSent !== null) return { kind: 'not_sent', say: this.notSent };
      if (this.failSends > 0) {
        this.failSends -= 1;
        return { kind: 'not_sent', say: this.failSendsSay };
      }
      if (this.open !== label) return { kind: 'not_sent', say: 'The chat that is open is not the one chosen.' };
      if (this.saysNotSentButSent) {
        this.saysNotSentButSent = false;
        this.pressed.push(text);
        this.outgoing(text);
        return { kind: 'not_sent', say: this.failSendsSay };
      }
      this.atSend?.(text);
      if (this.holdSend !== null) await this.holdSend;
      if (this.sendThrows !== null) throw this.sendThrows;
      this.pressed.push(text);
      if (this.sendAppears) this.outgoing(this.drawsEmojiAsPictures ? plainText(text) : text);
      return { kind: 'pressed' };
    },
    verify: async (text): Promise<SendCheck> => {
      if (this.verifyAs !== null) return this.verifyAs;
      return this.messages.some((m) => m.dir === 'out' && plainText(m.text) === plainText(text)) ? { status: 'sent', mark: 'sent' } : { status: 'not_found' };
    },
  };
}

/** A model that answers from a queue (or a function) and keeps every request it was given. */
export class FakeAI implements DraftAI {
  requests: string[] = [];
  private queue: Array<string | Error> = [];
  fallback: (() => string | Error) | null = null;
  hold: Promise<void> | null = null;
  /** Answers as the small local model would (the completion says so): the draft is held to a firmer standard. */
  small = false;
  /** The options each request came with (the structured-task shape the local model is sent). */
  optionsSeen: Array<{ structured?: { schema: unknown; local?: ReadonlyArray<{ role: string; content: string }> } } | undefined> = [];

  say(reply: string | null, extra: Record<string, unknown> = {}): this {
    this.queue.push(
      JSON.stringify({ reply, needs_user: null, no_reply_needed: reply === null ? 'nothing to say' : null, confidence: 'high', commitment: false, summary: 'chatting', ...extra }),
    );
    return this;
  }

  raw(text: string | Error): this {
    this.queue.push(text);
    return this;
  }

  get calls(): number {
    return this.requests.length;
  }

  async complete(messages: ReadonlyArray<{ role: string; content: string }>, _tools?: readonly never[], options?: FakeAI['optionsSeen'][number]): Promise<{ text: string; toolCalls: never[]; usage?: never; local?: true }> {
    this.requests.push(messages.map((m) => m.content).join('\n---\n'));
    this.optionsSeen.push(options);
    if (this.hold !== null) await this.hold;
    const next = this.queue.shift() ?? this.fallback?.() ?? new Error('the AI has nothing queued');
    if (next instanceof Error) throw next;
    return { text: next, toolCalls: [], ...(this.small ? { local: true as const } : {}) };
  }
}

export class MemoryIo {
  files = new Map<string, string>();
  writes: string[] = [];
  read = (path: string): string | null => this.files.get(path) ?? null;
  write = (path: string, text: string): void => {
    this.files.set(path, text);
    this.writes.push(text);
  };
}

export interface Rig {
  readonly chat: FakeChat;
  readonly ai: FakeAI;
  readonly io: MemoryIo;
  readonly alerts: string[];
  /** What was said TO the person (spoken, shown), in order. */
  readonly said: Array<{ spoken: string; shown: string }>;
  readonly clock: { now: number };
  readonly controller: LiveChatController;
  readonly deps: LiveChatDeps;
  readonly timers: Array<{ fn: () => void; at: number; id: number; cleared: boolean }>;
  /** Runs the timers that are due after moving the clock forward. */
  advance(ms: number): void;
  /** A second controller over the same saved file (a restart), with the same fake page. */
  restarted(): LiveChatController;
}

/** A stand-in for the one Enable live chat switch: on or off, with what the page would show. */
export class FakeSwitch {
  on = false;
  /** What is still in place underneath it (a permission taken away on the Plugins page makes this false). */
  inPlace = true;
  turnedOn = 0;
  turnedOff = 0;
  failOn: string | null = null;
  /** What Eya calls the person in the chat. */
  owner = 'Rakesh';
  get standing(): boolean {
    return this.on && this.inPlace;
  }
  readonly control = {
    view: () => ({ ownerName: this.owner, on: this.on, ready: this.standing, items: [{ id: 'connected', label: 'Eya may use your WhatsApp', ok: this.inPlace }] }),
    ownerName: () => this.owner,
    setOwnerName: (name: string) => {
      this.owner = name;
      return { ok: true, message: 'Saved.' };
    },
    standing: () => this.standing,
    turnOn: () => {
      this.turnedOn += 1;
      if (this.failOn !== null) return { ok: false, message: this.failOn };
      this.on = true;
      this.inPlace = true;
      return { ok: true, message: 'Live chat is enabled.' };
    },
    turnOff: () => {
      this.turnedOff += 1;
      this.on = false;
      return { ok: true, message: 'Live chat is switched off.' };
    },
  };
}

export interface RigOptions {
  /** The silence after which the live chat stops by itself (ms). Off (0) unless a test asks: most tests move the clock by hours. */
  idleStopMs?: number;
  /** What the live chat may do with pictures and documents; absent: they are not looked at. */
  media?: LiveChatDeps['media'];
  permits?: (permission: string) => string | null;
  enable?: LiveChatDeps['enable'];
  comeBackMs?: number;
  allowed?: () => string | null;
  reconcileMs?: number;
  fastCheckMs?: number;
}

export function rig(options: RigOptions = {}): Rig {
  const chat = new FakeChat();
  const ai = new FakeAI();
  const io = new MemoryIo();
  const alerts: string[] = [];
  const said: Array<{ spoken: string; shown: string }> = [];
  const clock = { now: 1_800_000_000_000 };
  const timers: Rig['timers'] = [];
  let ids = 0;
  const deps: LiveChatDeps = {
    store: new LiveChatStore('live-chat.json', io, () => clock.now),
    ai,
    watcher: chat.watcher,
    chat: chat.actions,
    permits: options.permits ?? ((): null => null),
    ...(options.enable !== undefined ? { enable: options.enable } : {}),
    allowed: options.allowed ?? ((): null => null),
    now: () => clock.now,
    newId: () => `id${++ids}`,
    alert: (m) => alerts.push(m),
    say: (spoken, shown) => said.push({ spoken, shown }),
    idleStopMs: options.idleStopMs ?? 0,
    ...(options.media !== undefined ? { media: options.media } : {}),
    reconcileMs: options.reconcileMs ?? 0,
    comeBackMs: options.comeBackMs ?? 0,
    ...(options.fastCheckMs !== undefined ? { fastCheckMs: options.fastCheckMs } : {}),
    timers: {
      set: (fn, ms) => {
        const t = { fn, at: clock.now + ms, id: timers.length + 1, cleared: false };
        timers.push(t);
        return t.id;
      },
      clear: (id) => {
        const t = timers.find((x) => x.id === id);
        if (t !== undefined) t.cleared = true;
      },
    },
  };
  const controller = new LiveChatController(deps);
  return {
    chat,
    ai,
    io,
    alerts,
    said,
    clock,
    controller,
    deps,
    timers,
    advance(ms) {
      clock.now += ms;
      for (const t of timers.filter((x) => !x.cleared && x.at <= clock.now)) {
        t.cleared = true;
        t.fn();
      }
    },
    restarted() {
      const next = new LiveChatController({ ...deps, store: new LiveChatStore('live-chat.json', io, () => clock.now) });
      next.restore();
      return next;
    },
  };
}

/** Lets pending promises (and the one-look-at-a-time loop) finish. */
export async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}
