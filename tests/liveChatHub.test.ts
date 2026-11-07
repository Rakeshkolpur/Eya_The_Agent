import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
import type { LiveChatMessage } from '../src/main/browser/BrowserAutomationService';
import { LiveChatController } from '../src/main/livechat/LiveChatController';
import { LiveChatHub, MAX_LIVE_CHATS } from '../src/main/livechat/LiveChatHub';
import { LiveChatStore } from '../src/main/livechat/LiveChatStore';
import { FakeAI, FakeChat, MemoryIo, settle } from './liveChatFixtures';

/**
 * Several live chats at once, over a MOCK WhatsApp that has several chats and shows one at a time. What it proves: they take turns, each reply goes to ITS chat, a chat that is busy is
 * never interrupted, the person's words are about the one shown, and "stop all" ends all. Mock only: how the real page switches chats is not covered.
 */

const MIN = 60_000;

function world(options: { multi?: boolean; idleStopMs?: number } = {}) {
  const chat = new FakeChat();
  const ai = new FakeAI();
  const io = new MemoryIo();
  const clock = { now: 1_800_000_000_000 };
  const timers: Array<{ fn: () => void; at: number; id: number; cleared: boolean }> = [];
  const threads = new Map<string, LiveChatMessage[]>();
  const alerts: string[] = [];
  const opened: string[] = [];
  let ids = 0;
  let multi = options.multi ?? true;
  let failOpen: string | null = null;
  chat.open = null;

  const show = (label: string): void => {
    if (chat.open !== null) threads.set(chat.open, chat.messages);
    chat.messages = threads.get(label) ?? [];
    chat.open = label;
    chat.title = label;
  };
  // (the page shows the chat that was asked for, by its name)
  chat.actions.open = async (query) => {
    opened.push(query);
    if (failOpen !== null && query === failOpen) return { kind: 'none', say: 'No chat has that name.' };
    const label = query.length > 0 ? query : 'Rahul Sharma';
    show(label);
    return { kind: 'opened', label, verified: true };
  };
  const incomingTo = (label: string, text: string): LiveChatMessage => {
    const was = chat.open;
    if (was === label) return chat.incoming(text);
    const saved = chat.messages;
    chat.messages = threads.get(label) ?? [];
    const m = chat.incoming(text);
    threads.set(label, chat.messages);
    chat.messages = saved;
    return m;
  };

  const timerApi = {
    set: (fn: () => void, ms: number) => {
      const t = { fn, at: clock.now + ms, id: timers.length + 1, cleared: false };
      timers.push(t);
      return t.id;
    },
    clear: (id: unknown) => {
      const t = timers.find((x) => x.id === id);
      if (t !== undefined) t.cleared = true;
    },
  };
  const make = (slot: number): LiveChatController =>
    new LiveChatController({
      store: new LiveChatStore(`live-chat-${slot}.json`, io, () => clock.now),
      ai,
      watcher: chat.watcher,
      chat: chat.actions,
      permits: () => null,
      allowed: () => null,
      now: () => clock.now,
      newId: () => `id${++ids}`,
      alert: (m) => alerts.push(m),
      say: () => undefined,
      idleStopMs: options.idleStopMs ?? 0,
      reconcileMs: 0,
      comeBackMs: 0,
      timers: timerApi,
    });
  const hub = new LiveChatHub({ make, multi: () => multi, now: () => clock.now, timers: timerApi, tickMs: 8_000, dwellMs: 25_000, hotDwellMs: 75_000 });
  return {
    chat,
    ai,
    io,
    hub,
    alerts,
    opened,
    clock,
    threads,
    incomingTo,
    setMulti: (v: boolean) => (multi = v),
    failOpenFor: (label: string | null) => (failOpen = label),
    make,
    /** Moves the clock; the hub's turn is looked at as its timer would. */
    async pass(ms: number): Promise<void> {
      clock.now += ms;
      await hub.rotate();
      await settle(20);
    },
    summary: () => hub.view().chats?.map((c) => `${c.chat}:${c.front ? 'front' : c.pause ?? c.state}`) ?? [],
  };
}

