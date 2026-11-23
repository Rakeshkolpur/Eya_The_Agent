import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import type { KnownFolders } from '../src/main/security/pathPolicy';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { createBrowserTools } from '../src/main/tools/impl/browserTools';
import { createChatSendGate, createChatTools } from '../src/main/tools/impl/chatTools';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';
import { FakeChatApp, FakeDisk } from './chatFixtures';
import type { FakeChatRow } from './chatFixtures';

/**
 * "WhatsApp is installed on this PC, but I can't type inside the installed app, so I'm using WhatsApp Web. (Give me the person's number instead…)" was said
 * in front of a send to a NUMBER, with a working browser: wrong on both counts (a number was given; and with a browser connected the installed program is not
 * used for a number either). It is said only when it is true and of use.
 */

const HOME = 'C:\\Users\\Test';
const folders: KnownFolders = { home: HOME, downloads: `${HOME}\\Downloads`, desktop: `${HOME}\\Desktop`, documents: `${HOME}\\Documents`, pictures: `${HOME}\\Pictures`, videos: `${HOME}\\Videos`, music: `${HOME}\\Music`, temp: HOME };
const PEOPLE: readonly FakeChatRow[] = [
  { name: 'Anna Reddy', phone: '+91 93611 13900', preview: 'see you' },
  { name: 'Priya Singh', phone: '+91 99887 70432', preview: 'thanks' },
];

let dir: string;
let db: Sql;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eya-appnote-'));
  db = openDatabase(join(dir, 'memory.db'));
  migrate(db, MIGRATIONS);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function rig(options: { browserReady?: boolean; linkWorks?: boolean } = {}) {
  const app = new FakeChatApp(PEOPLE);
  const policy = new CommunicationPolicy(() => ({ enabled: true, apps: {} }));
  const session = new ChatSession();
  const tools = new ToolRegistry();
  for (const t of createChatTools({ service: app, policy, session, folders, files: new FakeDisk(), sleep: async () => undefined })) tools.register(t);
  for (const t of createBrowserTools(app, undefined, { chatGate: createChatSendGate(session, policy) })) tools.register(t);
  const links: string[] = [];
  const chat = new ChatCommands({
    tools: { invoke: (name: string, args: ToolArgs): Promise<ToolResult> => tools.invoke(name, args) },
    contacts: new ContactBook(db),
    policy,
    session,
    confirmSends: 'unless_verified',
    fileRoute: 'chat',
    installedApp: (id) => id === 'whatsapp', // WhatsApp for Windows is installed on this PC
    openAppLink: async (url) => (links.push(url), options.linkWorks !== false),
    ...(options.browserReady !== undefined ? { browserReady: () => options.browserReady === true } : {}),
    sleep: async () => undefined,
  });
  return { app, links, say: (text: string) => chat.tryHandle(text) };
}

describe('the note about the installed WhatsApp program', () => {
  it('with a browser connected, a send to a NUMBER is just sent: no word about the installed app', async () => {
    const r = rig({ browserReady: true });
    const out = await r.say('send hello to 9361113900 on WhatsApp');
    expect(out?.spoken).toMatch(/^Sent to Anna Reddy\./);
    expect(out?.spoken).not.toMatch(/installed|WhatsApp Web\.|number instead/i);
    expect(r.links).toEqual([]); // the installed program was never opened
    expect(r.app.thread.map((m) => m.text)).toEqual(['hello']);
  });

  it('with a browser connected, a send to a NAME is also just sent: nothing to explain', async () => {
    const r = rig({ browserReady: true });
    const out = await r.say('send hello to Anna Reddy on WhatsApp');
    expect(out?.spoken).toMatch(/^Sent to Anna Reddy\./);
    expect(out?.spoken).not.toMatch(/installed/i);
  });

  it('a number is never told "give me a number", even when no browser is connected and the installed program would not open', async () => {
    const r = rig({ linkWorks: false }); // no browser dependency given: the web page is tried
    const out = await r.say('send hello to 9361113900 on WhatsApp');
    expect(out?.spoken).not.toMatch(/number instead of the name/i);
    expect(out?.spoken).not.toMatch(/installed on this PC/i);
  });

  it('with no browser connected and a NAME, it still says once why the web page is used (as it always did)', async () => {
    const r = rig({ browserReady: false });
    const first = await r.say('send hello to Anna Reddy on WhatsApp');
    expect(first?.spoken).toMatch(/^WhatsApp is installed on this PC, but I can't type inside the installed app, so I'm using WhatsApp Web\./);
    const again = await r.say('send hello there to Anna Reddy on WhatsApp');
    expect(again?.spoken).not.toMatch(/installed on this PC/);
  });
});
