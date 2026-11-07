import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatSession } from '../src/main/chat/chatSession';
import { ContactBook } from '../src/main/chat/ContactBook';
import { buildDraftMessages, buildOpeningMessages, generateOpening } from '../src/main/livechat/draft';
import { ChatCommands } from '../src/main/local/ChatCommands';
import { MIGRATIONS } from '../src/main/memory/schema';
import { migrate, openDatabase } from '../src/main/memory/sqlite';
import type { Sql } from '../src/main/memory/sqlite';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';
import { parseLiveChatRequest } from '../src/shared/liveChat';
import { FakeAI, rig, settle } from './liveChatFixtures';
import type { Rig, RigOptions } from './liveChatFixtures';

/**
 * Starting a live chat the way it was actually asked, and the first message Eya writes when asked to ("make her happy"). Over a MOCK chat and a MOCK model: these prove
 * how Eya decides and what she asks the model — not how WhatsApp Web or a real model behaves.
 */

const PASTED = '+91 98765 08501  do live chat with this number she is my close friend u can make her happy she also no Eya msging here, ok do . in whatsapp';
const OPENING = 'Hi! Just thinking of you, hope your day is going great. How are you?';
const NEEDS_PERMISSION = 'The WhatsApp plugin has not been given the permission "Live chat companion". Allow it on the Plugins page.';

async function running(r: Rig, purpose = 'she is my close friend, make her happy', opening = true) {
  const res = await r.controller.start('Rahul', undefined, purpose, opening);
  expect(res.view.state, res.message).toBe('ACTIVE');
}

