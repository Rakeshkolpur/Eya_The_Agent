import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatSession } from '../src/main/chat/chatSession';
import { ContactBook } from '../src/main/chat/ContactBook';
import { ChatCommands } from '../src/main/local/ChatCommands';
import { MIGRATIONS } from '../src/main/memory/schema';
import { migrate, openDatabase } from '../src/main/memory/sqlite';
import type { Sql } from '../src/main/memory/sqlite';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';
import type { LiveChatMode } from '../src/shared/liveChat';
import { FakeSwitch, rig, settle } from './liveChatFixtures';
import type { Rig, RigOptions } from './liveChatFixtures';

/**
 * TOGETHER: the person sits with Eya in a live chat, like two friends over one phone. Eya tells them what comes in as it comes; they say "send this: …", "type this: …", "no, send this: …",
 * "wait", "go ahead" — or type in the chat themselves. Over a MOCK chat and a MOCK model (how the real page and a real voice behave is not shown here).
 */

const INTRO = "Hi! 😊 How are you doing today?";

/** A live chat that is running together: automatic (Eya has said hello) or assisted (replies wait for the person). */
async function running(mode: LiveChatMode, options: RigOptions = {}, chatLabel = 'Rahul Sharma'): Promise<Rig> {
  const sw = new FakeSwitch();
  sw.on = mode === 'auto'; // (the one switch is the standing yes for automatic replies)
  const r = rig({ ...options, enable: sw.control });
  r.chat.openOutcome = { kind: 'opened', label: chatLabel, verified: true };
  r.chat.open = chatLabel;
  r.chat.title = chatLabel;
  if (mode === 'auto') r.ai.say(INTRO);
  const started = await r.controller.handle({ kind: 'start', name: chatLabel, mode: mode === 'draft' ? 'draft' : 'assisted', together: true });
  expect(started.ok, started.message).toBe(true);
  await settle(40);
  if (mode === 'auto') {
    r.advance(7_000);
    await settle(40);
  }
  return r;
}

const together = (r: Rig) => r.said.filter((s) => s.kind === 'together');

describe('starting and switching it', () => {
  it('a live chat started together says so, and tells the person what they can say', async () => {
    const r = await running('assisted');
    const v = r.controller.view();
    expect(v.together).toBe(true);
    expect(v.held).toBe(false);
    expect(v.notice ?? '').toBe('');
  });

  it('the start message says it is on and how to use it', async () => {
    const sw = new FakeSwitch();
    const r = rig({ enable: sw.control });
    const done = await r.controller.handle({ kind: 'start', name: 'Rahul Sharma', mode: 'assisted', together: true });
    expect(done.message).toMatch(/Together mode is on/);
    expect(done.message).toMatch(/send this/);
    expect(done.message).toMatch(/microphone stays on/);
  });

  it('it can be switched on and off while the chat runs, and is off when it was not asked for', async () => {
    const sw = new FakeSwitch();
    const r = rig({ enable: sw.control });
    await r.controller.handle({ kind: 'start', name: 'Rahul Sharma', mode: 'assisted' });
    await settle(30);
    expect(r.controller.view().together).toBe(false);
    expect((await r.controller.handle({ kind: 'set_together', on: true })).ok).toBe(true);
    expect(r.controller.view().together).toBe(true);
    expect((await r.controller.handle({ kind: 'set_together', on: true })).message).toMatch(/already on/);
    expect((await r.controller.handle({ kind: 'set_together', on: false })).ok).toBe(true);
    expect(r.controller.view().together).toBe(false);
  });

  it('with no live chat running there is nothing to do together', async () => {
    const r = rig();
    const done = await r.controller.handle({ kind: 'set_together', on: true });
    expect(done.ok).toBe(false);
    expect(done.message).toMatch(/no live chat running/);
  });

  it('it is for one run: a restart brings the chat back paused, with it off (the microphone is not switched on by itself)', async () => {
    const r = await running('assisted');
    expect(r.controller.view().together).toBe(true);
    const again = r.restarted();
    expect(again.view().together).toBe(false);
    expect(again.view().state).toBe('PAUSED');
  });

  it('a chat that could not start is not "together" either (the microphone is let go)', async () => {
    const sw = new FakeSwitch();
    const r = rig({ enable: sw.control });
    r.chat.watcherFails = { message: 'The extension is old.', pause: null };
    const done = await r.controller.handle({ kind: 'start', name: 'Rahul Sharma', mode: 'assisted', together: true });
    expect(done.ok).toBe(false);
    expect(r.controller.view().state).toBe('FAILED');
    expect(r.controller.view().together ?? false).toBe(false);
  });

  it('a chat that ends takes it with it', async () => {
    const r = await running('assisted');
    await r.controller.handle({ kind: 'stop' });
    expect(r.controller.view().together ?? false).toBe(false);
  });
});