describe('two live chats at once', () => {
  it('the second start puts the first on standby (quietly) and shows both', async () => {
    const w = world();
    await w.hub.handle({ kind: 'start', name: 'Rahul Sharma' });
    await settle();
    const second = await w.hub.handle({ kind: 'start', name: 'Priya Singh' });
    await settle();
    expect(second.ok, second.message).toBe(true);
    expect(second.message).toMatch(/1 other live chat is waiting for its turn/);
    expect(w.summary()).toEqual(['Rahul Sharma:standby', 'Priya Singh:front']);
    expect(w.hub.view().chat).toBe('Priya Singh');
    expect(w.alerts).toEqual([]); // (waiting for a turn is not something to tell the person)
  });

  it('the turn passes when the chat in front has nothing going on, and the other chat is opened again by its name and read', async () => {
    const w = world();
    await w.hub.handle({ kind: 'start', name: 'Rahul Sharma' });
    await settle();
    await w.hub.handle({ kind: 'start', name: 'Priya Singh' });
    await settle();
    w.incomingTo('Rahul Sharma', 'Are you free to talk?'); // (written while it waited)
    w.opened.length = 0;
    w.ai.say('Yes, call me.');
    await w.pass(10_000); // (too soon: the one in front keeps the turn)
    expect(w.summary()).toEqual(['Rahul Sharma:standby', 'Priya Singh:front']);
    expect(w.opened).toEqual([]);
    await w.pass(30_000);
    expect(w.summary()).toEqual(['Rahul Sharma:front', 'Priya Singh:standby']);
    expect(w.opened).toEqual(['Rahul Sharma']);
    // the reply written for Rahul's message is for Rahul's chat
    expect(w.hub.view().chat).toBe('Rahul Sharma');
    expect(w.hub.view().draft?.text).toBe('Yes, call me.');
    expect(w.chat.open).toBe('Rahul Sharma');
  });

  it('and back again: the cycle goes round', async () => {
    const w = world();
    await w.hub.handle({ kind: 'start', name: 'Rahul Sharma' });
    await settle();
    await w.hub.handle({ kind: 'start', name: 'Priya Singh' });
    await settle();
    await w.pass(30_000);
    expect(w.hub.view().chat).toBe('Rahul Sharma');
    await w.pass(30_000);
    expect(w.hub.view().chat).toBe('Priya Singh');
    await w.pass(30_000);
    expect(w.hub.view().chat).toBe('Rahul Sharma');
  });

  it('a chat that is busy is never interrupted: a reply waiting for the person keeps the turn', async () => {
    const w = world();
    await w.hub.handle({ kind: 'start', name: 'Rahul Sharma', mode: 'assisted' });
    await settle();
    w.ai.say('Sure.');
    w.chat.incoming('Can you come tomorrow?');
    w.chat.changed();
    await settle(40);
    expect(w.hub.view().state).toBe('WAITING_FOR_APPROVAL');
    await w.hub.handle({ kind: 'start', name: 'Priya Singh' });
    await settle();
    // (Priya is in front now, Rahul was put on standby with its reply kept)
    expect(w.summary()).toEqual(['Rahul Sharma:standby', 'Priya Singh:front']);
  });

  it('while a reply waits for the person in the chat in front, the turn does not pass', async () => {
    const w = world();
    await w.hub.handle({ kind: 'start', name: 'Rahul Sharma' });
    await settle();
    await w.hub.handle({ kind: 'start', name: 'Priya Singh', mode: 'assisted' });
    await settle();
    w.ai.say('Hello!');
    w.chat.incoming('Hi there');
    w.chat.changed();
    await settle(40);
    expect(w.hub.view().state).toBe('WAITING_FOR_APPROVAL');
    await w.pass(120_000);
    expect(w.hub.view().chat).toBe('Priya Singh'); // (still: its reply is waiting for the person)
  });

  it('a conversation that is going on keeps the turn a little longer than a quiet one', async () => {
    const w = world();
    await w.hub.handle({ kind: 'start', name: 'Rahul Sharma' });
    await settle();
    await w.hub.handle({ kind: 'start', name: 'Priya Singh', mode: 'assisted' });
    await settle();
    w.ai.say('Hi!');
    w.chat.incoming('hello');
    w.chat.changed();
    await settle(40);
    await w.hub.handle({ kind: 'approve' });
    await w.hub.handle({ kind: 'send' });
    await settle(40); // (the reply went: it is their turn to write, and something just happened in the chat)
    await w.pass(30_000);
    expect(w.hub.view().chat).toBe('Priya Singh'); // (30 s is not enough for a chat that was just talking)
    await w.pass(60_000);
    expect(w.hub.view().chat).toBe('Rahul Sharma');
  });
});

