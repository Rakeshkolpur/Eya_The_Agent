/**
 * "Loading the extension is enough": a real Chrome, the real extension, the real bridge — and the pairing window is NEVER opened.
 * Eya leaves a key in the extension's own folder; the extension reads it and pairs by itself. Also what the browser's Errors list
 * for the extension says when the key is missing (the fallback is still the window the user opens).
 *
 * Opt-in:  EYA_LIVE_BROWSER=1 npx vitest run tests/live/autopair.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChromeBridge, FileSecretStore } from '../../src/main/chrome/ChromeBridge';
import { publishBootstrap } from '../../src/main/chrome/bootstrapFile';
import { findBrowserExe, prepareExtensionCopy, sleep, startTestBrowser, waitFor } from './liveSupport';
import type { TestBrowser } from './liveSupport';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const BRIDGE_PORT = 47851;
const KEYED_DEBUG_PORT = 9350;
const BARE_DEBUG_PORT = 9351;

/** What the extension's worker writes to the browser's Errors list (console errors, thrown errors, error-level log entries). */
class WorkerWatch {
  readonly errors: string[] = [];
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
      for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable']) ws.send(JSON.stringify({ id: ++id, method }));
    };
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data)) as { method?: string; params?: Record<string, any> };
      if (d.method === 'Runtime.exceptionThrown') this.errors.push(`exception: ${String(d.params?.['exceptionDetails']?.exception?.description ?? d.params?.['exceptionDetails']?.text)}`);
      else if (d.method === 'Runtime.consoleAPICalled' && d.params?.['type'] === 'error') {
        this.errors.push(`console.error: ${(d.params['args'] as Array<{ value?: unknown; description?: string }>).map((a) => String(a.value ?? a.description ?? '')).join(' ')}`);
      } else if (d.method === 'Log.entryAdded' && d.params?.['entry']?.level === 'error') this.errors.push(`log.${String(d.params['entry'].source)}: ${String(d.params['entry'].text)}`);
    };
  }

  stop(): void {
    this.stopped = true;
  }
}

describe.skipIf(!live || findBrowserExe('chrome') === undefined)('the extension pairs by itself', () => {
  describe('with the key in its folder', () => {
    let browser: TestBrowser;
    let ext: { dir: string; cleanup: () => void };
    let secretsDir: string;
    let secrets: FileSecretStore;
    let bridge: ChromeBridge | null = null;
    const startBridge = async (): Promise<void> => {
      bridge = new ChromeBridge({ secrets, port: BRIDGE_PORT });
      if (!(await bridge.start())) throw new Error('port busy');
    };

    beforeAll(async () => {
      secretsDir = mkdtempSync(join(tmpdir(), 'eya-autopair-'));
      secrets = new FileSecretStore(join(secretsDir, 'chrome-bridge.json'));
      ext = prepareExtensionCopy(BRIDGE_PORT);
      expect(publishBootstrap(ext.dir, secrets.bootstrapToken())).toBe(true);
      browser = await startTestBrowser({ kind: 'chrome', extensionDir: ext.dir, debugPort: KEYED_DEBUG_PORT });
    }, 90_000);

    afterAll(async () => {
      browser?.kill();
      await bridge?.stop();
      await sleep(500);
      browser?.cleanup();
      ext?.cleanup();
      rmSync(secretsDir, { recursive: true, force: true });
    }, 30_000);

    it('Eya starts, nobody says anything, and the extension is connected and paired', async () => {
      await startBridge();
      expect((bridge as ChromeBridge).pairingOpen()).toBe(false);
      await waitFor(() => (bridge as ChromeBridge).isConnected('chrome'), 60_000, 'the extension to pair by itself');
      expect((bridge as ChromeBridge).pairingOpen()).toBe(false); // never opened
      expect((bridge as ChromeBridge).info().browsers['chrome']).toMatchObject({ connected: true, paired: true, extensionVersion: '0.9.0' });
      expect(secrets.loadHash('chrome')).toMatch(/^[0-9a-f]{64}$/);
    }, 90_000);

    it('Eya is restarted: it reconnects with the secret it was given, without pairing again', async () => {
      const hash = secrets.loadHash('chrome');
      await (bridge as ChromeBridge).stop();
      await sleep(3000);
      await startBridge();
      await waitFor(() => (bridge as ChromeBridge).isConnected('chrome'), 60_000, 'the extension to reconnect');
      expect(secrets.loadHash('chrome')).toBe(hash);
    }, 120_000);

    it('every pairing is forgotten (or the extension was reinstalled): it pairs again by itself, with a new secret', async () => {
      const hash = secrets.loadHash('chrome');
      (bridge as ChromeBridge).forgetPairing();
      await waitFor(() => !(bridge as ChromeBridge).isConnected('chrome'), 10_000, 'the connection to drop');
      await waitFor(() => (bridge as ChromeBridge).isConnected('chrome'), 60_000, 'the extension to pair again');
      expect(secrets.loadHash('chrome')).toMatch(/^[0-9a-f]{64}$/);
      expect(secrets.loadHash('chrome')).not.toBe(hash);
      expect((bridge as ChromeBridge).pairingOpen()).toBe(false);
    }, 120_000);
  });

  describe('without the key (an older Eya, or a folder she cannot write to)', () => {
    let browser: TestBrowser;
    let ext: { dir: string; cleanup: () => void };
    let secretsDir: string;
    let watch: WorkerWatch;
    let bridge: ChromeBridge | null = null;

    beforeAll(async () => {
      secretsDir = mkdtempSync(join(tmpdir(), 'eya-autopair-bare-'));
      ext = prepareExtensionCopy(BRIDGE_PORT);
      watch = new WorkerWatch(BARE_DEBUG_PORT);
      browser = await startTestBrowser({ kind: 'chrome', extensionDir: ext.dir, debugPort: BARE_DEBUG_PORT });
    }, 90_000);

    afterAll(async () => {
      watch?.stop();
      browser?.kill();
      await bridge?.stop();
      await sleep(500);
      browser?.cleanup();
      ext?.cleanup();
      rmSync(secretsDir, { recursive: true, force: true });
    }, 30_000);

    it('it waits to be paired — and the Errors list stays empty while it does — then the window the user opens still works', async () => {
      // No key file in this copy of the folder, and this Eya has none to compare with: the window is the only way, as before.
      bridge = new ChromeBridge({ secrets: new FileSecretStore(join(secretsDir, 'chrome-bridge.json')), port: BRIDGE_PORT });
      expect(await bridge.start()).toBe(true);
      await waitFor(() => (bridge as ChromeBridge).waitingToPair().includes('chrome'), 60_000, 'the extension to knock');
      await sleep(25_000); // several retries
      // eslint-disable-next-line no-console
      console.log(`  [no key file, waiting to be paired, ~25 s] errors in the extension's list: ${watch.errors.length}\n    ${[...new Set(watch.errors)].join('\n    ')}`);
      expect(watch.errors).toEqual([]);
      expect((bridge as ChromeBridge).isConnected('chrome')).toBe(false);

      (bridge as ChromeBridge).openPairingWindow();
      await waitFor(() => (bridge as ChromeBridge).isConnected('chrome'), 60_000, 'the extension to pair in the window');
    }, 180_000);
  });
});
