import { describe, expect, it } from 'vitest';
import type { LiveChatMessage } from '../src/main/browser/BrowserAutomationService';
import { buildNudgeMessages } from '../src/main/livechat/draft';
import { IDLE_STOP_MS } from '../src/main/livechat/auto';
import { askedJustBefore, needsReply } from '../src/main/livechat/messages';
import { FakeSwitch, rig, settle } from './liveChatFixtures';
import type { Rig, RigOptions } from './liveChatFixtures';

/**
 * "When the other person says something to tell Rakesh, Eya says ok, and then what else — she keeps the chat going. And a chat must not just be gone because the other person
 * takes time to answer." Over a MOCK chat and a MOCK model, with the clock moved by hand.
 */

const MIN = 60_000;
const FIVE = 5 * MIN;
const INTRO = "Hi! I am Eya, Rakesh's assistant 😊 What do you need?";
const CHECK = 'Still around? Anything else you want me to tell Rakesh? 😊';

function switched(options: RigOptions = {}) {
  const sw = new FakeSwitch();
  sw.on = true;
  const r = rig({ ...options, enable: sw.control });
  return { sw, r };
}

/** Automatic mode, introduction sent, nothing else yet. */
async function running(options: RigOptions = {}, intro = INTRO): Promise<Rig> {
  const { r } = switched(options);
  r.ai.say(intro);
  await r.controller.start('Rahul Sharma');
  await settle(40);
  return r;
}

/** They write, Eya answers (after the ten seconds there are between two automatic replies). */
async function theySay(r: Rig, text: string, reply: string, extra: Record<string, unknown> = {}): Promise<void> {
  r.ai.say(reply, extra);
  r.chat.incoming(text);
  r.chat.changed();
  await settle(40);
  r.advance(12_000);
  await settle(40);
}

const msg = (id: string, dir: 'in' | 'out', text: string, kind: LiveChatMessage['kind'] = 'text'): LiveChatMessage => ({ id, dir, kind, text, at: '10:00' });

describe('taking something down for Rakesh never leaves the other person with nothing', () => {
  it('the model noted a message for him but wrote no reply: it is asked once more, and the reply goes out ("ok, I will tell him — anything else?")', async () => {
    const r = await running();
    r.ai.say(null, { for_owner: 'she asks you to call her tonight' }); // (the first answer: a note, and nothing to say)
    r.ai.say('ok, I will tell Rakesh. Anything else you want me to say to him?'); // (asked again)
    r.chat.incoming('please tell Rakesh to call me tonight');
    r.chat.changed();
    await settle(40);
    r.advance(12_000);
    await settle(40);
    expect(r.ai.calls).toBe(3); // (the introduction, the answer, the second answer)
    expect(r.ai.requests.at(-1)).toMatch(/You wrote no reply, but the other person is waiting/);
    expect(r.ai.requests.at(-1)).toMatch(/carry on the conversation with one small friendly question about THEM or about what they just said/);
    expect(r.ai.requests.at(-1)).toMatch(/Do not ask whether there is anything else to tell Rakesh/);
    expect(r.chat.pressed.at(-1)).toBe('ok, I will tell Rakesh. Anything else you want me to say to him?');
    // the note for Rakesh is taken down ONCE and said to him once
    expect(r.controller.view().forYou.map((n) => n.text)).toEqual(['she asks you to call her tonight']);
    expect(r.said).toHaveLength(1);
    expect(r.controller.state).toBe('ACTIVE');
  });

  it('a question only he can answer, handed back without a reply: she is asked once more and answers the person herself', async () => {
    const r = await running();
    r.ai.say(null, { needs_user: 'where is Rakesh? only he knows' });
    r.ai.say('I do not know where he is, but I will ask him and tell you. Anything else?');
    r.chat.incoming('where is Rakesh?');
    r.chat.changed();
    await settle(40);
    r.advance(12_000);
    await settle(40);
    expect(r.chat.pressed.at(-1)).toBe('I do not know where he is, but I will ask him and tell you.'); // ("Anything else?" was cut: a reply is as long as a person would write)
    expect(r.controller.state).toBe('ACTIVE'); // (not "I need you for this one": the other person never waits for Rakesh)
  });

  it('asked again and still nothing: there is no third call, nothing is made up, the note is kept — and the plain true line goes out, so they are not left with silence', async () => {
    const r = await running();
    r.ai.say(null, { for_owner: 'she wants a call' });
    r.ai.say(null);
    r.chat.incoming('tell Rakesh to call me');
    r.chat.changed();
    await settle(40);
    r.advance(12_000);
    await settle(40);
    expect(r.ai.calls).toBe(3);
    expect(r.chat.pressed).toEqual([INTRO, "Sure, I'll let Rakesh know! 😊"]);
    expect(r.controller.view().forYou.map((n) => n.text)).toEqual(['she wants a call']);
    expect(r.controller.state).toBe('ACTIVE');
  });

  it('the second call fails: no error is shown for it, the note is kept, and the plain true line still goes out', async () => {
    const r = await running();
    r.ai.say(null, { for_owner: 'she wants a call' });
    r.ai.raw(new Error('its limit is used up'));
    r.chat.incoming('tell Rakesh to call me');
    r.chat.changed();
    await settle(40);
    r.advance(12_000);
    await settle(40);
    expect(r.controller.view().error).toBeNull();
    expect(r.controller.view().forYou).toHaveLength(1);
    expect(r.chat.pressed.at(-1)).toBe("Sure, I'll let Rakesh know! 😊");
    expect(r.controller.state).toBe('ACTIVE');
  });

  it('when she is not writing as Eya (Assisted mode), nothing is asked twice', async () => {
    const r = rig();
    r.ai.say(null, { for_owner: 'she wants a call' });
    await r.controller.start('Rahul', 'assisted');
    await settle();
    r.chat.incoming('tell Rakesh to call me');
    r.chat.changed();
    await settle(40);
    expect(r.ai.calls).toBe(1);
  });

  it('nothing taken down and nothing to say ("see you then"): nothing is asked twice either', async () => {
    const r = await running();
    r.ai.say(null);
    r.chat.incoming('ok see you tomorrow then');
    r.chat.changed();
    await settle(40);
    expect(r.ai.calls).toBe(2);
    expect(r.chat.pressed).toEqual([INTRO]);
  });
});

