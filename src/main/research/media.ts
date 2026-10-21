import type { WebFetcher } from './webFetch';
import { isBlockedSite, streamingPlatform } from './trust';
import type { SearchHit } from './searchResults';

/**
 * Films and songs, the legal way only: where a title can be watched or heard on an official platform, and the copies that are genuinely
 * free to keep (the Internet Archive's public-domain and openly licensed films, recordings and audio). Eya does not look for, name or
 * open the sites that give away other people's films and music without permission, and she says so rather than quietly going around.
 */

export interface FreeCopy {
  readonly title: string;
  readonly year: string | null;
  /** The item's page on the Internet Archive. */
  readonly url: string;
  readonly identifier: string;
  readonly kind: 'film' | 'audio';
  /** In a collection of public-domain works, or marked public domain / openly licensed by whoever shared it. */
  readonly freeToKeep: boolean;
  /** The rights note the item carries, as the address of the licence, when it has one. */
  readonly license: string | null;
  readonly downloads: number;
  /** A direct file address (filled for the first few only), ready for a download the user has agreed to. */
  readonly fileUrl?: string;
  readonly fileSizeBytes?: number | null;
}

export interface WatchOption {
  readonly platform: string;
  readonly title: string;
  readonly url: string;
  /** Platforms known to show titles free with adverts, which the page may need a sign-in for; the rest are paid or subscription. */
  readonly free: boolean;
  /** A caution to pass on: a "full movie" on YouTube is official only when the channel is the studio's or distributor's. */
  readonly note?: string;
}

/** Platforms that carry a free, advert-supported catalogue (some titles on them still need a subscription). */
const FREE_WITH_ADS = new Set(['YouTube', 'MX Player', 'Tubi', 'Pluto TV', 'Plex', 'The Roku Channel', 'JioSaavn', 'Gaana', 'Internet Archive']);

/** Collections the Internet Archive keeps public-domain or openly licensed works in. */
const FREE_COLLECTIONS = new Set(['silent_films', 'prelinger', 'classic_tv', 'film_noir', 'feature_films', 'librivox', 'netlabels']);
/**
 * The Archive also holds uploads of films and songs that are still in copyright (DVD rips, album uploads) in its open "community" and
 * "audio" collections. A copy counts as free to keep only on clear grounds: it carries a public-domain or Creative Commons licence, or it
 * sits in a curated collection of public-domain work AND is old (a feature film from 1930 or before, a LibriVox reading, a netlabel release).
 */
const OLD_ENOUGH = 1930;

interface ArchiveDoc {
  readonly identifier?: string;
  readonly title?: string | string[];
  readonly year?: string | number;
  readonly downloads?: number;
  readonly collection?: string | string[];
  readonly licenseurl?: string;
  readonly mediatype?: string;
}

const asList = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function freeToKeep(doc: ArchiveDoc): boolean {
  const lic = doc.licenseurl ?? '';
  if (/publicdomain|\/by(?:-sa)?\/|\/zero\//i.test(lic)) return true;
  const collections = asList(doc.collection);
  if (collections.some((c) => c === 'librivox' || c === 'netlabels')) return true;
  const year = Number(doc.year);
  return collections.some((c) => FREE_COLLECTIONS.has(c)) && Number.isFinite(year) && year > 0 && year <= OLD_ENOUGH;
}

/** The Internet Archive's own search for a film or recording by name. Empty (never an error) when it does not answer. */
export async function archiveSearch(fetcher: WebFetcher, topic: string, kinds: ReadonlyArray<'film' | 'audio'> = ['film', 'audio'], rows = 6): Promise<FreeCopy[]> {
  const words = topic
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 8)
    .join(' ');
  if (words === '') return [];
  const types = kinds.map((k) => (k === 'film' ? 'mediatype:(movies)' : 'mediatype:(audio)')).join(' OR ');
  const q = `title:(${words}) AND (${types})`;
  const url =
    'https://archive.org/advancedsearch.php?' +
    [`q=${encodeURIComponent(q)}`, ...['identifier', 'title', 'year', 'downloads', 'collection', 'licenseurl', 'mediatype'].map((f) => `fl[]=${f}`), `rows=${rows}`, 'sort[]=downloads+desc', 'output=json'].join('&');
  const data = await fetcher.json<{ response?: { docs?: ArchiveDoc[] } }>(url, 12_000);
  const docs = data?.response?.docs ?? [];
  const out: FreeCopy[] = [];
  for (const d of docs) {
    if (typeof d.identifier !== 'string' || d.identifier === '') continue;
    const title = asList(d.title)[0] ?? d.identifier;
    out.push({
      title,
      year: d.year === undefined ? null : String(d.year),
      url: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
      identifier: d.identifier,
      kind: d.mediatype === 'audio' ? 'audio' : 'film',
      freeToKeep: freeToKeep(d),
      license: d.licenseurl ?? null,
      downloads: typeof d.downloads === 'number' ? d.downloads : 0,
    });
  }
  return out;
}

