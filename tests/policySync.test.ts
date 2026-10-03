import { describe, it, expect } from 'vitest';
import { startPolicySync } from '../src/main/privacy/policySync';
import type { PolicySyncBridge } from '../src/main/privacy/policySync';
import type { BlockRule } from '../src/main/privacy/communicationAccess';
import type { BrowserName } from '../src/main/chrome/protocol';

function rig(opts: { connected?: BrowserName[]; fail?: Error } = {}) {
  const sent: Array<{ browser: BrowserName; op: string; args: unknown }> = [];
  const connectionListeners = new Set<(e: { browser: BrowserName; connected: boolean }) => void>();
  const changeListeners = new Set<() => void>();
  let rules: BlockRule[] = [{ host: 'web.whatsapp.com' }];
  const bridge: PolicySyncBridge = {
    connectedBrowsers: () => opts.connected ?? [],
    forBrowser: (browser) => ({
      request: async <T>(op: string, args?: Readonly<Record<string, unknown>>) => {
        sent.push({ browser, op, args });
        if (opts.fail !== undefined) throw opts.fail;
        return {} as T;
      },
    }),
    onConnectionChange: (l) => {
      connectionListeners.add(l);
      return () => connectionListeners.delete(l);
    },
  };
  const stop = startPolicySync({
    bridge,
    blockRules: () => rules,
    onPolicyChange: (l) => {
      changeListeners.add(l);
      return () => changeListeners.delete(l);
    },
  });
  return {
    sent,
    stop,
    connect: (browser: BrowserName) => connectionListeners.forEach((l) => l({ browser, connected: true })),
    disconnect: (browser: BrowserName) => connectionListeners.forEach((l) => l({ browser, connected: false })),
    change: (next: BlockRule[]) => {
      rules = next;
      changeListeners.forEach((l) => l());
    },
    listeners: () => connectionListeners.size + changeListeners.size,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('keeping the browser extension in step with the Communication Access switch', () => {
  it('sends the block list the moment a browser connects', async () => {
    const r = rig();
    r.connect('chrome');
    await tick();
    expect(r.sent).toEqual([{ browser: 'chrome', op: 'set_policy', args: { blocked: [{ host: 'web.whatsapp.com' }] } }]);
  });

  it('sends it again to every connected browser whenever the user changes the switch', async () => {
    const r = rig({ connected: ['chrome', 'edge'] });
    r.change([]);
    await tick();
    expect(r.sent.map((s) => s.browser).sort()).toEqual(['chrome', 'edge']);
    expect(r.sent.every((s) => JSON.stringify(s.args) === JSON.stringify({ blocked: [] }))).toBe(true);
  });

  it('sends the CURRENT list, not the one from when it started', async () => {
    const r = rig();
    r.change([{ host: 'instagram.com' }]);
    r.connect('edge');
    await tick();
    expect(r.sent.at(-1)?.args).toEqual({ blocked: [{ host: 'instagram.com' }] });
  });

  it('does nothing when a browser disconnects, and nothing after it is stopped', async () => {
    const r = rig({ connected: ['chrome'] });
    r.disconnect('chrome');
    await tick();
    expect(r.sent).toEqual([]);
    r.stop();
    expect(r.listeners()).toBe(0);
    r.connect('chrome');
    r.change([]);
    await tick();
    expect(r.sent).toEqual([]);
  });

  it('survives an extension that is too old to know the request, or a failed send — the extension then simply stays blocked', async () => {
    const old = rig({ fail: new Error('Unknown request: set_policy') });
    old.connect('chrome');
    await tick();
    expect(old.sent).toHaveLength(1);
    const broken = rig({ fail: new Error('socket closed') });
    broken.connect('chrome');
    await tick();
    expect(broken.sent).toHaveLength(1); // no throw, no crash
  });
});
