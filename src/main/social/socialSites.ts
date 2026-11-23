/**
 * The public sites Eya can write on for the person (LinkedIn first, Fiverr next). Eya uses the person's OWN signed-in session in their own browser: she never holds a password,
 * a token or the account. What each site is called, which hosts are it, and the addresses that are worth opening.
 */
export type SocialSiteId = 'linkedin' | 'fiverr';

export interface SocialSite {
  readonly id: SocialSiteId;
  readonly name: string;
  /** The page's host, without "www.": a page is this site when its host is this or ends with ".<host>". */
  readonly hosts: readonly string[];
  /** The plugin that stands for it (the person grants what it may do on the Plugins page). */
  readonly pluginId: string;
  readonly urls: Readonly<Record<string, string>>;
}

export const SOCIAL_SITES: readonly SocialSite[] = [
  {
    id: 'linkedin',
    name: 'LinkedIn',
    hosts: ['linkedin.com'],
    pluginId: 'linkedin',
    urls: {
      feed: 'https://www.linkedin.com/feed/',
      // (opens the "Create a post" box on the feed by itself)
      composer: 'https://www.linkedin.com/feed/?shareActive=true',
      notifications: 'https://www.linkedin.com/notifications/',
      myActivity: 'https://www.linkedin.com/in/me/recent-activity/all/',
      jobs: 'https://www.linkedin.com/jobs/',
    },
  },
  {
    id: 'fiverr',
    name: 'Fiverr',
    hosts: ['fiverr.com'],
    pluginId: 'fiverr',
    urls: { home: 'https://www.fiverr.com/' },
  },
];

export function siteById(id: string): SocialSite | null {
  return SOCIAL_SITES.find((s) => s.id === id) ?? null;
}

/** The site a page address belongs to, or null (any other website, a page that is not a web address). */
export function siteOfUrl(url: string): SocialSite | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  return SOCIAL_SITES.find((s) => s.hosts.some((h) => host === h || host.endsWith(`.${h}`))) ?? null;
}
