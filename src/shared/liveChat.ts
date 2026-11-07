/**
 * The Live Chat Companion as the Eya window sees it: one chat the person chose, watched while they allow it, with replies drafted for them. What is here is
 * what crosses from Eya's main process to its page — a picture of the session and the few things the page may ask for. Nothing in it is a token, a contact list
 * or any chat other than the one chosen.
 */

export const LIVE_CHAT_STATES = [
  'IDLE',
  'RESOLVING_CONTACT',
  'CONNECTING',
  'ACTIVE',
  'PROCESSING_MESSAGE',
  'DRAFT_READY',
  'WAITING_FOR_APPROVAL',
  'SENDING',
  'VERIFYING',
  'PAUSED',
  'WAITING_FOR_USER',
  'STOPPING',
  'STOPPED',
  'FAILED',
] as const;
export type LiveChatState = (typeof LIVE_CHAT_STATES)[number];

/** draft: replies are suggested and never sent by Eya. assisted: Eya sends one only when the person approves it. auto: Eya sends within limits the person set (see LiveChatAuto). */
export type LiveChatMode = 'draft' | 'assisted' | 'auto';

/** How far a reply got. `sent` is only ever set when the page showed the message. */
export type LiveDraftStatus = 'ready' | 'edited' | 'approved' | 'in_box' | 'sending' | 'sent' | 'uncertain' | 'failed' | 'discarded' | 'stale';

export interface LiveMessageView {
  readonly id: string;
  readonly dir: 'in' | 'out';
  readonly kind: string;
  /** The words, for the person's own screen; empty for a sticker, a voice note and the like. */
  readonly text: string;
  /** The time the page printed. */
  readonly at: string;
  /** An incoming message that has been looked at (a reply drafted, or no reply needed). */
  readonly handled: boolean;
}

export interface LiveDraftView {
  readonly id: string;
  readonly text: string;
  readonly status: LiveDraftStatus;
  readonly createdAt: number;
  /** How many incoming messages it answers. */
  readonly answers: number;
  /** Who wrote it: the model, or the person. */
  readonly by: 'eya' | 'you';
  /** The model's own account of how sure it is, and whether the reply promises or states something for the person. */
  readonly confidence: 'high' | 'medium' | 'low';
  readonly commitment: boolean;
  /** Why it was not sent / what to check, in one line. */
  readonly note: string | null;
}

export interface LiveAutoView {
  /** The most automatic replies the person set, or null: no limit, it goes on until they pause or stop it. */
  readonly maxReplies: number | null;
  readonly repliesSent: number;
  readonly minGapSeconds: number;
  /** When automatic replies end by themselves (ms since 1970), or null: no time limit. */
  readonly until: number | null;
  /** Replies that promise something, mention figures or links, or that Eya is unsure of, wait for the person (off by default: replies go out as messages come in). */
  readonly holdBack: boolean;
}

/**
 * Who the other person is to the person Eya writes for. It decides how Eya sounds: a friend gets a casual, playful tone; a partner a warm and caring one; family a respectful and
 * simple one; a senior (sir, madam, boss, teacher) a polite and brief one with no slang or emoji; a client a professional one.
 */
export type LiveRelation = 'friend' | 'partner' | 'family' | 'senior' | 'client' | 'other';
export const LIVE_RELATIONS: readonly LiveRelation[] = ['friend', 'partner', 'family', 'senior', 'client', 'other'];

/** Why the session is not simply running, in a word the page maps to a sentence. `standby`: several live chats run at once, and this one is waiting for its turn (see LiveChatHub). */
export type LiveChatPause = 'user' | 'chat_switched' | 'chat_closed' | 'browser_lost' | 'restart' | 'extension_old' | 'access_off' | 'unreadable' | 'standby';

/** One live chat in the list of the live chats that are running (when there are several). */
export interface LiveChatSummary {
  readonly id: string;
  /** The chat as the page names it (a number is shown with all but its last four digits hidden). */
  readonly chat: string;
  readonly state: LiveChatState;
  readonly pause: LiveChatPause | null;
  readonly relation: LiveRelation | null;
  readonly replies: number;
  /** The one the Live chat page shows in full, and that the person's "stop" / "pause" words are about. */
  readonly front: boolean;
}

/** One thing the single "Enable live chat" switch needs, and whether it is in place right now. */
export interface LiveChatEnableItem {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
}

/**
 * The ONE switch for the live chat. Turning it on (only the person's own click on the Live chat page does) allows everything the live chat needs — WhatsApp in Eya,
 * the plugin's find / live-chat / send permissions — and is the person's standing confirmation that the people they live-chat with know replies are written with AI
 * help: a live chat then starts replying by itself, with no further question.
 */
