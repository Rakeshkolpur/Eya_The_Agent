import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatSession } from '../src/main/chat/chatSession';
import { ContactBook } from '../src/main/chat/ContactBook';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { createLiveChatTool } from '../src/main/tools/impl/liveChatTool';
import { ChatCommands } from '../src/main/local/ChatCommands';
import { parseChatIntent } from '../src/main/local/chatIntents';
import { MIGRATIONS } from '../src/main/memory/schema';
import { migrate, openDatabase } from '../src/main/memory/sqlite';
import type { Sql } from '../src/main/memory/sqlite';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';
import type { LiveChatRequest, LiveChatResult, LiveChatView } from '../src/shared/liveChat';
import { EMPTY_LIVE_CHAT_VIEW } from '../src/shared/liveChat';
import { rig, settle } from './liveChatFixtures';

describe('"start live chat with …" and its siblings, in the person’s own words', () => {
  it.each([
    ['Start live chat with my friend Rahul', { action: 'start', name: 'Rahul' }],
    ['start a live chat with Rahul Sharma', { action: 'start', name: 'Rahul Sharma' }],
    ['please begin live chat with Priya on WhatsApp', { action: 'start', name: 'Priya' }],
    ['start live chat with Rahul in assisted mode', { action: 'start', name: 'Rahul', mode: 'assisted' }],
    ['open the live WhatsApp chat with Amma', { action: 'start', name: 'Amma' }],
    ['stop live chat', { action: 'stop' }],
    ['end the live chat', { action: 'stop' }],
    ['pause live chat', { action: 'pause' }],
    ['resume the live chat', { action: 'resume' }],
    ['live chat status', { action: 'status' }],
    ['is the live chat running', { action: 'status' }],
    ['confirm live chat', { action: 'confirm' }],
    ['live chat option 2', { action: 'choose', choice: 2 }],
    ['turn on auto reply', { action: 'auto' }],
    ['reply automatically in the live chat', { action: 'auto' }],
    ['Switch on automatic replies', { action: 'auto' }],
  ])('%s', (said, expected) => {
    expect(parseChatIntent(said)).toMatchObject({ kind: 'live_chat', ...expected });
  });

  it('never starts in automatic mode, and is not taken for anything else', () => {
    expect(parseChatIntent('start live chat with Rahul in auto mode')).toMatchObject({ kind: 'live_chat', action: 'start', name: 'Rahul', autoAsked: true });
    expect(parseChatIntent('start live chat with Rahul in auto mode')).not.toHaveProperty('mode');
    expect(parseChatIntent('open Rahul chat on whatsapp')).toMatchObject({ kind: 'open_chat' });
    expect(parseChatIntent('send hi to Rahul on whatsapp')).toMatchObject({ kind: 'message' });
    expect(parseChatIntent('start a chat with Rahul')).toBeNull();
    expect(parseChatIntent('live chat')).toBeNull();
  });
});

describe('the faster layers in front of ChatCommands do not take these for something else', () => {
  it.each(['Start live chat with my friend Rahul', 'stop live chat', 'end the live chat', 'pause live chat', 'open the live chat with Amma', 'close live chat'])('%s is not an app to open or close', (said) => {
    expect(new IntentRouter({ lookup: () => null }).match(said)).toBeUndefined();
  });
});

