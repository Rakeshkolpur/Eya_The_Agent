import { describe, expect, it } from 'vitest';
import { FakeSwitch, rig, settle } from './liveChatFixtures';
import type { Rig, RigOptions } from './liveChatFixtures';

/**
 * Seen on the real WhatsApp on 6 Nov 2026 (the app's own log): the first reply of an automatic live chat went out; the second reply's Send failed half a second after it was
 * pressed; and that ONE failure switched automatic replies off for the rest of the conversation. Every later message got a draft that only waited for approval in Eya — so Eya
 * showed replies, and WhatsApp showed nothing — until the person paused and resumed the chat. Over a MOCK chat and a MOCK model, with the clock moved by hand: a reply that
 * cannot be sent is tried again, a message that went is never sent twice, and automatic replies end only after several failures in a row — and say why.
 */

const SAY = "I couldn't press Send.";
const INTRO = "Hi! I am Eya, Rakesh's assistant 😊 What do you need?";
const CHECK = 'Still around? Anything else you want me to tell Rakesh? 😊';
const MIN = 60_000;

/** Automatic mode, introduction sent. */
async function running(options: RigOptions = {}): Promise<Rig> {
  const sw = new FakeSwitch();
  sw.on = true;
  const r = rig({ ...options, enable: sw.control });
  r.ai.say(INTRO);
  await r.controller.start('Rahul Sharma');
  await settle(40);
  return r;
}

/** They write; Eya's reply is attempted once the ten seconds between two automatic replies have passed. */
async function theyWrite(r: Rig, text: string, reply: string): Promise<void> {
  r.ai.say(reply);
  r.chat.incoming(text);
  r.chat.changed();
  await settle(40);
  r.advance(12_000);
  await settle(40);
}

async function wait(r: Rig, ms: number): Promise<void> {
  r.advance(ms);
  await settle(40);
}

