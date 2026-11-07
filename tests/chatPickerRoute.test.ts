import { describe, expect, it } from 'vitest';
import { ChatSession } from '../src/main/chat/chatSession';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import { createChatTools, openChatIsWrong } from '../src/main/tools/impl/chatTools';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';
import { FakeDisk } from './chatFixtures';
import { FakeWhatsAppWeb, PICKER_CONTACTS } from './chatPickerFixtures';
import type { PickerContact } from './chatPickerFixtures';

/**
 * Sending a file through the app's own "Select chats" step, as the real WhatsApp Web page showed it: the file is given to the page with no chat open, the
 * person is typed and ticked in the step, Send is pressed there, and the app opens that person's chat. Also: a chat is never called open because a click was
 * made — the page has to show it. All against a mock of that page; none of this is evidence about the real one.
 */

const HOME = 'C:\\Users\\Test';
const folders: KnownFolders = { home: HOME, downloads: `${HOME}\\Downloads`, desktop: `${HOME}\\Desktop`, documents: `${HOME}\\Documents`, pictures: `${HOME}\\Pictures`, videos: `${HOME}\\Videos`, music: `${HOME}\\Music`, temp: HOME };
const PDF = `${HOME}\\Desktop\\report.pdf`;

function rig(contacts: readonly PickerContact[] = PICKER_CONTACTS, setup?: (app: FakeWhatsAppWeb) => void) {
  const app = new FakeWhatsAppWeb(contacts);
  setup?.(app);
  const policy = new CommunicationPolicy(() => ({ enabled: true, apps: {} }));
  const session = new ChatSession();
  const disk = new FakeDisk({ [PDF]: { isFile: true, isDirectory: false, size: 10, content: Buffer.from('0123456789') } });
  const tools: Tool[] = createChatTools({ service: app, policy, session, folders, files: disk, sleep: async () => undefined });
  const run = (name: string, args: ToolArgs = {}): Promise<ToolResult> => (tools.find((t) => t.schema.name === name) as Tool).execute(args);
  const share = (args: ToolArgs = {}): Promise<ToolResult> => run('share_file_to_chat', { path: PDF, ...args });
  return { app, session, run, share };
}

