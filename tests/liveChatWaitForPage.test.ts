import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
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
import type { ToolArgs, ToolResult } from '../src/main/tools/types';
import { FakeSwitch, rig, settle } from './liveChatFixtures';
import type { Rig, RigOptions } from './liveChatFixtures';

/**
 * "If I type 'do live chat', she should say: OK Rakesh, wait, I opened it here — scan it. And wait, like a live person." WhatsApp Web asks for its QR code (or is still loading): the live chat
 * does not give up and ask to be started again; it says so out loud, looks again every few seconds, and goes on by itself when WhatsApp is ready. Over a MOCK page.
 */

const LOGIN = { kind: 'login', say: 'WhatsApp is asking you to log in with a QR code.' } as const;
const LOADING = { kind: 'loading', say: 'WhatsApp has not finished loading.' } as const;

function made(options: RigOptions = {}): Rig {
  const sw = new FakeSwitch();
  return rig({ enable: sw.control, ...options });
}

const live = (r: Rig) => r.said.filter((s) => s.kind === 'live').map((s) => s.spoken);

describe('WhatsApp shows its QR code: Eya says so, waits, and carries on by herself', () => {
  it('says "wait, I opened WhatsApp here, scan the QR" once, and the chat is waiting for the person — not failed', async () => {
    const r = made();
    r.chat.openQueue.push(LOGIN);
    const done = await r.controller.handle({ kind: 'start', name: 'Rahul Sharma', mode: 'assisted' });
    expect(r.controller.state).toBe('WAITING_FOR_USER');
    expect(done.ok, done.message).toBe(true);
    expect(done.message).toMatch(/QR code/);
    expect(done.message).toMatch(/I carry on by myself/);
    expect(live(r)).toEqual(['Rakesh, wait: I have opened WhatsApp here and it is asking for the QR code. Scan it with your phone (WhatsApp, then Linked devices, then Link a device) and I will carry on by myself.']);
    expect(r.alerts.some((a) => /scan its QR code/.test(a))).toBe(true);
    expect(r.chat.pressed).toEqual([]);
  });

  it('after the scan she opens the chat by herself, says it is connected, and the live chat is on', async () => {
    const r = made();
    r.chat.openQueue.push(LOGIN);
    await r.controller.handle({ kind: 'start', name: 'Rahul Sharma', mode: 'assisted' });
    expect(r.chat.opens).toBe(1);
    r.advance(3_100); // (the person scans; the next look finds the chat)
    await settle(40);
    expect(r.chat.opens).toBe(2);
    expect(r.controller.state).toBe('ACTIVE');
    expect(live(r)[1]).toBe('Okay Rakesh, WhatsApp is connected. I am opening the chat now.');
    expect(r.controller.view().verified).toBe(true);
  });

  it('while the code is not scanned she looks again every few seconds, and says it only once', async () => {
    const r = made();
    r.chat.openQueue.push(LOGIN, LOGIN, LOGIN);
    await r.controller.handle({ kind: 'start', name: 'Rahul Sharma', mode: 'assisted' });
    for (let i = 0; i < 3; i += 1) {
      r.advance(3_100);
      await settle(40);
    }
    expect(r.chat.opens).toBe(4);
    expect(r.controller.state).toBe('ACTIVE');
    expect(live(r)).toHaveLength(2); // (the wait, and the "connected")
  });

  it('five minutes without the scan: she says so and stops looking (nothing was sent, nothing was watched)', async () => {
    const r = made({ loginWaitMs: 10_000 });
    r.chat.openOutcome = LOGIN;
    await r.controller.handle({ kind: 'start', name: 'Rahul Sharma', mode: 'assisted' });
    for (let i = 0; i < 6; i += 1) {
      r.advance(3_100);
      await settle(40);
    }
    expect(r.controller.state).toBe('FAILED');
    expect(r.controller.view().error ?? '').toMatch(/not signed in within five minutes/);
    const opens = r.chat.opens;
    r.advance(30_000);
    await settle(20);
    expect(r.chat.opens).toBe(opens);
    expect(r.chat.pressed).toEqual([]);
  });

  it('"stop" while she waits ends it, and she does not look again', async () => {
    const r = made();
    r.chat.openOutcome = LOGIN;
    await r.controller.handle({ kind: 'start', name: 'Rahul Sharma', mode: 'assisted' });
    await r.controller.handle({ kind: 'stop' });
    const opens = r.chat.opens;
    r.advance(30_000);
    await settle(20);
    expect(r.chat.opens).toBe(opens);
    expect(r.controller.view().active).toBe(false);
  });

  it('a new live chat does not inherit the old wait', async () => {
    const r = made();
    r.chat.openOutcome = LOGIN;
    await r.controller.handle({ kind: 'start', name: 'Rahul Sharma', mode: 'assisted' });
    await r.controller.handle({ kind: 'stop' });
    r.chat.openOutcome = { kind: 'opened', label: 'Rahul Sharma', verified: true };
    await r.controller.handle({ kind: 'start', name: 'Rahul Sharma', mode: 'assisted' });
    await settle(40);
    expect(r.controller.state).toBe('ACTIVE');
    expect(live(r)).toHaveLength(1); // (only the first wait was said: the second start had nothing to wait for)
  });
});