describe('a word that answers her own question is answered', () => {
  const ask = msg('a', 'out', 'Anything else you want me to tell Rakesh?');
  it('"yes" right after her question is a message to answer; "thanks" or "ok" after a plain statement is not', () => {
    expect(askedJustBefore([ask, msg('b', 'in', 'yes')], [msg('b', 'in', 'yes')])).toBe(true);
    expect(askedJustBefore([msg('a', 'out', 'I will tell him.'), msg('b', 'in', 'yes')], [msg('b', 'in', 'yes')])).toBe(false);
    expect(askedJustBefore([ask, msg('c', 'in', 'wait'), msg('b', 'in', 'yes')], [msg('b', 'in', 'yes')])).toBe(false); // (an old question does not count)
    expect(askedJustBefore([msg('a', 'in', 'what?'), msg('b', 'in', 'yes')], [msg('b', 'in', 'yes')])).toBe(false); // (their own question is not hers)
    expect(askedJustBefore([], [])).toBe(false);
    expect(needsReply([msg('b', 'in', 'yes')], { afterQuestion: true }).needed).toBe(true);
    expect(needsReply([msg('b', 'in', 'no')], { afterQuestion: true }).needed).toBe(true);
    expect(needsReply([msg('b', 'in', 'ok')], { afterQuestion: true }).needed).toBe(true);
    expect(needsReply([msg('b', 'in', 'thanks')], { afterQuestion: true }).needed).toBe(false);
    expect(needsReply([msg('b', 'in', '👍')], { afterQuestion: true }).needed).toBe(false);
    expect(needsReply([msg('b', 'in', 'yes')], {}).needed).toBe(false);
    expect(needsReply([msg('b', 'in', 'ok')], { afterQuestion: false }).needed).toBe(false);
  });

  it('in a live chat: "yes" after her question gets a reply; "ok" after a statement does not', async () => {
    const asked = await running();
    await theySay(asked, 'yes', 'great, tell me what it is');
    expect(asked.chat.pressed.at(-1)).toBe('great, tell me what it is');

    const stated = await running({}, "Hi! I am Eya, Rakesh's assistant 😊");
    stated.chat.incoming('ok');
    stated.chat.changed();
    await settle(40);
    stated.advance(12_000);
    await settle(40);
    expect(stated.ai.calls).toBe(1); // (only the introduction: nothing was asked of the model)
    expect(stated.chat.pressed).toHaveLength(1);
  });
});