export interface LiveChatEnableView {
  /** What Eya calls the person in the chat ("I am Eya, <name>'s assistant"): what they set, or their Windows name. Empty: not known. */
  readonly ownerName: string;
  /** The person turned it on (and has not turned it off). */
  readonly on: boolean;
  /** On, and everything it needs is still in place (a permission taken away on the Plugins page afterwards makes this false). */
  readonly ready: boolean;
  readonly items: readonly LiveChatEnableItem[];
}

/** Something the other person wants the person to know or answer, as Eya took it down. */
export interface LiveNoteView {
  readonly id: string;
  readonly at: number;
  readonly text: string;
}

export interface LiveChoiceView {
  readonly choice: number;
  readonly label: string;
}

export interface LiveChatView {
  /** A session exists and has not ended. */
  readonly active: boolean;
  readonly sessionId: string | null;
  readonly app: string;
  /** The chat the session is bound to, as the page names it (a number is shown with all but its last four digits hidden). */
  readonly chat: string | null;
  /** The chat is an exact name or a whole number the page confirmed, not a likely match. */
  readonly verified: boolean;
  readonly state: LiveChatState;
  readonly mode: LiveChatMode;
  readonly auto: LiveAutoView | null;
  readonly startedAt: number | null;
  readonly replies: number;
  readonly draft: LiveDraftView | null;
  readonly recent: readonly LiveMessageView[];
  /** What is going wrong, in a sentence for the person. */
  readonly error: string | null;
  /** What just happened that they should know (a reply was refreshed, auto-reply stopped, nothing needed a reply). */
  readonly notice: string | null;
  readonly pause: LiveChatPause | null;
  /** Several chats fit what was said / the chat is only a likely match: the person decides. */
  readonly choices: readonly LiveChoiceView[];
  readonly confirmChat: string | null;
  /** What the person asked of this chat, in their words (shown so they can see what Eya was told). */
  readonly purpose: string;
  /** How new messages are noticed. `event`: the page tells Eya when the chat changes. `checking`: the page was seen NOT to announce a message, so the chat is looked at every few seconds. */
  readonly monitoring: 'event' | 'checking' | 'off';
  /** When Eya last looked at the chat (ms since 1970), or null. */
  readonly lastCheckAt: number | null;
  /** Whether Eya may send: the plugin permission and Communication Access. */
  readonly sendAllowed: boolean;
  /** The one "Enable live chat" switch and what it covers. */
  readonly enable: LiveChatEnableView;
  /** What the other person asked Eya to pass on to the person (newest last), kept until cleared. */
  readonly forYou: readonly LiveNoteView[];
  /** The live chat stops by itself when the other person has not written for this many minutes (null: it does not). */
  readonly idleStopMinutes: number | null;
  /** Who the other person is to the person (how Eya sounds), when known. */
  readonly relation?: LiveRelation | null;
  /** Every live chat that is running, when there are several (absent: just the one shown). */
  readonly chats?: readonly LiveChatSummary[];
}

export type LiveChatRequest =
  /**
   * `purpose`: what the person wants from this chat, in their words (it guides the replies). `opening`: true = Eya writes the first message, introducing herself; false = she
   * does not; absent = she does whenever she is to reply by herself (only once automatic replies are on).
   */
  /** `knows`: the person said, in this request, that the other person knows replies are written with AI help (true) or does NOT know (false); absent = not said. */
  | { readonly kind: 'start'; readonly name: string; readonly mode?: LiveChatMode; readonly purpose?: string; readonly opening?: boolean; readonly knows?: boolean; /** Who the other person is to the person (how Eya sounds). */ readonly relation?: LiveRelation }
  /** The one switch, on or off. Sent only by Eya's own Live chat page (a tool, a voice command or a web page cannot reach it). */
  | { readonly kind: 'enable_live' }
  | { readonly kind: 'disable_live' }
  /** What Eya calls the person in the chat ("<name>'s assistant"). Only Eya's own page sends it. */
  | { readonly kind: 'set_owner_name'; readonly name: string }
  /** The person has read what the other person asked to pass on: it is cleared. */
  | { readonly kind: 'clear_notes' }
  /** The person's own words for the other person ("tell her I will call at 6"): sent to them in the chat as the person's message. Only their own words reach this (never a model). */
  | { readonly kind: 'relay'; readonly text: string }
  /** `all`: every live chat that is running. `chat`: the one with that session id (from the list). Neither: the one the page shows. */
  | { readonly kind: 'stop'; readonly all?: boolean; readonly chat?: string }
  /** Show and work on this one of several live chats (the others wait for their turn). */
  | { readonly kind: 'focus'; readonly chat: string }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'set_mode'; readonly mode: 'draft' | 'assisted' }
  | { readonly kind: 'enable_auto'; readonly confirmedAware: boolean; readonly maxReplies?: number; readonly maxMinutes?: number; readonly minGapSeconds?: number; readonly holdBack?: boolean; readonly introduce?: boolean }
  | { readonly kind: 'disable_auto' }
  | { readonly kind: 'edit_draft'; readonly text: string }
  | { readonly kind: 'approve' }
  | { readonly kind: 'send' }
  | { readonly kind: 'discard' }
  | { readonly kind: 'regenerate' }
  | { readonly kind: 'confirm_chat' }
  | { readonly kind: 'choose'; readonly choice: number };

