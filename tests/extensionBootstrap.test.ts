import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOOTSTRAP_FILE, publishBootstrap } from '../src/main/chrome/bootstrapFile';

/**
 * The extension's real bridge.js against stand-ins for the browser, as in extensionProbe.test.ts. The point: a freshly loaded extension
 * (no pairing secret of its own) reads the key Eya left in its folder and presents it, so Eya can pair it without being asked; one that
 * already has a secret presents that and never even reads the file.
 */
const source = readFileSync(join(process.cwd(), 'eya-chrome-extension', 'bridge.js'), 'utf8').replace(/^export /gm, '');
const KEY = 'ab'.repeat(32);

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static made: FakeWebSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void | Promise<void>) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public readonly url: string) {
    FakeWebSocket.made.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {}
}

interface Rig {
  hello(): Promise<Record<string, unknown>>;
  fetched: string[];
  removed: string[];
  stored: Record<string, unknown>;
  receive(msg: Record<string, unknown>): Promise<void>;
}

function rig(opts: { secret?: string; file?: 'ok' | 'missing' | 'broken' | 'short'; keyOnDisk?: string }): Rig {
  FakeWebSocket.made = [];
  const fetched: string[] = [];
  const removed: string[] = [];
  const stored: Record<string, unknown> = opts.secret !== undefined ? { eyaSecret: opts.secret } : {};
  const chrome = {
    runtime: { id: 'x', getURL: (p: string) => `chrome-extension://x/${p}` },
    storage: {
      local: {
        get: async (k: string) => (k in stored ? { [k]: stored[k] } : {}),
        set: async (o: Record<string, unknown>) => void Object.assign(stored, o),
        remove: async (k: string) => void (removed.push(k), delete stored[k]),
      },
    },
  };
  const fakeFetch = async (url: string): Promise<unknown> => {
    fetched.push(url);
    if (url.includes('eya-pairing.json')) {
      if (opts.file === 'missing') return { ok: false, status: 404, json: async () => ({}) };
      if (opts.file === 'broken') return { ok: true, json: async () => { throw new SyntaxError('bad json'); } };
      if (opts.file === 'short') return { ok: true, json: async () => ({ token: 'abc' }) };
      return { ok: true, json: async () => ({ token: opts.keyOnDisk ?? KEY }) };
    }
    return { ok: false, status: 426 };
  };
  const factory = new Function('chrome', 'WebSocket', 'fetch', 'AbortController', `${source}\nreturn { Bridge };`);
  const api = factory(chrome, FakeWebSocket, fakeFetch, AbortController) as {
    Bridge: new (o: unknown) => { connect(): void; handle(m: unknown): Promise<void>; status: string };
  };
  const bridge = new api.Bridge({ onRequest: async () => ({}), onStatus: () => undefined, version: '0.6.0', browserName: 'chrome', browserVersion: '1', capabilities: ['observe'], getSnapshot: async () => ({ tabs: [], windows: [] }) });
  return {
    fetched,
    removed,
    stored,
    receive: (msg) => bridge.handle(msg),
    hello: async () => {
      bridge.connect();
      const ws = FakeWebSocket.made[0] as FakeWebSocket;
      ws.readyState = FakeWebSocket.OPEN;
      await ws.onopen?.();
      return ws.sent[0] as Record<string, unknown>;
    },
  };
}

describe('the extension presents the key in its folder when it has no secret of its own', () => {
  it('a freshly loaded extension: no secret, so it sends the folder key', async () => {
    const r = rig({});
    const hello = await r.hello();
    expect(hello['t']).toBe('hello');
    expect(hello['bootstrap']).toBe(KEY);
    expect(hello).not.toHaveProperty('secret');
    expect(r.fetched).toContain('chrome-extension://x/eya-pairing.json');
  });

  it('one that is already paired sends its secret and does not even read the file', async () => {
    const r = rig({ secret: 'cd'.repeat(32) });
    const hello = await r.hello();
    expect(hello['secret']).toBe('cd'.repeat(32));
    expect(hello).not.toHaveProperty('bootstrap');
    expect(r.fetched.some((u) => u.includes('eya-pairing.json'))).toBe(false);
  });

  it('with no file (an older Eya, or a folder she cannot write to) it says hello with nothing — the window is the way then', async () => {
    for (const file of ['missing', 'broken', 'short'] as const) {
      const hello = await rig({ file }).hello();
      expect(hello, file).not.toHaveProperty('bootstrap');
      expect(hello, file).not.toHaveProperty('secret');
      expect(hello['t'], file).toBe('hello');
    }
  });

  it('stores the secret Eya hands back, and from then on uses it instead of the key', async () => {
    const r = rig({});
    await r.hello();
    await r.receive({ t: 'paired', secret: 'ef'.repeat(32) });
    expect(r.stored['eyaSecret']).toBe('ef'.repeat(32));
    const next = rig({ secret: r.stored['eyaSecret'] as string });
    expect((await next.hello())['secret']).toBe('ef'.repeat(32));
  });

  it('drops a secret Eya no longer knows, so the next connection can pair again by the key', async () => {
    const r = rig({ secret: 'cd'.repeat(32) });
    await r.hello();
    await r.receive({ t: 'refused', reason: 'bad_secret' });
    expect(r.removed).toEqual(['eyaSecret']);
    expect(r.stored).not.toHaveProperty('eyaSecret');
  });
});

describe('placing the key in the extension folder', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eya-ext-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the key where the extension reads it, in the shape it expects', () => {
    expect(publishBootstrap(dir, KEY)).toBe(true);
    expect(BOOTSTRAP_FILE).toBe('eya-pairing.json'); // the extension has its own copy of this name
    expect(JSON.parse(readFileSync(join(dir, BOOTSTRAP_FILE), 'utf8'))).toEqual({ token: KEY });
  });

  it('is repeatable, and replaces a stale key (a key from another install, or an old shipped file)', () => {
    writeFileSync(join(dir, BOOTSTRAP_FILE), JSON.stringify({ token: 'old'.repeat(20) }));
    expect(publishBootstrap(dir, KEY)).toBe(true);
    expect(publishBootstrap(dir, KEY)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, BOOTSTRAP_FILE), 'utf8'))).toEqual({ token: KEY });
  });

  it('says false, and does not throw, when the folder cannot be written', () => {
    expect(publishBootstrap(join(dir, 'not-a-folder', 'nested'), KEY)).toBe(false);
    const blocked = join(dir, 'file');
    writeFileSync(blocked, 'x');
    expect(publishBootstrap(blocked, KEY)).toBe(false);
    mkdirSync(join(dir, 'ok'));
    expect(publishBootstrap(join(dir, 'ok'), KEY)).toBe(true);
  });

  it('the extension is not told to make the file reachable by web pages', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'eya-chrome-extension', 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty('web_accessible_resources');
    expect(readFileSync(join(process.cwd(), '.gitignore'), 'utf8')).toContain('eya-chrome-extension/eya-pairing.json');
  });
});
