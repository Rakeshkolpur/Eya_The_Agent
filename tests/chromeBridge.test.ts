import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { BridgeError, ChromeBridge, FileSecretStore } from '../src/main/chrome/ChromeBridge';
import type { BridgeBrowserEvent, BridgeConnectionEvent, SecretStore } from '../src/main/chrome/ChromeBridge';
import {
  BRIDGE_PATH,
  EXTENSION_ORIGIN,
  EYA_EXTENSION_ID,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  parseExtensionMessage,
} from '../src/main/chrome/protocol';
import type { BrowserName } from '../src/main/chrome/protocol';

class MemorySecrets implements SecretStore {
  hashes = new Map<BrowserName, string>();
  loadHash(b: BrowserName) {
    return this.hashes.get(b) ?? null;
  }
  saveHash(b: BrowserName, h: string) {
    this.hashes.set(b, h);
  }
  clear(b?: BrowserName) {
    if (b === undefined) this.hashes.clear();
    else this.hashes.delete(b);
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

/** A version-2 handshake, as the real extension sends it. */
const hello = (browser = 'chrome', over: Record<string, unknown> = {}) => ({
  t: 'hello',
  ext: EYA_EXTENSION_ID,
  protocolVersion: PROTOCOL_VERSION,
  extensionVersion: '0.2.0',
  browser,
  browserVersion: '154.0.0.0',
  capabilities: [...REQUIRED_CAPABILITIES, 'scroll', 'events'],
  tabs: [
    { tabId: 11, windowId: 1, title: 'Inbox', url: 'https://mail.example/', active: true, pinned: false, loading: false },
    { tabId: 12, windowId: 1, title: 'Docs', url: 'https://docs.example/', active: false, pinned: true, loading: false },
  ],
  windows: [{ windowId: 1, focused: true, tabCount: 2 }],
  activeWindowId: 1,
  activeTabId: 11,
  ...over,
});

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

/** Pairs a fresh client for this browser (opening a window first if none is open) and returns it with its secret. */
async function pair(browser = 'chrome', openWindow = true): Promise<{ client: Client; secret: string }> {
  if (openWindow) bridge.openPairingWindow();
  const client = await connect();
  client.send(hello(browser));
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
    b.send(hello('chrome', { ext: 'someotherextensionidsomeotherextensio' }));
    expect((await b.next())['reason']).toBe('protocol');
    const c = await connect();
    c.ws.send('not json at all');
    expect((await c.next())['reason']).toBe('protocol');
    const d = await connect();
    d.send({ t: 'event', name: 'tab_created', data: {} }); // events are only for an authenticated connection
    expect((await d.next())['reason']).toBe('protocol');
    expect(bridge.isConnected()).toBe(false);
  });

  it('drops a connection that never says hello', async () => {
    const c = await connect();
    expect(await c.closed).toBe(4000);
  });
});

