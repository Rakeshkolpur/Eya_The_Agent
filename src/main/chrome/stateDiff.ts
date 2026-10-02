import type { PageChanges } from '@main/browser/pageEffects';
import type { PageState } from './pageState';

const MAX_LISTED = 8;

const label = (e: { role: string; name: string }) => `${e.role}: ${e.name}`;
const normalizeText = (s: string) => s.replace(/\s+/g, ' ').trim();

/** What changed between two looks at the page — only things both looks actually reported. */
export function diffStates(before: PageState, after: PageState): PageChanges {
  const key = (e: { role: string; name: string }) => `${e.role}|${e.name.toLowerCase()}`;
  const beforeKeys = new Set(before.elements.map(key));
  const afterKeys = new Set(after.elements.map(key));
  const appeared = after.elements.filter((e) => e.name !== '' && !beforeKeys.has(key(e)));
  const disappeared = before.elements.filter((e) => e.name !== '' && !afterKeys.has(key(e)));

  const newDialog = after.dialogs.find((d) => !before.dialogs.includes(d));
  return {
    navigated: before.url !== after.url,
    ...(before.url !== after.url ? { urlChanged: { from: before.url, to: after.url } } : {}),
    titleChanged: before.title !== after.title,
    appeared: appeared.slice(0, MAX_LISTED).map(label),
    appearedCount: appeared.length,
    disappeared: disappeared.slice(0, MAX_LISTED).map(label),
    disappearedCount: disappeared.length,
    ...(newDialog !== undefined ? { dialogOpened: newDialog.slice(0, 200) } : {}),
    dialogClosed: before.dialogs.some((d) => !after.dialogs.includes(d)),
    textChanged: normalizeText(before.visibleText) !== normalizeText(after.visibleText),
  };
}

/** True when anything the model could see differs — the signal that an action did something. */
export function anyChange(changes: PageChanges): boolean {
  return (
    changes.navigated ||
    changes.titleChanged ||
    changes.appearedCount > 0 ||
    changes.disappearedCount > 0 ||
    changes.dialogOpened !== undefined ||
    changes.dialogClosed ||
    changes.textChanged
  );
}
