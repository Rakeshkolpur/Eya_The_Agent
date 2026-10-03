import { describe, it, expect } from 'vitest';
import { createChatSendGate, createChatTools, describeRecipient, mimeFor } from '../src/main/tools/impl/chatTools';
import { createBrowserTools } from '../src/main/tools/impl/browserTools';
import { ChatSession } from '../src/main/chat/chatSession';
import { COMMUNICATION_OFF, CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { CommunicationSettings } from '../src/main/privacy/communicationAccess';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';
import { FakeChatApp, FakeDisk, ROWS } from './chatFixtures';
import type { Behaviour } from './chatFixtures';

const HOME = 'C:\\Users\\Test';
const folders: KnownFolders = {
  home: HOME,
  downloads: `${HOME}\\Downloads`,
  desktop: `${HOME}\\Desktop`,
  documents: `${HOME}\\Documents`,
  pictures: `${HOME}\\Pictures`,
  videos: `${HOME}\\Videos`,
  music: `${HOME}\\Music`,
  temp: `${HOME}\\AppData\\Local\\Temp`,
};

const ON: CommunicationSettings = { enabled: true, apps: {} };
const PDF = `${HOME}\\Desktop\\report.pdf`;

function rig(opts: { settings?: CommunicationSettings; behaviour?: Behaviour } = {}) {
  const app = new FakeChatApp();
  if (opts.behaviour !== undefined) app.behaviour = opts.behaviour;
  const policy = new CommunicationPolicy(() => opts.settings ?? ON);
  const session = new ChatSession();
  const disk = new FakeDisk({
    [PDF]: { isFile: true, isDirectory: false, size: 10, content: Buffer.from('0123456789') },
    [`${HOME}\\Desktop\\Hello 2`]: { isFile: false, isDirectory: true, size: 0 },
    [`${HOME}\\Desktop\\empty.txt`]: { isFile: true, isDirectory: false, size: 0, content: Buffer.alloc(0) },
    [`${HOME}\\Desktop\\huge.zip`]: { isFile: true, isDirectory: false, size: 300 * 1024 * 1024 },
    [`${HOME}\\Desktop\\setup.exe`]: { isFile: true, isDirectory: false, size: 10, content: Buffer.alloc(10) },
    [`${HOME}\\Desktop\\.env`]: { isFile: true, isDirectory: false, size: 10, content: Buffer.alloc(10) },
    [`${HOME}\\Desktop\\photo.jpg`]: { isFile: true, isDirectory: false, size: 4, content: Buffer.from('JPEG') },
  });
  const tools = createChatTools({ service: app, policy, session, folders, files: disk, sleep: async () => undefined });
  const by = (name: string): Tool => tools.find((t) => t.schema.name === name) as Tool;
  const run = (name: string, args: ToolArgs = {}): Promise<ToolResult> => by(name).execute(args);
  const gate = createChatSendGate(session, policy);
  return { app, policy, session, disk, run, gate, tools };
}

const json = (r: ToolResult) => JSON.stringify(r);

describe('find_chat: choosing the right chat locally', () => {
  it('opens the one chat that fits a full name, and tells the model only that name', async () => {
    const { app, run, session } = rig();
    const r = await run('find_chat', { query: 'Rahul Sharma' });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ status: 'opened', chat: 'Rahul Sharma', app: 'WhatsApp' });
    expect(app.open?.name).toBe('Rahul Sharma');
    expect(session.chat()?.label).toBe('Rahul Sharma');
    // It typed the name into the app's own search box, and clicked the row.
    expect(app.calls).toContain('fill:Search or start new chat=rahul sharma');
    expect(app.calls.some((c) => c.startsWith('click:Rahul Sharma'))).toBe(true);
  });

  it('never hands the model the chat list, other people\'s names, or a message preview', async () => {
    const { run } = rig();
    const results = [await run('find_chat', { query: 'Priya' }), await run('find_chat', { query: 'Rahul' }), await run('find_chat', { query: 'Zorro' })];
    for (const r of results) {
      const text = json(r);
      for (const secret of ['hunter2', 'See you tomorrow', 'Thanks for the loan', 'Call me', 'Amit', 'Mum', '10:42', 'clinic']) expect(text, text).not.toContain(secret);
    }
  });

  it('a first name two chats share is not guessed: it returns both, numbered, and opens nothing', async () => {
    const { app, run, session } = rig();
    const r = await run('find_chat', { query: 'Rahul' });
    expect(r.ok).toBe(true);
    expect(r.data?.['status']).toBe('ambiguous');
    expect((r.data?.['candidates'] as Array<{ choice: number; label: string }>).map((c) => `${c.choice}:${c.label}`)).toEqual(['1:Rahul Sharma', '2:Rahul Verma']);
    expect(String(r.data?.['question'])).toMatch(/ask which one/i);
    expect(app.open).toBeNull();
    expect(app.calls.some((c) => c.startsWith('click:'))).toBe(false);
    expect(session.chat()).toBeNull();
  });

  it('after the user chooses, the choice number opens exactly that chat', async () => {
    const { app, run, session } = rig();
    await run('find_chat', { query: 'Rahul' });
    const r = await run('find_chat', { choice: 2 });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ status: 'opened', chat: 'Rahul Verma', matchedBy: 'the choice the user made' });
    expect(app.open?.name).toBe('Rahul Verma');
    expect(session.chat()?.label).toBe('Rahul Verma');
  });

  it('a choice that was never offered is refused', async () => {
    const { run } = rig();
    const r = await run('find_chat', { choice: 3 });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('no such choice');
  });

  it('nothing fits: it says so and opens nothing', async () => {
    const { app, run } = rig();
    const r = await run('find_chat', { query: 'Zorro' });
    expect(r.ok).toBe(true);
    expect(r.data?.['status']).toBe('none');
    expect(app.open).toBeNull();
  });

  it('digits of a number go to the app\'s own search: two matches ask, one opens', async () => {
    const { app, run } = rig();
    const two = await run('find_chat', { query: 'number ending 432' });
    expect(two.data?.['status']).toBe('ambiguous');
    expect((two.data?.['candidates'] as Array<{ label: string }>).map((c) => c.label).sort()).toEqual(['Priya Singh', 'Rahul Sharma']);
    expect(app.open).toBeNull();
    const one = await run('find_chat', { query: 'ending 00432' });
    expect(one.data).toMatchObject({ status: 'opened', chat: 'Rahul Sharma' });
  });

  it('a name plus digits settles it', async () => {
    const { run } = rig();
    const r = await run('find_chat', { query: 'Rahul' });
    expect(r.data?.['status']).toBe('ambiguous');
    const settled = await run('find_chat', { query: 'Rahul Verma' });
    expect(settled.data).toMatchObject({ status: 'opened', chat: 'Rahul Verma' });
  });

  it('a chat used earlier in the conversation settles a tie, and says it did', async () => {
    const { run } = rig();
    await run('find_chat', { query: 'Rahul Sharma' });
    const again = await run('find_chat', { query: 'Rahul' });
    expect(again.data).toMatchObject({ status: 'opened', chat: 'Rahul Sharma' });
    expect(String(again.data?.['matchedBy'])).toMatch(/earlier in this conversation/);
  });

  it('reads the end of the number from the chat header when the app shows it, and keeps it for the confirmation', async () => {
    const { app, run, session } = rig();
    const original = app.snapshot.bind(app);
    app.snapshot = () => ({ ...original(), headings: app.open !== null ? [`${app.open.name} ${app.open.phone}`] : [] });
    const r = await run('find_chat', { query: 'Priya' });
    expect(r.data).toMatchObject({ status: 'opened', chat: 'Priya Singh', numberEndsIn: '432', headerChecked: true });
    expect(session.chat()?.phoneEnding).toBe('432');
  });

  it('a number that is shown somewhere else on the page, next to another name, is NOT taken as this chat\'s', async () => {
    const { app, run, session } = rig();
    const original = app.snapshot.bind(app);
    app.snapshot = () => ({ ...original(), headings: ['Priya Singh', 'Rahul Verma +91 91234 55987'], visibleText: 'Priya Singh Thanks for the loan Rahul Verma +91 91234 55987' });
    const r = await run('find_chat', { query: 'Priya' });
    expect(r.data?.['status']).toBe('opened');
    expect(r.data).not.toHaveProperty('numberEndsIn');
    expect(session.chat()?.phoneEnding).toBeUndefined();
  });

  it('says plainly when it could not double-check the header, instead of claiming it did', async () => {
    const { app, run } = rig();
    app.headerInHeadings = false;
    const r = await run('find_chat', { query: 'Mum' });
    expect(r.data).toMatchObject({ status: 'opened', chat: 'Mum', headerChecked: false });
    expect(String(r.data?.['note'])).toMatch(/could not read the name/);
  });

  it('does not touch a page that is not a chat app', async () => {
    const { app, run } = rig();
    app.url = 'https://shop.example/';
    const r = await run('find_chat', { query: 'Mum' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('not a chat app');
    expect(app.calls.some((c) => c.startsWith('click:') || c.startsWith('fill:'))).toBe(false);
  });

  it('is refused, reading nothing, while Communication Access is off', async () => {
    const { app, run } = rig({ settings: COMMUNICATION_OFF });
    app.accessOff = true; // what the session manager does for a chat page when it is off
    const r = await run('find_chat', { query: 'Mum' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('communication access is off');
    expect(r.data).toMatchObject({ communicationAccess: 'off', nothingWasRead: true });
    expect(app.calls).toEqual([]);
  });

  it('asks for a name or digits, not an empty look', async () => {
    const { run } = rig();
    expect((await run('find_chat', {})).ok).toBe(false);
    expect((await run('find_chat', { query: 'the' })).ok).toBe(false);
  });
});

describe('attach_file: checks first, asks, then attaches without sending', () => {
  async function inChat(opts: Parameters<typeof rig>[0] = {}) {
    const r = rig(opts);
    await r.run('find_chat', { query: 'Rahul Sharma' });
    r.app.calls.length = 0;
    return r;
  }

  it('without a yes it attaches nothing and returns the question, naming the person and the file', async () => {
    const { app, run } = await inChat();
    const r = await run('attach_file', { path: PDF });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('needs confirmation');
    expect(r.data?.['question']).toBe('Found Rahul Sharma. Send the file "report.pdf" to this chat?');
    expect(r.error).toContain('Ask the user exactly this');
    expect(app.attached).toBeNull();
    expect(app.calls.some((c) => c.startsWith('attach:'))).toBe(false);
  });

  it('includes the end of the number when it is known', async () => {
    const r = rig();
    const original = r.app.snapshot.bind(r.app);
    r.app.snapshot = () => ({ ...original(), headings: r.app.open !== null ? [`${r.app.open.name} ${r.app.open.phone}`] : [] });
    await r.run('find_chat', { query: 'Rahul Sharma' });
    const q = await r.run('attach_file', { path: PDF });
    expect(q.data?.['question']).toBe('Found Rahul Sharma, number ending in 432. Send the file "report.pdf" to this chat?');
  });

  it('with a yes: attaches the real bytes, checks the page really shows it, and says it is NOT sent yet', async () => {
    const { app, run, session } = await inChat();
    const r = await run('attach_file', { path: PDF, confirm: true });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ status: 'attached_not_sent', file: 'report.pdf', sizeBytes: 10, chat: 'Rahul Sharma' });
    expect(String(r.data?.['next'])).toMatch(/NOT sent/);
    expect(app.attached).toMatchObject({ name: 'report.pdf', mime: 'application/pdf', size: 10, prefer: 'auto' });
    expect(app.attached?.bytes.toString()).toBe('0123456789'); // the whole file arrived intact, in pieces
    expect(session.attachment()).toBe('report.pdf');
    expect(session.isAuthorized('Rahul Sharma', 'report.pdf')).toBe(true);
    expect(app.thread).toEqual([]); // nothing was sent
  });

  it('passes the "as document / as media" choice on', async () => {
    const { app, run } = await inChat();
    await run('attach_file', { path: `${HOME}\\Desktop\\photo.jpg`, confirm: true, as: 'document' });
    expect(app.attached).toMatchObject({ name: 'photo.jpg', mime: 'image/jpeg', prefer: 'document' });
  });

  it('a folder cannot be attached: it points to zip_folder', async () => {
    const { app, run } = await inChat();
    const r = await run('attach_file', { path: `${HOME}\\Desktop\\Hello 2`, confirm: true });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('that is a folder');
    expect(r.error).toMatch(/zip_folder/);
    expect(app.calls.some((c) => c.startsWith('attach:'))).toBe(false);
  });

  it('refuses secrets, programs, missing, empty and oversized files, before touching the page', async () => {
    const { app, run } = await inChat();
    for (const [path, summary] of [
      [`${HOME}\\Desktop\\.env`, 'not allowed'],
      [`${HOME}\\Desktop\\setup.exe`, 'not allowed'],
      [`${HOME}\\Desktop\\nope.pdf`, 'file not found'],
      [`${HOME}\\Desktop\\empty.txt`, 'empty file'],
      [`${HOME}\\Desktop\\huge.zip`, 'too big'],
      [`${HOME}\\AppData\\Roaming\\Google\\Chrome\\User Data\\Default\\Cookies`, 'not allowed'],
      ['C:\\Windows\\System32\\config\\SAM', 'not allowed'],
    ] as const) {
      const r = await run('attach_file', { path, confirm: true });
      expect(r.ok, path).toBe(false);
      expect(r.summary, path).toBe(summary);
    }
    expect(app.calls).toEqual([]);
  });

  it('only on a chat app: a file is never put on an ordinary website', async () => {
    const { app, run } = await inChat();
    app.url = 'https://shop.example/upload';
    const r = await run('attach_file', { path: PDF, confirm: true });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('not a chat app');
    expect(app.attached).toBeNull();
  });

  it('is refused while Communication Access is off, and no byte of the file is read', async () => {
    const { app, run, disk } = await inChat();
    let reads = 0;
    const read = disk.read.bind(disk);
    disk.read = async (...a) => (reads++, read(...a));
    app.accessOff = true;
    const r = await run('attach_file', { path: PDF, confirm: true });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('communication access is off');
    expect(reads).toBe(0);
  });

  it('no file picker on the page yet: it says to open the attach menu (and not to click Document), and nothing is sent', async () => {
    const { app, run } = await inChat({ behaviour: 'no_picker' });
    const r = await run('attach_file', { path: PDF, confirm: true });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('no file picker yet');
    expect(r.data).toMatchObject({ status: 'not_attached', reason: 'no_file_input' });
    expect(app.thread).toEqual([]);
    // After the attach menu is opened it works.
    app.behaviour = 'normal';
    await app.clickOnPage('Attach');
    const again = await run('attach_file', { path: PDF, confirm: true });
    expect(again.ok).toBe(true);
  });

  it('the page never shows the attachment: it is NOT reported as attached, and the model is told not to send', async () => {
    const { run, session } = await inChat({ behaviour: 'never_shows' });
    const r = await run('attach_file', { path: PDF, confirm: true });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('could not confirm the attachment');
    expect(r.error).toMatch(/Do not click Send/);
    expect(session.attachment()).toBeNull();
  });

  it('when the chat is not known it still asks, saying it cannot tell who the chat is with', async () => {
    const r = rig();
    r.app.open = ROWS[0] as never; // the user opened a chat themselves; Eya did not
    const q = await r.run('attach_file', { path: PDF });
    expect(q.data?.['question']).toBe('I can\'t tell who this chat is with. Send the file "report.pdf" to this chat?');
    expect(q.data?.['chatKnown']).toBe(false);
  });
});

