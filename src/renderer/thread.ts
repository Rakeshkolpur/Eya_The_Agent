/**
 * The conversation as the Chat screen shows it: what was typed or said, and what Eya answered. Kept in memory for as long as the app is
 * open and never written anywhere (what is kept on disk is the short Recent history, not the words of a conversation).
 *
 * A live conversation reports "what you have said so far this turn" over and over as the words arrive, so those updates change one
 * message rather than adding a new one each time.
 */
export interface ChatMessage {
  readonly id: number;
  readonly role: 'user' | 'eya';
  readonly text: string;
  readonly at: number;
  readonly via: 'typed' | 'voice' | 'live';
}

export interface ThreadState {
  readonly messages: readonly ChatMessage[];
  readonly nextId: number;
  /** The live exchange in progress: the user's message and Eya's answer to it, once they exist. */
  readonly liveUser: number | null;
  readonly liveEya: number | null;
}

export const MAX_MESSAGES = 100;
export const emptyThread: ThreadState = { messages: [], nextId: 1, liveUser: null, liveEya: null };

function push(t: ThreadState, role: ChatMessage['role'], text: string, via: ChatMessage['via'], at: number): { thread: ThreadState; id: number } {
  const id = t.nextId;
  const messages = [...t.messages, { id, role, text, at, via }].slice(-MAX_MESSAGES);
  return { thread: { ...t, messages, nextId: id + 1 }, id };
}

function setText(t: ThreadState, id: number, text: string): ThreadState {
  return { ...t, messages: t.messages.map((m) => (m.id === id ? { ...m, text } : m)) };
}

export function addMessage(t: ThreadState, role: ChatMessage['role'], text: string, via: ChatMessage['via'], at: number = Date.now()): ThreadState {
  const clean = text.trim();
  return clean === '' ? t : push(t, role, clean, via, at).thread;
}

/** What the user has said so far this turn (the whole turn, every time). */
export function liveHeard(t: ThreadState, text: string, at: number = Date.now()): ThreadState {
  const clean = text.trim();
  if (clean === '') return t;
  // Eya has already answered the last turn, so these words are a new one.
  const base = t.liveEya !== null ? { ...t, liveUser: null, liveEya: null } : t;
  if (base.liveUser !== null) return setText(base, base.liveUser, clean);
  const { thread, id } = push(base, 'user', clean, 'live', at);
  return { ...thread, liveUser: id };
}

/** What Eya has said so far this turn. */
export function liveSaid(t: ThreadState, text: string, at: number = Date.now()): ThreadState {
  const clean = text.trim();
  if (clean === '') return t;
  if (t.liveEya !== null) return setText(t, t.liveEya, clean);
  const { thread, id } = push(t, 'eya', clean, 'live', at);
  return { ...thread, liveEya: id };
}

export function liveEnded(t: ThreadState): ThreadState {
  return { ...t, liveUser: null, liveEya: null };
}
