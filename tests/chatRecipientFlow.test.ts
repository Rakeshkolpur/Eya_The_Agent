import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryDiagnostics } from '../src/main/chat/chatDiagnostics';
import { ChatSession } from '../src/main/chat/chatSession';
import { ContactBook } from '../src/main/chat/ContactBook';
import { ChatCommands } from '../src/main/local/ChatCommands';
import type { FileLocation } from '../src/main/local/ChatCommands';
import { MIGRATIONS } from '../src/main/memory/schema';
import { migrate, openDatabase } from '../src/main/memory/sqlite';
import type { Sql } from '../src/main/memory/sqlite';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { CommunicationSettings } from '../src/main/privacy/communicationAccess';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { createBrowserTools } from '../src/main/tools/impl/browserTools';
import { createChatSendGate, createChatTools } from '../src/main/tools/impl/chatTools';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';
import { ANNA_ROWS, FakeChatApp, FakeDisk, ROWS } from './chatFixtures';
import type { Behaviour, FakeChatRow } from './chatFixtures';

/**
 * "Send this PDF to Anna on WhatsApp" when the phone holds Anna, Ramesh Anna, Anna Reddy and Anna Kumar. Everything here runs through the real
 * parser, the real chat commands and the real chat tools against a stand-in chat page that behaves the way a real one does (rows whose text changes,
 * clicks that are refused, a header that shows late, a search that answers late, delivery marks that arrive late). It proves the logic of the
 * agent; it does NOT prove anything about the real WhatsApp Web, whose page has never been driven by these tests.
 */

const HOME = 'C:\\Users\\Test';
const folders: KnownFolders = { home: HOME, downloads: `${HOME}\\Downloads`, desktop: `${HOME}\\Desktop`, documents: `${HOME}\\Documents`, pictures: `${HOME}\\Pictures`, videos: `${HOME}\\Videos`, music: `${HOME}\\Music`, temp: HOME };
const ON: CommunicationSettings = { enabled: true, apps: {} };
const PDF = `${HOME}\\Desktop\\report.pdf`;
const REPORT: FileLocation = { kind: 'one', path: PDF, name: 'report.pdf' };

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

interface Rig {
  readonly app: FakeChatApp;
  readonly chat: ChatCommands;
  readonly session: ChatSession;
  readonly invoked: string[];
  readonly diag: MemoryDiagnostics;
  clock: number;
}

function rig(
  opts: { confirmSends?: 'always' | 'unless_verified'; rows?: readonly FakeChatRow[]; behaviour?: Behaviour; located?: FileLocation | null; lastFile?: { path: string; name: string } | null; tweak?: (app: FakeChatApp) => void; loadAttempts?: number; installed?: boolean; browserReady?: boolean; openLink?: (url: string) => Promise<boolean> } = {},
): Rig {
  const app = new FakeChatApp(opts.rows ?? ANNA_ROWS);
  if (opts.behaviour !== undefined) app.behaviour = opts.behaviour;
  opts.tweak?.(app);
  const state = { clock: 1_000_000 };
  const policy = new CommunicationPolicy(() => ON);
  const session = new ChatSession(() => state.clock);
  const book = new ContactBook(db);
  book.setLearning('off'); // (so that the question about remembering names does not follow the first send)
  const tools = new ToolRegistry();
  const disk = new FakeDisk({
    [PDF]: { isFile: true, isDirectory: false, size: 10, content: Buffer.from('0123456789') },
    [`${HOME}\\Desktop\\notes.docx`]: { isFile: true, isDirectory: false, size: 10, content: Buffer.from('0123456789') },
  });
  for (const t of createChatTools({ service: app, policy, session, folders, files: disk, sleep: async () => undefined, now: () => state.clock })) tools.register(t);
  for (const t of createBrowserTools(app, undefined, { chatGate: createChatSendGate(session, policy) })) tools.register(t);
  const invoked: string[] = [];
  const diag = new MemoryDiagnostics();
  const located = opts.located === undefined ? REPORT : opts.located;
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
    files: { locate: async () => located },
    ...(opts.lastFile !== undefined ? { lastFile: () => opts.lastFile ?? null } : {}),
    diagnostics: diag,
    confirmSends: opts.confirmSends ?? 'always',
    fileRoute: 'chat',
    ...(opts.installed !== undefined ? { installedApp: (id: string) => id === 'whatsapp' && opts.installed === true } : {}),
    ...(opts.openLink !== undefined ? { openAppLink: opts.openLink } : {}),
    ...(opts.browserReady !== undefined ? { browserReady: () => opts.browserReady === true } : {}),
    now: () => state.clock,
    sleep: async () => undefined,
    ...(opts.loadAttempts !== undefined ? { loadAttempts: opts.loadAttempts } : {}),
  });
  return Object.assign(state, { app, chat, session, invoked, diag }) as unknown as Rig;
}

