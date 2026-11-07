import { useCallback, useEffect, useRef, useState } from 'react';
import { titleFrom } from '../shared/chats';
import type { ChatSummary } from '../shared/chats';
import type { ChatsControl } from './control';
import { emptyThread, storedMessages, threadFromStored } from './thread';
import type { ThreadState } from './thread';

/** How long after the last change a conversation is written to disk (a live conversation changes many times a second). */
const SAVE_AFTER_MS = 700;

function newId(): string {
  return `chat_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The conversations Eya keeps: the list for the sidebar, starting a new one, opening an old one, renaming and deleting. The one on screen is
 * saved a moment after it changes (when keeping chats is on), under one id for as long as it is the same conversation; opening an old one
 * puts its messages back and gives the assistant the end of it, so a follow-up is understood.
 */
export function useChatHistory(args: {
  readonly thread: ThreadState;
  readonly setThread: (t: ThreadState) => void;
  /** Settings → Privacy: whether new conversations are kept. */
  readonly keep: boolean;
  /** Eya is answering: the conversation cannot be switched under her. */
  readonly busy: boolean;
}): ChatsControl {
  const { thread, setThread, keep, busy } = args;
  const [items, setItems] = useState<readonly ChatSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const idRef = useRef<string | null>(null);
  const createdRef = useRef(0);
  /** What was last saved or loaded, so putting an old conversation back does not save it again as if it had just been used. */
  const sigRef = useRef('');

  useEffect(() => {
    let alive = true;
    void window.eya.listChats().then((l) => alive && setItems(l)).catch(() => undefined);
    const off = window.eya.onChats((l) => setItems(l));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const messages = thread.messages;
  const last = messages[messages.length - 1];
  const signature = last === undefined ? '' : `${messages.length}:${last.id}:${last.text.length}`;
  useEffect(() => {
    if (!keep || messages.length === 0 || signature === sigRef.current) return undefined;
    const t = window.setTimeout(() => {
      if (idRef.current === null) {
        idRef.current = newId();
        createdRef.current = messages[0]?.at ?? Date.now();
        setCurrentId(idRef.current);
      }
      sigRef.current = signature;
      const first = messages.find((m) => m.role === 'user') ?? messages[0];
      void window.eya
        .saveChat({ id: idRef.current, title: titleFrom(first?.text ?? ''), createdAt: createdRef.current, updatedAt: Date.now(), messages: storedMessages(thread) })
        .catch(() => undefined);
    }, SAVE_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [keep, messages, signature, thread]);

  const newChat = useCallback(() => {
    if (busy) return;
    idRef.current = null;
    createdRef.current = 0;
    sigRef.current = '';
    setCurrentId(null);
    setThread(emptyThread);
    void window.eya.switchChat(null).catch(() => undefined);
  }, [busy, setThread]);

  const openChat = useCallback(
    (id: string) => {
      if (busy || id === idRef.current) return;
      void window.eya
        .getChat(id)
        .then((chat) => {
          if (chat === null) return;
          const next = threadFromStored(chat.messages);
          idRef.current = chat.id;
          createdRef.current = chat.createdAt;
          const tail = next.messages[next.messages.length - 1];
          sigRef.current = tail === undefined ? '' : `${next.messages.length}:${tail.id}:${tail.text.length}`;
          setCurrentId(chat.id);
          setThread(next);
          return window.eya.switchChat(chat);
        })
        .catch(() => undefined);
    },
    [busy, setThread],
  );

  const deleteChat = useCallback(
    (id: string) => {
      void window.eya
        .deleteChat(id)
        .then(() => {
          if (id === idRef.current && !busy) newChat();
        })
        .catch(() => undefined);
    },
    [busy, newChat],
  );

  const renameChat = useCallback((id: string, title: string) => {
    void window.eya.renameChat(id, title).catch(() => undefined);
  }, []);

  const clearChats = useCallback(() => {
    void window.eya
      .clearChats()
      .then(() => {
        if (!busy) newChat();
      })
      .catch(() => undefined);
  }, [busy, newChat]);

  return { items, currentId, busy, keeping: keep, newChat, openChat, deleteChat, renameChat, clearChats };
}
