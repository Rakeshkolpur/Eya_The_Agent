import { describe, expect, it } from 'vitest';
import { ChatSession } from '../src/main/chat/chatSession';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import { createChatTools } from '../src/main/tools/impl/chatTools';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';
import { DOCS, FakeMediaApp } from './chatMediaFixtures';
import type { FakeDoc } from './chatMediaFixtures';
import { FakeDisk } from './chatFixtures';

const HOME = 'C:\\Users\\Test';
const folders: KnownFolders = { home: HOME, downloads: `${HOME}\\Downloads`, desktop: `${HOME}\\Desktop`, documents: `${HOME}\\Documents`, pictures: `${HOME}\\Pictures`, videos: `${HOME}\\Videos`, music: `${HOME}\\Music`, temp: HOME };
/** Tuesday 27 October 2026, midday. */
const NOW = new Date(2026, 9, 27, 12, 0, 0).getTime();

function rig(docs: readonly FakeDoc[] = DOCS) {
  const app = new FakeMediaApp(docs);
  const policy = new CommunicationPolicy(() => ({ enabled: true, apps: {} }));
  const tools = createChatTools({ service: app, policy, session: new ChatSession(), folders, files: new FakeDisk(), sleep: async () => undefined, now: () => NOW });
  const tool = tools.find((t) => t.schema.name === 'find_chat_files');
  if (tool === undefined) throw new Error('find_chat_files is not registered');
  const find = (args: ToolArgs): Promise<ToolResult> => tool.execute(args);
  return { app, find };
}

const files = (r: ToolResult): string[] => ((r.data?.['files'] as Array<{ file: string }> | undefined) ?? []).map((f) => f.file);

describe('find_chat_files: one file, found and its chat opened', () => {
  it('finds the file I sent, opens its chat at the message, and says which chat', async () => {
    const { app, find } = rig();
    const r = await find({ file: 'resume pdf', direction: 'sent' });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ status: 'found', count: 1, located: true, chat: 'Anna Reddy' });
    expect(files(r)).toEqual(['Resume Rakesh.pdf']);
    expect(String(r.data?.['say'])).toBe('“Resume Rakesh.pdf” (PDF, 3 MB) — you sent it Thursday, in your chat with Anna Reddy. I have opened that chat on the file.');
    // the chat is now open at the file, and the only menu entry pressed was "Go to message" — never Forward, Star, Reply or Delete
    expect(app.chat).toBe('Anna Reddy');
    expect(app.pressed).toEqual(['Go to message']);
  });

  it('a chat named in the message box by its phone number is said with the number hidden', async () => {
    const { app, find } = rig();
    app.composerAsNumber = '+91 93611 13900';
    const r = await find({ file: 'resume' });
    expect(r.data?.['chat']).toMatch(/^\+91 .*3900$|\*/);
    expect(JSON.stringify(r.data)).not.toContain('93611 13900');
  });

  it('with open: false it only looks — no menu is touched, no chat is opened', async () => {
    const { app, find } = rig();
    const r = await find({ file: 'resume', open: false });
    expect(r.data).toMatchObject({ status: 'found', count: 1, located: false });
    expect(app.pressed).toEqual([]);
    expect(app.chat).toBeNull();
    expect(app.calls.some((c) => c.startsWith("click:Message's context menu"))).toBe(false);
    expect(app.panelOpen).toBe(false); // the list is closed again
  });
});