describe('the send gate: who it goes to is said before anything is sent', () => {
  it('a Send click asks, naming the recipient, and gives the exact question', async () => {
    const { session, policy, app, gate } = rig();
    session.openedChat({ app: 'WhatsApp', label: 'Rahul Sharma', phoneEnding: '432' });
    const d = gate.forClick(app.snapshot(), { name: 'Send', role: 'button' });
    expect(d?.reason).toBe('sending this message in a chat app');
    expect(d?.question).toBe('Found Rahul Sharma, number ending in 432. Send this message to this chat?');
    expect(policy.appForUrl(app.url)).not.toBeNull();
  });

  it('with a file waiting on the page, the question names the file', () => {
    const { session, app, gate } = rig();
    session.openedChat({ app: 'WhatsApp', label: 'Mum' });
    session.attached('report.pdf');
    const page = { ...app.snapshot(), dialogs: ['Send file report.pdf Add a caption'] };
    expect(gate.forClick(page, { name: 'Send', role: 'button' })?.question).toBe('Found Mum. Send the file "report.pdf" to this chat?');
  });

  it('a file that can no longer be seen on the page is not described as waiting — and the question says so', () => {
    const { session, app, gate } = rig();
    session.openedChat({ app: 'WhatsApp', label: 'Mum' });
    session.attached('report.pdf');
    const d = gate.forClick(app.snapshot(), { name: 'Send', role: 'button' });
    expect(d?.question).toBe('Found Mum. I can no longer see the file "report.pdf" waiting on the page. Send what is on the page to this chat?');
  });

  it('the user\'s yes does not survive the preview being gone: a later Send asks again', async () => {
    const { run, app, gate } = rig();
    await run('find_chat', { query: 'Rahul Sharma' });
    await run('attach_file', { path: PDF, confirm: true }); // the preview is showing
    expect(gate.forClick(app.snapshot(), { name: 'Send', role: 'button' })).toMatchObject({ reason: null });
    app.previewOpen = false; // the preview was closed without sending
    const d = gate.forClick(app.snapshot(), { name: 'Send', role: 'button' });
    expect(d?.reason).not.toBeNull();
    expect(d?.question).toMatch(/no longer see the file "report\.pdf"/);
  });

  it('cancelling the preview withdraws the yes and the attachment, so a message that follows is asked about as a message', async () => {
    const { run, app, gate, session } = rig();
    await run('find_chat', { query: 'Rahul Sharma' });
    await run('attach_file', { path: PDF, confirm: true });
    expect(gate.forClick(app.snapshot(), { name: 'Cancel', role: 'button' })).toBeNull(); // not a send, left to the ordinary rules…
    expect(session.attachment()).toBeNull(); // …but it withdrew everything
    expect(session.isAuthorized('Rahul Sharma', 'report.pdf')).toBe(false);
    expect(gate.forClick(app.snapshot(), { name: 'Send', role: 'button' })?.question).toBe('Found Rahul Sharma. Send this message to this chat?');
  });

  it('a yes runs out after a few minutes', async () => {
    const clock = { t: 1_000_000 };
    const session = new ChatSession(() => clock.t);
    session.openedChat({ app: 'WhatsApp', label: 'Mum' });
    session.authorize({ chat: 'Mum' });
    expect(session.isAuthorized('Mum')).toBe(true);
    clock.t += 3 * 60_000 + 1000;
    expect(session.isAuthorized('Mum')).toBe(false);
  });

  it('the yes given through attach_file covers exactly that send — and nothing else', async () => {
    const { run, app, gate, session } = rig();
    await run('find_chat', { query: 'Rahul Sharma' });
    await run('attach_file', { path: PDF, confirm: true });
    expect(gate.forClick(app.snapshot(), { name: 'Send', role: 'button' })).toMatchObject({ reason: null });
    // Moving to another chat withdraws it.
    await run('find_chat', { query: 'Mum' });
    session.attached('report.pdf');
    expect(gate.forClick(app.snapshot(), { name: 'Send', role: 'button' })?.reason).not.toBeNull();
  });

  it('a different file than the one agreed to asks again', async () => {
    const { run, app, gate, session } = rig();
    await run('find_chat', { query: 'Rahul Sharma' });
    await run('attach_file', { path: PDF, confirm: true });
    session.attached('something-else.pdf');
    const d = gate.forClick({ ...app.snapshot(), dialogs: ['Send file something-else.pdf'] }, { name: 'Send', role: 'button' });
    expect(d?.reason).toBe('sending the file "something-else.pdf" in a chat app');
  });

  it('only a Send control on a chat page: other clicks, links and other sites are left to the ordinary rules', () => {
    const { session, app, gate } = rig();
    session.openedChat({ app: 'WhatsApp', label: 'Mum' });
    expect(gate.forClick(app.snapshot(), { name: 'Attach', role: 'button' })).toBeNull();
    expect(gate.forClick(app.snapshot(), { name: 'Rahul Sharma', role: 'clickable' })).toBeNull();
    expect(gate.forClick(app.snapshot(), { name: 'Send', role: 'link' })).toBeNull();
    expect(gate.forClick({ ...app.snapshot(), url: 'https://shop.example/' }, { name: 'Send', role: 'button' })).toBeNull();
    expect(gate.forClick(null, { name: 'Send', role: 'button' })).toBeNull();
  });

  it('pressing Enter in a message box asks the same way; in a search box it does not', () => {
    const { session, app, gate } = rig();
    session.openedChat({ app: 'WhatsApp', label: 'Mum' });
    expect(gate.forSubmit(app.snapshot(), 'Type a message')?.question).toContain('Found Mum.');
    expect(gate.forSubmit(app.snapshot(), 'Search or start new chat')).toBeNull();
  });

  it('describes an unknown chat honestly', () => {
    expect(describeRecipient(new ChatSession())).toEqual({ text: "I can't tell who this chat is with", known: false });
  });
});

