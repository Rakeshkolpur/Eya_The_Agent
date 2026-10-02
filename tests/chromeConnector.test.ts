import { describe, it, expect } from 'vitest';
import { createChromeConnector } from '../src/main/chrome/chromeConnector';
import type { ConnectorBridge } from '../src/main/chrome/chromeConnector';
import type { BrowserName } from '../src/main/chrome/protocol';

interface Script {
  /** When (ms of fake time) each browser's extension connects. Unlisted browsers never do. */
  connectsAt?: Partial<Record<BrowserName, number>>;
  /** Browsers whose extension is running and trying to connect (knocking) from the start. */
  knocking?: BrowserName[];
  /** Browsers that were paired in an earlier session. */
  paired?: BrowserName[];
  alreadyConnected?: BrowserName[];
}

function setup(s: Script = {}) {
  let clock = 0;
  const log: string[] = [];
  const connectedNow = (): BrowserName[] =>
    (['chrome', 'edge', 'other'] as const).filter((b) => (s.alreadyConnected ?? []).includes(b) || (s.connectsAt?.[b] !== undefined && clock >= (s.connectsAt[b] as number)));
  const bridge: ConnectorBridge & { windows: number } = {
    windows: 0,
    isConnected: (b) => (b === undefined ? connectedNow().length > 0 : connectedNow().includes(b)),
    connectedBrowsers: connectedNow,
    waitingToPair: () => (s.knocking ?? []).filter((b) => !connectedNow().includes(b)),
    info: () => ({
      browsers: Object.fromEntries(
        (['chrome', 'edge', 'other'] as const)
          .filter((b) => connectedNow().includes(b) || (s.paired ?? []).includes(b) || (s.knocking ?? []).includes(b))
          .map((b) => [b, { connected: connectedNow().includes(b), paired: (s.paired ?? []).includes(b) }]),
      ),
    }),
    openPairingWindow: () => {
      bridge.windows += 1;
      return 1;
    },
  };
  const connector = createChromeConnector({
    bridge,
    extensionFolder: 'C:\\app\\eya-chrome-extension',
    openExtensionsPage: async () => void log.push('page'),
    revealFolder: async (p) => void log.push(`folder:${p}`),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
  });
  return { connector, bridge, log };
}

describe('connect my browser', () => {
  it('says so and does nothing else when everything running is already connected', async () => {
    const { connector, bridge, log } = setup({ alreadyConnected: ['chrome'], paired: ['chrome'] });
    const r = await connector.connect();
    expect(r).toMatchObject({ connected: true, alreadyConnected: true, browsers: ['chrome'] });
    expect(bridge.windows).toBe(0);
    expect(log).toEqual([]);
  });

  it('first time (no extension has ever shown up): opens the pairing window AND helps add the extension, then reports it once connected', async () => {
    const { connector, bridge, log } = setup({ connectsAt: { chrome: 4000 } });
    const r = await connector.connect(20_000);
    expect(r).toMatchObject({ connected: true, alreadyConnected: false, helpOpened: true, browsers: ['chrome'] });
    expect(bridge.windows).toBe(1);
    expect(log).toEqual(['page', 'folder:C:\\app\\eya-chrome-extension']);
  });

  it('an extension is already knocking: just opens the window and lets it connect — no needless pop-ups', async () => {
    const { connector, log } = setup({ knocking: ['chrome'], connectsAt: { chrome: 3000 } });
    const r = await connector.connect(20_000);
    expect(r).toMatchObject({ connected: true, helpOpened: false, browsers: ['chrome'] });
    expect(log).toEqual([]);
  });

  it('connects Chrome AND Edge in one go when both extensions are knocking', async () => {
    const { connector, bridge } = setup({ knocking: ['chrome', 'edge'], connectsAt: { chrome: 2000, edge: 5000 } });
    const r = await connector.connect(20_000);
    expect(r.browsers).toEqual(['chrome', 'edge']);
    expect(r.stillWaiting).toEqual([]);
    expect(bridge.windows).toBe(1);
  });

  it('does not wait forever for a second browser: reports what connected and what is still waiting', async () => {
    const { connector } = setup({ knocking: ['chrome', 'edge'], connectsAt: { chrome: 1000 } });
    const r = await connector.connect(20_000);
    expect(r).toMatchObject({ connected: true, browsers: ['chrome'], stillWaiting: ['edge'] });
  });

  it('one browser is connected but another is knocking: still opens the window for the second', async () => {
    const { connector, bridge } = setup({ alreadyConnected: ['chrome'], knocking: ['edge'], connectsAt: { edge: 2000 } });
    const r = await connector.connect(20_000);
    expect(bridge.windows).toBe(1);
    expect(r.browsers).toEqual(['chrome', 'edge']);
    expect(r.alreadyConnected).toBe(false);
  });

  it('never connects within the wait: says it is waiting for the user, and (if it had not yet) opens the help', async () => {
    const { connector, log } = setup({ paired: ['chrome'] });
    const r = await connector.connect(5000);
    expect(r).toMatchObject({ connected: false, helpOpened: true, browsers: [], extensionFolder: 'C:\\app\\eya-chrome-extension' });
    expect(log).toEqual(['page', 'folder:C:\\app\\eya-chrome-extension']);
  });

  it('survives the browser refusing to open the extensions page', async () => {
    let clock = 0;
    const bridge: ConnectorBridge = {
      isConnected: () => false,
      connectedBrowsers: () => [],
      waitingToPair: () => [],
      info: () => ({ browsers: {} }),
      openPairingWindow: () => 1,
    };
    const connector = createChromeConnector({
      bridge,
      extensionFolder: 'x',
      openExtensionsPage: async () => {
        throw new Error('no handler');
      },
      revealFolder: async () => {
        throw new Error('no explorer');
      },
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
    });
    expect(await connector.connect(1000)).toMatchObject({ connected: false });
  });
});