describe('the first message, from the controller', () => {
  it('is written only once automatic replies are on — never before — and sent once, through the normal checks', async () => {
    const r = rig();
    r.ai.say(OPENING);
    await running(r);
    await settle();
    expect(r.ai.calls).toBe(0); // draft mode: nothing is written by itself
    expect(r.controller.view().purpose).toMatch(/close friend/);
    const on = await r.controller.handle({ kind: 'enable_auto', confirmedAware: true });
    expect(on.ok).toBe(true);
    await settle(40);
    expect(r.chat.pressed).toEqual([OPENING]);
    expect(r.ai.calls).toBe(1);
    expect(r.controller.view()).toMatchObject({ state: 'ACTIVE', replies: 1, auto: { repliesSent: 1 } });
  });

  it('is not written again: her answer is replied to by the normal path, and the first message stays the only one of its kind', async () => {
    const r = rig();
    r.ai.say(OPENING).say('Aww that is so sweet, thank you!');
    await running(r);
    await r.controller.handle({ kind: 'enable_auto', confirmedAware: true });
    await settle(40);
    r.chat.incoming('Hey! I am fine, how are you?');
    r.chat.changed();
    await settle(40);
    r.advance(20_000); // (the gap between two automatic replies)
    await settle(40);
    expect(r.chat.pressed).toEqual([OPENING, 'Aww that is so sweet, thank you!']);
    expect(r.ai.calls).toBe(2);
    // and nothing more is written when nothing new came
    r.chat.changed();
    await settle(40);
    r.advance(60_000);
    await settle(40);
    expect(r.ai.calls).toBe(2);
    expect(r.chat.pressed).toHaveLength(2);
  });

  it('tells the model what the person asked for, that the other person knows, and that it must never pretend to be a human', async () => {
    const r = rig();
    r.ai.say(OPENING);
    await running(r);
    await r.controller.handle({ kind: 'enable_auto', confirmedAware: true });
    await settle(40);
    const asked = r.ai.requests[0] ?? '';
    expect(asked).toMatch(/close friend, make her happy/);
    expect(asked).toMatch(/knows, and agreed, that an assistant called Eya/);
    expect(asked).toMatch(/never claim to be a human/i);
    expect(asked).toMatch(/I am Eya, an assistant/);
    expect(asked).toMatch(/Write the first message/);
    expect(asked).not.toMatch(/98765|08501/); // no number goes to the model
  });

  it('a reply to her carries the same instruction and the same honesty rule', async () => {
    const r = rig();
    r.ai.say(OPENING).say('Doing well, thanks for asking!');
    await running(r);
    await r.controller.handle({ kind: 'enable_auto', confirmedAware: true });
    await settle(40);
    r.chat.incoming('Are you a bot?');
    r.chat.changed();
    await settle(40);
    const asked = r.ai.requests[1] ?? '';
    expect(asked).toMatch(/close friend, make her happy/);
    expect(asked).toMatch(/never claim to be a human/i);
    expect(asked).toMatch(/say honestly that you are Eya/);
    expect(asked).toMatch(/Them: Are you a bot\?/);
  });

  it('by default the first message goes out like any other automatic reply, even if it proposes something', async () => {
    const r = rig();
    r.ai.say('Shall we plan a nice evening together soon?', { commitment: true });
    await running(r);
    await r.controller.handle({ kind: 'enable_auto', confirmedAware: true });
    await settle(40);
    expect(r.chat.pressed).toEqual(['Shall we plan a nice evening together soon?']);
    expect(r.controller.view()).toMatchObject({ mode: 'auto', state: 'ACTIVE' });
  });

  it('when asked to hold back, a first message that is not a plain one (it commits to something) is not sent: it waits for the person, and the person can send it', async () => {
    const r = rig();
    r.ai.say('Shall we plan a nice evening together soon?', { commitment: true });
    await running(r);
    await r.controller.handle({ kind: 'enable_auto', confirmedAware: true, holdBack: true });
    await settle(40);
    expect(r.chat.pressed).toEqual([]);
    // (the same rule as for any reply: one that is not plain ends automatic replies and gives control back to the person)
    expect(r.controller.view()).toMatchObject({ state: 'WAITING_FOR_APPROVAL', mode: 'assisted', auto: null });
    expect(r.controller.view().notice).toMatch(/Control is back with you/);
    expect(r.controller.view().draft).toMatchObject({ text: 'Shall we plan a nice evening together soon?', by: 'eya', status: 'ready' });
    const sent = await r.controller.handle({ kind: 'send' });
    expect(sent.ok, sent.message).toBe(true);
    expect(r.chat.pressed).toEqual(['Shall we plan a nice evening together soon?']);
  });

  it('a first message with a figure the person never gave is not sent and not kept as a draft: it says what it needs', async () => {
    const r = rig();
    r.ai.say('Call me on 9876543210 right now!');
    await running(r);
    await r.controller.handle({ kind: 'enable_auto', confirmedAware: true });
    await settle(40);
    expect(r.chat.pressed).toEqual([]);
    expect(r.controller.view()).toMatchObject({ state: 'WAITING_FOR_USER', draft: null });
    expect(r.controller.view().notice).toMatch(/first message/);
    expect(r.ai.calls).toBe(1); // not tried again and again
  });

  it('the AI being out of reach is said, nothing is sent, and it is tried again by itself shortly', async () => {
    const r = rig();
    r.ai.raw(new Error('limit over')).say(OPENING);
    await running(r);
    await r.controller.handle({ kind: 'enable_auto', confirmedAware: true });
    await settle(40);
    expect(r.chat.pressed).toEqual([]);
    expect(r.controller.view().state).toBe('ACTIVE');
    expect(r.controller.view().error).toMatch(/first message/);
    expect(r.alerts).toContain('The AI could not write the first message.');
    r.advance(16_000);
    await settle(40);
    expect(r.chat.pressed).toEqual([OPENING]);
    expect(r.controller.view().error).toBeNull();
  });

  it('after a few failures it stops trying by itself and waits for Regenerate', async () => {
    const r = rig();
    for (let i = 0; i < 3; i += 1) r.ai.raw(new Error('limit over'));
    r.ai.say(OPENING);
    await running(r);
    await r.controller.handle({ kind: 'enable_auto', confirmedAware: true });
    await settle(40);
    for (let i = 0; i < 6; i += 1) {
      r.advance(16_000);
      await settle(40);
    }
    expect(r.ai.calls).toBe(3);
    expect(r.chat.pressed).toEqual([]);
    const again = await r.controller.handle({ kind: 'regenerate' });
    expect(again.ok, again.message).toBe(true);
    await settle(40);
    expect(r.chat.pressed).toEqual([OPENING]);
  });

  it('in Draft mode it is written only when the person presses Regenerate, and then waits for them; nothing is sent', async () => {
    const r = rig();
    r.ai.say(OPENING);
    await running(r);
    const res = await r.controller.handle({ kind: 'regenerate' });
    expect(res.ok, res.message).toBe(true);
    expect(r.controller.view().draft).toMatchObject({ text: OPENING, status: 'ready' });
    expect(r.controller.view().state).toBe('WAITING_FOR_APPROVAL');
    expect(r.chat.pressed).toEqual([]);
    const approved = await r.controller.handle({ kind: 'approve' });
    expect(approved.ok, approved.message).toBe(true);
    expect(r.chat.box).toBe(OPENING); // typed in WhatsApp's own box; Draft mode never presses Send
    expect(r.chat.pressed).toEqual([]);
  });

  it('a first message waiting for approval can be written again', async () => {
    const r = rig();
    r.ai.say('Hi! Hope you are well.').say('Hello you! How is your day going?');
    await running(r);
    await r.controller.handle({ kind: 'regenerate' });
    expect(r.controller.view().draft?.text).toBe('Hi! Hope you are well.');
    await r.controller.handle({ kind: 'regenerate' });
    expect(r.controller.view().draft?.text).toBe('Hello you! How is your day going?');
    expect(r.ai.calls).toBe(2);
  });

  it('when she wrote first, there is no first message left to write', async () => {
    const r = rig();
    r.ai.say('Yes, I am here! How are you?');
    await running(r);
    r.chat.incoming('Hey, you there?');
    r.chat.changed();
    await settle(40);
    expect(r.controller.view().draft?.text).toBe('Yes, I am here! How are you?');
    await r.controller.handle({ kind: 'discard' }); // (nothing waiting any more: only "she wrote first" stands in the way of a first message)
    await r.controller.handle({ kind: 'enable_auto', confirmedAware: true });
    await settle(40);
    expect(r.ai.calls).toBe(1); // no opening was written on top of the conversation
    expect(r.chat.pressed).toEqual([]);
  });

  it('an explicit "do not introduce yourself" is respected: nothing is written first', async () => {
    const r = rig();
    r.ai.say(OPENING);
    await running(r, '', false);
    await r.controller.handle({ kind: 'enable_auto', confirmedAware: true, introduce: false });
    await settle(40);
    expect(r.ai.calls).toBe(0);
    expect(r.chat.pressed).toEqual([]);
  });

  it('stopping at once leaves nothing sent', async () => {
    const r = rig();
    r.ai.say(OPENING);
    await running(r);
    r.ai.hold = new Promise(() => undefined); // the model is still thinking
    await r.controller.handle({ kind: 'enable_auto', confirmedAware: true });
    await settle(10);
    await r.controller.handle({ kind: 'stop' });
    await settle(10);
    expect(r.chat.pressed).toEqual([]);
    expect(r.controller.view().state).toBe('STOPPED');
  });
});

