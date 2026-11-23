import { describe, expect, it } from 'vitest';
import { rig, settle } from './liveChatFixtures';
import type { Rig } from './liveChatFixtures';

/**
 * "The message had already come but it said no reply for one or three minutes": what makes the live chat notice a message promptly, and what it does when the page
 * does not announce one, when the AI fails, and when the browser connection drops and returns.
 */

async function running(options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig(options);
  r.chat.incoming('Hi Rahul here');
  r.chat.outgoing('Hello! Tell me');
  const res = await r.controller.start('Rahul');
  expect(res.view.state, res.message).toBe('ACTIVE');
  return r;
}

describe('a message the page did not announce', () => {
  it('is found by the backstop, which then checks often (and the page says so), instead of leaving it for minutes', async () => {
    const r = await running({ reconcileMs: 15_000, fastCheckMs: 5_000 });
    expect(r.controller.view().monitoring).toBe('event');
    r.ai.say('Yes, free.');
    r.chat.incoming('Are you free?'); // no event reaches Eya
    r.advance(15_000);
    await settle();
    expect(r.controller.view().draft?.text).toBe('Yes, free.');
    expect(r.controller.view().monitoring).toBe('checking');
    // from now on it looks every 5 seconds
    await r.controller.handle({ kind: 'discard' });
    r.ai.say('Sure.');
    r.chat.incoming('And tomorrow?');
    r.advance(5_000);
    await settle();
    expect(r.controller.view().draft?.text).toBe('Sure.');
  });

  it('a message the page DID announce does not switch to fast checking', async () => {
    const r = await running({ reconcileMs: 15_000 });
    r.ai.say('Yes.');
    r.chat.incoming('Are you free?');
    r.chat.changed();
    await settle();
    r.advance(15_000);
    await settle();
    expect(r.controller.view().monitoring).toBe('event');
  });

  it('a backstop look that finds nothing new changes nothing', async () => {
    const r = await running({ reconcileMs: 15_000 });
    r.advance(15_000);
    await settle();
    r.advance(15_000);
    await settle();
    expect(r.ai.calls).toBe(0);
    expect(r.controller.view().monitoring).toBe('event');
  });

  it('a message that waited because the AI failed is not mistaken for one the page missed', async () => {
    const r = await running({ reconcileMs: 15_000 });
    r.ai.raw(new Error('quota'));
    r.chat.incoming('Are you free?');
    r.chat.changed();
    await settle();
    r.ai.say('Yes.');
    r.clock.now += 20_000;
    r.advance(1); // (the backstop is not due yet; nothing to find that is new)
    expect(r.controller.view().monitoring).toBe('event');
  });

  it('the last look at the chat is shown, so the person can see it is alive', async () => {
    const r = await running();
    expect(r.controller.view().lastCheckAt).toBe(r.clock.now);
    r.clock.now += 7_000;
    r.ai.say('Hi!');
    r.chat.incoming('Hello again');
    r.chat.changed();
    await settle();
    expect(r.controller.view().lastCheckAt).toBe(r.clock.now);
  });
});

describe('the AI failing does not leave a message waiting for the person to press something', () => {
  it('it is tried again by itself, a few times, and then left for Regenerate', async () => {
    const r = await running();
    r.ai.raw(new Error('quota'));
    r.chat.incoming('Are you free?');
    r.chat.changed();
    await settle();
    expect(r.ai.calls).toBe(1);
    expect(r.controller.view().error).toMatch(/could not write a reply/);
    // the first retry, shortly after: the AI is back
    r.ai.say('Yes, free.');
    r.advance(16_000);
    await settle();
    expect(r.ai.calls).toBe(2);
    expect(r.controller.view().draft?.text).toBe('Yes, free.');
    expect(r.controller.view().error).toBeNull();
  });

  it('three retries at most', async () => {
    const r = await running();
    r.ai.fallback = () => new Error('quota');
    r.chat.incoming('Are you free?');
    r.chat.changed();
    await settle();
    for (let i = 0; i < 6; i += 1) {
      r.advance(16_000);
      await settle();
    }
    expect(r.ai.calls).toBe(4); // the first try and three retries
    expect(r.controller.view().state).toBe('ACTIVE');
    expect(r.controller.view().error).toMatch(/Regenerate/);
  });

  it('stopping cancels the retry', async () => {
    const r = await running();
    r.ai.raw(new Error('quota'));
    r.chat.incoming('Are you free?');
    r.chat.changed();
    await settle();
    await r.controller.handle({ kind: 'stop' });
    r.ai.say('Yes.');
    r.advance(16_000);
    await settle();
    expect(r.ai.calls).toBe(1);
  });
});

describe('the connection to the browser dropping and coming back', () => {
  it('a live chat that only lost its connection carries on by itself, and answers what arrived meanwhile once', async () => {
    const r = await running();
    r.chat.lost('browser_lost');
    await settle();
    expect(r.controller.view()).toMatchObject({ state: 'PAUSED', pause: 'browser_lost' });
    r.ai.say('Sorry, back now.');
    r.chat.incoming('Are you there?');
    const starts = r.chat.starts;
    r.chat.back();
    await settle();
    expect(r.controller.view().state).toBe('WAITING_FOR_APPROVAL');
    expect(r.chat.starts).toBe(starts + 1);
    expect(r.ai.calls).toBe(1);
    expect(r.controller.view().draft?.text).toBe('Sorry, back now.');
  });

  it('it does not carry on when the chat on the page is no longer the chosen one', async () => {
    const r = await running();
    r.chat.lost('browser_lost');
    await settle();
    r.chat.open = 'Someone Else';
    r.chat.openOutcome = { kind: 'none', say: 'No such chat.' };
    r.chat.back();
    await settle();
    expect(r.controller.view().state).toBe('FAILED');
    expect(r.chat.watching).toBe(false);
  });

  it('only a lost connection is made good: a closed chat, Chats switched off, or the person pausing stay paused', async () => {
    for (const why of ['chat_closed', 'access_off'] as const) {
      const r = await running();
      await r.controller.pause(why, 'x');
      r.chat.back();
      await settle();
      expect(r.controller.view().state, why).toBe('PAUSED');
    }
    const user = await running();
    await user.controller.handle({ kind: 'pause' });
    user.chat.back();
    await settle();
    expect(user.controller.view().state).toBe('PAUSED');
  });

  it('with Chats switched off in the meantime it stays paused', async () => {
    let on = true;
    const r = await running({ allowed: () => (on ? null : 'Chats are off.') });
    r.chat.lost('browser_lost');
    await settle();
    on = false;
    r.chat.back();
    await settle();
    expect(r.controller.view().state).toBe('PAUSED');
  });

  it('stopping while paused for a lost connection means a returning browser does nothing', async () => {
    const r = await running();
    r.chat.lost('browser_lost');
    await settle();
    await r.controller.handle({ kind: 'stop' });
    const starts = r.chat.starts;
    r.chat.back();
    await settle();
    expect(r.controller.view().state).toBe('STOPPED');
    expect(r.chat.starts).toBe(starts);
  });
});
