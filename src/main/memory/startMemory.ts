import { join } from 'node:path';
import { rootLogger } from '@main/logging/logger';
import type { CommunicationPolicy } from '@main/privacy/communicationAccess';
import { MemoryService } from './MemoryService';
import type { MemoryEvent } from './MemoryService';
import type { ToolInvoker } from './skillExecutor';
import type { NewStep } from './types';

const log = rootLogger.child('memory');

/**
 * Where the memory database lives: Eya's own data folder (the per-user app-data folder, e.g. %APPDATA%\Eya\data\eya_memory.db) —
 * persistent, never a temp folder, and writable when Eya is installed under Program Files. EYA_MEMORY_DB overrides it (for tests).
 */
export function memoryDbPath(userDataDir: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = env['EYA_MEMORY_DB']?.trim();
  return override !== undefined && override !== '' ? override : join(userDataDir, 'data', 'eya_memory.db');
}

/** A step that opens or acts in a chat app is private: a routine is never learned from it, however often it is repeated. */
export function privateStepCheck(policy: Pick<CommunicationPolicy, 'appForUrl' | 'appForWindow'>): (step: NewStep) => boolean {
  return (step) => {
    if (step.action === 'open_url') return policy.appForUrl(step.target) !== null;
    if (step.action === 'open_app') {
      const name = step.target.trim();
      return policy.appForWindow({ process: name.toLowerCase().replace(/\.exe$/, ''), title: name }) !== null;
    }
    return false;
  };
}

export interface StartMemoryOptions {
  readonly dbPath: string;
  readonly tools: ToolInvoker;
  readonly policy: Pick<CommunicationPolicy, 'appForUrl' | 'appForWindow'>;
  readonly notify: (event: MemoryEvent) => void;
}

/**
 * Opens (creating and migrating if needed) the memory database. Memory is a convenience, never a requirement: if the file cannot be
 * opened (a newer version wrote it, the disk is read-only…) Eya says so in the log and carries on without it.
 */
export function startMemory(options: StartMemoryOptions): MemoryService | null {
  try {
    return MemoryService.open(options.dbPath, { tools: options.tools, isPrivateStep: privateStepCheck(options.policy), notify: options.notify });
  } catch (err) {
    log.error('memory is unavailable; Eya will run without it', { path: options.dbPath, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
