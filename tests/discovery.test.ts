import { describe, expect, it, vi } from 'vitest';
import { attribution, classifyRefusal, classifyToolFailure, describeDiscovery, discoverSite, leadSentence, planDiscovery, refusalOf } from '../src/main/agent/discovery';
import { blockReason } from '../src/main/providers/ai/GeminiAIProvider';
import { OpenAICompatibleProvider } from '../src/main/providers/ai/OpenAICompatibleProvider';
import type { ToolResult } from '../src/main/tools/types';
import { isBlockedName } from '../src/main/research/trust';

describe('which site a request is about (the application finds it, so it has to be plain)', () => {
  it('an address after "open" / "visit" / "go to", and what is left to do on it', () => {
    expect(planDiscovery('Open example.org and tell me the main heading.')).toEqual({ url: 'https://example.org', then: 'tell me the main heading' });
    expect(planDiscovery('please visit https://www.tshc.gov.in/cause-list now')).toEqual({ url: 'https://www.tshc.gov.in/cause-list', then: 'now' });
    expect(planDiscovery('go to www.flipkart.com, then search for shoes')).toEqual({ url: 'https://www.flipkart.com', then: 'search for shoes' });
    expect(planDiscovery('open example.org.')).toEqual({ url: 'https://example.org', then: '' });
    // (the word "website" may come before the address)
    expect(planDiscovery('Open the website example.org and tell me what the main heading on the page says.')).toEqual({ url: 'https://example.org', then: 'tell me what the main heading on the page says' });
    expect(planDiscovery('open site https://www.tshc.gov.in')).toEqual({ url: 'https://www.tshc.gov.in', then: '' });
    // (a link with a port, or a local one, is an address as it stands)
    expect(planDiscovery('open http://movierulz.localhost:53349/ and play it')).toEqual({ url: 'http://movierulz.localhost:53349/', then: 'play it' });
    expect(planDiscovery('open http://localhost:3000/app')).toEqual({ url: 'http://localhost:3000/app', then: '' });
    expect(planDiscovery('open example.org:8080/x then read it')).toEqual({ url: 'https://example.org:8080/x', then: 'read it' });
  });

  it('a name before "site" / "website" / "portal", and what is left to do on it', () => {
    expect(planDiscovery('Open MovieRulz site and play Telugu HD Paradise movie.')).toEqual({ name: 'MovieRulz', then: 'play Telugu HD Paradise movie' });
    expect(planDiscovery('could you open the telangana high court website')).toEqual({ name: 'telangana high court', then: '' });
    expect(planDiscovery('visit the ecourts portal and check my case')).toEqual({ name: 'ecourts', then: 'check my case' });
  });

  it('leaves everything less plain to the model: apps, folders, files, "my" site, no site word', () => {
    for (const text of ['open notepad', 'open the downloads folder', 'open report.pdf', 'open my website', 'open our company site', 'open the site settings', 'open youtube', 'play some songs', 'book a ticket', 'close the site', 'Hi', '']) {
      expect(planDiscovery(text), text).toBeNull();
    }
  });
});

describe('whose "no" is it', () => {
  it('tells a refusal on policy or safety grounds from one for lack of a tool', () => {
    expect(classifyRefusal('I cannot open or play movies from sites like MovieRulz, as they often provide content without permission.')).toBe('policy');
    expect(classifyRefusal("I'm sorry, I can't help with that: it is against my policy.")).toBe('policy');
    expect(classifyRefusal("I don't have a tool for that.")).toBe('capability');
    expect(classifyRefusal("I'm unable to browse the web.")).toBe('capability');
    expect(classifyRefusal("I can't tell you that: nobody knows.")).toBe('unknown');
  });

  it('an answer IS a refusal only when it opens with the "no": one that did the job and says what it will not do is not', () => {
    expect(leadSentence('I opened it and looked. It lists new releases, but I will not start playback there.')).toBe('I opened it and looked.');
    expect(refusalOf('I opened it and looked. It lists new releases, but I will not start playback there.')).toBeNull();
    expect(refusalOf("I'm sorry, but I can't open MovieRulz. My tools blocked it because it is a site that distributes movies without permission.")).toBe('policy');
    expect(refusalOf('I cannot open or play movies from sites like MovieRulz, as they often provide content without permission.')).toBe('policy');
    expect(refusalOf('')).toBeNull();
  });

  it('is not fooled by an answer that merely mentions legal things', () => {
    expect(classifyRefusal('Paradise is available legally on Netflix and the Internet Archive has a free copy.')).toBeNull();
    expect(classifyRefusal('Done. I opened the page.')).toBeNull();
  });
});

