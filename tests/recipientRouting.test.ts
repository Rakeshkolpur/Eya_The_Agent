import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PageItem } from '../src/main/browser/BrowserAutomationService';
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
import { createBrowserTools } from '../src/main/tools/impl/browserTools';
import { createChatSendGate, createChatTools } from '../src/main/tools/impl/chatTools';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';
import { FakeChatApp, FakeDisk } from './chatFixtures';
import type { FakeChatRow } from './chatFixtures';
import { FakeWhatsAppWeb } from './chatPickerFixtures';
import type { PickerContact } from './chatPickerFixtures';

/**
 * Who a message or a file is for, when the person says a PHONE NUMBER (whole, without its country code, spaces and hyphens, the end of it, read out loud), "him",
 * or "the person I messaged yesterday": through the real parser, ChatCommands, the chat tools and the recipient resolver, against mocks of the chat page. Nothing
 * here is evidence about the real WhatsApp Web: it shows that Eya sends only when the recipient is identified, keeps the message exactly, and never repeats a send.
 */

const HOME = 'C:\\Users\\Test';
const folders: KnownFolders = { home: HOME, downloads: `${HOME}\\Downloads`, desktop: `${HOME}\\Desktop`, documents: `${HOME}\\Documents`, pictures: `${HOME}\\Pictures`, videos: `${HOME}\\Videos`, music: `${HOME}\\Music`, temp: HOME };
const PDF = `${HOME}\\Desktop\\report.pdf`;

const PEOPLE: readonly FakeChatRow[] = [
  { name: 'Anna Reddy', phone: '+91 93611 13900', preview: 'see you' }, // saved: the list shows the name, never the number
  { name: 'Ravi Kumar', phone: '+91 98765 00432', preview: 'ok' },
  { name: '+91 70211 13900', phone: '+91 70211 13900', preview: 'hello' }, // not saved: the list shows its number
  { name: 'Priya', phone: '+91 99887 70432', preview: 'thanks' },
  { name: 'Anna Kumar', phone: '+91 80000 11111', preview: 'ok' },
];

let dir: string;
let db: Sql;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eya-recipient-'));
  db = openDatabase(join(dir, 'memory.db'));
  migrate(db, MIGRATIONS);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The chat app's list as a real page has it: the app's own buttons are in its top bar, among what the page offers to click. */
class PageWithOwnButtons extends FakeChatApp {
  override async listItems(): Promise<PageItem[]> {
    const items = await super.listItems();
    return [{ name: 'Meta AI', role: 'button', region: 'header' }, { name: 'Go to Calls', role: 'button', region: 'header' }, { name: 'Invite a friend', role: 'button' }, { name: 'Privacy Checkup', role: 'button', region: 'header' }, { name: 'Download the app', role: 'button' }, { name: 'You', role: 'button' }, ...items];
  }
}

interface Rig {
  readonly app: FakeChatApp;
  readonly book: ContactBook;
  readonly chat: ChatCommands;
  readonly session: ChatSession;
  readonly invoked: string[];
  readonly state: { clock: number; country: string | undefined };
}

