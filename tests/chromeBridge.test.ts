import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { BridgeError, ChromeBridge } from '../src/main/chrome/ChromeBridge';
import type { SecretStore } from '../src/main/chrome/ChromeBridge';
import { BRIDGE_PATH, EXTENSION_ORIGIN, EYA_EXTENSION_ID } from '../src/main/chrome/protocol';

class MemorySecrets implements SecretStore {
  hash: string | null = null;
  loadHash() {
    return this.hash;
  }
  saveHash(h: string) {
    this.hash = h;
  }
  clear() {
    this.hash = null;
  }
}

interface Client {
  ws: WebSocket;
  next(): Promise<Record<string, unknown>>;
  closed: Promise<number>;
  send(m: unknown): void;
}

function open(port: number, origin: string | null = EXTENSION_ORIGIN): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${BRIDGE_PATH}`, origin === null ? {} : { origin });
    const inbox: Array<Record<string, unknown>> = [];
    const waiters: Array<(m: Record<string, unknown>) => void> = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as Record<string, unknown>;
      const w = waiters.shift();
      if (w) w(m);
      else inbox.push(m);
    });
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', (e) => reject(e));
    ws.once('open', () =>
      resolve({
        ws,
        closed,
        send: (m) => ws.send(JSON.stringify(m)),
        next: () => {
          const queued = inbox.shift();
          if (queued) return Promise.resolve(queued);
          return new Promise((r) => waiters.push(r));
        },
      }),
    );
  });
}

const hello = (secret?: string, ext = EYA_EXTENSION_ID) => ({ t: 'hello', ext, version: '0.1.0', browser: 'edge', ...(secret ? { secret } : {}) });

let bridge: ChromeBridge;
let secrets: MemorySecrets;
let clock = 1_000_000;
const clients: Client[] = [];

async function connect(origin: string | null = EXTENSION_ORIGIN) {
  const c = await open(bridge.port() as number, origin);
  clients.push(c);
  return c;
}

/** The server notices a close a moment after the client does. */
async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

/** Pairs a fresh client and returns it with its secret. */
async function pair(): Promise<{ client: Client; secret: string }> {
  bridge.openPairingWindow();
  const client = await connect();
  client.send(hello());
  const paired = await client.next();
  expect(paired['t']).toBe('paired');
  return { client, secret: paired['secret'] as string };
}

beforeEach(async () => {
  clock = 1_000_000;
  secrets = new MemorySecrets();
  bridge = new ChromeBridge({ secrets, port: 0, now: () => clock, requestTimeoutMs: 400, helloTimeoutMs: 300, pairingWindowMs: 10_000 });
  expect(await bridge.start()).toBe(true);
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await bridge.stop();
});

describe('who may connect', () => {
  it('refuses a handshake that does not carry the extension origin (a web page cannot forge this)', async () => {
    await expect(connect('https://evil.example')).rejects.toThrow(/403/);
    await expect(connect('chrome-extension://abcdefghijklmnopabcdefghijklmnop')).rejects.toThrow(/403/);
    await expect(connect(null)).rejects.toThrow(/403/);
    expect(bridge.isConnected()).toBe(false);
  });

  it('refuses the right origin when nothing has been paired and no pairing window is open', async () => {
    const c = await connect();
    c.send(hello());
    expect(await c.next()).toEqual({ t: 'refused', reason: 'not_pairing' });
    expect(await c.closed).toBe(4002);
    expect(bridge.isConnected()).toBe(false);
  });

  it('never accepts a first message that is not a hello, or a hello for some other extension', async () => {
    const a = await connect();
    a.send({ t: 'res', id: 1, ok: true });
    expect((await a.next())['reason']).toBe('protocol');
    bridge.openPairingWindow();
    const b = await connect();
    b.send(hello(undefined, 'someotherextensionidsomeotherextensio'));
    expect((await b.next())['reason']).toBe('protocol');
    const c = await connect();
    c.ws.send('not json at all');
    expect((await c.next())['reason']).toBe('protocol');
    expect(bridge.isConnected()).toBe(false);
  });

  it('drops a connection that never says hello', async () => {
    const c = await connect();
    expect(await c.closed).toBe(4000);
  });
});

describe('pairing', () => {
  it('hands out a secret only inside the pairing window, stores only its hash, and the window is single-use', async () => {
    const { client, secret } = await pair();
    expect(bridge.isConnected()).toBe(true);
    expect(secrets.hash).toBe(createHash('sha256').update(secret).digest('hex'));
    expect(secrets.hash).not.toContain(secret);
    expect(bridge.pairingOpen()).toBe(false);
    expect(bridge.info()).toMatchObject({ connected: true, paired: true, browser: 'edge' });

    client.ws.terminate();
    await client.closed;
    await until(() => !bridge.isConnected());
    const intruder = await connect();
    intruder.send(hello()); // no secret, window already used
    expect((await intruder.next())['reason']).toBe('not_pairing');
  });

  it('the window expires on its own', async () => {
    bridge.openPairingWindow();
    clock += 10_001;
    const late = await connect();
    late.send(hello());
    expect((await late.next())['reason']).toBe('not_pairing');
    expect(secrets.hash).toBeNull();
  });

  it('later connections just present the stored secret — no window needed — and a wrong one is refused', async () => {
    const { client, secret } = await pair();
    client.ws.terminate();
    await client.closed;
    await until(() => !bridge.isConnected());

    const again = await connect();
    again.send(hello(secret));
    expect(await again.next()).toEqual({ t: 'ready' });
    expect(bridge.isConnected()).toBe(true);

    const wrong = await connect();
    wrong.send(hello('0'.repeat(64)));
    expect(await wrong.next()).toEqual({ t: 'refused', reason: 'bad_secret' });
    expect(await wrong.closed).toBe(4003);
    expect(bridge.isConnected()).toBe(true); // the good connection is untouched
  });

  it('forgetting the pairing drops the browser and makes the old secret useless', async () => {
    const { client, secret } = await pair();
    bridge.forgetPairing();
    expect(await client.closed).toBe(4003);
    const retry = await connect();
    retry.send(hello(secret));
    expect((await retry.next())['reason']).toBe('bad_secret');
    expect(bridge.info().paired).toBe(false);
  });
});

describe('requests', () => {
  async function connected() {
    const { client } = await pair();
    return client;
  }

  it('sends a request and resolves with the extension reply', async () => {
    const c = await connected();
    const pending = bridge.request<{ n: number }>('observe', { tabId: 3 });
    const req = await c.next();
    expect(req).toMatchObject({ t: 'req', op: 'observe', args: { tabId: 3 } });
    c.send({ t: 'res', id: req['id'], ok: true, result: { n: 7 } });
    expect(await pending).toEqual({ n: 7 });
  });

  it('turns an extension-side failure into a BridgeError carrying the message', async () => {
    const c = await connected();
    const pending = bridge.request('click', {});
    const req = await c.next();
    c.send({ t: 'res', id: req['id'], ok: false, error: 'That element is gone.' });
    await expect(pending).rejects.toMatchObject({ code: 'extension_error', message: 'That element is gone.' });
  });

  it('times out when the browser never answers, and ignores the late reply', async () => {
    const c = await connected();
    const pending = bridge.request('observe', {}, 60);
    const req = await c.next();
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
    c.send({ t: 'res', id: req['id'], ok: true, result: 1 }); // late: must not throw or resurrect anything
    c.send({ t: 'ping' });
    expect(await c.next()).toEqual({ t: 'pong' });
  });

  it('rejects in-flight requests when the browser goes away, and refuses new ones', async () => {
    const c = await connected();
    const pending = bridge.request('observe', {});
    const outcome = pending.catch((e: unknown) => e);
    await c.next();
    c.ws.terminate();
    expect(await outcome).toMatchObject({ code: 'disconnected' });
    await until(() => !bridge.isConnected());
    await expect(bridge.request('observe', {})).rejects.toMatchObject({ code: 'not_connected' });
    expect(new BridgeError('timeout', 'x')).toBeInstanceOf(Error);
  });

  it('is single-connection: a newer authenticated browser replaces the old one', async () => {
    const { client: first, secret } = await pair();
    const inFlight = bridge.request('observe', {});
    const inFlightOutcome = inFlight.catch((e: unknown) => e);
    await first.next();

    const second = await connect();
    second.send(hello(secret));
    expect(await second.next()).toEqual({ t: 'ready' });
    expect(await first.closed).toBe(4009);
    expect(await inFlightOutcome).toMatchObject({ code: 'disconnected' });

    const pending = bridge.request('observe', {});
    const req = await second.next();
    second.send({ t: 'res', id: req['id'], ok: true, result: 'from second' });
    expect(await pending).toBe('from second');
  });

  it('tells listeners when the connection comes and goes', async () => {
    const seen: boolean[] = [];
    bridge.onConnectionChange((c) => seen.push(c));
    const { client } = await pair();
    client.ws.terminate();
    await client.closed;
    await until(() => seen.length === 2);
    expect(seen).toEqual([true, false]);
  });
});

describe('start', () => {
  it('reports false instead of throwing when the port is already in use', async () => {
    const other = new ChromeBridge({ secrets: new MemorySecrets(), port: bridge.port() as number });
    expect(await other.start()).toBe(false);
    await other.stop();
  });
});
