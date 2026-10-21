import { rootLogger } from '@main/logging/logger';
import { extractPage, looksLikeDocumentLink } from './htmlText';
import type { ExtractedPage, PageLink } from './htmlText';
import { archiveFile, archiveSearch, LEGAL_NOTE, watchOptionsFrom } from './media';
import type { FreeCopy, WatchOption } from './media';
import { followUpQueries, hasTerm, keyTerms, leadsFrom, mediaTitle, planQueries, siteQueries, siteRestriction, siteSearchUrls, termWeights, weightedCoverage } from './queries';
import type { ResearchKind } from './queries';
import { searchOne } from './searchResults';
import type { Engine, SearchHit } from './searchResults';
import { domainOf, isBlockedSite, trustOf } from './trust';
import type { SiteKind } from './trust';
import type { WebFetcher } from './webFetch';

const log = rootLogger.child('research');

export interface ResearchRequest {
  readonly question: string;
  readonly kind: ResearchKind;
  /** A site or address the person named: it is looked in first, on its own. */
  readonly site?: string;
  readonly thorough?: boolean;
}

export interface SourceFound {
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly siteKind: SiteKind;
  readonly trust: number;
  /** Why it is in the list, in a few words. */
  readonly why: string;
  readonly excerpts: readonly string[];
}

export interface DocumentFound {
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly sizeBytes: number | null;
  /** Checked: the address really gives a PDF (it begins with the PDF marker). */
  readonly verified: boolean;
  /** Where it was found: the page that links to it, or "search result". */
  readonly from: string;
  readonly trust: number;
}

export interface ResearchReport {
  readonly question: string;
  readonly kind: ResearchKind;
  readonly topic: string;
  readonly queries: readonly string[];
  readonly searched: number;
  readonly pagesRead: number;
  /** What the named site gave, when the person named one. */
  readonly namedSite?: { readonly domain: string; readonly found: number };
  readonly sources: readonly SourceFound[];
  readonly documents: readonly DocumentFound[];
  /** Films and songs: where it can be watched or heard on an official platform. */
  readonly watch?: readonly WatchOption[];
  /** Films and songs: copies that are legally free to keep (public domain or openly licensed). */
  readonly freeCopies?: readonly FreeCopy[];
  readonly notes: readonly string[];
  readonly elapsedMs: number;
  readonly fromCache?: boolean;
}

export interface ResearcherDeps {
  readonly fetcher: WebFetcher;
  readonly now?: () => number;
  /** A search done another way (the user's browser), when the plain search engines give nothing. */
  readonly fallbackSearch?: (query: string) => Promise<readonly SearchHit[]>;
  readonly engines?: readonly Engine[];
  /** A short pause between searches, so a search engine is not hammered. Tests turn it off. */
  readonly searchGapMs?: number;
}

type Progress = (message: string) => void;

const CACHE_MS = 30 * 60_000;
const BUDGET_MS = 60_000;
const BUDGET_THOROUGH_MS = 100_000;

/** Runs `fn` over `items`, at most `limit` at a time, in order of the results. Never rejects (a failing item is undefined). */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<Array<R | undefined>> {
  const out: Array<R | undefined> = new Array(items.length).fill(undefined);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i] as T, i);
      } catch {
        out[i] = undefined;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The share of `terms` that appear in `text` (0 to 1). */
export function coverage(text: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const t = text.toLowerCase();
  let hit = 0;
  for (const term of terms) if (hasTerm(t, term)) hit += 1;
  return hit / terms.length;
}

/** The few sentences of a text that talk most about the terms. */
export function bestPassages(text: string, terms: readonly string[], count = 3): string[] {
  if (terms.length === 0) return [];
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 40 && s.length <= 420);
  const scored = sentences
    .map((s) => ({ s, score: coverage(s, terms) + (/\d/.test(s) ? 0.05 : 0) }))
    .filter((x) => x.score >= Math.min(0.34, 1 / terms.length + 0.01))
    .sort((a, b) => b.score - a.score);
  const picked: string[] = [];
  for (const { s } of scored) {
    if (picked.some((p) => p.includes(s.slice(0, 50)) || s.includes(p.slice(0, 50)))) continue;
    picked.push(s.length > 260 ? `${s.slice(0, 259)}…` : s);
    if (picked.length >= count) break;
  }
  return picked;
}

