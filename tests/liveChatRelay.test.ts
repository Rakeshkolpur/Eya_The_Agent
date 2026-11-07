import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatSession } from '../src/main/chat/chatSession';
import { ContactBook } from '../src/main/chat/ContactBook';
import { ChatCommands } from '../src/main/local/ChatCommands';
import { parseChatIntent, parseRelay } from '../src/main/local/chatIntents';
import { MIGRATIONS } from '../src/main/memory/schema';
import { migrate, openDatabase } from '../src/main/memory/sqlite';
import type { Sql } from '../src/main/memory/sqlite';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';
import { parseLiveChatRequest } from '../src/shared/liveChat';
import { FakeSwitch, rig, settle } from './liveChatFixtures';
import type { Rig, RigOptions } from './liveChatFixtures';

/**
 * "If the other person says anything for Rakesh, speak it here to Rakesh — who it is from (the number or the name) and what they said. If Rakesh says something, reply that
 * to that person." Over a MOCK chat and a MOCK model.
 */

const INTRO = "Hi! I am Eya, Rakesh's assistant 😊 What do you need?";

function switched(options: RigOptions = {}) {
  const sw = new FakeSwitch();
  sw.on = true;
  const r = rig({ ...options, enable: sw.control });
  return { sw, r };
}

/** A live chat in automatic mode that has said hello, with the other person having just written something for Rakesh. */
async function running(options: RigOptions = {}, chatLabel = 'Rahul Sharma') {
  const { r } = switched(options);
  r.chat.openOutcome = { kind: 'opened', label: chatLabel, verified: true };
  r.chat.open = chatLabel;
  r.chat.title = chatLabel;
  r.ai.say(INTRO);
  await r.controller.start(chatLabel);
  await settle(40);
  return r;
}

async function theySay(r: Rig, text: string, reply: string, forOwner: string | null): Promise<void> {
  r.ai.say(reply, forOwner === null ? {} : { for_owner: forOwner });
  r.chat.incoming(text);
  r.chat.changed();
  await settle(40);
  r.advance(12_000);
  await settle(40);
}

describe('what the other person says for Rakesh is said TO Rakesh', () => {
  it('by name: "Rakesh, Rahul Sharma says: …", spoken and shown, with how to answer', async () => {
    const r = await running();
    await theySay(r, 'Please tell Rakesh his father wants to talk to him', 'Sure, I will tell Rakesh 😊', 'your father wants to talk to you');
    expect(r.said).toHaveLength(1);
    expect(r.said[0]?.spoken).toBe('Rakesh, Rahul Sharma says: your father wants to talk to you. Tell me what to answer, if you like.');
    expect(r.said[0]?.shown).toMatch(/^Rakesh, Rahul Sharma says: your father wants to talk to you\. To answer, say or type for example "tell them I will call at 6"/);
    // (it is also kept on the Live chat page, as before)
    expect(r.controller.view().forYou.map((n) => n.text)).toEqual(['your father wants to talk to you']);
  });

  it('by number: spoken by its last digits only, shown masked — the number is never read out in full', async () => {
    const r = await running({}, '+91 98765 08501');
    await theySay(r, 'tell Rakesh I called', 'ok, I will tell him', 'she called and wants you to ring back');
    const said = r.said[0];
    expect(said?.spoken).toMatch(/^Rakesh, the number ending 8 5 0 1 says: she called and wants you to ring back\./);
    expect(said?.spoken).not.toMatch(/98765|08501|\+91/);
    expect(said?.shown).not.toMatch(/98765/);
    expect(said?.shown).toMatch(/8501/);
  });

  it('nothing is said when there is nothing for Rakesh', async () => {
    const r = await running();
    await theySay(r, 'hi, how are you', 'I am good, thanks! You?', null);
    expect(r.said).toEqual([]);
  });

  it('without a name for the person, it is just who and what', async () => {
    const { sw, r } = switched();
    sw.owner = '';
    r.ai.say(INTRO);
    await r.controller.start('Rahul');
    await settle(40);
    await theySay(r, 'tell him I called', 'will do', 'he called');
    expect(r.said[0]?.spoken).toBe('Rahul Sharma says: he called. Tell me what to answer, if you like.');
  });
});

