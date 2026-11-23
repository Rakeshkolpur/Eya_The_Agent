import { randomUUID } from 'node:crypto';
import { realIo } from '@main/privacy/communicationAccessStore';
import type { StoreIo } from '@main/privacy/communicationAccessStore';
import { rootLogger } from '@main/logging/logger';
import type { OwnerNoteView } from '@shared/liveChat';

const log = rootLogger.child('livechat');

/** How many notes are kept (the oldest finished ones go first). */
export const MAX_SAVED_NOTES = 200;

/**
 * The notes Eya takes down for the person while she chats for them: what someone in a live chat asked her to pass on, or a file they sent. Unlike the short list inside one live
 * chat, these are kept in one file on this PC until the person clears them — they stay after the live chat ends and after Eya is restarted, from every live chat together, each
 * with who it was from (a phone number only by its last four digits) and when. It is the person's own file: nothing in it is ever sent anywhere.
 */
export class OwnerNotes {
  private notes: OwnerNoteView[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly path: string,
    private readonly io: StoreIo = realIo,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {
    try {
      const text = io.read(path);
      if (text !== null) {
        const raw = JSON.parse(text) as unknown;
        if (Array.isArray(raw)) {
          for (const n of raw) {
            const o = n as Record<string, unknown>;
            if (typeof o['id'] === 'string' && typeof o['at'] === 'number' && typeof o['from'] === 'string' && typeof o['text'] === 'string') {
              this.notes.push({ id: o['id'], at: o['at'], from: o['from'].slice(0, 80), text: o['text'].slice(0, 400), kind: o['kind'] === 'file' ? 'file' : 'said', done: o['done'] === true });
            }
          }
          this.notes = this.notes.slice(-MAX_SAVED_NOTES);
        }
      }
    } catch {
      log.warn('the saved notes file is not valid; starting without it');
    }
  }

  /** Newest last. */
  list(): readonly OwnerNoteView[] {
    return this.notes;
  }

  /** Notes not marked done. */
  open(): readonly OwnerNoteView[] {
    return this.notes.filter((n) => !n.done);
  }

  add(note: { readonly from: string; readonly text: string; readonly kind?: 'said' | 'file' }): OwnerNoteView | null {
    const text = note.text.replace(/\s+/g, ' ').trim().slice(0, 400);
    if (text === '') return null;
    const saved: OwnerNoteView = { id: this.newId(), at: this.now(), from: note.from.replace(/\s+/g, ' ').trim().slice(0, 80), text, kind: note.kind ?? 'said', done: false };
    this.notes = [...this.notes, saved];
    if (this.notes.length > MAX_SAVED_NOTES) {
      // (finished ones are let go first)
      const drop = this.notes.length - MAX_SAVED_NOTES;
      const finished = this.notes.filter((n) => n.done).slice(0, drop);
      this.notes = this.notes.filter((n) => !finished.includes(n));
      if (this.notes.length > MAX_SAVED_NOTES) this.notes = this.notes.slice(-MAX_SAVED_NOTES);
    }
    this.changed();
    return saved;
  }

  done(id: string, value = true): boolean {
    const found = this.notes.find((n) => n.id === id);
    if (found === undefined) return false;
    this.notes = this.notes.map((n) => (n.id === id ? { ...n, done: value } : n));
    this.changed();
    return true;
  }

  remove(id: string): boolean {
    const before = this.notes.length;
    this.notes = this.notes.filter((n) => n.id !== id);
    if (this.notes.length === before) return false;
    this.changed();
    return true;
  }

  /** Finished notes only, or all of them. Returns how many went. */
  clear(which: 'done' | 'all' = 'all'): number {
    const before = this.notes.length;
    this.notes = which === 'all' ? [] : this.notes.filter((n) => !n.done);
    const gone = before - this.notes.length;
    if (gone > 0) this.changed();
    return gone;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    try {
      this.io.write(this.path, JSON.stringify(this.notes));
    } catch (err) {
      log.warn('could not save the notes', { err: String(err) });
    }
    for (const l of [...this.listeners]) l();
  }
}