interface Candidate {
  readonly hit: SearchHit;
  score: number;
  seen: number;
}

/** The title of a bot-check or error page. */
const BOT_WALL = /^(?:client challenge|just a moment|access denied|attention required|are you a robot|403 forbidden|404|page not found|error|security check|verify you are human)\b/i;
/** Documents that are about running an office, not about the subject. */
const NOISE_DOC = /(exam[-_ ]?objection|objection|circular|notice|tender|recruit|vacan|advertis|syllabus|admit[-_ ]?card|time[-_ ]?table|roster|cause[-_ ]?list|office[-_ ]?order|corrigendum)/i;

/** Documents every site of an office carries in its menus and footer, whatever the page is about. */
const SITE_CHROME = /(charter|practice[-_ ]and[-_ ]procedure|procedure|privacy[-_ ]policy|terms[-_ ]and|disclaimer|accessibility|sitemap|site[-_ ]map|handbook|manual|guidelines|rti|annual[-_ ]report|organi[sz]ation|faq|help[-_ ]?line|contact)/i;

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** An address's path as words ("Kesavananda-Bharati-v-State" → "Kesavananda Bharati v State"). */
function readablePath(url: string): string {
  let p = safePath(url);
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep it as it is
  }
  return p.replace(/[-_.+/]+/g, ' ');
}