const say = (r: Rig, text: string) => r.chat.tryHandle(text);
const clicks = (r: Rig): string[] => r.app.calls.filter((c) => c.startsWith('click'));

describe('who is meant: Anna among the Annas', () => {
  it('one exact name is the recipient, and it is an identity: no caveat', async () => {
    const r = rig();
    const out = await say(r, 'send hi to Anna on WhatsApp');
    expect(r.app.open?.name).toBe('Anna'); // not Ramesh Anna, not Anna Reddy, whatever came first in the results
    expect(out?.spoken).toBe('Found Anna. Send "hi"?');
    expect(r.session.chat()).toMatchObject({ label: 'Anna', verified: true, headerChecked: true, matchedBy: 'exact name' });
    expect(r.app.draft).toBe('hi');
    expect(r.app.thread).toEqual([]); // nothing sent before the yes
  });

  it('several Annas and no exact one: asks once, opens nothing, and the answer is not asked again', async () => {
    const r = rig({ rows: ANNA_ROWS.filter((x) => x.name !== 'Anna') });
    const out = await say(r, 'send hi to Anna on WhatsApp');
    expect(out?.spoken).toMatch(/^Which one: /);
    for (const n of ['Ramesh Anna', 'Anna Reddy', 'Anna Kumar']) expect(out?.spoken).toContain(n);
    expect(r.app.open).toBeNull();
    expect(clicks(r)).toEqual([]);
    const searchesBeforeAnswer = r.app.searchTypes;
    const answered = await say(r, 'Anna Reddy');
    expect(r.app.open?.name).toBe('Anna Reddy');
    expect(answered?.spoken).toBe('Found Anna Reddy. Send "hi"?'); // what the person chose is an identity too
    expect(answered?.spoken).not.toMatch(/Which one/);
    expect(r.app.searchTypes).toBe(searchesBeforeAnswer); // the row they chose is opened from the list that is showing: nothing is searched again
  });

  it('the answer can be a number or "the second one"', async () => {
    const r = rig({ rows: ANNA_ROWS.filter((x) => x.name !== 'Anna') });
    await say(r, 'send hi to Anna on WhatsApp');
    const out = await say(r, 'the second one');
    expect(out?.spoken).toMatch(/^Found /);
    expect(r.app.open).not.toBeNull();
  });

  it('a name that merely CONTAINS what was said is a likely match: it is said to be one, and is not an identity', async () => {
    const r = rig({ rows: [{ name: 'Ramesh Anna', phone: '+91 90000 22222', preview: 'ok' }, ROWS[3] as FakeChatRow] });
    const out = await say(r, 'send hi to Anna on WhatsApp');
    expect(r.app.open?.name).toBe('Ramesh Anna'); // the only one there is
    expect(out?.spoken).toContain('Found Ramesh Anna');
    expect(out?.spoken).toContain('matched only on "Anna", not an exact name');
    expect(r.session.chat()).toMatchObject({ label: 'Ramesh Anna', verified: false });
  });

  it('a whole phone number is an identity', async () => {
    const r = rig({ rows: ROWS });
    const out = await say(r, 'send hello to +91 98765 00432 on whatsapp');
    expect(r.app.open?.name).toBe('Rahul Sharma');
    expect(r.session.chat()).toMatchObject({ verified: true, matchedBy: 'full phone number' });
    expect(out?.spoken).toBe('Found Rahul Sharma, number ending in 432. Send "hello"?');
  });

  it('the end of a number is only a likely match', async () => {
    const r = rig({ rows: ROWS });
    await say(r, 'send hello to number ending 432 on whatsapp');
    // two chats end in 432 (Rahul Sharma and Priya Singh): never picked for the person
    expect(r.app.open).toBeNull();
  });

  it('nobody by that name: says so, and types and sends nothing', async () => {
    const r = rig();
    const out = await say(r, 'send hi to Zorro on WhatsApp');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toContain("couldn't find a chat called Zorro");
    expect(r.app.draft).toBe('');
    expect(r.app.thread).toEqual([]);
  });
});