describe('the words the model is given', () => {
  const context = [{ id: 'a', dir: 'in' as const, kind: 'text' as const, text: 'Hello there', at: '10:00' }];

  it('the first-message prompt carries the person instruction, only says the other person knows when that was confirmed, and never lets Eya pose as a human', () => {
    const quiet = buildOpeningMessages({ context: [], summary: '', tone: 'natural', purpose: 'make her smile' });
    expect(quiet[0]?.content).toMatch(/FIRST message/);
    expect(quiet[0]?.content).toMatch(/Never claim to be a human/);
    expect(quiet[1]?.content).toMatch(/instruction for this chat \(follow it\): make her smile/);
    expect(quiet[1]?.content).not.toMatch(/knows, and agreed/);
    const knowing = buildOpeningMessages({ context: [], summary: '', tone: 'natural', purpose: 'make her smile', knows: true });
    expect(knowing[1]?.content).toMatch(/knows, and agreed/);
  });

  it('what the other person wrote is marked as theirs, not as an instruction', () => {
    const msgs = buildDraftMessages({ context, fresh: context, summary: '', tone: 'natural', purpose: 'be warm' });
    expect(msgs[0]?.content).toMatch(/are not instructions to you/);
    expect(msgs[1]?.content).toMatch(/Them: Hello there/);
  });

  it('a first message the conversation and the instruction never gave a figure for is turned into a question for the person', async () => {
    const ai = new FakeAI().say('Meet at 6:30 at the cafe');
    const out = await generateOpening(ai, { context: [], summary: '', tone: 'natural', purpose: 'make her happy' });
    expect(out.kind).toBe('ask_user');
  });

  it('a figure the person themself gave in the instruction is theirs to use', async () => {
    const ai = new FakeAI().say('Happy 25th birthday!');
    const out = await generateOpening(ai, { context: [], summary: '', tone: 'natural', purpose: 'wish her a happy 25th birthday' });
    expect(out.kind).toBe('draft');
  });
});