describe('the live chat tool: what a model may and may not do with it', () => {
  function toolWith(requests: LiveChatRequest[], view: LiveChatView = EMPTY_LIVE_CHAT_VIEW) {
    return createLiveChatTool({
      handle: async (r): Promise<LiveChatResult> => {
        requests.push(r);
        return { ok: true, message: 'ok', view };
      },
      view: () => view,
    });
  }

  it('starts, stops, pauses, resumes and reports', async () => {
    const seen: LiveChatRequest[] = [];
    const tool = toolWith(seen);
    await tool.execute({ action: 'start', name: 'Rahul' });
    await tool.execute({ action: 'pause' });
    await tool.execute({ action: 'resume' });
    await tool.execute({ action: 'stop' });
    expect(seen).toEqual([{ kind: 'start', name: 'Rahul' }, { kind: 'pause' }, { kind: 'resume' }, { kind: 'stop' }]);
    expect((await tool.execute({ action: 'status' })).data?.['active']).toBe(false);
  });

  it('cannot approve, send, switch automatic replies on, confirm a chat or choose one', async () => {
    const seen: LiveChatRequest[] = [];
    const tool = toolWith(seen);
    for (const action of ['approve', 'send', 'enable_auto', 'confirm_chat', 'choose', 'edit_draft', 'set_mode']) {
      const r = await tool.execute({ action, name: 'x' });
      expect(r.ok, action).toBe(false);
    }
    expect(seen).toEqual([]);
    expect(JSON.stringify(tool.schema)).not.toMatch(/"(approve|send|enable_auto|confirm_chat)"/);
  });

  it('passes on what the person wanted from the chat and that Eya writes first — but only as asked, and never as a switch for automatic replies', async () => {
    const seen: LiveChatRequest[] = [];
    const tool = toolWith(seen);
    await tool.execute({ action: 'start', name: 'Rahul', purpose: '  she is my friend,   make her happy ', opening: true });
    await tool.execute({ action: 'start', name: 'Rahul', opening: 'yes' });
    expect(seen).toEqual([{ kind: 'start', name: 'Rahul', purpose: 'she is my friend, make her happy', opening: true }, { kind: 'start', name: 'Rahul' }]);
    expect(JSON.stringify(tool.schema)).not.toMatch(/"(approve|send|enable_auto|confirm_chat)"/);
  });

  it('needs a name to start', async () => {
    expect((await toolWith([]).execute({ action: 'start' })).ok).toBe(false);
  });
});

