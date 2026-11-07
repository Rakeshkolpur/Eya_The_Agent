import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatSession } from '../src/main/chat/chatSession';
import { ContactBook } from '../src/main/chat/ContactBook';
import type { StoredSession } from '../src/main/livechat/session';
import { ChatCommands } from '../src/main/local/ChatCommands';
import { MIGRATIONS } from '../src/main/memory/schema';
import { migrate, openDatabase } from '../src/main/memory/sqlite';
import type { Sql } from '../src/main/memory/sqlite';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import { LiveChatPage } from '../src/renderer/pages/LiveChatPage';
import type { EyaControl } from '../src/renderer/control';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';
import { EMPTY_LIVE_CHAT_VIEW, parseLiveChatRequest } from '../src/shared/liveChat';
import type { LiveChatView } from '../src/shared/liveChat';
import { FakeSwitch, rig, settle } from './liveChatFixtures';
import type { Rig, RigOptions } from './liveChatFixtures';

/**
 * "If I enable it, it should do the live chat without asking any other permission — all the related permissions with one enable option." What a live chat does when the
 * ONE switch is on, what it does when it is not, and what Eya says. (The switch itself, over the real plugin manager, is in liveChatSwitch.test.ts.)
 */

const OPENING = 'Hi! Just thinking of you, hope your day is going great. How are you?';
const PASTED = '+91 98765 08501  do live chat with this number she is my close friend u can make her happy she also no Eya msging here, ok do . in whatsapp';
const saved = (r: Rig): StoredSession => JSON.parse(r.io.files.get('live-chat.json') as string) as StoredSession;

function switched(on = true, options: RigOptions = {}) {
  const sw = new FakeSwitch();
  sw.on = on;
  const r = rig({ ...options, enable: sw.control });
  return { sw, r };
}

describe('the controller, with the switch on', () => {
  it('a live chat replies by itself as soon as the chat is confirmed — no question, no enable_auto request — and writes the first message when asked', async () => {
    const { r } = switched();
    r.ai.say(OPENING);
    const res = await r.controller.start('Rahul', undefined, 'she is my close friend, make her happy', true);
    // (it is on, and the first message is being written: the state says so until that is done)
    expect(['ACTIVE', 'PROCESSING_MESSAGE', 'DRAFT_READY', 'SENDING', 'VERIFYING'], res.message).toContain(res.view.state);
    expect(res.view).toMatchObject({ mode: 'auto', verified: true });
    expect(res.view.auto).not.toBeNull();
    expect(res.message).toMatch(/Automatic replies are ON: I answer each new message as it comes in/);
    expect(res.message).toMatch(/introducing myself in the chat now/);
    await settle(40);
    expect(r.chat.pressed).toEqual([OPENING]);
    expect(r.controller.view().state).toBe('ACTIVE');
    expect(saved(r).autoBasis).toBe('switch');
  });

  it('and answers what she writes next, as it comes in', async () => {
    const { r } = switched();
    r.ai.say('Good morning to you too!');
    await r.controller.start('Rahul');
    r.chat.incoming('Good morning');
    r.chat.changed();
    await settle(40);
    expect(r.chat.pressed).toEqual(['Good morning to you too!']);
  });

  it('what the person said in the request about her wins over the switch: "she does not know" is never replied to by itself', async () => {
    const { r } = switched();
    r.ai.say('Hello!');
    const res = await r.controller.start('Rahul', undefined, undefined, undefined, false);
    expect(res.view).toMatchObject({ state: 'ACTIVE', mode: 'draft', auto: null });
    r.chat.incoming('Hi');
    r.chat.changed();
    await settle(40);
    expect(r.chat.pressed).toEqual([]);
    expect(r.controller.view().draft?.text).toBe('Hello!');
    expect(saved(r).autoBasis).toBeNull();
  });

  it('a chat that is only a likely match waits for the person to confirm it; replies by themselves start when they do, and not before', async () => {
    const { r } = switched();
    r.chat.openOutcome = { kind: 'opened', label: 'Rahul Sharma', verified: false };
    const res = await r.controller.start('Rahul');
    expect(res.view).toMatchObject({ state: 'WAITING_FOR_USER', auto: null, mode: 'draft' });
    await settle(20);
    expect(r.chat.starts).toBe(0);
    const done = await r.controller.handle({ kind: 'confirm_chat' });
    expect(done.view).toMatchObject({ mode: 'auto' });
    expect(done.view.auto).not.toBeNull();
  });

  it('if the switch is turned off before the chat is confirmed, its standing yes is gone: nothing replies by itself', async () => {
    const { r, sw } = switched();
    r.chat.openOutcome = { kind: 'opened', label: 'Rahul Sharma', verified: false };
    await r.controller.start('Rahul');
    sw.on = false;
    const done = await r.controller.handle({ kind: 'confirm_chat' });
    expect(done.view).toMatchObject({ state: 'ACTIVE', mode: 'draft', auto: null });
  });

  it('a permission taken away underneath the switch ends its standing yes too', async () => {
    const { r, sw } = switched();
    sw.inPlace = false; // (what the switch rests on is no longer all there)
    const res = await r.controller.start('Rahul');
    expect(res.view).toMatchObject({ mode: 'draft', auto: null });
  });

  it('without the permission to send it still watches, and says it could not switch replies on', async () => {
    const { r } = switched(true, { permits: (p) => (p === 'messages.send' ? 'The WhatsApp plugin has not been given the permission "Send text messages". Allow it on the Plugins page.' : null) });
    const res = await r.controller.start('Rahul');
    expect(res.view).toMatchObject({ state: 'ACTIVE', mode: 'draft', auto: null });
    expect(res.message).toMatch(/could not switch on automatic replies/);
  });

  it('automatic replies that run on the switch do not survive a restart: Resume brings the chat back as Assisted, as for any automatic reply', async () => {
    const { r } = switched();
    await r.controller.start('Rahul');
    expect(r.controller.view().mode).toBe('auto');
    expect(saved(r).autoBasis).toBe('switch'); // (as it was while it ran)
    const again = r.restarted();
    expect(again.view()).toMatchObject({ state: 'PAUSED', mode: 'assisted', auto: null });
    expect(saved(r).autoBasis).toBeNull(); // (a restart ends the standing yes for that run)
    const resumed = await again.resume();
    expect(resumed.view).toMatchObject({ mode: 'assisted', auto: null });
  });
});

