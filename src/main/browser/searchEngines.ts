/** The result pages Eya reads when Gemini's own search is unavailable. Order = preference. */
export interface SearchEngineUrl {
  readonly name: 'duckduckgo' | 'bing';
  url(query: string): string;
}

export const SEARCH_ENGINE_URLS: readonly SearchEngineUrl[] = [
  { name: 'duckduckgo', url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}` },
  { name: 'bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
];

/**
 * The engines to read, in order. Tests only: EYA_TEST_SEARCH_URL (an address with {q} in it) stands in for them, read as a results page shaped like
 * DuckDuckGo's, so a test can answer a search with a page of its own instead of the real internet.
 */
export function searchEngineUrls(): readonly SearchEngineUrl[] {
  const test = process.env['EYA_TEST_SEARCH_URL'];
  if (test !== undefined && test.includes('{q}')) return [{ name: 'duckduckgo', url: (q) => test.replace('{q}', encodeURIComponent(q)) }];
  return SEARCH_ENGINE_URLS;
}
