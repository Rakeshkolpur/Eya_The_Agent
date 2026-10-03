import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { rootLogger } from '@main/logging/logger';
import { COMMUNICATION_APPS, COMMUNICATION_OFF, parseSettings } from './communicationAccess';
import type { CommunicationSettings } from './communicationAccess';

const log = rootLogger.child('privacy');

export interface StoreIo {
  /** The file's text, or null if it does not exist or cannot be read. */
  read(path: string): string | null;
  write(path: string, text: string): void;
}

const realIo: StoreIo = {
  read: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  write: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path); // never leaves a half-written settings file
  },
};

/**
 * Where the Communication Access choice lives: one small file in Eya's data folder. It holds only the switch and the
 * per-app choices — never a message, a contact or anything from a chat. Missing, unreadable or corrupt means OFF.
 */
export class CommunicationAccessStore {
  private settings: CommunicationSettings = COMMUNICATION_OFF;
  private readonly listeners = new Set<(s: CommunicationSettings) => void>();

  constructor(
    private readonly path: string,
    private readonly io: StoreIo = realIo,
    private readonly knownIds: readonly string[] = COMMUNICATION_APPS.map((a) => a.id),
  ) {}

  load(): CommunicationSettings {
    const text = this.io.read(this.path);
    if (text === null) {
      this.settings = COMMUNICATION_OFF;
      return this.settings;
    }
    try {
      this.settings = parseSettings(JSON.parse(text), this.knownIds);
    } catch {
      log.warn('communication access file is not valid; treating it as OFF');
      this.settings = COMMUNICATION_OFF;
    }
    return this.settings;
  }

  get(): CommunicationSettings {
    return this.settings;
  }

  /** Saves and applies a new choice. If it cannot be saved it is NOT applied (the user is told by the caller). */
  set(next: CommunicationSettings): CommunicationSettings {
    const clean = parseSettings(next, this.knownIds);
    this.io.write(this.path, JSON.stringify(clean, null, 2));
    this.settings = clean;
    log.info('communication access changed', { enabled: clean.enabled, apps: Object.keys(clean.apps).length });
    for (const listener of this.listeners) listener(clean);
    return clean;
  }

  onChange(listener: (s: CommunicationSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