interface ArchiveFile {
  readonly name?: string;
  readonly format?: string;
  readonly size?: string;
  readonly source?: string;
}

const WANTED_FORMATS: ReadonlyArray<{ readonly film: boolean; readonly re: RegExp }> = [
  { film: true, re: /^(?:h\.264|mpeg4|512kb mpeg4)$/i },
  { film: true, re: /^ogg video$/i },
  { film: false, re: /^(?:vbr mp3|mp3|128kbps mp3)$/i },
  { film: false, re: /^ogg vorbis$/i },
];

/** The best single file of an item to download: a normal-size MP4/MP3 rather than the huge original. Null when it has none. */
export async function archiveFile(fetcher: WebFetcher, copy: FreeCopy): Promise<{ readonly url: string; readonly sizeBytes: number | null } | null> {
  const meta = await fetcher.json<{ files?: ArchiveFile[]; is_dark?: boolean }>(`https://archive.org/metadata/${encodeURIComponent(copy.identifier)}`, 12_000);
  if (meta === null || meta.is_dark === true || !Array.isArray(meta.files)) return null;
  for (const want of WANTED_FORMATS.filter((w) => w.film === (copy.kind === 'film'))) {
    const files = meta.files.filter((f) => typeof f.name === 'string' && typeof f.format === 'string' && want.re.test(f.format) && !/_(?:sample|preview|thumb)\b/i.test(f.name ?? ''));
    if (files.length === 0) continue;
    const best = [...files].sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0))[0] as ArchiveFile;
    // (The biggest derivative of a feature film can run to many gigabytes; the smallest sensible one is fine to watch.)
    const pick = files.filter((f) => Number(f.size) > 5_000_000).sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0))[0] ?? best;
    const size = Number(pick.size);
    return { url: `https://archive.org/download/${encodeURIComponent(copy.identifier)}/${encodeURIComponent(pick.name as string)}`, sizeBytes: Number.isFinite(size) && size > 0 ? size : null };
  }
  return null;
}

/** The official platforms among search results (one per platform, the highest-ranked first), free-with-ads ones before the paid. */
export function watchOptionsFrom(hits: ReadonlyArray<Pick<SearchHit, 'title' | 'url'>>): WatchOption[] {
  const byPlatform = new Map<string, WatchOption>();
  for (const hit of hits) {
    if (isBlockedSite(hit.url)) continue;
    const platform = streamingPlatform(hit.url);
    if (platform === null) continue;
    if (byPlatform.has(platform)) continue;
    // A search-results page or a home page is not the title; the title's own page is.
    if (/\/(?:results|search|browse)\b|[?&](?:q|search_query|query)=/i.test(hit.url)) continue;
    const caution = platform === 'YouTube' && /full\s+(?:movie|film)/i.test(hit.title);
    byPlatform.set(platform, {
      platform,
      title: hit.title,
      url: hit.url,
      free: FREE_WITH_ADS.has(platform),
      ...(caution ? { note: "this is a YouTube upload: it is official only if the channel is the film's studio or distributor" } : {}),
    });
  }
  return [...byPlatform.values()].sort((a, b) => Number(b.free) - Number(a.free));
}

/** What a request for a film or song for free from anywhere is answered with before any search: the honest limit. */
export const LEGAL_NOTE =
  "I only look in legal places: the official apps and sites where it can be watched or heard, and copies that are public domain or openly licensed. I don't search or open sites that give away films and songs without permission.";
