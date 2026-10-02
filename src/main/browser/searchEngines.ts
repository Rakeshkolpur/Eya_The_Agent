/** The result pages Eya reads when Gemini's own search is unavailable. Order = preference. */
export interface SearchEngineUrl {
  readonly name: 'duckduckgo' | 'bing';
  url(query: string): string;
}

export const SEARCH_ENGINE_URLS: readonly SearchEngineUrl[] = [
  { name: 'duckduckgo', url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}` },
  { name: 'bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
];
