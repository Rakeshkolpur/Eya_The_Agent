import { describe, expect, it } from 'vitest';
import { LiveChatSwitch, LiveChatSwitchStore, parseSwitchSaved, SWITCH_OFF, SWITCH_PERMISSIONS } from '../src/main/livechat/LiveChatSwitch';
import { WHATSAPP_PLUGIN, whatsappConnector } from '../src/main/plugins/builtin/whatsapp';
import { LocalCatalog } from '../src/main/plugins/catalog';
import { PluginManager } from '../src/main/plugins/PluginManager';
import { PluginStateStore } from '../src/main/plugins/PluginStateStore';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { CommunicationSettings } from '../src/main/privacy/communicationAccess';
import { CommunicationAccessStore } from '../src/main/privacy/communicationAccessStore';
import type { StoreIo } from '../src/main/privacy/communicationAccessStore';

/**
 * The one "Enable live chat" switch, over the REAL plugin manager and the real WhatsApp connector (Communication Access): what one click puts in place, that turning it
 * off puts back only what it changed, and that a permission taken away afterwards shows. (The switch is the person's own click on Eya's page: nothing here is reachable
 * by a tool.)
 */

const TOOLS = new Set(WHATSAPP_PLUGIN.actions.flatMap((a) => a.tools));

function memoryIo(): { io: StoreIo; files: Map<string, string> } {
  const files = new Map<string, string>();
  return { files, io: { read: (p) => files.get(p) ?? null, write: (p, t) => void files.set(p, t) } };
}

function world(options: { access?: CommunicationSettings; granted?: string[]; disabled?: boolean; connect?: boolean } = {}) {
  const accessIo = memoryIo();
  const access = new CommunicationAccessStore('access.json', accessIo.io);
  if (options.access !== undefined) access.set(options.access);
  else access.load();
  const policy = new CommunicationPolicy(() => access.get());
  const pluginIo = memoryIo();
  const manager = new PluginManager({
    catalog: new LocalCatalog(),
    store: new PluginStateStore('plugins.json', pluginIo.io),
    connectors: { whatsapp: whatsappConnector(policy, access) },
    eyaVersion: '0.1.0',
    knownTools: () => TOOLS,
  });
  // (a first run with WhatsApp already allowed would grant everything; the person's own choices are made by hand afterwards, as here)
  if (options.connect === true) manager.apply({ kind: 'connect', id: 'whatsapp' });
  for (const permission of options.granted ?? []) manager.apply({ kind: 'grant', id: 'whatsapp', permission });
  if (options.disabled === true) manager.apply({ kind: 'disable', id: 'whatsapp' });
  const switchIo = memoryIo();
  const store = new LiveChatSwitchStore('live-chat-switch.json', switchIo.io);
  const sw = new LiveChatSwitch(manager, store, () => 1_800_000_000_000);
  const view = () => manager.list().find((p) => p.id === 'whatsapp');
  const granted = (): string[] => (view()?.permissions ?? []).filter((p) => p.granted).map((p) => p.id).sort();
  return { sw, manager, access, policy, store, switchIo, view, granted, restarted: () => new LiveChatSwitch(manager, new LiveChatSwitchStore('live-chat-switch.json', switchIo.io)) };
}

describe('one click puts everything the live chat needs in place', () => {
  it('from nothing: WhatsApp allowed in Eya, the plugin on, and the three permissions — and the switch reads as ready', () => {
    const w = world();
    expect(w.sw.view()).toMatchObject({ on: false, ready: false });
    expect(w.granted()).toEqual([]); // (fresh: nothing granted, Chats off)
    const r = w.sw.turnOn();
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/know that replies are written with AI help/);
    expect(w.view()?.connection).toBe('connected');
    expect(w.granted()).toEqual(['chats.live', 'chats.read', 'messages.send']);
    expect(w.sw.view()).toMatchObject({ on: true, ready: true });
    expect(w.sw.view().items.every((i) => i.ok)).toBe(true);
    expect(w.sw.standing()).toBe(true);
  });

  it('it grants ONLY what the live chat needs: not "Send files", not "Find files in chats"', () => {
    const w = world();
    w.sw.turnOn();
    expect(w.granted()).not.toContain('files.send');
    expect(w.granted()).not.toContain('files.find');
    expect(SWITCH_PERMISSIONS.map((p) => p.id)).toEqual(['chats.read', 'chats.live', 'messages.send']);
  });

  it('what the person had already allowed is not counted as the switch\'s: turning it off leaves it', () => {
    const w = world({ connect: true, granted: ['chats.read', 'files.send'] });
    w.sw.turnOn();
    expect(w.granted()).toEqual(['chats.live', 'chats.read', 'files.send', 'messages.send']);
    const off = w.sw.turnOff();
    expect(off.ok, off.message).toBe(true);
    expect(w.granted()).toEqual(['chats.read', 'files.send']); // the two it gave are gone, the person's own stay
    expect(w.view()?.connection).toBe('connected'); // WhatsApp was already allowed: it stays allowed
    expect(w.sw.view().on).toBe(false);
    expect(off.message).toMatch(/left as it was/);
  });

  it('Chats that the switch itself turned on are turned off again with it', () => {
    const w = world({ access: { enabled: false, apps: {} } });
    w.sw.turnOn();
    expect(w.view()?.connection).toBe('connected');
    w.sw.turnOff();
    expect(w.view()?.connection).toBe('not_connected');
    expect(w.granted()).toEqual([]);
  });

  it('a plugin that was switched off is switched on, and off again with the switch', () => {
    const w = world({ disabled: true });
    expect(w.view()?.enabled).toBe(false);
    w.sw.turnOn();
    expect(w.view()?.enabled).toBe(true);
    w.sw.turnOff();
    expect(w.view()?.enabled).toBe(false);
  });

  it('turning it on twice changes nothing more, and turning it off twice is harmless', () => {
    const w = world();
    w.sw.turnOn();
    const first = w.granted();
    expect(w.sw.turnOn().ok).toBe(true);
    expect(w.granted()).toEqual(first);
    expect(w.sw.turnOff().ok).toBe(true);
    expect(w.sw.turnOff().ok).toBe(true);
    expect(w.granted()).toEqual([]);
  });
});

