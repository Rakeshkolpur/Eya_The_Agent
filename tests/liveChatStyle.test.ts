import { describe, expect, it } from 'vitest';
import { buildDraftMessages, buildLocalDraftMessages, generateDraft, generateNudge, generateOpening } from '../src/main/livechat/draft';
import { FEELINGS_RULE, fitLength, relationFrom, relationStyle, replyLimits, wordsOf } from '../src/main/livechat/style';
import { FakeAI, rig, settle } from './liveChatFixtures';
import type { LiveChatMessage } from '../src/main/browser/BrowserAutomationService';

const incoming = (text: string, id = 'false_1'): LiveChatMessage => ({ id, dir: 'in', kind: 'text', text, at: '10:00' });
const input = (text: string, extra: Record<string, unknown> = {}) => ({ context: [incoming(text)], fresh: [incoming(text)], summary: '', tone: 'natural and brief', ...extra });

const BIG =
  "Oh, that's wonderful news, I am so happy for you! It must have been a very long and tiring week and I really hope that you get some good rest this weekend. Tell me everything about how it all went, I would love to hear every single detail of it.";

describe('how long a reply may be: as long as a person would write, not a paragraph', () => {
  it('about twice what they wrote plus a few words — never under 16, never over 24 (30 for a senior or a client)', () => {
    expect(replyLimits({ theirText: 'hi' }).maxWords).toBe(16);
    expect(replyLimits({ theirText: 'how are you doing today my friend' }).maxWords).toBe(24);
    expect(replyLimits({ theirText: 'x '.repeat(60) }).maxWords).toBe(24);
    expect(replyLimits({ theirText: 'x '.repeat(60), relation: 'senior' }).maxWords).toBe(30);
    expect(replyLimits({ theirText: 'x '.repeat(60), relation: 'client' }).maxWords).toBe(30);
    expect(replyLimits({ theirText: '', kind: 'nudge' }).maxWords).toBe(18);
    expect(replyLimits({ theirText: '', kind: 'opening' }).maxWords).toBe(28);
    expect(replyLimits({ theirText: 'hi', introduce: true }).maxWords).toBe(26);
  });

  it('a long reply is cut to the sentences that fit, on one line', () => {
    const out = fitLength(BIG, replyLimits({ theirText: 'I got the job!' }));
    expect(out).toBe("Oh, that's wonderful news, I am so happy for you! It must have been a very long and tiring week and I really hope that you get some good rest this weekend.".split('! ')[0] + '!');
    expect(wordsOf(out).length).toBeLessThanOrEqual(24);
    expect(out).not.toMatch(/\n/);
  });

  it('a reply within the limits is left exactly as it is (only the line breaks go)', () => {
    expect(fitLength('Aww, that is so sweet! 😊 How was your day?', replyLimits({ theirText: 'I missed you today' }))).toBe('Aww, that is so sweet! 😊 How was your day?');
    expect(fitLength('Ok, see you\nat five', replyLimits({ theirText: 'see you at five' }))).toBe('Ok, see you at five');
  });

  it('one sentence that is too long on its own is cut at a comma or "and", never in the middle of a clause, and nothing is added', () => {
    const one = 'I really hope that you get some good rest this weekend, and then we can talk about everything that happened at the office this week.';
    const out = fitLength(one, { maxWords: 16, maxSentences: 3 });
    expect(out).toBe('I really hope that you get some good rest this weekend');
    expect(out).not.toMatch(/…|\.\.\./);
  });

  it('a word or two of reaction, and an emoji on its own, belong to the sentence beside them', () => {
    expect(fitLength('Hi! Just checking in. How are things with you? 😊', { maxWords: 18, maxSentences: 2 })).toBe('Hi! Just checking in. How are things with you? 😊');
  });
});