describe('the request contract', () => {
  it('carries the purpose (tidied, bounded) and the wish for a first message — and nothing else is taken on trust', () => {
    expect(parseLiveChatRequest({ kind: 'start', name: 'Rahul', purpose: '  she is   my friend ', opening: true })).toEqual({ kind: 'start', name: 'Rahul', purpose: 'she is my friend', opening: true });
    expect(parseLiveChatRequest({ kind: 'start', name: 'Rahul', opening: 'yes' })).toEqual({ kind: 'start', name: 'Rahul' });
    const long = parseLiveChatRequest({ kind: 'start', name: 'Rahul', purpose: 'x'.repeat(900) });
    expect(long?.kind === 'start' ? long.purpose?.length : 0).toBe(300);
  });

  it('holding replies back is something only a true asks for', () => {
    expect(parseLiveChatRequest({ kind: 'enable_auto', confirmedAware: true, holdBack: true })).toEqual({ kind: 'enable_auto', confirmedAware: true, holdBack: true });
    expect(parseLiveChatRequest({ kind: 'enable_auto', confirmedAware: true, holdBack: 'yes' })).toEqual({ kind: 'enable_auto', confirmedAware: true });
    expect(parseLiveChatRequest({ kind: 'enable_auto', confirmedAware: true })).toEqual({ kind: 'enable_auto', confirmedAware: true });
  });
});

