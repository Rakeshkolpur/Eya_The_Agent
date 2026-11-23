import { describe, it, expect } from 'vitest';
import { cleanSearchHits, decodeSearchHref, formatHitsAsAnswer } from '../src/main/browser/webSearchResults';

function bingWrap(dest: string): string {
  const b64 = Buffer.from(dest, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `https://www.bing.com/ck/a?!&&p=abc123&ptn=3&ver=2&u=a1${b64}&ntb=1`;
}

describe('decodeSearchHref', () => {
  it("unwraps DuckDuckGo's protocol-relative redirect to the real destination", () => {
    const href = '//duckduckgo.com/l/?uddg=https%3A%2F%2Ftshc.gov.in%2FprocessMenuWithPage%3Fid%3D13&rut=deadbeef';
    expect(decodeSearchHref(href)).toBe('https://tshc.gov.in/processMenuWithPage?id=13');
  });

  it("unwraps Bing's base64 redirect to the real destination", () => {
    expect(decodeSearchHref(bingWrap('https://tg.tshc.gov.in/showList?id=1'))).toBe('https://tg.tshc.gov.in/showList?id=1');
  });

  it('passes an ordinary direct link through', () => {
    expect(decodeSearchHref('https://example.com/a')).toBe('https://example.com/a');
  });

  it('rejects anything that is not an ordinary web address', () => {
    expect(decodeSearchHref('javascript:alert(1)')).toBeNull();
    expect(decodeSearchHref('not a url')).toBeNull();
    expect(decodeSearchHref('//duckduckgo.com/l/?uddg=javascript%3Aalert(1)')).toBeNull();
    expect(decodeSearchHref('//duckduckgo.com/l/?rut=nodestination')).toBeNull();
    expect(decodeSearchHref('https://user:pass@example.com/')).toBeNull();
  });

  it('refuses a Bing redirect it cannot decode instead of returning the redirect itself', () => {
    expect(decodeSearchHref('https://www.bing.com/ck/a?u=notbase64prefix')).toBeNull();
  });
});

describe('cleanSearchHits', () => {
  it('keeps real destinations in ranking order, de-duplicated', () => {
    const hits = cleanSearchHits([
      { title: 'High Court for the State of Telangana', href: '//duckduckgo.com/l/?uddg=https%3A%2F%2Ftshc.gov.in%2F', snippet: 'The Official Website' },
      { title: 'Dup', href: 'https://tshc.gov.in/' },
      { title: 'Other', href: 'https://tg.tshc.gov.in/' },
    ]);
    expect(hits.map((h) => h.url)).toEqual(['https://tshc.gov.in/', 'https://tg.tshc.gov.in/']);
    expect(hits[0]?.title).toBe('High Court for the State of Telangana');
    expect(hits[0]?.snippet).toBe('The Official Website');
  });

  it("drops the search engine's own pages and anything undecodable", () => {
    const hits = cleanSearchHits([
      { title: 'More results', href: 'https://www.bing.com/search?q=next' },
      { title: 'Ad', href: 'https://duckduckgo.com/y.js?ad=1' },
      { title: 'Broken', href: 'javascript:void(0)' },
      { title: 'Missing', href: null },
      { title: 'Good', href: 'https://example.org/' },
    ]);
    expect(hits.map((h) => h.url)).toEqual(['https://example.org/']);
  });

  it('cleans up whitespace, caps lengths, and falls back to the host when a title is empty', () => {
    const long = 'x'.repeat(500);
    const [first, second] = cleanSearchHits([
      { title: '  Many \n\t spaces  ', href: 'https://a.example/', snippet: long },
      { title: '   ', href: 'https://b.example/' },
    ]);
    expect(first?.title).toBe('Many spaces');
    expect(first?.snippet.length).toBeLessThanOrEqual(200);
    expect(second?.title).toBe('b.example');
  });

  it('returns at most eight results', () => {
    const raw = Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, href: `https://site${i}.example/` }));
    expect(cleanSearchHits(raw)).toHaveLength(8);
  });
});

describe('formatHitsAsAnswer', () => {
  it('numbers the results with their links and tells the model to judge by domain', () => {
    const text = formatHitsAsAnswer('telangana high court', [
      { title: 'High Court for the State of Telangana', url: 'https://tshc.gov.in/', snippet: 'Official' },
      { title: 'Some news', url: 'https://news.example/x', snippet: '' },
    ]);
    expect(text).toContain('1. High Court for the State of Telangana — https://tshc.gov.in/ — Official');
    expect(text).toContain('2. Some news — https://news.example/x');
    expect(text).toMatch(/from its own domain/);
  });
});
