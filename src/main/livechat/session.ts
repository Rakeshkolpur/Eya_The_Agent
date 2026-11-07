import type { LiveChatMessage } from '@main/browser/BrowserAutomationService';
import type { LiveChatMode, LiveChatPause, LiveChatState, LiveDraftStatus, LiveRelation } from '@shared/liveChat';
import { LIVE_CHAT_STATES, LIVE_RELATIONS } from '@shared/liveChat';
import { EMPTY_TRACKER } from './messages';
import type { MediaNote, Tracker } from './messages';

/**
 * The live chat session as it is kept on disk, and the rules for which state can follow which. A session that is not over when Eya closes comes back PAUSED, with
 * nothing sent and nothing watched: it carries on only when the person says so.
 */

/** Which state may follow which. A move that is not here is a bug, and is refused (and logged) instead of silently happening. */
export const NEXT: Readonly<Record<LiveChatState, readonly LiveChatState[]>> = {
  IDLE: ['RESOLVING_CONTACT'],
  RESOLVING_CONTACT: ['CONNECTING', 'WAITING_FOR_USER', 'FAILED', 'STOPPING', 'STOPPED'],
  CONNECTING: ['ACTIVE', 'WAITING_FOR_USER', 'RESOLVING_CONTACT', 'PAUSED', 'FAILED', 'STOPPING', 'STOPPED'],
  ACTIVE: ['PROCESSING_MESSAGE', 'WAITING_FOR_APPROVAL', 'PAUSED', 'WAITING_FOR_USER', 'FAILED', 'STOPPING'],
  PROCESSING_MESSAGE: ['ACTIVE', 'DRAFT_READY', 'WAITING_FOR_APPROVAL', 'WAITING_FOR_USER', 'PAUSED', 'FAILED', 'STOPPING'],
  DRAFT_READY: ['WAITING_FOR_APPROVAL', 'SENDING', 'PROCESSING_MESSAGE', 'WAITING_FOR_USER', 'PAUSED', 'STOPPING', 'ACTIVE'],
  WAITING_FOR_APPROVAL: ['SENDING', 'PROCESSING_MESSAGE', 'ACTIVE', 'WAITING_FOR_USER', 'DRAFT_READY', 'PAUSED', 'STOPPING', 'FAILED'],
  SENDING: ['VERIFYING', 'WAITING_FOR_APPROVAL', 'WAITING_FOR_USER', 'STOPPING', 'FAILED'],
  VERIFYING: ['ACTIVE', 'WAITING_FOR_USER', 'WAITING_FOR_APPROVAL', 'STOPPING', 'FAILED'],
  PAUSED: ['CONNECTING', 'ACTIVE', 'WAITING_FOR_USER', 'FAILED', 'STOPPING', 'STOPPED'],
  WAITING_FOR_USER: ['ACTIVE', 'CONNECTING', 'WAITING_FOR_APPROVAL', 'PROCESSING_MESSAGE', 'RESOLVING_CONTACT', 'PAUSED', 'FAILED', 'STOPPING', 'STOPPED'],
  STOPPING: ['STOPPED'],
  STOPPED: ['IDLE'],
  FAILED: ['IDLE', 'STOPPING', 'STOPPED'],
};

export const canMove = (from: LiveChatState, to: LiveChatState): boolean => from === to || NEXT[from].includes(to);

/** A session that is over (or never began). */
export const isOver = (s: LiveChatState): boolean => s === 'IDLE' || s === 'STOPPED' || s === 'FAILED';

/** States in which new messages of the chat are looked at. */
export const WATCHING: readonly LiveChatState[] = ['ACTIVE', 'PROCESSING_MESSAGE', 'DRAFT_READY', 'WAITING_FOR_APPROVAL', 'WAITING_FOR_USER'];

export interface StoredDraft {
  readonly id: string;
  readonly text: string;
  readonly status: LiveDraftStatus;
  readonly createdAt: number;
  readonly by: 'eya' | 'you';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly commitment: boolean;
  readonly note: string | null;
  /** The incoming messages it answers (the page's own ids). */
  readonly basedOn: readonly string[];
}

/** How far a send got, as far as anything showed. Only `visibly_sent` and beyond mean the page showed the message. */
export type SendStatus = 'attempted' | 'visibly_sent' | 'delivered' | 'read' | 'uncertain' | 'failed' | 'not_seen';

