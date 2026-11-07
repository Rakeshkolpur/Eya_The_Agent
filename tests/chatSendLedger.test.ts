import { describe, expect, it } from 'vitest';
import { ChatSession } from '../src/main/chat/chatSession';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import { createBrowserTools } from '../src/main/tools/impl/browserTools';
import { createChatSendGate, createChatTools } from '../src/main/tools/impl/chatTools';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';
import { FakeChatApp, FakeDisk, ROWS } from './chatFixtures';
import type { Behaviour } from './chatFixtures';

/**
 * The model's own steps (not the fast layer) also never send a file twice on a guess: what is known about a send is kept by verify_sent, and the next
 * attach_file for the same file in the same chat says so, and verify_sent can look in the chat on purpose (recheck) before anything is attached again.
 */

const HOME = 'C:\\Users\\Test';
const folders: KnownFolders = { home: HOME, downloads: `${HOME}\\Downloads`, desktop: `${HOME}\\Desktop`, documents: `${HOME}\\Documents`, pictures: `${HOME}\\Pictures`, videos: `${HOME}\\Videos`, music: `${HOME}\\Music`, temp: HOME };
const PDF = `${HOME}\\Desktop\\report.pdf`;

function rig(behaviour: Behaviour = 'normal') {
  const app = new FakeChatApp(ROWS);
  app.behaviour = behaviour;
  const policy = new CommunicationPolicy(() => ({ enabled: true, apps: {} }));
  const session = new ChatSession();
  const disk = new FakeDisk({ [PDF]: { isFile: true, isDirectory: false, size: 10, content: Buffer.from('0123456789') } });
  const tools: Tool[] = [
    ...createChatTools({ service: app, policy, session, folders, files: disk, sleep: async () => undefined }),
    ...createBrowserTools(app, undefined, { chatGate: createChatSendGate(session, policy) }),
  ];
  const run = (name: string, args: ToolArgs = {}): Promise<ToolResult> => (tools.find((t) => t.schema.name === name) as Tool).execute(args);
  const sendFile = async (): Promise<ToolResult> => {
    await run('find_chat', { query: 'Rahul Sharma' });
    await run('attach_file', { path: PDF, confirm: true });
    await run('click_on_page', { text: 'Send' });
    return run('verify_sent', { name: 'report.pdf' });
  };
  return { app, session, run, sendFile };
}

describe('a file is not sent again on a guess (the model\'s own steps)', () => {
  it('a send that was not confirmed is said so when the same file is attached again, and the chat can be looked at first', async () => {
    const r = rig('no_marks');
    const first = await r.sendFile();
    expect(first.ok).toBe(false); // the file is in the chat but no delivery mark: not known
    expect(r.session.lastSend('Rahul Sharma', 'report.pdf')?.status).toBe('uncertain');

    const again = await r.run('attach_file', { path: PDF });
    expect(again.data?.['question']).toContain('not confirmed either way');
    expect(again.data?.['question']).toContain('verify_sent with recheck true');

    // looked at on purpose: it IS in the chat, so it is kept as "not confirmed" (the person is told), and nothing was attached again
    const look = await r.run('verify_sent', { name: 'report.pdf', recheck: true });
    expect(look.data?.['status']).toBe('unconfirmed');
    expect(r.app.thread.filter((m) => m.file === 'report.pdf')).toHaveLength(1);
  });

  it('a recheck that finds nothing in the chat means the earlier send did not go, so sending it is not a repeat', async () => {
    const r = rig('stays_in_preview'); // Send does nothing: the file never reaches the chat
    await r.sendFile();
    expect(r.session.lastSend('Rahul Sharma', 'report.pdf')?.status).toBe('uncertain');
    const look = await r.run('verify_sent', { name: 'report.pdf', recheck: true });
    expect(look.data?.['status']).toBe('not_found');
    expect(r.session.lastSend('Rahul Sharma', 'report.pdf')?.status).toBe('failed');
    const again = await r.run('attach_file', { path: PDF });
    expect(again.data?.['question']).not.toMatch(/earlier send|already sent/);
  });

  it('a file seen to have gone is said to have gone when it is attached again a little later', async () => {
    const r = rig();
    const ok = await r.sendFile();
    expect(ok.data?.['status']).toBe('sent');
    const again = await r.run('attach_file', { path: PDF });
    expect(again.data?.['question']).toContain('already sent to this chat a little while ago');
  });

  it('a different file, or a different chat, is not a repeat', async () => {
    const r = rig();
    await r.sendFile();
    await r.run('find_chat', { query: 'Priya Singh' });
    const other = await r.run('attach_file', { path: PDF });
    expect(other.data?.['question']).not.toMatch(/already sent|earlier send/);
  });
});