describe('the search is typed once', () => {
  it('while the page is still loading', async () => {
    const r = rig({ tweak: (a) => (a.loadingFor = 4) });
    const out = await say(r, 'send hi to Anna on WhatsApp');
    expect(out?.spoken).toBe('Found Anna. Send "hi"?');
    expect(r.app.searchTypes).toBe(1);
  });

  it('when the search is answered late, the answer is read again, not typed again', async () => {
    const r = rig({ tweak: (a) => (a.listLag = 4) });
    const out = await say(r, 'send hi to Anna on WhatsApp');
    expect(out?.spoken).toBe('Found Anna. Send "hi"?');
    expect(r.app.searchTypes).toBe(1);
  });

  it('an app that has just been opened and is still filling its list is read again, and the search is not flipped back and forth', async () => {
    const r = rig({ tweak: (a) => ((a.url = 'https://example.com/'), (a.emptyListLooks = 40)) });
    const out = await say(r, 'send hi to Anna on WhatsApp');
    expect(out?.spoken).toBe('Found Anna. Send "hi"?');
    // the name, then (once) its first letters when nothing fitted, then the name again: three searches, however many times the list is read
    expect(r.app.searchTypes).toBeLessThanOrEqual(3);
    expect(r.app.calls.filter((c) => c === 'open')).toHaveLength(1); // the app is opened once
  });

  it('the same request said again while the chat is open does not search or click again', async () => {
    const r = rig();
    await say(r, 'send hi to Anna on WhatsApp');
    const before = { searches: r.app.searchTypes, clicks: clicks(r).length };
    const again = await say(r, 'send hi to Anna on WhatsApp');
    expect(again?.spoken).toBe('Found Anna. Send "hi"?');
    expect({ searches: r.app.searchTypes, clicks: clicks(r).length }).toEqual(before);
  });

  it('a chat shown twice in a search (as a chat and as a contact) is one chat, opened once', async () => {
    const r = rig({ tweak: (a) => (a.duplicateSections = true) });
    const out = await say(r, 'send hi to Anna on WhatsApp');
    expect(out?.spoken).toBe('Found Anna. Send "hi"?');
    expect(clicks(r)).toEqual(['clickItem:Anna']);
  });
});