describe('find_chat_files: which chat — never a guess', () => {
  it('the list is narrowed to the one file before its menu is opened (exactly one row is showing)', async () => {
    const { app, find } = rig();
    await find({ file: 'resume pdf' });
    expect(app.rowsWhenMenuOpened).toEqual([1]);
  });

  it('a chat that was already open is not taken for the answer: the one the file is in is', async () => {
    const { app, find } = rig();
    app.chat = 'Priya Singh';
    const r = await find({ file: 'resume' });
    expect(r.data).toMatchObject({ located: true, chat: 'Anna Reddy' });
  });

  it('the file is in the very chat that is already open: its message is in view, so that chat is named', async () => {
    const { app, find } = rig();
    app.chat = 'Anna Reddy';
    const r = await find({ file: 'resume' });
    expect(r.data).toMatchObject({ located: true, chat: 'Anna Reddy' });
  });

  it('"Go to message" that moves nowhere does not name the chat that happened to be open', async () => {
    const { app, find } = rig();
    app.chat = 'Priya Singh';
    app.gotoDoesNothing = true;
    const r = await find({ file: 'resume' });
    expect(r.data).toMatchObject({ located: false, notLocated: 'no_chat' });
    expect(JSON.stringify(r.data)).not.toContain('Priya Singh');
    expect(String(r.data?.['say'])).toMatch(/could not read which chat it is in/);
  });

  it('a second copy that only shows once the list is narrowed to the whole name still stops it: no chat is named', async () => {
    const twice: FakeDoc[] = [
      { file: 'Resume Rakesh.pdf', type: 'PDF', size: '3 MB', sender: 'You', when: 'Today at 09:10', chat: 'Anna Reddy' },
      { file: 'Resume Rakesh.pdf', type: 'PDF', size: '3 MB', sender: 'You', when: 'Yesterday at 11:00', chat: 'Ravi Kumar' },
    ];
    const { app, find } = rig(twice);
    app.hideCopiesUntilExact = true;
    const r = await find({ file: 'resume' });
    expect(r.data).toMatchObject({ located: false, notLocated: 'copies' });
    expect(app.chat).toBeNull();
    expect(app.rowsWhenMenuOpened).toEqual([]);
  });

  it('a list that will not narrow to the file is not guessed at: no menu is opened', async () => {
    const { app, find } = rig();
    app.searchIgnored = true;
    const r = await find({ file: 'resume' });
    expect(files(r)).toEqual(['Resume Rakesh.pdf']); // still found: the rows are judged here
    expect(r.data).toMatchObject({ located: false, notLocated: 'no_menu' });
    expect(app.rowsWhenMenuOpened).toEqual([]);
    expect(app.pressed).toEqual([]);
  });
});

describe('find_chat_files: judged here, not by the page', () => {
  it('a time window keeps only what was sent then ("yesterday")', async () => {
    const { find } = rig();
    const r = await find({ when: 'yesterday' });
    expect(files(r)).toEqual(['Bail petition draft.docx']);
  });

  it('"last week or so" reaches back to the start of last week and no further', async () => {
    const { find } = rig();
    const r = await find({ when: 'last week', open: false });
    expect(files(r)).toEqual(['Fee receipts.xlsx', 'Bail petition draft.docx', 'Resume Rakesh.pdf']); // newest first; the file of 21 September is out
    expect(r.data?.['window']).toBe('last week or so (19 Oct – 27 Oct)');
  });

  it('direction "received" and a sender narrow it', async () => {
    const { find } = rig();
    expect(files(await find({ direction: 'received' }))).toEqual(['Bail petition draft.docx']);
    expect(files(await find({ from: 'anna' }))).toEqual(['Bail petition draft.docx']);
  });

  it('several fit: it lists them (newest first), asks for more, and opens nothing', async () => {
    const { app, find } = rig();
    const r = await find({ direction: 'sent' });
    expect(files(r)).toEqual(['Fee receipts.xlsx', 'Resume Rakesh.pdf', 'Agreement final.pdf']);
    expect(String(r.data?.['say'])).toMatch(/^I found 3 files: 1\. “Fee receipts\.xlsx” — you sent it Today at 09:10; 2\. “Resume Rakesh\.pdf” — you sent it Thursday; 3\. “Agreement final\.pdf” — you sent it 21\/09\/2026\. Which one\?/);
    expect(app.pressed).toEqual([]);
    expect(app.chat).toBeNull();
    expect(app.panelOpen).toBe(false);
  });

  it('a word in the caption finds the file', async () => {
    const { find } = rig();
    expect(files(await find({ file: 'page 3', open: false }))).toEqual(['Bail petition draft.docx']);
  });

  it('documents in the OPEN CHAT’s own messages are not rows of the list', async () => {
    const { app, find } = rig();
    app.chat = 'Anna Reddy';
    app.bubbles = [{ file: 'Ghost file.pdf', type: 'PDF', size: '1 MB' }];
    const r = await find({ direction: 'sent', open: false });
    expect(files(r)).not.toContain('Ghost file.pdf');
    expect(r.data?.['scanned']).toBe(4);
  });
});

