import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { rootLogger } from '@main/logging/logger';

const log = rootLogger.child('memory');

export interface UserPreferences {
  preferredApplications?: Readonly<Record<string, string>>;
  preferredFolders?: Readonly<Record<string, string>>;
  shortcuts?: Readonly<Record<string, string>>;
}

/**
 * MemoryManager stores explicit user preferences and named shortcuts on disk.
 * Nothing is persisted implicitly; only when the user tells Eya to remember.
 */
export class MemoryManager {
  private prefs: UserPreferences = {};
  private path = '';

  async init(): Promise<void> {
    this.path = join(app.getPath('userData'), 'preferences.json');
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      this.prefs = JSON.parse(raw) as UserPreferences;
      log.info('preferences loaded', { path: this.path });
    } catch (err) {
      log.info('preferences not present yet', { path: this.path, err: String(err) });
      this.prefs = {};
    }
  }

  get(): UserPreferences {
    return this.prefs;
  }

  async update(patch: UserPreferences): Promise<void> {
    this.prefs = { ...this.prefs, ...patch };
    await fs.writeFile(this.path, JSON.stringify(this.prefs, null, 2), 'utf8');
  }
}