describe('what Rakesh says is sent to that person', () => {
  it('"tell them …": sent in the chat as "Rakesh says: …", and checked in the chat like any send', async () => {
    const r = await running();
    await theySay(r, 'tell Rakesh I called', 'ok', 'she called');
    const before = r.chat.pressed.length;
    const done = await r.controller.handle({ kind: 'relay', text: 'I will call at 6' });
    expect(done.ok, done.message).toBe(true);
    expect(r.chat.pressed.slice(before)).toEqual(['Rakesh says: I will call at 6']);
    expect(r.chat.messages.some((m) => m.dir === 'out' && m.text === 'Rakesh says: I will call at 6')).toBe(true);
    expect(r.controller.state).toBe('ACTIVE');
  });

  it('a newer message from them does not make it out of date (it is not an answer to anything): it is sent, and the new message is answered after it', async () => {
    const r = await running();
    r.chat.incoming('are you there?'); // (arrived, not looked at yet)
    r.ai.say('Yes, I am here!');
    const done = await r.controller.handle({ kind: 'relay', text: 'I will call at 6' });
    expect(done.ok, done.message).toBe(true);
    await settle(40);
    r.advance(12_000);
    await settle(40);
    expect(r.chat.pressed.some((t) => t === 'Rakesh says: I will call at 6')).toBe(true);
    expect(r.chat.pressed).toContain('Yes, I am here!');
  });

  it('Draft mode never sends: the words go in WhatsApp\'s box for the person to press Send', async () => {
    const sw = new FakeSwitch(); // (the switch is off: Draft mode, and Eya knows whose assistant she is)
    const r = rig({ enable: sw.control });
    await r.controller.start('Rahul');
    await settle();
    const done = await r.controller.handle({ kind: 'relay', text: 'I will call at 6' });
    expect(done.ok, done.message).toBe(true);
    expect(r.chat.pressed).toEqual([]);
    expect(r.chat.box).toBe('Rakesh says: I will call at 6');
    expect(done.message).toMatch(/press Send/);
  });

  it('every other check still holds: the wrong chat open, nothing is sent', async () => {
    const r = await running();
    const before = r.chat.pressed.length;
    r.chat.open = 'Somebody Else';
    const done = await r.controller.handle({ kind: 'relay', text: 'I will call at 6' });
    expect(done.ok).toBe(false);
    expect(r.chat.pressed.length).toBe(before);
  });

  it('with no live chat running, or paused, nothing is sent and it says why', async () => {
    const r = rig();
    const none = await r.controller.handle({ kind: 'relay', text: 'hello' });
    expect(none.ok).toBe(false);
    expect(none.message).toMatch(/no live chat running/);
    await r.controller.start('Rahul');
    await settle();
    await r.controller.pause('user');
    const paused = await r.controller.handle({ kind: 'relay', text: 'hello' });
    expect(paused.ok).toBe(false);
    expect(paused.message).toMatch(/paused/);
    expect(r.chat.pressed).toEqual([]);
  });

  it('only the person\'s words can reach it: the page request is checked (a length, no empty text)', () => {
    expect(parseLiveChatRequest({ kind: 'relay', text: '  I will call  at 6 ' })).toEqual({ kind: 'relay', text: 'I will call at 6' });
    expect(parseLiveChatRequest({ kind: 'relay', text: '   ' })).toBeNull();
    expect(parseLiveChatRequest({ kind: 'relay', text: 'x'.repeat(601) })).toBeNull();
    expect(parseLiveChatRequest({ kind: 'relay' })).toBeNull();
  });
});