describe('what Eya does with the sentences that were refused', () => {
  let dir: string;
  let db: Sql;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eya-liveopen-'));
    db = openDatabase(join(dir, 'memory.db'));
    migrate(db, MIGRATIONS);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function commands(options: RigOptions = {}) {
    const r = rig(options);
    const queries: string[] = [];
    const open = r.chat.actions.open;
    r.chat.actions.open = async (query) => {
      queries.push(query);
      return open(query);
    };
    const cc = new ChatCommands({
      tools: { invoke: async (_name: string, _args: ToolArgs): Promise<ToolResult> => ({ ok: false, summary: 'unused', error: 'unused' }) },
      contacts: new ContactBook(db),
      policy: new CommunicationPolicy(() => ({ enabled: true, apps: {} })),
      session: new ChatSession(),
      confirmSends: 'unless_verified',
      fileRoute: 'chat',
      liveChat: r.controller,
      sleep: async () => undefined,
    });
    return { r, queries, say: (text: string) => cc.tryHandle(text) };
  }

  it('"+91 98765 08501 do live chat with this number …" starts it with that number, switches automatic replies on (she knows, the person said), and writes the first message', async () => {
    const { r, queries, say } = commands();
    r.ai.say(OPENING);
    const out = await say(PASTED);
    expect(out, 'it must be handled here, not left for the model to refuse').not.toBeNull();
    expect(out?.ok, out?.spoken).toBe(true);
    expect(queries).toEqual(['+91 98765 08501']);
    expect(out?.spoken).toMatch(/Live chat is on with Rahul Sharma\./);
    expect(out?.spoken).toMatch(/Automatic replies are ON/);
    expect(out?.spoken).toMatch(/You said Rahul Sharma knows it is Eya writing/);
    expect(out?.spoken).toMatch(/introducing myself in the chat now/);
    expect(out?.spoken).not.toMatch(/98765|08501/);
    expect(r.controller.view().mode).toBe('auto');
    expect(r.controller.view().purpose).toMatch(/close friend/);
    await settle(40);
    expect(r.chat.pressed).toEqual([OPENING]);
    expect(r.controller.view().state).toBe('ACTIVE');
    expect(r.ai.requests[0]).toMatch(/make her happy/);
    expect(r.ai.requests[0]).not.toMatch(/98765|08501/);
  });

  it('after the first message, her next message is answered as it comes in — even a reply that agrees to something is not held back', async () => {
    const { r, say } = commands();
    r.ai.say(OPENING).say('Yes, I will come tomorrow, see you there!', { commitment: true, confidence: 'medium' });
    await say(PASTED);
    await settle(40);
    r.chat.incoming('Will you come tomorrow?');
    r.chat.changed();
    await settle(40);
    r.advance(20_000);
    await settle(40);
    expect(r.chat.pressed).toEqual([OPENING, 'Yes, I will come tomorrow, see you there!']);
    expect(r.controller.view()).toMatchObject({ mode: 'auto', auto: { holdBack: false } });
    expect(r.ai.requests[1]).toMatch(/You are Eya, an AI assistant/);
  });

  it('the question Eya asks says replies go out as each message comes in, and what is never sent', async () => {
    const { say } = commands();
    const out = await say('do live chat with 9361113900');
    expect(out?.spoken).toMatch(/as each message comes in, without asking you each time/);
    expect(out?.spoken).toMatch(/never send passwords, codes or card numbers and never make up a time, an amount or a link/);
    expect(out?.spoken).toMatch(/stop live chat/);
    expect(out?.spoken).not.toMatch(/only plain replies/);
  });

  it('when the person did not say she knows, the ONE question is asked first — and nothing is switched on or written until the person says yes', async () => {
    const { r, say } = commands();
    r.ai.say(OPENING);
    const out = await say('do live chat with 9361113900 and make her happy');
    expect(out?.ok).toBe(true);
    expect(out?.spoken).toMatch(/must know and agree that replies in this chat are written with AI help/);
    expect(out?.spoken).toMatch(/introducing myself in the chat as Eya/);
    await settle(40);
    expect(r.controller.view()).toMatchObject({ state: 'ACTIVE', mode: 'draft', auto: null });
    expect(r.ai.calls).toBe(0);
    expect(r.chat.pressed).toEqual([]);
    const yes = await say('yes');
    expect(yes?.ok, yes?.spoken).toBe(true);
    await settle(40);
    expect(r.controller.view().mode).toBe('auto');
    expect(r.chat.pressed).toEqual([OPENING]);
  });

  it('"she does not know" is never taken as her agreement, and no first message is written', async () => {
    const { r, say } = commands();
    r.ai.say(OPENING);
    const out = await say('do live chat with 9361113900 make her happy but she does not know it is Eya');
    expect(out?.spoken).toMatch(/does not know it is Eya, so I only write replies for you to review and never send anything by myself/); // (nothing is asked: there is nothing she could be taken to have agreed to)
    expect(out?.spoken).not.toMatch(/first message/);
    await settle(40);
    expect(r.controller.view()).toMatchObject({ mode: 'draft', auto: null });
    expect(r.ai.calls).toBe(0);
    expect(r.chat.pressed).toEqual([]);
  });

  it('a "no" to the question keeps it as it was, and the first message is not written', async () => {
    const { r, say } = commands();
    r.ai.say(OPENING);
    await say('do live chat with 9361113900 and make her happy');
    const no = await say('no');
    expect(no?.spoken).toMatch(/No automatic replies/);
    await settle(40);
    expect(r.ai.calls).toBe(0);
    expect(r.chat.pressed).toEqual([]);
  });

  it('without the plugin permission it says exactly what to switch on — and "do live chat now go" afterwards starts it with the same number and the same instruction', async () => {
    let granted = false;
    const { r, queries, say } = commands({ permits: (p) => (p === 'chats.live' && !granted ? NEEDS_PERMISSION : null) });
    r.ai.say(OPENING);
    const first = await say(PASTED);
    expect(first?.ok).toBe(false);
    expect(first?.spoken).toMatch(/Live chat companion/);
    expect(first?.spoken).toMatch(/open Live chat in Eya and switch on "Enable live chat"/);
    expect(first?.spoken).toMatch(/do live chat now go/);
    expect(first?.spoken).not.toMatch(/98765|08501/);
    expect(queries).toEqual([]); // nothing was opened, watched or written
    granted = true;
    const again = await say('do live chat now go');
    expect(again?.ok, again?.spoken).toBe(true);
    expect(queries).toEqual(['+91 98765 08501']);
    expect(again?.spoken).toMatch(/Automatic replies are ON/);
    await settle(40);
    expect(r.chat.pressed).toEqual([OPENING]);
    expect(r.ai.requests[0]).toMatch(/make her happy/);
  });

  it('"ok" after a start that could not happen takes the same request up again', async () => {
    let granted = false;
    const { r, queries, say } = commands({ permits: (p) => (p === 'chats.live' && !granted ? NEEDS_PERMISSION : null) });
    r.ai.say(OPENING);
    await say(PASTED);
    granted = true;
    const again = await say('ok');
    expect(again?.ok, again?.spoken).toBe(true);
    expect(queries).toEqual(['+91 98765 08501']);
    await settle(40);
    expect(r.controller.view().state).toBe('ACTIVE');
    expect(r.chat.pressed).toEqual([OPENING]);
  });

  it('"do live chat now go" with nobody mentioned before asks who — it is never refused, and nothing starts', async () => {
    const { r, queries, say } = commands();
    const out = await say('do live chat now go');
    expect(out?.ok).toBe(true);
    expect(out?.spoken).toMatch(/Who should I do the live chat with/);
    expect(queries).toEqual([]);
    expect(r.controller.view().state).toBe('IDLE');
  });

  it('a request that names nobody but says what it is for keeps that for the number given next', async () => {
    const { r, queries, say } = commands();
    r.ai.say(OPENING);
    await say('do live chat, make her happy, she also knows it is Eya');
    expect(queries).toEqual([]);
    const out = await say('do live chat with 9361113900');
    expect(out?.ok, out?.spoken).toBe(true);
    expect(queries).toEqual(['9361113900']);
    expect(out?.spoken).toMatch(/Automatic replies are ON/);
    await settle(40);
    expect(r.chat.pressed).toEqual([OPENING]);
  });

  it('a request that names someone else does not inherit what was said about the earlier one', async () => {
    const { r, queries, say } = commands();
    r.ai.say(OPENING);
    await say('do live chat with Priya make her happy she knows it is Eya');
    await say('stop live chat');
    r.chat.open = 'Rahul Sharma';
    const out = await say('do live chat with Amma');
    expect(queries).toEqual(['Priya', 'Amma']);
    expect(out?.spoken).toMatch(/must know and agree/); // asked, not assumed
    expect(r.controller.view()).toMatchObject({ mode: 'draft', auto: null, purpose: '' });
  });

  it('a chat that is only a likely match: nothing is switched on until the person confirms it — and then what they said is applied', async () => {
    const { r, say } = commands();
    r.chat.openOutcome = { kind: 'opened', label: 'Rahul Sharma', verified: false };
    r.ai.say(OPENING);
    const out = await say(PASTED);
    expect(out?.spoken).toMatch(/only a likely match/);
    expect(r.controller.view()).toMatchObject({ state: 'WAITING_FOR_USER', mode: 'draft', auto: null });
    await settle(40);
    expect(r.chat.pressed).toEqual([]);
    const confirmed = await say('confirm live chat');
    expect(confirmed?.spoken).toMatch(/Automatic replies are ON/);
    await settle(40);
    expect(r.chat.pressed).toEqual([OPENING]);
  });

  it('without permission to send, it still watches and drafts — and says it cannot reply on its own', async () => {
    const { r, say } = commands({ permits: (p) => (p === 'messages.send' ? 'The WhatsApp plugin has not been given the permission "Send text messages". Allow it on the Plugins page.' : null) });
    r.ai.say(OPENING);
    const out = await say(PASTED);
    expect(out?.ok).toBe(true);
    expect(out?.spoken).toMatch(/cannot reply on my own until Eya is allowed to send/);
    expect(r.controller.view()).toMatchObject({ state: 'ACTIVE', mode: 'draft', auto: null });
    await settle(40);
    expect(r.ai.calls).toBe(0);
    expect(r.chat.pressed).toEqual([]);
  });
});
