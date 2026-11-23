/**
 * Turning a search engine's results page into plain, trustworthy links. Used
 * when Gemini's own Google-grounded search is unavailable (its free-tier
 * allowance is separate from, and far smaller than, ordinary model calls), so
 * a "find me the official website" request still works by reading a real
 * results page the way a person would — never by guessing an address.
 */
export interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface RawSearchHit {
  readonly title?: string | null | undefined;
  readonly href?: string | null | undefined;
  readonly snippet?: string | null | undefined;
}

const MAX_HITS = 8;
const MAX_TITLE_CHARS = 120;
const MAX_SNIPPET_CHARS = 200;

function isSearchEngineHost(host: string): boolean {
  return /(^|\.)(duckduckgo|bing|google)\.[a-z.]+$/i.test(host);
}

function decodeBase64Url(value: string): string | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Search engines wrap every result in their own redirect link. This unwraps
 * DuckDuckGo's (`uddg=`) and Bing's (`u=a1<base64url>`) to the real
 * destination, passes a direct link through unchanged, and returns null for
 * anything that isn't an ordinary http(s) address.
 */
export function decodeSearchHref(href: string): string | null {
  let raw = href.trim();
  if (raw.startsWith('//')) raw = `https:${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  let target: string = url.href;
  if (/(^|\.)duckduckgo\.com$/i.test(url.hostname) && url.pathname.startsWith('/l/')) {
    const dest = url.searchParams.get('uddg');
    if (dest === null) return null;
    target = dest;
  } else if (/(^|\.)bing\.com$/i.test(url.hostname) && url.pathname.startsWith('/ck/a')) {
    const wrapped = url.searchParams.get('u');
    if (wrapped === null || !wrapped.startsWith('a1')) return null;
    const dest = decodeBase64Url(wrapped.slice(2));
    if (dest === null) return null;
    target = dest;
  }

  try {
    const final = new URL(target);
    if (final.protocol !== 'https:' && final.protocol !== 'http:') return null;
    if (final.username !== '' || final.password !== '') return null;
    return final.href;
  } catch {
    return null;
  }
}

function tidy(text: string | null | undefined, max: number): string {
  const collapsed = (text ?? '').replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Real destinations only (never the search engine's own pages), de-duplicated, in the engine's own ranking order. */
export function cleanSearchHits(raw: readonly RawSearchHit[], max: number = MAX_HITS): WebSearchHit[] {
  const seen = new Set<string>();
  const hits: WebSearchHit[] = [];
  for (const r of raw) {
    if (typeof r.href !== 'string') continue;
    const url = decodeSearchHref(r.href);
    if (url === null) continue;
    if (isSearchEngineHost(new URL(url).hostname)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const title = tidy(r.title, MAX_TITLE_CHARS);
    hits.push({ title: title.length > 0 ? title : new URL(url).hostname, url, snippet: tidy(r.snippet, MAX_SNIPPET_CHARS) });
    if (hits.length >= max) break;
  }
  return hits;
}

/** The same `{answer, sources}` shape a grounded search returns, so the model handles either identically. */
export function formatHitsAsAnswer(query: string, hits: readonly WebSearchHit[]): string {
  const lines = hits.map((h, i) => `${i + 1}. ${h.title} — ${h.url}${h.snippet.length > 0 ? ` — ${h.snippet}` : ''}`);
  return (
    `Top web results for "${query}" (a plain search-results page, not verified): ` +
    'judge which one is the genuine official site from its own domain, not from its title or snippet.\n' +
    lines.join('\n')
  );
}
