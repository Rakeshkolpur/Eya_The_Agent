import { describe, it, expect } from 'vitest';
import { createChromeConnector } from '../src/main/chrome/chromeConnector';
import type { ConnectorBridge } from '../src/main/chrome/chromeConnector';

function setup(opts: { connected?: boolean; paired?: boolean; connectsAfterMs?: number } = {}) {
  let clock = 0;
  const log: string[] = [];
  const bridge: ConnectorBridge & { windows: number } = {
    windows: 0,
    isConnected: () => (opts.connected ?? false) || (opts.connectsAfterMs !== undefined && clock >= opts.connectsAfterMs),
    info: () => ({ connected: bridge.isConnected(), browser: 'edge', paired: opts.paired ?? false }),
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
  it('says so and does nothing else when the browser is already connected', async () => {
    const { connector, bridge, log } = setup({ connected: true });
    const r = await connector.connect();
    expect(r).toMatchObject({ connected: true, alreadyConnected: true, browser: 'edge' });
    expect(bridge.windows).toBe(0);
    expect(log).toEqual([]);
  });

  it('first time: opens the pairing window AND helps the user add the extension (page + folder), then reports success once it connects', async () => {
    const { connector, bridge, log } = setup({ paired: false, connectsAfterMs: 4000 });
    const r = await connector.connect(20_000);
    expect(r).toMatchObject({ connected: true, alreadyConnected: false, helpOpened: true });
    expect(bridge.windows).toBe(1);
    expect(log).toEqual(['page', 'folder:C:\\app\\eya-chrome-extension']);
  });

  it('already paired once: just opens the window and waits — no needless pop-ups if the extension reconnects by itself', async () => {
    const { connector, log } = setup({ paired: true, connectsAfterMs: 3000 });
    const r = await connector.connect(20_000);
    expect(r).toMatchObject({ connected: true, helpOpened: false });
    expect(log).toEqual([]);
  });

  it('never connects within the wait: says it is waiting for the user, and (if it had not yet) opens the help', async () => {
    const { connector, log } = setup({ paired: true });
    const r = await connector.connect(5000);
    expect(r).toMatchObject({ connected: false, helpOpened: true, extensionFolder: 'C:\\app\\eya-chrome-extension' });
    expect(log).toEqual(['page', 'folder:C:\\app\\eya-chrome-extension']);
  });

  it('survives the browser refusing to open the extensions page', async () => {
    const bridge: ConnectorBridge = {
      isConnected: () => false,
      info: () => ({ connected: false, paired: false }),
      openPairingWindow: () => 1,
    };
    let clock = 0;
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
