import { cleanAttachmentChips } from './attachments';
import type { AttachmentChip } from './attachments';

/** One message of a kept conversation: what was typed or said, or what Eya answered. */
export interface StoredMessage {
  readonly id: number;
  readonly role: 'user' | 'eya';
  readonly text: string;
  readonly at: number;
  readonly via: 'typed' | 'voice' | 'live';
  /** The files that went with the message (names, kinds and sizes only; never their contents). */
  readonly attachments?: readonly AttachmentChip[];
}

/** A kept conversation, as the chat history stores it. */
export interface StoredChat {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messages: readonly StoredMessage[];
}

/** What the list in the sidebar shows for a conversation. */
export interface ChatSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly messages: number;
}

export const MAX_CHATS = 200;
export const MAX_CHAT_MESSAGES = 200;
export const MAX_MESSAGE_CHARS = 20_000;
export const MAX_TITLE_CHARS = 60;

/** A title from the first thing said: one line, no longer than the list can show. */
export function titleFrom(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one === '') return 'New chat';
  return one.length > MAX_TITLE_CHARS ? `${one.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : one;
}

export function cleanTitle(raw: unknown): string {
  return typeof raw === 'string' ? titleFrom(raw) : 'New chat';
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isChatId(raw: unknown): raw is string {
  return typeof raw === 'string' && ID_PATTERN.test(raw);
}

function cleanMessage(raw: unknown): StoredMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['role'] !== 'user' && r['role'] !== 'eya') return null;
  if (typeof r['text'] !== 'string' || r['text'].trim() === '') return null;
  const id = typeof r['id'] === 'number' && Number.isFinite(r['id']) ? Math.trunc(r['id']) : 0;
  const at = typeof r['at'] === 'number' && Number.isFinite(r['at']) ? r['at'] : 0;
  const via = r['via'] === 'voice' || r['via'] === 'live' ? r['via'] : 'typed';
  const attachments = cleanAttachmentChips(r['attachments']);
  return {
    id,
    role: r['role'],
    text: r['text'].slice(0, MAX_MESSAGE_CHARS),
    at,
    via,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

/** A conversation from the page or from the file, made safe: unknown things dropped, lengths capped, nothing trusted. Null when it is not one. */
export function cleanChat(raw: unknown): StoredChat | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isChatId(r['id']) || !Array.isArray(r['messages'])) return null;
  const messages = r['messages']
    .map(cleanMessage)
    .filter((m): m is StoredMessage => m !== null)
    .slice(-MAX_CHAT_MESSAGES);
  if (messages.length === 0) return null;
  const first = messages.find((m) => m.role === 'user') ?? messages[0];
  const createdAt = typeof r['createdAt'] === 'number' && Number.isFinite(r['createdAt']) ? r['createdAt'] : (messages[0]?.at ?? 0);
  const updatedAt = typeof r['updatedAt'] === 'number' && Number.isFinite(r['updatedAt']) ? r['updatedAt'] : (messages[messages.length - 1]?.at ?? createdAt);
  const title = typeof r['title'] === 'string' && r['title'].trim() !== '' ? titleFrom(r['title']) : titleFrom(first?.text ?? '');
  return { id: r['id'], title, createdAt, updatedAt, messages };
}

export function summarize(chat: StoredChat): ChatSummary {
  return { id: chat.id, title: chat.title, updatedAt: chat.updatedAt, messages: chat.messages.length };
}
