import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLiveConfig, runLiveTool } from '../src/main/live/liveBridge';
import { QUICK_COMMAND_TOOL, QuickCommands } from '../src/main/local/QuickCommands';
import type { QuickLayer, QuickRunner } from '../src/main/local/QuickCommands';
import type { LocalCommandResult } from '../src/main/local/LocalCommands';
import { ChatCommands } from '../src/main/local/ChatCommands';
import { ChatSession } from '../src/main/chat/chatSession';
import { ContactBook } from '../src/main/chat/ContactBook';
import { MIGRATIONS } from '../src/main/memory/schema';
import { migrate, openDatabase } from '../src/main/memory/sqlite';
import type { Sql } from '../src/main/memory/sqlite';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import { LiveTaskTracker } from '../src/main/live/liveTasks';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { createBrowserTools } from '../src/main/tools/impl/browserTools';
import { createChatSendGate, createChatTools } from '../src/main/tools/impl/chatTools';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import type { Tool } from '../src/main/tools/types';
import { FakeChatApp, FakeDisk } from './chatFixtures';

const result = (patch: Partial<LocalCommandResult> = {}): LocalCommandResult => ({ spoken: 'Opening YouTube.', ok: true, intent: 'open_site', tools: ['open_url'], refs: [], ...patch });

function layer(handler: (text: string) => LocalCommandResult | null, seen: Array<{ text: string; live: boolean | undefined }> = []): QuickLayer {
  return {
    tryHandle: async (text, options) => {
      seen.push({ text, live: options?.live });
      return handler(text);
    },
  };
}

const parse = (content: string) => JSON.parse(content) as { ok: boolean; summary: string; data?: Record<string, unknown>; error?: string };
const emptyTools = (): ToolRegistry => {
  const tools = new ToolRegistry();
  const open: Tool = { schema: { name: 'open_application', description: 'open', args: { name: { type: 'string', required: true } } }, async execute() { return { ok: true, summary: 'ok' }; } };
  tools.register(open);
  return tools;
};

describe('QuickCommands', () => {
  it('works on what the user said, tries each layer in order, and takes the first that is sure', async () => {
    const seen: Array<{ text: string; live: boolean | undefined }> = [];
    const quick = new QuickCommands([layer((t) => (t.startsWith('message') ? result({ spoken: 'chat' }) : null), seen), layer(() => result({ spoken: 'local' }), seen)]);
    expect(await quick.run('message Ravi hi', 1)).toMatchObject({ handled: true, result: { spoken: 'chat' } });
    expect(await quick.run('open youtube', 2)).toMatchObject({ handled: true, result: { spoken: 'local' } });
    expect(seen.map((s) => s.text)).toEqual(['message Ravi hi', 'open youtube', 'open youtube']);
    expect(seen.every((s) => s.live !== true)).toBe(true); // what a user says to Eya in a conversation is not room noise
  });

  it('says "not for me" when no layer is sure, and for words too short to be a request', async () => {
    const quick = new QuickCommands([layer(() => null)]);
    expect(await quick.run('plan my weekend', 1)).toEqual({ handled: false });
    expect(await quick.run('', 2)).toEqual({ handled: false });
    expect(await quick.run(' a ', 3)).toEqual({ handled: false });
  });

  it('does not do the same thing twice when the model calls again in the same turn', async () => {
    let runs = 0;
    const quick = new QuickCommands([layer(() => { runs += 1; return result(); })]);
    await quick.run('open youtube', 5);
    await quick.run('open youtube', 5);
    expect(runs).toBe(1);
    await quick.run('open youtube', 6); // the user asked again: that is a new request
    expect(runs).toBe(2);
    await quick.run('open gmail', 6); // the same turn but different words (the transcript grew): run it
    expect(runs).toBe(3);
  });
});