describe('a chat that goes quiet is checked on once before it ends', () => {
  it('five minutes of silence: ONE friendly check-in goes out and the chat is still on; five more minutes: it ends, and says it checked in', async () => {
    const r = await running({ idleStopMs: FIVE });
    r.ai.say(CHECK);
    r.ai.say('Hello again? Anything you want me to pass on?'); // (a second check-in would be possible, if she made one: she must not)
    r.advance(FIVE);
    await settle(60);
    expect(r.chat.pressed).toEqual([INTRO, CHECK]);
    expect(r.controller.state).toBe('ACTIVE');
    expect(r.chat.watching).toBe(true);
    r.advance(FIVE - 1_000);
    await settle(40);
    expect(r.controller.state).toBe('ACTIVE'); // (not a moment before)
    r.advance(2_000);
    await settle(60);
    expect(r.controller.state).toBe('STOPPED');
    expect(r.chat.pressed).toEqual([INTRO, CHECK]); // (one check-in, not two)
    expect(r.controller.view().notice).toMatch(/did not write back, even after I checked in, for 5 more minutes/);
    expect(r.alerts.some((a) => /stayed quiet after my check-in/.test(a))).toBe(true);
  });

  it('not a moment before the first five minutes are up', async () => {
    const r = await running({ idleStopMs: FIVE });
    r.ai.say(CHECK);
    r.advance(FIVE - 1_000);
    await settle(40);
    expect(r.chat.pressed).toEqual([INTRO]);
  });

  it('the check-in is written as a gentle one: Eya, quiet, never a complaint, in the other person\'s language', async () => {
    const r = await running({ idleStopMs: FIVE });
    r.ai.say(CHECK);
    r.advance(FIVE);
    await settle(60);
    const asked = r.ai.requests.at(-1) ?? '';
    expect(asked).toMatch(/The other person has gone quiet/);
    expect(asked).toMatch(/a gentle check-in, never a complaint/);
    expect(asked).toMatch(/do not say they took long, that you have been waiting/);
    expect(asked).toMatch(/SAME language and script/);
    expect(asked).toMatch(/has not written for about 5 minutes/);
    expect(asked).toMatch(/Never invent anything about Rakesh/);
    const messages = buildNudgeMessages({ context: [], summary: '', tone: 'x', ownerName: 'Rakesh', minutes: 5 });
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toMatch(/never claim to be a human/);
  });

  it('if they write back, the chat goes on — and a LATER silence gets its own check-in', async () => {
    const r = await running({ idleStopMs: FIVE });
    r.ai.say(CHECK);
    r.advance(FIVE);
    await settle(60);
    expect(r.chat.pressed).toEqual([INTRO, CHECK]);
    await theySay(r, 'sorry was busy, tell Rakesh I called', 'no problem! I will tell him. Anything else?', { for_owner: 'she called' });
    expect(r.chat.pressed.at(-1)).toBe('no problem! I will tell him. Anything else?');
    r.ai.say('Hope everything is okay there. Want me to tell Rakesh anything more?');
    r.advance(FIVE);
    await settle(60);
    expect(r.chat.pressed.at(-1)).toBe('Hope everything is okay there. Want me to tell Rakesh anything more?');
    expect(r.controller.state).toBe('ACTIVE');
    expect(r.chat.pressed).toHaveLength(4);
  });

  it('a "thanks" from them needs no answer, but it still means they are back: a later silence gets its own check-in', async () => {
    const r = await running({ idleStopMs: FIVE });
    r.ai.say(CHECK);
    r.advance(FIVE);
    await settle(60);
    r.chat.incoming('thanks'); // (nothing is sent in answer)
    r.chat.changed();
    await settle(40);
    expect(r.chat.pressed).toEqual([INTRO, CHECK]);
    r.ai.say('Take care then. Shout if you need anything told to Rakesh.');
    r.advance(FIVE);
    await settle(60);
    expect(r.chat.pressed.at(-1)).toBe('Take care then. Shout if you need anything told to Rakesh.');
    expect(r.controller.state).toBe('ACTIVE');
  });

  it('anything else Eya sends (Rakesh\'s own words, for example) gives them a new chance too', async () => {
    const r = await running({ idleStopMs: FIVE });
    r.ai.say(CHECK);
    r.advance(FIVE);
    await settle(60);
    expect(r.chat.pressed).toEqual([INTRO, CHECK]);
    const sent = await r.controller.handle({ kind: 'relay', text: 'I will call at 6' });
    expect(sent.ok).toBe(true);
    await settle(40);
    expect(r.chat.pressed.at(-1)).toBe('Rakesh says: I will call at 6');
    r.ai.say('Just checking you got that. Anything else for Rakesh?');
    r.advance(FIVE);
    await settle(60);
    expect(r.chat.pressed.at(-1)).toBe('Just checking you got that. Anything else for Rakesh?');
    expect(r.controller.state).toBe('ACTIVE');
  });

  it('when the AI cannot write one, nothing is made up: the chat ends the way it did before, after five minutes', async () => {
    const r = await running({ idleStopMs: FIVE });
    r.advance(FIVE); // (nothing is queued: the model "cannot answer")
    await settle(60);
    expect(r.controller.state).toBe('STOPPED');
    expect(r.chat.pressed).toEqual([INTRO]);
    expect(r.controller.view().notice).toMatch(/did not write for 5 minutes/);
    expect(r.controller.view().notice).not.toMatch(/even after/);
  });

  it('when Eya may not answer by herself (Assisted mode) there is no check-in: a message would only sit waiting for the person', async () => {
    const r = rig({ idleStopMs: FIVE });
    r.ai.say(CHECK);
    await r.controller.start('Rahul', 'assisted');
    await settle();
    r.advance(FIVE);
    await settle(60);
    expect(r.controller.state).toBe('STOPPED');
    expect(r.ai.calls).toBe(0);
    expect(r.chat.pressed).toEqual([]);
  });

  it('a check-in that would go out by itself only through the same gate: one that mentions something private is not sent, and the chat ends', async () => {
    const r = await running({ idleStopMs: FIVE });
    r.ai.say('Anything else? You can tell me your password too');
    r.advance(FIVE);
    await settle(60);
    expect(r.chat.pressed).toEqual([INTRO]);
    expect(r.controller.state).toBe('STOPPED');
    expect(r.controller.view().draft).toBeNull();
  });

  it('a message that arrives while she is writing the check-in is not met with a check-in: it is answered', async () => {
    const r = await running({ idleStopMs: FIVE });
    r.ai.say(CHECK);
    r.ai.say('ha, good to hear from you');
    let release: () => void = () => undefined;
    r.ai.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    r.advance(FIVE);
    await settle(40); // (the model is "thinking" about the check-in)
    r.chat.incoming('hey, I am back');
    r.chat.changed();
    release();
    r.ai.hold = null;
    await settle(80);
    r.advance(12_000);
    await settle(80);
    expect(r.chat.pressed).not.toContain(CHECK);
    expect(r.chat.pressed.at(-1)).toBe('ha, good to hear from you');
    expect(r.controller.state).toBe('ACTIVE');
  });

  it('they write while she tries to write the check-in and the AI fails: the chat is not ended over it, their message is answered', async () => {
    const r = await running({ idleStopMs: FIVE });
    r.ai.raw(new Error('its limit is used up')); // (the check-in cannot be written)
    r.ai.say('ha, welcome back');
    let release: () => void = () => undefined;
    r.ai.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    r.advance(FIVE);
    await settle(40);
    r.chat.incoming('hey, I am back');
    r.chat.changed();
    release();
    r.ai.hold = null;
    await settle(80);
    r.advance(40_000);
    await settle(80);
    expect(r.controller.state).toBe('ACTIVE');
    expect(r.chat.pressed.at(-1)).toBe('ha, welcome back');
  });

  it('the person typing in the chat themself while she writes it means the chat is alive too: no check-in, and the watch for silence starts again from there', async () => {
    const r = await running({ idleStopMs: FIVE });
    r.ai.say(CHECK);
    let release: () => void = () => undefined;
    r.ai.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    r.advance(FIVE);
    await settle(40);
    r.chat.outgoing('I will call you in the evening'); // (typed on the phone, not by Eya)
    release();
    r.ai.hold = null;
    await settle(80);
    expect(r.chat.pressed).toEqual([INTRO]);
    expect(r.controller.state).toBe('ACTIVE');
    r.advance(4 * MIN);
    await settle(40);
    expect(r.controller.state).toBe('ACTIVE'); // (five minutes are counted from what the person wrote, not from the introduction)
    r.ai.say(CHECK);
    r.advance(2 * MIN);
    await settle(60);
    expect(r.chat.pressed.at(-1)).toBe(CHECK);
  });

  it('a check-in that could not go out is not left waiting for the person as if it were a reply', async () => {
    const r = await running({ idleStopMs: FIVE });
    r.ai.say(CHECK);
    r.chat.notSent = 'WhatsApp would not take the message.';
    r.advance(FIVE);
    await settle(60);
    expect(r.chat.pressed).toEqual([INTRO]);
    expect(r.controller.view().draft?.status).not.toBe('ready');
    expect(r.controller.view().draft?.status).not.toBe('approved');
  });
});