describe('how a person says it', () => {
  it.each([
    ['tell her I will call at 6', 'I will call at 6', 'her'],
    ['tell him that I am busy', 'I am busy', 'him'],
    ['Tell them I am coming', 'I am coming', 'them'],
    ['say to them hello', 'hello', 'them'],
    ['let her know I reached', 'I reached', 'her'],
    ['ok tell her ok done', 'ok done', 'her'],
    ['reply to her: I will check', 'I will check', 'her'],
    ['tell her to call me', 'please call me', 'her'],
    ['tell that person I am out of station', 'I am out of station', 'that person'],
  ])('%s → "%s" (to %s)', (said, text, to) => {
    expect(parseRelay(said)).toEqual({ text, to });
  });

  it('"reply: …" has no one named', () => {
    expect(parseRelay('reply: I will check')).toEqual({ text: 'I will check' });
    expect(parseRelay('reply with ok done')).toEqual({ text: 'ok done' });
  });

  it.each(['tell me a joke', 'tell Rahul I am late', 'tell her', 'what did she say', 'send hi to Anna', 'reply', 'say hello to him on instagram'])('%s is not a relay', (said) => {
    const relay = parseRelay(said);
    // ("say hello to him on instagram" is another app's request; the rest name nobody or somebody by name)
    expect(relay === null || /instagram/i.test(said)).toBe(true);
  });

  it('it is NOT one of the chat intents: "tell him …" is also how a message to the person messaged earlier is asked for, so ChatCommands looks at it only while a live chat runs', () => {
    expect(parseChatIntent('tell her I will call at 6')).not.toMatchObject({ kind: 'live_chat' });
    expect(parseChatIntent('tell Rahul I am late')).not.toMatchObject({ kind: 'live_chat' });
  });
});

describe('through ChatCommands (typed, or spoken through quick_command)', () => {
  let dir: string;
  let db: Sql;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eya-relay-'));
    db = openDatabase(join(dir, 'memory.db'));
    migrate(db, MIGRATIONS);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function commands(r: Rig, now: () => number = () => r.clock.now) {
    const cc = new ChatCommands({
      tools: { invoke: async (_n: string, _a: ToolArgs): Promise<ToolResult> => ({ ok: false, summary: 'unused', error: 'unused' }) },
      contacts: new ContactBook(db),
      policy: new CommunicationPolicy(() => ({ enabled: true, apps: {} })),
      session: new ChatSession(),
      confirmSends: 'unless_verified',
      fileRoute: 'chat',
      liveChat: r.controller,
      sleep: async () => undefined,
      now,
    });
    return { say: (text: string) => cc.tryHandle(text) };
  }

  it('"tell her I will call at 6" while a live chat is running: sent, and said back', async () => {
    const r = await running();
    const { say } = commands(r);
    const before = r.chat.pressed.length;
    const out = await say('tell her I will call at 6');
    expect(out, 'handled here').not.toBeNull();
    expect(out?.ok, out?.spoken).toBe(true);
    expect(out?.spoken).toBe('Done. I told Rahul Sharma: "Rakesh says: I will call at 6".');
    expect(r.chat.pressed.slice(before)).toEqual(['Rakesh says: I will call at 6']);
  });

  it('with no live chat running it is left to the model, as before', async () => {
    const r = rig();
    const { say } = commands(r);
    expect(await say('tell her I will call at 6')).toBeNull();
    expect(r.chat.pressed).toEqual([]);
  });

  it('"reply: …" is an answer only soon after they had something for Rakesh', async () => {
    const r = await running();
    const { say } = commands(r);
    expect(await say('reply: ok done'), 'nothing to reply to yet').toBeNull();
    await theySay(r, 'tell Rakesh I called', 'ok', 'she called');
    const out = await say('reply: ok done');
    expect(out?.ok, out?.spoken).toBe(true);
    expect(r.chat.pressed.at(-1)).toBe('Rakesh says: ok done');
    // (half an hour later it is no longer "the answer")
    r.advance(31 * 60_000);
    expect(await say('reply: something else')).toBeNull();
  });

  it('a name is a message to somebody, not an answer to the live chat', async () => {
    const r = await running();
    const { say } = commands(r);
    const before = r.chat.pressed.length;
    const out = await say('tell Anna I am late');
    // (handled as a message to Anna by the normal path, which this test does not wire: it must not be sent into the live chat)
    expect(r.chat.pressed.length).toBe(before);
    expect(out === null || !/Rahul Sharma/.test(out.spoken)).toBe(true);
  });
});
