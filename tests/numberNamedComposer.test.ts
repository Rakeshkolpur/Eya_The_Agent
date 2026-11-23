import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PageItem } from '../src/main/browser/BrowserAutomationService';
import type { PageSnapshot } from '../src/main/browser/pageSnapshot';
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
import { createChatSendGate, createChatTools, openChatIsWrong } from '../src/main/tools/impl/chatTools';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';
import { FakeChatApp, FakeDisk } from './chatFixtures';
import type { FakeChatRow } from './chatFixtures';

/**
 * A chat whose message box WhatsApp Web labels with the contact's PHONE NUMBER instead of the name ("Type a message to +1 (940) 290-7669"), found on the real
 * page for a chat called "Uber": the check "does the message box name the chat I clicked?" refused a right chat. The header's button named like the chat is
 * what settles it — and a message box that names another NAME is still a different chat.
 */

const HOME = 'C:\\Users\\Test';
const folders: KnownFolders = { home: HOME, downloads: `${HOME}\\Downloads`, desktop: `${HOME}\\Desktop`, documents: `${HOME}\\Documents`, pictures: `${HOME}\\Pictures`, videos: `${HOME}\\Videos`, music: `${HOME}\\Music`, temp: HOME };
const PEOPLE: readonly FakeChatRow[] = [
  { name: 'Uber', phone: '+1 940 290 7669', preview: 'a link' },
  { name: 'Priya', phone: '+91 99887 70432', preview: 'thanks' },
  { name: 'Ravi Kumar', phone: '+91 98765 00432', preview: 'ok' },
];
const NUMBER = '+1 (940) 290-7669';

/** The real page's way for such a chat: header has a button with the chat's name, headings do not, and the message box carries a number. */
class NumberNamedPage extends FakeChatApp {
  composerName: string = NUMBER;
  headerButton = true;
  constructor(rows: readonly FakeChatRow[] = PEOPLE) {
    super(rows);
    this.headerInHeadings = false;
  }
  override snapshot(): PageSnapshot {
    const s = super.snapshot();
    return { ...s, inputs: s.inputs.map((i) => (i === 'Type a message' ? `Type a message to ${this.composerName}` : i)) };
  }
  override async listItems(): Promise<PageItem[]> {
    const items = await super.listItems();
    return this.open !== null && this.headerButton ? [{ name: this.open.name, role: 'button', region: 'header' }, ...items] : items;
  }
}

let dir: string;
let db: Sql;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eya-numcomposer-'));
  db = openDatabase(join(dir, 'memory.db'));
  migrate(db, MIGRATIONS);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function rig(page: FakeChatApp) {
  const policy = new CommunicationPolicy(() => ({ enabled: true, apps: {} }));
  const session = new ChatSession();
  const tools = new ToolRegistry();
  for (const t of createChatTools({ service: page, policy, session, folders, files: new FakeDisk(), sleep: async () => undefined })) tools.register(t);
  for (const t of createBrowserTools(page, undefined, { chatGate: createChatSendGate(session, policy) })) tools.register(t);
  const chat = new ChatCommands({
    tools: { invoke: (name: string, args: ToolArgs): Promise<ToolResult> => tools.invoke(name, args) },
    contacts: new ContactBook(db),
    policy,
    session,
    confirmSends: 'unless_verified',
    fileRoute: 'chat',
    sleep: async () => undefined,
  });
  return { page, session, tools, chat, say: (text: string) => chat.tryHandle(text) };
}

describe('a message box that names the chat by its phone number', () => {
  it('is not a wrong chat when the page\'s header shows the chat chosen: the chat opens, as an exact name', async () => {
    const r = rig(new NumberNamedPage());
    const out = await r.tools.invoke('find_chat', { query: 'Uber' });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.data).toMatchObject({ status: 'opened', chat: 'Uber', verified: true, matchEvidence: 'exact name', headerChecked: true });
    expect(r.session.chat()).toMatchObject({ label: 'Uber', composerAs: NUMBER, headerChecked: true });
  });

  it('the whole request goes through: "send hi to Uber" is sent, once, to that chat', async () => {
    const r = rig(new NumberNamedPage());
    const out = await r.say('send hi to Uber on WhatsApp');
    expect(out?.spoken).toMatch(/^Sent to Uber\./);
    expect(r.page.thread.map((m) => m.text)).toEqual(['hi']);
  });

  it('with no header button naming the chat it is still refused, and says what the box named (the number hidden)', async () => {
    const page = new NumberNamedPage();
    page.headerButton = false;
    const r = rig(page);
    const out = await r.say('send hi to Uber on WhatsApp');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toMatch(/A different chat opened from the one I clicked \(WhatsApp's message box names it "\+1 ••••••7669"\), so nothing was typed or sent\./);
    expect(out?.spoken).not.toContain('940');
    expect(page.thread).toEqual([]);
    expect(page.draft).toBe('');
  });

  it('a message box that names another NAME is a different chat, whatever the header says', async () => {
    const page = new NumberNamedPage();
    page.composerName = 'Ravi Kumar';
    const r = rig(page);
    const out = await r.tools.invoke('find_chat', { query: 'Uber' });
    expect(out.ok).toBe(false);
    expect(out.data).toMatchObject({ status: 'wrong_chat', openedAs: 'Ravi Kumar' });
    expect(r.session.chat()).toBeNull();
  });

  it('a number that is not the chosen chat\'s own is not accepted: if the box then names ANOTHER number, the Send is refused', async () => {
    const page = new NumberNamedPage();
    const r = rig(page);
    await r.tools.invoke('find_chat', { query: 'Uber' });
    expect(openChatIsWrong(r.session, page.snapshot())).toBe(false);
    page.composerName = '+1 (415) 555-2671'; // the open chat has changed to someone else
    expect(openChatIsWrong(r.session, page.snapshot())).toBe(true);
    page.draft = 'hi';
    const send = await r.tools.invoke('click_on_page', { text: 'Send', confirm: true });
    expect(send.ok).toBe(false);
    expect(page.thread).toEqual([]);
  });

  it('a click the page would not take is said as that, not as "something went wrong in the browser"', async () => {
    const page = new FakeChatApp(PEOPLE);
    page.blockedClicks = 5;
    const r = rig(page);
    const out = await r.say('send hi to Uber on WhatsApp');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toMatch(/I found the chat, but couldn't open it \(the page wouldn't take the click\), so nothing was typed or sent\./);
    expect(out?.spoken).not.toMatch(/something went wrong in the browser/);
    expect(page.thread).toEqual([]);
  });
});