describe('the controller, without the switch (or with it off)', () => {
  it('nothing replies by itself: it drafts, as before', async () => {
    const none = rig();
    expect((await none.controller.start('Rahul')).view).toMatchObject({ mode: 'draft', auto: null });
    const { r } = switched(false);
    expect((await r.controller.start('Rahul')).view).toMatchObject({ mode: 'draft', auto: null });
  });

  it('"she knows", said in the request, is still enough on its own', async () => {
    const r = rig();
    const res = await r.controller.start('Rahul', undefined, undefined, undefined, true);
    expect(res.view).toMatchObject({ mode: 'auto' });
    expect(saved(r).autoBasis).toBe('said');
  });
});

describe('the switch through the controller (the page is the only way in)', () => {
  it('on and off reach the switch, and the view shows it', async () => {
    const { r, sw } = switched(false);
    expect(r.controller.view().enable).toMatchObject({ on: false, ready: false });
    const on = await r.controller.handle({ kind: 'enable_live' });
    expect(on.ok, on.message).toBe(true);
    expect(sw.turnedOn).toBe(1);
    expect(on.view.enable).toMatchObject({ on: true, ready: true });
    const off = await r.controller.handle({ kind: 'disable_live' });
    expect(off.ok).toBe(true);
    expect(off.view.enable.on).toBe(false);
  });

  it('switching it off ends automatic replies that were running on its word, at once', async () => {
    const { r } = switched();
    await r.controller.start('Rahul');
    expect(r.controller.view().mode).toBe('auto');
    const off = await r.controller.handle({ kind: 'disable_live' });
    expect(off.ok).toBe(true);
    expect(off.view).toMatchObject({ mode: 'assisted', auto: null });
    expect(off.view.notice).toMatch(/Live chat was switched off/);
    r.ai.say('Hi!');
    r.chat.incoming('Hello');
    r.chat.changed();
    await settle(40);
    expect(r.chat.pressed).toEqual([]); // the reply waits for the person
  });

  it('a switch that cannot be turned on says why, and the live chat stays as it was', async () => {
    const { r, sw } = switched(false);
    sw.failOn = 'The WhatsApp plugin cannot be connected here.';
    const on = await r.controller.handle({ kind: 'enable_live' });
    expect(on.ok).toBe(false);
    expect(on.message).toMatch(/cannot be connected here/);
    expect(on.view.enable.on).toBe(false);
  });

  it('with no switch at all, the request is refused', async () => {
    const r = rig();
    expect((await r.controller.handle({ kind: 'enable_live' })).ok).toBe(false);
  });

  it('only Eya\'s own page can send these: the request parser knows them, and a start can say "she does not know" but nothing can say "enable" through a start', () => {
    expect(parseLiveChatRequest({ kind: 'enable_live' })).toEqual({ kind: 'enable_live' });
    expect(parseLiveChatRequest({ kind: 'disable_live' })).toEqual({ kind: 'disable_live' });
    expect(parseLiveChatRequest({ kind: 'start', name: 'Rahul', knows: false })).toEqual({ kind: 'start', name: 'Rahul', knows: false });
    expect(parseLiveChatRequest({ kind: 'start', name: 'Rahul', knows: 'no' })).toEqual({ kind: 'start', name: 'Rahul' });
    expect(parseLiveChatRequest({ kind: 'start', name: 'Rahul', enable: true })).toEqual({ kind: 'start', name: 'Rahul' });
  });

  it('a change outside the controller (a permission, Chats) tells the page', async () => {
    const { r } = switched();
    const seen: LiveChatView[] = [];
    r.controller.onChange((v) => seen.push(v));
    r.controller.refresh();
    expect(seen).toHaveLength(1);
  });
});

