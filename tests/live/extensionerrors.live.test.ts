/**
 * What the extension's own background worker logs as ERRORS (the list behind the "Errors" button on the browser's extensions page), in
 * the three situations a user actually meets: Eya not running, Eya being restarted, and Eya working. A real Chrome, the real extension,
 * the real bridge; the worker's console is read over the browser's debugging port.
 *
 * Opt-in:  EYA_LIVE_BROWSER=1 npx vitest run tests/live/extensionerrors.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChromeBridge } from '../../src/main/chrome/ChromeBridge';
import type { SecretStore } from '../../src/main/chrome/ChromeBridge';
import type { BrowserName } from '../../src/main/chrome/protocol';
import { startTestSite } from '../fixtures/chrome-test-site/server.mjs';
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser, waitFor } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const BRIDGE_PORT = 47841;
const DEBUG_PORT = 9349;

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

interface Entry {
  readonly at: number;
  readonly kind: string;
  readonly text: string;
}

/** Listens to every service-worker target of the test browser and keeps what they log as errors or throw. */
class WorkerWatch {
  readonly errors: Entry[] = [];
  readonly infos: Entry[] = [];
  private readonly attached = new Set<string>();
  private stopped = false;

  constructor(private readonly port: number) {
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${this.port}/json`)).json()) as Array<{ id: string; type: string; url: string; webSocketDebuggerUrl?: string }>;
        for (const t of list) {
          if (t.type !== 'service_worker' || !t.url.includes('service-worker.js') || t.webSocketDebuggerUrl === undefined || this.attached.has(t.id)) continue;
          this.attached.add(t.id);
          this.attach(t.webSocketDebuggerUrl);
        }
      } catch {
        // the browser is not answering yet
      }
      await sleep(400);
    }
  }

  private attach(url: string): void {
    const ws = new WebSocket(url);
    ws.onopen = () => {
      let id = 0;
      const send = (method: string) => ws.send(JSON.stringify({ id: ++id, method }));
      send('Runtime.enable');
      send('Log.enable');
      send('Network.enable');
    };
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data)) as { method?: string; params?: Record<string, any> };
      const now = Date.now();
      if (d.method === 'Runtime.exceptionThrown') this.errors.push({ at: now, kind: 'exception', text: String(d.params?.['exceptionDetails']?.exception?.description ?? d.params?.['exceptionDetails']?.text) });
      else if (d.method === 'Runtime.consoleAPICalled') {
        const text = (d.params?.['args'] as Array<{ value?: unknown; description?: string }>).map((a) => String(a.value ?? a.description ?? '')).join(' ');
        (d.params?.['type'] === 'error' ? this.errors : this.infos).push({ at: now, kind: `console.${String(d.params?.['type'])}`, text });
      } else if (d.method === 'Log.entryAdded') {
        const entry = d.params?.['entry'] as { level?: string; text?: string; source?: string };
        if (entry.level === 'error') this.errors.push({ at: now, kind: `log.${entry.source ?? ''}`, text: String(entry.text) });
      }
    };
  }

  stop(): void {
    this.stopped = true;
  }
}

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('what the extension logs as errors', () => {
  let browser: TestBrowser;
  let ext: { dir: string; cleanup: () => void };
  let watch: WorkerWatch;
  let bridge: ChromeBridge | null = null;
  const secrets = new MemorySecrets();
  const startBridge = async (): Promise<void> => {
    bridge = new ChromeBridge({ secrets, port: BRIDGE_PORT });
    if (!(await bridge.start())) throw new Error('port busy');
  };
  const summary = (list: readonly Entry[]): string => [...new Set(list.map((e) => `${e.kind}: ${e.text.slice(0, 160)}`))].join('\n    ');

  beforeAll(async () => {
    ext = prepareExtensionCopy(BRIDGE_PORT);
    watch = new WorkerWatch(DEBUG_PORT);
    browser = await startTestBrowser({ kind: 'chrome', extensionDir: ext.dir, debugPort: DEBUG_PORT });
  }, 90_000);

  afterAll(async () => {
    watch?.stop();
    browser?.kill();
    await bridge?.stop();
    await sleep(500);
    browser?.cleanup();
    ext?.cleanup();
  }, 30_000);

  it('Eya not running: what the worker logs while it keeps trying to connect', async () => {
    await sleep(25_000);
    // eslint-disable-next-line no-console
    console.log(`  [Eya not running, 25 s] errors: ${watch.errors.length}\n    ${summary(watch.errors)}\n  infos: ${watch.infos.length}`);
    // The extension looks for Eya quietly and opens no connection while nobody answers, so there is nothing for the browser to write in
    // the extension's Errors list. (Before it did: five in 25 seconds, one per failed connection, for as long as Eya was off.)
    expect(watch.errors).toEqual([]);
  }, 60_000);

  it('Eya started, then restarted twice: what the worker logs', async () => {
    const before = watch.errors.length;
    await startBridge();
    (bridge as ChromeBridge).openPairingWindow();
    await waitFor(() => (bridge as ChromeBridge).isConnected('chrome'), 60_000, 'the extension to connect');
    await sleep(2000);
    for (let i = 0; i < 2; i += 1) {
      await (bridge as ChromeBridge).stop();
      await sleep(8000);
      await startBridge();
      await waitFor(() => (bridge as ChromeBridge).isConnected('chrome'), 60_000, 'the extension to reconnect');
      await sleep(1500);
    }
    // eslint-disable-next-line no-console
    console.log(`  [connected, then restarted twice] new errors: ${watch.errors.length - before}\n    ${summary(watch.errors.slice(before))}`);
    // Eya going away for eight seconds and coming back: at most one connection can be caught half-way by her closing.
    expect(watch.errors.length - before).toBeLessThanOrEqual(2);
  }, 180_000);

  it('Eya working in the browser: opening a page, looking, scrolling, going back, reloading — no errors', async () => {
    const site = await startTestSite(0);
    try {
      const before = watch.errors.length;
      const link = (bridge as ChromeBridge).forBrowser('chrome');
      const url = `http://chat.localhost:${site.port}/chat.html`;
      await link.request('open_url', { url, quick: true }, 30_000);
      await link.request('observe', {}, 15_000);
      await link.request('scroll', { direction: 'down', amount: 300 }, 15_000);
      await link.request('list_tabs', {}, 15_000);
      await link.request('reload', {}, 30_000);
      await link.request('observe', {}, 15_000);
      await sleep(1500);
      // eslint-disable-next-line no-console
      console.log(`  [working in the browser] new errors: ${watch.errors.length - before}
    ${summary(watch.errors.slice(before))}`);
      expect(watch.errors.slice(before)).toEqual([]);
    } finally {
      site.server.close();
    }
  }, 120_000);
});
