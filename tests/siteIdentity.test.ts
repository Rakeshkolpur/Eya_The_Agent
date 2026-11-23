import { describe, expect, it } from 'vitest';
import {
  brandLabel,
  contentMatch,
  hostOf,
  isExecutableUrl,
  judgeIdentity,
  problemOfPage,
  rankCandidates,
  registrableDomain,
  sameSite,
  significantTokens,
  suspiciousReason,
} from '../src/main/browser/siteIdentity';
import type { PageSnapshot } from '../src/main/browser/pageSnapshot';

export function snap(url: string, title: string, text = '', over: Partial<PageSnapshot> = {}): PageSnapshot {
  return { url, title, headings: title === '' ? [] : [title], links: ['Home', 'About', 'Contact'], buttons: [], inputs: [], dialogs: [], truncated: false, ...(text !== '' ? { visibleText: text } : {}), ...over };
}

describe('names and addresses', () => {
  it('keeps the meaningful words of a name', () => {
    expect(significantTokens('the official Telangana High Court website')).toEqual(['telangana', 'high', 'court']);
    expect(significantTokens('open the new url of Example')).toEqual(['example']);
    expect(significantTokens('')).toEqual([]);
  });

  it('finds the part of an address a person registers, and its brand', () => {
    expect(registrableDomain('www.example.com')).toBe('example.com');
    expect(registrableDomain('ww1.movierulz.com.ps')).toBe('movierulz.com.ps');
    expect(registrableDomain('tshc.gov.in')).toBe('tshc.gov.in');
    expect(registrableDomain('a.b.c.example.co.uk')).toBe('example.co.uk');
    expect(brandLabel('ww1.movierulz.com.ps')).toBe('movierulz');
    expect(hostOf('https://WWW.Example.org/path')).toBe('example.org');
    expect(sameSite('https://example.com/a', 'https://www.example.com/b')).toBe(true);
    expect(sameSite('https://example.com/', 'https://example.org/')).toBe(false);
  });

  it('does not trust an address on sight: short links, bare numbers, look-alike characters, program files', () => {
    expect(suspiciousReason('https://bit.ly/abc')).toMatch(/shortening/);
    expect(suspiciousReason('http://203.0.113.7/')).toMatch(/number/);
    expect(suspiciousReason('https://xn--exmple-cua.com/')).toMatch(/look-alike/);
    expect(suspiciousReason('https://xn--exmple-cua.com/', 'https://xn--exmple-cua.com/')).toBeNull();
    expect(suspiciousReason('https://example.com/setup.exe')).toMatch(/program/);
    expect(suspiciousReason('https://example.com/report.pdf')).toBeNull();
    expect(isExecutableUrl('https://x.org/a.MSI?dl=1')).toBe(true);
  });
});

describe('is it the site that was asked for', () => {
  it('verified when its address, title or headings carry the name', () => {
    const j = judgeIdentity(snap('https://tshc.gov.in/', 'High Court for the State of Telangana', 'Cause list'), { name: 'the Telangana High Court' });
    expect(j.identity).toBe('verified');
  });

  it('a site that moved to another ending keeps its brand: verified', () => {
    const j = judgeIdentity(snap('https://example.org/', 'Example — home'), { url: 'https://example.com/' });
    expect(j.identity).toBe('verified');
    const renamed = judgeIdentity(snap('https://new-example.org/', 'Example'), { url: 'https://old-example.com/' });
    expect(renamed.identity).toBe('verified');
  });

  it('unclear when the name is only somewhere in the text', () => {
    const j = judgeIdentity(snap('https://shopdeals.com/', 'Best deals', 'Compare prices. Example Corp reviewed here.'), { name: 'Example Corp' });
    expect(j.identity).toBe('unclear');
  });

  it('a mismatch when nothing on the page matches', () => {
    const j = judgeIdentity(snap('https://shopdeals.com/', 'Best deals today', 'Cheap shoes and bags'), { name: 'Example Corp' });
    expect(j.identity).toBe('mismatch');
  });

  it('never verified by name alone on an address of the kind that is mostly spam', () => {
    const j = judgeIdentity(snap('https://example-free.xyz/', 'Example'), { url: 'https://example.com/' });
    expect(j.identity).toBe('unclear');
    expect(j.reason).toMatch(/copy or a scam/);
  });

  it('nothing to compare with is unclear, not verified', () => {
    expect(judgeIdentity(snap('https://x.org/', 'X'), {}).identity).toBe('unclear');
  });
});

describe('what is wrong with a page that did open', () => {
  it('reads the site\'s error answer from the notes', () => {
    const p = problemOfPage(snap('https://example.com/x', 'Oops', 'Something is here for a while to be long enough.', { notes: ['example.com/x answered "503": the site itself has an error.'] }), 'https://example.com/x');
    expect(p?.kind).toBe('server_error');
    expect(p?.retryable).toBe(true);
    const gone = problemOfPage(snap('https://example.com/x', 'Gone', 'text text text text text text', { notes: ['example.com/x answered "404": that page does not exist (any more).'] }), 'https://example.com/x');
    expect(gone?.kind).toBe('not_found');
    expect(gone?.retryable).toBe(false);
  });

  it('knows a parked "domain for sale" page and an error page, and a blank one', () => {
    expect(problemOfPage(snap('https://old.com/', 'old.com', 'This domain may be for sale. Buy this domain today.'), 'https://old.com/')?.kind).toBe('not_found');
    expect(problemOfPage(snap('https://old.com/', '404 Not Found', 'The page you want is not here.', { links: [] }), 'https://old.com/')?.kind).toBe('not_found');
    const blank = problemOfPage({ url: 'https://old.com/', title: '', headings: [], links: [], buttons: [], inputs: [], dialogs: [], truncated: false }, 'https://old.com/');
    expect(blank?.kind).toBe('empty');
    expect(blank?.retryable).toBe(true);
    expect(problemOfPage(snap('https://ok.com/', 'Welcome', 'Plenty of ordinary text on an ordinary page, nothing wrong here at all.'), 'https://ok.com/')).toBeNull();
  });
});