describe('Eya tells the person what comes in, as it comes', () => {
  it('each message is said once: who it is from and what they wrote — even when it is looked at again', async () => {
    const r = await running('assisted');
    r.ai.raw(new Error('the AI is out for a moment'));
    r.chat.incoming('Are you free tonight?');
    r.chat.changed();
    await settle(40);
    expect(together(r).map((s) => s.spoken)).toEqual(['Rahul Sharma says: Are you free tonight?']);
    // (the reply could not be written; the message is looked at again when the next one arrives — it is not said again, and the new one is said)
    r.chat.incoming('hello?');
    r.chat.changed();
    await settle(40);
    expect(together(r).map((s) => s.spoken)).toEqual(['Rahul Sharma says: Are you free tonight?', 'Rahul Sharma says: hello?']);
    r.ai.say('Yes, free after 7.');
    await r.controller.handle({ kind: 'regenerate' });
    await settle(40);
    expect(together(r).filter((s) => /Are you free tonight/.test(s.spoken))).toHaveLength(1);
  });

  it('what Eya would reply is said too, with how to answer it', async () => {
    const r = await running('assisted');
    r.ai.say('Yes, free after 7.');
    r.chat.incoming('Are you free tonight?');
    r.chat.changed();
    await settle(40);
    const lines = together(r).map((s) => s.spoken);
    expect(lines[0]).toBe('Rahul Sharma says: Are you free tonight?');
    expect(lines[1]).toBe("I'd reply: Yes, free after 7. Say send it, or tell me what to send instead.");
  });

  it('a number is said by its last digits only, and shown masked', async () => {
    const r = await running('assisted', {}, '+91 98765 08501');
    r.ai.say('Hello!');
    r.chat.incoming('hi');
    r.chat.changed();
    await settle(40);
    const first = together(r)[0];
    expect(first?.spoken).toMatch(/^the number ending 8 5 0 1 says: hi$/);
    expect(first?.shown).not.toMatch(/98765/);
  });

  it('a picture or a voice note is said as what it is', async () => {
    const r = await running('assisted');
    r.ai.say('Nice one!');
    r.chat.incoming('', 'image');
    r.chat.changed();
    await settle(40);
    expect(together(r)[0]?.spoken).toBe('Rahul Sharma sent a picture.');
  });

  it('nothing is said when it is not together (the live chat is as it was)', async () => {
    const sw = new FakeSwitch();
    const r = rig({ enable: sw.control });
    await r.controller.handle({ kind: 'start', name: 'Rahul Sharma', mode: 'assisted' });
    await settle(30);
    r.ai.say('Yes!');
    r.chat.incoming('Are you free?');
    r.chat.changed();
    await settle(40);
    expect(together(r)).toEqual([]);
  });

  it('when the reply needs the person, that is said aloud too', async () => {
    const r = await running('assisted');
    r.ai.raw(JSON.stringify({ reply: null, needs_user: 'she asks for your bank details', no_reply_needed: null, confidence: 'high', commitment: false, summary: 'money' }));
    r.chat.incoming('send me your bank details');
    r.chat.changed();
    await settle(40);
    expect(together(r).some((s) => /I need you for this one: she asks for your bank details/.test(s.spoken))).toBe(true);
  });
});