describe('through ChatCommands, with the real controller over the mock chat', () => {
  let dir: string;
  let db: Sql;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eya-livechat-'));
    db = openDatabase(join(dir, 'memory.db'));
    migrate(db, MIGRATIONS);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function commands() {
    const r = rig();
    r.chat.incoming('Hi Rahul here');
    const policy = new CommunicationPolicy(() => ({ enabled: true, apps: {} }));
    const cc = new ChatCommands({
      tools: { invoke: async (_name: string, _args: ToolArgs): Promise<ToolResult> => ({ ok: false, summary: 'unused', error: 'unused' }) },
      contacts: new ContactBook(db),
      policy,
      session: new ChatSession(),
      confirmSends: 'unless_verified',
      fileRoute: 'chat',
      liveChat: r.controller,
      sleep: async () => undefined,
    });
    return { r, say: (text: string) => cc.tryHandle(text), hear: (text: string) => cc.tryHandle(text, { live: true }) };
  }

  it('"Start live chat with my friend Rahul" opens the chat, starts watching in Draft mode (nothing sent), and asks the ONE question about replying by itself', async () => {
    const { r, say } = commands();
    const out = await say('Start live chat with my friend Rahul');
    expect(out?.intent).toBe('chat_live');
    expect(out?.ok).toBe(true);
    expect(out?.spoken).toMatch(/Live chat is on with Rahul Sharma\./);
    expect(out?.spoken).toMatch(/Is that so\? Say yes to switch it on, or no to keep it as it is\./);
    expect(r.controller.view()).toMatchObject({ state: 'ACTIVE', mode: 'draft', auto: null }); // asked, not switched on
    expect(r.chat.watching).toBe(true);
    expect(r.chat.pressed).toEqual([]);
  });

  it('a likely match asks for "confirm live chat" — and only that, in the person’s words, confirms it', async () => {
    const { r, say } = commands();
    r.chat.openOutcome = { kind: 'opened', label: 'Rahul Sharma', verified: false };
    const out = await say('start live chat with Rahul');
    expect(out?.spoken).toMatch(/only a likely match/);
    expect(out?.spoken).toMatch(/confirm live chat/);
    expect(r.chat.watching).toBe(false);
    const done = await say('confirm live chat');
    expect(done?.ok).toBe(true);
    expect(r.controller.view().state).toBe('ACTIVE');
  });

  it('several chats are listed, and a spoken number chooses', async () => {
    const { r, say } = commands();
    r.chat.openOutcome = { kind: 'ambiguous', options: [{ label: 'Rahul Sharma', choice: 1 }, { label: 'Rahul Verma', choice: 2 }] };
    r.chat.chooseOutcome = { kind: 'opened', label: 'Rahul Sharma', verified: true };
    const out = await say('start live chat with Rahul');
    expect(out?.spoken).toMatch(/1\. Rahul Sharma, 2\. Rahul Verma/);
    const chosen = await say('live chat option 1');
    expect(chosen?.ok).toBe(true);
    expect(r.controller.view().state).toBe('ACTIVE');
  });

  it('"…and reply automatically": the chat is started, then ONE question is asked; only the spoken or typed yes of the person switches automatic replies on', async () => {
    const { r, say } = commands();
    const out = await say('start live chat with Rahul in auto mode');
    expect(out?.ok).toBe(true);
    expect(out?.spoken).toMatch(/Auto-reply means I will answer Rahul Sharma myself/);
    expect(out?.spoken).toMatch(/must know and agree that replies in this chat are written with AI help/);
    expect(r.controller.view()).toMatchObject({ state: 'ACTIVE', mode: 'draft', auto: null }); // asked, not switched on
    const yes = await say('yes');
    expect(yes?.ok, yes?.spoken).toBe(true);
    expect(r.controller.view()).toMatchObject({ mode: 'auto', auto: { maxReplies: null, until: null } }); // (no limit unless one is set: it goes on until the person pauses or stops it)
    expect(r.controller.view().notice).toMatch(/Automatic replies are ON/);
  });

  it('a "no" to that question leaves everything as it was', async () => {
    const { r, say } = commands();
    await say('start live chat with Rahul in auto mode');
    const no = await say('no');
    expect(no?.spoken).toMatch(/No automatic replies/);
    expect(r.controller.view()).toMatchObject({ mode: 'draft', auto: null });
  });

  it('something else said instead of yes is not a yes (the question lapses and it is a new request)', async () => {
    const { r, say } = commands();
    await say('start live chat with Rahul in auto mode');
    await say('what is the weather');
    expect(r.controller.view().auto).toBeNull();
    expect(await say('yes')).toBeNull();
    expect(r.controller.view().auto).toBeNull();
  });

  it('"turn on auto reply" asks the same question for the live chat that is running — and is not about a live chat when none is', async () => {
    const none = commands();
    expect(await none.say('turn on auto reply')).toBeNull();
    const { r, say } = commands();
    await say('start live chat with Rahul');
    const asked = await say('turn on auto reply');
    expect(asked?.spoken).toMatch(/Is that so\? Say yes/);
    await say('yes');
    expect(r.controller.view().mode).toBe('auto');
  });

  it('an unconfirmed chat cannot be put on auto-reply: it is said, and no question is asked', async () => {
    const { r, say } = commands();
    r.chat.openOutcome = { kind: 'opened', label: 'Rahul Sharma', verified: false };
    const out = await say('start live chat with Rahul in auto mode');
    expect(out?.spoken).toMatch(/When the chat is confirmed, say "turn on auto reply"/);
    expect(await say('yes')).toBeNull();
    expect(r.controller.view().auto).toBeNull();
  });

  it('always-on listening never answers it: a "yes" heard from a room or a video is not a yes', async () => {
    const { r, say, hear } = commands();
    await say('start live chat with Rahul in auto mode');
    expect(await hear('yes')).toBeNull(); // heard by the always-on listener: not an answer
    expect(r.controller.view().auto).toBeNull();
    expect(await hear('turn on auto reply')).toBeNull(); // and not a command either
  });

  it('stop, pause, resume and status reach the controller', async () => {
    const { r, say } = commands();
    await say('start live chat with Rahul');
    expect((await say('live chat status'))?.spoken).toMatch(/is active/);
    await say('pause live chat');
    expect(r.controller.view().state).toBe('PAUSED');
    await say('resume live chat');
    await settle();
    expect(r.controller.view().state).toBe('ACTIVE');
    const stopped = await say('stop live chat');
    expect(stopped?.ok).toBe(true);
    expect(r.controller.view().state).toBe('STOPPED');
    expect((await say('live chat status'))?.spoken).toBe('There is no live chat running.');
  });

  it('without a plugin permission it says why and does nothing', async () => {
    const r = rig({ permits: (p) => (p === 'chats.live' ? 'The WhatsApp plugin has not been given the permission "Live chat companion". Allow it on the Plugins page.' : null) });
    const cc = new ChatCommands({
      tools: { invoke: async () => ({ ok: false, summary: 'unused' }) },
      contacts: new ContactBook(db),
      policy: new CommunicationPolicy(() => ({ enabled: true, apps: {} })),
      session: new ChatSession(),
      confirmSends: 'unless_verified',
      fileRoute: 'chat',
      liveChat: r.controller,
      sleep: async () => undefined,
    });
    const out = await cc.tryHandle('start live chat with Rahul');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toMatch(/permission/);
    expect(r.chat.starts).toBe(0);
  });

});