describe('the person\'s words', () => {
  async function two() {
    const w = world();
    await w.hub.handle({ kind: 'start', name: 'Rahul Sharma' });
    await settle();
    await w.hub.handle({ kind: 'start', name: 'Priya Singh' });
    await settle();
    return w;
  }

  it('"stop live chat" is about the one shown; the other one has the turn at once, and is told so', async () => {
    const w = await two();
    const out = await w.hub.handle({ kind: 'stop' });
    expect(out.message).toMatch(/^Stopped the live chat with Priya Singh\. 1 other live chat is still running; say "stop all live chats"/);
    await settle();
    expect(w.hub.view().chat).toBe('Rahul Sharma');
    expect(w.hub.view().state).toBe('ACTIVE');
    expect(w.chat.open).toBe('Rahul Sharma');
  });

  it('"stop all live chats" ends every one', async () => {
    const w = await two();
    const out = await w.hub.handle({ kind: 'stop', all: true });
    expect(out.message).toMatch(/^Stopped all 2 live chats/);
    expect(w.hub.view().active).toBe(false);
    expect(w.hub.view().chats).toBeUndefined();
  });

  it('a chat can be stopped by its id from the list, whichever is in front', async () => {
    const w = await two();
    const rahul = w.hub.view().chats?.find((c) => c.chat === 'Rahul Sharma');
    const out = await w.hub.handle({ kind: 'stop', chat: rahul?.id ?? 'none' });
    expect(out.message).toMatch(/^Stopped the live chat with Rahul Sharma/);
    expect(w.hub.view().chat).toBe('Priya Singh');
    expect(w.hub.view().chats).toBeUndefined(); // (one left: just that one)
  });

  it('"show this one" brings another to the front: the one that was shown waits', async () => {
    const w = await two();
    const rahul = w.hub.view().chats?.find((c) => c.chat === 'Rahul Sharma');
    const out = await w.hub.handle({ kind: 'focus', chat: rahul?.id ?? 'none' });
    expect(out.ok, out.message).toBe(true);
    await settle();
    expect(w.summary()).toEqual(['Rahul Sharma:front', 'Priya Singh:standby']);
  });

  it('everything else (approve, pause, relay …) is about the one shown', async () => {
    const w = await two();
    const out = await w.hub.handle({ kind: 'pause' });
    expect(out.ok).toBe(true);
    expect(w.hub.view().pause).toBe('user');
    expect(w.summary()).toEqual(['Rahul Sharma:standby', 'Priya Singh:front']);
    // (a chat the person paused is not woken by the turns, and the one waiting does not take the turn from it)
    await w.pass(60_000);
    expect(w.hub.view().chat).toBe('Priya Singh');
    expect(w.hub.view().pause).toBe('user');
  });
});

describe('the limits', () => {
  it('the same chat twice is not started twice', async () => {
    const w = world();
    await w.hub.handle({ kind: 'start', name: 'Rahul Sharma' });
    await settle();
    const again = await w.hub.handle({ kind: 'start', name: 'Rahul Sharma' });
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/already running/);
    expect(w.hub.view().chats).toBeUndefined();
    expect(w.hub.view().state).toBe('ACTIVE');
  });

  it(`no more than ${MAX_LIVE_CHATS} at once`, async () => {
    const w = world();
    for (let i = 1; i <= MAX_LIVE_CHATS; i += 1) {
      const out = await w.hub.handle({ kind: 'start', name: `Friend ${i}` });
      expect(out.ok, out.message).toBe(true);
      await settle();
    }
    const sixth = await w.hub.handle({ kind: 'start', name: 'Friend 6' });
    expect(sixth.ok).toBe(false);
    expect(sixth.message).toMatch(/5 live chats are already running, which is the most at once/);
  });

  it('with the setting off it is one at a time, as before', async () => {
    const w = world({ multi: false });
    await w.hub.handle({ kind: 'start', name: 'Rahul Sharma' });
    await settle();
    const second = await w.hub.handle({ kind: 'start', name: 'Priya Singh' });
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/is running.*one live chat at a time/);
    expect(w.hub.view().chats).toBeUndefined();
  });

  it('a chat that cannot be opened does not take the other one\'s place: the first goes on', async () => {
    const w = world();
    await w.hub.handle({ kind: 'start', name: 'Rahul Sharma' });
    await settle();
    w.failOpenFor('Nobody Known');
    const out = await w.hub.handle({ kind: 'start', name: 'Nobody Known' });
    await settle();
    expect(out.ok).toBe(false);
    expect(w.hub.view().chat).toBe('Rahul Sharma');
    expect(w.hub.view().state).toBe('ACTIVE');
    expect(w.chat.open).toBe('Rahul Sharma');
  });

  it('a chat that cannot take its turn (it is not found any more) hands the turn back', async () => {
    const w = world();
    await w.hub.handle({ kind: 'start', name: 'Rahul Sharma' });
    await settle();
    await w.hub.handle({ kind: 'start', name: 'Priya Singh' });
    await settle();
    w.failOpenFor('Rahul Sharma');
    await w.pass(40_000);
    expect(w.hub.view().chat).toBe('Priya Singh');
    expect(w.chat.open).toBe('Priya Singh');
  });
});

describe('across a restart, and with time', () => {
  it('every live chat comes back paused (none is running), the first as the one shown', async () => {
    const w = world();
    await w.hub.handle({ kind: 'start', name: 'Rahul Sharma' });
    await settle();
    await w.hub.handle({ kind: 'start', name: 'Priya Singh' });
    await settle();
    const next = new LiveChatHub({ make: w.make, multi: () => true, now: () => w.clock.now, tickMs: 8_000 });
    expect(next.restore()).toBe(true);
    next.dispose();
    const chats = next.view().chats ?? [];
    expect(chats.map((c) => c.pause)).toEqual(['restart', 'restart']);
  });
});