describe('"send this: …" — the person\'s own words, word for word', () => {
  it('goes out as THEIR message (no "Rakesh says"), after a short moment in which "wait" can still stop it', async () => {
    const r = await running('assisted');
    const done = await r.controller.handle({ kind: 'dictate', text: 'I will come at 5', send: true });
    expect(done.ok, done.message).toBe(true);
    expect(done.message).toMatch(/Sending "I will come at 5" in a moment/);
    expect(r.chat.pressed).toEqual([]); // (not yet: the moment is still running)
    r.advance(2_000);
    await settle(20);
    expect(r.chat.pressed).toEqual([]);
    r.advance(1_500);
    await settle(40);
    expect(r.chat.pressed).toEqual(['I will come at 5']);
    expect(r.chat.messages.some((m) => m.dir === 'out' && m.text === 'I will come at 5')).toBe(true);
    expect(r.controller.view().draft?.status).toBe('sent');
    expect(r.controller.state).toBe('ACTIVE');
  });

  it('with no moment asked for it goes at once, and says what happened', async () => {
    const r = await running('assisted', { dictateUndoMs: 0 });
    const done = await r.controller.handle({ kind: 'dictate', text: 'on my way', send: true });
    expect(done.ok, done.message).toBe(true);
    expect(done.message).toMatch(/^Sent\./);
    expect(r.chat.pressed).toEqual(['on my way']);
  });

  it('"no, send this: …" within the moment replaces it: only the second goes', async () => {
    const r = await running('assisted');
    await r.controller.handle({ kind: 'dictate', text: 'I will come at 5', send: true });
    r.advance(1_000);
    await r.controller.handle({ kind: 'dictate', text: 'I will come at 6', send: true });
    r.advance(5_000);
    await settle(40);
    expect(r.chat.pressed).toEqual(['I will come at 6']);
  });

  it('"wait" stops it: nothing is sent, and the person is told so', async () => {
    const r = await running('assisted');
    await r.controller.handle({ kind: 'dictate', text: 'I will come at 5', send: true });
    r.advance(1_000);
    const held = await r.controller.handle({ kind: 'hold' });
    expect(held.ok, held.message).toBe(true);
    expect(held.message).toMatch(/was not sent/);
    r.advance(10_000);
    await settle(40);
    expect(r.chat.pressed).toEqual([]);
    expect(r.controller.view().draft).toBeNull();
    expect(r.controller.state).toBe('ACTIVE');
  });

  it('a draft it cannot send does not go: the chat is not the open one', async () => {
    const r = await running('assisted');
    await r.controller.handle({ kind: 'dictate', text: 'I will come at 5', send: true });
    r.chat.open = 'Somebody Else';
    r.advance(4_000);
    await settle(40);
    expect(r.chat.pressed).toEqual([]);
    // (and the person is told aloud: nobody is waiting for the answer of a timer)
    expect(together(r).some((s) => /I could not send that/.test(s.spoken))).toBe(true);
  });

  it('while it waits its moment, what the other person writes is not answered over it: it is looked at right after it has gone', async () => {
    const r = await running('assisted');
    await r.controller.handle({ kind: 'dictate', text: 'I will come at 5', send: true });
    const before = r.ai.calls;
    r.chat.incoming('ok great, where?');
    r.chat.changed();
    await settle(40);
    expect(r.ai.calls).toBe(before); // (no reply was written meanwhile)
    expect(r.controller.view().draft?.text).toBe('I will come at 5'); // (still the person's)
    r.ai.say('Near the station.');
    r.advance(4_000);
    await settle(60);
    expect(r.chat.pressed[0]).toBe('I will come at 5');
    expect(r.ai.calls).toBe(before + 1); // (now the new message was looked at)
    expect(r.controller.view().draft?.text).toBe('Near the station.');
  });

  it('every other check still holds: stopped, paused or in the wrong chat, nothing goes', async () => {
    const r = await running('assisted');
    await r.controller.handle({ kind: 'dictate', text: 'I will come at 5', send: true });
    await r.controller.handle({ kind: 'stop' });
    r.advance(10_000);
    await settle(40);
    expect(r.chat.pressed).toEqual([]);
    const r2 = await running('assisted');
    await r2.controller.handle({ kind: 'pause' });
    const done = await r2.controller.handle({ kind: 'dictate', text: 'hello', send: true });
    expect(done.ok).toBe(false);
    expect(done.message).toMatch(/paused/);
  });

  it('too long or empty is refused; nothing is sent', async () => {
    const r = await running('assisted');
    expect((await r.controller.handle({ kind: 'dictate', text: '   ', send: true })).ok).toBe(false);
    expect((await r.controller.handle({ kind: 'dictate', text: 'x'.repeat(601), send: true })).ok).toBe(false);
    r.advance(10_000);
    await settle(20);
    expect(r.chat.pressed).toEqual([]);
  });

  it('a reply of Eya that was waiting is replaced by the person\'s own words', async () => {
    const r = await running('assisted');
    r.ai.say('Yes, free after 7.');
    r.chat.incoming('Are you free tonight?');
    r.chat.changed();
    await settle(40);
    expect(r.controller.view().draft?.by).toBe('eya');
    await r.controller.handle({ kind: 'dictate', text: 'Not tonight, sorry', send: true });
    r.advance(4_000);
    await settle(40);
    expect(r.chat.pressed).toEqual(['Not tonight, sorry']);
  });
});

