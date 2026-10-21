import { rootLogger } from '@main/logging/logger';
import { realIo } from '@main/privacy/communicationAccessStore';
import type { StoreIo } from '@main/privacy/communicationAccessStore';
import type { AppSettings } from '@shared/ipcContract';
import { parsePerformanceSetting } from '@shared/performance';
import type { Point } from '@main/windows/geometry';

const log = rootLogger.child('settings');

export const DEFAULT_APP_SETTINGS: AppSettings = { showBubble: true, tapToTalk: true, keepHistory: true, performance: 'auto', aiFirst: 'auto' };

/** Reads saved settings. Anything that is missing, the wrong type or not an object falls back to its default. */
export function parseAppSettings(raw: unknown): AppSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_APP_SETTINGS;
  const r = raw as Record<string, unknown>;
  const flag = (key: 'showBubble' | 'tapToTalk' | 'keepHistory'): boolean => (typeof r[key] === 'boolean' ? (r[key] as boolean) : DEFAULT_APP_SETTINGS[key]);
  return {
    showBubble: flag('showBubble'),
    tapToTalk: flag('tapToTalk'),
    keepHistory: flag('keepHistory'),
    performance: parsePerformanceSetting(r['performance']),
    aiFirst: r['aiFirst'] === 'backup' ? 'backup' : 'auto',
  };
}

/**
 * Eya's few app settings (is the bubble shown, does a click on it start a conversation, is a history of what she did kept): one small
 * file in her data folder. Not memory — nothing the user said or did is in it.
 */
export class AppSettingsStore {
  private settings: AppSettings = DEFAULT_APP_SETTINGS;
  private readonly listeners = new Set<(s: AppSettings) => void>();

  constructor(
    private readonly path: string,
    private readonly io: StoreIo = realIo,
  ) {}

  load(): AppSettings {
    const text = this.io.read(this.path);
    if (text === null) return (this.settings = DEFAULT_APP_SETTINGS);
    try {
      this.settings = parseAppSettings(JSON.parse(text));
    } catch {
      log.warn('settings file is not valid; using the defaults');
      this.settings = DEFAULT_APP_SETTINGS;
    }
    return this.settings;
  }

  get(): AppSettings {
    return this.settings;
  }

  /** Applies a change and saves it. If it cannot be saved it is still applied for this run (and logged). */
  update(patch: Partial<AppSettings>): AppSettings {
    const next = parseAppSettings({ ...this.settings, ...patch });
    this.settings = next;
    try {
      this.io.write(this.path, JSON.stringify(next, null, 2));
    } catch (err) {
      log.warn('could not save settings; the change lasts until Eya is closed', { err: String(err) });
    }
    for (const listener of this.listeners) listener(next);
    return next;
  }

  onChange(listener: (s: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Where the bubble was last left (its top-left corner on the desktop), so it is there again next time. */
export class WindowStateStore {
  private bubble: Point | null = null;

  constructor(
    private readonly path: string,
    private readonly io: StoreIo = realIo,
  ) {}

  load(): Point | null {
    const text = this.io.read(this.path);
    if (text === null) return (this.bubble = null);
    try {
      const raw = JSON.parse(text) as { bubble?: { x?: unknown; y?: unknown } };
      const { x, y } = raw.bubble ?? {};
      this.bubble = typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : null;
    } catch {
      this.bubble = null;
    }
    return this.bubble;
  }

  get(): Point | null {
    return this.bubble;
  }

  saveBubble(at: Point): void {
    this.bubble = { x: Math.round(at.x), y: Math.round(at.y) };
    try {
      this.io.write(this.path, JSON.stringify({ bubble: this.bubble }, null, 2));
    } catch (err) {
      log.warn('could not remember where the bubble is', { err: String(err) });
    }
  }
}
