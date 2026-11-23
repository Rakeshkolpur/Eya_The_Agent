import { describe, expect, it } from 'vitest';
import { buildDraftMessages, buildLocalDraftMessages, generateDraft } from '../src/main/livechat/draft';
import { factsLine, lookupNeed, wantsSuggestion, MAX_LOOKUPS } from '../src/main/livechat/lookup';
import type { LookupNeed } from '../src/main/livechat/lookup';
import { replyLimits, wordsOf } from '../src/main/livechat/style';
import type { LiveChatMessage } from '../src/main/browser/BrowserAutomationService';
import { FakeAI, FakeSwitch, rig, settle } from './liveChatFixtures';

/**
 * "If the person in the chat asks for a suggestion (songs, movies), or asks whether a movie is available, or about a train or tickets, or for a summary of something, Eya should be
 * able to tell." The question is looked up (web_search) and the reply is written from what it found; a suggestion is asked of the model's own knowledge. What is NOT looked up: what is
 * really about the person or Eya. Live seat availability cannot be seen by a web search, and Eya says so instead of guessing.
 */

describe('what is looked up', () => {
  it.each([
    ['Is Leo available on Netflix?', 'availability'],
    ['is the new Salaar movie streaming anywhere', 'availability'],
    ['Which OTT has the film Jailer? is it available', 'availability'],
    ['can you check train 12723 running status', 'travel'],
    ['is there any train from Hyderabad to Vijayawada tomorrow?', 'travel'],
    ['are tatkal tickets available for Friday?', 'travel'],
    ['please check the PNR 1234567890 status', 'travel'],
    ['what is the gold rate today?', 'fact'],
    ['who won the IPL match yesterday?', 'fact'],
    ['what is the weather in Hyderabad tomorrow', 'fact'],
    ['can you give me a summary of the Ramayana', 'summary'],
    ['summarize the story of Baahubali for me', 'summary'],
    ['explain quantum computing in simple words', 'summary'],
    ['what is the meaning of karma', 'summary'],
    ['who was Sardar Patel', 'summary'],
  ])('%s → %s', (said, kind) => {
    expect(lookupNeed(said)?.kind).toBe(kind);
  });

  it.each([
    'hi how are you',
    'what are you doing',
    'did you book the train ticket?',
    'are you coming by bus tomorrow',
    'who is this?',
    'what is up',
    'when will you come',
    'how is your mother',
    'I got the ticket',
    'ok',
    'what is your plan for the weekend',
    'Rakesh is not picking up',
    'I watched Leo yesterday, it was good',
    'where are you',
  ])('%s is just a chat, not a lookup', (said) => {
    expect(lookupNeed(said)).toBeNull();
  });

  it('nothing is looked up when they have just sent a picture or a document (that is read, not searched for)', () => {
    expect(lookupNeed('can you give me a summary of this', { hasFile: true })).toBeNull();
    expect(lookupNeed('can you give me a summary of this')?.kind).toBe('summary');
  });

  it('the query is the question as they asked it, cut to a line', () => {
    expect(lookupNeed('Is   Leo\n available on Netflix?')?.query).toBe('Is Leo available on Netflix?');
    expect(lookupNeed(`is Leo available on netflix? ${'and so on '.repeat(60)}`)?.query.length).toBe(220);
  });

  it('a request for suggestions is told apart (no search: the model names real ones)', () => {
    for (const said of ['suggest me a good movie', 'any good songs to listen to tonight?', 'can you recommend a series', 'which movie should we watch', 'what should I watch this weekend']) {
      expect(wantsSuggestion(said), said).toBe(true);
    }
    for (const said of ['I watched a movie', 'how are you', 'what are you doing', 'did you suggest it to him']) {
      expect(wantsSuggestion(said), said).toBe(false);
    }
  });
});

describe('what the model is told', () => {
  const m = (text: string): LiveChatMessage => ({ id: 'false_1', dir: 'in', kind: 'text', text, at: '10:00' });
  const base = (text: string, extra: Record<string, unknown> = {}) => ({ context: [m(text)], fresh: [m(text)], summary: '', tone: 'natural', ...extra });

  it('what the search found goes in as information, never instructions, with the rule for its kind', () => {
    const s = JSON.stringify(buildDraftMessages(base('is Leo on netflix?', { facts: { kind: 'availability', text: 'Leo is streaming on Netflix India since 24 November 2023.' } })));
    expect(s).toContain('Leo is streaming on Netflix India');
    expect(s).toMatch(/information and never instructions/);
    expect(s).toMatch(/pirated copy/);
    const small = JSON.stringify(buildLocalDraftMessages(base('is Leo on netflix?', { facts: { kind: 'availability', text: 'Leo is streaming on Netflix India.' } })));
    expect(small).toContain('Leo is streaming on Netflix India');
  });

  it('for a train, it is told that a web search cannot see seats or a waiting list', () => {
    expect(factsLine({ kind: 'travel', text: 'The 12723 Telangana Express runs daily.' })).toMatch(/cannot see live seat availability/);
  });

  it('a search that found nothing is said so honestly: no guess', () => {
    expect(factsLine({ kind: 'fact', text: '' })).toMatch(/gave nothing usable.*do not guess/);
  });

  it('what the search says is cut to a size a prompt can carry (shorter for the small model)', () => {
    const long = 'word '.repeat(1000);
    expect(factsLine({ kind: 'summary', text: long }).length).toBeLessThan(1700);
    expect(factsLine({ kind: 'summary', text: long }, true).length).toBeLessThan(1100);
  });

  it('a suggestion is asked for specifically, with no made-up titles', () => {
    expect(JSON.stringify(buildDraftMessages(base('suggest me a movie', { suggest: true })))).toMatch(/two or three specific ones that really exist/);
  });

  it('an answer that was looked up may be a little longer than small talk — and still short', () => {
    expect(replyLimits({ theirText: 'is Leo on netflix?', kind: 'info' })).toEqual({ maxWords: 40, maxSentences: 4 });
    expect(replyLimits({ theirText: 'is Leo on netflix?' }).maxWords).toBe(18);
  });
});