export interface SendRecord {
  readonly id: string;
  readonly draftId: string;
  /** What the send answers (the ids it was for): the same trigger is never answered twice. */
  readonly triggerKey: string;
  readonly text: string;
  readonly at: number;
  readonly status: SendStatus;
  /** Send was really pressed (so the message may have gone, whatever came back). */
  readonly pressed: boolean;
  /** The last message the account had sent before this one (to tell the new one apart afterwards). */
  readonly lastOutId: string | null;
  readonly by: 'user' | 'auto';
  /** What was seen: the page's own mark, or the id of the message found in the chat. */
  readonly evidence: string | null;
}

export interface StoredAuto {
  /** The most automatic replies, or null for no limit (until the person pauses or stops it). */
  readonly maxReplies: number | null;
  readonly repliesSent: number;
  readonly minGapMs: number;
  /** When automatic replies end by themselves (ms since 1970), or null for no time limit. */
  readonly until: number | null;
  readonly lastSentAt: number | null;
  /**
   * The person asked for replies that promise something, or mention figures or links, or that Eya is unsure of, to be held back for their approval. Off by default:
   * the person is watching the chat, so each reply goes out as the message comes in (what is never sent is in auto.ts).
   */
  readonly holdBack: boolean;
}

/** Something the other person said that the person should know (one sentence, in Eya's words, never the chat itself). */
export interface StoredNote {
  readonly id: string;
  readonly at: number;
  readonly text: string;
}

export const MAX_NOTES = 20;
/** How many pictures and documents the session remembers what became of. */
export const MAX_MEDIA = 30;

export interface StoredSession {
  readonly version: 1;
  readonly id: string;
  readonly app: string;
  readonly chat: { readonly label: string; readonly verified: boolean; readonly ending?: string } | null;
  readonly mode: LiveChatMode;
  readonly state: LiveChatState;
  readonly pause: LiveChatPause | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly stoppedAt: number | null;
  readonly tracker: Tracker;
  readonly context: readonly LiveChatMessage[];
  readonly summary: string;
  readonly draft: StoredDraft | null;
  readonly sends: readonly SendRecord[];
  readonly replyCount: number;
  readonly auto: StoredAuto | null;
  readonly tone: string;
  /** Who the other person is to the person (friend, partner, family, senior, client, other): how Eya sounds. Null: not said, so she is natural and polite. */
  readonly relation: LiveRelation | null;
  /** What the person asked of this chat, in their words: it guides the replies (and is the person's own instruction, never the other side's). */
  readonly purpose: string;
  /** The person asked for Eya to write the first message, and whether that has been done (once, ever). */
  readonly openingWanted: boolean;
  readonly openingDone: boolean;
  /**
   * Automatic replies are to start by themselves once the chat is confirmed, and on whose word: `said` (the person said, in the request, that the other person knows) or
   * `switch` (the one "Enable live chat" switch, for as long as it stays on). Null: not asked for — the person is asked, or does it on the page. Not kept across a restart.
   */
  readonly autoBasis: 'said' | 'switch' | null;
  /** Eya has said who she is in this chat (her first message, or the first reply, carried it). */
  readonly introduced: boolean;
  /** What the other person wants Eya to pass on to the person: kept until the person clears it (or starts another live chat). */
  readonly forYou: readonly StoredNote[];
  /** Message id → what became of the picture or document it carried (saved in Downloads, read, or not). Only file names, never paths. */
  readonly media: Readonly<Record<string, MediaNote>>;
  readonly error: string | null;
  readonly notice: string | null;
}

export const DEFAULT_TONE = 'natural and brief, like a friendly message between acquaintances';

export function newSession(id: string, now: number, app = 'WhatsApp'): StoredSession {
  return {
    version: 1,
    id,
    app,
    chat: null,
    mode: 'draft',
    state: 'IDLE',
    pause: null,
    createdAt: now,
    startedAt: null,
    stoppedAt: null,
    tracker: EMPTY_TRACKER,
    context: [],
    summary: '',
    draft: null,
    sends: [],
    replyCount: 0,
    auto: null,
    tone: DEFAULT_TONE,
    relation: null,
    purpose: '',
    openingWanted: false,
    openingDone: false,
    autoBasis: null,
    introduced: false,
    forYou: [],
    media: {},
    error: null,
    notice: null,
  };
}

