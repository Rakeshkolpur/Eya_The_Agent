import { createHash } from 'node:crypto';
import { realIo } from '@main/privacy/communicationAccessStore';
import type { StoreIo } from '@main/privacy/communicationAccessStore';
import { rootLogger } from '@main/logging/logger';
import { LIVE_RELATIONS } from '@shared/liveChat';
import type { LiveRelation } from '@shared/liveChat';

const log = rootLogger.child('livechat');

/**
 * Who each person is to the person Eya writes for (friend, partner, family, senior, client, other), so that she is asked once and not at every live chat. It is kept on this PC in
 * one small file; what is stored is a hash of the name or the number, never the name or the number itself, and never a message.
 */
export class RelationBook {
  private readonly map = new Map<string, LiveRelation>();

  constructor(
    private readonly path: string,
    private readonly io: StoreIo = realIo,
  ) {
    try {
      const text = io.read(path);
      if (text !== null) {
        const raw = JSON.parse(text) as Record<string, unknown>;
        for (const [k, v] of Object.entries(raw)) {
          const rel = LIVE_RELATIONS.find((r) => r === v);
          if (/^[0-9a-f]{16}$/.test(k) && rel !== undefined) this.map.set(k, rel);
        }
      }
    } catch {
      log.warn('the live chat relation file is not valid; starting without it');
    }
  }

  /** The key for a person: the digits of a phone number (so "+91 98765 08501" and "9876508501" are one person), else the lower-case name. */
  static key(name: string): string {
    const digits = name.replace(/\D/g, '');
    const plain = digits.length >= 7 ? digits.slice(-10) : name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return createHash('sha256').update(plain).digest('hex').slice(0, 16);
  }

  get(name: string): LiveRelation | null {
    return this.map.get(RelationBook.key(name)) ?? null;
  }

  set(name: string, relation: LiveRelation): void {
    this.map.set(RelationBook.key(name), relation);
    try {
      this.io.write(this.path, JSON.stringify(Object.fromEntries(this.map)));
    } catch (err) {
      log.warn('could not save the live chat relations', { err: String(err) });
    }
  }

  forget(): void {
    this.map.clear();
    try {
      this.io.write(this.path, JSON.stringify({}));
    } catch {
      // nothing more to do
    }
  }
}