describe('the handshake: which browser, which version, what it can do, what is open', () => {
  it('records the browser identity, versions, capabilities and the tabs it had open', async () => {
    await pair('edge');
    const h = bridge.handshakeOf('edge');
    expect(h).toMatchObject({ browser: 'edge', protocolVersion: PROTOCOL_VERSION, extensionVersion: '0.2.0', browserVersion: '154.0.0.0', activeTabId: 11 });
    expect(h?.capabilities).toContain('scroll');
    expect(h?.tabs.map((t) => t.title)).toEqual(['Inbox', 'Docs']);
    expect(bridge.info().browsers['edge']).toMatchObject({ connected: true, paired: true, extensionVersion: '0.2.0', browserVersion: '154.0.0.0' });
  });

  it('refuses an extension that speaks another protocol version, saying exactly what to do — and counts it as waiting', async () => {
    bridge.openPairingWindow();
    const c = await connect();
    c.send(hello('chrome', { protocolVersion: PROTOCOL_VERSION + 1 }));
    const refused = await c.next();
    expect(refused).toMatchObject({ t: 'refused', reason: 'incompatible' });
    expect(String(refused['detail'])).toMatch(/Reload the Eya Browser Bridge extension/);
    expect(await c.closed).toBe(4005);
    expect(bridge.isConnected()).toBe(false);
    expect(secrets.loadHash('chrome')).toBeNull(); // nothing was paired
    expect(bridge.waitingToPair()).toEqual(['chrome']);
  });

  it('treats the first version of the extension (no protocolVersion) as out of date, politely', async () => {
    bridge.openPairingWindow();
    const c = await connect();
    c.send({ t: 'hello', ext: EYA_EXTENSION_ID, version: '0.1.0', browser: 'chrome' });
    const refused = await c.next();
    expect(refused).toMatchObject({ t: 'refused', reason: 'incompatible' });
    expect(String(refused['detail'])).toContain('speaks 1');
  });

  it('refuses an extension that lacks abilities Eya relies on', async () => {
    bridge.openPairingWindow();
    const c = await connect();
    c.send(hello('chrome', { capabilities: ['observe'] }));
    const refused = await c.next();
    expect(refused).toMatchObject({ t: 'refused', reason: 'incompatible' });
    expect(String(refused['detail'])).toMatch(/missing abilities/);
  });

  it('parses a hello defensively: junk tabs and fields are dropped, not trusted', () => {
    const parsed = parseExtensionMessage(
      JSON.stringify({ t: 'hello', ext: 'x', browser: 'edge', protocolVersion: 2, tabs: [{ tabId: 'bad' }, { tabId: 1, windowId: 2, title: 'T' }, 'junk'], capabilities: ['a', 5], windows: 'nope' }),
    );
    expect(parsed).toMatchObject({ t: 'hello', browser: 'edge', capabilities: ['a'], windows: [] });
    expect(parsed && parsed.t === 'hello' ? parsed.tabs : []).toHaveLength(1);
  });
});

describe('pairing, per browser', () => {
  it('hands out a secret only inside the pairing window, stores only its hash, and one browser pairs once per window', async () => {
    const { client, secret } = await pair('chrome');
    expect(bridge.isConnected('chrome')).toBe(true);
    expect(secrets.loadHash('chrome')).toBe(createHash('sha256').update(secret).digest('hex'));
    expect(secrets.loadHash('chrome')).not.toContain(secret);

    client.ws.terminate();
    await client.closed;
    await until(() => !bridge.isConnected('chrome'));
    const again = await connect();
    again.send(hello('chrome')); // no secret, and this browser already used the window
    expect((await again.next())['reason']).toBe('not_pairing');
  });

  it('Chrome and Edge can both pair in the same window, each with its own secret', async () => {
    bridge.openPairingWindow();
    const { secret: chromeSecret } = await pair('chrome', false);
    const { secret: edgeSecret } = await pair('edge', false);
    expect(chromeSecret).not.toBe(edgeSecret);
    expect(bridge.connectedBrowsers()).toEqual(['chrome', 'edge']);
    expect(secrets.loadHash('chrome')).not.toBe(secrets.loadHash('edge'));
  });

  it('the window expires on its own', async () => {
    bridge.openPairingWindow();
    clock += 10_001;
    const late = await connect();
    late.send(hello());
    expect((await late.next())['reason']).toBe('not_pairing');
    expect(secrets.loadHash('chrome')).toBeNull();
  });

  it('a restarted bridge does not inherit a pairing window opened before it stopped', async () => {
    bridge.openPairingWindow();
    expect(bridge.pairingOpen()).toBe(true);
    await bridge.stop();
    expect(bridge.pairingOpen()).toBe(false);
    expect(await bridge.start()).toBe(true);
    expect(bridge.pairingOpen()).toBe(false);
    const late = await connect();
    late.send(hello());
    expect((await late.next())['reason']).toBe('not_pairing');
  });

  it('later connections just present the stored secret — no window needed — and a wrong one is refused', async () => {
    const { client, secret } = await pair('chrome');
    client.ws.terminate();
    await client.closed;
    await until(() => !bridge.isConnected('chrome'));

    const again = await connect();
    again.send(hello('chrome', { secret }));
    expect(await again.next()).toEqual({ t: 'ready', protocolVersion: PROTOCOL_VERSION });
    expect(bridge.isConnected('chrome')).toBe(true);

    const wrong = await connect();
    wrong.send(hello('chrome', { secret: '0'.repeat(64) }));
    expect(await wrong.next()).toEqual({ t: 'refused', reason: 'bad_secret' });
    expect(await wrong.closed).toBe(4003);
    expect(bridge.isConnected('chrome')).toBe(true); // the good connection is untouched
  });

  it("one browser's secret is useless to the other browser", async () => {
    const { secret: chromeSecret } = await pair('chrome');
    const impostor = await connect();
    impostor.send(hello('edge', { secret: chromeSecret }));
    expect((await impostor.next())['reason']).toBe('bad_secret');
    expect(bridge.isConnected('edge')).toBe(false);
  });

  it("forgetting one browser's pairing drops only that browser and invalidates only its secret", async () => {
    bridge.openPairingWindow();
    const { client: chrome } = await pair('chrome', false);
    const { client: edge, secret: edgeSecret } = await pair('edge', false);
    bridge.forgetPairing('chrome');
    expect(await chrome.closed).toBe(4003);
    await until(() => !bridge.isConnected('chrome'));
    expect(bridge.isConnected('edge')).toBe(true);
    expect(secrets.loadHash('chrome')).toBeNull();
    expect(secrets.loadHash('edge')).not.toBeNull();

    edge.ws.terminate();
    await edge.closed;
    await until(() => !bridge.isConnected('edge'));
    const back = await connect();
    back.send(hello('edge', { secret: edgeSecret }));
    expect((await back.next())['t']).toBe('ready');
  });

  it('forgetting everything drops every browser', async () => {
    bridge.openPairingWindow();
    const { client: a } = await pair('chrome', false);
    const { client: b } = await pair('edge', false);
    bridge.forgetPairing();
    expect(await a.closed).toBe(4003);
    expect(await b.closed).toBe(4003);
    await until(() => bridge.info().browsers['chrome'] === undefined && bridge.info().browsers['edge'] === undefined);
  });
});