const DRAFT_STATUSES: readonly LiveDraftStatus[] = ['ready', 'edited', 'approved', 'in_box', 'sending', 'sent', 'uncertain', 'failed', 'discarded', 'stale'];
const SEND_STATUSES: readonly SendStatus[] = ['attempted', 'visibly_sent', 'delivered', 'read', 'uncertain', 'failed', 'not_seen'];
const PAUSES: readonly LiveChatPause[] = ['user', 'chat_switched', 'chat_closed', 'browser_lost', 'restart', 'extension_old', 'access_off', 'unreadable'];
const KINDS = ['text', 'deleted', 'sticker', 'audio', 'video', 'image', 'document', 'other'] as const;

const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function readMessage(raw: unknown): LiveChatMessage | null {
  const m = rec(raw);
  if (m === null) return null;
  const id = str(m['id'], 200);
  const kind = KINDS.find((k) => k === m['kind']);
  if (id === null || id === '' || (m['dir'] !== 'in' && m['dir'] !== 'out') || kind === undefined) return null;
  return { id, dir: m['dir'], kind, text: str(m['text'], 1200) ?? '', at: str(m['at'], 40) ?? '' };
}

function readDraft(raw: unknown): StoredDraft | null {
  const d = rec(raw);
  if (d === null) return null;
  const status = DRAFT_STATUSES.find((s) => s === d['status']);
  const id = str(d['id'], 80);
  const text = str(d['text'], 2000);
  const createdAt = num(d['createdAt']);
  if (status === undefined || id === null || text === null || createdAt === null) return null;
  const confidence = d['confidence'] === 'high' || d['confidence'] === 'medium' ? d['confidence'] : 'low';
  return {
    id,
    text,
    status,
    createdAt,
    by: d['by'] === 'you' ? 'you' : 'eya',
    confidence,
    commitment: d['commitment'] !== false,
    note: str(d['note'], 300),
    basedOn: Array.isArray(d['basedOn']) ? d['basedOn'].filter((x): x is string => typeof x === 'string').slice(0, 50) : [],
  };
}

function readSend(raw: unknown): SendRecord | null {
  const s = rec(raw);
  if (s === null) return null;
  const status = SEND_STATUSES.find((x) => x === s['status']);
  const id = str(s['id'], 80);
  const draftId = str(s['draftId'], 80);
  const triggerKey = str(s['triggerKey'], 400);
  const text = str(s['text'], 2000);
  const at = num(s['at']);
  if (status === undefined || id === null || draftId === null || triggerKey === null || text === null || at === null) return null;
  return { id, draftId, triggerKey, text, at, status, pressed: s['pressed'] === true, lastOutId: str(s['lastOutId'], 200), by: s['by'] === 'auto' ? 'auto' : 'user', evidence: str(s['evidence'], 200) };
}

/** What became of the pictures and documents, read back: only a known kind and status, a plain file name and a short summary are kept. */
function readMedia(raw: unknown): Record<string, MediaNote> {
  const out: Record<string, MediaNote> = {};
  for (const [id, value] of Object.entries(rec(raw) ?? {}).slice(-MAX_MEDIA)) {
    const m = rec(value);
    const kind = m?.['kind'] === 'image' || m?.['kind'] === 'document' ? m['kind'] : null;
    const status = m?.['status'] === 'read' || m?.['status'] === 'saved' || m?.['status'] === 'failed' || m?.['status'] === 'skipped' ? m['status'] : null;
    const name = str(m?.['name'], 120);
    if (m === null || kind === null || status === null || name === null || id === '' || id.length > 200) continue;
    out[id] = { kind, name: name.replace(/[\\/]/g, '_'), status, summary: str(m['summary'], 400) ?? '' };
  }
  return out;
}