describe('"type this: …" — made ready, sent when the person says so', () => {
  it('is not sent by itself; "send it" sends it word for word', async () => {
    const r = await running('assisted');
    const done = await r.controller.handle({ kind: 'dictate', text: 'see you at 7', send: false });
    expect(done.ok, done.message).toBe(true);
    expect(done.message).toMatch(/Ready, not sent yet/);
    r.advance(60_000);
    await settle(30);
    expect(r.chat.pressed).toEqual([]);
    expect(r.controller.view().draft?.status).toBe('edited');
    const sent = await r.controller.handle({ kind: 'send' });
    expect(sent.ok, sent.message).toBe(true);
    expect(r.chat.pressed).toEqual(['see you at 7']);
  });

  it('can be changed before it goes ("change it to …"), and dropped ("don\'t send it")', async () => {
    const r = await running('assisted');
    await r.controller.handle({ kind: 'dictate', text: 'see you at 7', send: false });
    await r.controller.handle({ kind: 'edit_draft', text: 'see you at 8' });
    expect(r.controller.view().draft?.text).toBe('see you at 8');
    const dropped = await r.controller.handle({ kind: 'discard' });
    expect(dropped.ok).toBe(true);
    expect(r.chat.pressed).toEqual([]);
  });

  it('Draft mode never sends: the words are put in WhatsApp\'s own message box', async () => {
    const r = await running('draft');
    const done = await r.controller.handle({ kind: 'dictate', text: 'I will come at 5', send: true });
    expect(done.ok, done.message).toBe(true);
    expect(done.message).toMatch(/message box: press Send there/);
    expect(r.chat.box).toBe('I will come at 5');
    r.advance(60_000);
    await settle(30);
    expect(r.chat.pressed).toEqual([]);
    expect(r.controller.view().draft?.status).toBe('in_box');
  });
});

