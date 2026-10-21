/**
 * Websites people ask for by name ("open YouTube", "search Amazon for a phone case"), and the address that searches each one.
 * Everything here is an ordinary public https address opened in the user's own default browser: no sign-in, no page reading.
 * A name that is not in this list is simply not claimed, and the request goes on to the model as before.
 */

export interface Site {
  readonly id: string;
  /** What Eya says. */
  readonly label: string;
  /** Every way it is said (lower case). */
  readonly names: readonly string[];
  readonly url: string;
  /** The address that runs a search; `{q}` is the URL-encoded query. Absent when the site has no plain search address. */
  readonly search?: string;
}

export const SITES: readonly Site[] = [
  { id: 'google', label: 'Google', names: ['google', 'google search'], url: 'https://www.google.com/', search: 'https://www.google.com/search?q={q}' },
  { id: 'youtube', label: 'YouTube', names: ['youtube', 'you tube'], url: 'https://www.youtube.com/', search: 'https://www.youtube.com/results?search_query={q}' },
  { id: 'gmail', label: 'Gmail', names: ['gmail', 'google mail', 'g mail'], url: 'https://mail.google.com/' },
  { id: 'maps', label: 'Google Maps', names: ['google maps', 'maps'], url: 'https://www.google.com/maps', search: 'https://www.google.com/maps/search/{q}' },
  { id: 'drive', label: 'Google Drive', names: ['google drive'], url: 'https://drive.google.com/' },
  { id: 'docs', label: 'Google Docs', names: ['google docs'], url: 'https://docs.google.com/document/' },
  { id: 'sheets', label: 'Google Sheets', names: ['google sheets'], url: 'https://docs.google.com/spreadsheets/' },
  { id: 'slides', label: 'Google Slides', names: ['google slides'], url: 'https://docs.google.com/presentation/' },
  { id: 'calendar', label: 'Google Calendar', names: ['google calendar'], url: 'https://calendar.google.com/' },
  { id: 'meet', label: 'Google Meet', names: ['google meet'], url: 'https://meet.google.com/' },
  { id: 'translate', label: 'Google Translate', names: ['google translate', 'translate'], url: 'https://translate.google.com/' },
  { id: 'photos', label: 'Google Photos', names: ['google photos'], url: 'https://photos.google.com/' },
  { id: 'bing', label: 'Bing', names: ['bing'], url: 'https://www.bing.com/', search: 'https://www.bing.com/search?q={q}' },
  { id: 'duckduckgo', label: 'DuckDuckGo', names: ['duckduckgo', 'duck duck go'], url: 'https://duckduckgo.com/', search: 'https://duckduckgo.com/?q={q}' },
  { id: 'wikipedia', label: 'Wikipedia', names: ['wikipedia', 'wiki'], url: 'https://www.wikipedia.org/', search: 'https://en.wikipedia.org/w/index.php?search={q}' },
  { id: 'github', label: 'GitHub', names: ['github', 'git hub'], url: 'https://github.com/', search: 'https://github.com/search?q={q}' },
  { id: 'stackoverflow', label: 'Stack Overflow', names: ['stack overflow', 'stackoverflow'], url: 'https://stackoverflow.com/', search: 'https://stackoverflow.com/search?q={q}' },
  { id: 'reddit', label: 'Reddit', names: ['reddit'], url: 'https://www.reddit.com/', search: 'https://www.reddit.com/search/?q={q}' },
  { id: 'amazon', label: 'Amazon', names: ['amazon'], url: 'https://www.amazon.com/', search: 'https://www.amazon.com/s?k={q}' },
  { id: 'flipkart', label: 'Flipkart', names: ['flipkart'], url: 'https://www.flipkart.com/', search: 'https://www.flipkart.com/search?q={q}' },
  { id: 'netflix', label: 'Netflix', names: ['netflix'], url: 'https://www.netflix.com/', search: 'https://www.netflix.com/search?q={q}' },
  { id: 'spotify', label: 'Spotify', names: ['spotify'], url: 'https://open.spotify.com/', search: 'https://open.spotify.com/search/{q}' },
  { id: 'linkedin', label: 'LinkedIn', names: ['linkedin', 'linked in'], url: 'https://www.linkedin.com/' },
  { id: 'facebook', label: 'Facebook', names: ['facebook'], url: 'https://www.facebook.com/' },
  { id: 'instagram', label: 'Instagram', names: ['instagram'], url: 'https://www.instagram.com/' },
  { id: 'twitter', label: 'X', names: ['twitter'], url: 'https://x.com/', search: 'https://x.com/search?q={q}' },
  { id: 'whatsapp', label: 'WhatsApp Web', names: ['whatsapp web', 'whatsapp'], url: 'https://web.whatsapp.com/' },
  { id: 'telegram', label: 'Telegram Web', names: ['telegram web', 'telegram'], url: 'https://web.telegram.org/a/' },
  { id: 'chatgpt', label: 'ChatGPT', names: ['chatgpt', 'chat gpt'], url: 'https://chatgpt.com/' },
  { id: 'claude', label: 'Claude', names: ['claude'], url: 'https://claude.ai/' },
  { id: 'outlook', label: 'Outlook', names: ['outlook mail', 'outlook web'], url: 'https://outlook.live.com/mail/' },
  { id: 'onedrive', label: 'OneDrive', names: ['onedrive', 'one drive'], url: 'https://onedrive.live.com/' },
];

/** What a person says to name a site, mapped to the site. A name is claimed by one site only. */
const BY_NAME = new Map<string, Site>();
for (const site of SITES) for (const name of site.names) if (!BY_NAME.has(name)) BY_NAME.set(name, site);

/** The site a spoken name means ("the youtube website" has already had its filler removed), or undefined. */
export function findSite(name: string): Site | undefined {
  return BY_NAME.get(name.trim().toLowerCase().replace(/\s+/g, ' '));
}

/** Every name a search can be aimed at: only the sites that have a search address. */
export function searchableSiteNames(): readonly string[] {
  return [...BY_NAME.entries()].filter(([, s]) => s.search !== undefined).map(([n]) => n).sort((a, b) => b.length - a.length);
}

export function searchUrl(site: Site, query: string): string | null {
  return site.search === undefined ? null : site.search.replace('{q}', encodeURIComponent(query));
}

// Top-level domains someone actually says. "dot com" is how a speech recogniser hears an address.
const TLDS = 'com|org|net|in|io|co|dev|app|edu|gov|ai|me|info|tv|us|uk|ca|au|de|fr';

/** "github dot com" -> "github.com" (only for the endings above, so ordinary sentences are left alone). */
export function joinSpokenDots(text: string): string {
  return text.replace(new RegExp(`\\b([a-z0-9][a-z0-9-]*) dot (${TLDS})\\b`, 'g'), '$1.$2');
}

const DOMAIN = new RegExp(`^(?:www\\.)?[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9][a-z0-9-]*)*\\.(?:${TLDS})(?:/[^\\s]*)?$`);

/** A bare web address like "github.com" or "www.bbc.co.uk/news", as an https URL; null for anything else. */
export function domainToUrl(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (!DOMAIN.test(t)) return null;
  return `https://${t}`;
}