const isPdfUrl = (url: string): boolean => {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

/**
 * Researches a question across the open web the way a careful person would: several searches phrased differently, the best pages read
 * for real, the leads they give (a citation, a case number) searched in a second round, and the documents found checked to be what they
 * claim before any is offered. It uses no AI itself — the model that asked reads the report and answers — so it costs no allowance.
 */
export class Researcher {
  private readonly cache = new Map<string, { readonly at: number; readonly report: ResearchReport }>();
  private readonly inflight = new Map<string, Promise<ResearchReport>>();
  private readonly now: () => number;

  constructor(private readonly deps: ResearcherDeps) {
    this.now = deps.now ?? Date.now;
  }

  async research(req: ResearchRequest, onProgress: Progress = () => undefined): Promise<ResearchReport> {
    const key = `${req.kind}|${req.question.trim().toLowerCase()}|${(req.site ?? '').toLowerCase()}|${req.thorough === true}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && this.now() - cached.at < CACHE_MS) return { ...cached.report, fromCache: true };
    // The same research asked again while it is still running (the first answer timed out and the request was tried again) joins it.
    const running = this.inflight.get(key);
    if (running !== undefined) return running;
    const job = this.run(req, onProgress)
      .then((report) => {
        // Only a research that found something is worth remembering: asking again later should try again.
        if (report.sources.length > 0 || report.documents.length > 0 || (report.watch?.length ?? 0) > 0 || (report.freeCopies?.length ?? 0) > 0) {
          this.cache.set(key, { at: this.now(), report });
        }
        return report;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  /** Asks a named site's own search box (by the address patterns sites use), and gives back the pages worth reading from its answers. */
  private async searchNamedSite(domain: string, searches: readonly string[], cov: (text: string) => number, left: () => number): Promise<string[]> {
    const results: string[] = [];
    // Which of the usual search-box addresses this site answers to is found once, and the next search goes straight to it.
    let working: number | null = null;
    for (const search of searches) {
      if (left() < 12_000 || results.length >= 6) break;
      const all = siteSearchUrls(domain, search);
      const urls = working === null ? all : [all[working] as string];
      const fetched = await mapLimit(urls, 5, (url) => this.deps.fetcher.page(url, { timeoutMs: Math.min(10_000, Math.max(3_000, left() - 8_000)) }));
      for (let i = 0; i < fetched.length; i += 1) {
        const f = fetched[i];
        if (f === undefined || !f.ok || f.text === '') continue;
        const page = extractPage(f.text, f.url);
        // A results page that really has the topic in it (not a "nothing found" page, a home page or a log-in).
        if (cov(`${page.title} ${page.text.slice(0, 30_000)}`) < 0.34) continue;
        if (working === null) working = all.indexOf(urls[i] as string);
        if (!results.includes(f.url)) results.push(f.url);
        const digs = page.links
          .filter((l) => domainOf(l.url) === domain || domainOf(l.url).endsWith(`.${domain}`))
          .map((l) => ({ l, c: cov(`${l.text} ${readablePath(l.url)}`) }))
          .filter((x) => x.c >= 0.4 && x.l.text.length > 8)
          .sort((a, b) => b.c - a.c)
          .slice(0, 4);
        for (const d of digs) if (!results.includes(d.l.url)) results.push(d.l.url);
        break;
      }
    }
    return results.slice(0, 6);
  }

  private async run(req: ResearchRequest, onProgress: Progress): Promise<ResearchReport> {
    const started = this.now();
    const deadline = started + (req.thorough === true ? BUDGET_THOROUGH_MS : BUDGET_MS);
    const left = (): number => deadline - this.now();
    const plan = planQueries(req.question, req.kind, { ...(req.site !== undefined ? { site: req.site } : {}), ...(req.thorough !== undefined ? { thorough: req.thorough } : {}) });
    // (For a film or song the title is what is matched, not "full movie download".)
    const subject = req.kind === 'media' ? mediaTitle(req.question) : req.question;
    const terms = keyTerms(subject);
    const weights = termWeights(subject);
    const cov = (text: string): number => weightedCoverage(text, terms, weights);
    const notes: string[] = [];
    const named = siteRestriction(req.site);
    log.info('research started', { kind: req.kind, topic: plan.topic, queries: plan.queries.length, site: named?.domain });

    // ------------------------------------------------------------------------------------------------ 1. search
    const candidates = new Map<string, Candidate>();
    let searched = 0;
    const addHits = (hits: readonly SearchHit[]): void => {
      hits.forEach((hit, index) => {
        if (isBlockedSite(hit.url)) return;
        const trust = trustOf(hit.url);
        const rel = cov(`${hit.title} ${hit.snippet} ${hit.url}`);
        const phrase = plan.topic.length > 6 && `${hit.title} ${hit.snippet}`.toLowerCase().includes(plan.topic.toLowerCase()) ? 0.2 : 0;
        const pdf = req.kind === 'documents' && isPdfUrl(hit.url) ? 0.25 : 0;
        const poor = trust.kind === 'poor' ? 0.4 : 1;
        const score = (0.55 * rel + phrase + 0.35 * (trust.score / 100) + pdf + (1 - Math.min(index, 10) * 0.03) * 0.05) * poor;
        const have = candidates.get(hit.url);
        if (have === undefined) candidates.set(hit.url, { hit, score, seen: 1 });
        else {
          have.score = Math.max(have.score, score) + 0.04; // found by more than one search: a little more likely to be right
          have.seen += 1;
        }
      });
    };
    const engines = this.deps.engines ?? (['duckduckgo', 'bing'] as const);
    const searchQuery = async (q: string, i: number): Promise<void> => {
      if (left() < 4_000) return;
      onProgress(`Searching the web (${Math.min(i + 1, plan.queries.length)} of ${plan.queries.length})…`);
      if ((this.deps.searchGapMs ?? 250) > 0 && i > 0) await new Promise((r) => setTimeout(r, (this.deps.searchGapMs ?? 250) * (i % 3)));
      let hits = await searchOne(this.deps.fetcher, engines[0] ?? 'duckduckgo', q);
      searched += 1;
      // A second opinion for the first few searches, and for any search the first engine gave little for.
      if (engines[1] !== undefined && (hits.length < 4 || i < 3)) hits = [...hits, ...(await searchOne(this.deps.fetcher, engines[1], q))];
      if (hits.length === 0 && this.deps.fallbackSearch !== undefined) hits = [...(await this.deps.fallbackSearch(q).catch(() => []))];
      addHits(hits);
    };
    const archiveLookup = req.kind === 'media' ? archiveSearch(this.deps.fetcher, mediaTitle(req.question)).catch(() => [] as FreeCopy[]) : Promise.resolve([] as FreeCopy[]);
    await mapLimit(plan.queries, 3, searchQuery);

    // ------------------------------------------------------------------------------------------------ 2. read the best pages
    const direct = named?.url !== null && named !== null ? named.url : null;
    const pagesRead = new Map<string, { readonly page: ExtractedPage; readonly url: string; readonly score: number; readonly words: number }>();
    const readPages = async (urls: readonly string[]): Promise<void> => {
      let done = 0;
      await mapLimit(urls, 4, async (url) => {
        if (left() < 3_000) return;
        const fetched = await this.deps.fetcher.page(url, { timeoutMs: Math.min(12_000, Math.max(3_000, left() - 1_000)) });
        done += 1;
        onProgress(`Reading sites (${done} of ${urls.length})…`);
        if (!fetched.ok || fetched.text === '' || /pdf/i.test(fetched.contentType)) return;
        const page = extractPage(fetched.text, fetched.url);
        const body = `${page.title} ${page.description} ${page.text.slice(0, 20_000)}`;
        pagesRead.set(url, { page, url: fetched.url, score: cov(body), words: Math.round(coverage(body, terms) * terms.length) });
      });
    };
    const pickPages = (max: number, skip: ReadonlySet<string>): string[] => {
      const perDomain = new Map<string, number>();
      const out: string[] = [];
      for (const c of [...candidates.values()].sort((a, b) => b.score - a.score)) {
        if (skip.has(c.hit.url) || isPdfUrl(c.hit.url)) continue;
        const d = domainOf(c.hit.url);
        if ((perDomain.get(d) ?? 0) >= 2) continue;
        perDomain.set(d, (perDomain.get(d) ?? 0) + 1);
        out.push(c.hit.url);
        if (out.length >= max) break;
      }
      return out;
    };
    const first = [...(direct !== null ? [direct] : []), ...pickPages(req.thorough === true ? 10 : 6, new Set(direct !== null ? [direct] : []))];
    // A site the person named: its own search is asked directly (the web search engines know only part of any site), and the best of what
    // that gives is read too.
    if (named !== null && left() > 15_000) {
      onProgress(`Looking on ${named.domain}…`);
      const found = await this.searchNamedSite(named.domain, siteQueries(req.question), cov, left);
      first.push(...found.filter((u) => !first.includes(u)));
    }
    await readPages(first);

    // ------------------------------------------------------------------------------------------------ 3. follow the leads
    if (left() > 18_000) {
      const texts = [...[...pagesRead.values()].map((p) => p.page.text.slice(0, 30_000)), ...[...candidates.values()].map((c) => `${c.hit.title}. ${c.hit.snippet}`)];
      const leads = leadsFrom(texts, plan.topic, req.thorough === true ? 5 : 3);
      if (leads.length > 0) {
        onProgress('Following up what I found…');
        const second = followUpQueries(leads, req.kind);
        await mapLimit(second, 3, async (q, i) => {
          if (left() < 8_000) return;
          searched += 1;
          addHits(await searchOne(this.deps.fetcher, engines[0] ?? 'duckduckgo', q));
          void i;
        });
        await readPages(pickPages(3, new Set(pagesRead.keys())));
      }
    }

    // ------------------------------------------------------------------------------------------------ 4. what was found
    const sources: SourceFound[] = [];
    for (const [url, { page, url: finalUrl, score, words }] of [...pagesRead.entries()].sort((a, b) => b[1].score - a[1].score)) {
      const trust = trustOf(finalUrl);
      if (trust.kind === 'poor') continue;
      // A site's "checking your browser" wall, or a page that says nothing about the topic, is not a source.
      if (BOT_WALL.test(page.title) || (terms.length > 0 && score < 0.2)) continue;
      const excerpts = bestPassages(`${page.description}\n${page.text}`, terms, 3);
      const cand = candidates.get(url);
      const why = [
        trust.kind === 'official' ? 'official site' : trust.kind === 'legal' ? 'legal publisher' : trust.kind === 'archive' ? 'public archive' : trust.kind === 'education' ? 'university' : trust.kind === 'reference' ? 'reference' : trust.kind === 'news' ? 'news' : null,
        `mentions ${words} of ${terms.length} key words`,
        cand !== undefined && cand.seen > 1 ? `found by ${cand.seen} searches` : null,
      ]
        .filter((x): x is string => x !== null)
        .join(' · ');
      sources.push({ title: page.title || domainOf(finalUrl), url: finalUrl, domain: domainOf(finalUrl), siteKind: trust.kind, trust: trust.score, why, excerpts });
    }
    // Those that said something about it, from the more trusted sites, first.
    const worth = (s: SourceFound): number => s.trust * 0.4 + (s.excerpts.length > 0 ? 60 : 0);
    sources.sort((a, b) => worth(b) - worth(a));

    // Documents: PDFs that came up as results, and the document links on the pages that were read.
    const docCandidates = new Map<string, { title: string; from: string; score: number }>();
    const addDoc = (url: string, title: string, from: string, base: number, strongPage = false): void => {
      if (isBlockedSite(url)) return;
      const trust = trustOf(url);
      // The address names the document more reliably than the link text does; a PDF of notices, circulars or exam papers is not it.
      const named = cov(readablePath(url));
      // (A document that an official page about exactly this topic links to is the one, whatever the file is called.)
      const label = `${safePath(url)} ${title}`;
      // A document found only as a search result, with nothing about the topic in its name or title, is noise (a circular, a form).
      if (!strongPage && cov(`${title} ${url}`) === 0) return;
      // A menu or footer document that does not even name the topic is never what was asked for.
      if (SITE_CHROME.test(label) && !SITE_CHROME.test(req.question) && cov(`${title} ${url}`) < 0.34) return;
      const noise = (!strongPage && NOISE_DOC.test(label) && !NOISE_DOC.test(req.question) ? 0.35 : 0) + (SITE_CHROME.test(label) && !SITE_CHROME.test(req.question) ? 0.5 : 0);
      const score = base + 0.25 * (trust.score / 100) + 0.45 * cov(`${title} ${url}`) + 0.3 * named - noise;
      const have = docCandidates.get(url);
      if (have === undefined || score > have.score) docCandidates.set(url, { title: title || url, from, score });
    };
    for (const c of candidates.values()) if (isPdfUrl(c.hit.url)) addDoc(c.hit.url, c.hit.title, 'search result', 0.15 + Math.min(c.seen, 3) * 0.03);
    for (const { page, url: pageUrl, score } of pagesRead.values()) {
      const links: readonly PageLink[] = page.links;
      let kept = 0;
      for (const link of links) {
        const kind = looksLikeDocumentLink(link);
        if (kind === null) continue;
        // A page is "exactly about it" when its own title and address say so (not just its text: a court's home page mentions everything).
        const strong = score >= 0.8 && trustOf(pageUrl).score >= 80 && cov(`${page.title} ${readablePath(pageUrl)}`) >= 0.6;
        const linkRel = cov(`${link.text} ${readablePath(link.url)}`);
        const relevant = linkRel >= 0.34 || strong;
        if (!relevant) continue;
        addDoc(link.url, link.text || page.title, pageUrl, (kind === 'pdf' ? 0.12 : 0.04) + (strong ? 0.3 : 0), strong);
        kept += 1;
        if (kept >= 8) break;
      }
    }
    const topDocs = [...docCandidates.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 10);
    const documents: DocumentFound[] = [];
    const docScore = new Map<string, number>();
    if (topDocs.length > 0 && left() > 2_000) {
      onProgress(`Checking ${topDocs.length} documents…`);
      const probes = await mapLimit(topDocs, 4, (d) => this.deps.fetcher.probeDocument(d[0], Math.min(10_000, Math.max(2_000, left()))));
      topDocs.forEach(([url, d], i) => {
        const probe = probes[i];
        if (probe === undefined || !probe.ok || !probe.isPdf) return;
        const trust = trustOf(probe.url);
        documents.push({ title: tidyTitle(betterTitle(d.title, probe.url, cov)), url: probe.url, domain: domainOf(probe.url), sizeBytes: probe.sizeBytes, verified: true, from: d.from === 'search result' ? 'search result' : domainOf(d.from), trust: trust.score });
        docScore.set(probe.url, d.score);
        void url;
      });
    }
    documents.sort((a, b) => (docScore.get(b.url) ?? 0) - (docScore.get(a.url) ?? 0));

    let watch: WatchOption[] | undefined;
    let freeCopies: FreeCopy[] | undefined;
    if (req.kind === 'media') {
      // Only the platform pages that are about THIS title (a search for one film also returns another with a similar name).
      watch = watchOptionsFrom(
        [...candidates.values()]
          .sort((a, b) => b.score - a.score)
          .map((c) => c.hit)
          .filter((h) => coverage(`${h.title} ${h.url}`, terms.filter((t) => !/^\d+$/.test(t))) >= 0.6),
      ).slice(0, 8);
      const found = await archiveLookup;
      // The ones with a clear public-domain or open licence first, then the most-watched.
      // Only copies whose rights are clear are offered: the rest of what the Archive holds under this name may be someone's pirated upload.
      const ordered = found.filter((c) => c.freeToKeep).sort((a, b) => b.downloads - a.downloads).slice(0, 5);
      if (found.length > 0 && ordered.length === 0) notes.push("The Internet Archive had uploads under that name, but I couldn't confirm any is public domain or openly licensed, so I left them out.");
      const files = await mapLimit(ordered.slice(0, 2), 2, (c) => archiveFile(this.deps.fetcher, c));
      freeCopies = ordered.map((c, i) => {
        const f = i < 2 ? files[i] : undefined;
        return f !== undefined && f !== null ? { ...c, fileUrl: f.url, fileSizeBytes: f.sizeBytes } : c;
      });
      notes.push(LEGAL_NOTE);
      if (watch.length === 0 && freeCopies.length === 0) notes.push('I found no official place that has it.');
    }

    if (named !== null) {
      const onNamed = [...sources, ...documents].filter((x) => x.domain === named.domain || x.domain.endsWith(`.${named.domain}`)).length;
      if (onNamed === 0) notes.push(`Nothing from ${named.domain} matched, so I searched the rest of the web.`);
    }
    if (req.kind === 'documents' && documents.length === 0) notes.push('No PDF could be confirmed. The pages listed may still have it behind a button or a search form.');
    if (sources.length === 0 && documents.length === 0) notes.push('Nothing useful came back: the search engines may be blocking automated searches right now, or the topic is too specific.');
    if (left() <= 0) notes.push('I stopped at the time limit; asking for a thorough search goes deeper.');

    const report: ResearchReport = {
      question: req.question,
      kind: req.kind,
      topic: plan.topic,
      queries: plan.queries,
      searched,
      pagesRead: pagesRead.size,
      ...(named !== null
        ? { namedSite: { domain: named.domain, found: [...sources, ...documents].filter((x) => x.domain === named.domain || x.domain.endsWith(`.${named.domain}`)).length } }
        : {}),
      sources: sources.slice(0, req.thorough === true ? 10 : 7),
      documents: documents.slice(0, 6),
      ...(watch !== undefined ? { watch } : {}),
      ...(freeCopies !== undefined ? { freeCopies } : {}),
      notes,
      elapsedMs: this.now() - started,
    };
    log.info('research finished', { sources: report.sources.length, documents: report.documents.length, pages: report.pagesRead, searched, ms: report.elapsedMs });
    return report;
  }
}

/** A search engine titles a PDF with the first line of its text ("JUDIS.NIC.IN SUPREME COURT OF INDIA Page 1 of 502"): when the file's own name says more about the topic, that is the title. */
function betterTitle(title: string, url: string, cov: (text: string) => number): string {
  let file = safePath(url).split('/').pop() ?? '';
  try {
    file = decodeURIComponent(file);
  } catch {
    // keep it as it is
  }
  const fromName = file.replace(/\.pdf$/i, '').replace(/[-_.+]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (fromName.length < 6 || /^\d+$/.test(fromName)) return title;
  return cov(fromName) > cov(title) + 0.2 ? fromName : title;
}

function tidyTitle(title: string): string {
  const t = title.replace(/\s+/g, ' ').replace(/^\[?PDF\]?\s*/i, '').trim();
  return t.length > 120 ? `${t.slice(0, 119)}…` : t;
}
