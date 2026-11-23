import { describe, it, expect } from 'vitest';
import { parseLocalIntent } from '../src/main/local/localIntents';
import type { FileQuery, LocalIntent } from '../src/main/local/localIntents';
import { domainToUrl, findSite, joinSpokenDots, searchUrl } from '../src/main/local/sites';

const kind = (text: string): string | null => parseLocalIntent(text)?.kind ?? null;
const as = <K extends LocalIntent['kind']>(text: string, k: K): Extract<LocalIntent, { kind: K }> => {
  const intent = parseLocalIntent(text);
  expect(intent?.kind, text).toBe(k);
  return intent as Extract<LocalIntent, { kind: K }>;
};

describe('opening a website by name', () => {
  it('opens known sites however it is phrased', () => {
    for (const [say, url] of [
      ['open youtube', 'https://www.youtube.com/'],
      ['Open YouTube.', 'https://www.youtube.com/'],
      ['hey eya, could you please open gmail for me', 'https://mail.google.com/'],
      ['go to github', 'https://github.com/'],
      ['visit wikipedia', 'https://www.wikipedia.org/'],
      ['take me to netflix', 'https://www.netflix.com/'],
      ['open the youtube website', 'https://www.youtube.com/'],
      ['open google maps', 'https://www.google.com/maps'],
      ['open whatsapp web', 'https://web.whatsapp.com/'],
      ['launch chatgpt', 'https://chatgpt.com/'],
    ] as const) {
      expect(as(say, 'open_site').url, say).toBe(url);
    }
  });

  it('opens a spoken or typed web address', () => {
    expect(as('open github.com', 'open_site').url).toBe('https://github.com/'.replace(/\/$/, ''));
    expect(as('go to github dot com', 'open_site').url).toBe('https://github.com');
    expect(as('open www.bbc.co.uk/news', 'open_site').url).toBe('https://www.bbc.co.uk/news');
    expect(as('open https://example.org/page?x=1', 'open_site').url).toBe('https://example.org/page?x=1');
    expect(as('visit https://example.org/a.', 'open_site').url).toBe('https://example.org/a');
  });

  it('does not claim things that are not sites', () => {
    for (const text of ['open the door', 'open sesame', 'open unicorn', 'open', 'go to sleep', 'visit grandma', 'open my heart']) {
      expect(kind(text), text).toBeNull();
    }
  });
});

describe('searching', () => {
  it('searches a named site', () => {
    const youtube = as('search youtube for funny cats', 'search');
    expect(youtube.site.id).toBe('youtube');
    expect(youtube.query).toBe('funny cats');
    expect(youtube.url).toBe('https://www.youtube.com/results?search_query=funny%20cats');
    expect(as('search for phone cases on amazon', 'search').url).toBe('https://www.amazon.com/s?k=phone%20cases');
    expect(as('look up ohm on wikipedia', 'search').site.id).toBe('wikipedia');
    expect(as('find react hooks on github', 'search').site.id).toBe('github');
    expect(as('search flipkart for running shoes', 'search').site.id).toBe('flipkart');
  });

  it('searches the web with google', () => {
    expect(as('google weather in hyderabad', 'search').url).toBe('https://www.google.com/search?q=weather%20in%20hyderabad');
    expect(as('search the web for best pizza', 'search').query).toBe('best pizza');
    expect(as('search online for cheap flights', 'search').site.id).toBe('google');
    expect(as('search for tomatoes on google', 'search').query).toBe('tomatoes');
  });

  it('encodes what was said so it cannot change the address', () => {
    const intent = as('google a&b=c/d e#f', 'search');
    expect(intent.url).toBe('https://www.google.com/search?q=a%26b%3Dc%2Fd%20e%23f');
  });

  it('leaves vague searches for the model', () => {
    for (const text of ['search for cats', 'search', 'search for my resume', 'google', 'look up the meaning of life', 'what is on youtube']) {
      expect(kind(text) === 'search', text).toBe(false);
    }
  });
});

describe('opening a folder', () => {
  it('opens the usual folders', () => {
    for (const [say, folder] of [
      ['open downloads', 'downloads'],
      ['open my downloads folder', 'downloads'],
      ['open the download folder', 'downloads'],
      ['show me desktop', 'desktop'],
      ['go to documents', 'documents'],
      ['open my pictures', 'pictures'],
      ['open music', 'music'],
      ['open videos folder', 'videos'],
      ['open the home folder', 'home'],
    ] as const) {
      expect(as(say, 'open_folder').folder, say).toBe(folder);
    }
  });

  it('does not take a bare singular for a folder', () => {
    expect(kind('open download')).toBeNull();
    expect(kind('open video')).toBeNull();
  });

  it('opens a folder by name', () => {
    expect(as('open the cases folder', 'open_named_folder').tokens).toEqual(['cases']);
    expect(as('open my tax returns folder', 'open_named_folder').tokens).toEqual(['tax', 'returns']);
  });
});

