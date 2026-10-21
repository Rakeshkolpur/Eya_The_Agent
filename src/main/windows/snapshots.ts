import type { ActivitySnapshot, AppSettings } from '@shared/ipcContract';
import type { ActivityStore } from '@main/memory/ActivityStore';
import { PERFORMANCE_SETTINGS } from '@shared/performance';

/** The Recent screen's data. With no database there is simply nothing to show. */
export function activitySnapshot(store: ActivityStore | null, keep: boolean): ActivitySnapshot {
  if (store === null) return { enabled: keep, items: [], sites: [] };
  return {
    enabled: keep,
    items: store.list(100).map((a) => ({ id: a.id, at: a.at, kind: a.kind, title: a.title, detail: a.detail, ok: a.ok, canRepeat: a.request !== '', request: a.request })),
    sites: store.sites(6),
  };
}

/** Only real booleans (and a known performance level) get through from the page: anything else in a settings change is ignored. */
export function cleanSettingsPatch(raw: unknown): { patch: Partial<AppSettings>; startWithWindows?: boolean } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { patch: {} };
  const r = raw as Record<string, unknown>;
  const patch: { -readonly [K in keyof AppSettings]?: AppSettings[K] } = {};
  for (const key of ['showBubble', 'tapToTalk', 'keepHistory'] as const) if (typeof r[key] === 'boolean') patch[key] = r[key] as boolean;
  if (typeof r['performance'] === 'string' && (PERFORMANCE_SETTINGS as readonly string[]).includes(r['performance'])) patch.performance = r['performance'] as AppSettings['performance'];
  if (r['aiFirst'] === 'auto' || r['aiFirst'] === 'backup') patch.aiFirst = r['aiFirst'];
  return { patch, ...(typeof r['startWithWindows'] === 'boolean' ? { startWithWindows: r['startWithWindows'] } : {}) };
}