describe('opening the chat', () => {
  it('opens the row by what it is, even though its text (preview, time) changes between the list and the click', async () => {
    const r = rig({ tweak: (a) => ((a.strictRowText = true), (a.rowsDrift = true)) });
    const out = await say(r, 'send hi to Anna on WhatsApp');
    expect(out?.spoken).toBe('Found Anna. Send "hi"?');
    expect(r.app.open?.name).toBe('Anna');
  });

  it('(clicking by the row\'s whole text, as it used to, fails on the same page)', async () => {
    const app = new FakeChatApp(ANNA_ROWS);
    app.strictRowText = true;
    app.rowsDrift = true;
    const stale = ((await app.listItems()).find((i) => i.primary === 'Anna') as { name: string }).name; // what the list said when it was read
    await app.listItems(); // the page moves on (a message arrives, the minute turns)
    expect((await app.clickOnPage(stale)).ok).toBe(false);
  });

  it('a click that is refused is tried once more, from a fresh look, and nothing is typed again', async () => {
    const r = rig({ tweak: (a) => (a.blockedClicks = 1) });
    const out = await say(r, 'send hi to Anna on WhatsApp');
    expect(out?.spoken).toBe('Found Anna. Send "hi"?');
    expect(clicks(r)).toEqual(['clickItem:Anna', 'clickItem:Anna']);
    expect(r.app.searchTypes).toBe(1);
  });

  it('a click that keeps being refused ends in a plain answer after two tries, with nothing typed or sent', async () => {
    const r = rig({ tweak: (a) => (a.blockedClicks = 9) });
    const out = await say(r, 'send hi to Anna on WhatsApp');
    expect(out?.ok).toBe(false);
    expect(clicks(r)).toHaveLength(2);
    expect(r.app.draft).toBe('');
    expect(r.app.thread).toEqual([]);
  });

  it('a chat that opens slowly is waited for (its name shows a moment after the click) and is then checked', async () => {
    const r = rig({ tweak: (a) => (a.headerAfter = 2) });
    const out = await say(r, 'send hi to Anna on WhatsApp');
    expect(out?.spoken).toBe('Found Anna. Send "hi"?');
    expect(r.session.chat()?.headerChecked).toBe(true);
  });

  it('a header that cannot be read is said so, and the person still decides', async () => {
    const r = rig({ tweak: (a) => (a.headerInHeadings = false) });
    const out = await say(r, 'send hi to Anna on WhatsApp');
    expect(out?.spoken).toContain("I couldn't read the chat's header to double-check it");
    expect(r.session.chat()?.headerChecked).toBe(false);
  });
});

describe('sending a file', () => {
  it('"this PDF" is the file in view, and the question names the file and the exact person', async () => {
    const r = rig({ lastFile: { path: PDF, name: 'report.pdf' } });
    const out = await say(r, 'Send this PDF to Anna on WhatsApp.');
    expect(out?.spoken).toBe('Found Anna. Send the file "report.pdf"?');
    expect(r.app.attached).toBeNull(); // nothing attached before the yes
    const done = await say(r, 'yes');
    // (only what the page showed is said about how far it got: its own mark, here "sent", is not "delivered" and not "read")
    expect(done?.spoken).toBe('Sent "report.pdf" to Anna. WhatsApp shows it as sent, not yet delivered.');
    expect(r.app.thread).toHaveLength(1);
    expect(r.app.thread[0]?.file).toBe('report.pdf');
  });

  it('"this PDF" with nothing in view is a question, not a guess at a file', async () => {
    const r = rig({ lastFile: null });
    const out = await say(r, 'Send this PDF to Anna on WhatsApp.');
    expect(out?.spoken).toMatch(/Which PDF do you mean/);
    expect(r.invoked).toEqual([]);
  });

  it('"this PDF" when the file in view is a Word file asks which one', async () => {
    const r = rig({ lastFile: { path: `${HOME}\\Desktop\\notes.docx`, name: 'notes.docx' } });
    const out = await say(r, 'send this pdf to Anna on whatsapp');
    expect(out?.spoken).toContain("isn't a PDF");
    expect(r.invoked).toEqual([]);
  });

  it('a file that cannot be found is left to the model, and nothing is opened', async () => {
    const r = rig({ located: null });
    expect(await say(r, 'send resume.pdf to Anna on whatsapp')).toBeNull();
    expect(r.invoked).toEqual([]);
  });

  it('an attachment the page never shows is not sent, and is said not to have been', async () => {
    const r = rig({ behaviour: 'never_shows', lastFile: { path: PDF, name: 'report.pdf' } });
    await say(r, 'send this pdf to Anna on whatsapp');
    const out = await say(r, 'yes');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toContain('nothing was sent');
    expect(r.app.thread).toEqual([]);
  });

  it('if the open chat is no longer the chosen one, the file is not attached and nothing is sent', async () => {
    const r = rig({ lastFile: { path: PDF, name: 'report.pdf' } });
    await say(r, 'send this pdf to Anna on whatsapp');
    r.app.open = ANNA_ROWS[1] as FakeChatRow; // the person clicked another chat in the meantime
    const out = await say(r, 'yes');
    expect(out?.spoken).toContain('is not the chat with Anna any more');
    expect(r.app.attached).toBeNull();
    expect(r.app.thread).toEqual([]);
  });
});