describe('through the real click_on_page tool', () => {
  function browserTools(r: ReturnType<typeof rig>) {
    const tools = createBrowserTools(r.app, undefined, { chatGate: r.gate });
    return (name: string, args: ToolArgs) => (tools.find((t) => t.schema.name === name) as Tool).execute(args);
  }

  it('clicking Send in a chat stops with the exact question, and clicks nothing', async () => {
    const r = rig();
    await r.run('find_chat', { query: 'Priya Singh' });
    const call = browserTools(r);
    const out = await call('click_on_page', { text: 'Send' });
    expect(out.ok).toBe(false);
    expect(out.summary).toBe('needs confirmation');
    expect(out.error).toContain('Ask the user exactly this');
    expect(out.error).toContain('Found Priya Singh. Send this message to this chat?');
    expect(out.data?.['question']).toBe('Found Priya Singh. Send this message to this chat?');
    expect(r.app.thread).toEqual([]);
  });

  it('after a clear yes it goes ahead', async () => {
    const r = rig();
    await r.run('find_chat', { query: 'Priya Singh' });
    const call = browserTools(r);
    const out = await call('click_on_page', { text: 'Send', confirm: true });
    expect(out.ok).toBe(true);
    expect(r.app.thread).toHaveLength(1);
  });

  it('a file the user agreed to through attach_file is sent by the next Send click without asking twice', async () => {
    const r = rig();
    await r.run('find_chat', { query: 'Rahul Sharma' });
    await r.run('attach_file', { path: PDF, confirm: true });
    const call = browserTools(r);
    const out = await call('click_on_page', { text: 'Send' });
    expect(out.ok).toBe(true);
    expect(r.app.thread[0]?.file).toBe('report.pdf');
  });

  it('the yes covers ONE Send: the next Send (a typed message, say) asks again, even before verify_sent', async () => {
    const r = rig();
    await r.run('find_chat', { query: 'Rahul Sharma' });
    await r.run('attach_file', { path: PDF, confirm: true });
    const call = browserTools(r);
    expect((await call('click_on_page', { text: 'Send' })).ok).toBe(true);
    const next = await call('click_on_page', { text: 'Send' });
    expect(next.ok).toBe(false);
    expect(next.data?.['question']).toBe('Found Rahul Sharma. Send this message to this chat?');
    // And what was just sent can still be checked.
    expect((await r.run('verify_sent', {})).data).toMatchObject({ status: 'sent', file: 'report.pdf' });
  });

  it('pressing Enter in the message box asks first as well', async () => {
    const r = rig();
    await r.run('find_chat', { query: 'Mum' });
    const call = browserTools(r);
    const out = await call('fill_on_page', { label: 'Type a message', value: 'hello', submit: true });
    expect(out.ok).toBe(false);
    expect(out.summary).toBe('needs confirmation');
    expect(out.data?.['question']).toBe('Found Mum. Send this message to this chat?');
    expect(r.app.calls.some((c) => c.includes('+enter'))).toBe(false);
  });

  it('on an ordinary website, the ordinary rules apply unchanged', async () => {
    const r = rig();
    r.app.url = 'https://shop.example/';
    const out = await browserTools(r)('click_on_page', { text: 'Send' });
    expect(out.ok).toBe(false);
    expect(out.summary).toBe('needs confirmation');
    expect(out.error).toMatch(/sending or publishing something/);
  });
});

