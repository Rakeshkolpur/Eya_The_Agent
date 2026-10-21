import { describe, it, expect } from 'vitest';
import { decodeEntities, extractPage, looksLikeDocumentLink, stripTags } from '../src/main/research/htmlText';
import { isBlockedSite, streamingPlatform, trustOf } from '../src/main/research/trust';
import { parseBing, parseDuckDuckGo } from '../src/main/research/searchResults';
import {
  cleanTopic,
  followUpQueries,
  hasTerm,
  keyTerms,
  leadsFrom,
  mediaTitle,
  planQueries,
  siteQueries,
  siteRestriction,
  siteSearchUrls,
  termWeights,
  weightedCoverage,
} from '../src/main/research/queries';

describe('htmlText', () => {
  it('decodes entities', () => {
    expect(decodeEntities('Tom &amp; Jerry &#8212; &#x41;&nbsp;b &quot;q&quot;')).toBe('Tom & Jerry — A b "q"');
  });

  it('strips tags even when a quoted attribute holds a ">" (Wikipedia puts JSON in them)', () => {
    expect(stripTags('<span data-x=\'{"a":">"}\'>real text</span>').replace(/\s+/g, ' ').trim()).toBe('real text');
  });

  it('extracts title, description, readable text and links, and leaves scripts out', () => {
    const html = `<html><head><title>Case &amp; Law</title><meta name="description" content="A summary"><script>var x = "secret";</script></head>
      <body><nav><a href="/menu">Menu</a></nav><main><h1>The case</h1><p>${'Words about the case. '.repeat(40)}</p>
      <a href="/files/judgment.pdf">Full judgment (PDF)</a><a href="mailto:a@b.c">mail</a><a href="#top">top</a></main></body></html>`;
    const page = extractPage(html, 'https://example.org/case/1');
    expect(page.title).toBe('Case & Law');
    expect(page.description).toBe('A summary');
    expect(page.text).toContain('Words about the case.');
    expect(page.text).not.toContain('secret');
    expect(page.headings).toEqual(['The case']);
    const urls = page.links.map((l) => l.url);
    expect(urls).toContain('https://example.org/files/judgment.pdf');
    expect(urls.some((u) => u.startsWith('mailto'))).toBe(false);
  });

  it('recognises links that lead to documents', () => {
    expect(looksLikeDocumentLink({ text: 'x', url: 'https://a.org/f/order.PDF' })).toBe('pdf');
    expect(looksLikeDocumentLink({ text: 'Download PDF', url: 'https://a.org/download?id=3' })).toBe('maybe');
    expect(looksLikeDocumentLink({ text: 'Home', url: 'https://a.org/' })).toBeNull();
    expect(looksLikeDocumentLink({ text: 'Download', url: 'https://a.org/setup.exe' })).toBeNull();
  });
});

describe('trust', () => {
  it('ranks official and legal sites above general ones and never trusts piracy-looking domains', () => {
    expect(trustOf('https://www.sci.gov.in/x').kind).toBe('official');
    expect(trustOf('https://indiankanoon.org/doc/1/').kind).toBe('legal');
    expect(trustOf('https://archive.org/details/x').kind).toBe('archive');
    expect(trustOf('https://some-blog.example.com/p').kind).toBe('general');
    expect(trustOf('https://random.xyz/p').kind).toBe('poor');
  });

  it('blocks shadow-library, torrent and crack sites', () => {
    for (const url of ['https://1337x.to/torrent/1', 'https://thepiratebay.org/', 'https://sci-hub.se/10.1/x', 'https://libgen.is/', 'https://yts.mx/movies/a', 'https://moviesda.com/x']) {
      expect(isBlockedSite(url), url).toBe(true);
    }
    expect(isBlockedSite('https://www.youtube.com/watch?v=1')).toBe(false);
  });

  it('knows the official platforms', () => {
    expect(streamingPlatform('https://www.netflix.com/title/1')).toBe('Netflix');
    expect(streamingPlatform('https://www.youtube.com/watch?v=1')).toBe('YouTube');
    expect(streamingPlatform('https://example.com/')).toBeNull();
  });
});

describe('search result parsing', () => {
  it('reads DuckDuckGo results', () => {
    const html = `<div class="result results_links"><a class="result__a" href="https://sci.gov.in/doc/1">Judgment &amp; order</a>
      <a class="result__snippet">The Supreme Court held that <b>privacy</b> is a right.</a></div>
      <div class="result"><a class="result__a" href="https://x.org/2">Second</a><a class="result__snippet">two</a></div>`;
    const hits = parseDuckDuckGo(html);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ href: 'https://sci.gov.in/doc/1', title: 'Judgment & order' });
    expect(hits[0]?.snippet).toContain('privacy');
  });

  it('reads Bing results', () => {
    const html = '<ol><li class="b_algo"><h2><a href="https://a.org/1">One</a></h2><p>snippet one</p></li><li class="b_algo"><h2><a href="https://b.org/2">Two</a></h2><p>two</p></li></ol>';
    expect(parseBing(html).map((h) => h.href)).toEqual(['https://a.org/1', 'https://b.org/2']);
  });
});