describe('Rakesh taking time to answer does not end the chat or hold up the other person', () => {
  it('they ask for Rakesh, she says ok and asks what else; Rakesh says nothing for a long while; the chat is alive, then they add something and it carries on', async () => {
    const r = await running({ idleStopMs: FIVE });
    await theySay(r, 'please tell Rakesh his father wants to talk to him', 'ok, I will tell Rakesh. Is there anything else you want me to say to him?', { for_owner: 'your father wants to talk to you' });
    expect(r.chat.pressed.at(-1)).toBe('ok, I will tell Rakesh. Is there anything else you want me to say to him?');
    expect(r.said).toHaveLength(1); // (Rakesh is told, aloud and on the screen — and does not answer)
    r.advance(4 * MIN); // (Rakesh is away: nobody has answered the note)
    await settle(40);
    expect(r.controller.state).toBe('ACTIVE');
    await theySay(r, 'yes, tell him I am at the hospital with mother', 'oh, I hope she is okay. I will tell him right away.', { for_owner: 'she is at the hospital with her mother' });
    expect(r.said).toHaveLength(2);
    expect(r.controller.view().forYou).toHaveLength(2);
    r.advance(4 * MIN);
    await settle(40);
    expect(r.controller.state).toBe('ACTIVE');
    expect(r.controller.view().draft?.status).not.toBe('ready'); // (nothing is waiting for Rakesh to approve)
  });
});