function rig(opts: { rows?: readonly FakeChatRow[]; learning?: 'on' | 'off'; confirm?: 'always' | 'unless_verified'; country?: string; page?: FakeChatApp } = {}): Rig {
  const app = opts.page ?? new FakeChatApp(opts.rows ?? PEOPLE);
  const state = { clock: new Date('2026-10-26T15:00:00').getTime(), country: opts.country as string | undefined };
  const policy = new CommunicationPolicy(() => ({ enabled: true, apps: {} }));
  const session = new ChatSession(() => state.clock);
  const book = new ContactBook(db, () => new Date(state.clock).toISOString());
  if (opts.learning !== undefined) book.setLearning(opts.learning);
  const tools = new ToolRegistry();
  const names = { learn: (a: string, l: readonly string[]) => book.learn(a, l), used: (a: string, l: string) => book.used(a, l), learning: () => book.learning() === 'on' };
  const disk = new FakeDisk({ [PDF]: { isFile: true, isDirectory: false, size: 10, content: Buffer.from('0123456789') } });
  const country = (): string | undefined => state.country;
  for (const t of createChatTools({ service: app, policy, session, folders, files: disk, sleep: async () => undefined, names, country })) tools.register(t);
  for (const t of createBrowserTools(app, undefined, { chatGate: createChatSendGate(session, policy) })) tools.register(t);
  const invoked: string[] = [];
  const chat = new ChatCommands({
    tools: {
      invoke: async (name: string, args: ToolArgs): Promise<ToolResult> => {
        invoked.push(name);
        return tools.invoke(name, args);
      },
    },
    contacts: book,
    policy,
    session,
    files: { locate: async () => ({ kind: 'one', path: PDF, name: 'report.pdf' }) },
    confirmSends: opts.confirm ?? 'unless_verified',
    fileRoute: 'chat',
    country,
    now: () => state.clock,
    sleep: async () => undefined,
  });
  return { app, book, chat, session, invoked, state };
}

const say = (r: Rig, text: string) => r.chat.tryHandle(text);
const typedInSearch = (r: Rig): string[] => r.app.calls.filter((c) => c.startsWith('fill:Search')).map((c) => c.replace(/^fill:Search or start new chat=/, ''));

