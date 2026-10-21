/**
 * From what the person said to what to search for. A request is full of words that are about the REQUEST ("I want", "download",
 * "related PDF") and not about the thing; searching with them finds pages about downloading. These turn the sentence into the topic,
 * and the topic into several different searches, because one phrasing never finds everything.
 */

export type ResearchKind = 'answer' | 'documents' | 'media';

const FILLER =
  /\b(?:i|we)\s+(?:want|need|would like|am looking for|'m looking for|wanna|gotta)\b|\b(?:please|kindly|can you|could you|will you|would you|just|hey|eya|for me|to me|me the|me a|me an|some|any)\b|\b(?:find|get|fetch|bring|give|show|search|look up|look for|research|download|downloading|save|collect)\b|\b(?:the|a|an)\s+(?:related|relevant|full|complete|official|free|latest|new)\b|\b(?:related|relevant|free|full text|online|on the internet|on internet|in the internet|entire internet|whole internet|internet|web)\b|\b(?:pdf|pdfs|document|documents|file|files|copy|copies|link|links|site|sites|website|websites)\b/gi;

const STOP = new Set(
  'a an and are as at be by for from has have how i in is it its of on or that the their there this to was were what when where which who why will with you your about into than then them they these those do does did can could should would over under between against during before after above below up down out off again further once here all both each few more most other such only own same so too very s t just also'.split(' '),
);

/** The thing asked about, without the words of asking. */
export function cleanTopic(question: string): string {
  const t = question
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(FILLER, ' ')
    .replace(/[“”"]/g, '"')
    .replace(/[^\p{L}\p{N}\s.,&()'"\-/:]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:of|for|on|about|to|and|the)\s+/i, '')
    .replace(/\s+(?:of|for|on|about|to|and|the)$/i, '')
    .trim();
  return t === '' ? question.trim() : t;
}

/** The title of a film or song without the words around it ("download Raja Harishchandra full movie hd" → "Raja Harishchandra"). */
export function mediaTitle(question: string): string {
  const t = cleanTopic(question)
    .replace(/\b(?:movies?|films?|songs?|videos?|full|hd|4k|1080p|720p|watch|play|online|free|mp3|mp4|music|audio|album|legally|official|trailer|hindi dubbed|dubbed|download|link)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:the|a|an|of|to|for|my|some)\s+/i, '');
  return t === '' ? cleanTopic(question) : t;
}

/** The words worth matching a page against. */
export function keyTerms(question: string): string[] {
  const words = cleanTopic(question)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w));
  return [...new Set(words)];
}

/** Words that fit almost any page about the subject (a court's home page, a dictionary entry) and so say little about whether it is THE page. */
const GENERIC = new Set(
  'judgment judgement judgments supreme court courts case cases order orders act acts law laws legal right rights report reports document documents pdf full text copy online free latest new official india indian state states government govt section article articles constitution high bench petition appeal writ news information details related relevant list guide study analysis summary history overview movie movies film films song songs video videos full watch hd mp3 music album'.split(' '),
);

/**
 * How much each key word says about the page being the right one: the names and numbers in the question (a person, a case, an Act's year)
 * say most, the ordinary subject words some, and the words that fit any page about the field least. Without it "judgment of the Supreme
 * Court on the right to privacy Puttaswamy" matches every court's home page as well as the one case.
 */
export function termWeights(question: string): ReadonlyMap<string, number> {
  const tokens = question.replace(/https?:\/\/\S+/g, ' ').split(/[^\p{L}\p{N}]+/u).filter((t) => t !== '');
  const weights = new Map<string, number>();
  tokens.forEach((token, index) => {
    const word = token.toLowerCase();
    if (word.length < 2 || STOP.has(word)) return;
    let w = 1;
    if (GENERIC.has(word)) w = 0.35;
    else if (/\d/.test(word)) w = 2;
    else if (index > 0 && word.length >= 3 && /^\p{Lu}/u.test(token)) w = 2.5;
    weights.set(word, Math.max(weights.get(word) ?? 0, w));
  });
  return weights;
}

/** The search words for a site's own search box: the names and the subject words, not the generic ones (such a box matches every word, and "judgment of the Supreme Court" is in every judgment). */
export function siteQueries(question: string): string[] {
  const weights = termWeights(question);
  const terms = keyTerms(question);
  const subject = terms.filter((t) => (weights.get(t) ?? 1) >= 1);
  const names = terms.filter((t) => (weights.get(t) ?? 1) >= 2);
  const out: string[] = [];
  for (const words of [subject, names]) {
    const q = words.slice(0, 6).join(' ');
    if (q !== '' && !out.includes(q)) out.push(q);
  }
  if (out.length === 0) out.push(terms.slice(0, 6).join(' '));
  return out.filter((q) => q !== '');
}

/** Whether a (lower-case) text has the word; short words ("hi", "ho", "tum") must stand alone, or "hi" is found inside "Shiva". */
export function hasTerm(lower: string, term: string): boolean {
  if (term.length > 3) return lower.includes(term);
  const isWordChar = (c: string): boolean => /[\p{L}\p{N}]/u.test(c);
  let from = 0;
  for (;;) {
    const i = lower.indexOf(term, from);
    if (i < 0) return false;
    if (!isWordChar(i === 0 ? '' : (lower[i - 1] as string)) && !isWordChar(lower[i + term.length] ?? '')) return true;
    from = i + 1;
  }
}

/**
 * The share of the question's key words that a text has, counting names and numbers for more and generic field words for less; a text that
 * has none of the distinctive words is held down however many generic ones it repeats.
 */
export function weightedCoverage(text: string, terms: readonly string[], weights: ReadonlyMap<string, number>): number {
  if (terms.length === 0) return 0;
  const t = text.toLowerCase();
  let total = 0;
  let got = 0;
  let distinctive = 0;
  let distinctiveGot = 0;
  for (const term of terms) {
    const w = weights.get(term) ?? 1;
    total += w;
    const has = hasTerm(t, term);
    if (has) got += w;
    if (w >= 1) {
      distinctive += 1;
      if (has) distinctiveGot += 1;
    }
  }
  const share = got / total;
  return distinctive > 0 && distinctiveGot === 0 ? share * 0.3 : share;
}

const LEGAL_HINT =
  /\b(?:case|judg(?:e)?ment|order|petition|writ|appeal|bail|fir|v\.?|vs\.?|versus|supreme court|high court|tribunal|act|section|article|constitution|ipc|bns|crpc|bnss|cpc|sc|hc|w\.?p\.?|slp|crl|civil|criminal|advocate|lawyer|court|verdict|ruling|notification|gazette|bare act)\b/i;

export function looksLegal(text: string): boolean {
  return LEGAL_HINT.test(text);
}

/** "a site:... " restriction for a site or address the person named, or null when it is not one. */
export function siteRestriction(site: string | undefined): { readonly domain: string; readonly url: string | null } | null {
  if (site === undefined) return null;
  const s = site.trim().toLowerCase();
  if (s === '') return null;
  try {
    const u = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
    if (!/\./.test(u.hostname)) return null;
    const hasPath = u.pathname !== '/' && u.pathname !== '';
    return { domain: u.hostname.replace(/^www\./, ''), url: hasPath || /^https?:\/\//.test(s) ? u.href : null };
  } catch {
    return null;
  }
}

/** The addresses sites commonly give their own search box (Indian Kanoon, WordPress sites, the usual "search?q="), for a site the person named. */
export function siteSearchUrls(domain: string, topic: string): string[] {
  const q = encodeURIComponent(topic);
  return [
    `https://${domain}/search/?formInput=${q}`,
    `https://${domain}/search?q=${q}`,
    `https://${domain}/?s=${q}`,
    `https://${domain}/search?query=${q}`,
    `https://${domain}/search/${q}`,
  ];
}

/** Free public places a judgment, an Act or a court order is published, to look in by name (they are searched, never assumed to have it). */
const LEGAL_SOURCES = ['indiankanoon.org', 'sci.gov.in', 'ecourts.gov.in', 'indiacode.nic.in', 'scobserver.in'];

export interface QueryPlan {
  readonly queries: readonly string[];
  readonly topic: string;
}

export function planQueries(question: string, kind: ResearchKind, options: { readonly site?: string; readonly thorough?: boolean } = {}): QueryPlan {
  const topic = kind === 'media' ? mediaTitle(question) : cleanTopic(question);
  const site = siteRestriction(options.site);
  const q: string[] = [];
  const add = (s: string): void => {
    const t = s.replace(/\s+/g, ' ').trim();
    if (t !== '' && !q.includes(t)) q.push(t);
  };
  if (site !== null) {
    // What the person named is looked in first, on its own.
    add(`site:${site.domain} ${topic}`);
    if (kind === 'documents') add(`site:${site.domain} ${topic} pdf`);
  }
  if (kind === 'documents') {
    add(`${topic} pdf`);
    add(`${topic} filetype:pdf`);
    add(`${topic} full text download`);
    if (looksLegal(question)) {
      add(`${topic} judgment pdf`);
      for (const s of LEGAL_SOURCES.slice(0, options.thorough === true ? 5 : 3)) add(`site:${s} ${topic}`);
    } else {
      add(`${topic} official document`);
      add(`${topic} report pdf`);
    }
    add(`"${topic}" pdf free`);
  } else if (kind === 'media') {
    add(`${topic} watch online`);
    add(`${topic} where to watch India`);
    add(`${topic} full movie youtube`);
    add(`${topic} streaming OTT`);
    add(`${topic} internet archive`);
  } else {
    add(topic);
    add(`${topic} explained`);
    add(`${topic} latest`);
    if (looksLegal(question)) add(`${topic} law India`);
    if (options.thorough === true) {
      add(`${topic} overview`);
      add(`${topic} history background`);
      add(`${topic} pdf report`);
    }
  }
  return { topic, queries: q.slice(0, options.thorough === true ? 10 : 7) };
}

// ---------------------------------------------------------------------------------------------------------- following leads
/** Citations and case numbers: the exact names a document is filed under, found in what was read. */
const CITATIONS: readonly RegExp[] = [
  /\bAIR\s+\d{4}\s+(?:SC|[A-Z]{2,4})\s+\d{1,5}\b/g,
  /\(\d{4}\)\s*\d{1,3}\s+(?:SCC|SCR|SCALE)\s+\d{1,5}\b/g,
  /\b\d{4}\s+(?:SCC\s+OnLine\s+[A-Za-z]+\s+\d+|INSC\s+\d+|SCC\s+\d+)\b/g,
  /\b(?:W\.?P\.?\s*\(?[A-Z]?\)?|SLP\s*\(?[A-Z]*\)?|Crl\.?\s*A\.?|Civil\s+Appeal|Criminal\s+Appeal|C\.?A\.?|O\.?S\.?|W\.?A\.?)\s*(?:No\.?|Nos\.?)?\s*\d{1,6}\s*(?:of|\/)\s*\d{4}\b/gi,
  /\b[A-Z][A-Za-z.&' ]{2,40}\s+v(?:s)?\.?\s+[A-Z][A-Za-z.&' ]{2,50}\b/g,
];

/** Names worth searching for in a second round, from the text the first round read (most frequent first). */
export function leadsFrom(texts: readonly string[], known: string, max = 4): string[] {
  const count = new Map<string, number>();
  for (const text of texts) {
    for (const re of CITATIONS) {
      for (const m of text.matchAll(re)) {
        const lead = m[0].replace(/\s+/g, ' ').trim();
        if (lead.length < 6 || lead.length > 90) continue;
        count.set(lead, (count.get(lead) ?? 0) + 1);
      }
    }
  }
  const knownLower = known.toLowerCase();
  return [...count.entries()]
    .filter(([lead]) => !knownLower.includes(lead.toLowerCase()))
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, max)
    .map(([lead]) => lead);
}

/** The searches for a second round: each lead on its own as a document. */
export function followUpQueries(leads: readonly string[], kind: ResearchKind): string[] {
  return leads.map((lead) => (kind === 'documents' ? `"${lead}" pdf` : `"${lead}"`));
}