describe('the quiet time is fifteen minutes (the person asked for 15 on 6 Nov 2026; it was 5)', () => {
  it('is fifteen minutes by default, and the page is told so', async () => {
    expect(IDLE_STOP_MS).toBe(15 * MIN);
    const r = await running({ idleStopMs: IDLE_STOP_MS });
    expect(r.controller.view().idleStopMinutes).toBe(15);
  });

  it('nothing at five minutes (it used to check in there), nothing a second before fifteen; ONE check-in at fifteen; fifteen more, and it ends and says so', async () => {
    const r = await running({ idleStopMs: IDLE_STOP_MS });
    r.ai.say(CHECK);
    r.ai.say('A second check-in must not be written'); // (she must not)
    r.advance(5 * MIN);
    await settle(40);
    expect(r.chat.pressed).toEqual([INTRO]);
    r.advance(10 * MIN - 1_000);
    await settle(40);
    expect(r.chat.pressed).toEqual([INTRO]);
    expect(r.controller.state).toBe('ACTIVE');
    r.advance(2_000);
    await settle(60);
    expect(r.chat.pressed).toEqual([INTRO, CHECK]);
    expect(r.controller.state).toBe('ACTIVE');
    r.advance(14 * MIN);
    await settle(40);
    expect(r.controller.state).toBe('ACTIVE'); // (a quiet quarter of an hour after the check-in is still not the end)
    r.advance(1 * MIN + 1_000);
    await settle(60);
    expect(r.controller.state).toBe('STOPPED');
    expect(r.chat.pressed).toEqual([INTRO, CHECK]);
    expect(r.controller.view().notice).toMatch(/did not write back, even after I checked in, for 15 more minutes/);
  });

  it('the longest gap a person can set between two automatic replies (ten minutes) is shorter than the quiet time now, so the check-in is never held back by it', async () => {
    const r = await running({ idleStopMs: IDLE_STOP_MS });
    r.ai.say(CHECK);
    r.advance(15 * MIN);
    await settle(60);
    expect(r.chat.pressed).toEqual([INTRO, CHECK]);
  });
});