describe('is what was asked for on the page', () => {
  const page = snap('https://court.gov.in/', 'Court', 'Cause list for today. Judgments and orders.', { links: ['Cause List', 'Orders', 'Contact'] });
  it('counts words found: every word for one or two, about 60% for more', () => {
    expect(contentMatch(page, ['cause list']).ok).toBe(true);
    expect(contentMatch(page, ['cause list', 'judgments']).ok).toBe(true);
    expect(contentMatch(page, ['cause list', 'zebra']).ok).toBe(false);
    expect(contentMatch(page, ['cause', 'orders', 'zebra']).ok).toBe(true);
    expect(contentMatch(page, ['zebra', 'yak', 'orders']).ok).toBe(false);
    expect(contentMatch(page, []).ok).toBe(true);
  });
});

describe('which search results could be the current address', () => {
  const hits = (list: Array<[string, string, string]>): Array<{ title: string; url: string; snippet: string }> => list.map(([title, url, snippet]) => ({ title, url, snippet }));

  it('ranks by the site\'s name in the address, title and description, and leaves out what was tried', () => {
    const ranked = rankCandidates(
      hits([
        ['Example — official site', 'https://example-new.org/', 'The home of Example'],
        ['Example on a forum', 'https://forum.net/t/example', 'people talk about example'],
        ['Old Example', 'https://old-example.com/', 'Example'],
      ]),
      { name: 'Example', oldHost: 'old-example.com', triedHosts: new Set(['old-example.com']) },
    );
    expect(ranked[0]?.host).toBe('example-new.org');
    expect(ranked.map((c) => c.host)).not.toContain('old-example.com');
  });

  it('never offers short links, bare numbers, search engines or sites that give things away without permission', () => {
    const ranked = rankCandidates(
      hits([
        ['Example', 'https://bit.ly/example', 'Example'],
        ['Example', 'http://203.0.113.9/', 'Example'],
        ['Example', 'https://www.google.com/search?q=example', 'Example'],
        ['Example movies free download', 'https://movierulz.example-mirror.com/', 'Example'],
        ['Example', 'https://example.org/', 'Example'],
      ]),
      { name: 'Example', oldHost: '', triedHosts: new Set() },
    );
    expect(ranked.map((c) => c.host)).toEqual(['example.org']);
  });

  it('an encyclopedia page is evidence, not a site: the address it names becomes the candidate', () => {
    const ranked = rankCandidates(
      hits([['Example Corp - Wikipedia', 'https://en.wikipedia.org/wiki/Example_Corp', 'Example Corp is a company. Its website is example-corp.com and it was founded in 1990.']]),
      { name: 'Example Corp', oldHost: '', triedHosts: new Set() },
    );
    expect(ranked.map((c) => c.host)).toEqual(['example-corp.com']);
    expect(ranked[0]?.why.join(' ')).toMatch(/named by en\.wikipedia\.org/);
  });

  it('gives nothing when nothing resembles the site', () => {
    expect(rankCandidates(hits([['Cheap shoes', 'https://shoes.com/', 'sale']]), { name: 'Example', oldHost: '', triedHosts: new Set() })).toEqual([]);
  });
});

describe('a name is matched on its distinctive words, not on a common one', () => {
  it('"Telangana High Court" is not "Karnataka High Court", and "Hang Example" is not "Reports Example"', () => {
    const karnataka = judgeIdentity(snap('https://karnatakajudiciary.kar.nic.in/', 'High Court of Karnataka', 'Cause list'), { name: 'the Telangana High Court' });
    expect(karnataka.identity).toBe('unclear');
    const reports = judgeIdentity(snap('https://reports-example.org/', 'Reports Example — official'), { name: 'Hang Example' });
    expect(reports.identity).toBe('unclear');
    const four = judgeIdentity(snap('https://x.org/', 'Delhi High Court of India'), { name: 'Delhi High Court India Official Portal' });
    expect(four.identity).toBe('verified');
  });
});

describe('what a page found by search for the person\'s own words must have', () => {
  const home = snap('https://tshc.gov.in/', 'Telangana High Court', 'Welcome to the Telangana High Court. History of the court and the names of its judges.');
  it('the words every page of a site carries (its name) are not enough: the topic asked for must be there too', () => {
    const words = ['telangana', 'high', 'court', 'cause', 'list'];
    expect(contentMatch(home, words).ok).toBe(true); // (the ordinary rule is satisfied by the name alone)
    expect(contentMatch(home, words, true).ok).toBe(false);
    const list = snap('https://tshc.gov.in/cl', 'Cause List', 'Telangana High Court cause list for today.');
    expect(contentMatch(list, words, true).ok).toBe(true);
  });

  it('all of up to three words, four fifths of more', () => {
    const page = snap('https://x.org/', 'Flights', 'Cheap flights from Hyderabad to Delhi.');
    expect(contentMatch(page, ['flights', 'hyderabad', 'delhi'], true).ok).toBe(true);
    expect(contentMatch(page, ['flights', 'hyderabad', 'mumbai'], true).ok).toBe(false);
    expect(contentMatch(page, ['cheap', 'flights', 'hyderabad', 'delhi', 'tomorrow'], true).ok).toBe(true);
    expect(contentMatch(page, ['cheap', 'flights', 'hyderabad', 'mumbai', 'tomorrow'], true).ok).toBe(false);
  });
});