describe('what Eya says', () => {
  let dir: string;
  let db: Sql;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eya-livechat-enable-'));
    db = openDatabase(join(dir, 'memory.db'));
    migrate(db, MIGRATIONS);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function commands(on: boolean, options: RigOptions = {}) {
    const sw = new FakeSwitch();
    sw.on = on;
    const r = rig({ ...options, enable: sw.control });
    const queries: string[] = [];
    const open = r.chat.actions.open;
    r.chat.actions.open = async (query) => {
      queries.push(query);
      return open(query);
    };
    const cc = new ChatCommands({
      tools: { invoke: async (_n: string, _a: ToolArgs): Promise<ToolResult> => ({ ok: false, summary: 'unused', error: 'unused' }) },
      contacts: new ContactBook(db),
      policy: new CommunicationPolicy(() => ({ enabled: true, apps: {} })),
      session: new ChatSession(),
      confirmSends: 'unless_verified',
      fileRoute: 'chat',
      liveChat: r.controller,
      sleep: async () => undefined,
    });
    return { r, sw, queries, say: (text: string) => cc.tryHandle(text) };
  }

  it('switch ON: "do live chat with <number>" starts it, replies by itself, with NO question — and says why it did not ask', async () => {
    const { r, queries, say } = commands(true);
    r.ai.say(OPENING);
    const out = await say('do live chat with 9361113900 and make her happy');
    expect(out?.ok, out?.spoken).toBe(true);
    expect(queries).toEqual(['9361113900']);
    expect(out?.spoken).toMatch(/Automatic replies are ON/);
    expect(out?.spoken).toMatch(/Your Enable live chat switch is on, so I answer by myself and do not ask each time/);
    expect(out?.spoken).toMatch(/introducing myself in the chat now/);
    expect(out?.spoken).not.toMatch(/Is that so\?/);
    await settle(40);
    expect(r.chat.pressed).toEqual([OPENING]);
  });

  it('switch ON: the sentence that was refused just works, and says it is on the person\'s word that she knows', async () => {
    const { r, queries, say } = commands(true);
    r.ai.say(OPENING);
    const out = await say(PASTED);
    expect(queries).toEqual(['+91 98765 08501']);
    expect(out?.spoken).toMatch(/You said Rahul Sharma knows it is Eya writing/);
    await settle(40);
    expect(r.chat.pressed).toEqual([OPENING]);
  });

  it('switch ON and the person says she does NOT know: nothing is sent by itself, and nothing is asked', async () => {
    const { r, say } = commands(true);
    r.ai.say(OPENING);
    const out = await say('do live chat with 9361113900 make her happy but she does not know it is Eya');
    expect(out?.ok).toBe(true);
    expect(out?.spoken).toMatch(/does not know it is Eya, so I only write replies for you to review and never send anything by myself/);
    expect(out?.spoken).not.toMatch(/Is that so\?/);
    await settle(40);
    expect(r.controller.view()).toMatchObject({ mode: 'draft', auto: null });
    expect(r.chat.pressed).toEqual([]);
    expect(r.ai.calls).toBe(0);
  });

  it('switch OFF: the one question is asked as before — and it says how to never be asked', async () => {
    const { r, say } = commands(false);
    const out = await say('do live chat with 9361113900');
    expect(out?.spoken).toMatch(/Is that so\? Say yes to switch it on, or no to keep it as it is\./);
    expect(out?.spoken).toMatch(/switch on "Enable live chat" on the Live chat page/);
    expect(r.controller.view().auto).toBeNull();
  });

  it('a live chat that cannot start for a missing permission points at the ONE switch, not at the Plugins page', async () => {
    const { r, say } = commands(false, { permits: (p) => (p === 'chats.live' ? 'The WhatsApp plugin has not been given the permission "Live chat companion". Allow it on the Plugins page.' : null) });
    const out = await say('do live chat with 9361113900');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toMatch(/open Live chat in Eya and switch on "Enable live chat": one switch that allows everything the live chat needs/);
    expect(out?.spoken).toMatch(/I cannot switch it on for you/);
    expect(out?.spoken).toMatch(/do live chat now go/);
    expect(r.chat.starts).toBe(0);
  });

  it('after the person switches it on, "do live chat now go" starts it with the same number, no question', async () => {
    const sw = new FakeSwitch();
    let blocked = true;
    const r = rig({ enable: sw.control, permits: (p) => (p === 'chats.live' && blocked ? 'The WhatsApp plugin has not been given the permission "Live chat companion". Allow it on the Plugins page.' : null) });
    const queries: string[] = [];
    const open = r.chat.actions.open;
    r.chat.actions.open = async (q) => (queries.push(q), open(q));
    const cc = new ChatCommands({
      tools: { invoke: async () => ({ ok: false, summary: 'unused', error: 'unused' }) },
      contacts: new ContactBook(db),
      policy: new CommunicationPolicy(() => ({ enabled: true, apps: {} })),
      session: new ChatSession(),
      confirmSends: 'unless_verified',
      fileRoute: 'chat',
      liveChat: r.controller,
      sleep: async () => undefined,
    });
    r.ai.say(OPENING);
    const first = await cc.tryHandle(PASTED);
    expect(first?.ok).toBe(false);
    // the person clicks the switch on the page: everything it covers is now in place
    blocked = false;
    expect((await r.controller.handle({ kind: 'enable_live' })).ok).toBe(true);
    const again = await cc.tryHandle('do live chat now go');
    expect(again?.ok, again?.spoken).toBe(true);
    expect(queries).toEqual(['+91 98765 08501']);
    expect(again?.spoken).toMatch(/Automatic replies are ON/);
    await settle(40);
    expect(r.chat.pressed).toEqual([OPENING]);
  });

  it('a chat that needs confirming: said, and when the person confirms it replies by itself start and Eya says so', async () => {
    const { r, say } = commands(true);
    r.chat.openOutcome = { kind: 'opened', label: 'Rahul Sharma', verified: false };
    const out = await say('do live chat with Rahul');
    expect(out?.spoken).toMatch(/only a likely match/);
    expect(r.controller.view().auto).toBeNull();
    const done = await say('confirm live chat');
    expect(done?.spoken).toMatch(/Automatic replies are ON/);
    expect(done?.spoken).toMatch(/Enable live chat switch is on/);
  });
});

