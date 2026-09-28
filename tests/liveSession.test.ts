import { describe, it, expect } from 'vitest';
import { LiveOpenError, LiveSession } from '../src/renderer/liveSession';
import type { LiveCloseInfo, SocketLike } from '../src/renderer/liveSession';
import type { LiveEvent, LiveSetupOptions } from '../src/renderer/liveProtocol';

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  receive(message: unknown, asBlob = false): void {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    this.onmessage?.({ data: asBlob ? new Blob([text]) : text });
  }
  drop(code: number, reason = ''): void {
    this.onclose?.({ code, reason });
  }
}

const setup: LiveSetupOptions = { model: 'm', voice: 'Aoede', systemInstruction: 's', tools: [] };
const tick = () => new Promise((r) => setTimeout(r, 5));

function session() {
  const socket = new FakeSocket();
  const s = new LiveSession(() => socket);
  const events: LiveEvent[] = [];
  const closes: LiveCloseInfo[] = [];
  s.onEvent((e) => events.push(e));
  s.onClose((c) => closes.push(c));
  return { socket, s, events, closes };
}

async function openReady() {
  const ctx = session();
  const opened = ctx.s.open('wss://x', setup);
  ctx.socket.open();
  ctx.socket.receive({ setupComplete: {} });
  await opened;
  return ctx;
}

describe('opening a session', () => {
  it('sends the setup once the socket opens, and is ready when the server confirms', async () => {
    const { socket, s } = session();
    const opened = s.open('wss://x', setup);
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(JSON.parse(socket.sent[0] ?? '{}').setup.model).toBe('models/m');
    expect(s.isOpen).toBe(false);
    socket.receive({ setupComplete: {} });
    await opened;
    expect(s.isOpen).toBe(true);
  });

  it('fails with the server\'s own reason if it hangs up before it is ready (e.g. quota)', async () => {
    const { socket, s } = session();
    const opened = s.open('wss://x', setup);
    socket.open();
    socket.drop(1011, 'Resource has been exhausted');
    await expect(opened).rejects.toMatchObject({ kind: 'closed', code: 1011, reason: 'Resource has been exhausted' });
    expect(s.isOpen).toBe(false);
  });

  it('fails on a connection error, and on a timeout', async () => {
    const a = session();
    const errored = a.s.open('wss://x', setup);
    a.socket.onerror?.({});
    await expect(errored).rejects.toBeInstanceOf(LiveOpenError);

    const b = session();
    await expect(b.s.open('wss://x', setup, 20)).rejects.toMatchObject({ kind: 'timeout' });
    expect(b.socket.closed).toBe(true); // does not leave a socket dangling
  });

  it('fails cleanly if the socket cannot even be created', async () => {
    const s = new LiveSession(() => {
      throw new Error('blocked');
    });
    await expect(s.open('wss://x', setup)).rejects.toMatchObject({ kind: 'error' });
  });

  it('ignores a late setup message after it already failed', async () => {
    const { socket, s } = session();
    const opened = s.open('wss://x', setup, 20);
    await expect(opened).rejects.toBeInstanceOf(LiveOpenError);
    socket.receive({ setupComplete: {} }); // handlers were detached; must not throw
    await tick();
    expect(s.isOpen).toBe(false);
  });
});

describe('a live session', () => {
  it('turns server messages into events, including ones the browser delivers as Blobs, in order', async () => {
    const { socket, events } = await openReady();
    socket.receive({ serverContent: { inputTranscription: { text: 'open notepad' } } }, true); // slow to read
    socket.receive({ toolCall: { functionCalls: [{ id: 'a', name: 'open_application', args: { name: 'notepad' } }] } });
    socket.receive({ serverContent: { turnComplete: true } }, true);
    await tick();
    expect(events.map((e) => e.type)).toEqual(['setupComplete', 'heard', 'toolCall', 'turnComplete']);
  });

  it('sends audio and tool results, but only while open', async () => {
    const { socket, s } = await openReady();
    const before = socket.sent.length;
    s.sendAudio(new Uint8Array([1, 2]));
    s.sendToolResults([{ id: 'a', name: 'x', response: { ok: true } }]);
    expect(socket.sent).toHaveLength(before + 2);
    expect(JSON.parse(socket.sent[before] ?? '{}')).toHaveProperty('realtimeInput');
    expect(JSON.parse(socket.sent[before + 1] ?? '{}')).toHaveProperty('toolResponse');

    s.sendToolResults([]); // nothing to say
    expect(socket.sent).toHaveLength(before + 2);

    s.close();
    socket.drop(1000);
    s.sendAudio(new Uint8Array([3]));
    expect(socket.sent).toHaveLength(before + 2);
  });

  it('never sends audio before it is ready', () => {
    const { socket, s } = session();
    void s.open('wss://x', setup, 50).catch(() => undefined);
    socket.open();
    s.sendAudio(new Uint8Array([1]));
    expect(socket.sent).toHaveLength(1); // just the setup
  });

  it('says whether it was us or the server that ended it', async () => {
    const mine = await openReady();
    mine.s.close();
    mine.socket.drop(1000);
    expect(mine.closes).toEqual([{ code: 1000, reason: '', byUs: true }]);

    const theirs = await openReady();
    theirs.socket.drop(1006, 'network dropped');
    expect(theirs.closes).toEqual([{ code: 1006, reason: 'network dropped', byUs: false }]);
    expect(theirs.s.isOpen).toBe(false);
  });
});
