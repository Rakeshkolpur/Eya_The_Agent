import { describe, expect, it } from 'vitest';
import { parseLiveStart } from '../src/main/livechat/liveChatRequest';

/**
 * How people actually ask for a live chat. The first sentence below is the one that was said to Eya and was refused by the AI model — because Eya did not
 * recognise it as a live chat request at all.
 */

describe('the sentence that was refused', () => {
  const said =
    '+91 98765 08501  do live chat with this number she is my close friend u can make her happy she also no Eya msging here, ok do . in whatsapp';

  it('is a live chat with that number', () => {
    expect(parseLiveStart(said)).toMatchObject({ target: '+91 98765 08501' });
  });

  it('the person said she knows Eya is messaging, and that Eya is to make her happy — so Eya writes first', () => {
    const r = parseLiveStart(said);
    expect(r?.aware).toBe(true);
    expect(r?.opening).toBe(true);
    expect(r?.purpose).toMatch(/close friend/);
    expect(r?.purpose).toMatch(/make her happy/);
    expect(r?.purpose).not.toMatch(/98765/); // the number is who, not what
  });

  it('"do live chat now go", said straight after, is a live chat too: with nobody named, so the last one is used', () => {
    expect(parseLiveStart('do live chat now go')).toMatchObject({ target: null, aware: false, opening: false, purpose: '' });
  });
});

describe('who', () => {
  it.each([
    ['Start live chat with my friend Rahul', 'Rahul'],
    ['start a live chat with Rahul Sharma', 'Rahul Sharma'],
    ['please begin live chat with Priya on WhatsApp', 'Priya'],
    ['open the live WhatsApp chat with Amma', 'Amma'],
    ['start live chat with Rahul in assisted mode', 'Rahul'],
    ['start live chat with Rahul in auto mode', 'Rahul'],
    ['start live chat with my close friend Anna Reddy and she knows it is Eya', 'Anna Reddy'],
    ['do live chat with 9361113900', '9361113900'],
    ['live chat with +91 98765 43210 please', '+91 98765 43210'],
    ['9361113900 live chat start', '9361113900'],
  ])('%s → %s', (said, target) => {
    expect(parseLiveStart(said)?.target).toBe(target);
  });

  it('"this number" with no number in the sentence names nobody', () => {
    expect(parseLiveStart('do live chat with this number')?.target).toBeNull();
    expect(parseLiveStart('start live chat with her')?.target).toBeNull();
  });

  it('a number too short or not a whole number is not taken for who', () => {
    expect(parseLiveStart('do live chat with 1234 please')?.target).toBeNull();
  });
});

describe('what the person said about the other person knowing', () => {
  it.each([
    'start live chat with Rahul he knows Eya is messaging him',
    'do live chat with 9361113900 she also knows it is Eya',
    'live chat with Priya, she is aware that Eya is chatting',
    'start live chat with Amma she agrees to this chat with the assistant',
    'do live chat with 9361113900 she also no Eya msging here',
  ])('%s → aware', (said) => {
    expect(parseLiveStart(said)?.aware).toBe(true);
  });

  it.each([
    'start live chat with Rahul he does not know it is Eya',
    'do live chat with 9361113900 she doesnt know about the assistant',
    'start live chat with Priya secretly',
    'start live chat with Rahul and dont tell him it is Eya',
    'start live chat with Rahul secretly, he knows nothing about this chat',
    'start live chat with Priya, she knows Eya is chatting but do not tell her more',
    'start live chat with Rahul',
  ])('%s → NOT aware (so nothing is taken as her agreement)', (said) => {
    expect(parseLiveStart(said)?.aware).toBe(false);
  });

  it('and never writes first to someone who is not known to know', () => {
    expect(parseLiveStart('start live chat with Rahul and make him happy but he does not know it is Eya')?.opening).toBe(false);
    expect(parseLiveStart('start live chat with Rahul secretly make him happy')?.opening).toBe(false);
  });
});

describe('writing first, and automatic replies in words', () => {
  it.each([
    'start live chat with Rahul and make him happy',
    'do live chat with Priya cheer her up',
    'start live chat with Amma and say hi',
    'live chat with 9361113900 talk to her',
  ])('%s → Eya writes first', (said) => {
    expect(parseLiveStart(said)?.opening).toBe(true);
  });

  it('a plain request does not make Eya write first', () => {
    expect(parseLiveStart('start live chat with Rahul')).toMatchObject({ opening: false, autoAsked: false });
  });

  it.each(['start live chat with Rahul and reply automatically', 'start live chat with Rahul in auto mode', 'live chat with Priya reply by yourself', 'start live chat with Amma without asking me'])(
    '%s → automatic replies asked for',
    (said) => {
      expect(parseLiveStart(said)?.autoAsked).toBe(true);
    },
  );

  it('draft and assisted are read as the mode, never auto', () => {
    expect(parseLiveStart('start live chat with Rahul in draft mode')?.mode).toBe('draft');
    expect(parseLiveStart('start live chat with Rahul in assisted mode')?.mode).toBe('assisted');
    expect(parseLiveStart('start live chat with Rahul in auto mode')?.mode).toBeUndefined();
  });
});

describe('not a request to start one', () => {
  it.each([
    'stop live chat',
    'please end the live chat',
    'pause the live chat',
    'resume live chat',
    'what is live chat',
    'how does the live chat work',
    'is the live chat running',
    "don't do live chat with Rahul",
    'do not start live chat with her',
    'send hello to Rahul on whatsapp',
    'open Rahul chat',
    'start a chat with Rahul',
  ])('%s', (said) => {
    expect(parseLiveStart(said)).toBeNull();
  });
});