describe('the Live chat page: one switch', () => {
  const html = (view: LiveChatView): string =>
    renderToStaticMarkup(React.createElement(LiveChatPage, { c: { liveChat: view, liveChatAct: async () => ({ ok: true, message: '', view }) } as unknown as EyaControl }));
  const ITEMS = [
    { id: 'plugin', label: 'The WhatsApp plugin is installed and on', ok: true },
    { id: 'connected', label: 'Eya may use your WhatsApp (Chats on for WhatsApp)', ok: true },
    { id: 'messages.send', label: 'Send the replies (permission: Send text messages)', ok: true },
  ];

  it('off: the switch is there, unchecked, with what it covers and the confirmation the person gives by turning it on', () => {
    const m = html({ ...EMPTY_LIVE_CHAT_VIEW, enable: { ownerName: 'Rakesh', on: false, ready: false, items: ITEMS.map((i) => ({ ...i, ok: false })) } });
    expect(m).toContain('Enable live chat');
    expect(m).toMatch(/<input[^>]*role="switch"[^>]*aria-label="Enable live chat"/);
    expect(m).not.toMatch(/role="switch"[^>]*checked/);
    expect(m).toContain('One switch for everything the live chat needs');
    expect(m).toContain('you confirm that the people you live-chat with know that replies are written with AI help');
    expect(m).toContain('The WhatsApp plugin is installed and on');
    expect(m).toContain('Off');
  });

  it('on and ready: it says a live chat replies by itself, every part ticked', () => {
    const m = html({ ...EMPTY_LIVE_CHAT_VIEW, enable: { ownerName: 'Rakesh', on: true, ready: true, items: ITEMS } });
    expect(m).toMatch(/role="switch"[^>]*checked/);
    expect(m).toContain('a live chat replies by itself, with no question each time');
    expect(m).not.toContain('Allow what is missing again');
  });

  it('on but something it needs was taken away: said, with the missing part named and one button to put it back', () => {
    const m = html({ ...EMPTY_LIVE_CHAT_VIEW, enable: { ownerName: 'Rakesh', on: true, ready: false, items: [ITEMS[0] as (typeof ITEMS)[number], { id: 'messages.send', label: 'Send the replies (permission: Send text messages)', ok: false }] } });
    expect(m).toContain('On, but something it needs was taken away');
    expect(m).toContain('Allow what is missing again');
    expect(m).toContain('(not in place)');
  });
});
