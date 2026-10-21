import { describe, it, expect } from 'vitest';
import { Researcher, coverage, mapLimit } from '../src/main/research/Researcher';
import { WebFetcher } from '../src/main/research/webFetch';
import { archiveSearch, watchOptionsFrom } from '../src/main/research/media';

interface Route {
  readonly match: RegExp;
  readonly status?: number;
  readonly type?: string;
  readonly body: string;
  readonly range?: boolean;
}

const ddg = (hits: ReadonlyArray<{ url: string; title: string; snippet?: string }>): string =>
  hits.map((h) => `<div class="result"><a class="result__a" href="${h.url}">${h.title}</a><a class="result__snippet">${h.snippet ?? ''}</a></div>`).join('\n');

/** A web made of routes: the first whose pattern matches the address answers; anything else is a 404. */
function fakeWeb(routes: readonly Route[]): { fetcher: WebFetcher; calls: string[] } {
  const calls: string[] = [];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url);
    const route = routes.find((r) => r.match.test(url));
    if (route === undefined) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    const headers: Record<string, string> = { 'content-type': route.type ?? 'text/html' };
    const asked = (init?.headers ?? {}) as Record<string, string>;
    if (route.range === true && asked['range'] !== undefined) {
      return new Response(route.body.slice(0, 1024), { status: 206, headers: { ...headers, 'content-range': `bytes 0-1023/${route.body.length + 5000}` } });
    }
    return new Response(route.body, { status: route.status ?? 200, headers });
  };
  return { fetcher: new WebFetcher({ fetch: fetchFn }), calls };
}

