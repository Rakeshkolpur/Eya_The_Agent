import { rootLogger } from '@main/logging/logger';
import { realIo } from '@main/privacy/communicationAccessStore';
import type { StoreIo } from '@main/privacy/communicationAccessStore';
import { parseSession } from './session';
import type { StoredSession } from './session';

const log = rootLogger.child('livechat');

/**
 * Where the live chat session is kept: one small file in Eya's data folder (`live-chat.json`). It holds the one session — which chat, how far it got, the last
 * messages it needs to follow the conversation, a draft that was waiting, and a record of each send BEFORE it was made. It is written whole each time, so what is
 * read back is a state that really existed. It is removed when the person asks Eya to forget it, and its words are removed when the session ends (see `scrub`).
 */
export class LiveChatStore {
  constructor(
    private readonly path: string,
    private readonly io: StoreIo = realIo,
    private readonly now: () => number = Date.now,
  ) {}

  /** The saved session, or null when there is none or the file cannot be read (a damaged file is the same as no file, never a guess). */
  load(): StoredSession | null {
    const text = this.io.read(this.path);
    if (text === null) return null;
    try {
      return parseSession(JSON.parse(text));
    } catch {
      log.warn('the live chat file is not valid; starting as if nothing was saved');
      return null;
    }
  }

  /**
   * When the session was last written (milliseconds). Null when the file has no such time (written before it was kept) or cannot be read. A session that was last written a
   * long time ago is not brought back: it was "running" for 15 hours with nobody there.
   */
  savedAt(): number | null {
    const text = this.io.read(this.path);
    if (text === null) return null;
    try {
      const at = (JSON.parse(text) as { savedAt?: unknown }).savedAt;
      return typeof at === 'number' && Number.isFinite(at) ? at : null;
    } catch {
      return null;
    }
  }

  save(session: StoredSession): void {
    try {
      this.io.write(this.path, JSON.stringify({ ...session, savedAt: this.now() }));
    } catch (err) {
      // (a send record that cannot be written is found out by the caller, which asks `save` to throw: see LiveChatController.record)
      log.warn('could not save the live chat', { err: String(err) });
      throw err;
    }
  }

  clear(): void {
    try {
      this.io.write(this.path, JSON.stringify({ version: 0 }));
    } catch {
      // nothing more to do
    }
  }
}