export interface LiveChatResult {
  readonly ok: boolean;
  /** One sentence for the person: what happened or why not. */
  readonly message: string;
  readonly view: LiveChatView;
}

export const EMPTY_LIVE_CHAT_VIEW: LiveChatView = {
  active: false,
  sessionId: null,
  app: 'WhatsApp',
  chat: null,
  verified: false,
  state: 'IDLE',
  mode: 'draft',
  auto: null,
  startedAt: null,
  replies: 0,
  draft: null,
  recent: [],
  error: null,
  notice: null,
  pause: null,
  choices: [],
  confirmChat: null,
  purpose: '',
  monitoring: 'off',
  lastCheckAt: null,
  sendAllowed: false,
  enable: { ownerName: '', on: false, ready: false, items: [] },
  forYou: [],
  idleStopMinutes: null,
};

const MODES: readonly LiveChatMode[] = ['draft', 'assisted', 'auto'];

function int(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.trunc(v))) : undefined;
}

/** What the page sent, as one of the known requests — or null. Nothing that is not exactly one of these changes anything. */
export function parseLiveChatRequest(raw: unknown): LiveChatRequest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  switch (r['kind']) {
    case 'start': {
      if (typeof r['name'] !== 'string' || r['name'].trim() === '' || r['name'].length > 120) return null;
      const mode = MODES.find((m) => m === r['mode']);
      const purpose = typeof r['purpose'] === 'string' ? r['purpose'].replace(/\s+/g, ' ').trim().slice(0, 300) : '';
      return {
        kind: 'start',
        name: r['name'].trim(),
        ...(mode === 'draft' || mode === 'assisted' ? { mode } : {}),
        ...(purpose !== '' ? { purpose } : {}),
        ...(typeof r['opening'] === 'boolean' ? { opening: r['opening'] } : {}),
        ...(typeof r['knows'] === 'boolean' ? { knows: r['knows'] } : {}),
        ...(LIVE_RELATIONS.find((x) => x === r['relation']) !== undefined ? { relation: r['relation'] as LiveRelation } : {}),
      };
    }
    case 'stop': {
      const chat = typeof r['chat'] === 'string' && r['chat'].length > 0 && r['chat'].length <= 80 ? r['chat'] : undefined;
      return { kind: 'stop', ...(r['all'] === true ? { all: true } : {}), ...(chat !== undefined ? { chat } : {}) };
    }
    case 'focus':
      return typeof r['chat'] === 'string' && r['chat'].length > 0 && r['chat'].length <= 80 ? { kind: 'focus', chat: r['chat'] } : null;
    case 'set_owner_name': {
      const name = typeof r['name'] === 'string' ? r['name'].replace(/\s+/g, ' ').trim() : null;
      // (a name: letters, spaces and the usual marks; nothing that could carry an instruction or a number)
      return name !== null && name.length <= 40 && /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(name) ? { kind: 'set_owner_name', name } : name === '' ? { kind: 'set_owner_name', name: '' } : null;
    }
    case 'clear_notes':
    case 'enable_live':
    case 'disable_live':
    case 'pause':
    case 'resume':
    case 'disable_auto':
    case 'approve':
    case 'send':
    case 'discard':
    case 'regenerate':
    case 'confirm_chat':
      return { kind: r['kind'] };
    case 'set_mode':
      return r['mode'] === 'draft' || r['mode'] === 'assisted' ? { kind: 'set_mode', mode: r['mode'] } : null;
    case 'enable_auto': {
      const maxReplies = int(r['maxReplies'], 1, 1000);
      const maxMinutes = int(r['maxMinutes'], 1, 24 * 60);
      const minGapSeconds = int(r['minGapSeconds'], 5, 600);
      return {
        kind: 'enable_auto',
        confirmedAware: r['confirmedAware'] === true,
        ...(maxReplies !== undefined ? { maxReplies } : {}),
        ...(maxMinutes !== undefined ? { maxMinutes } : {}),
        ...(minGapSeconds !== undefined ? { minGapSeconds } : {}),
        ...(r['holdBack'] === true ? { holdBack: true } : {}),
        ...(r['introduce'] === false ? { introduce: false } : {}),
      };
    }
    case 'edit_draft':
      return typeof r['text'] === 'string' && r['text'].length <= 2000 ? { kind: 'edit_draft', text: r['text'] } : null;
    case 'relay': {
      const text = typeof r['text'] === 'string' ? r['text'].replace(/\s+/g, ' ').trim() : '';
      return text !== '' && text.length <= 600 ? { kind: 'relay', text } : null;
    }
    case 'choose': {
      const choice = int(r['choice'], 1, 50);
      return choice === undefined ? null : { kind: 'choose', choice };
    }
    default:
      return null;
  }
}