describe('find_chat_files: when nothing is found, or the page is unhelpful', () => {
  it('none: says so, and says how far back the list went when that is short of the time asked', async () => {
    const { find } = rig([{ file: 'Fee receipts.xlsx', type: 'XLSX', size: '1.2 MB', sender: 'You', when: 'Today at 09:10', chat: 'Priya Singh' }]);
    const r = await find({ file: 'resume', when: 'last month' });
    expect(r.data).toMatchObject({ status: 'none', count: 0, reachedBack: false });
    expect(String(r.data?.['say'])).toMatch(/I did not find a file like “resume” from last month \(1 Sep – 30 Sep\) in WhatsApp's documents\. WhatsApp's list only went back to Today at 09:10/);
  });

  it('the list’s own search that shows nothing is not trusted: the whole list is read and judged here', async () => {
    const { app, find } = rig();
    app.searchBroken = true;
    const r = await find({ file: 'resume', open: false });
    expect(files(r)).toEqual(['Resume Rakesh.pdf']);
    expect(app.calls.filter((c) => c === 'click:Media').length).toBe(2); // opened again for the unfiltered read
  });

  it('the same file sent more than once: the chats cannot be told apart, so none is opened', async () => {
    const twice: FakeDoc[] = [
      { file: 'Resume Rakesh.pdf', type: 'PDF', size: '3 MB', sender: 'You', when: 'Today at 09:10', chat: 'Anna Reddy' },
      { file: 'Resume Rakesh.pdf', type: 'PDF', size: '3 MB', sender: 'You', when: 'Yesterday at 11:00', chat: 'Ravi Kumar' },
    ];
    const { app, find } = rig(twice);
    const r = await find({ file: 'resume' });
    expect(r.data).toMatchObject({ status: 'found', count: 2 });
    expect(app.chat).toBeNull();
    expect(app.pressed).toEqual([]);
  });

  it('a one-file match whose copies are two rows says so and opens no chat', async () => {
    const twice: FakeDoc[] = [
      { file: 'Resume Rakesh.pdf', type: 'PDF', size: '3 MB', sender: 'You', when: 'Today at 09:10', chat: 'Anna Reddy' },
      { file: 'Resume Rakesh.pdf', type: 'PDF', size: '3 MB', sender: 'Anna Reddy', when: 'Yesterday at 11:00', chat: 'Anna Reddy' },
    ];
    const { app, find } = rig(twice);
    const r = await find({ file: 'resume', direction: 'sent' });
    expect(r.data).toMatchObject({ count: 1, located: false, notLocated: 'copies' });
    expect(app.chat).toBeNull();
  });

  it('a menu without "Go to message" is closed and nothing else in it is pressed', async () => {
    const { app, find } = rig();
    app.noGoto = true;
    const r = await find({ file: 'resume' });
    expect(r.data).toMatchObject({ located: false, notLocated: 'no_menu' });
    expect(app.pressed).toEqual([]);
    expect(app.calls).toContain('escape');
    expect(app.chat).toBeNull();
  });

  it('asks for something to look for', async () => {
    const { find } = rig();
    expect((await find({})).ok).toBe(false);
    expect((await find({ when: 'whenever' })).ok).toBe(false);
  });
});

describe('find_chat_files: the app and the rules', () => {
  it('refuses while Communication Access is off, and touches nothing', async () => {
    const { app, find } = rig();
    app.accessOff = true;
    const r = await find({ file: 'resume' });
    expect(r.ok).toBe(false);
    expect(app.calls.filter((c) => c.startsWith('click:'))).toEqual([]);
  });

  it('not a chat app: says so, does nothing', async () => {
    const { app, find } = rig();
    app.url = 'https://example.com/';
    const r = await find({ file: 'resume' });
    expect(r.summary).toBe('not a chat app');
    expect(app.calls.filter((c) => c.startsWith('click:'))).toEqual([]);
  });

  it('a log-in screen and a page still loading are said, not "no file"', async () => {
    const a = rig();
    a.app.loginScreen = true;
    expect((await a.find({ file: 'resume' })).data).toMatchObject({ status: 'needs_login' });
    const b = rig();
    b.app.loadingFor = 5;
    expect((await b.find({ file: 'resume' })).data).toMatchObject({ status: 'loading' });
  });

  it('Telegram has no such list: said plainly', async () => {
    const { app, find } = rig();
    app.url = 'https://web.telegram.org/a/';
    const r = await find({ file: 'resume' });
    expect(r.data).toMatchObject({ status: 'unsupported' });
    expect(String(r.data?.['say'])).toMatch(/only look for files in WhatsApp/);
  });

  it('never hands back captions, and says the chat only when the page showed it', async () => {
    const { find } = rig();
    const r = await find({ file: 'bail', open: false });
    expect(JSON.stringify(r.data)).not.toContain('page 3');
  });
});