describe('share_file_to_chat: through "Select chats"', () => {
  it('an exact name, asked for in so many words, goes straight: typed in the picker, ticked, sent, checked in the chat', async () => {
    const r = rig();
    const out = await r.share({ to: 'Anna', authorized: true });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.data).toMatchObject({ status: 'sent', mark: 'sent', recipient: 'Anna', verifiedRecipient: true, via: 'select_chats' });
    expect(r.app.sentLog).toEqual([{ to: 'Anna', file: 'report.pdf' }]); // Anna, not Ramesh Anna or Naveen Anna, and once
    expect(r.app.searchTypes).toBe(0); // the left search box was never typed in
    expect(r.app.rowClicks).toBe(0); // and no chat row was clicked
    expect(r.app.pickerSearchTypes).toBe(1);
    expect(r.app.open?.name).toBe('Anna');
    expect(r.session.chat()).toMatchObject({ label: 'Anna', verified: true, headerChecked: true });
    expect(r.session.lastSend('Anna', 'report.pdf')?.status).toBe('sent');
  });

  it('without the user\'s own instruction it ticks the person and ASKS (nothing sent); a yes then sends it, without giving the file to the page again', async () => {
    const r = rig();
    const asked = await r.share({ to: 'Anna' });
    expect(asked.ok).toBe(false);
    expect(asked.summary).toBe('needs confirmation');
    expect(asked.data).toMatchObject({ status: 'ready_to_send', recipient: 'Anna', verified: true });
    expect(String(asked.data?.['question'])).toBe('Found Anna. Send the file "report.pdf" to Anna?');
    expect(r.app.sentLog).toEqual([]);
    expect(r.app.picker?.ticked.has('Anna')).toBe(true);

    const sent = await r.share({ to: 'Anna', confirm: true });
    expect(sent.data).toMatchObject({ status: 'sent', recipient: 'Anna' });
    expect(r.app.sentLog).toEqual([{ to: 'Anna', file: 'report.pdf' }]);
    expect(r.app.calls.filter((c) => c.startsWith('attach:'))).toHaveLength(1);
  });

  it('a likely match (not an exact name) still asks, even when the user said to send it', async () => {
    const r = rig();
    const out = await r.share({ to: 'Naveen', authorized: true });
    expect(out.ok).toBe(false);
    expect(out.data).toMatchObject({ status: 'ready_to_send', recipient: 'Naveen Anna', verified: false });
    expect(String(out.data?.['question'])).toContain('matched only on "Naveen", not an exact name');
    expect(r.app.sentLog).toEqual([]);
  });

  it('with several Annas and none exact it asks which, once, and sends nothing; the choice is then the person', async () => {
    const r = rig([{ name: 'Ramesh Anna', phone: '+91 90000 22222' }, { name: 'Anna Reddy', phone: '+91 91111 33333' }, { name: 'Anna Kumar', phone: '+91 93333 55555' }]);
    const asked = await r.share({ to: 'Anna', authorized: true });
    expect(asked.data).toMatchObject({ status: 'ambiguous' });
    expect((asked.data?.['candidates'] as Array<{ label: string }>).map((c) => c.label).sort()).toEqual(['Anna Kumar', 'Anna Reddy', 'Ramesh Anna']);
    expect(r.app.sentLog).toEqual([]);
    expect(r.app.picker?.ticked.size).toBe(0);

    const choice = (asked.data?.['candidates'] as Array<{ label: string; choice: number }>).find((c) => c.label === 'Anna Reddy')?.choice;
    const out = await r.share({ choice: choice as number, authorized: true });
    expect(out.data).toMatchObject({ status: 'sent', recipient: 'Anna Reddy' });
    expect(r.app.sentLog).toEqual([{ to: 'Anna Reddy', file: 'report.pdf' }]);
  });

  it('nobody matching: says so, sends nothing, and makes up no number', async () => {
    const r = rig();
    const out = await r.share({ to: 'Zoya', authorized: true });
    expect(out.ok).toBe(true);
    expect(out.data?.['status']).toBe('none');
    expect(JSON.stringify(out)).not.toMatch(/\+?\d[\d\s]{9,}/); // no phone number anywhere in what is handed back
    expect(r.app.sentLog).toEqual([]);
  });

  it('a person already ticked in a forgotten picker is never sent to: the picker is closed and nothing goes', async () => {
    const r = rig();
    // a picker left open by an earlier attempt, with the SAME file waiting and somebody else ticked
    await r.share({ to: 'Anna' }); // opens it, ticks Anna, asks
    r.app.picker?.ticked.clear();
    r.app.picker?.ticked.add('Mum');
    const out = await r.share({ to: 'Anna', authorized: true });
    expect(out.ok).toBe(false);
    expect(out.data?.['status']).toBe('stale_selection');
    expect(r.app.picker).toBeNull();
    expect(r.app.sentLog).toEqual([]);
  });

  it('with a chat open it leaves it first (Escape), because a file given to the page then goes to THAT chat', async () => {
    const r = rig(PICKER_CONTACTS, (a) => {
      a.open = PICKER_CONTACTS[4] as PickerContact; // some other chat is open
    });
    const out = await r.share({ to: 'Anna', authorized: true });
    expect(out.data).toMatchObject({ status: 'sent', recipient: 'Anna' });
    expect(r.app.escapes).toBe(1);
    expect(r.app.reloads).toBe(0);
    expect(r.app.sentLog).toEqual([{ to: 'Anna', file: 'report.pdf' }]); // nothing reached the chat that had been open
  });

  it('if Escape does not close the chat, the page is loaded again; if even that leaves it open, nothing is given to the page', async () => {
    const reload = rig(PICKER_CONTACTS, (a) => {
      a.open = PICKER_CONTACTS[4] as PickerContact;
      a.escapeDoesNothing = true;
    });
    expect((await reload.share({ to: 'Anna', authorized: true })).data).toMatchObject({ status: 'sent' });
    expect(reload.app.reloads).toBe(1);

    const stuck = rig(PICKER_CONTACTS, (a) => {
      a.open = PICKER_CONTACTS[4] as PickerContact;
      a.escapeDoesNothing = true;
      a.reopenAfterReload = true;
    });
    const out = await stuck.share({ to: 'Anna', authorized: true });
    expect(out.ok).toBe(false);
    expect(out.data?.['status']).toBe('chat_stays_open');
    expect(stuck.app.calls.some((c) => c.startsWith('attach:'))).toBe(false);
    expect(stuck.app.sentLog).toEqual([]);
  });

  it('a row that does not tick when clicked is ticked by its own tick box; if nothing ticks, nothing is sent and the picker is closed', async () => {
    const viaBox = rig(PICKER_CONTACTS, (a) => {
      a.rowClickDoesNotTick = true;
    });
    expect((await viaBox.share({ to: 'Anna', authorized: true })).data).toMatchObject({ status: 'sent', recipient: 'Anna' });
    expect(viaBox.app.calls.some((c) => c === 'clickItem:dialog:checkbox:Anna')).toBe(true);

    const never = rig(PICKER_CONTACTS, (a) => {
      a.nothingTicks = true;
    });
    const out = await never.share({ to: 'Anna', authorized: true });
    expect(out.ok).toBe(false);
    expect(out.data?.['status']).toBe('not_selected');
    expect(never.app.picker).toBeNull();
    expect(never.app.sentLog).toEqual([]);
  });

  it('Send that does nothing is not "sent": the send is kept as not known, and asking again never sends it on a guess', async () => {
    const r = rig(PICKER_CONTACTS, (a) => {
      a.sendDoesNothing = true;
    });
    const out = await r.share({ to: 'Anna', authorized: true });
    expect(out.ok).toBe(false);
    expect(out.data?.['status']).toBe('send_not_seen');
    expect(r.session.lastSend('Anna', 'report.pdf')?.status).toBe('uncertain');
    const again = await r.share({ to: 'Anna', authorized: true });
    expect(again.ok).toBe(false);
    expect(again.summary).toBe('needs confirmation'); // an earlier send that was not confirmed: asked, not sent
    expect(String(again.data?.['question'])).toContain('not confirmed either way');
    expect(r.app.sendClicks).toBe(1);
  });

  it('says what the page showed: a delivery mark names how far it got, and a file with no mark is "in the chat" and not "sent"', async () => {
    const delivered = rig(PICKER_CONTACTS, (a) => {
      a.marks = 'delivered';
    });
    expect((await delivered.share({ to: 'Anna', authorized: true })).data).toMatchObject({ status: 'sent', mark: 'delivered' });

    const none = rig(PICKER_CONTACTS, (a) => {
      a.marks = 'none';
    });
    const out = await none.share({ to: 'Anna', authorized: true });
    expect(out.ok).toBe(false);
    expect(out.data?.['status']).not.toBe('sent');
    expect(none.app.sentLog).toEqual([{ to: 'Anna', file: 'report.pdf' }]); // it did go, the page just did not say so: reported as unconfirmed, never as sent
    expect(none.session.lastSend('Anna', 'report.pdf')?.status).toBe('uncertain');
  });

  it('a page with no file input at home says so (so the caller can use the other way), and nothing is sent', async () => {
    const r = rig(PICKER_CONTACTS, (a) => {
      a.noGlobalInput = true;
    });
    const out = await r.share({ to: 'Anna', authorized: true });
    expect(out.ok).toBe(false);
    expect(out.data).toMatchObject({ status: 'not_attached', reason: 'no_file_input' });
  });

  it('cancel closes the picker without sending', async () => {
    const r = rig();
    await r.share({ to: 'Anna' });
    const out = await r.share({ cancel: true });
    expect(out.data?.['status']).toBe('cancelled');
    expect(r.app.picker).toBeNull();
    expect(r.app.sentLog).toEqual([]);
  });

  it('a whole phone number is an identity; the end of a number is only a likely match', async () => {
    const whole = rig();
    expect((await whole.share({ to: '+91 92222 44444', authorized: true })).data).toMatchObject({ status: 'sent', recipient: 'Anna', verifiedRecipient: true });
    const part = rig();
    const out = await part.share({ to: 'ending 44444', authorized: true });
    expect(out.data).toMatchObject({ status: 'ready_to_send', verified: false });
    expect(part.app.sentLog).toEqual([]);
  });

  it('is refused for an app that is switched off', async () => {
    const r = rig(PICKER_CONTACTS, (a) => {
      a.accessOff = true;
    });
    const out = await r.share({ to: 'Anna', authorized: true });
    expect(out.ok).toBe(false);
    expect(out.data).toMatchObject({ communicationAccess: 'off' });
  });
});

