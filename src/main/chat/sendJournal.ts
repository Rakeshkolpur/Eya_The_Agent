import { rootLogger } from '@main/logging/logger';
import { realIo } from '@main/privacy/communicationAccessStore';
import type { StoreIo } from '@main/privacy/communicationAccessStore';
import type { JournalRow, SendJournal } from './chatSession';

const log = rootLogger.child('sendjournal');

const STATUSES = ['attempted', 'sent', 'uncertain', 'failed'] as const;

/**
 * Remembers, across Eya closing, that a message or file was sent (or begun) to a chat — so that asking again after a restart finds it and LOOKS in the chat
 * before anything is sent, instead of sending a second time. It keeps no name and no words: only a short fingerprint of "this chat and this thing", when, and
 * how far it got. A fingerprint cannot be turned back into a message.
 */
export class FileSendJournal implements SendJournal {
  constructor(
    private readonly path: string,
    private readonly io: StoreIo = realIo,
  ) {}

  load(): readonly JournalRow[] {
    const text = this.io.read(this.path);
    if (text === null) return [];
    try {
      const raw = JSON.parse(text) as { sends?: unknown };
      const list = Array.isArray(raw.sends) ? raw.sends : [];
      return list.flatMap((r): JournalRow[] => {
        if (typeof r !== 'object' || r === null) return [];
        const x = r as Record<string, unknown>;
        const status = STATUSES.find((s) => s === x['status']);
        return typeof x['h'] === 'string' && /^[0-9a-f]{16}$/.test(x['h']) && status !== undefined && typeof x['at'] === 'number' && Number.isFinite(x['at']) ? [{ h: x['h'], status, at: x['at'] }] : [];
      });
    } catch {
      log.warn('the send journal is not valid; starting with none');
      return [];
    }
  }

  save(rows: readonly JournalRow[]): void {
    try {
      this.io.write(this.path, JSON.stringify({ version: 1, sends: rows }));
    } catch (err) {
      log.warn('could not save the send journal; it lasts until Eya is closed', { err: String(err) });
    }
  }
}