// ------------------------------------------------------------------------------------------------------------------ the tool: find_chat
describe('find_chat with a phone number', () => {
  function tool(opts: { page?: FakeChatApp; rows?: readonly FakeChatRow[]; country?: string } = {}) {
    const app = opts.page ?? new FakeChatApp(opts.rows ?? PEOPLE);
    const session = new ChatSession();
    const policy = new CommunicationPolicy(() => ({ enabled: true, apps: {} }));
    const tools: Tool[] = createChatTools({ service: app, policy, session, folders, files: new FakeDisk(), sleep: async () => undefined, ...(opts.country !== undefined ? { country: () => opts.country } : {}) });
    const find = (args: ToolArgs): Promise<ToolResult> => (tools.find((t) => t.schema.name === 'find_chat') as Tool).execute(args);
    return { app, session, find };
  }

  it.each(['+91 9361113900', '+91-93611-13900', '9361113900', '09361113900', '93611 13900', '(936) 111-3900', '919361113900'])('the whole number "%s" opens the chat the app finds for it, as an identity', async (said) => {
    const t = tool();
    const out = await t.find({ query: said });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.data).toMatchObject({ status: 'opened', chat: 'Anna Reddy', verified: true, matchEvidence: 'full phone number', headerChecked: true });
    // what was typed into the app's search is the number's own digits: never a country code that was not said
    expect(t.app.search).toBe(''); // (opening the chat clears the search)
    expect(t.app.calls.filter((c) => c.startsWith('fill:')).some((c) => /=9361113900$/.test(c))).toBe(true);
  });

  it('the end of a number opens nothing on its own when several chats have it: it asks, with the numbers hidden', async () => {
    const t = tool();
    const out = await t.find({ query: 'ending 3900' });
    expect(out.data?.['status']).toBe('ambiguous');
    const labels = (out.data?.['candidates'] as Array<{ label: string; masked?: string }>).map((c) => c.label).sort();
    expect(labels).toEqual(['+91 ••••••3900', 'Anna Reddy']); // (the chat listed under its number is handed back with the number hidden)
    expect(t.app.open).toBeNull();
    expect(JSON.stringify(out.data?.['candidates'])).not.toMatch(/70211/);
  });

  it('the last digits, said as "the last 4 digits 3900", are 3900 — the 4 is a count, not a digit', async () => {
    const t = tool();
    await t.find({ query: 'the last 4 digits 3900' });
    expect(t.app.calls.filter((c) => c.startsWith('fill:'))[0]).toContain('=3900');
  });

  it('a chat listed under its number is an exact match for that number, and a part of it only a likely one', async () => {
    const whole = tool();
    const exact = await whole.find({ query: '70211 13900' });
    expect(exact.data).toMatchObject({ status: 'opened', chat: '+91 70211 13900', verified: true });
    const part = tool({ rows: [PEOPLE[2] as FakeChatRow, PEOPLE[1] as FakeChatRow] });
    const likely = await part.find({ query: 'ending 211 13900' });
    expect(likely.data).toMatchObject({ status: 'opened', chat: '+91 70211 13900', verified: true, matchEvidence: 'end of the number' });
    const short = tool({ rows: [PEOPLE[2] as FakeChatRow, PEOPLE[1] as FakeChatRow] });
    const four = await short.find({ query: 'ending 3900' });
    expect(four.data).toMatchObject({ status: 'opened', chat: '+91 70211 13900', verified: false, matchEvidence: 'part of the number' });
  });

  it('a saved contact found for only the end of a number is a likely match: never an identity', async () => {
    const t = tool();
    const out = await t.find({ query: 'ending 500432' });
    expect(out.data).toMatchObject({ status: 'opened', chat: 'Ravi Kumar', verified: false, matchEvidence: 'part of the number' });
  });

  it('a number nobody has: says so, opens nothing, and the answer shows the number only hidden', async () => {
    const t = tool();
    const out = await t.find({ query: '+91 9361199999' });
    expect(out.ok).toBe(true);
    expect(out.data?.['status']).toBe('none');
    expect(String(out.data?.['say'])).toContain('••');
    expect(JSON.stringify(out.data)).not.toMatch(/9361199999/);
    expect(t.app.open).toBeNull();
    // the number was looked for as its national digits and then once more with its country code
    const typed = t.app.calls.filter((c) => c.startsWith('fill:')).map((c) => c.split('=')[1]);
    expect(typed).toContain('9361199999');
    expect(typed).toContain('919361199999');
  });

  it('digits that are not a valid number are searched as they are, never given a country code, and are said to be unreadable if nobody shows them', async () => {
    const t = tool();
    const out = await t.find({ query: '5361113900' });
    expect(out.data?.['status']).toBe('none');
    expect(out.data?.['unreadable']).toBe(true);
    expect(String(out.data?.['say'])).toMatch(/phone number/);
    const typed = t.app.calls.filter((c) => c.startsWith('fill:')).map((c) => c.split('=')[1]);
    expect(typed).toEqual(['5361113900']);
    expect(typed.join(' ')).not.toContain('915361113900');
    expect(t.app.open).toBeNull();
  });

  it('the same digits under another country code are a different person until the person says so', async () => {
    const t = tool({ rows: [{ name: '+1 936 111 3900', phone: '+1 936 111 3900', preview: 'hi' }] });
    const out = await t.find({ query: '9361113900' });
    expect(out.data).toMatchObject({ status: 'opened', verified: false, matchEvidence: 'same digits, different country code' });
    // with the country code SAID, a number of another country is simply not that number
    const said = tool({ rows: [{ name: '+1 936 111 3900', phone: '+1 936 111 3900', preview: 'hi' }] });
    const none = await said.find({ query: '+91 9361113900' });
    expect(none.data?.['status']).toBe('none');
    expect(said.app.open).toBeNull();
  });

  it('is read against the configured country: the same digits are an American number for an American', async () => {
    const rows: readonly FakeChatRow[] = [{ name: '+1 415 555 2671', phone: '+1 415 555 2671', preview: 'hi' }];
    const us = tool({ rows, country: 'US' });
    const out = await us.find({ query: '(415) 555-2671' });
    expect(out.data).toMatchObject({ status: 'opened', chat: '+1 415 555 2671', verified: true, matchEvidence: 'full phone number' });
    // a person in India saying the same digits meant an Indian number: the American chat is not settled on
    const india = tool({ rows });
    const asked = await india.find({ query: '(415) 555-2671' });
    expect(asked.data).toMatchObject({ status: 'opened', verified: false });
  });

  it('the app\'s own buttons are never taken for the person a number belongs to', async () => {
    const t = tool({ page: new PageWithOwnButtons(PEOPLE) });
    const none = await t.find({ query: 'ending 4444' });
    expect(none.data?.['status']).toBe('none');
    expect(JSON.stringify(none)).not.toMatch(/Meta AI|Go to Calls|Invite a friend|Privacy Checkup|Download the app/);
    const found = await tool({ page: new PageWithOwnButtons(PEOPLE) }).find({ query: '+91 9361113900' });
    expect(found.data).toMatchObject({ status: 'opened', chat: 'Anna Reddy' });
  });

  it('the "You" button of the left rail (the profile) is a control, not a chat: found on the real WhatsApp Web, where it was clicked as if it were one', async () => {
    const t = tool({ page: new PageWithOwnButtons(PEOPLE) });
    const out = await t.find({ query: 'You' });
    expect(out.data?.['status']).toBe('none');
    expect(out.ok).toBe(true);
    expect(t.app.open).toBeNull();
    expect(t.app.calls.some((c) => c.startsWith('clickItem:You') || c === 'click:You')).toBe(false);
  });

  it('a name is still a name: nothing about numbers changes how a name is looked for', async () => {
    const t = tool();
    const out = await t.find({ query: 'Priya' });
    expect(out.data).toMatchObject({ status: 'opened', chat: 'Priya', verified: true, matchEvidence: 'exact name' });
  });
});

