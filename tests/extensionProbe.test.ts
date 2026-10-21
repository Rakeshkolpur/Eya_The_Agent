import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The extension's real bridge.js, run against stand-ins for the browser's WebSocket and fetch. The point: a failed connection is written
 * to the extension's "Errors" list by the browser every time, so the extension must not attempt one unless Eya has just answered a
 * quiet look. (Measured in a real Chrome: a failed look records no error; a failed connection records one each time.)
 */
const source = readFileSync(join(process.cwd(), 'eya-chrome-extension', 'bridge.js'), 'utf8').replace(/^export /gm, '');

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static made: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public readonly url: string) {
    FakeWebSocket.made.push(this);
  }
  send(): void {}
  close(): void {}
}

interface BridgeLike {
  ensureConnected(): void;
  eyaIsThere(): Promise<boolean>;
  ws: FakeWebSocket | null;
  retryTimer: unknown;
}

function load(fetchImpl: (url: string, init: { mode?: string; cache?: string; signal: AbortSignal }) => Promise<unknown>) {
  const retries: number[] = [];
  const timers = { setTimeout: (fn: () => void, ms: number) => { retries.push(ms); return setTimeout(fn, ms); } };
  const factory = new Function('chrome', 'WebSocket', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', `${source}\nreturn { Bridge, PROBE_URL, BRIDGE_URL };`);
  const quiet = { info: () => undefined, log: () => undefined };
  const api = factory({ runtime: { id: 'x' }, storage: { local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined } } }, FakeWebSocket, fetchImpl, AbortController, timers.setTimeout, clearTimeout, setInterval, clearInterval, quiet) as {
    Bridge: new (o: unknown) => BridgeLike;
    PROBE_URL: string;
    BRIDGE_URL: string;
  };
  const bridge = new api.Bridge({ onRequest: async () => ({}), onStatus: () => undefined, version: '0.6.0', browserName: 'chrome', browserVersion: '1', capabilities: [], getSnapshot: async () => ({}) });
  return { bridge, api, retries };
}

beforeEach(() => {
  FakeWebSocket.made = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the extension looks for Eya quietly before it connects', () => {
  it('opens NO connection when nobody answers (so the browser has no error to write down), and tries again later', async () => {
    const fetched: string[] = [];
    const { bridge, retries } = load(async (url) => {
      fetched.push(url);
      throw new TypeError('Failed to fetch');
    });
    for (let i = 0; i < 5; i += 1) bridge.ensureConnected(); // the browser wakes the worker again and again
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeWebSocket.made).toEqual([]);
    expect(fetched).toHaveLength(1); // five wake-ups, one look at a time
    expect(retries).toContain(1500); // and it comes back for another look (the 2000 is the look's own time limit)
  });

  it('connects when Eya answers — to the bridge address, once', async () => {
    const { bridge, api } = load(async () => ({ ok: false, status: 426 })); // the bridge answers a plain request with "upgrade required"
    bridge.ensureConnected();
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeWebSocket.made.map((w) => w.url)).toEqual([api.BRIDGE_URL]);
    bridge.ensureConnected(); // already connecting: no second look, no second connection
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeWebSocket.made).toHaveLength(1);
  });

  it('gives up on a look that never comes back, after two seconds', async () => {
    vi.useFakeTimers();
    const { bridge } = load((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const there = bridge.eyaIsThere();
    await vi.advanceTimersByTimeAsync(1999);
    let settled = false;
    void there.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await there).toBe(false);
  });

  it('the look is a plain request to the same loopback address, and cannot read or send anything of the user\'s', async () => {
    const seen: Array<{ url: string; mode?: string; cache?: string }> = [];
    const { api } = load(async (url, init) => {
      seen.push({ url, ...(init.mode !== undefined ? { mode: init.mode } : {}), ...(init.cache !== undefined ? { cache: init.cache } : {}) });
      return {};
    });
    const { bridge } = load(async (url, init) => (seen.push({ url, mode: init.mode as string, cache: init.cache as string }), {}));
    await bridge.eyaIsThere();
    expect(api.PROBE_URL).toBe(api.BRIDGE_URL.replace(/^ws:/, 'http:'));
    expect(api.PROBE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(seen).toEqual([{ url: api.PROBE_URL, mode: 'no-cors', cache: 'no-store' }]);
  });
});
