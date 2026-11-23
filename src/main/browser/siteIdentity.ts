import { isBlockedSite, trustOf } from '@main/research/trust';
import type { NavigationProblem } from './navigationErrors';
import { describeHttpStatus } from './navigationErrors';
import type { PageSnapshot } from './pageSnapshot';
import type { WebSearchHit } from './webSearchResults';

/**
 * Is this page really the site that was asked for? A name that resembles the one asked for is not proof: the checks here look at the address,
 * the page's title and headings and its text, and at where the address came from, and say "verified", "unclear" (it may be, nothing contradicts
 * it, but nothing confirms it either: ask the person) or "mismatch" (it is some other site). Pure functions, so every rule can be tested.
 */

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'official', 'site', 'sites', 'website', 'websites', 'web', 'page', 'home', 'homepage', 'url', 'link', 'new', 'latest',
  'working', 'current', 'domain', 'address', 'download', 'downloads', 'movie', 'movies', 'film', 'free', 'online', 'app', 'portal', 'com', 'net', 'org', 'www',
  'http', 'https', 'html', 'open', 'find', 'visit', 'this', 'that', 'its', 'please', 'go', 'get',
]);

/** The meaningful words of a name ("the official Telangana High Court website" -> telangana, high, court). */
export function significantTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw) || out.includes(raw)) continue;
    out.push(raw);
  }
  return out;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'nic', 'ltd', 'plc', 'ne', 'or', 'go']);

/** The part of a host a person registers ("ww1.movierulz.com.ps" -> "movierulz.com.ps"; "tshc.gov.in" -> "tshc.gov.in"). */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, '').split('.').filter((l) => l !== '');
  if (labels.length <= 2) return labels.join('.');
  const last = labels[labels.length - 1] ?? '';
  const second = labels[labels.length - 2] ?? '';
  if (last.length === 2 && SECOND_LEVEL.has(second)) return labels.slice(-3).join('.');
  return labels.slice(-2).join('.');
}

/** The brand part of a host ("ww1.movierulz.com.ps" -> "movierulz"). */
export function brandLabel(host: string): string {
  return registrableDomain(host).split('.')[0] ?? '';
}

export function sameSite(a: string, b: string): boolean {
  const ha = hostOf(a);
  const hb = hostOf(b);
  return ha !== '' && hb !== '' && registrableDomain(ha) === registrableDomain(hb);
}