describe('a reply that could not be sent is tried again; automatic replies stay on', () => {
  it('the second reply fails to send (as on the real WhatsApp): the chat says so, stays in automatic mode, and the same reply goes out a few seconds later', async () => {
    const r = await running();
    await theyWrite(r, 'How are you?', 'I am good, thanks!'); // (the first reply goes)
    expect(r.chat.pressed.at(-1)).toBe('I am good, thanks!');
    r.chat.failSends = 1;
    await theyWrite(r, 'What is Rakesh doing?', 'I do not know, but I will ask Rakesh.');
    // (the Send failed: nothing went, the reply waits, automatic mode is NOT ended)
    expect(r.chat.pressed.at(-1)).toBe('I am good, thanks!');
    expect(r.controller.view().mode).toBe('auto');
    expect(r.controller.view().notice).toMatch(/could not send the reply just now.*I will try again in a few seconds/);
    await wait(r, 5_000);
    expect(r.chat.pressed.at(-1)).toBe('I do not know, but I will ask Rakesh.');
    expect(r.controller.view().mode).toBe('auto');
    expect(r.controller.state).toBe('ACTIVE');
    expect(r.controller.view().notice).toBeNull();
    // and the one after it is answered by itself, as before
    await theyWrite(r, 'ok tell him', 'Ok, I will tell Rakesh. Anything else?');
    expect(r.chat.pressed.at(-1)).toBe('Ok, I will tell Rakesh. Anything else?');
    expect(r.chat.pressed.filter((t) => t === 'I do not know, but I will ask Rakesh.')).toHaveLength(1);
  });

  it('three failures in a row end automatic replies, and say what failed and how many times — and nothing is tried after that', async () => {
    const r = await running();
    r.chat.failSends = 99;
    await theyWrite(r, 'Hello?', 'Hi!');
    expect(r.controller.view().mode).toBe('auto'); // (first failure)
    await wait(r, 5_000);
    expect(r.controller.view().mode).toBe('auto'); // (second)
    await wait(r, 5_000);
    expect(r.controller.view().mode).toBe('assisted'); // (third: it is over)
    expect(r.controller.view().notice).toMatch(/Automatic reply stopped: I couldn't press Send\. It failed 3 times in a row\. Control is back with you/);
    expect(r.alerts.some((a) => /Automatic replies stopped/.test(a))).toBe(true);
    // the reply waits for the person; nothing is pressed again by itself
    expect(r.controller.view().draft?.text).toBe('Hi!');
    r.chat.failSends = 0;
    await wait(r, 2 * MIN);
    expect(r.chat.pressed).toEqual([INTRO]);
  });

  it('failures that a success separates are not "in a row": the count starts again after a reply goes out', async () => {
    const r = await running();
    for (const [said, reply] of [['one?', 'Reply one.'], ['two?', 'Reply two.'], ['three?', 'Reply three.']] as const) {
      r.chat.failSends = 2; // (two failures, then it works: six failures over three replies, never three in a row)
      await theyWrite(r, said, reply);
      await wait(r, 5_000);
      await wait(r, 5_000);
      expect(r.chat.pressed.at(-1)).toBe(reply);
      expect(r.controller.view().mode).toBe('auto');
    }
  });

  it('what failed before a pause is not "in a row" with what fails after the chat is resumed', async () => {
    const r = await running();
    r.chat.failSends = 2;
    await theyWrite(r, 'first', 'Reply A.'); // (one failure: the retry is waiting)
    await r.controller.handle({ kind: 'pause' });
    await wait(r, 30 * MIN);
    await r.controller.handle({ kind: 'resume' });
    await settle(60);
    r.chat.failSends = 2; // (the page will not take the next two either — two failures now, a third press works)
    await theyWrite(r, 'second', 'Reply B.');
    await wait(r, 5_000);
    await wait(r, 5_000);
    expect(r.controller.view().mode).toBe('auto');
    expect(r.chat.pressed.at(-1)).toBe('Reply B.');
  });

  it('switching automatic replies on again starts the count again', async () => {
    const r = await running();
    r.chat.failSends = 2;
    await theyWrite(r, 'first', 'Reply A.');
    await wait(r, 5_000); // (two failures so far)
    expect(r.controller.view().mode).toBe('auto');
    await r.controller.handle({ kind: 'enable_auto', confirmedAware: true, introduce: false });
    r.chat.failSends = 1;
    await theyWrite(r, 'second', 'Reply B.'); // (one failure: with the old count this would have been the third)
    await wait(r, 5_000);
    expect(r.controller.view().mode).toBe('auto');
    expect(r.chat.pressed.at(-1)).toBe('Reply B.');
  });

  it('a press that SAID it failed but whose message is in the chat all the same is a sent message: it is not sent again', async () => {
    const r = await running();
    r.chat.saysNotSentButSent = true;
    await theyWrite(r, 'How are you?', 'I am good, thanks!');
    await wait(r, 10_000);
    await wait(r, 10_000);
    expect(r.chat.pressed.filter((t) => t === 'I am good, thanks!')).toHaveLength(1);
    expect(r.controller.view().mode).toBe('auto');
    expect(r.controller.view().draft?.status).toBe('sent'); // (counted as the reply it was)
    expect(r.controller.state).toBe('ACTIVE');
    expect(r.controller.view().notice).toBeNull();
  });

  it('the page cannot be read for the check just before sending: the reply does not sit ready until another message happens to arrive — it is tried again', async () => {
    const r = await running();
    r.ai.say('I am good, thanks!');
    r.chat.incoming('How are you?');
    // (the reads before the reply: the one that finds the message; the one that checks the chat before pressing Send — that second one cannot be trusted)
    r.chat.unreliableOnRead = r.chat.reads + 2;
    r.chat.changed();
    await settle(40);
    r.advance(12_000);
    await settle(40);
    await wait(r, 5_000);
    expect(r.chat.pressed.at(-1)).toBe('I am good, thanks!');
    expect(r.controller.view().mode).toBe('auto');
    expect(r.controller.state).toBe('ACTIVE');
  });

  it('a check-in that could not go out is dropped: it neither ends automatic replies nor is it tried again', async () => {
    const r = await running({ idleStopMs: 5 * MIN });
    r.ai.say(CHECK);
    r.chat.failSends = 99;
    r.advance(5 * MIN);
    await settle(60);
    expect(r.chat.pressed).toEqual([INTRO]);
    expect(r.controller.view().mode).toBe('auto');
    // (a check-in is not "a reply that could not be sent": nothing is said about trying again)
    expect(r.controller.view().notice ?? '').not.toMatch(/could not send the reply|try again/);
    r.chat.failSends = 0;
    await wait(r, 20_000);
    expect(r.chat.pressed).toEqual([INTRO]); // (not tried again by itself)
    expect(r.controller.view().draft?.status).not.toBe('ready');
  });

  it('a Send the PERSON pressed (Assisted mode) that failed is not tried again by itself: it waits for them, as before', async () => {
    const r = rig(); // (no live chat switch: that one turns automatic replies on by itself)
    await r.controller.start('Rahul Sharma', 'assisted');
    await settle(40);
    expect(r.controller.view().mode).toBe('assisted');
    r.ai.say('Yes, call me.');
    r.chat.incoming('Can we talk today?');
    r.chat.changed();
    await settle(40);
    r.chat.failSends = 1;
    const res = await r.controller.handle({ kind: 'send' });
    expect(res.ok).toBe(false);
    await wait(r, 60_000);
    expect(r.chat.pressed).toEqual([]);
    expect(r.controller.view()).toMatchObject({ state: 'WAITING_FOR_APPROVAL', draft: { status: 'ready' } });
    // (it was the person's own press: nothing is said about Eya trying again)
    expect(r.controller.view().notice ?? '').not.toMatch(/try again/);
  });

  it('a new message while the reply is waiting to be tried again is answered with a new reply (the old one is out of date), and the chat carries on', async () => {
    const r = await running();
    r.chat.failSends = 1;
    await theyWrite(r, 'How are you?', 'Old reply.');
    expect(r.chat.pressed).toEqual([INTRO]);
    r.ai.say('New reply, about both.');
    r.chat.incoming('Are you there?');
    r.chat.changed();
    await settle(40);
    await wait(r, 12_000);
    await wait(r, 6_000);
    expect(r.chat.pressed).not.toContain('Old reply.');
    expect(r.chat.pressed.at(-1)).toBe('New reply, about both.');
    expect(r.controller.view().mode).toBe('auto');
  });
});