describe('verify_sent: clicking Send is not proof', () => {
  async function sent(behaviour: Behaviour, how: 'file' | 'message' = 'file') {
    const r = rig({ behaviour });
    await r.run('find_chat', { query: 'Rahul Sharma' });
    if (how === 'file') await r.run('attach_file', { path: PDF, confirm: true });
    const gate = r.gate;
    const tools = createBrowserTools(r.app, undefined, { chatGate: gate });
    await (tools.find((t) => t.schema.name === 'click_on_page') as Tool).execute({ text: 'Send', confirm: how === 'message' });
    return r;
  }

  it('sent: the file is in the conversation with a delivery mark and the preview is gone', async () => {
    const r = await sent('normal');
    const v = await r.run('verify_sent', {});
    expect(v.ok).toBe(true);
    expect(v.data).toMatchObject({ status: 'sent', mark: 'sent', file: 'report.pdf' });
  });

  it('sent: a typed message is checked by its words', async () => {
    const r = await sent('normal', 'message');
    const v = await r.run('verify_sent', { text: 'a typed message' });
    expect(v.data).toMatchObject({ status: 'sent' });
  });

  it('failed: the app shows a failure mark — it says it did NOT go', async () => {
    const r = await sent('fails');
    const v = await r.run('verify_sent', {});
    expect(v.ok).toBe(false);
    expect(v.data).toMatchObject({ status: 'failed', mark: 'failed to send' });
    expect(v.error).toMatch(/did NOT go/);
  });

  it('still pending: not reported as sent', async () => {
    const r = await sent('pending');
    const v = await r.run('verify_sent', {});
    expect(v.ok).toBe(false);
    expect(v.data).toMatchObject({ status: 'pending', mark: 'pending' });
  });

  it('in the chat but no delivery mark the page lets it read: "could not confirm", never "sent"', async () => {
    const r = await sent('no_marks');
    const v = await r.run('verify_sent', {});
    expect(v.ok).toBe(false);
    expect(v.data).toMatchObject({ status: 'unconfirmed' });
    expect(v.error).toMatch(/do not say it was sent/i);
  });

  it('in the chat, but the only mark on screen belongs to an OLD message: that is not proof this one went', async () => {
    const r = await sent('old_mark_only');
    const v = await r.run('verify_sent', {});
    expect(v.ok).toBe(false);
    expect(v.data).toMatchObject({ status: 'unconfirmed' });
  });

  it('the preview is still open (Send did not complete): not sent', async () => {
    const r = await sent('stays_in_preview');
    const v = await r.run('verify_sent', {});
    expect(v.ok).toBe(false);
    expect(v.data?.['status']).toBe('not_found');
  });

  it('an older message\'s "read" mark does not make a message that never appeared look sent', async () => {
    const r = rig();
    await r.run('find_chat', { query: 'Rahul Sharma' });
    const v = await r.run('verify_sent', { text: 'hello there' });
    expect(v.ok).toBe(false);
    expect(v.data?.['status']).toBe('not_found');
  });

  it('needs to know what was sent', async () => {
    const r = rig();
    expect((await r.run('verify_sent', {})).ok).toBe(false);
  });

  it('the yes is used up once it is sent, so the next send asks again', async () => {
    const r = await sent('normal');
    await r.run('verify_sent', {});
    expect(r.session.isAuthorized('Rahul Sharma', 'report.pdf')).toBe(false);
    expect(r.session.attachment()).toBeNull();
  });
});

describe('small things', () => {
  it('knows the type of a file by its name', () => {
    expect(mimeFor('a.PDF')).toBe('application/pdf');
    expect(mimeFor('a.zip')).toBe('application/zip');
    expect(mimeFor('a.jpeg')).toBe('image/jpeg');
    expect(mimeFor('a.unknown')).toBe('application/octet-stream');
    expect(mimeFor('noext')).toBe('application/octet-stream');
  });
});