const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'adf.ly', 'shorte.st', 'linkvertise.com', 'ouo.io', 'cutt.ly', 'rb.gy', 'bc.vc', 'exe.io', 'shrinkme.io']);
const EXECUTABLE_PATH = /\.(exe|msi|msix|bat|cmd|com|scr|ps1|vbs|js|jse|wsf|hta|lnk|jar|apk|dmg|pkg|deb|rpm|appx|cpl|reg|dll)(\?|#|$)/i;

export function isExecutableUrl(url: string): boolean {
  try {
    return EXECUTABLE_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Why an address should not be trusted on sight (null when nothing is wrong with it). */
export function suspiciousReason(url: string, from?: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'it is not a normal web address';
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return 'it is a bare number address, not a named site';
  if (SHORTENERS.has(host) || SHORTENERS.has(registrableDomain(host))) return 'it is a link-shortening or advert-redirect address';
  if (host.split('.').some((l) => l.startsWith('xn--')) && (from === undefined || !hostOf(from).includes('xn--'))) return 'its name uses look-alike characters';
  if (isExecutableUrl(url)) return 'it leads straight to a program file';
  return null;
}

// ----------------------------------------------------------------------------------------------- what the page is
/** What the page calls itself: its title and headings (an address that merely contains the name, like "example1.org", proves nothing by itself). */
function pageHead(s: PageSnapshot): string {
  return `${s.title} ${s.headings.slice(0, 6).join(' ')}`.toLowerCase();
}

function pageBody(s: PageSnapshot): string {
  return `${s.visibleText ?? ''} ${s.links.slice(0, 40).join(' ')} ${s.buttons.slice(0, 20).join(' ')}`.toLowerCase();
}

export type Identity = 'verified' | 'unclear' | 'mismatch';

/** How many of a name's words must be in the page's title or headings: all of one or two, three quarters of more ("Telangana High Court" is not "Karnataka High Court"). */
function neededOf(words: number): number {
  return words <= 2 ? words : Math.ceil(words * 0.75);
}

export interface IdentityJudgement {
  readonly identity: Identity;
  readonly reason: string;
}

/**
 * Does the page that opened look like the site asked for? `name` is what the person called it, `url` the address they gave (its brand part is
 * also looked for: a site that moves to another ending keeps its name). Matching words in the address, title or headings are strong evidence;
 * words only somewhere in the text are not (any page can mention a name).
 */
export function judgeIdentity(snapshot: PageSnapshot, target: { readonly name?: string; readonly url?: string }): IdentityJudgement {
  const nameTokens = significantTokens(target.name ?? '');
  const brand = target.url !== undefined ? brandLabel(hostOf(target.url)) : '';
  // (a site that renames itself usually keeps a part of its name: "old-example" and "new-example" share "example")
  const brandParts = brand.length >= 3 ? [brand, ...significantTokens(brand.replace(/[-_]/g, ' ')).filter((p) => p.length >= 4 && p !== brand)] : [];
  if (nameTokens.length === 0 && brandParts.length === 0) return { identity: 'unclear', reason: 'there is nothing to compare the page with' };
  const head = pageHead(snapshot);
  const body = pageBody(snapshot);
  // (the name IS the address's own brand: example.com moved to example.org)
  const landedBrand = brandLabel(hostOf(snapshot.url));
  const strongName = nameTokens.filter((t) => head.includes(t) || landedBrand === t);
  const weakName = nameTokens.filter((t) => !strongName.includes(t) && body.includes(t));
  const brandStrong = brandParts.filter((p) => head.includes(p) || landedBrand === p);
  const brandWeak = brandParts.filter((p) => !brandStrong.includes(p) && body.includes(p));
  const landed = snapshot.url;
  let identity: Identity =
    (nameTokens.length > 0 && strongName.length >= neededOf(nameTokens.length)) || brandStrong.length > 0
      ? 'verified'
      : strongName.length + weakName.length + brandWeak.length > 0
        ? 'unclear'
        : 'mismatch';
  const reasons: string[] = [];
  if (identity === 'verified') reasons.push(`its address, title or headings match "${[...strongName, ...brandStrong].join(' ')}"`);
  else if (identity === 'unclear') reasons.push(`"${[...strongName, ...weakName, ...brandWeak].join(' ')}" is on the page, but not in its address, title or headings`);
  else reasons.push(`nothing on the page matches "${[...nameTokens, ...brandParts].join(' ')}"`);
  // A site of the kind that exists to give things away without permission, or an address ending that is mostly spam, is never "verified" by a name alone.
  if (identity === 'verified' && trustOf(landed).kind === 'poor' && (target.url === undefined || !sameSite(target.url, landed))) {
    identity = 'unclear';
    reasons.push('but it is an address of the kind that is often a copy or a scam');
  }
  return { identity, reason: reasons.join('; ') };
}

const PARKED = /(this domain (name )?(may be|is|could be) (for sale|available)|domain (name )?is for sale|buy this domain|domain (has )?expired|this domain is parked|parked (free|domain|by)|hugedomains|sedo\.com|dan\.com|afternic|the domain .{0,40} (is|has been) (suspended|seized|taken down)|domain (has been )?seized)/i;
const ERROR_PAGE = /(page not found|404 not found|\b404\b.{0,20}(error|not found)|403 forbidden|access denied|502 bad gateway|503 service unavailable|service temporarily unavailable|account suspended|this site can.?t be reached|site not found|website (is )?(closed|no longer available)|no longer available)/i;

export function isParkedPage(s: PageSnapshot): boolean {
  return PARKED.test(`${s.title} ${s.headings.join(' ')} ${(s.visibleText ?? '').slice(0, 1500)}`);
}

export function looksLikeErrorPage(s: PageSnapshot): boolean {
  const small = (s.visibleText ?? '').length < 600 && s.links.length < 12;
  return small && ERROR_PAGE.test(`${s.title} ${s.headings.join(' ')} ${(s.visibleText ?? '').slice(0, 600)}`);
}

/** A page with nothing on it yet (it may still be building itself). */
export function isThin(s: PageSnapshot): boolean {
  return (s.visibleText ?? '').trim().length < 20 && s.links.length + s.buttons.length + s.inputs.length < 3 && s.headings.length === 0;
}

/** What the page says went wrong with it, if anything: an error answer from the site, a parked or error page, a blank page. */
export function problemOfPage(s: PageSnapshot, requested: string): NavigationProblem | null {
  for (const note of s.notes ?? []) {
    const m = /answered "(\d{3})"/.exec(note);
    if (m !== null) {
      const problem = describeHttpStatus(Number(m[1]), s.url || requested);
      if (problem !== null) return problem;
    }
  }
  if (isParkedPage(s)) {
    return { kind: 'not_found', retryable: false, message: `${hostOf(s.url) || hostOf(requested)} now shows a "domain for sale" or closed-down page: the site has moved or gone.` };
  }
  if (looksLikeErrorPage(s)) {
    return { kind: 'not_found', retryable: false, message: `${hostOf(s.url) || hostOf(requested)} opened, but only to an error page ("${(s.title || s.headings[0] || 'not found').slice(0, 60)}").` };
  }
  if (isThin(s)) {
    return { kind: 'empty', retryable: true, message: `${hostOf(s.url) || hostOf(requested)} opened as a blank page.` };
  }
  return null;
}

/** How much of what was asked for is on the page: words found, and words asked for (matched in the title, headings, text, links and buttons). */
export function contentMatch(s: PageSnapshot, expect: readonly string[], strict = false): { readonly found: number; readonly total: number; readonly ok: boolean } {
  const words = expect.map((w) => w.toLowerCase().trim()).filter((w) => w !== '');
  if (words.length === 0) return { found: 0, total: 0, ok: true };
  const hay = `${s.title} ${s.headings.join(' ')} ${s.visibleText ?? ''} ${s.links.join(' ')} ${s.buttons.join(' ')} ${(s.tables ?? []).map((t) => `${t.headers.join(' ')} ${t.rows.map((r) => r.join(' ')).join(' ')}`).join(' ')}`.toLowerCase();
  const found = words.filter((w) => hay.includes(w)).length;
  // (strict, for a page found by search for the person's own words: the words every page of a site carries - its name - must not be enough on their own)
  const needed = strict ? (words.length <= 3 ? words.length : Math.ceil(words.length * 0.8)) : words.length <= 2 ? words.length : Math.ceil(words.length * 0.6);
  return { found, total: words.length, ok: found >= needed };
}

// ------------------------------------------------------------------------------------- candidates from a search
export interface Candidate {
  readonly url: string;
  readonly host: string;
  readonly score: number;
  readonly why: readonly string[];
}

/** Pages that can vouch for an address (they are evidence, and some of them are also sites in their own right). */
const RELIABLE_SOURCE = /(^|\.)(wikipedia\.org|wikidata\.org|wikimedia\.org|britannica\.com|gov|gov\.in|nic\.in|edu|ac\.in|ac\.uk|edu\.au)$/;
/** Pages that only vouch: an encyclopedia article about a site is not the site. */
const EVIDENCE_ONLY = /(^|\.)(wikipedia\.org|wikidata\.org|wikimedia\.org|britannica\.com)$/;
const HOST_IN_TEXT = /\b((?:[a-z0-9][a-z0-9-]{1,40}\.)+[a-z]{2,10})\b/gi;
export const MIN_CANDIDATE_SCORE = 3;

/**
 * Which results of a search could be the current address of the site that was lost, best first. A result earns trust from its own address
 * (the site's brand in it), its title and snippet, and from a reliable source (an encyclopedia, a government or a university page) naming the
 * address; it loses it for being a short link, a bare number or a program file. Addresses already tried, search engines, and sites of the kind
 * that give things away without permission are never offered.
 */
export function rankCandidates(
  hits: readonly WebSearchHit[],
  ctx: { readonly name: string; readonly oldHost: string; readonly triedHosts: ReadonlySet<string> },
): Candidate[] {
  const tokens = significantTokens(ctx.name);
  const oldBrand = brandLabel(ctx.oldHost);
  if (oldBrand.length >= 3 && !tokens.includes(oldBrand)) tokens.push(oldBrand);
  const byHost = new Map<string, { url: string; score: number; why: string[] }>();
  const add = (url: string, score: number, why: string): void => {
    const host = hostOf(url);
    if (host === '' || ctx.triedHosts.has(host) || /(^|\.)(duckduckgo|bing|google|yahoo|baidu|yandex)\./.test(host)) return;
    if (isBlockedSite(url) || suspiciousReason(url) !== null) return;
    const have = byHost.get(host);
    if (have === undefined) byHost.set(host, { url, score, why: [why] });
    else {
      have.score += score;
      have.why.push(why);
    }
  };
  for (const hit of hits) {
    const host = hostOf(hit.url);
    if (host === '') continue;
    let score = 0;
    const why: string[] = [];
    if (tokens.some((t) => t.length >= 4 && host.includes(t))) {
      score += 3;
      why.push('its address carries the site\'s name');
    }
    const title = hit.title.toLowerCase();
    const titleHits = tokens.filter((t) => title.includes(t)).length;
    if (titleHits > 0) {
      score += titleHits === tokens.length ? 3 : 2;
      why.push('its title matches');
    }
    if (tokens.some((t) => hit.snippet.toLowerCase().includes(t))) {
      score += 1;
      why.push('its description matches');
    }
    const trust = trustOf(hit.url);
    if (trust.kind === 'official' || trust.kind === 'legal' || trust.kind === 'reference') score += 2;
    if (trust.kind === 'poor') score -= 3;
    if (score > 0 && !EVIDENCE_ONLY.test(host)) add(hit.url, score, why.join(', '));
    // A reliable page that names an address: that address is a candidate, however the search ranked it.
    if (RELIABLE_SOURCE.test(host)) {
      for (const m of `${hit.snippet} ${hit.title}`.matchAll(HOST_IN_TEXT)) {
        const named = (m[1] ?? '').toLowerCase().replace(/^www\./, '');
        if (named === host || !tokens.some((t) => t.length >= 4 && named.includes(t))) continue;
        add(`https://${named}/`, 3, `named by ${host}`);
      }
    }
  }
  return [...byHost.entries()]
    .map(([host, v]): Candidate => ({ url: v.url, host, score: v.score, why: v.why }))
    .filter((c) => c.score >= MIN_CANDIDATE_SCORE)
    .sort((a, b) => b.score - a.score);
}

/**
 * Which results of a search fit what the person asked for (no site was named, so any good page will do), best first: the words in the title
 * count most, then in the description and the address; reliable kinds of site (official, legal, archive, education, reference, news) are
 * preferred and poor ones are held back. Search engines, short links, bare numbers, program files, addresses already tried, and sites that
 * give things away without permission are never offered.
 */
export function rankResults(hits: readonly WebSearchHit[], words: readonly string[], triedUrls: ReadonlySet<string>): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const hit of hits) {
    const host = hostOf(hit.url);
    if (host === '' || triedUrls.has(hit.url) || /(^|\.)(duckduckgo|bing|google|yahoo|baidu|yandex)\./.test(host)) continue;
    if (isBlockedSite(hit.url) || suspiciousReason(hit.url) !== null) continue;
    const title = hit.title.toLowerCase();
    const snippet = hit.snippet.toLowerCase();
    let score = 0;
    const why: string[] = [];
    const inTitle = words.filter((w) => title.includes(w)).length;
    const inSnippet = words.filter((w) => !title.includes(w) && snippet.includes(w)).length;
    if (inTitle > 0) {
      score += inTitle * 2;
      why.push('its title matches');
    }
    if (inSnippet > 0) {
      score += inSnippet;
      why.push('its description matches');
    }
    if (words.some((w) => w.length >= 4 && host.includes(w))) score += 1;
    const trust = trustOf(hit.url);
    if (trust.kind === 'official' || trust.kind === 'legal' || trust.kind === 'archive' || trust.kind === 'education' || trust.kind === 'reference') {
      score += 2;
      why.push('a reliable kind of site');
    } else if (trust.kind === 'news') score += 1;
    else if (trust.kind === 'poor') score -= 3;
    if (score >= 2 && !out.has(hit.url)) out.set(hit.url, { url: hit.url, host, score, why });
  }
  return [...out.values()].sort((a, b) => b.score - a.score);
}
