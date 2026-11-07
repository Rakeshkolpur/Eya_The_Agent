import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import { cleanChat, isChatId } from '@shared/chats';
import type { ChatSummary, StoredChat, StoredMessage } from '@shared/chats';
import type { ConversationContext, Turn } from '@main/context/ConversationContext';
import type { ChatStore } from './ChatStore';

/** How many of the latest exchanges of an opened conversation are given back to the assistant so a follow-up is understood. */
export const SEED_TURNS = 8;

/** The exchanges (what was asked, what Eya answered) of a kept conversation, as the assistant's short memory of the conversation takes them. */
export function turnsFrom(messages: readonly StoredMessage[]): Turn[] {
  const turns: Turn[] = [];
  let pending: StoredMessage | null = null;
  for (const m of messages) {
    if (m.role === 'user') {
      if (pending !== null) turns.push({ at: pending.at, userText: pending.text, ok: true, refs: [] });
      pending = m;
    } else if (pending !== null) {
      turns.push({ at: pending.at, userText: pending.text, reply: m.text, ok: true, refs: [] });
      pending = null;
    }
  }
  if (pending !== null) turns.push({ at: pending.at, userText: pending.text, ok: true, refs: [] });
  return turns.slice(-SEED_TURNS);
}

/** New chat (no messages) clears what the assistant remembers of the talk so far; opening an old one gives it the end of that conversation. */
export function switchContext(context: ConversationContext, chat: StoredChat | null): void {
  context.clear();
  if (chat === null) return;
  for (const t of turnsFrom(chat.messages)) context.push(t);
}

export interface ChatsIpcDeps {
  readonly store: ChatStore;
  readonly context: ConversationContext;
  /** Whether new conversations are kept (Settings → Privacy). When off nothing more is saved; the ones already kept stay listed until they are deleted. */
  readonly enabled: () => boolean;
  readonly send: (channel: string, payload: unknown) => void;
}

export function registerChatsIpc(deps: ChatsIpcDeps): { readonly list: () => ChatSummary[] } {
  const list = (): ChatSummary[] => deps.store.list();
  deps.store.onChange(() => deps.send(IpcChannels.chatsChanged, list()));
  ipcMain.handle(IpcChannels.chatsList, () => list());
  ipcMain.handle(IpcChannels.chatsGet, (_e, id: unknown): StoredChat | null => (isChatId(id) ? deps.store.get(id) : null));
  ipcMain.handle(IpcChannels.chatsSave, (_e, raw: unknown): ChatSummary | null => (deps.enabled() ? deps.store.upsert(raw) : null));
  ipcMain.handle(IpcChannels.chatsRename, (_e, id: unknown, title: unknown): boolean => isChatId(id) && deps.store.rename(id, title));
  ipcMain.handle(IpcChannels.chatsDelete, (_e, id: unknown): boolean => isChatId(id) && deps.store.delete(id));
  ipcMain.handle(IpcChannels.chatsClear, (): number => deps.store.clear());
  // The window starts a new conversation (null) or opens a kept one: either way the assistant's own short memory follows.
  ipcMain.handle(IpcChannels.chatsSwitch, (_e, raw: unknown): void => switchContext(deps.context, raw === null ? null : cleanChat(raw)));
  return { list };
}
