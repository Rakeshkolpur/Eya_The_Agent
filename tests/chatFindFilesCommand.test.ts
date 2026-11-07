import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatSession } from '../src/main/chat/chatSession';
import { ContactBook } from '../src/main/chat/ContactBook';
import { ChatCommands } from '../src/main/local/ChatCommands';
import { parseChatIntent } from '../src/main/local/chatIntents';
import { MIGRATIONS } from '../src/main/memory/schema';
import { migrate, openDatabase } from '../src/main/memory/sqlite';
import type { Sql } from '../src/main/memory/sqlite';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { createChatTools } from '../src/main/tools/impl/chatTools';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';
import { FakeDisk } from './chatFixtures';
import { FakeMediaApp } from './chatMediaFixtures';

/**
 * "Check this file where it is in WhatsApp": said to Eya, it is understood without the model, the file is looked for in WhatsApp's own list of documents, and the
 * answer says where it is. Mock page only: these tests do not prove the real WhatsApp Web behaves so.
 */

const HOME = 'C:\\Users\\Test';
const folders: KnownFolders = { home: HOME, downloads: `${HOME}\\Downloads`, desktop: `${HOME}\\Desktop`, documents: `${HOME}\\Documents`, pictures: `${HOME}\\Pictures`, videos: `${HOME}\\Videos`, music: `${HOME}\\Music`, temp: HOME };
const NOW = new Date(2026, 9, 27, 12, 0, 0).getTime();

let dir: string;
let db: Sql;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eya-findfiles-'));
  db = openDatabase(join(dir, 'memory.db'));
  migrate(db, MIGRATIONS);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function rig(options: { last?: { path: string; name: string } | null; chatsOn?: boolean; blockedReason?: string } = {}) {
  const app = new FakeMediaApp();
  const policy = new CommunicationPolicy(() => ({ enabled: options.chatsOn !== false, apps: {} }));
  const session = new ChatSession();
  const tools = new ToolRegistry();
  for (const t of createChatTools({ service: app, policy, session, folders, files: new FakeDisk(), sleep: async () => undefined, now: () => NOW })) tools.register(t);
  if (options.blockedReason !== undefined) {
    const reason = options.blockedReason;
    tools.setGuard({ blocked: (name) => (name === 'find_chat_files' ? { plugin: 'whatsapp', reason } : null) });
  }
  const called: ToolArgs[] = [];
  const chat = new ChatCommands({
    tools: {
      invoke: (name: string, args: ToolArgs): Promise<ToolResult> => {
        if (name === 'find_chat_files') called.push(args);
        return tools.invoke(name, args);
      },
    },
    contacts: new ContactBook(db),
    policy,
    session,
    confirmSends: 'unless_verified',
    fileRoute: 'chat',
    ...(options.last !== undefined ? { lastFile: () => options.last ?? null } : {}),
    sleep: async () => undefined,
    now: () => NOW,
  });
  return { app, called, say: (text: string) => chat.tryHandle(text) };
}

describe('finding a file in the chats, said to Eya', () => {
  it('"check this file where it is in WhatsApp" looks for the file just talked about and says its chat', async () => {
    const r = rig({ last: { path: 'C:\\Users\\Test\\Documents\\Resume Rakesh.pdf', name: 'Resume Rakesh.pdf' } });
    const out = await r.say('check this file where it is in whatsapp');
    expect(out?.intent).toBe('chat_files');
    expect(out?.ok).toBe(true);
    expect(out?.spoken).toBe('“Resume Rakesh.pdf” (PDF, 3 MB) — you sent it Thursday, in your chat with Anna Reddy. I have opened that chat on the file.');
    expect(r.called).toEqual([{ file: 'Resume Rakesh.pdf', direction: 'any' }]);
    expect(r.app.pressed).toEqual(['Go to message']); // nothing was sent, forwarded, starred or deleted
  });

  it('with no file in view it asks which, and touches nothing', async () => {
    const r = rig({ last: null });
    const out = await r.say('check this file where it is in whatsapp');
    expect(out?.spoken).toMatch(/^Which file do you mean\?/);
    expect(r.app.calls.filter((c) => c.startsWith('click:'))).toEqual([]);
  });

  it('"find the resume pdf I sent last week on WhatsApp"', async () => {
    const r = rig();
    const out = await r.say('find the resume pdf I sent last week on WhatsApp');
    expect(r.called).toEqual([{ file: 'resume pdf', when: 'last week', direction: 'sent' }]);
    expect(out?.spoken).toMatch(/^“Resume Rakesh\.pdf”.*in your chat with Anna Reddy/);
  });

  it('when the chat found is not the one the person said, it says so', async () => {
    const r = rig();
    const out = await r.say('which chat did I send the resume pdf to Priya in whatsapp');
    expect(out?.spoken).toMatch(/You said it went to Priya; the chat I found is Anna Reddy\.$/);
  });

  it('a file that was received is not "a file I sent"', async () => {
    const r = rig();
    const out = await r.say('where is the bail petition file i sent last week in whatsapp');
    expect(out?.spoken).toMatch(/^I did not find a file like “bail petition”/);
  });

  it('a sending request is never taken for this, nor a search for a file on this PC', () => {
    expect(parseChatIntent('send the resume pdf to Anna on whatsapp')?.kind).toBe('send_file');
    expect(parseChatIntent('find the resume pdf and send it to Anna on whatsapp')?.kind).not.toBe('find_files');
    expect(parseChatIntent('where is my resume file')).toBeNull();
    expect(parseChatIntent('open Anna chat on whatsapp')?.kind).toBe('open_chat');
  });

  it('with Chats off it says so and looks at nothing', async () => {
    const r = rig({ chatsOn: false });
    const out = await r.say('find the resume pdf I sent last week on WhatsApp');
    expect(out?.spoken).toMatch(/^Chats are off for WhatsApp/);
    expect(r.called).toEqual([]);
  });

  it('with the plugin not allowed to find files, it says why (the plugin’s own words) and does nothing', async () => {
    const reason = 'The WhatsApp plugin has not been given the permission "Find files in chats". Allow it on the Plugins page.';
    const r = rig({ blockedReason: reason });
    const out = await r.say('find the resume pdf I sent last week on WhatsApp');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toBe(reason);
    expect(r.app.calls.filter((c) => c.startsWith('click:'))).toEqual([]);
  });

  it('a log-in screen is said, not "no file"', async () => {
    const r = rig();
    r.app.loginScreen = true;
    const out = await r.say('find the resume pdf I sent last week on WhatsApp');
    expect(out?.spoken).toMatch(/asking you to log in/);
  });
});