describe('queries', () => {
  it('turns a request into the topic', () => {
    expect(cleanTopic('I want Kesavananda Bharati case and related PDF')).toBe('Kesavananda Bharati case');
    expect(cleanTopic('please find me the Right to Information Act')).toMatch(/Right to Information Act/);
    expect(mediaTitle('download Raja Harishchandra 1913 full movie')).toBe('Raja Harishchandra 1913');
    expect(mediaTitle('play Tum Hi Ho song')).toBe('Tum Hi Ho');
  });

  it('weighs names and numbers up and the words of a whole field down', () => {
    const w = termWeights('judgment of the Supreme Court on the right to privacy Puttaswamy');
    expect(w.get('puttaswamy')).toBeGreaterThan(w.get('privacy') ?? 0);
    expect(w.get('court') ?? 1).toBeLessThan(1);
    expect(termWeights('Act 2019').get('2019')).toBe(2);
  });

  it('holds down a page that has only the generic words', () => {
    const q = 'judgment of the Supreme Court on the right to privacy Puttaswamy';
    const terms = keyTerms(q);
    const weights = termWeights(q);
    const generic = weightedCoverage('The Supreme Court home page: latest judgment and the right to know', terms, weights);
    const specific = weightedCoverage('Justice Puttaswamy v Union of India: the right to privacy', terms, weights);
    expect(specific).toBeGreaterThan(generic * 2);
    expect(generic).toBeLessThan(0.34);
  });

  it('matches short words only as whole words ("hi" is not in "Shiva")', () => {
    expect(hasTerm('tum hi ho', 'hi')).toBe(true);
    expect(hasTerm('shiva', 'hi')).toBe(false);
    expect(hasTerm('kaise ho (official video)', 'ho')).toBe(true);
    expect(hasTerm('hotel', 'ho')).toBe(false);
    expect(hasTerm('kesavananda', 'kesav')).toBe(true);
  });

  it('plans several differently-worded searches, the named site first', () => {
    const plan = planQueries('Kesavananda Bharati case judgment', 'documents', { site: 'indiankanoon.org' });
    expect(plan.queries[0]).toBe('site:indiankanoon.org Kesavananda Bharati case judgment');
    expect(plan.queries.some((q) => q.includes('filetype:pdf'))).toBe(true);
    expect(plan.queries.some((q) => q.startsWith('site:sci.gov.in'))).toBe(true);
    expect(new Set(plan.queries).size).toBe(plan.queries.length);
    const media = planQueries('download Raja Harishchandra 1913 full movie', 'media');
    expect(media.topic).toBe('Raja Harishchandra 1913');
    expect(media.queries.some((q) => /watch/.test(q))).toBe(true);
    expect(media.queries.join(' ')).not.toMatch(/torrent|free download/i);
  });

  it('understands the site the person names', () => {
    expect(siteRestriction('indiankanoon.org')).toEqual({ domain: 'indiankanoon.org', url: null });
    expect(siteRestriction('https://www.sci.gov.in/judgments')).toMatchObject({ domain: 'sci.gov.in' });
    expect(siteRestriction('ecourts')).toBeNull();
    expect(siteRestriction(undefined)).toBeNull();
    expect(siteSearchUrls('indiankanoon.org', 'a b')[0]).toBe('https://indiankanoon.org/search/?formInput=a%20b');
  });

  it("searches a named site's own box with the names and subject words only", () => {
    const qs = siteQueries('judgment of the Supreme Court on the right to privacy Puttaswamy');
    expect(qs[0]).toBe('privacy puttaswamy');
    expect(qs).toContain('puttaswamy');
  });

  it('finds citations and case names in what was read, for the second round', () => {
    const leads = leadsFrom(['See AIR 1973 SC 1461 and (1973) 4 SCC 225. In Kesavananda Bharati v. State of Kerala the Court held. AIR 1973 SC 1461 again.'], 'something else');
    expect(leads[0]).toBe('AIR 1973 SC 1461');
    expect(leads.some((l) => /SCC/.test(l))).toBe(true);
    expect(followUpQueries(['AIR 1973 SC 1461'], 'documents')).toEqual(['"AIR 1973 SC 1461" pdf']);
  });
});