describe('where a failure came from', () => {
  const fail = (data: Record<string, unknown>, error = 'it failed'): ToolResult => ({ ok: false, summary: 'could not open', error, data });

  it('a site Eya will not open is her own rule', () => {
    expect(classifyToolFailure('find_and_open_website', fail({ navigation: { problem: 'blocked_site' } }))?.source).toBe('application_policy');
  });

  it('the search failing, or finding no address, is the search; the page not opening is navigation', () => {
    expect(classifyToolFailure('web_search', fail({}))?.source).toBe('search');
    expect(classifyToolFailure('deep_research', fail({}))?.source).toBe('search');
    expect(classifyToolFailure('find_and_open_website', fail({ recovery: { reason: 'no_alternative', notes: ['A web search did not work.'] } }))?.source).toBe('search');
    expect(classifyToolFailure('find_and_open_website', fail({ recovery: { reason: 'no_alternative', notes: [] } }))?.source).toBe('search');
    for (const reason of ['unreachable', 'not_found', 'no_content', 'time_budget', 'attempt_limit']) {
      expect(classifyToolFailure('find_and_open_website', fail({ recovery: { reason } }))?.source, reason).toBe('navigation');
    }
    expect(classifyToolFailure('open_website', fail({}))?.source).toBe('navigation');
  });

  it('a check or sign-in that needs the person is navigation; another tool is just a tool; success is nothing', () => {
    expect(classifyToolFailure('find_and_open_website', fail({ needsUser: true }))?.source).toBe('navigation');
    expect(classifyToolFailure('find_file', fail({}))?.source).toBe('tool');
    expect(classifyToolFailure('open_website', { ok: true, summary: 'opened' })).toBeNull();
  });

  it('says whose "no" it was, so the browser is not blamed for the model (or the other way round)', () => {
    const model = [{ source: 'model_refusal' as const, detail: 'x' }];
    expect(attribution(model, { title: 'Example Domain', host: 'example.org' })).toMatch(/page itself did open \(Example Domain\).*AI model, not from the browser/);
    expect(attribution(model, null)).toMatch(/came from the AI model, not from the browser or the search/);
    // (something failed first: the model's "no" is likely a result of that, so the failure that came first explains it and nothing is blamed on the model)
    expect(attribution([{ source: 'navigation', detail: 'y' }, ...model], null)).toBe('');
    expect(attribution([{ source: 'navigation', detail: 'y' }], null)).toBe('');
    expect(attribution([], null)).toBe('');
  });
});

describe('what the model is told after the application\'s own browser step', () => {
  const page: ToolResult = { ok: true, summary: 'opened Example Domain', data: { currentPage: { url: 'https://www.example.org/', title: 'Example Domain' } } };

  it('the page that was opened and checked, and what is left to do', () => {
    const r = describeDiscovery({ url: 'https://example.org', then: 'read the heading' }, page, '{"ok":true}');
    expect(r.opened).toBe(true);
    expect(r.page).toEqual({ url: 'https://www.example.org/', title: 'Example Domain', host: 'example.org' });
    expect(r.note).toContain('"read the heading"');
    expect(r.note).toContain('{"ok":true}');
    expect(r.line).toBe('I opened Example Domain.');
    expect(r.findings).toEqual([]);
  });

  it('a stop is described by where it stopped, not as a refusal', () => {
    const r = describeDiscovery({ name: 'Lost', then: '' }, { ok: false, summary: 'could not open', error: 'nope', data: { recovery: { reason: 'unreachable' } } }, '{}');
    expect(r.opened).toBe(false);
    expect(r.note).toContain('stopped at opening the page');
    expect(r.findings.map((f) => f.source)).toEqual(['navigation']);
  });
});

