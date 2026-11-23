import { describe, it, expect } from 'vitest';
import { buildImage } from '../src/renderer/liveProtocol';
import { LiveSession } from '../src/renderer/liveSession';
import type { SocketLike } from '../src/renderer/liveSession';
import type { LiveSetupOptions } from '../src/renderer/liveProtocol';
import { ScreenShare } from '../src/main/screen/screenShare';
import { cleanAskRequest } from '../src/main/screen/screenShareIpc';
import { createScreenShareTools } from '../src/main/tools/impl/screenShareTools';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { riskLevelFor } from '../src/main/permissions/PermissionManager';

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    /* nothing */
  }
}

const setup: LiveSetupOptions = { model: 'm', voice: 'Aoede', systemInstruction: 's', tools: [] };

describe('a picture sent to a live conversation', () => {
  it('is a realtime video input of type JPEG, carrying exactly the picture it was given', () => {
    expect(JSON.parse(buildImage('QUJD'))).toEqual({ realtimeInput: { video: { mimeType: 'image/jpeg', data: 'QUJD' } } });
  });

  it('is sent once the session is ready, and never before (nor after it is closed)', async () => {
    const socket = new FakeSocket();
    const session = new LiveSession(() => socket);
    session.sendImage('early');
    const opened = session.open('wss://x', setup);
    socket.onopen?.();
    session.sendImage('still setting up');
    socket.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
    await opened;
    const afterSetup = socket.sent.length;
    session.sendImage('QUJD');
    expect(socket.sent.length).toBe(afterSetup + 1);
    expect(JSON.parse(socket.sent[socket.sent.length - 1] ?? '{}').realtimeInput.video.data).toBe('QUJD');
    expect(socket.sent.some((s) => s.includes('early') || s.includes('still setting up'))).toBe(false);
    session.close();
    session.sendImage('after close');
    expect(socket.sent.some((s) => s.includes('after close'))).toBe(false);
  });
});

describe('what the page may ask about the screen', () => {
  it('only a known kind of question, with a short plain question', () => {
    expect(cleanAskRequest({ mode: 'analyze' })).toEqual({ mode: 'analyze' });
    expect(cleanAskRequest({ mode: 'ask', question: '  How do I download this?  ' })).toEqual({ mode: 'ask', question: 'How do I download this?' });
    expect(cleanAskRequest({ mode: 'next', question: 5 })).toEqual({ mode: 'next' });
    expect(cleanAskRequest({ mode: 'ask', question: 'x'.repeat(900) })?.question).toHaveLength(500);
    for (const bad of [null, undefined, 3, 'ask', [], {}, { mode: 'control' }, { mode: 7 }, { question: 'hi' }]) expect(cleanAskRequest(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe('starting and stopping sharing by voice', () => {
  function rig() {
    const log: string[] = [];
    const share = new ScreenShare({
      capture: async () => ({ bytes: Buffer.from('png') }),
      toFrame: () => ({ bytes: Buffer.from('j'), width: 1, height: 1 }),
      toAnswerImage: () => ({ bytes: Buffer.from('j'), mime: 'image/jpeg' }),
      windowTitles: async () => [],
      blockedBy: () => null,
      analyze: async () => 'ok',
      scrub: (t) => t,
      protectOwnWindows: (on) => void log.push(`protect ${on}`),
      emitFrame: () => undefined,
      emitStatus: () => undefined,
      schedule: () => 0, // the stream is not what is being tested here
      cancel: () => undefined,
    });
    const tools = new ToolRegistry();
    for (const t of createScreenShareTools(share)) tools.register(t);
    return { share, tools, log };
  }

  it('starting asks first: without a yes nothing is shared, and the question names what it means', async () => {
    const { share, tools } = rig();
    const asked = await tools.invoke('start_screen_share', {});
    expect(asked).toMatchObject({ ok: false, summary: 'needs confirmation', data: { status: 'permission_required', action: 'start_screen_share' } });
    expect(asked.error).toContain('Do you want to share your screen with me?');
    expect(asked.error).toContain('I will not save anything');
    expect(share.status().active).toBe(false);
    expect(await tools.invoke('start_screen_share', { confirm: false })).toMatchObject({ ok: false });
    expect(share.status().active).toBe(false);
  });

  it('after a clear yes it starts, hiding Eya\'s own windows, and tells the model how to behave', async () => {
    const { share, tools, log } = rig();
    const started = await tools.invoke('start_screen_share', { confirm: true });
    expect(started).toMatchObject({ ok: true, summary: 'sharing started', data: { sharing: true } });
    expect(String(started.data?.['note'])).toContain('never read out passwords');
    expect(share.status().active).toBe(true);
    expect(log).toEqual(['protect true']);
    expect(await tools.invoke('start_screen_share', {})).toMatchObject({ ok: true, summary: 'already sharing' });
  });

  it('stopping never needs a yes, and is harmless when nothing is shared', async () => {
    const { share, tools } = rig();
    expect(await tools.invoke('stop_screen_share', {})).toMatchObject({ ok: true, summary: 'was not sharing' });
    share.start();
    expect(await tools.invoke('stop_screen_share', {})).toMatchObject({ ok: true, summary: 'sharing stopped', data: { sharing: false } });
    expect(share.status()).toMatchObject({ active: false, stopped: 'user' });
  });

  it('is held to the permission model: starting is confirm-level, stopping is safe', () => {
    expect(riskLevelFor('start_screen_share')).toBe('confirm');
    expect(riskLevelFor('stop_screen_share')).toBe('safe');
  });
});