describe('WhatsApp is still loading: she waits for it too', () => {
  it('says so, looks again, and goes on when it is ready', async () => {
    const r = made();
    r.chat.openQueue.push(LOADING);
    await r.controller.handle({ kind: 'start', name: 'Rahul Sharma', mode: 'assisted' });
    expect(r.controller.state).toBe('WAITING_FOR_USER');
    expect(live(r)[0]).toBe('Rakesh, wait a moment: WhatsApp is still loading here. I will carry on as soon as it is ready.');
    r.advance(3_100);
    await settle(40);
    expect(r.controller.state).toBe('ACTIVE');
    expect(live(r)[1]).toBe('Okay Rakesh, WhatsApp is ready. I am opening the chat now.');
  });

  it('gives up after a minute and a half, and says why', async () => {
    const r = made({ loadingWaitMs: 9_000 });
    r.chat.openOutcome = LOADING;
    await r.controller.handle({ kind: 'start', name: 'Rahul Sharma', mode: 'assisted' });
    for (let i = 0; i < 5; i += 1) {
      r.advance(3_100);
      await settle(40);
    }
    expect(r.controller.state).toBe('FAILED');
    expect(r.controller.view().error ?? '').toMatch(/did not finish loading/);
  });
});

describe('typed or spoken to Eya', () => {
  let dir: string;
  let db: Sql;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eya-wait-'));
    db = openDatabase(join(dir, 'memory.db'));
    migrate(db, MIGRATIONS);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('"do live chat with Rahul" answers that she is waiting for the scan (not that it failed), in words she can say', async () => {
    const r = made();
    r.chat.openQueue.push(LOGIN);
    const cc = new ChatCommands({
      tools: { invoke: async (_n: string, _a: ToolArgs): Promise<ToolResult> => ({ ok: false, summary: 'unused', error: 'unused' }) },
      contacts: new ContactBook(db),
      policy: new CommunicationPolicy(() => ({ enabled: true, apps: {} })),
      session: new ChatSession(),
      confirmSends: 'unless_verified',
      fileRoute: 'chat',
      liveChat: r.controller,
      sleep: async () => undefined,
      now: () => r.clock.now,
    });
    const out = await cc.tryHandle('do live chat with Rahul Sharma');
    expect(out, 'handled here').not.toBeNull();
    expect(out?.ok, out?.spoken).toBe(true);
    expect(out?.spoken).toMatch(/QR code/);
    expect(out?.spoken).toMatch(/I carry on by myself/);
    expect(r.controller.state).toBe('WAITING_FOR_USER');
  });
});