/** What was saved, read back — exactly or not at all. Anything missing, of the wrong type or out of range is dropped, never guessed. */
export function parseSession(raw: unknown): StoredSession | null {
  const s = rec(raw);
  if (s === null || s['version'] !== 1) return null;
  const id = str(s['id'], 80);
  const state = LIVE_CHAT_STATES.find((x) => x === s['state']);
  const createdAt = num(s['createdAt']);
  if (id === null || state === undefined || createdAt === null) return null;
  const chat = rec(s['chat']);
  const label = chat === null ? null : str(chat['label'], 160);
  const tracker = rec(s['tracker']);
  const hashes: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec(tracker?.['hashes']) ?? {}).slice(-400)) if (typeof v === 'string') hashes[k.slice(0, 200)] = v.slice(0, 20);
  const auto = rec(s['auto']);
  const sends = (Array.isArray(s['sends']) ? s['sends'] : []).map(readSend).filter((x): x is SendRecord => x !== null).slice(-60);
  return {
    version: 1,
    id,
    app: str(s['app'], 40) ?? 'WhatsApp',
    chat: label === null || label === '' ? null : { label, verified: chat?.['verified'] === true, ...(typeof chat?.['ending'] === 'string' ? { ending: chat['ending'].slice(0, 6) } : {}) },
    mode: s['mode'] === 'assisted' || s['mode'] === 'auto' ? s['mode'] : 'draft',
    state,
    pause: PAUSES.find((p) => p === s['pause']) ?? null,
    createdAt,
    startedAt: num(s['startedAt']),
    stoppedAt: num(s['stoppedAt']),
    tracker: { handled: Array.isArray(tracker?.['handled']) ? (tracker['handled'] as unknown[]).filter((x): x is string => typeof x === 'string').slice(-300) : [], hashes },
    context: (Array.isArray(s['context']) ? s['context'] : []).map(readMessage).filter((x): x is LiveChatMessage => x !== null).slice(-30),
    summary: str(s['summary'], 400) ?? '',
    draft: readDraft(s['draft']),
    sends,
    replyCount: Math.max(0, Math.trunc(num(s['replyCount']) ?? 0)),
    auto:
      auto === null || num(auto['minGapMs']) === null
        ? null
        : { maxReplies: num(auto['maxReplies']), repliesSent: Math.max(0, Math.trunc(num(auto['repliesSent']) ?? 0)), minGapMs: num(auto['minGapMs']) as number, until: num(auto['until']), lastSentAt: num(auto['lastSentAt']), holdBack: auto['holdBack'] === true },
    tone: str(s['tone'], 200) ?? DEFAULT_TONE,
    relation: LIVE_RELATIONS.find((x) => x === s['relation']) ?? null,
    purpose: str(s['purpose'], 300) ?? '',
    openingWanted: s['openingWanted'] === true,
    openingDone: s['openingDone'] === true,
    autoBasis: s['autoBasis'] === 'said' || s['autoBasis'] === 'switch' ? s['autoBasis'] : null,
    introduced: s['introduced'] === true,
    forYou: (Array.isArray(s['forYou']) ? s['forYou'] : [])
      .flatMap((n): StoredNote[] => {
        const r = rec(n);
        const id = r === null ? null : str(r['id'], 80);
        const text = r === null ? null : str(r['text'], 240);
        const at = r === null ? null : num(r['at']);
        return id === null || id === '' || text === null || text === '' || at === null ? [] : [{ id, at, text }];
      })
      .slice(-MAX_NOTES),
    media: readMedia(s['media']),
    error: str(s['error'], 400),
    notice: str(s['notice'], 400),
  };
}

/**
 * After a restart: nothing is watched and nothing is sent until the person says so. A session that was running comes back PAUSED (its draft kept, a send that was
 * begun and not seen stays as it was, to be looked at before anything else), and automatic replies are off — they are for one run only.
 */
export function afterRestart(saved: StoredSession): StoredSession {
  if (isOver(saved.state)) return saved;
  return {
    ...saved,
    state: 'PAUSED',
    pause: 'restart',
    mode: saved.mode === 'auto' ? 'assisted' : saved.mode,
    auto: null,
    autoBasis: null,
    draft: saved.draft !== null && (saved.draft.status === 'sending' || saved.draft.status === 'in_box') ? { ...saved.draft, status: saved.draft.status === 'sending' ? 'uncertain' : saved.draft.status, note: saved.draft.status === 'sending' ? 'Eya closed while this was being sent: look at the chat before sending anything again.' : saved.draft.note } : saved.draft,
    notice: 'Eya was restarted, so the live chat is paused. Nothing has been sent. Resume it when you are ready.',
  };
}

/** What is kept once a session is over: that it happened, with the chat and the counts — not the words. */
export function scrub(s: StoredSession): StoredSession {
  return { ...s, tracker: EMPTY_TRACKER, context: [], summary: '', purpose: '', draft: null, sends: s.sends.map((x) => ({ ...x, text: '' })), media: {}, notice: null };
}