describe('a chat is open only when the page says so', () => {
  it('a click that opened nothing is NOT "opened": the message box never appeared, and nothing is claimed', async () => {
    const r = rig(PICKER_CONTACTS, (a) => {
      a.rowClickDoesNothing = true;
    });
    const out = await r.run('find_chat', { query: 'Anna' });
    expect(out.ok).toBe(false);
    expect(out.data).toMatchObject({ status: 'not_opened' });
    expect(r.session.chat()).toBeNull();
    expect(r.app.searchTypes).toBe(1); // searched once, however many times it was looked at
  });

  it('opened: the message box names the chat ("Type a message to Anna"), which is the proof, and the exact name is verified', async () => {
    const r = rig();
    const out = await r.run('find_chat', { query: 'Anna' });
    expect(out.data).toMatchObject({ status: 'opened', chat: 'Anna', verified: true, headerChecked: true });
    expect(r.session.chat()).toMatchObject({ label: 'Anna', headerChecked: true, proof: 'composer' });
  });

  it('asked for again, the open chat is not searched for or clicked again', async () => {
    const r = rig();
    await r.run('find_chat', { query: 'Anna' });
    const clicks = r.app.rowClicks;
    const again = await r.run('find_chat', { query: 'Anna' });
    expect(again.data).toMatchObject({ status: 'opened', alreadyOpen: true });
    expect(r.app.rowClicks).toBe(clicks);
  });

  it('the page showing a different chat (a box that names Ramesh Anna) is the wrong chat for "Anna": a Send there is refused', async () => {
    const r = rig();
    await r.run('find_chat', { query: 'Anna' });
    r.app.open = PICKER_CONTACTS[1] as PickerContact; // the user clicked Ramesh Anna meanwhile
    expect(openChatIsWrong(r.session, r.app.snapshot())).toBe(true);
    const attach = await r.run('attach_file', { path: PDF, confirm: true });
    expect(attach.data).toMatchObject({ status: 'wrong_chat' });
  });

  it('a "Select chats" popup left open is closed before searching, and its names are never taken for an open chat', async () => {
    const r = rig();
    await r.share({ to: 'Anna' }); // leaves the picker open, with Anna ticked
    expect(r.app.picker).not.toBeNull();
    const out = await r.run('find_chat', { query: 'Anna' });
    expect(out.data).toMatchObject({ status: 'opened', chat: 'Anna' });
    expect(r.app.picker).toBeNull();
    expect(r.app.sentLog).toEqual([]);
  });

  it('attach_file with no chat open does not hand the file to the app\'s picker: it points to share_file_to_chat', async () => {
    const r = rig();
    const out = await r.run('attach_file', { path: PDF, confirm: true });
    expect(out.ok).toBe(false);
    expect(out.data).toMatchObject({ status: 'no_chat_open', use: 'share_file_to_chat' });
    expect(r.app.picker).toBeNull();
  });

  it('the left search box is still recognised once something is typed in it (the page then names it only by its id)', async () => {
    const r = rig();
    r.app.search = 'an'; // the box now reads "_r_a_"
    const out = await r.run('find_chat', { query: 'Anna' });
    expect(out.data?.['status']).toBe('opened'); // not "still loading"
  });
});
