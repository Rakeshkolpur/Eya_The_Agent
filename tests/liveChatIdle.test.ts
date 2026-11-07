import { describe, expect, it } from 'vitest';
import { FakeSwitch, rig, settle } from './liveChatFixtures';
import type { RigOptions } from './liveChatFixtures';

/**
 * "Unlimited messages until I stop it — or until the other person has been silent for more than five minutes: then it stops by itself." Over a MOCK chat and a MOCK model, with
 * the clock moved by hand: what counts as silence, what does not, and that a conversation that keeps going is never cut off.
 */

const MIN = 60_000;
const FIVE = 5 * MIN;

function switched(options: RigOptions = {}) {
  const sw = new FakeSwitch();
  sw.on = true;
  const r = rig({ ...options, enable: sw.control });
  return { sw, r };
}

describe('a live chat stops by itself when the other person goes quiet', () => {
  it('five minutes of silence from the start: it stops, says why, and tells the person', async () => {
    const r = rig({ idleStopMs: FIVE });
    await r.controller.start('Rahul');
    await settle();
    expect(r.controller.state).toBe('ACTIVE');
    r.advance(FIVE);
    await settle();
    expect(r.controller.state).toBe('STOPPED');
    expect(r.controller.view().notice).toMatch(/did not write for 5 minutes/);
    expect(r.alerts.some((a) => /stopped: they did not write for 5 minutes/.test(a))).toBe(true);
    expect(r.chat.watching).toBe(false);
    expect(r.chat.stops).toBeGreaterThan(0);
  });

  it('not a moment before', async () => {
    const r = rig({ idleStopMs: FIVE });
    await r.controller.start('Rahul');
    await settle();
    r.advance(FIVE - 1_000);
    await settle();
    expect(r.controller.state).toBe('ACTIVE');
  });

  it('what the other person writes starts the count again from that moment', async () => {
    const r = rig({ idleStopMs: FIVE });
    await r.controller.start('Rahul');
    await settle();
    r.advance(4 * MIN);
    r.chat.incoming('ok'); // (nothing to answer: it is their turn again)
    r.chat.changed();
    await settle();
    expect(r.controller.state).toBe('ACTIVE');
    r.advance(4 * MIN); // (eight minutes since the start, four since they wrote)
    await settle();
    expect(r.controller.state).toBe('ACTIVE');
    r.advance(MIN + 5_000);
    await settle();
    expect(r.controller.state).toBe('STOPPED');
  });

  it('a message of Eya\'s own starts it too: the silence is counted from the reply they have not answered', async () => {
    const { r } = switched({ idleStopMs: FIVE });
    r.ai.say('Hi, I am Eya, Rakesh\'s assistant 😊');
    await r.controller.start('Rahul');
    await settle(40);
    expect(r.chat.pressed).toHaveLength(1); // (the introduction went out by itself)
    r.advance(4 * MIN);
    await settle();
    expect(r.controller.state).toBe('ACTIVE');
    r.advance(MIN + 5_000);
    await settle();
    expect(r.controller.state).toBe('STOPPED');
    expect(r.controller.view().notice).toMatch(/did not write for 5 minutes/);
  });
});

describe('the count restarts from Eya\'s own reply, which goes out after the message it answers', () => {
  it('their message at one moment, her reply twelve seconds later: five minutes are counted from the reply', async () => {
    const { r } = switched({ idleStopMs: FIVE });
    r.ai.say('Hi, I am Eya, Rakesh\'s assistant 😊');
    await r.controller.start('Rahul');
    await settle(40);
    r.ai.say('ha, nice one');
    r.chat.incoming('guess what happened today'); // (right after her introduction: her reply has to wait out the ten seconds between two automatic replies)
    r.chat.changed();
    await settle(40);
    expect(r.chat.pressed).toHaveLength(1);
    r.advance(12_000); // (the reply goes out now: twelve seconds after their message)
    await settle(40);
    expect(r.chat.pressed.at(-1)).toBe('ha, nice one');
    r.advance(FIVE - 6_000); // (just under five minutes after her reply, but more than five after their message)
    await settle();
    expect(r.controller.state).toBe('ACTIVE');
    r.advance(10_000);
    await settle();
    expect(r.controller.state).toBe('STOPPED');
  });
});

