/**
 * The two headers that make Eya's page "cross-origin isolated", which the speech engine needs to use several processor threads
 * (SharedArrayBuffer is only available to an isolated page). "credentialless" isolates without demanding that every third-party response
 * carry a resource policy of its own.
 *
 * They must appear EXACTLY ONCE on a response. Header names are matched without regard to case here because Chromium reports the names
 * it received in lower case, so adding "Cross-Origin-Opener-Policy" beside an existing "cross-origin-opener-policy" gives a response
 * with both, which the browser reads as "same-origin, same-origin": invalid, so isolation silently switches OFF and a worker the page
 * starts is refused. (That is exactly what happened to the installed app, which serves its own files and also had this hook.)
 */

export const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
} as const;

const ISOLATION_NAME = /^cross-origin-(opener|embedder)-policy$/i;

/** The response's headers with the two isolation headers set to exactly one value each, replacing any already there. */
export function withIsolationHeaders(headers: Record<string, string[]> | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(headers ?? {})) if (!ISOLATION_NAME.test(name)) out[name] = value;
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) out[name] = [value];
  return out;
}