describe('sending a message', () => {
  it('on a yes, in the chat that was chosen, it is sent, checked, and the task ends', async () => {
    const r = rig();
    await say(r, 'send hi to Anna on WhatsApp');
    const done = await say(r, 'yes');
    expect(done?.spoken).toBe('Sent to Anna. WhatsApp shows it as sent, not yet delivered.');
    expect(r.app.thread).toHaveLength(1);
    // a stray yes afterwards is not an answer to anything: nothing is sent again
    expect(await say(r, 'yes')).toBeNull();
    expect(r.app.thread).toHaveLength(1);
    const states = r.diag.events.filter((e) => e['op'] === 'state').map((e) => e['to']);
    expect(states.at(-1)).toBe('COMPLETED');
  });

  it('a yes does not cover a send in a different chat from the one chosen', async () => {
    const r = rig();
    await say(r, 'send hi to Anna on WhatsApp');
    r.app.open = ANNA_ROWS[0] as FakeChatRow; // Ramesh Anna is open now
    const out = await say(r, 'yes');
    expect(out?.ok).toBe(false);
    expect(out?.spoken).toContain('is not the chat with Anna any more');
    expect(r.app.thread).toEqual([]);
  });

  it('a delivery mark that arrives late is waited for', async () => {
    const r = rig({ tweak: (a) => (a.markAfter = 4) });
    await say(r, 'send hi to Anna on WhatsApp');
    expect((await say(r, 'yes'))?.spoken).toBe('Sent to Anna. WhatsApp shows it as sent, not yet delivered.');
  });

  it('a send whose result never shows is "not known", never "sent", and is not sent a second time', async () => {
    const r = rig({ behaviour: 'no_marks' });
    await say(r, 'send hi to Anna on WhatsApp');
    const first = await say(r, 'yes');
    expect(first?.ok).toBe(false);
    expect(first?.spoken).toContain("can't confirm");
    expect(first?.spoken).toContain("won't send it again without checking");
    expect(r.app.thread).toHaveLength(1);

    // The same request again: the chat is looked at first. The message is there, so it is NOT prepared and sent again behind the person's back.
    const again = await say(r, 'send hi to Anna on WhatsApp');
    expect(again?.spoken).toContain('already in the chat');
    expect(r.app.thread).toHaveLength(1);
    // and a no leaves it at one
    await say(r, 'no');
    expect(r.app.thread).toHaveLength(1);
  });

  it('a send that the app shows as still sending is not repeated either', async () => {
    const r = rig({ behaviour: 'pending' });
    await say(r, 'send hi to Anna on WhatsApp');
    await say(r, 'yes');
    const again = await say(r, 'send hi to Anna on WhatsApp');
    expect(again?.spoken).toContain('still shows it as sending');
    expect(again?.spoken).toContain('did not send it again');
    expect(r.app.thread).toHaveLength(1);
  });

  it('the same message to the same chat a moment after it was seen to go is said to be a repeat when asked', async () => {
    const r = rig();
    await say(r, 'send hi to Anna on WhatsApp');
    await say(r, 'yes');
    r.clock += 40_000;
    const again = await say(r, 'send hi to Anna on WhatsApp');
    expect(again?.spoken).toContain('I already sent this message here 40 seconds ago');
    expect(r.app.thread).toHaveLength(1); // not sent: the person is asked first
  });

  it('a message that never reached the chat is prepared again as a normal send', async () => {
    const r = rig({ behaviour: 'fails' });
    await say(r, 'send hi to Anna on WhatsApp');
    const failed = await say(r, 'yes');
    expect(failed?.spoken).toContain('failed to send');
    r.app.behaviour = 'normal';
    r.app.thread = [];
    const again = await say(r, 'send hi to Anna on WhatsApp');
    expect(again?.spoken).toBe('Found Anna. Send "hi"?');
  });
});

