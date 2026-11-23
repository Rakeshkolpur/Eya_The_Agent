import { rootLogger } from '@main/logging/logger';
import { realIo } from '@main/privacy/communicationAccessStore';
import type { StoreIo } from '@main/privacy/communicationAccessStore';
import type { PluginRecord, PluginState } from './types';

const log = rootLogger.child('plugins');

export const EMPTY_STATE: PluginState = { version: 1, plugins: {}, removed: [] };

/** Reads what was saved. Anything that is not exactly what was written — missing, corrupt, wrong types — is nothing, never a guess. */
export function parseState(raw: unknown): PluginState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY_STATE;
  const r = raw as { plugins?: unknown; removed?: unknown };
  const plugins: Record<string, PluginRecord> = {};
  if (typeof r.plugins === 'object' && r.plugins !== null && !Array.isArray(r.plugins)) {
    for (const [id, value] of Object.entries(r.plugins as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      if (typeof v['installedVersion'] !== 'string' || typeof v['enabled'] !== 'boolean') continue;
      const granted = Array.isArray(v['granted']) ? [...new Set(v['granted'].filter((g): g is string => typeof g === 'string' && g.length <= 60))].slice(0, 40) : [];
      plugins[id] = { installedVersion: v['installedVersion'], enabled: v['enabled'], granted };
    }
  }
  const removed = Array.isArray(r.removed) ? r.removed.filter((x): x is string => typeof x === 'string').slice(0, 40) : [];
  return { version: 1, plugins, removed };
}

/**
 * Where what the person did with their plugins is kept: one small file in Eya's data folder. It holds which plugin is installed, switched on, and which
 * permissions were granted — never an account, a token, a contact, a message or a file.
 */
export class PluginStateStore {
  constructor(
    private readonly path: string,
    private readonly io: StoreIo = realIo,
  ) {}

  /** The saved state, or null when there is no usable file (the first run, or a file that cannot be read). */
  load(): PluginState | null {
    const text = this.io.read(this.path);
    if (text === null) return null;
    try {
      return parseState(JSON.parse(text));
    } catch {
      log.warn('the plugins file is not valid; starting as if nothing was saved');
      return null;
    }
  }

  save(state: PluginState): void {
    try {
      this.io.write(this.path, JSON.stringify(state, null, 2));
    } catch (err) {
      log.warn('could not save the plugins; the change lasts until Eya is closed', { err: String(err) });
    }
  }
}
