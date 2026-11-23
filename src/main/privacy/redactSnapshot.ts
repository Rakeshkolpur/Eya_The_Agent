import type { PageSnapshot } from '@main/browser/pageSnapshot';

/**
 * What Eya is given instead of a chat page while Communication Access is off: the app's name and that it is there — no
 * chat list, no contact names, no message text, no buttons, no fields. Not even the address beyond its origin.
 */
export function communicationBlockedSnapshot(snapshot: PageSnapshot, appName: string): PageSnapshot {
  let origin = '';
  try {
    origin = new URL(snapshot.url).origin;
  } catch {
    // no usable address
  }
  return {
    url: origin,
    title: appName,
    headings: [],
    links: [],
    buttons: [],
    inputs: [],
    dialogs: [],
    truncated: false,
    ...(snapshot.environment !== undefined ? { environment: snapshot.environment } : {}),
    notes: [`${appName} is a chat app and Communication Access is off, so Eya is on it (or opened it) but did not look at anything in it.`],
  };
}