describe('"wait" and "go ahead": Eya answers by herself, but the person can hold her back', () => {
  it('her own reply waits a few seconds first, so there is time to say wait — then it goes', async () => {
    const r = await running('auto');
    r.advance(20_000); // (the ten seconds Eya always leaves between two replies are over: it is the few seconds of together that are looked at)
    r.ai.say('I am good, you?');
    r.chat.incoming('how are you');
    r.chat.changed();
    await settle(40);
    expect(together(r).some((s) => /^I'm replying: I am good, you\?/.test(s.spoken))).toBe(true);
    expect(r.chat.pressed).toEqual([INTRO]);
    r.advance(5_000);
    await settle(30);
    expect(r.chat.pressed).toEqual([INTRO]);
    r.advance(2_000);
    await settle(40);
    expect(r.chat.pressed).toEqual([INTRO, 'I am good, you?']);
  });

  it('"wait" holds it, even past the few seconds; "go ahead" lets it go', async () => {
    const r = await running('auto');
    r.advance(20_000);
    r.ai.say('I am good, you?');
    r.chat.incoming('how are you');
    r.chat.changed();
    await settle(40);
    r.advance(2_000);
    const held = await r.controller.handle({ kind: 'hold' });
    expect(held.ok, held.message).toBe(true);
    expect(r.controller.view().held).toBe(true);
    r.advance(30_000);
    await settle(30);
    expect(r.chat.pressed).toEqual([INTRO]);
    const go = await r.controller.handle({ kind: 'release' });
    expect(go.ok).toBe(true);
    await settle(40);
    expect(r.controller.view().held).toBe(false);
    expect(r.chat.pressed).toEqual([INTRO, 'I am good, you?']);
  });

  it('the hold runs out by itself (a minute by default), and a number of seconds can be asked for', async () => {
    const r = await running('auto');
    r.advance(20_000);
    r.ai.say('I am good, you?');
    r.chat.incoming('how are you');
    r.chat.changed();
    await settle(40);
    await r.controller.handle({ kind: 'hold', seconds: 20 });
    r.advance(15_000);
    await settle(30);
    expect(r.chat.pressed).toEqual([INTRO]);
    expect(r.controller.view().held).toBe(true);
    r.advance(6_000);
    await settle(40);
    expect(r.controller.view().held).toBe(false);
    expect(r.chat.pressed).toEqual([INTRO, 'I am good, you?']);
  });

  it('the person answering with their own words goes ahead of her reply: only theirs is sent', async () => {
    const r = await running('auto');
    r.advance(20_000);
    r.ai.say('I am good, you?');
    r.chat.incoming('how are you');
    r.chat.changed();
    await settle(40);
    r.advance(1_000);
    await r.controller.handle({ kind: 'dictate', text: 'I am fine, how are you da', send: true });
    r.advance(8_000);
    await settle(40);
    expect(r.chat.pressed).toEqual([INTRO, 'I am fine, how are you da']);
    // (and automatic replies are still on for the next message)
    expect(r.controller.view().mode).toBe('auto');
  });

  it('what is not asked for is as before: without together there is no waiting', async () => {
    const sw = new FakeSwitch();
    sw.on = true;
    const r = rig({ enable: sw.control });
    r.chat.openOutcome = { kind: 'opened', label: 'Rahul Sharma', verified: true };
    r.ai.say(INTRO);
    await r.controller.handle({ kind: 'start', name: 'Rahul Sharma' });
    await settle(40);
    r.ai.say('I am good, you?');
    r.chat.incoming('how are you');
    r.chat.changed();
    await settle(40);
    r.advance(12_000); // (the gap between two automatic replies, as ever)
    await settle(40);
    expect(r.chat.pressed).toEqual([INTRO, 'I am good, you?']);
  });
});

describe('who wrote what: the person\'s dictated words are theirs, not Eya\'s', () => {
  it('the model is told the line was Rakesh\'s own, so Eya does not take it for hers', async () => {
    const r = await running('auto');
    await r.controller.handle({ kind: 'dictate', text: 'I will come at 5', send: true });
    r.advance(4_000);
    await settle(40);
    expect(r.chat.pressed.at(-1)).toBe('I will come at 5');
    r.ai.say('Great, see you!');
    r.chat.incoming('ok great');
    r.chat.changed();
    await settle(40);
    r.advance(8_000);
    await settle(40);
    const asked = r.ai.requests.at(-1) ?? '';
    expect(asked).toMatch(/Rakesh: I will come at 5/);
    expect(asked).not.toMatch(/Eya: I will come at 5/);
    // (what Eya herself said is hers)
    expect(asked).toMatch(/Eya: Hi! 😊 How are you doing today\?/);
  });
});

/** The same, said to Eya (typed, or spoken through quick_command). */
describe('through ChatCommands', () => {
  let dir: string;
  let db: Sql;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eya-together-'));
    db = openDatabase(join(dir, 'memory.db'));
    migrate(db, MIGRATIONS);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function commands(r: Rig) {
    const cc = new ChatCommands({
      tools: { invoke: async (_n: string, _a: ToolArgs): Promise<ToolResult> => ({ ok: false, summary: 'unused', error: 'unused' }) },
      contacts: new ContactBook(db),
      policy: new CommunicationPolicy(() => ({ enabled: true, apps: {} })),
      session: new ChatSession(),
      confirmSends: 'unless_verified',
      fileRoute: 'chat',
      liveChat: r.controller,
      sleep: async () => undefined,
      now: () => r.clock.now,
    });
    return { say: (text: string) => cc.tryHandle(text) };
  }

  it('"send this: …" is sent as theirs; "wait" and "go ahead" hold and release; the answer says what happened', async () => {
    const r = await running('assisted');
    const { say } = commands(r);
    const out = await say('send this: I will come at 5');
    expect(out, 'handled here').not.toBeNull();
    expect(out?.ok, out?.spoken).toBe(true);
    expect(out?.spoken).toMatch(/Sending "I will come at 5" in a moment/);
    r.advance(4_000);
    await settle(40);
    expect(r.chat.pressed).toEqual(['I will come at 5']);
    const waited = await say('wait');
    expect(waited?.spoken).toMatch(/holding|waiting for you/);
    expect(r.controller.view().held).toBe(true);
    const go = await say('go ahead');
    expect(go?.spoken).toMatch(/answer now/);
    expect(r.controller.view().held).toBe(false);
  });

  it('"no, send this: …" right after replaces it', async () => {
    const r = await running('assisted');
    const { say } = commands(r);
    await say('send this message: I will come at 5');
    r.advance(1_000);
    await say('no, send this: I will come at 6');
    r.advance(5_000);
    await settle(40);
    expect(r.chat.pressed).toEqual(['I will come at 6']);
  });

  it('"type this …" is only made ready; "send it" sends it', async () => {
    const r = await running('assisted');
    const { say } = commands(r);
    const typed = await say('type this: see you at 7');
    expect(typed?.spoken).toMatch(/Ready, not sent yet/);
    expect(r.chat.pressed).toEqual([]);
    const sent = await say('send it');
    expect(sent?.ok, sent?.spoken).toBe(true);
    expect(r.chat.pressed).toEqual(['see you at 7']);
  });

  it('"send it" sends the reply Eya wrote, "don\'t send it" drops it', async () => {
    const r = await running('assisted');
    const { say } = commands(r);
    r.ai.say('Yes, free after 7.');
    r.chat.incoming('Are you free tonight?');
    r.chat.changed();
    await settle(40);
    const sent = await say('send it');
    expect(sent?.ok, sent?.spoken).toBe(true);
    expect(r.chat.pressed).toEqual(['Yes, free after 7.']);
    r.ai.say('Near the station.');
    r.chat.incoming('where?');
    r.chat.changed();
    await settle(40);
    const dropped = await say("don't send it");
    expect(dropped?.ok, dropped?.spoken).toBe(true);
    expect(r.chat.pressed).toEqual(['Yes, free after 7.']);
    expect(r.controller.view().draft).toBeNull();
  });

  it('"change it to …" changes the one that is ready', async () => {
    const r = await running('assisted');
    const { say } = commands(r);
    await say('type this: see you at 7');
    const out = await say('change it to see you at 8');
    expect(out?.ok, out?.spoken).toBe(true);
    expect(r.controller.view().draft?.text).toBe('see you at 8');
  });

  it('"what did she say" reads her last message', async () => {
    const r = await running('assisted');
    const { say } = commands(r);
    r.ai.say('Hello!');
    r.chat.incoming('are you coming today');
    r.chat.changed();
    await settle(40);
    const out = await say('what did she say');
    expect(out?.spoken).toBe('Rahul Sharma said: are you coming today');
  });

  it('"send it" with nothing waiting is not about this chat (it may be a file): left to the others', async () => {
    const r = await running('assisted');
    const { say } = commands(r);
    expect(await say('send it')).toBeNull();
    expect(await say('no')).toBeNull();
    expect(r.chat.pressed).toEqual([]);
  });

  it('without together on, none of it applies: the words are left to the others and nothing is sent', async () => {
    const sw = new FakeSwitch();
    const r = rig({ enable: sw.control });
    await r.controller.handle({ kind: 'start', name: 'Rahul Sharma', mode: 'assisted' });
    await settle(30);
    const { say } = commands(r);
    const out = await say('send this: I will come at 5');
    r.advance(10_000);
    await settle(30);
    expect(r.chat.pressed).toEqual([]);
    expect(out === null || !/Sending/.test(out.spoken)).toBe(true);
  });

  it('with no live chat running it is left alone as before', async () => {
    const r = rig();
    const { say } = commands(r);
    expect(await say('wait')).toBeNull();
    expect(await say('go ahead')).toBeNull();
    expect(await say('send this: hi')).toBeNull();
  });

  it('"together mode" and "I\'m here too" switch it on; "turn off together mode" switches it off', async () => {
    const sw = new FakeSwitch();
    const r = rig({ enable: sw.control });
    await r.controller.handle({ kind: 'start', name: 'Rahul Sharma', mode: 'assisted' });
    await settle(30);
    const { say } = commands(r);
    const on = await say("I'm here too");
    expect(on?.ok, on?.spoken).toBe(true);
    expect(on?.spoken).toMatch(/Together mode is on/);
    expect(r.controller.view().together).toBe(true);
    const off = await say('turn off together mode');
    expect(off?.ok).toBe(true);
    expect(r.controller.view().together).toBe(false);
  });

  it('"do live chat with Rahul, I am here too" starts it together', async () => {
    const sw = new FakeSwitch();
    const r = rig({ enable: sw.control });
    const { say } = commands(r);
    const out = await say('do live chat with Rahul Sharma, I am here too');
    expect(out, 'handled').not.toBeNull();
    await settle(40);
    expect(r.controller.view().together).toBe(true);
  });
});
