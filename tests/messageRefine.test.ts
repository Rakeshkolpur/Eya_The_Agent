import { describe, expect, it } from 'vitest';
import { cleanModelMessage, makeRefiner, needsRefining, tidyMessage } from '../src/main/local/messageRefine';
import { isImpatientYes, looksLikeEdit, parseChatIntent, parseYesNo } from '../src/main/local/chatIntents';

describe('what needs writing properly', () => {
  it('a note about what to tell them (reported speech, chat shorthand) does; a message that is already one does not', () => {
    expect(needsRefining('Rakesh told me he will call u night after having dinner, until he said take care, and he asking u, u want anything for diwali')).toBe(true);
    expect(needsRefining('tell him I will be late')).toBe(true);
    expect(needsRefining('where r u pls call me')).toBe(true);
    expect(needsRefining('hi')).toBe(false);
    expect(needsRefining("I'll be late, start without me")).toBe(false);
    expect(needsRefining('"see you at five"')).toBe(false); // (said inside quotation marks: it is the message)
  });

  it('is tidied by rule when no AI answers: shorthand spelled out, "he asking" -> "he is asking", capitals, a full stop', () => {
    expect(tidyMessage('Rakesh told me he will call u night after having dinner, until he said take care, and he asking u, u want anything for diwali')).toBe(
      'Rakesh told me he will call you night after having dinner, until he said take care, and he is asking you, you want anything for Diwali.',
    );
    expect(tidyMessage('pls call me n tell abt it')).toBe('Please call me and tell about it.');
  });

  it('what a model wrote is cleaned of quotes and "Here is the message:", and refused when it is an apology or has made things up', () => {
    expect(cleanModelMessage('"Hi, Rakesh will call you tonight."', 'rakesh will call u tonight')).toBe('Hi, Rakesh will call you tonight.');
    expect(cleanModelMessage('Here is the message: Rakesh will call you tonight.', 'rakesh will call u tonight')).toBe('Rakesh will call you tonight.');
    expect(cleanModelMessage("I'm sorry, I can't help with that.", 'x')).toBeNull();
    expect(cleanModelMessage('word '.repeat(300), 'short')).toBeNull();
    expect(cleanModelMessage('   ', 'x')).toBeNull();
  });
});

describe('the refiner', () => {
  const ai = (text: string, delay = 0) => ({ complete: async () => (delay > 0 ? await new Promise((r) => setTimeout(r, delay)) : undefined, { text, toolCalls: [] }) });
  it('uses what the AI wrote', async () => {
    expect(await makeRefiner(ai('Rakesh will call you tonight after dinner.'))({ text: 'rakesh will call u tonight after dinner' })).toBe('Rakesh will call you tonight after dinner.');
  });
  it('falls back to the rule-based tidy when the AI is slow, fails or is not there, so the person always sees a readable message', async () => {
    const slow = makeRefiner(ai('late answer', 200), 30);
    expect(await slow({ text: 'pls call me' })).toBe('Please call me.');
    expect(await makeRefiner({ complete: async () => Promise.reject(new Error('out of allowance')) })({ text: 'pls call me' })).toBe('Please call me.');
    expect(await makeRefiner(undefined)({ text: 'pls call me' })).toBe('Please call me.');
    expect(await makeRefiner(ai("I'm sorry, I can't"))({ text: 'pls call me' })).toBe('Please call me.');
  });
  it('a change keeps the draft when the AI cannot write', async () => {
    expect(await makeRefiner(undefined)({ text: 'x', draft: 'Hello there.', change: 'shorter' })).toBe('Hello there.');
  });
});

describe('the words', () => {
  it('"<number> msg this person, <what to say>" is a message to that number', () => {
    const intent = parseChatIntent('+91 98765 08501 msg this person, Rakesh told me he will call u night after having dinner, until he said take care, and he asking u, u want anything for diwali');
    expect(intent).toMatchObject({ kind: 'message_unsplit' });
    expect((intent as { rest: string }).rest).toMatch(/^\+91 98765 08501 Rakesh told me/);
    expect(parseChatIntent('+91 98765 08501 message him call me tonight')).toMatchObject({ kind: 'message_unsplit' });
    expect(parseChatIntent('+91 98765 08501 is a nice number')).toBeNull();
  });

  it('ways of saying yes that were not understood now are, and the ones that were not meant as yes still are not', () => {
    for (const y of ['ya', 'yaa', 'yess', 'yes send', 'yaa send', 'haan', 'avunu', 'ok send it', 'okk', 'k', 'yes please', 'yeah', 'ok now']) expect(parseYesNo(y), y).toBe('yes');
    for (const n of ['yes but change it', 'ok now go', 'yaa what about the colour', 'hmm', 'maybe', 'yes and also call him']) expect(parseYesNo(n), n).toBeNull();
    expect(parseYesNo('no')).toBe('no');
    expect(parseYesNo("don't send")).toBe('no');
  });

  it('being asked again is a yes only when a send is in it, and never with a no', () => {
    expect(isImpatientYes('fuck send why u askign me again gagin')).toBe(true);
    expect(isImpatientYes('i already said yes send it')).toBe(true);
    expect(isImpatientYes("don't send it, why are you asking again")).toBe(false);
    expect(isImpatientYes('why is the sky blue')).toBe(false);
  });

  it('a change asked for in a written message is told from a new request', () => {
    for (const e of ['make it shorter', 'add that I miss him', 'change it to something more polite', 'remove the part about Diwali', 'instead say I will call at nine']) expect(looksLikeEdit(e), e).toBe(true);
    for (const e of ['what is the weather', 'open youtube', 'yes', 'no', 'hi']) expect(looksLikeEdit(e), e).toBe(false);
  });
});
