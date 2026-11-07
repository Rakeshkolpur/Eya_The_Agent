import type { ActivitySnapshot, AppSettings } from '@shared/ipcContract';
import { isEyaLanguage } from '@shared/language';
import { isModelName } from '@shared/localAi';
import type { ActivityStore } from '@main/memory/ActivityStore';
import { countryContext } from '@main/chat/phoneNumbers';
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
  for (const key of ['showBubble', 'tapToTalk', 'keepHistory', 'keepChats', 'autoScreenLook', 'multiLiveChats'] as const) if (typeof r[key] === 'boolean') patch[key] = r[key] as boolean;
  if (typeof r['performance'] === 'string' && (PERFORMANCE_SETTINGS as readonly string[]).includes(r['performance'])) patch.performance = r['performance'] as AppSettings['performance'];
  if (r['aiFirst'] === 'auto' || r['aiFirst'] === 'backup' || r['aiFirst'] === 'local' || r['aiFirst'] === 'local-only') patch.aiFirst = r['aiFirst'];
  if (isModelName(r['localModel'])) patch.localModel = r['localModel'];
  if (isEyaLanguage(r['language'])) patch.language = r['language'];
  if (r['browser'] === 'eya' || r['browser'] === 'mine') patch.browser = r['browser'];
  // (a country the page names must be one a phone number can be read for; anything else is ignored, not guessed)
  if (typeof r['country'] === 'string' && /^[A-Za-z]{2}$/.test(r['country']) && countryContext(r['country']).region === r['country'].toUpperCase()) patch.country = r['country'].toUpperCase();
  return { patch, ...(typeof r['startWithWindows'] === 'boolean' ? { startWithWindows: r['startWithWindows'] } : {}) };
}