describe('what is NOT their silence', () => {
  it('a reply waiting for the person to approve it: a quarter of an hour of waiting does not end the chat (but four times the quiet time does: see below)', async () => {
    const r = rig({ idleStopMs: FIVE });
    r.ai.say('Sure, I will look.');
    await r.controller.start('Rahul', 'assisted');
    await settle();
    r.chat.incoming('Can you check this?');
    r.chat.changed();
    await settle(40);
    expect(r.controller.state).toBe('WAITING_FOR_APPROVAL');
    r.advance(15 * MIN);
    await settle();
    expect(r.controller.state).toBe('WAITING_FOR_APPROVAL');
    expect(r.controller.view().draft?.text).toBe('Sure, I will look.');
  });

  it('but not for ever: a reply nobody approves for four times the quiet time ends the chat, and says why (it was found "running" after 15 hours)', async () => {
    const r = rig({ idleStopMs: FIVE });
    r.ai.say('Sure, I will look.');
    await r.controller.start('Rahul', 'assisted');
    await settle();
    r.chat.incoming('Can you check this?');
    r.chat.changed();
    await settle(40);
    expect(r.controller.state).toBe('WAITING_FOR_APPROVAL');
    r.advance(21 * MIN);
    await settle();
    expect(r.controller.state).toBe('STOPPED');
    expect(r.controller.view().notice).toMatch(/Stopped by itself: nothing happened in the chat with .* for 2\d minutes \(a reply was waiting for your approval\)/);
    expect(r.alerts.some((a) => /stopped: nothing happened/.test(a))).toBe(true);
  });

  it('and when the person then dismisses that reply, the other person gets five minutes from that moment (not from a message that was long ago)', async () => {
    const r = rig({ idleStopMs: FIVE });
    r.ai.say('Sure, I will look.');
    await r.controller.start('Rahul', 'assisted');
    await settle();
    r.chat.incoming('Can you check this?');
    r.chat.changed();
    await settle(40);
    r.advance(15 * MIN);
    await settle();
    expect(r.controller.state).toBe('WAITING_FOR_APPROVAL');
    await r.controller.handle({ kind: 'discard' });
    await settle();
    expect(r.controller.state).toBe('ACTIVE');
    r.advance(4 * MIN);
    await settle();
    expect(r.controller.state).toBe('ACTIVE');
    r.advance(2 * MIN);
    await settle();
    expect(r.controller.state).toBe('STOPPED');
  });

  it('a message of theirs that has not been answered yet is never mistaken for silence', async () => {
    const r = rig({ idleStopMs: FIVE });
    await r.controller.start('Rahul');
    await settle();
    r.advance(FIVE - 10_000);
    r.chat.incoming('hello?'); // (arrives, and is not looked at: no event reaches Eya)
    r.advance(30_000);
    await settle();
    expect(r.controller.state).not.toBe('STOPPED');
  });

  it('a live chat the person paused is theirs to resume: it waits four times the quiet time, then ends (it used to wait for ever)', async () => {
    const r = rig({ idleStopMs: FIVE });
    await r.controller.start('Rahul');
    await settle();
    await r.controller.pause('user');
    r.advance(15 * MIN);
    await settle();
    expect(r.controller.state).toBe('PAUSED');
    r.advance(10 * MIN);
    await settle();
    expect(r.controller.state).toBe('STOPPED');
    expect(r.controller.view().notice).toMatch(/was paused for 20 minutes/);
  });

  it('a live chat that paused by itself (the browser was lost, the chat closed, Eya restarted) ends after the quiet time, not the longer one', async () => {
    const r = rig({ idleStopMs: FIVE });
    await r.controller.start('Rahul');
    await settle();
    await r.controller.pause('browser_lost');
    r.advance(4 * MIN);
    await settle();
    expect(r.controller.state).toBe('PAUSED');
    r.advance(2 * MIN);
    await settle();
    expect(r.controller.state).toBe('STOPPED');
    expect(r.controller.view().notice).toMatch(/was paused for 5 minutes/);
    expect(r.alerts.some((a) => /it had been paused for 5 minutes/.test(a))).toBe(true);
  });

  it('resuming starts the count afresh', async () => {
    const r = rig({ idleStopMs: FIVE });
    await r.controller.start('Rahul');
    await settle();
    r.advance(3 * MIN);
    await r.controller.pause('user');
    r.advance(12 * MIN);
    await r.controller.resume();
    await settle();
    r.advance(4 * MIN);
    await settle();
    expect(r.controller.state).toBe('ACTIVE');
    r.advance(2 * MIN);
    await settle();
    expect(r.controller.state).toBe('STOPPED');
  });
});

describe('everything else is unlimited', () => {
  it('a conversation that keeps going is never cut off: dozens of replies over hours, as long as they keep writing', async () => {
    const { r } = switched({ idleStopMs: FIVE });
    r.ai.say('Hi, I am Eya, Rakesh\'s assistant 😊');
    await r.controller.start('Rahul');
    await settle(40);
    for (let i = 1; i <= 40; i += 1) {
      r.advance(4 * MIN); // (never five minutes of silence)
      r.ai.say(`Reply ${i}`);
      r.chat.incoming(`message ${i}`);
      r.chat.changed();
      await settle(40);
      r.advance(12_000);
      await settle(40);
    }
    expect(r.controller.state).toBe('ACTIVE');
    expect(r.chat.pressed).toHaveLength(41);
    expect(r.controller.view().auto).toMatchObject({ maxReplies: null, until: null });
  });

  it('the view says so, and the setting can be switched off', async () => {
    const on = rig({ idleStopMs: FIVE });
    await on.controller.start('Rahul');
    expect(on.controller.view().idleStopMinutes).toBe(5);
    const off = rig({ idleStopMs: 0 });
    await off.controller.start('Rahul');
    expect(off.controller.view().idleStopMinutes).toBeNull();
    off.advance(5 * 60 * MIN);
    await settle();
    expect(off.controller.state).toBe('ACTIVE');
  });
});