describe('the application\'s own browser step', () => {
  it('asks the browser tool for the address, or for the name; never for anything else; and looks up lawful options only for a blocked site', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const invoke = vi.fn(async (name: string, args: unknown): Promise<ToolResult> => {
      calls.push({ name, args });
      return name === 'find_and_open_website' && (args as { name?: string }).name === 'MovieRulz'
        ? { ok: false, summary: 'could not open', error: 'blocked', data: { navigation: { problem: 'blocked_site' } } }
        : { ok: true, summary: 'ok', data: { currentPage: { url: 'https://example.org/', title: 'Example' } } };
    });
    const io = { invoke, say: () => undefined, resultText: (r: ToolResult) => JSON.stringify(r.data ?? {}) };
    await discoverSite({ url: 'https://example.org', then: '' }, 'open example.org', io);
    expect(calls).toEqual([{ name: 'find_and_open_website', args: { url: 'https://example.org' } }]);
    calls.length = 0;
    await discoverSite({ name: 'MovieRulz', then: 'play Paradise' }, 'open MovieRulz site and play Paradise', io);
    expect(calls.map((c) => c.name)).toEqual(['find_and_open_website', 'deep_research']);
    expect(calls[1]?.args).toEqual({ question: 'Paradise', kind: 'media', no_site: true });
  });
});

describe('the AI declining is reported by the provider as that', () => {
  it('Gemini: a blocked prompt or an answer cut by a safety filter, and nothing else', () => {
    expect(blockReason({ promptFeedback: { blockReason: 'SAFETY' } }, undefined)).toMatch(/prompt was blocked \(SAFETY\)/);
    expect(blockReason({}, 'SAFETY')).toMatch(/safety filter \(SAFETY\)/);
    expect(blockReason({}, 'PROHIBITED_CONTENT')).toMatch(/PROHIBITED_CONTENT/);
    expect(blockReason({}, 'STOP')).toBeUndefined();
    expect(blockReason({}, 'MAX_TOKENS')).toBeUndefined();
    expect(blockReason({ promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' } }, 'STOP')).toBeUndefined();
  });

  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const make = (body: unknown): OpenAICompatibleProvider => new OpenAICompatibleProvider({ label: 'openai', baseUrl: 'https://x/v1', apiKey: 'k'.repeat(20), model: 'gpt-4o-mini', fetchFn: (async () => json(body)) as unknown as typeof fetch });

  it('an OpenAI-style model\'s stated refusal, or its content filter, is marked blocked; an ordinary answer is not', async () => {
    const refused = await make({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: "I can't help with that." } }] }).complete([{ role: 'user', content: 'x' }], []);
    expect(refused.blocked).toBe('the model declined');
    expect(refused.text).toBe("I can't help with that.");
    const filtered = await make({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }).complete([{ role: 'user', content: 'x' }], []);
    expect(filtered.blocked).toMatch(/content filter/);
    const fine = await make({ choices: [{ finish_reason: 'stop', message: { content: 'Hello.' } }] }).complete([{ role: 'user', content: 'x' }], []);
    expect(fine.blocked).toBeUndefined();
    expect(fine.text).toBe('Hello.');
  });
});

describe('a site named in words, even misspelled, is checked against the sites Eya does not open', () => {
  it('catches the name as it is, with a space, with a word after it, and a letter off', () => {
    for (const name of ['MovieRulz', 'movie rulz', 'Movierulz telugu', 'movieruz', 'movierulzz', 'tamilrockerz', 'Tamil Rockers', 'fmovies', 'hdhub4u']) expect(isBlockedName(name), name).toBe(true);
  });

  it('leaves every ordinary name alone, however it is written', () => {
    for (const name of ['National Library', 'telangana high court', 'Reports Example', 'netflix', 'youtube', 'Prime Video', 'hotstar', 'ecourts', 'example', 'movies', 'the movie database', 'ibm', '']) expect(isBlockedName(name), name).toBe(false);
  });
});