// ------------------------------------------------------------------------------------------------------------------ the request, start to end
describe('"send … to <number>": from what was said to a send that is checked', () => {
  const MESSAGE = "Don't wait — I'm running 5 min LATE!";

  it.each([
    ['full international', `send ${MESSAGE} to +91 9361113900 on WhatsApp`],
    ['international with hyphens', `send ${MESSAGE} to +91-93611-13900 on WhatsApp`],
    ['national, no country code', `send ${MESSAGE} to 9361113900 on WhatsApp`],
    ['national with spaces', `send ${MESSAGE} to 93611 13900 on WhatsApp`],
    ['with a leading zero', `send ${MESSAGE} to 09361113900 on WhatsApp`],
    ['read out loud', `send ${MESSAGE} to nine three six triple one three nine double zero on WhatsApp`],
    ['read out with a spoken plus', `send ${MESSAGE} to plus nine one nine three six one one one three nine zero zero on WhatsApp`],
    ['in Telugu digits', `send ${MESSAGE} to ౯౩౬౧౧౧౩౯౦౦ on WhatsApp`],
  ])('%s: sent to that person once, the message exactly as said', async (_what, request) => {
    const r = rig();
    const out = await say(r, request);
    expect(out?.ok, out?.spoken).toBe(true);
    expect(out?.spoken).toMatch(/^Sent to Anna Reddy\./);
    expect(r.app.thread.map((m) => m.text)).toEqual([MESSAGE]);
    expect(r.app.open?.name).toBe('Anna Reddy');
  });

  it('"message <number> <text>": where the number ends and the message begins is read, and the message keeps its own spacing and case', async () => {
    const r = rig();
    const out = await say(r, 'message 93611 13900 See  you   at 5 PM sharp on WhatsApp');
    expect(out?.spoken).toMatch(/^Sent to Anna Reddy\./);
    expect(r.app.thread.map((m) => m.text)).toEqual(['See  you   at 5 PM sharp']);
    const spoken = await say(rig(), 'message nine three six triple one three nine double zero See you at 5 on WhatsApp');
    expect(spoken?.spoken).toMatch(/^Sent to Anna Reddy\./);
  });

  it('a spoken number inside the MESSAGE is left as it was said', async () => {
    const r = rig();
    await say(r, 'send call me on one two three four five six seven to 9361113900 on WhatsApp');
    expect(r.app.thread.map((m) => m.text)).toEqual(['call me on one two three four five six seven']);
  });

  it('a chat listed under its number is that person: sent without asking', async () => {
    const r = rig();
    const out = await say(r, 'send hello to 70211 13900 on WhatsApp');
    expect(out?.spoken).toMatch(/^Sent to \+91 70211 13900\./);
    expect(r.app.thread.map((m) => m.text)).toEqual(['hello']);
  });

  it('the end of a number is NOT enough to send: a chat is found, said, and asked about — nothing goes until the yes', async () => {
    const r = rig();
    const out = await say(r, 'send hello to the number ending 500432 on WhatsApp');
    expect(out?.spoken).toMatch(/^Found Ravi Kumar/);
    expect(out?.spoken).toContain('matched only on part of the number');
    expect(out?.spoken).toContain('Send "hello"?');
    expect(r.app.thread).toEqual([]);
    expect(r.app.draft).toBe('hello'); // typed in the box, not sent
    const yes = await say(r, 'yes');
    expect(yes?.spoken).toMatch(/^Sent to Ravi Kumar/);
    expect(r.app.thread.map((m) => m.text)).toEqual(['hello']);
  });

  it('two chats with the same ending: asks which (names, numbers hidden), sends nothing, and the answer decides', async () => {
    const r = rig();
    const asked = await say(r, 'send hello to the number ending 3900 on WhatsApp');
    expect(asked?.spoken).toMatch(/^Which one: /);
    expect(asked?.spoken).toContain('Anna Reddy');
    expect(asked?.spoken).toContain('••');
    expect(asked?.spoken).not.toMatch(/70211|93611/); // no whole number is ever read out
    expect(r.app.thread).toEqual([]);
    expect(r.app.open).toBeNull();
    const picked = await say(r, 'Anna Reddy');
    expect(picked?.spoken, picked?.spoken).toMatch(/Sent to Anna Reddy/);
    expect(r.app.thread.map((m) => m.text)).toEqual(['hello']);
  });

  it('duplicate endings both shown on their chats: the same — asks, hides the numbers, sends nothing', async () => {
    const r = rig({ rows: [{ name: '+91 93611 13900', phone: '+91 93611 13900', preview: 'a' }, { name: '+91 70211 13900', phone: '+91 70211 13900', preview: 'b' }] });
    const asked = await say(r, 'send hello to the number ending 113900 on WhatsApp');
    expect(asked?.spoken).toMatch(/^Which one: /);
    expect(asked?.spoken).not.toMatch(/9361|70211/);
    expect(asked?.spoken.match(/•{2,}/g)?.length).toBe(2);
    expect(r.app.thread).toEqual([]);
  });

  it('a number nobody has: nothing is sent, and what is missing is said', async () => {
    const r = rig();
    const out = await say(r, 'send hello to +91 9361199999 on WhatsApp');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toMatch(/couldn't find a chat with/);
    expect(out?.spoken).not.toContain('9361199999');
    expect(r.app.thread).toEqual([]);
    expect(r.app.draft).toBe('');
  });

  it('digits that are not a number: no country code is added, nothing is sent, and the person is asked once', async () => {
    const r = rig();
    const out = await say(r, 'send hello to 5361113900 on WhatsApp');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toMatch(/phone number/);
    expect(r.app.thread).toEqual([]);
    expect(r.app.calls.some((c) => c.includes('915361113900'))).toBe(false);
  });

  it('a number with too many digits is refused before anything is touched', async () => {
    const r = rig();
    const out = await say(r, 'send hello to 1234567890123456789 on WhatsApp');
    expect(out?.spoken).toMatch(/more digits than a phone number/);
    expect(r.invoked).toEqual([]);
  });

  it('the same digits under another country code are said back and asked about, never sent on', async () => {
    const r = rig({ rows: [{ name: '+1 936 111 3900', phone: '+1 936 111 3900', preview: 'hi' }] });
    const out = await say(r, 'send hello to 9361113900 on WhatsApp');
    expect(out?.spoken).toContain('different country code');
    expect(r.app.thread).toEqual([]);
  });

  it('a country that is not India changes how the same digits are read', async () => {
    const rows: readonly FakeChatRow[] = [{ name: '+1 415 555 2671', phone: '+1 415 555 2671', preview: 'hi' }];
    const us = rig({ rows, country: 'US' });
    const sent = await say(us, 'send hello to (415) 555-2671 on WhatsApp');
    expect(sent?.spoken).toMatch(/^Sent to \+1 415 555 2671\./);
    const india = rig({ rows });
    const asked = await say(india, 'send hello to (415) 555-2671 on WhatsApp');
    expect(asked?.spoken).toContain('different country code');
    expect(india.app.thread).toEqual([]);
  });

  it('a request said again is not sent again: it is said to be a repeat and asked about, and "ok" after a send does nothing', async () => {
    const r = rig({ learning: 'off' }); // (so that no question about remembering names is waiting for a "yes")
    const first = await say(r, 'send hello to 9361113900 on WhatsApp');
    expect(first?.spoken).toMatch(/^Sent to Anna Reddy\./);
    const again = await say(r, 'send hello to 9361113900 on WhatsApp');
    expect(again?.spoken).toContain('already sent this message');
    expect(r.app.thread).toHaveLength(1);
    expect((await say(r, 'no'))?.spoken).toMatch(/won't send it/); // (the question about the repeat is answered no)
    expect(await say(r, 'ok')).toBeNull(); // and an "ok" after a finished send is not a request to send again
    expect(r.app.thread).toHaveLength(1);
  });

  it('a send that could not be seen is looked at, not repeated, when the same thing is asked for again', async () => {
    const r = rig();
    r.app.behaviour = 'no_marks';
    const first = await say(r, 'send hello to 9361113900 on WhatsApp');
    expect(first?.ok).toBe(false); // pressed, but the app showed no result
    r.app.behaviour = 'normal';
    const again = await say(r, 'send hello to 9361113900 on WhatsApp');
    expect(r.app.thread.filter((m) => m.text === 'hello')).toHaveLength(1);
    expect(again?.spoken).toMatch(/already in the chat|did not send it again|already sent|Send "hello"\?/);
  });

  it('never keeps a phone number, or the end of one, as a name for a chat', async () => {
    const r = rig({ learning: 'on' });
    await say(r, 'send hello to 9361113900 on WhatsApp');
    expect(r.book.list('whatsapp').flatMap((c) => c.aliases)).toEqual([]);
    expect(r.book.list('whatsapp').map((c) => c.name).join(' ')).not.toMatch(/\d{5}/);
    const ending = rig({ learning: 'on' });
    await say(ending, 'send hello to the number ending 1111 on WhatsApp');
    await say(ending, 'yes');
    expect(ending.app.thread.map((m) => m.text)).toEqual(['hello']); // (it was sent, to the one chat the app found for those digits)
    expect(ending.app.open?.name).toBe('Anna Kumar');
    // four digits are short enough to look like a name to the name-keeper: they must still never become what the chat is called
    expect(ending.book.list('whatsapp').flatMap((c) => c.aliases)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------ references to the conversation
describe('"him", "the last person", "the person I messaged yesterday"', () => {
  it('"him" with nobody in the conversation is left to the AI, which has the whole talk', async () => {
    const r = rig();
    expect(await say(r, 'send hello to him on WhatsApp')).toBeNull();
    expect(await say(r, 'tell him I am late')).toBeNull();
    expect(r.app.calls).toEqual([]);
  });

  it('"him" after one chat in this conversation: said back, and only a yes sends it — to that chat, the message exactly as said', async () => {
    const r = rig();
    await say(r, "open Ravi Kumar's chat on WhatsApp");
    r.app.search = '';
    r.state.clock += 5 * 60_000;
    const asked = await say(r, "send I'll be there by 6 to him on WhatsApp");
    expect(asked?.spoken).toContain('By "him" do you mean Ravi Kumar?');
    expect(r.app.thread).toEqual([]);
    const yes = await say(r, 'yes');
    expect(yes?.spoken).toMatch(/^Sent to Ravi Kumar\./);
    expect(r.app.thread.map((m) => m.text)).toEqual(["I'll be there by 6"]);
  });

  it('"him" and then a no: nothing is sent, and the person is asked once for a name or number', async () => {
    const r = rig();
    await say(r, "open Ravi Kumar's chat on WhatsApp");
    await say(r, 'send hello to him on WhatsApp');
    const no = await say(r, 'no');
    expect(no?.spoken).toMatch(/Who should I send it to\?/);
    expect(r.app.thread).toEqual([]);
  });

  it('"tell him …" is read as a message to him, and what follows is the message', async () => {
    const intent = parseChatIntent("tell him I'm late");
    expect(intent).toMatchObject({ kind: 'message', name: 'him', text: "I'm late" });
    const r = rig();
    await say(r, "open Ravi Kumar's chat on WhatsApp");
    const asked = await say(r, "tell him I'm late");
    expect(asked?.spoken).toContain('do you mean Ravi Kumar?');
    expect(r.app.thread).toEqual([]);
  });

  it('with two chats in the conversation, "him" asks which one — it never picks', async () => {
    const r = rig();
    await say(r, "open Ravi Kumar's chat on WhatsApp");
    await say(r, "open Priya's chat on WhatsApp");
    const asked = await say(r, 'send hello to her on WhatsApp');
    expect(asked?.spoken).toMatch(/^Which one: /);
    expect(asked?.spoken).toContain('Ravi Kumar');
    expect(asked?.spoken).toContain('Priya');
    expect(r.app.thread).toEqual([]);
    const picked = await say(r, 'Priya');
    expect(picked?.spoken).toMatch(/^Sent to Priya\./);
    expect(r.app.thread.map((m) => m.text)).toEqual(['hello']);
  });

  it('"him" long after the conversation moved on is nobody in particular: left to the AI', async () => {
    const r = rig();
    await say(r, "open Ravi Kumar's chat on WhatsApp");
    r.state.clock += 3 * 60 * 60_000;
    expect(await say(r, 'send hello to him on WhatsApp')).toBeNull();
  });

  it('"the person I messaged yesterday" is found from the saved history by when it was used, said back, and only a yes sends', async () => {
    const r = rig({ learning: 'on' });
    const today = r.state.clock;
    r.state.clock = new Date('2026-10-25T18:00:00').getTime();
    r.book.used('whatsapp', 'Priya');
    r.state.clock = new Date('2026-10-24T10:00:00').getTime();
    r.book.used('whatsapp', 'Ravi Kumar');
    r.state.clock = today;
    const asked = await say(r, 'send see you soon to the same person I messaged yesterday on WhatsApp');
    expect(asked?.spoken).toContain('do you mean Priya?');
    expect(r.app.thread).toEqual([]);
    const yes = await say(r, 'yes');
    expect(yes?.spoken).toMatch(/^Sent to Priya\./);
    expect(r.app.thread.map((m) => m.text)).toEqual(['see you soon']);
  });

  it('"the person I messaged yesterday" with nobody known from yesterday: one focused question, nothing sent', async () => {
    const r = rig({ learning: 'on' });
    r.book.used('whatsapp', 'Priya'); // used today, not yesterday
    const out = await say(r, 'send hello to the person I messaged yesterday on WhatsApp');
    expect(out?.spoken).toMatch(/I don't know who you mean/);
    expect(out?.spoken).toMatch(/Who should I send it to\?/);
    expect(r.app.thread).toEqual([]);
    expect(r.app.calls).toEqual([]);
  });

  it('with the history off nothing is kept to look back on, and it says so by asking', async () => {
    const r = rig({ learning: 'off' });
    r.book.used('whatsapp', 'Priya');
    const out = await say(r, 'send hello to the last person I messaged on WhatsApp');
    expect(out?.spoken).toMatch(/Who should I send it to\?/);
  });

  it('a pronoun or a phrase is never kept as a name for a chat', async () => {
    const r = rig({ learning: 'on' });
    await say(r, "open Ravi Kumar's chat on WhatsApp");
    await say(r, 'send hello to him on WhatsApp');
    await say(r, 'yes');
    expect(r.book.resolve('whatsapp', 'him').kind).toBe('none');
    expect(r.book.list('whatsapp').flatMap((c) => c.aliases)).toEqual([]);
  });

  it('a name with several matches is asked about (as before), and nothing is sent', async () => {
    const r = rig();
    const asked = await say(r, 'send hello to Anna on WhatsApp');
    expect(asked?.spoken).toMatch(/^Which one: /);
    expect(r.app.thread).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------ files, through "Select chats"
describe('a file to a phone number, through "Select chats"', () => {
  const CONTACTS: readonly PickerContact[] = [
    { name: 'Anna Reddy', phone: '+91 93611 13900' },
    { name: 'Ravi Kumar', phone: '+91 98765 00432' },
    { name: '+91 70211 13900', phone: '+91 70211 13900' },
  ];

  function share(contacts: readonly PickerContact[] = CONTACTS) {
    const app = new FakeWhatsAppWeb(contacts);
    const policy = new CommunicationPolicy(() => ({ enabled: true, apps: {} }));
    const session = new ChatSession();
    const disk = new FakeDisk({ [PDF]: { isFile: true, isDirectory: false, size: 10, content: Buffer.from('0123456789') } });
    const tools: Tool[] = createChatTools({ service: app, policy, session, folders, files: disk, sleep: async () => undefined });
    const run = (args: ToolArgs): Promise<ToolResult> => (tools.find((t) => t.schema.name === 'share_file_to_chat') as Tool).execute({ path: PDF, ...args });
    return { app, run };
  }

  it('a whole number, asked for in so many words, goes straight to the one person the picker found for it', async () => {
    const r = share();
    const out = await r.run({ to: '+91 9361113900', authorized: true });
    expect(out.data).toMatchObject({ status: 'sent', recipient: 'Anna Reddy', verifiedRecipient: true });
    expect(r.app.sentLog).toEqual([{ to: 'Anna Reddy', file: 'report.pdf' }]);
  });

  it('the end of a number is a likely match: the person is ticked and asked about, nothing sent', async () => {
    const r = share();
    const out = await r.run({ to: 'ending 500432', authorized: true });
    expect(out.data).toMatchObject({ status: 'ready_to_send', recipient: 'Ravi Kumar', verified: false });
    expect(String(out.data?.['question'])).toContain('matched only on part of the number');
    expect(r.app.sentLog).toEqual([]);
  });

  it('two people with that ending: asked which, with numbers hidden; the choice is then who it goes to', async () => {
    const r = share();
    const asked = await r.run({ to: 'ending 3900', authorized: true });
    expect(asked.data).toMatchObject({ status: 'ambiguous' });
    expect(JSON.stringify(asked.data?.['candidates'])).not.toMatch(/70211/);
    expect(r.app.sentLog).toEqual([]);
    const choice = (asked.data?.['candidates'] as Array<{ label: string; choice: number }>).find((c) => c.label === 'Anna Reddy')?.choice;
    const out = await r.run({ choice: choice as number, authorized: true });
    expect(out.data).toMatchObject({ status: 'sent', recipient: 'Anna Reddy' });
    expect(r.app.sentLog).toEqual([{ to: 'Anna Reddy', file: 'report.pdf' }]);
  });

  it('a number nobody has: nothing is sent, the picker is left tidy, and no number is read out whole', async () => {
    const r = share();
    const out = await r.run({ to: '+91 9361199999', authorized: true });
    expect(out.data?.['status']).toBe('none');
    expect(JSON.stringify(out.data)).not.toContain('9361199999');
    expect(r.app.sentLog).toEqual([]);
  });

  it('digits that are not a valid number are never given a country code in the picker either', async () => {
    const r = share();
    const out = await r.run({ to: '5361113900', authorized: true });
    expect(out.data?.['status']).toBe('none');
    expect(r.app.sentLog).toEqual([]);
  });
});
