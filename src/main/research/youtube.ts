import { hasTerm, keyTerms, mediaTitle } from './queries';
import type { WebFetcher } from './webFetch';

/**
 * Choosing the right video on YouTube for "play <song or film>": YouTube's own results page is read over plain HTTP (it carries its
 * results as data in the page), and the result a careful person would click is picked: the right title, from the official channel, of the
 * right length (a song is a few minutes, a film an hour or more; a mashup, a trailer or a 30-second clip is not what was asked for).
 */

export interface YtVideo {
  readonly id: string;
  readonly title: string;
  readonly channel: string;
  /** The channel carries YouTube's verified badge. */
  readonly verified: boolean;
  readonly seconds: number | null;
  readonly views: number | null;
  readonly live: boolean;
}

export type YtKind = 'song' | 'movie' | 'video';

interface Runs {
  readonly simpleText?: string;
  readonly runs?: ReadonlyArray<{ readonly text?: string }>;
}

const textOf = (r: Runs | undefined): string => (r === undefined ? '' : (r.simpleText ?? (r.runs ?? []).map((x) => x.text ?? '').join('')));

/** "4:11" → 251, "1:45:30" → 6330. */
export function secondsFromLength(text: string): number | null {
  const parts = text.trim().split(':').map((p) => Number(p));
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** "19,04,00,721 views" or "2.1M views" → a number. */
export function viewsFromText(text: string): number | null {
  const m = /([\d][\d,.]*)\s*([KMB]?)/i.exec(text);
  if (m === null) return null;
  const n = Number((m[1] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? '').toUpperCase();
  return Math.round(n * (unit === 'K' ? 1e3 : unit === 'M' ? 1e6 : unit === 'B' ? 1e9 : 1));
}

function collectVideoRenderers(node: unknown, out: Array<Record<string, unknown>>, depth = 0): void {
  if (depth > 14 || out.length >= 60 || typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    for (const x of node) collectVideoRenderers(x, out, depth + 1);
    return;
  }
  const rec = node as Record<string, unknown>;
  const vr = rec['videoRenderer'];
  if (typeof vr === 'object' && vr !== null) out.push(vr as Record<string, unknown>);
  for (const [key, value] of Object.entries(rec)) {
    if (key !== 'videoRenderer') collectVideoRenderers(value, out, depth + 1);
  }
}

/** The videos of a YouTube results page (shorts, adverts and playlists are not among them). */
export function parseYoutubeResults(html: string): YtVideo[] {
  const marker = 'ytInitialData = ';
  const start = html.indexOf(marker);
  if (start < 0) return [];
  const from = start + marker.length;
  const end = html.indexOf(';</script>', from);
  if (end < 0) return [];
  let data: unknown;
  try {
    data = JSON.parse(html.slice(from, end));
  } catch {
    return [];
  }
  const found: Array<Record<string, unknown>> = [];
  collectVideoRenderers(data, found);
  const out: YtVideo[] = [];
  for (const v of found) {
    const id = typeof v['videoId'] === 'string' ? v['videoId'] : '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) continue;
    const title = textOf(v['title'] as Runs | undefined);
    const channel = textOf(v['ownerText'] as Runs | undefined) || textOf(v['longBylineText'] as Runs | undefined);
    const badges = (Array.isArray(v['ownerBadges']) ? v['ownerBadges'] : []) as Array<{ metadataBadgeRenderer?: { style?: string } }>;
    const live =
      v['upcomingEventData'] !== undefined ||
      JSON.stringify(v['badges'] ?? []).includes('LIVE') ||
      JSON.stringify(v['thumbnailOverlays'] ?? []).includes('"LIVE"') ||
      textOf(v['viewCountText'] as Runs | undefined).toLowerCase().includes('watching');
    out.push({
      id,
      title,
      channel,
      verified: badges.some((b) => (b.metadataBadgeRenderer?.style ?? '').includes('VERIFIED')),
      seconds: secondsFromLength(textOf(v['lengthText'] as Runs | undefined)),
      views: viewsFromText(textOf(v['viewCountText'] as Runs | undefined)),
      live,
    });
  }
  return out;
}

export async function searchYoutube(fetcher: WebFetcher, query: string): Promise<YtVideo[]> {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&gl=IN`;
  const page = await fetcher.page(url, { maxBytes: 4_000_000, timeoutMs: 15_000 });
  if (!page.ok || page.text === '') return [];
  return parseYoutubeResults(page.text);
}

/** What a request is: a song, a film, or just a video. */
export function kindFromRequest(text: string): YtKind {
  const t = text.toLowerCase();
  if (/(^|[^a-z])(movie|film|full movie|cinema|web series|episode)([^a-z]|$)/.test(t)) return 'movie';
  if (/(^|[^a-z])(song|songs|music|lyrics|album|track|gana|gaana|audio)([^a-z]|$)/.test(t)) return 'song';
  return 'video';
}

/** A year from 1890 to 1930 in the text (a film that old is in the public domain), or null. */
export function oldFilmYear(text: string): number | null {
  for (const m of text.matchAll(/(?:^|[^0-9])(18[89][0-9]|19[0-2][0-9]|1930)(?:[^0-9]|$)/g)) return Number(m[1]);
  return null;
}

const OFF_TOPIC = ['trailer', 'teaser', 'reaction', 'review', 'cover', 'lyrics', 'lyrical', 'mashup', 'remix', 'status', 'shorts', 'jukebox', 'karaoke', 'instrumental', 'scene', 'scenes', 'clip', 'dialogue', 'ringtone', 'whatsapp', 'edit', 'climax', 'fight', 'interval', 'making', 'bts', 'promo', 'songs', 'best', 'comedy', 'emotional'];

/** The candidates in the order a careful person would try them (best first), with a score each. Empty when nothing fits. */
export function rankVideos(videos: readonly YtVideo[], request: string, kind: YtKind): Array<{ readonly video: YtVideo; readonly score: number }> {
  const subject = mediaTitle(request);
  const terms = keyTerms(subject);
  const asked = request.toLowerCase();
  const scored: Array<{ readonly video: YtVideo; readonly score: number }> = [];
  videos.forEach((video, index) => {
    if (video.live) return;
    const seconds = video.seconds;
    if (seconds !== null && seconds < 45 && kind !== 'video') return;
    const label = `${video.title} ${video.channel}`.toLowerCase();
    const named = terms.length === 0 ? 0 : terms.filter((t) => hasTerm(label, t)).length / terms.length;
    // Not (mostly) the title that was asked for: not a candidate (the engine's order alone is not enough).
    if (terms.length > 0 && named < 0.5) return;
    // A full film is played only from a channel YouTube has verified (a studio, a distributor), or when it is old enough to be public
    // domain (1930 or before): the "full movie" uploads of recent films by anyone else are mostly pirated copies.
    const oldFilm = oldFilmYear(`${request} ${video.title}`) !== null;
    if (kind === 'movie' && !video.verified && !oldFilm) return;
    // (A scene, a trailer or a compilation is not the film: a feature runs well over 40 minutes.)
    if (kind === 'movie' && seconds !== null && seconds < 2400 && !oldFilm) return;
    let score = named * 1.0;
    score += video.verified ? 0.25 : 0;
    if (/\bofficial\b|\bvevo\b|- topic$|\bt-series\b|\bmusic\b/i.test(video.channel) || /official/i.test(video.title)) score += 0.1;
    if (seconds !== null) {
      if (kind === 'song') score += seconds >= 120 && seconds <= 600 ? 0.3 : seconds <= 900 ? 0.05 : -0.4;
      else if (kind === 'movie') score += seconds >= 3600 ? 0.4 : seconds >= 1800 ? 0.1 : -0.5;
    }
    for (const word of OFF_TOPIC) {
      if (new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, 'i').test(video.title) && !asked.includes(word)) score -= 0.25;
    }
    if (video.views !== null && video.views > 0) score += Math.min(0.2, Math.log10(video.views) / 40);
    score -= index * 0.02;
    scored.push({ video, score });
  });
  return scored.sort((a, b) => b.score - a.score);
}