describe('finding and opening files', () => {
  const file = (text: string): FileQuery => as(text, 'file');

  it('finds files by type', () => {
    const q = file('find my latest pdf');
    expect(q.action).toBe('find');
    expect(q.extensions).toEqual(['pdf']);
    expect(q.tokens).toEqual([]);
    expect(q.newest).toBe(true);
  });

  it('takes "a word document" to be Word\'s kind of file, not a file with "word" in its name', () => {
    for (const text of ['show me my latest word document', 'find my latest word doc', 'find my word file']) {
      const q = file(text);
      expect(q.extensions, text).toEqual(expect.arrayContaining(['doc', 'docx']));
      expect(q.extensions, text).not.toContain('txt');
      expect(q.tokens, text).toEqual([]);
    }
    // a name that merely contains the word stays a name
    expect(file('find my word count notes').tokens).toEqual(['word', 'count', 'notes']);
    expect(file('find my notes document').extensions).toContain('pdf'); // "document" alone is still any kind of document
  });

  it('finds a file by name when it says whose it is, or what kind', () => {
    expect(file('find my resume').tokens).toEqual(['resume']);
    expect(file('where is my passport scan').tokens).toEqual(['passport', 'scan']);
    expect(file('find the invoice pdf').extensions).toEqual(['pdf']);
    expect(file('search for budget spreadsheet').extensions).toContain('xlsx');
    expect(file('locate report.docx').extensions).toEqual(['docx']);
    expect(file('locate report.docx').tokens).toEqual(['report']);
  });

  it('understands where and when', () => {
    const q = file('find invoice pdf in downloads');
    expect(q.folder).toBe('downloads');
    expect(q.tokens).toEqual(['invoice']);
    expect(file('show me my pictures from yesterday').when).toBe('yesterday');
    expect(file('find my documents from last week').when).toBe('last_week');
    expect(file('find today\'s photos').when).toBe('today');
    expect(file('open my latest download').folder).toBe('downloads');
  });

  it('opens a file only with a clear sign it is a file', () => {
    expect(file('open the invoice pdf').action).toBe('open');
    expect(file('open my notes file').tokens).toEqual(['notes']);
    expect(file('open the latest pdf in downloads').newest).toBe(true);
    expect(kind('open my notes')).toBeNull();
    expect(kind('open the door file')).not.toBeNull(); // has the word "file": a (probably empty) file search, not the model
  });

  it('lists with "show me"', () => {
    const q = file('show me my latest pdf');
    expect(q.action).toBe('find');
  });

  it('leaves things that are not file searches to the model', () => {
    for (const text of ['find a good restaurant', 'find me a hotel', 'where is the nearest atm', 'find out who won', 'find', 'find files', 'where is']) {
      expect(kind(text) === 'file', text).toBe(false);
    }
  });
});

describe('downloading', () => {
  it('downloads a link that was said or typed', () => {
    expect(as('download https://example.com/report.pdf', 'download').url).toBe('https://example.com/report.pdf');
    expect(as('please download the file from https://example.com/a/b.zip.', 'download').url).toBe('https://example.com/a/b.zip');
    expect(as('download example.com/report.pdf', 'download').url).toBe('https://example.com/report.pdf');
  });

  it('downloads what was copied', () => {
    for (const say of ['download this', 'download that link', 'download the link', 'download it']) {
      expect(as(say, 'download').url, say).toBeNull();
    }
  });

  it('leaves "download <something>" without a link to the model', () => {
    for (const text of ['download chrome', 'download a movie', 'download']) expect(kind(text), text).toBeNull();
  });
});

describe('site helpers', () => {
  it('joins spoken dots only for real endings', () => {
    expect(joinSpokenDots('open github dot com')).toBe('open github.com');
    expect(joinSpokenDots('the dot product')).toBe('the dot product');
  });
  it('recognises web addresses', () => {
    expect(domainToUrl('github.com')).toBe('https://github.com');
    expect(domainToUrl('notadomain')).toBeNull();
    expect(domainToUrl('my file.pdf')).toBeNull();
  });
  it('builds search addresses', () => {
    const youtube = findSite('youtube');
    expect(youtube && searchUrl(youtube, 'a b')).toBe('https://www.youtube.com/results?search_query=a%20b');
    const gmail = findSite('gmail');
    expect(gmail && searchUrl(gmail, 'x')).toBeNull();
  });
});

describe('a browser named at the end of the request', () => {
  const browserOf = (text: string): string | undefined => (parseLocalIntent(text) as { browser?: string } | null)?.browser;

  it('is carried with an open or a search; with none named, the page opens in Chrome (no browser on the intent)', () => {
    expect(browserOf('open youtube')).toBeUndefined();
    expect(browserOf('open youtube in edge')).toBe('edge');
    expect(browserOf('Open YouTube in Microsoft Edge, please.')).toBe('edge');
    expect(browserOf('open gmail on chrome')).toBe('chrome');
    expect(browserOf('open github using google chrome browser')).toBe('chrome');
    expect(browserOf('open wikipedia with firefox')).toBe('firefox');
    expect(browserOf('search cats on youtube in edge')).toBe('edge');
    expect(as('open youtube in edge', 'open_site').url).toBe('https://www.youtube.com/');
    expect(as('search cats on youtube in edge', 'search').query).toBe('cats');
  });

  it('a browser Eya cannot start by name, or one named for something that is not a website, goes to the model', () => {
    expect(parseLocalIntent('open youtube in brave')).toBeNull();
    expect(parseLocalIntent('open youtube on opera browser')).toBeNull();
    expect(parseLocalIntent('open my downloads folder in edge')).toBeNull();
    expect(parseLocalIntent('find my resume in chrome')).toBeNull();
  });

  it('does not mistake the browsers\' own names for a request to name one', () => {
    expect(parseLocalIntent('open chrome')).toBeNull();
    expect(browserOf('open edge')).toBeUndefined();
  });
});