describe('the installed app or the web page', () => {
  it('with WhatsApp installed and a browser connected, a message to a number is worked in the web page (typed, sent and checked), not left for the person to press Enter', async () => {
    const opened: string[] = [];
    const r = rig({ rows: ROWS, installed: true, browserReady: true, openLink: async (u) => (opened.push(u), true) });
    const out = await say(r, 'open whatsapp and send msg to +91 98765 00432 " hello "');
    expect(opened).toEqual([]); // the installed program was not used
    expect(out?.spoken).toContain('Found Rahul Sharma');
    expect(out?.spoken).toContain('Send "hello"?'); // (and the quotation marks are not part of the message)
    expect((await say(r, 'yes'))?.spoken).toContain('Sent to Rahul Sharma');
    expect(r.app.thread.map((m) => m.text)).toEqual(['hello']);
  });

  it('with no browser to work in, the installed app is opened with the message ready, and nothing is claimed sent', async () => {
    const opened: string[] = [];
    const r = rig({ rows: ROWS, installed: true, browserReady: false, openLink: async (u) => (opened.push(u), true) });
    const out = await say(r, 'send hello to +91 98765 00432 on whatsapp');
    expect(opened).toEqual(['whatsapp://send?phone=919876500432&text=hello']);
    expect(out?.spoken).toContain("can't send it or confirm it for you");
    expect(r.app.thread).toEqual([]);
  });
});

describe('a request that is taken up again', () => {
  it('after a slow page it is the same task: nothing is searched twice, and the task does not start over', async () => {
    const r = rig({ tweak: (a) => (a.loadingFor = 1000), loadAttempts: 3 });
    const slow = await say(r, 'send hi to Anna on WhatsApp');
    expect(slow?.pending).toMatchObject({ kind: 'retry' });
    expect(r.app.searchTypes).toBe(0); // the page never got as far as a search box
    r.app.loadingFor = 0;
    const done = await say(r, 'send hi to Anna on WhatsApp');
    expect(done?.spoken).toBe('Found Anna. Send "hi"?');
    expect(r.app.searchTypes).toBe(1);
    expect(new Set(r.diag.events.map((e) => e['task'])).size).toBe(1);
  });
});

describe('what is written down', () => {
  it('holds states, durations and outcomes, and no message, name or number', async () => {
    const r = rig({ rows: ROWS });
    await say(r, 'send secretword to +91 98765 00432 on whatsapp');
    await say(r, 'yes');
    const written = JSON.stringify(r.diag.events);
    expect(r.diag.events.length).toBeGreaterThan(8);
    expect(written).not.toMatch(/secretword|Rahul|Sharma|98765|00432/i);
    expect(written).toContain('SEARCH_CONTACT');
    expect(written).toContain('VERIFY_SENT_RESULT');
    expect(r.diag.events.every((e) => typeof e['task'] === 'string' && typeof e['op'] === 'string')).toBe(true);
  });
});
