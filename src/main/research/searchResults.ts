import { cleanSearchHits } from '@main/browser/webSearchResults';
import type { RawSearchHit, WebSearchHit } from '@main/browser/webSearchResults';
import { decodeEntities } from './htmlText';
import type { WebFetcher } from './webFetch';

/**
 * Reading a search engine's results page over plain HTTP. DuckDuckGo's HTML page answers a script as it would a browser (measured: ten
 * results, no check, for a legal query); Bing answers too but gives poor results unless asked in an English market, so it is the second
 * opinion, not the first. Google, Brave and the others block or need a script, and are not used here.
 */

export type Engine = 'duckduckgo' | 'bing';

export interface SearchHit extends WebSearchHit {
  readonly engine: Engine;
}

const tidy = (s: string): string => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export function parseDuckDuckGo(html: string): RawSearchHit[] {
  const out: RawSearchHit[] = [];
  const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    const a = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (a?.[1] === undefined) continue;
    const snippet = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block) ?? /<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    out.push({ href: decodeEntities(a[1]), title: tidy(a[2] ?? ''), snippet: tidy(snippet?.[1] ?? '') });
  }
  return out;
}

export function parseBing(html: string): RawSearchHit[] {
  const out: RawSearchHit[] = [];
  for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)) {
    const block = m[0];
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (a?.[1] === undefined) continue;
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    out.push({ href: decodeEntities(a[1]), title: tidy(a[2] ?? ''), snippet: tidy(p?.[1] ?? '') });
  }
  return out;
}

export const searchUrl: Record<Engine, (q: string) => string> = {
  duckduckgo: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=in-en`,
  bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en&cc=IN&mkt=en-IN`,
};

/** One query on one engine: real destinations only, in the engine's own order. Empty (never an error) when the engine does not answer. */
export async function searchOne(fetcher: WebFetcher, engine: Engine, query: string, max = 10): Promise<SearchHit[]> {
  const page = await fetcher.page(searchUrl[engine](query), { maxBytes: 600_000, timeoutMs: 15_000 });
  if (!page.ok || page.text === '') return [];
  // An engine's "are you a robot" page is not results.
  if (/anomaly-modal|unusual traffic|captcha/i.test(page.text) && !/result__a|b_algo/.test(page.text)) return [];
  const raw = engine === 'duckduckgo' ? parseDuckDuckGo(page.text) : parseBing(page.text);
  return cleanSearchHits(raw, max).map((h) => ({ ...h, engine }));
}
