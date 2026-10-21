/**
 * Turning a web page's HTML into what a person would read: the title, the words, and the links. No HTML library is needed for that: the
 * job is "good enough to judge whether this page is about the thing and where its documents are", not to render it.
 */

export interface PageLink {
  readonly text: string;
  readonly url: string;
}

export interface ExtractedPage {
  readonly title: string;
  readonly description: string;
  /** The readable text, whitespace collapsed, capped. */
  readonly text: string;
  readonly headings: readonly string[];
  readonly links: readonly PageLink[];
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
  middot: '·',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** A tag, attributes and all: a quoted attribute may hold a ">" (Wikipedia puts whole JSON documents in them), so it is not "up to the next >". */
const TAG = /<\/?[a-zA-Z][^\s>/]*(?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>/g;
export const stripTags = (s: string): string => s.replace(TAG, ' ');
const tidy = (s: string): string => decodeEntities(stripTags(s)).replace(/\s+/g, ' ').trim();

function between(html: string, open: RegExp): string {
  const m = open.exec(html);
  return m?.[1] !== undefined ? tidy(m[1]) : '';
}

function metaContent(html: string, key: string): string {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (new RegExp(`(?:name|property)\\s*=\\s*["']${key}["']`, 'i').test(tag)) {
      const c = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag);
      const v = c?.[1] ?? c?.[2];
      if (v !== undefined) return decodeEntities(v).replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

function resolve(href: string, base: string): string | null {
  const h = decodeEntities(href).trim();
  if (h === '' || h.startsWith('#') || /^(?:javascript|mailto|tel|data):/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username !== '' || u.password !== '') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

const MAX_TEXT = 60_000;
const MAX_LINKS = 400;

export function extractPage(html: string, baseUrl: string): ExtractedPage {
  const head = html.slice(0, 200_000);
  const title = between(head, /<title[^>]*>([\s\S]*?)<\/title>/i) || metaContent(head, 'og:title');
  const description = metaContent(head, 'description') || metaContent(head, 'og:description');

  // Without scripts, styles and the like; the main part of the page when it names one.
  let body = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template|iframe|canvas|head)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  const links: PageLink[] = [];
  const seen = new Set<string>();
  // Links come from the whole page (a document link often sits in a sidebar or a footer), the words from the main part.
  for (const m of body.matchAll(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = resolve(m[1] ?? m[2] ?? '', baseUrl);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    links.push({ text: tidy(m[3] ?? '').slice(0, 140), url });
    if (links.length >= MAX_LINKS) break;
  }
  if (main?.[2] !== undefined && tidy(main[2]).length > 400) body = main[2];
  else body = body.replace(/<(nav|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ');

  const headings: string[] = [];
  for (const m of body.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const h = tidy(m[2] ?? '');
    if (h !== '' && h.length < 200 && headings.length < 20) headings.push(h);
  }

  const text = decodeEntities(
    body
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/table)\b[^>]*>/gi, '\n')
      .replace(TAG, ' '),
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT);

  return { title, description, text, headings, links };
}

/** Whether a link looks like it leads to a document rather than another page (the file ending, or the words on and around it). */
export function looksLikeDocumentLink(link: PageLink): 'pdf' | 'maybe' | null {
  let path = '';
  try {
    path = new URL(link.url).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (/\.pdf$/.test(path)) return 'pdf';
  const text = link.text.toLowerCase();
  if (/\b(pdf|download|full text|full judgment|judgement|order copy|copy of order|view document|read online)\b/.test(text)) {
    if (/\.(zip|exe|msi|apk|rar|7z|dmg|iso|torrent)$/.test(path)) return null;
    return /\bpdf\b/.test(text) || /(download|document|file|attach|upload|pdf|judg|order)/.test(path) ? 'maybe' : null;
  }
  if (/(\/|=)(pdf|download|getpdf|viewpdf|showpdf)(\/|$|\?|=)/.test(link.url.toLowerCase())) return 'maybe';
  return null;
}