describe('what the switch shows', () => {
  it('a permission taken away on the Plugins page afterwards shows: still "on", no longer ready, the missing part named — and one click puts it back', () => {
    const w = world();
    w.sw.turnOn();
    w.manager.apply({ kind: 'revoke', id: 'whatsapp', permission: 'messages.send' });
    const v = w.sw.view();
    expect(v).toMatchObject({ on: true, ready: false });
    expect(v.items.filter((i) => !i.ok).map((i) => i.id)).toEqual(['messages.send']);
    expect(w.sw.standing()).toBe(false); // (a standing yes is only as good as what it stands on)
    expect(w.sw.turnOn().ok).toBe(true);
    expect(w.sw.view().ready).toBe(true);
  });

  it('Chats switched off afterwards shows too', () => {
    const w = world();
    w.sw.turnOn();
    w.access.set({ enabled: false, apps: {} });
    expect(w.sw.view()).toMatchObject({ on: true, ready: false });
    expect(w.sw.view().items.find((i) => i.id === 'connected')?.ok).toBe(false);
  });
});

describe('what survives a restart', () => {
  it('on stays on, and what the switch gave is still known (so off still puts back only that)', () => {
    const w = world({ granted: ['chats.read'] });
    w.sw.turnOn();
    const again = w.restarted();
    expect(again.view()).toMatchObject({ on: true, ready: true });
    again.turnOff();
    expect(w.granted()).toEqual(['chats.read']);
  });

  it('a damaged or foreign file is the same as no file: the switch is off', () => {
    expect(parseSwitchSaved(null)).toBeNull();
    expect(parseSwitchSaved({ version: 2, on: true })).toBeNull();
    expect(parseSwitchSaved({ version: 1, on: true, granted: ['chats.live', 'files.send', 42], enabledPlugin: 'yes', connected: true })).toEqual({
      version: 1,
      on: true,
      granted: ['chats.live'], // (only what the switch can give is believed)
      enabledPlugin: false,
      connected: true,
      at: null,
      ownerName: '',
    });
    const w = world();
    w.switchIo.files.set('live-chat-switch.json', '{not json');
    expect(w.restarted().view().on).toBe(false);
    expect(SWITCH_OFF.on).toBe(false);
  });
});

describe('when it cannot be done', () => {
  it('says why and does not claim to be on', () => {
    const w = world();
    const failing = { list: () => w.manager.list(), apply: () => ({ ok: false, message: 'The WhatsApp plugin cannot be connected here.', snapshot: w.manager.snapshot() }) };
    const sw = new LiveChatSwitch(failing, new LiveChatSwitchStore('x.json', memoryIo().io));
    const r = sw.turnOn();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/cannot be connected here/);
    expect(r.message).toMatch(/was not enabled/);
    expect(sw.view().on).toBe(false);
    expect(sw.standing()).toBe(false);
  });

  it('a step that fails part-way keeps a record of what was already done, so that off puts it back', () => {
    const w = world();
    let granted = 0;
    const flaky = {
      list: () => w.manager.list(),
      apply: (c: Parameters<PluginManager['apply']>[0]) => {
        if (c.kind === 'grant') {
          granted += 1;
          if (granted === 2) return { ok: false, message: 'Could not save.', snapshot: w.manager.snapshot() };
        }
        return w.manager.apply(c);
      },
    };
    const sw = new LiveChatSwitch(flaky, new LiveChatSwitchStore('y.json', memoryIo().io));
    expect(sw.turnOn().ok).toBe(false);
    expect(sw.view().on).toBe(false);
    expect(w.granted()).toEqual(['chats.read']);
    expect(sw.turnOff().ok).toBe(true);
    expect(w.granted()).toEqual([]);
  });
});
