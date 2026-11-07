import { rootLogger } from '@main/logging/logger';
import { realIo } from '@main/privacy/communicationAccessStore';
import type { StoreIo } from '@main/privacy/communicationAccessStore';
import { MAX_CHATS, cleanChat, cleanTitle, summarize } from '@shared/chats';
import type { ChatSummary, StoredChat } from '@shared/chats';
import { CoalescedWriter } from '@main/storage/CoalescedWriter';

const log = rootLogger.child('chats');

/**
 * The conversations the person has had with Eya, kept on this PC so they can be opened again and carried on (the list in the sidebar). One file
 * in Eya's data folder, written whole each time (never half-written). It holds what was typed and said and what Eya answered, plus the names of
 * attached files, never the files. The person can delete one, delete all, or switch keeping them off (Settings → Privacy).
 */
export class ChatStore {
  private chats = new Map<string, StoredChat>();
  private loaded = false;
  private readonly listeners = new Set<() => void>();
  private readonly writer: CoalescedWriter;

  /** `coalesceMs`: a burst of changes (a message added, its answer, the title) is written once, that long after the last; 0 writes every change at once. */
  constructor(
    private readonly path: string,
    private readonly io: StoreIo = realIo,
    coalesceMs = 0,
  ) {
    this.writer = new CoalescedWriter(coalesceMs);
  }

  /** Writes what is waiting to be written (the app is closing). */
  flush(): void {
    this.writer.flush();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const text = this.io.read(this.path);
    if (text === null) return;
    try {
      const raw: unknown = JSON.parse(text);
      const list = typeof raw === 'object' && raw !== null && Array.isArray((raw as { chats?: unknown }).chats) ? (raw as { chats: unknown[] }).chats : [];
      for (const item of list) {
        const chat = cleanChat(item);
        if (chat !== null) this.chats.set(chat.id, chat);
      }
    } catch {
      log.warn('the chat history file is not valid; starting with none');
    }
  }

  private save(): void {
    // (the text is made when it is written, so a burst of changes is turned into text once)
    this.writer.schedule(() => {
      try {
        this.io.write(this.path, JSON.stringify({ chats: [...this.chats.values()] }));
      } catch (err) {
        log.warn('could not save the chat history; it lasts until Eya is closed', { err: String(err) });
      }
    });
    for (const l of this.listeners) l();
  }

  /** Newest first. */
  list(): ChatSummary[] {
    this.load();
    return [...this.chats.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(summarize);
  }

  get(id: string): StoredChat | null {
    this.load();
    return this.chats.get(id) ?? null;
  }

  /**
   * Adds a conversation or replaces its messages. The title and the day it began stay as they were first stored, so a name the person gave it
   * (see rename) is not overwritten each time the page saves the same chat again.
   */
  upsert(raw: unknown): ChatSummary | null {
    this.load();
    const chat = cleanChat(raw);
    if (chat === null) return null;
    const before = this.chats.get(chat.id);
    const stored: StoredChat = before === undefined ? chat : { ...chat, title: before.title, createdAt: before.createdAt };
    this.chats.set(stored.id, stored);
    this.trim();
    this.save();
    return summarize(stored);
  }

  rename(id: string, title: unknown): boolean {
    this.load();
    const chat = this.chats.get(id);
    if (chat === undefined) return false;
    this.chats.set(id, { ...chat, title: cleanTitle(title) });
    this.save();
    return true;
  }

  delete(id: string): boolean {
    this.load();
    const gone = this.chats.delete(id);
    if (gone) this.save();
    return gone;
  }

  clear(): number {
    this.load();
    const n = this.chats.size;
    this.chats.clear();
    this.save();
    return n;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The oldest go first when there are more than the list is meant to hold. */
  private trim(): void {
    if (this.chats.size <= MAX_CHATS) return;
    const oldest = [...this.chats.values()].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, this.chats.size - MAX_CHATS);
    for (const c of oldest) this.chats.delete(c.id);
  }
}