describe('a live chat that nobody is running is not "running" (it was found alive after 15 hours, and it refused a new one)', () => {
  it('after a restart a chat that was last written a few minutes ago comes back paused, and then ends by itself after the quiet time if nobody resumes it', async () => {
    const r = rig({ idleStopMs: FIVE });
    await r.controller.start('Rahul');
    await settle();
    r.clock.now += 2 * MIN;
    const next = r.restarted();
    expect(next.state).toBe('PAUSED');
    r.advance(6 * MIN);
    await settle();
    expect(next.state).toBe('STOPPED');
  });

  it('after a restart a chat that was last written longer ago than the quiet time is NOT brought back', async () => {
    const r = rig({ idleStopMs: FIVE });
    await r.controller.start('Rahul');
    await settle();
    r.clock.now += 10 * MIN; // (Eya was closed; no timer ran)
    const next = r.restarted();
    expect(next.state).toBe('STOPPED');
    expect(next.view().draft).toBeNull();
  });

  it('a saved chat from a version that did not write the time is not brought back either', async () => {
    const r = rig({ idleStopMs: FIVE });
    await r.controller.start('Rahul');
    await settle();
    const saved = JSON.parse(r.io.read('live-chat.json') as string) as Record<string, unknown>;
    delete saved['savedAt'];
    r.io.write('live-chat.json', JSON.stringify(saved));
    const next = r.restarted();
    expect(next.state).toBe('STOPPED');
  });

  it('asking for a new live chat while the old one is paused ends the old one and starts the new, and says so', async () => {
    const r = rig({ idleStopMs: FIVE });
    await r.controller.start('Rahul');
    await settle();
    await r.controller.pause('browser_lost');
    const second = await r.controller.start('Priya');
    expect(second.ok).toBe(true);
    expect(second.message).toMatch(/^I ended the earlier live chat with Rahul Sharma \(it was paused\)\./);
  });

  it('asking while the old one has done nothing for the whole quiet time (its timer has not run yet) replaces it too', async () => {
    const r = rig({ idleStopMs: FIVE });
    await r.controller.start('Rahul');
    await settle();
    r.clock.now += 6 * MIN;
    const second = await r.controller.start('Priya');
    expect(second.ok).toBe(true);
    expect(second.message).toMatch(/I ended the earlier live chat with Rahul Sharma/);
  });

  it('asking while the old one is really running explains how long ago it was active, that one runs at a time, and how to switch', async () => {
    const r = rig({ idleStopMs: FIVE });
    await r.controller.start('Rahul');
    await settle();
    r.clock.now += 2 * MIN;
    const second = await r.controller.start('Priya');
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/A live chat with Rahul Sharma is running \(the last message was 2 minutes ago\)\. I can run one live chat at a time: say "stop live chat" and ask again/);
    expect(second.message).toMatch(/ends by itself when they stay quiet for 5 minutes/);
  });
});

describe('a chat that waits for its turn (several live chats at once)', () => {
  it('is put aside quietly (no notice, no alert), left alone for twice the quiet time, and then ended like any paused chat', async () => {
    const r = rig({ idleStopMs: FIVE });
    await r.controller.start('Rahul');
    await settle();
    await r.controller.pause('standby');
    expect(r.controller.state).toBe('PAUSED');
    expect(r.alerts).toEqual([]);
    expect(r.controller.view().notice).toBeNull();
    r.advance(9 * MIN);
    await settle();
    expect(r.controller.state).toBe('PAUSED'); // (a person-paused chat waits 20 minutes, one paused by itself 5, a chat waiting for its turn 10)
    r.advance(2 * MIN);
    await settle();
    expect(r.controller.state).toBe('STOPPED');
  });

  it('only a chat with nothing going on can be put aside: a reply waiting for the person cannot', async () => {
    const r = rig({ idleStopMs: FIVE });
    r.ai.say('Sure.');
    await r.controller.start('Rahul', 'assisted');
    await settle();
    expect(r.controller.settled()).toBe(true);
    r.chat.incoming('Can you check this?');
    r.chat.changed();
    await settle(40);
    expect(r.controller.state).toBe('WAITING_FOR_APPROVAL');
    expect(r.controller.settled()).toBe(false);
    expect(await r.controller.standby()).toBe(false);
  });

  it('how long since someone spoke: not set by connecting, set by what they write', async () => {
    const r = rig({ idleStopMs: FIVE });
    await r.controller.start('Rahul');
    await settle();
    expect(r.controller.quietMs()).toBe(Number.POSITIVE_INFINITY);
    r.chat.incoming('hello');
    r.chat.changed();
    await settle(40);
    r.advance(20_000);
    expect(r.controller.quietMs()).toBeGreaterThanOrEqual(20_000);
    expect(r.controller.quietMs()).toBeLessThan(40_000);
  });
});