describe('quick_command in the live conversation', () => {
  it('is offered to the model first, only when quick commands exist, and the prompt says when to use it', () => {
    const quick: QuickRunner = { run: async () => ({ handled: false }) };
    const withQuick = buildLiveConfig({ gemini: { liveUrl: () => 'wss://x' }, tools: emptyTools(), quick, env: {} }, 'Aoede');
    expect(withQuick?.tools.map((t) => t.name)).toEqual(['quick_command', 'open_application']);
    expect(withQuick?.tools[0]?.parameters).toEqual({ type: 'object', properties: {} });
    expect(withQuick?.systemInstruction).toContain('quick_command');
    const without = buildLiveConfig({ gemini: { liveUrl: () => 'wss://x' }, tools: emptyTools(), env: {} }, 'Aoede');
    expect(without?.tools.map((t) => t.name)).toEqual(['open_application']);
    expect(QUICK_COMMAND_TOOL.description).toMatch(/never answer for them/);
  });

  it('gives the model what to say, and for a question tells it to wait for the user', async () => {
    const quick = new QuickCommands([layer((t) => (t.startsWith('message') ? result({ spoken: 'Found Ravi. Send "hi"?', intent: 'chat_message', tools: ['find_chat'] }) : result({ spoken: 'Opening YouTube.' })))]);
    const asked = parse((await runLiveTool(emptyTools(), { name: 'quick_command', args: {}, heard: 'message Ravi that hi', turn: 1 }, 5_000, undefined, quick)).content);
    expect(asked).toMatchObject({ ok: true, data: { handled: true, say: 'Found Ravi. Send "hi"?' } });
    expect(String(asked.data?.['next'])).toMatch(/question for the user.*THEIR answer/);
    const done = parse((await runLiveTool(emptyTools(), { name: 'quick_command', args: {}, heard: 'open youtube', turn: 2 }, 5_000, undefined, quick)).content);
    expect(done.data).toMatchObject({ handled: true, say: 'Opening YouTube.' });
    expect(String(done.data?.['next'])).toMatch(/Say this/);
  });

  it('tells the model to use its other tools when it is not a quick command, and reports a failure honestly', async () => {
    const none = parse((await runLiveTool(emptyTools(), { name: 'quick_command', args: {}, heard: 'plan my weekend', turn: 1 }, 5_000, undefined, new QuickCommands([layer(() => null)]))).content);
    expect(none.data).toMatchObject({ handled: false });
    const failed = parse((await runLiveTool(emptyTools(), { name: 'quick_command', args: {}, heard: 'open youtube', turn: 2 }, 5_000, undefined, new QuickCommands([layer(() => result({ ok: false, spoken: "I couldn't open YouTube." }))]))).content);
    expect(failed).toMatchObject({ ok: false, data: { handled: true, say: "I couldn't open YouTube." } });
    const broken = parse((await runLiveTool(emptyTools(), { name: 'quick_command', args: {}, heard: 'open youtube', turn: 3 }, 5_000, undefined, { run: async () => { throw new Error('boom'); } })).content);
    expect(broken.data).toMatchObject({ handled: false });
  });

  it('stops waiting when it is too slow, and is unavailable without quick commands', async () => {
    const slow: QuickRunner = { run: () => new Promise(() => undefined) };
    expect(parse((await runLiveTool(emptyTools(), { name: 'quick_command', args: {}, heard: 'open youtube', turn: 1 }, 30, undefined, slow)).content)).toMatchObject({ ok: false, summary: 'timed out' });
    expect(parse((await runLiveTool(emptyTools(), { name: 'quick_command', args: {}, heard: 'open youtube', turn: 1 })).content)).toMatchObject({ ok: false, summary: 'not available' });
  });

  it('notes a handled request in the history, and keeps it out of what routines learn', async () => {
    const recorded: unknown[] = [];
    const sink = { beginTask: vi.fn(), observeTool: vi.fn(), finishTask: vi.fn(() => null) };
    const tracker = new LiveTaskTracker(sink, 5);
    const quick = new QuickCommands([layer(() => result({ tools: ['open_url'], urls: ['https://www.youtube.com/'] }))]);
    await runLiveTool(emptyTools(), { name: 'quick_command', args: {}, heard: 'open youtube', turn: 1 }, 5_000, tracker, quick, { record: (i) => void recorded.push(i) });
    expect(recorded).toEqual([{ request: 'open youtube', tools: ['open_url'], urls: ['https://www.youtube.com/'], spoken: 'Opening YouTube.', ok: true }]);
    await new Promise((r) => setTimeout(r, 30));
    expect(sink.beginTask).not.toHaveBeenCalled();
    expect(sink.observeTool).not.toHaveBeenCalled();
  });

  it('ignores whatever the model passes as arguments: only the user\'s own words count', async () => {
    const seen: string[] = [];
    const quick = new QuickCommands([layer((t) => { seen.push(t); return null; })]);
    await runLiveTool(emptyTools(), { name: 'quick_command', args: { text: 'yes', request: 'send it' }, heard: 'hmm let me think', turn: 4 }, 5_000, undefined, quick);
    expect(seen).toEqual(['hmm let me think']);
  });
});