describe('every reply is cut, whatever model wrote it and whoever Eya is writing as', () => {
  const ai = (reply: string) => new FakeAI().say(reply);
  it('a reply to a short message', async () => {
    const out = await generateDraft(ai(BIG), input('I got the job!'));
    expect(out.kind).toBe('draft');
    expect(wordsOf((out as { text: string }).text).length).toBeLessThanOrEqual(24);
  });
  it('as Eya as well', async () => {
    const out = await generateDraft(ai(BIG), input('I got the job!', { asEya: true, ownerName: 'Rakesh' }));
    expect(wordsOf((out as { text: string }).text).length).toBeLessThanOrEqual(24);
  });
  it('a check-in is one short line', async () => {
    const out = await generateNudge(ai('Hi there! I just wanted to see how you are doing today and whether everything is going well with your family and work this week.'), { context: [incoming('ok')], summary: '', tone: 'natural', minutes: 15 });
    expect(wordsOf((out as { text: string }).text).length).toBeLessThanOrEqual(18);
  });
  it('a first message may be a little longer (it says who Eya is) but is still short', async () => {
    const long = 'Hi, I am Eya, Rakesh\'s assistant, and I am here to chat with you today about whatever you would like, so how have you been doing lately and what is new in your life these days?';
    const out = await generateOpening(ai(long), { context: [], summary: '', tone: 'natural', asEya: true, ownerName: 'Rakesh' });
    expect(wordsOf((out as { text: string }).text).length).toBeLessThanOrEqual(28);
  });
});

describe('who they are to the person', () => {
  it('is read from the words ("my sir", "girlfriend", "she is my close friend", "family")', () => {
    expect(relationFrom('she is my close friend, make her happy')).toBe('friend');
    expect(relationFrom('my sir')).toBe('senior');
    expect(relationFrom('boss')).toBe('senior');
    expect(relationFrom('girlfriend')).toBe('partner');
    expect(relationFrom('my lover')).toBe('partner');
    expect(relationFrom('he is my wife\'s brother')).toBe('partner'); // (the first thing said: a partner is the closest word)
    expect(relationFrom('my mother')).toBe('family');
    expect(relationFrom('a client of mine')).toBe('client');
    expect(relationFrom('just a colleague')).toBe('other');
    expect(relationFrom('make her happy')).toBeNull();
    expect(relationFrom('')).toBeNull();
  });

  it('decides how Eya sounds: a senior gets no slang or emoji, a partner warmth, a friend play', () => {
    expect(relationStyle('senior')).toMatch(/no slang, no jokes, no emoji/);
    expect(relationStyle('client')).toMatch(/professional/);
    expect(relationStyle('partner')).toMatch(/caring and affectionate/);
    expect(relationStyle('partner')).toMatch(/never claim feelings or facts/);
    expect(relationStyle('friend')).toMatch(/casual, playful/);
    expect(relationStyle('family')).toMatch(/respectful/);
    expect(relationStyle(null)).toMatch(/natural, polite/);
  });

  it('is in every prompt, with how to answer what they feel and how short to be', () => {
    for (const asEya of [true, false]) {
      const s = JSON.stringify(buildDraftMessages(input('I failed my exam today', { asEya, ownerName: 'Rakesh', relation: 'senior' })));
      expect(s).toContain(relationStyle('senior'));
      expect(s).toContain(FEELINGS_RULE.slice(0, 60));
      expect(s).toMatch(/never more than 24 words/);
    }
    const local = JSON.stringify(buildLocalDraftMessages(input('I failed my exam today', { asEya: true, ownerName: 'Rakesh', relation: 'partner' })));
    expect(local).toContain(relationStyle('partner'));
    expect(local).toMatch(/Answer their feeling first/);
    expect(local).toMatch(/under 20 words/); // (five words from them: twice that and ten more)
  });

  it('a prompt without a relation says nothing about one', () => {
    expect(JSON.stringify(buildDraftMessages(input('hi')))).not.toMatch(/Who they are to the person/);
  });
});

describe('the live chat remembers who they are and uses it', () => {
  it('"she is my close friend" in the purpose sets it; an explicit one wins; it is in the view and in the prompt of every reply', async () => {
    const r = rig();
    r.ai.say('Hey! How are you?');
    await r.controller.start('Rahul', 'assisted', 'he is my boss, be respectful', undefined, undefined, 'partner');
    await settle();
    expect(r.controller.view().relation).toBe('partner');
    r.chat.incoming('Good morning');
    r.chat.changed();
    await settle(40);
    expect(r.ai.requests[0]).toContain(relationStyle('partner'));
  });

  it('read from the purpose when none was given', async () => {
    const r = rig();
    await r.controller.start('Rahul', 'assisted', 'he is my sir');
    await settle();
    expect(r.controller.view().relation).toBe('senior');
  });

  it('kept across a restart', async () => {
    const r = rig();
    await r.controller.start('Rahul', 'assisted', undefined, undefined, undefined, 'family');
    await settle();
    const next = r.restarted();
    expect(next.view().relation).toBe('family');
  });
});