const pdfBody = '%PDF-1.4\n' + 'x'.repeat(2000);
const page = (title: string, body: string, links = ''): string => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p>${links}</main></body></html>`;

describe('helpers', () => {
  it('mapLimit runs at most `limit` at a time, keeps order and never rejects', async () => {
    let running = 0;
    let most = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      if (n === 3) throw new Error('boom');
      return n * 10;
    });
    expect(out).toEqual([10, 20, undefined, 40, 50, 60]);
    expect(most).toBeLessThanOrEqual(2);
  });

  it('coverage counts the share of terms present', () => {
    expect(coverage('Kesavananda Bharati v State of Kerala', ['kesavananda', 'bharati', 'privacy'])).toBeCloseTo(2 / 3);
  });
});

describe('Researcher: documents', () => {
  const web = (): ReturnType<typeof fakeWeb> =>
    fakeWeb([
      {
        match: /duckduckgo\.com\/html/,
        body: ddg([
          { url: 'https://www.sci.gov.in/document/kesavananda-bharati-v-state-of-kerala/', title: 'Kesavananda Bharati v State of Kerala | Supreme Court of India', snippet: 'The Basic Structure judgment of 1973' },
          { url: 'https://blog.example.com/kesavananda', title: 'Kesavananda Bharati case explained', snippet: 'A student guide to the case' },
          { url: 'https://1337x.to/torrent/1', title: 'Kesavananda Bharati full download', snippet: 'free' },
          { url: 'https://files.example.org/circular-exam-objections.pdf', title: 'Exam objections circular', snippet: 'notice' },
        ]),
      },
      { match: /bing\.com\/search/, body: '<html></html>' },
      {
        match: /sci\.gov\.in\/document\/kesavananda/,
        body: page(
          'Kesavananda Bharati v State of Kerala',
          'The Kesavananda Bharati case decided in 1973 laid down the basic structure doctrine. ' + 'More words about the case and the bench. '.repeat(10),
          '<a href="https://cdn.sci.gov.in/files/kesavananda-bharati-judgment.pdf">Download judgment (PDF)</a><a href="https://cdn.sci.gov.in/files/citizens-charter.pdf">Citizen\'s Charter (PDF)</a>',
        ),
      },
      { match: /blog\.example\.com/, body: page('Kesavananda Bharati case explained', 'The Kesavananda Bharati case is about the basic structure of the Constitution of India.') },
      { match: /kesavananda-bharati-judgment\.pdf/, type: 'application/pdf', body: pdfBody, range: true },
      { match: /citizens-charter\.pdf/, type: 'application/pdf', body: pdfBody, range: true },
      { match: /circular-exam-objections\.pdf/, type: 'application/pdf', body: pdfBody, range: true },
    ]);

  it('finds the official page, verifies the PDF, ranks it first and drops piracy, circulars and menu documents', async () => {
    const { fetcher, calls } = web();
    const r = new Researcher({ fetcher, searchGapMs: 0 });
    const report = await r.research({ question: 'I want Kesavananda Bharati case and related PDF', kind: 'documents' });
    expect(report.topic).toBe('Kesavananda Bharati case');
    expect(report.documents[0]?.url).toBe('https://cdn.sci.gov.in/files/kesavananda-bharati-judgment.pdf');
    expect(report.documents[0]?.verified).toBe(true);
    const urls = report.documents.map((d) => d.url);
    expect(urls.some((u) => /citizens-charter/.test(u))).toBe(false);
    expect(urls.some((u) => /exam-objections/.test(u))).toBe(false);
    expect(report.sources[0]?.siteKind).toBe('official');
    expect(report.sources.some((s) => s.url.includes('1337x'))).toBe(false);
    expect(calls.some((u) => u.includes('1337x.to'))).toBe(false);
  });

  it('does not offer an address that only looks like a PDF', async () => {
    const fake = fakeWeb([
      { match: /duckduckgo\.com\/html/, body: ddg([{ url: 'https://files.example.org/kesavananda-bharati.pdf', title: 'Kesavananda Bharati case', snippet: 'pdf' }]) },
      { match: /bing\.com/, body: '<html></html>' },
      { match: /kesavananda-bharati\.pdf/, type: 'text/html', body: '<html>Please log in</html>', range: true },
    ]);
    const report = await new Researcher({ fetcher: fake.fetcher, searchGapMs: 0 }).research({ question: 'Kesavananda Bharati case pdf', kind: 'documents' });
    expect(report.documents).toHaveLength(0);
    expect(report.notes.join(' ')).toMatch(/No PDF could be confirmed/);
  });

  it('remembers a finished research, and a repeated question joins one that is still running', async () => {
    const { fetcher, calls } = web();
    const r = new Researcher({ fetcher, searchGapMs: 0 });
    const req = { question: 'Kesavananda Bharati case', kind: 'documents' as const };
    const [a, b] = await Promise.all([r.research(req), r.research(req)]);
    expect(b).toBe(a);
    const before = calls.length;
    const again = await r.research(req);
    expect(again.fromCache).toBe(true);
    expect(calls.length).toBe(before);
  });

  it('looks on the named site first, with its own search, using the distinctive words', async () => {
    const fake = fakeWeb([
      { match: /duckduckgo\.com\/html/, body: ddg([]) },
      { match: /bing\.com/, body: '<html></html>' },
      {
        match: /indiankanoon\.org\/search\/\?formInput=privacy%20puttaswamy/,
        body: page('Search results', 'Justice Puttaswamy privacy results', '<a href="/doc/91938676/">Justice K.S.Puttaswamy(Retd) And Anr. vs Union Of India And Ors.</a><a href="/doc/1/">Unrelated tax matter v Collector</a>'),
      },
      { match: /indiankanoon\.org\/doc\/91938676/, body: page('Justice K.S.Puttaswamy(Retd) And Anr. vs Union Of India', 'The right to privacy is a fundamental right. Puttaswamy judgment text. '.repeat(8)) },
    ]);
    const report = await new Researcher({ fetcher: fake.fetcher, searchGapMs: 0 }).research({
      question: 'judgment of the Supreme Court on the right to privacy Puttaswamy',
      kind: 'documents',
      site: 'indiankanoon.org',
    });
    expect(fake.calls.some((u) => u.includes('indiankanoon.org/search/?formInput=privacy%20puttaswamy'))).toBe(true);
    expect(report.sources.some((s) => s.url.includes('/doc/91938676'))).toBe(true);
    expect(report.namedSite?.domain).toBe('indiankanoon.org');
    expect(report.namedSite?.found).toBeGreaterThan(0);
  });

  it('keeps going when the search engines give nothing, and says so', async () => {
    const fake = fakeWeb([{ match: /./, status: 503, body: 'no' }]);
    const report = await new Researcher({ fetcher: fake.fetcher, searchGapMs: 0 }).research({ question: 'Some very rare topic', kind: 'answer' });
    expect(report.sources).toHaveLength(0);
    expect(report.notes.join(' ')).toMatch(/Nothing useful came back/);
  });

  it('uses the browser fallback search when the engines answer nothing', async () => {
    const fake = fakeWeb([
      { match: /duckduckgo|bing/, status: 503, body: 'no' },
      { match: /example\.org\/topic/, body: page('The topic page', 'Everything about the topic called zebracrossing and its history is here.') },
    ]);
    const report = await new Researcher({
      fetcher: fake.fetcher,
      searchGapMs: 0,
      fallbackSearch: async () => [{ title: 'The topic page', url: 'https://example.org/topic', snippet: 'zebracrossing', engine: 'duckduckgo' }],
    }).research({ question: 'zebracrossing', kind: 'answer' });
    expect(report.sources[0]?.url).toBe('https://example.org/topic');
  });
});

describe('Researcher: films and songs (legal only)', () => {
  it('lists official platforms for the title only, and free-to-keep copies with clear rights only', async () => {
    const fake = fakeWeb([
      {
        match: /duckduckgo\.com\/html/,
        body: ddg([
          { url: 'https://www.netflix.com/title/81587752', title: 'Watch Kesari | Netflix', snippet: 'Kesari 2019' },
          { url: 'https://www.youtube.com/watch?v=abc', title: 'Kesari 2019 official trailer', snippet: '' },
          { url: 'https://www.netflix.com/title/999', title: 'Watch Something Else | Netflix', snippet: '' },
          { url: 'https://moviesda.com/kesari', title: 'Kesari download', snippet: 'free' },
        ]),
      },
      { match: /bing\.com/, body: '<html></html>' },
      {
        match: /archive\.org\/advancedsearch/,
        body: JSON.stringify({
          response: {
            docs: [
              { identifier: 'KesariRip', title: 'Kesari (2019) DVDScr Rip', year: 2019, downloads: 90000, collection: ['opensource_movies'], mediatype: 'movies' },
              { identifier: 'OldFilm', title: 'Kesari 1913 silent', year: 1913, downloads: 100, collection: ['silent_films', 'feature_films'], mediatype: 'movies', licenseurl: 'http://creativecommons.org/publicdomain/zero/1.0/' },
            ],
          },
        }),
        type: 'application/json',
      },
      {
        match: /archive\.org\/metadata\/OldFilm/,
        type: 'application/json',
        body: JSON.stringify({ files: [{ name: 'old.mp4', format: 'h.264', size: '60000000' }, { name: 'old.ogv', format: 'Ogg Video', size: '30000000' }] }),
      },
    ]);
    const report = await new Researcher({ fetcher: fake.fetcher, searchGapMs: 0 }).research({ question: 'I want to download the movie Kesari', kind: 'media' });
    expect(report.topic).toBe('Kesari');
    expect(report.watch?.map((w) => w.platform)).toEqual(['YouTube', 'Netflix']);
    expect(report.watch?.every((w) => !w.url.includes('999'))).toBe(true);
    expect(report.freeCopies).toHaveLength(1);
    expect(report.freeCopies?.[0]).toMatchObject({ identifier: 'OldFilm', freeToKeep: true, fileUrl: 'https://archive.org/download/OldFilm/old.mp4' });
    expect(report.notes.join(' ')).toMatch(/only look in legal places/);
    expect(fake.calls.some((u) => u.includes('moviesda'))).toBe(false);
  });
});

describe('media helpers', () => {
  it('archiveSearch marks copies free to keep only on clear grounds', async () => {
    const fake = fakeWeb([
      {
        match: /advancedsearch/,
        type: 'application/json',
        body: JSON.stringify({
          response: {
            docs: [
              { identifier: 'a', title: 'Modern album upload', year: 2015, collection: ['opensource_audio'], mediatype: 'audio' },
              { identifier: 'b', title: 'Silent classic', year: 1925, collection: ['silent_films'], mediatype: 'movies' },
              { identifier: 'c', title: 'Modern film in the feature collection', year: 2012, collection: ['feature_films'], mediatype: 'movies' },
              { identifier: 'd', title: 'Open recording', collection: ['librivox'], mediatype: 'audio' },
              { identifier: 'e', title: 'CC licensed', year: 2018, collection: ['community'], mediatype: 'movies', licenseurl: 'https://creativecommons.org/licenses/by/4.0/' },
            ],
          },
        }),
      },
    ]);
    const found = await archiveSearch(fake.fetcher, 'anything');
    expect(Object.fromEntries(found.map((c) => [c.identifier, c.freeToKeep]))).toEqual({ a: false, b: true, c: false, d: true, e: true });
  });

  it('watchOptionsFrom keeps one title page per platform and skips search pages and piracy sites', () => {
    const out = watchOptionsFrom([
      { title: 'Search results', url: 'https://www.youtube.com/results?search_query=x' },
      { title: 'Kesari Full Movie', url: 'https://www.youtube.com/watch?v=1' },
      { title: 'Kesari second', url: 'https://www.youtube.com/watch?v=2' },
      { title: 'Watch Kesari', url: 'https://www.primevideo.com/detail/1' },
      { title: 'Kesari free', url: 'https://yts.mx/movies/kesari' },
    ]);
    expect(out.map((o) => o.platform)).toEqual(['YouTube', 'Prime Video']);
    expect(out[0]?.free).toBe(true);
    expect(out[0]?.note).toMatch(/official only if the channel/);
  });
});
