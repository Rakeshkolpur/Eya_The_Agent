/**
 * Communication Access, enforced inside the browser as well as in Eya.
 *
 * The user decides, in Eya's panel, whether Eya may look at or act in chat apps and sites (WhatsApp, Telegram,
 * Instagram…). Eya tells this extension which of them are NOT allowed; here, a tab on one of those is never read, clicked
 * in, typed into or photographed, and its title (which can be a contact's name) is never reported. The extension cannot
 * be given less access than it already has (a browser lets it read every site or none), so this is the extension
 * declining to use it — and it starts out declining for every chat app until Eya says otherwise (fail closed).
 *
 * The list below is the same catalogue as Eya's (src/main/privacy/communicationAccess.ts); a test keeps them in step.
 */

const DEFAULT_BLOCKED = [
  { host: 'web.whatsapp.com' },
  { host: 'web.telegram.org' },
  { host: 'instagram.com' },
  { host: 'messenger.com' },
  { host: 'facebook.com', pathPrefix: '/messages' },
  { host: 'discord.com', pathPrefix: '/channels' },
  { host: 'app.slack.com' },
  { host: 'teams.microsoft.com' },
  { host: 'teams.live.com' },
  { host: 'web.skype.com' },
];

let blocked = DEFAULT_BLOCKED;

/** Only plain host names and "/path" prefixes are accepted, and not an unreasonable number of them. */
function sanitize(list) {
  if (!Array.isArray(list)) return DEFAULT_BLOCKED;
  const out = [];
  for (const rule of list.slice(0, 200)) {
    if (typeof rule?.host !== 'string' || !/^[a-z0-9.-]{3,253}$/i.test(rule.host)) continue;
    const entry = { host: rule.host.toLowerCase() };
    if (typeof rule.pathPrefix === 'string' && /^\/[\w\-./]{0,100}$/.test(rule.pathPrefix)) entry.pathPrefix = rule.pathPrefix;
    out.push(entry);
  }
  return out;
}

// After the browser restarts the worker, pick up what Eya last said; until then everything stays blocked.
const loaded = chrome.storage.session
  .get('eyaBlocked')
  .then((v) => {
    if (Array.isArray(v?.eyaBlocked)) blocked = sanitize(v.eyaBlocked);
  })
  .catch(() => undefined);

/** Eya's current list of what is NOT allowed. Returns how many rules are in force. */
export function setBlocked(list) {
  blocked = sanitize(list);
  chrome.storage.session.set({ eyaBlocked: blocked }).catch(() => undefined);
  return blocked.length;
}

function matchBlocked(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  for (const rule of blocked) {
    if (host !== rule.host && !host.endsWith(`.${rule.host}`)) continue;
    if (rule.pathPrefix !== undefined && !u.pathname.toLowerCase().startsWith(rule.pathPrefix.toLowerCase())) continue;
    return rule.host;
  }
  return null;
}

/** The blocked host this address belongs to, or null. Waits for the saved list to load first, so a restart never opens a gap. */
export async function blockedHostFor(url) {
  await loaded;
  return matchBlocked(url);
}

/** Same, without waiting (for building a tab description): until the list has loaded this uses the safe default. */
export function blockedHostForSync(url) {
  return matchBlocked(url);
}

/** Thrown instead of touching a chat app's page. The text is what Eya's side recognises. */
export class CommunicationAccessOff extends Error {
  constructor(host) {
    super(`communication_access_off: ${host}`);
    this.name = 'CommunicationAccessOff';
    this.host = host;
  }
}