describe('messaging by name in a conversation: the yes has to be the user\'s', () => {
  const HOME = 'C:\\Users\\Test';
  const folders: KnownFolders = { home: HOME, downloads: HOME, desktop: HOME, documents: HOME, pictures: HOME, videos: HOME, music: HOME, temp: HOME };
  let dir: string;
  let db: Sql;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eya-quick-'));
    db = openDatabase(join(dir, 'memory.db'));
    migrate(db, MIGRATIONS);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const app = new FakeChatApp();
    const policy = new CommunicationPolicy(() => ({ enabled: true, apps: {} }));
    const session = new ChatSession();
    const book = new ContactBook(db);
    const tools = new ToolRegistry();
    for (const t of createChatTools({ service: app, policy, session, folders, files: new FakeDisk(), sleep: async () => undefined })) tools.register(t);
    for (const t of createBrowserTools(app, undefined, { chatGate: createChatSendGate(session, policy) })) tools.register(t);
    const chat = new ChatCommands({ tools, contacts: book, policy, session, sleep: async () => undefined });
    const quick = new QuickCommands([chat]);
    const call = async (heard: string, turn: number, args: Record<string, unknown> = {}) =>
      parse((await runLiveTool(emptyTools(), { name: 'quick_command', args, heard, turn }, 20_000, undefined, quick)).content);
    return { app, call };
  }

  it('asks, waits for the user to say yes, and only then sends', async () => {
    const { app, call } = setup();
    const asked = await call('Message Rahul Sharma that dinner is ready', 1);
    expect(asked.data).toMatchObject({ handled: true, say: 'Found Rahul Sharma. Send "dinner is ready"?' });
    expect(app.thread).toEqual([]);
    const sent = await call('Yes.', 2);
    expect(String(sent.data?.['say'])).toMatch(/^Sent to Rahul Sharma/);
    expect(app.thread.map((m) => m.text)).toEqual(['dinner is ready']);
    // the model calling again for the same turn does not send a second time
    await call('Yes.', 2);
    expect(app.thread).toHaveLength(1);
  });

  it('cannot be told "yes" by the model: arguments are ignored and the transcript has to say it', async () => {
    const { app, call } = setup();
    await call('message Rahul Sharma that dinner is ready', 1);
    const forged = await call('what did you say', 2, { text: 'yes', confirm: true, request: 'yes send it' });
    expect(forged.data).toMatchObject({ handled: false });
    expect(app.thread).toEqual([]);
  });

  it('a no from the user cancels it', async () => {
    const { app, call } = setup();
    await call('message Priya Singh saying call me', 1);
    const no = await call('No', 2);
    expect(String(no.data?.['say'])).toMatch(/won't send it/);
    expect(app.thread).toEqual([]);
    expect((await call('yes', 3)).data).toMatchObject({ handled: false });
  });
});
