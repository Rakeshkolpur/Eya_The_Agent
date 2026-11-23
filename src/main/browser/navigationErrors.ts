/**
 * What went wrong when a page would not open, in words the user (and the model) can act on. The browser's own error codes
 * ("net::ERR_NAME_NOT_RESOLVED") mean nothing to a person, and treating every failure the same either retries what can never work or gives up
 * on what a second try would fix.
 */
export type NavigationProblemKind =
  | 'dns'
  | 'offline'
  | 'refused'
  | 'timeout'
  | 'redirect_loop'
  | 'certificate'
  | 'blocked'
  | 'empty'
  | 'aborted'
  | 'access_denied'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'crashed'
  | 'other';

export interface NavigationProblem {
  readonly kind: NavigationProblemKind;
  /** What happened, for the user. */
  readonly message: string;
  /** A second try soon might work (a hiccup); false for anything that will fail the same way again. */
  readonly retryable: boolean;
  /** What the user can do about it, when there is something. */
  readonly next?: string;
}

/** Shortens an address for a message: the host and the start of the path. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = `${u.pathname}${u.search}`;
    return `${u.host}${path.length > 40 ? `${path.slice(0, 40)}…` : path === '/' ? '' : path}`;
  } catch {
    return url.slice(0, 60);
  }
}

/** The browser's own wording for why a navigation failed, as it comes out of Playwright or Chrome, turned into a problem. */
export function classifyNavigationError(err: unknown, url: string): NavigationProblem {
  const text = err instanceof Error ? err.message : String(err);
  const where = shortUrl(url);
  const has = (re: RegExp): boolean => re.test(text);
  if (has(/ERR_NAME_NOT_RESOLVED|ENOTFOUND|getaddrinfo/i)) {
    return { kind: 'dns', retryable: false, message: `${where} could not be found: the name does not exist or is mistyped (a DNS failure).`, next: 'Check the address for a typing mistake, or send me the exact link.' };
  }
  if (has(/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_PROXY_CONNECTION_FAILED|ERR_NETWORK_ACCESS_DENIED/i)) {
    return { kind: 'offline', retryable: true, message: 'There is no working internet connection right now (or it just changed).', next: 'Check the connection; I will try again.' };
  }
  if (has(/ERR_CONNECTION_REFUSED/i)) {
    return { kind: 'refused', retryable: false, message: `${where} refused the connection: the site is down or not accepting visitors.`, next: 'Try again later, or check the address.' };
  }
  if (has(/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|Timeout \d+ms exceeded|timed out|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|ERR_CONNECTION_CLOSED/i)) {
    return { kind: 'timeout', retryable: true, message: `${where} did not answer in time (the site is slow, busy or the connection dropped).`, next: 'I can try once more; if it keeps failing the site is down.' };
  }
  if (has(/ERR_TOO_MANY_REDIRECTS/i)) {
    return { kind: 'redirect_loop', retryable: false, message: `${where} keeps redirecting to itself (a redirect loop), often because of a stale cookie or a sign-in problem on the site.`, next: 'Clearing this site\'s data, or signing in again, usually fixes it.' };
  }
  if (has(/ERR_CERT_|ERR_SSL_|SSL_ERROR|certificate/i)) {
    return { kind: 'certificate', retryable: false, message: `${where} has a security-certificate problem, so the browser would not open it.`, next: 'I will not open a site the browser says is not safe; check the address or tell me it is fine and I will say how.' };
  }
  if (has(/ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_RESPONSE|ERR_ACCESS_DENIED|ERR_UNSAFE_PORT/i)) {
    return { kind: 'blocked', retryable: false, message: `${where} blocked the browser from opening it.`, next: 'The site may not allow automated visits; open it yourself in your own browser.' };
  }
  if (has(/ERR_ABORTED|frame was detached|Navigation.*interrupted|interrupted by another navigation/i)) {
    return { kind: 'aborted', retryable: true, message: `The page was replaced by another one while it was opening (${where}).` };
  }
  if (has(/crash|Target closed|has been closed|Browser has been closed/i)) {
    return { kind: 'crashed', retryable: true, message: 'The browser page closed or crashed while opening it.', next: 'I will start it again.' };
  }
  return { kind: 'other', retryable: false, message: `${where} could not be opened: ${text.replace(/^page\.goto: /i, '').split('\n')[0]?.slice(0, 160) ?? 'unknown error'}` };
}

/** A page that did open, but the site answered with an error code. Null for a normal answer. */
export function describeHttpStatus(status: number | null | undefined, url: string): NavigationProblem | null {
  if (status === null || status === undefined || status < 400) return null;
  const where = shortUrl(url);
  if (status === 401 || status === 403) {
    return { kind: 'access_denied', retryable: false, message: `${where} answered "${status}": access is denied (a sign-in is needed, or the site does not allow this visitor).`, next: 'Sign in on the page if it offers it; otherwise I cannot get in.' };
  }
  if (status === 404 || status === 410) {
    return { kind: 'not_found', retryable: false, message: `${where} answered "${status}": that page does not exist (any more).`, next: 'Check the address, or tell me where to click from the site\'s home page.' };
  }
  if (status === 429) {
    return { kind: 'rate_limited', retryable: true, message: `${where} answered "429": too many requests, so the site is asking visitors to slow down.`, next: 'Wait a little, then I will try again.' };
  }
  if (status >= 500) {
    return { kind: 'server_error', retryable: true, message: `${where} answered "${status}": the site itself has an error.`, next: 'I can try once more; if it stays, the site is down.' };
  }
  return { kind: 'other', retryable: false, message: `${where} answered "${status}".` };
}

/** A navigation that ended somewhere other than where it was sent. Null when it went where it was asked. */
export function describeRedirect(requested: string, final: string): string | null {
  if (final === '' || final === requested) return null;
  try {
    const a = new URL(requested);
    const b = new URL(final);
    // (the address's query part is left out of the comparison: addresses are shortened and redacted on the way back)
    const bare = (h: string): string => h.replace(/^www\./, '');
    if (bare(a.host) === bare(b.host) && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '')) return null;
    if (bare(a.host) !== bare(b.host)) {
      return `Asked for ${shortUrl(requested)} but the browser ended up on a DIFFERENT site, ${shortUrl(final)} (a redirect). It is not the page that was asked for.`;
    }
    return `The site redirected from ${shortUrl(requested)} to ${shortUrl(final)}.`;
  } catch {
    return `The page ended up at ${final.slice(0, 80)}, not at the address asked for.`;
  }
}
