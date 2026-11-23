import { describe, it, expect } from 'vitest';
import { CommunicationAccessStore } from '../src/main/privacy/communicationAccessStore';
import type { StoreIo } from '../src/main/privacy/communicationAccessStore';
import { CommunicationPolicy, COMMUNICATION_APPS } from '../src/main/privacy/communicationAccess';
import { applyChange, stateOf } from '../src/main/privacy/communicationAccessIpc';

class MemoryIo implements StoreIo {
  files = new Map<string, string>();
  writes = 0;
  failWrites = false;
  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }
  write(path: string, text: string): void {
    if (this.failWrites) throw new Error('disk full');
    this.writes += 1;
    this.files.set(path, text);
  }
}

const PATH = 'C:\\data\\communication-access.json';

describe('the saved choice', () => {
  it('is OFF when there is no file yet (a brand-new install)', () => {
    const store = new CommunicationAccessStore(PATH, new MemoryIo());
    expect(store.load()).toEqual({ enabled: false, apps: {} });
    expect(store.get().enabled).toBe(false);
  });

  it('is OFF when the file is damaged or says something it should not', () => {
    for (const text of ['', '{not json', 'null', '"on"', '[]', '{"enabled":"yes"}', '{"enabled":1}', '{"apps":{"whatsapp":true}}']) {
      const io = new MemoryIo();
      io.files.set(PATH, text);
      expect(new CommunicationAccessStore(PATH, io).load().enabled, text).toBe(false);
    }
  });

  it('survives a restart: what was saved is what is loaded', () => {
    const io = new MemoryIo();
    const first = new CommunicationAccessStore(PATH, io);
    first.set({ enabled: true, apps: { instagram: false } });
    const second = new CommunicationAccessStore(PATH, io);
    expect(second.load()).toEqual({ enabled: true, apps: { instagram: false } });
  });

  it('writes only the switch and the per-app choices — nothing from any chat', () => {
    const io = new MemoryIo();
    new CommunicationAccessStore(PATH, io).set({ enabled: true, apps: { whatsapp: true } });
    expect(JSON.parse(io.files.get(PATH) as string)).toEqual({ enabled: true, apps: { whatsapp: true } });
  });

  it('cleans what it is given: unknown apps and non-booleans never get saved', () => {
    const io = new MemoryIo();
    const store = new CommunicationAccessStore(PATH, io);
    store.set({ enabled: true, apps: { whatsapp: false, hacked: true, telegram: 'yes' as never } });
    expect(JSON.parse(io.files.get(PATH) as string)).toEqual({ enabled: true, apps: { whatsapp: false } });
  });

  it('if it cannot be saved, it is NOT applied — the switch never claims a state it did not keep', () => {
    const io = new MemoryIo();
    const store = new CommunicationAccessStore(PATH, io);
    store.set({ enabled: true, apps: {} });
    io.failWrites = true;
    expect(() => store.set({ enabled: false, apps: {} })).toThrow(/disk full/);
    expect(store.get().enabled).toBe(true);
  });

  it('tells listeners when it changes, and stops when they leave', () => {
    const store = new CommunicationAccessStore(PATH, new MemoryIo());
    const seen: boolean[] = [];
    const off = store.onChange((s) => seen.push(s.enabled));
    store.set({ enabled: true, apps: {} });
    store.set({ enabled: false, apps: {} });
    off();
    store.set({ enabled: true, apps: {} });
    expect(seen).toEqual([true, false]);
  });
});

describe('changing it from the panel', () => {
  const ids = COMMUNICATION_APPS.map((a) => a.id);
  const off = { enabled: false, apps: {} };

  it('turns the master switch on and off', () => {
    expect(applyChange(off, { enabled: true }, ids).enabled).toBe(true);
    expect(applyChange({ enabled: true, apps: {} }, { enabled: false }, ids).enabled).toBe(false);
  });

  it('allows or excludes one app without touching the master switch', () => {
    const on = { enabled: true, apps: {} };
    expect(applyChange(on, { app: { id: 'instagram', allowed: false } }, ids)).toEqual({ enabled: true, apps: { instagram: false } });
    expect(applyChange(off, { app: { id: 'whatsapp', allowed: true } }, ids)).toEqual({ enabled: false, apps: { whatsapp: true } }); // still off
  });

  it('keeps the exclusions when the master switch is turned off and on again — it never quietly re-allows an app', () => {
    let s = applyChange({ enabled: true, apps: {} }, { app: { id: 'instagram', allowed: false } }, ids);
    s = applyChange(s, { enabled: false }, ids);
    s = applyChange(s, { enabled: true }, ids);
    expect(s).toEqual({ enabled: true, apps: { instagram: false } });
  });

  it('ignores anything that is not a plain boolean or a known app', () => {
    const on = { enabled: true, apps: {} };
    for (const bad of [null, undefined, 'on', 5, [], { enabled: 'true' }, { enabled: 1 }, { app: { id: 'nonsense', allowed: true } }, { app: { id: 'whatsapp', allowed: 'yes' } }, { app: 'whatsapp' }]) {
      expect(applyChange(on, bad, ids), JSON.stringify(bad)).toEqual(on);
    }
    expect(applyChange(off, { enabled: 'true' }, ids).enabled).toBe(false);
  });

  it('shows the panel the switch and each chat app with whether it is allowed (and not the ones with nothing to block)', () => {
    const p = new CommunicationPolicy(() => ({ enabled: true, apps: { instagram: false } }));
    const state = stateOf(p);
    expect(state.enabled).toBe(true);
    expect(state.apps.find((a) => a.id === 'instagram')).toEqual({ id: 'instagram', name: 'Instagram', allowed: false });
    expect(state.apps.find((a) => a.id === 'whatsapp')).toEqual({ id: 'whatsapp', name: 'WhatsApp', allowed: true });
    expect(state.apps.length).toBe(COMMUNICATION_APPS.length);
  });
});