describe('the secret file: per browser, and a first-version file still works', () => {
  it('migrates the old single-secret file: it works for whichever browser uses it first, then belongs to that browser', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eya-secrets-'));
    try {
      const path = join(dir, 'chrome-bridge.json');
      writeFileSync(path, JSON.stringify({ secretHash: 'ab'.repeat(32) }));
      const store = new FileSecretStore(path);
      expect(store.loadHash('chrome')).toBe('ab'.repeat(32));
      expect(store.loadHash('edge')).toBe('ab'.repeat(32)); // anybody's, until claimed
      store.saveHash('chrome', 'ab'.repeat(32)); // chrome presented it successfully
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { hashes: Record<string, string>; secretHash?: string };
      expect(raw.hashes['chrome']).toBe('ab'.repeat(32));
      expect(raw.secretHash).toBeUndefined();
      expect(store.loadHash('edge')).toBeNull(); // no longer anybody's
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps separate hashes per browser and clears one at a time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eya-secrets-'));
    try {
      const store = new FileSecretStore(join(dir, 's.json'));
      store.saveHash('chrome', 'aa'.repeat(32));
      store.saveHash('edge', 'bb'.repeat(32));
      expect(store.loadHash('chrome')).toBe('aa'.repeat(32));
      expect(store.loadHash('edge')).toBe('bb'.repeat(32));
      store.clear('chrome');
      expect(store.loadHash('chrome')).toBeNull();
      expect(store.loadHash('edge')).toBe('bb'.repeat(32));
      store.clear();
      expect(store.loadHash('edge')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Chrome and Edge at the same time', () => {
  async function both() {
    bridge.openPairingWindow();
    const chrome = (await pair('chrome', false)).client;
    const edge = (await pair('edge', false)).client;
    return { chrome, edge };
  }

  it('keeps both connected and tracked independently', async () => {
    await both();
    expect(bridge.connectedBrowsers()).toEqual(['chrome', 'edge']);
    expect(bridge.handshakeOf('chrome')?.browser).toBe('chrome');
    expect(bridge.handshakeOf('edge')?.browser).toBe('edge');
    expect(bridge.info().anyConnected).toBe(true);
  });

  it("sends each request to the browser it is for and no other, and refuses to guess when it is not said", async () => {
    const { chrome, edge } = await both();
    const toEdge = bridge.forBrowser('edge').request('observe', { tabId: 7 });
    const req = await edge.next();
    expect(req).toMatchObject({ t: 'req', op: 'observe', args: { tabId: 7 } });
    edge.send({ t: 'res', id: req['id'], ok: true, result: 'from edge' });
    expect(await toEdge).toBe('from edge');

    const toChrome = bridge.forBrowser('chrome').request('observe', {});
    const creq = await chrome.next();
    chrome.send({ t: 'res', id: creq['id'], ok: true, result: 'from chrome' });
    expect(await toChrome).toBe('from chrome');

    await expect(bridge.request('observe', {})).rejects.toMatchObject({ code: 'ambiguous' });
  });

  it("a request with no browser named goes to the only one connected", async () => {
    const { client } = await pair('chrome');
    const pending = bridge.request('observe', {});
    const req = await client.next();
    client.send({ t: 'res', id: req['id'], ok: true, result: 1 });
    expect(await pending).toBe(1);
  });

  it("one browser going away leaves the other connected and fails only its own in-flight requests", async () => {
    const { chrome, edge } = await both();
    const chromeOutcome = bridge.forBrowser('chrome').request('observe', {}).catch((e: unknown) => e);
    const edgePending = bridge.forBrowser('edge').request('observe', {});
    await chrome.next();
    const edgeReq = await edge.next();
    chrome.ws.terminate();
    expect(await chromeOutcome).toMatchObject({ code: 'disconnected' });
    await until(() => !bridge.isConnected('chrome'));
    expect(bridge.isConnected('edge')).toBe(true);
    edge.send({ t: 'res', id: edgeReq['id'], ok: true, result: 'still fine' });
    expect(await edgePending).toBe('still fine');
  });

  it("a newer connection from the SAME browser replaces only that browser's old one", async () => {
    const { chrome, edge } = await both();
    const secret = secrets.loadHash('chrome');
    expect(secret).not.toBeNull();
    // the real extension would present its stored secret; here a fresh pairing window stands in for it
    bridge.openPairingWindow();
    const replacement = await connect();
    replacement.send(hello('chrome'));
    expect((await replacement.next())['t']).toBe('paired');
    expect(await chrome.closed).toBe(4009);
    expect(bridge.isConnected('chrome')).toBe(true);
    expect(bridge.isConnected('edge')).toBe(true);
    void edge;
  });

  it('tells listeners which browser connected or left, with the handshake', async () => {
    const seen: BridgeConnectionEvent[] = [];
    bridge.onConnectionChange((e) => seen.push(e));
    const { client } = await pair('edge');
    client.ws.terminate();
    await client.closed;
    await until(() => seen.length === 2);
    expect(seen[0]).toMatchObject({ browser: 'edge', connected: true });
    expect(seen[0]?.hello?.tabs).toHaveLength(2);
    expect(seen[1]).toEqual({ browser: 'edge', connected: false });
  });
});

describe('live events from the browser', () => {
  it('delivers each event with the browser it came from', async () => {
    const events: BridgeBrowserEvent[] = [];
    bridge.onBrowserEvent((e) => events.push(e));
    bridge.openPairingWindow();
    const { client: chrome } = await pair('chrome', false);
    const { client: edge } = await pair('edge', false);
    chrome.send({ t: 'event', name: 'tab_created', data: { tab: { tabId: 5, windowId: 1 }, byEya: false } });
    edge.send({ t: 'event', name: 'tab_activated', data: { tabId: 9, windowId: 2, byEya: true } });
    await until(() => events.length === 2);
    expect(events[0]).toMatchObject({ browser: 'chrome', name: 'tab_created' });
    expect(events[1]).toMatchObject({ browser: 'edge', name: 'tab_activated', data: { tabId: 9 } });
  });

  it('ignores malformed events instead of breaking the connection', async () => {
    const events: BridgeBrowserEvent[] = [];
    bridge.onBrowserEvent((e) => events.push(e));
    const { client } = await pair('chrome');
    client.ws.send(JSON.stringify({ t: 'event' })); // no name
    client.send({ t: 'event', name: 'ok', data: 'not an object' });
    await until(() => events.length === 1);
    expect(events[0]).toMatchObject({ name: 'ok', data: {} });
    expect(bridge.isConnected('chrome')).toBe(true);
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
    const outcome = bridge.request('observe', {}).catch((e: unknown) => e);
    await c.next();
    c.ws.terminate();
    expect(await outcome).toMatchObject({ code: 'disconnected' });
    await until(() => !bridge.isConnected());
    await expect(bridge.request('observe', {})).rejects.toMatchObject({ code: 'not_connected' });
    expect(new BridgeError('timeout', 'x')).toBeInstanceOf(Error);
  });

  it('knows which unpaired extensions are knocking, and stops listing one once it has connected', async () => {
    const knocker = await connect();
    knocker.send(hello('edge'));
    expect((await knocker.next())['reason']).toBe('not_pairing');
    expect(bridge.waitingToPair()).toEqual(['edge']);
    expect(bridge.info().waitingToPair).toEqual(['edge']);
    bridge.openPairingWindow();
    await pair('edge', false);
    expect(bridge.waitingToPair()).toEqual([]);
    clock += 100_000; // old knocks are forgotten
    expect(bridge.waitingToPair()).toEqual([]);
  });

  it('tells an outdated extension (needs a reload) apart from one that merely is not paired: only the refused-for-version one is outdated', async () => {
    const stale = await connect();
    stale.send({ t: 'hello', ext: EYA_EXTENSION_ID, version: '0.1.0', browser: 'edge' }); // the first version of the extension
    expect((await stale.next())['reason']).toBe('incompatible');
    const unpaired = await connect();
    unpaired.send(hello('chrome'));
    expect((await unpaired.next())['reason']).toBe('not_pairing');

    expect(bridge.waitingToPair().sort()).toEqual(['chrome', 'edge']);
    expect(bridge.outdated()).toEqual(['edge']);
    expect(bridge.info().outdated).toEqual(['edge']);
  });

  it('an outdated extension that is reloaded and pairs is no longer outdated, and old knocks are forgotten', async () => {
    const stale = await connect();
    stale.send({ t: 'hello', ext: EYA_EXTENSION_ID, version: '0.1.0', browser: 'edge' });
    await stale.next();
    expect(bridge.outdated()).toEqual(['edge']);
    bridge.openPairingWindow();
    await pair('edge', false);
    expect(bridge.outdated()).toEqual([]);

    const again = await connect();
    again.send({ t: 'hello', ext: EYA_EXTENSION_ID, version: '0.1.0', browser: 'chrome' });
    await again.next();
    expect(bridge.outdated()).toEqual(['chrome']);
    clock += 100_000;
    expect(bridge.outdated()).toEqual([]);
  });

  it('an extension missing abilities Eya needs is also reported as outdated', async () => {
    const c = await connect();
    c.send(hello('chrome', { capabilities: ['observe'] }));
    expect((await c.next())['reason']).toBe('incompatible');
    expect(bridge.outdated()).toEqual(['chrome']);
  });

  it('waitForConnection resolves as soon as the browser connects, and false when it does not', async () => {
    expect(await bridge.waitForConnection('chrome', 30)).toBe(false);
    const waiting = bridge.waitForConnection('chrome', 2000);
    await pair('chrome');
    expect(await waiting).toBe(true);
    expect(await bridge.waitForConnection('chrome', 30)).toBe(true); // already connected: immediate
  });
});

describe('start', () => {
  it('reports false instead of throwing when the port is already in use', async () => {
    const other = new ChromeBridge({ secrets: new MemorySecrets(), port: bridge.port() as number });
    expect(await other.start()).toBe(false);
    await other.stop();
  });
});