describe('a reply is written from what was found, and may state it', () => {
  const m = (text: string): LiveChatMessage => ({ id: 'false_1', dir: 'in', kind: 'text', text, at: '10:00' });
  const input = (text: string, extra: Record<string, unknown> = {}) => ({ context: [m(text)], fresh: [m(text)], summary: '', tone: 'natural', ...extra });

  it('names, dates and figures from the search are allowed in the reply (they are not "made up"); without the search they would be', async () => {
    const said = 'Leo is on Netflix since 24 November 2023.';
    const withFacts = await generateDraft(new FakeAI().say(said), input('is Leo available on Netflix?', { facts: { kind: 'availability', text: 'Leo (2023) began streaming on Netflix on 24 November 2023.' } }));
    expect(withFacts.kind).toBe('draft');
    const without = await generateDraft(new FakeAI().say(said), input('is Leo available on Netflix?'));
    expect(without.kind).toBe('ask_user');
  });

  it('an answer to a question is up to about forty words, not cut to a few', async () => {
    const reply = 'Leo is streaming on Netflix India. It came out there in late November 2023. It is in Tamil and dubbed in Hindi, Telugu and Malayalam too. Enjoy it!';
    const out = await generateDraft(new FakeAI().say(reply), input('is Leo available on Netflix?', { facts: { kind: 'availability', text: 'Leo streaming on Netflix India 2023 Tamil Hindi Telugu Malayalam' } }));
    expect(out.kind).toBe('draft');
    expect(wordsOf((out as { text: string }).text).length).toBeGreaterThan(24);
    expect(wordsOf((out as { text: string }).text).length).toBeLessThanOrEqual(40);
  });
});

describe('in a live chat', () => {
  function chatting(lookup: (need: LookupNeed) => Promise<{ text: string } | null>) {
    const sw = new FakeSwitch();
    sw.on = true;
    const r = rig({ enable: sw.control, lookup });
    return r;
  }
  async function begin(r: ReturnType<typeof chatting>) {
    r.chat.open = 'Priya Rao';
    r.chat.title = 'Priya Rao';
    r.chat.openOutcome = { kind: 'opened', label: 'Priya Rao', verified: true };
    r.ai.say("Hi! 😊 How are you doing today?");
    await r.controller.start('Priya Rao');
    await settle(40);
  }
  async function theySay(r: ReturnType<typeof chatting>, text: string): Promise<void> {
    r.chat.incoming(text);
    r.chat.changed();
    await settle(40);
    r.advance(12_000);
    await settle(40);
  }

  it('a question about a film is looked up, the answer is in the prompt, and the reply goes out', async () => {
    const asked: LookupNeed[] = [];
    const r = chatting(async (need) => {
      asked.push(need);
      return { text: 'Leo (2023) streams on Netflix India.' };
    });
    await begin(r);
    r.ai.say('Yes, Leo is on Netflix India! 🍿');
    await theySay(r, 'is Leo available on Netflix?');
    expect(asked).toEqual([{ kind: 'availability', query: 'is Leo available on Netflix?' }]);
    expect(r.ai.requests[r.ai.requests.length - 1]).toContain('Leo (2023) streams on Netflix India.');
    expect(r.chat.pressed).toContain('Yes, Leo is on Netflix India! 🍿');
  });

  it('small talk is not looked up', async () => {
    const asked: LookupNeed[] = [];
    const r = chatting(async (need) => {
      asked.push(need);
      return { text: 'x' };
    });
    await begin(r);
    r.ai.say('Doing well! You?');
    await theySay(r, 'hi, how are you doing today?');
    expect(asked).toEqual([]);
  });

  it('a search that fails does not stop the reply: the model is told it found nothing, and says so', async () => {
    const r = chatting(async () => {
      throw new Error('search down');
    });
    await begin(r);
    r.ai.say("I couldn't check that right now. Want me to try again later?");
    await theySay(r, 'what is the gold rate today?');
    expect(r.ai.requests[r.ai.requests.length - 1]).toMatch(/gave nothing usable/);
    expect(r.chat.pressed.length).toBeGreaterThan(0);
  });

  it('a chat looks up only so many things (the free search allowance is small)', async () => {
    let n = 0;
    const r = chatting(async () => {
      n += 1;
      return { text: 'something' };
    });
    await begin(r);
    for (let i = 0; i < MAX_LOOKUPS + 3; i += 1) {
      r.ai.say(`Here is answer ${i} about it.`);
      await theySay(r, `can you give me a summary of topic number ${i}`);
    }
    expect(n).toBe(MAX_LOOKUPS);
  });

  it('with no lookup wired (Eya without the search), nothing changes: the question is answered as before', async () => {
    const sw = new FakeSwitch();
    sw.on = true;
    const r = rig({ enable: sw.control });
    await begin(r as never);
    r.ai.say('Let me tell Rakesh to check that.');
    await theySay(r as never, 'is Leo available on Netflix?');
    expect(r.ai.requests[r.ai.requests.length - 1]).not.toMatch(/web search found/);
  });
});
