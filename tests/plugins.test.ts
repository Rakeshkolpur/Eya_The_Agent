import { describe, expect, it } from 'vitest';
import { createLiveChatTool } from '../src/main/tools/impl/liveChatTool';
import { EMPTY_LIVE_CHAT_VIEW } from '../src/shared/liveChat';
import { WHATSAPP_PLUGIN, whatsappConnector } from '../src/main/plugins/builtin/whatsapp';
import { LocalCatalog } from '../src/main/plugins/catalog';
import { compareVersions, compatibility, parseVersion, soundEntries, supportedPermissions, validateManifest } from '../src/main/plugins/manifest';
import { PluginManager } from '../src/main/plugins/PluginManager';
import { parseState, PluginStateStore } from '../src/main/plugins/PluginStateStore';
import type { CatalogEntry, CatalogSource, PluginConnector, PluginManifest, PluginState } from '../src/main/plugins/types';
import { ChatSession } from '../src/main/chat/chatSession';
import { CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { CommunicationSettings } from '../src/main/privacy/communicationAccess';
import { CommunicationAccessStore } from '../src/main/privacy/communicationAccessStore';
import type { StoreIo } from '../src/main/privacy/communicationAccessStore';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { createBrowserTools } from '../src/main/tools/impl/browserTools';
import { createChatSendGate, createChatTools } from '../src/main/tools/impl/chatTools';
import type { Tool, ToolResult } from '../src/main/tools/types';
import { FakeChatApp, FakeDisk } from './chatFixtures';

/**
 * The plugin framework: a manifest is data that can only name tools Eya already has; installing is not connecting is not granting; a tool of a plugin that
 * cannot be used is hidden from the AI and refused if called; a Send in a chat app is held to the plugin's permission; and what the person chose survives a restart.
 */

const HOME = 'C:\\Users\\Test';
const folders: KnownFolders = { home: HOME, downloads: `${HOME}\\Downloads`, desktop: `${HOME}\\Desktop`, documents: `${HOME}\\Documents`, pictures: `${HOME}\\Pictures`, videos: `${HOME}\\Videos`, music: `${HOME}\\Music`, temp: HOME };
const WHATSAPP_TOOLS = ['find_chat', 'find_chat_files', 'live_chat', 'learn_chat_names', 'fill_on_page', 'click_on_page', 'share_file_to_chat', 'attach_file', 'verify_sent'];
const EYA = '0.1.0';

/** A second plugin, for the tests of more than one: two note-keeping tools, a real manifest over fake tools. */
const NOTES: PluginManifest = {
  id: 'notes',
  name: 'Notes',
  description: 'Keep short notes.',
  version: '1.0.0',
  author: 'Test',
  compat: { minEya: '0.1.0' },
  auth: { kind: 'none', describe: 'Nothing to connect.' },
  permissions: [
    { id: 'notes.read', label: 'Read notes', description: 'Read the notes.', risk: 'read' },
    { id: 'notes.write', label: 'Save notes', description: 'Save a note.', risk: 'write' },
  ],
  actions: [
    { id: 'read_notes', label: 'Read notes', description: 'Read the notes.', tools: ['notes_read'], gate: 'registry', permission: 'notes.read', verify: 'Returns the notes.' },
    { id: 'save_note', label: 'Save a note', description: 'Save a note.', tools: ['notes_save'], gate: 'registry', permission: 'notes.write', verify: 'Reads it back.' },
  ],
};

function memoryIo(initial: Record<string, string> = {}): { io: StoreIo; files: Map<string, string>; failWrites: { on: boolean } } {
  const files = new Map(Object.entries(initial));
  const failWrites = { on: false };
  return {
    files,
    failWrites,
    io: {
      read: (p) => files.get(p) ?? null,
      write: (p, text) => {
        if (failWrites.on) throw new Error('disk is read-only');
        files.set(p, text);
      },
    },
  };
}

interface World {
  readonly manager: PluginManager;
  readonly tools: ToolRegistry;
  readonly policy: CommunicationPolicy;
  readonly access: CommunicationAccessStore;
  readonly stateFiles: Map<string, string>;
  readonly accessFiles: ReturnType<typeof memoryIo>;
  readonly calls: string[];
  restart(options?: { eyaVersion?: string; catalog?: CatalogSource }): World;
}

const noop = (name: string): Tool => ({ schema: { name, description: name, args: {} }, execute: async (): Promise<ToolResult> => ({ ok: true, summary: `${name} ran` }) });

function world(options: { access?: CommunicationSettings; catalog?: CatalogSource; eyaVersion?: string; extraTools?: string[]; state?: Map<string, string>; accessFiles?: ReturnType<typeof memoryIo> } = {}): World {
  const accessFiles = options.accessFiles ?? memoryIo();
  const access = new CommunicationAccessStore('access.json', accessFiles.io);
  if (options.access !== undefined) access.set(options.access);
  else access.load();
  const policy = new CommunicationPolicy(() => access.get());
  const stateFiles = options.state ?? new Map<string, string>();
  const stateIo: StoreIo = { read: (p) => stateFiles.get(p) ?? null, write: (p, t) => void stateFiles.set(p, t) };
  const tools = new ToolRegistry();
  const calls: string[] = [];
  for (const name of [...WHATSAPP_TOOLS, ...(options.extraTools ?? [])]) {
    tools.register({ schema: { name, description: name, args: {} }, execute: async () => (calls.push(name), { ok: true, summary: `${name} ran` }) });
  }
  const manager = new PluginManager({
    catalog: options.catalog ?? new LocalCatalog(),
    store: new PluginStateStore('plugins.json', stateIo),
    connectors: { whatsapp: whatsappConnector(policy, access) },
    eyaVersion: options.eyaVersion ?? EYA,
    knownTools: () => new Set(tools.list().map((t) => t.schema.name)),
  });
  tools.setGuard({ blocked: (n) => manager.blockFor(n), observe: (n, r) => manager.observe(n, r) });
  const self: World = {
    manager,
    tools,
    policy,
    access,
    stateFiles,
    accessFiles,
    calls,
    restart: (o = {}) => world({ ...options, ...o, state: stateFiles, accessFiles }),
  };
  return self;
}

const catalogOf = (...manifests: PluginManifest[]): CatalogSource => ({ name: 'Test catalogue', remote: false, entries: () => manifests.map((manifest): CatalogEntry => ({ manifest, trust: 'built-in' })) });
const ON: CommunicationSettings = { enabled: true, apps: {} };

// ------------------------------------------------------------------------------------------------------------------ the catalogue and its manifests
describe('manifests and the catalogue', () => {
  it('the WhatsApp manifest is sound, and every tool it names really exists in Eya', () => {
    // (the real tools, not stand-ins: a manifest that names a tool that was renamed or removed must fail here, not mislead the person)
    const reg = new ToolRegistry();
    const app = new FakeChatApp();
    const policy = new CommunicationPolicy(() => ON);
    const session = new ChatSession();
    for (const t of createChatTools({ service: app, policy, session, folders, files: new FakeDisk() })) reg.register(t);
    for (const t of createBrowserTools(app)) reg.register(t);
    reg.register(createLiveChatTool({ handle: async () => ({ ok: true, message: '', view: EMPTY_LIVE_CHAT_VIEW }), view: () => EMPTY_LIVE_CHAT_VIEW }));
    const known = new Set(reg.list().map((t) => t.schema.name));
    expect(validateManifest(WHATSAPP_PLUGIN, { knownTools: known })).toEqual([]);
    expect(new LocalCatalog().entries()).toHaveLength(1);
  });

  it('what WhatsApp cannot do is declared as not supported, with no tool and no permission: nothing is promised that is not there', () => {
    const unsupported = WHATSAPP_PLUGIN.actions.filter((a) => a.unsupported !== undefined);
    expect(unsupported.map((a) => a.id).sort()).toEqual(['download_attachment', 'find_messages']);
    for (const a of unsupported) {
      expect(a.tools).toEqual([]);
      expect(a.permission).toBeUndefined();
    }
    // and no permission exists only for something that is not supported
    expect(supportedPermissions(WHATSAPP_PLUGIN).sort()).toEqual(['chats.live', 'chats.read', 'files.find', 'files.send', 'messages.send']);
  });

  it('refuses a manifest that is wrong, saying why', () => {
    const known = new Set(WHATSAPP_TOOLS);
    const bad = (change: Partial<PluginManifest>): string[] => validateManifest({ ...WHATSAPP_PLUGIN, ...change }, { knownTools: known });
    expect(bad({ id: 'Bad Id' }).join(' ')).toMatch(/id/);
    expect(bad({ version: '1.2' }).join(' ')).toMatch(/version/);
    expect(bad({ name: ' ' }).join(' ')).toMatch(/no name/);
    expect(bad({ description: '' }).join(' ')).toMatch(/no description/);
    expect(bad({ compat: { minEya: 'new' } }).join(' ')).toMatch(/oldest Eya/);
    expect(bad({ actions: [...WHATSAPP_PLUGIN.actions, { id: 'x_run', label: 'x', description: 'x', tools: ['no_such_tool'], gate: 'registry', permission: 'chats.read', verify: 'x' }] }).join(' ')).toMatch(/tool that does not exist: no_such_tool/);
    expect(bad({ actions: [{ id: 'x_run', label: 'x', description: 'x', tools: ['find_chat'], gate: 'registry', permission: 'nothing.here', verify: 'x' }] }).join(' ')).toMatch(/not declared/);
    expect(bad({ actions: [{ id: 'x_run', label: 'x', description: 'x', tools: ['find_chat'], gate: 'registry', verify: 'x' }] }).join(' ')).toMatch(/needs a permission/);
    expect(bad({ actions: [{ id: 'x_run', label: 'x', description: 'x', tools: [], gate: 'registry', permission: 'chats.read', verify: 'x' }] }).join(' ')).toMatch(/no tool/);
    expect(bad({ actions: [{ id: 'x_run', label: 'x', description: 'x', tools: ['find_chat'], gate: 'registry', permission: 'chats.read', verify: ' ' }] }).join(' ')).toMatch(/how its result is checked/);
    expect(bad({ actions: [{ id: 'x_run', label: 'x', description: 'x', tools: ['find_chat'], gate: 'registry', permission: 'chats.read', unsupported: 'later', verify: 'x' }] }).join(' ')).toMatch(/not supported but names/);
    expect(bad({ permissions: [...WHATSAPP_PLUGIN.permissions, WHATSAPP_PLUGIN.permissions[0] as never] }).join(' ')).toMatch(/declared twice/);
    // an action that sends something cannot sit behind a "read" permission
    expect(bad({ permissions: WHATSAPP_PLUGIN.permissions.map((p) => (p.id === 'messages.send' ? { ...p, risk: 'read' as const } : p)) }).join(' ')).toMatch(/only "read"/);
  });

  it('a catalogue entry that is not sound, duplicated or not from a trusted origin is left out, and the rest is kept', () => {
    const known = new Set([...WHATSAPP_TOOLS, 'notes_read', 'notes_save']);
    const entries: CatalogEntry[] = [
      { manifest: WHATSAPP_PLUGIN, trust: 'built-in' },
      { manifest: WHATSAPP_PLUGIN, trust: 'built-in' },
      { manifest: { ...NOTES, id: 'bad id' }, trust: 'built-in' },
      { manifest: NOTES, trust: 'downloaded' as unknown as 'built-in' },
    ];
    const { good, refused } = soundEntries(entries, { knownTools: known });
    expect(good.map((e) => e.manifest.id)).toEqual(['whatsapp']);
    expect(refused.map((r) => r.id)).toEqual(['whatsapp', 'bad id', 'notes']);
    expect(refused[0]?.problems.join(' ')).toMatch(/same id/);
    expect(refused[2]?.problems.join(' ')).toMatch(/not trusted/);
  });

  it('reads versions and says whether a plugin works with this Eya', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('v1.2.3')).toBeNull();
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compatibility(WHATSAPP_PLUGIN, '0.1.0').ok).toBe(true);
    const old = { ...WHATSAPP_PLUGIN, compat: { minEya: '2.0.0' } };
    expect(compatibility(old, '0.1.0')).toMatchObject({ ok: false });
    expect(compatibility(old, '0.1.0').note).toMatch(/Needs Eya 2\.0\.0 or newer/);
    const capped = { ...WHATSAPP_PLUGIN, compat: { minEya: '0.1.0', maxEya: '0.5.0' } };
    expect(compatibility(capped, '0.9.0').note).toMatch(/up to 0\.5\.0/);
  });

  it('the Plugins page says plainly that no online catalogue is connected', () => {
    const w = world();
    const snap = w.manager.snapshot();
    expect(snap.catalogue.remote).toBe(false);
    expect(snap.catalogue.note).toMatch(/No online catalogue is connected/);
    expect(snap.catalogue.source).toBe('Built in to Eya');
  });
});

// ------------------------------------------------------------------------------------------------------------------ installing, connecting and granting are different things
describe('the plugin lifecycle', () => {
  it('on the first run a bundled plugin is there and switched on, with nothing granted when nothing was allowed before', () => {
    const w = world();
    const v = w.manager.list()[0];
    expect(v).toMatchObject({ id: 'whatsapp', installed: true, enabled: true, connection: 'not_connected', status: 'not_connected' });
    expect(v?.permissions.every((p) => !p.granted)).toBe(true);
    expect(JSON.parse(w.stateFiles.get('plugins.json') as string).plugins.whatsapp).toMatchObject({ enabled: true, granted: [] });
  });

  it('a person who had already allowed WhatsApp keeps what worked: its permissions carry over on the first run', () => {
    const w = world({ access: ON });
    const v = w.manager.list()[0];
    expect(v).toMatchObject({ status: 'ready', connection: 'connected' });
    expect(v?.permissions.filter((p) => p.granted).map((p) => p.id).sort()).toEqual(['chats.live', 'chats.read', 'files.find', 'files.send', 'messages.send']);
  });

  it('INSTALLING connects nothing and grants nothing', () => {
    const w = world({ catalog: catalogOf(NOTES, WHATSAPP_PLUGIN), extraTools: ['notes_read', 'notes_save'] });
    // (notes is not bundled)
    expect(w.manager.list().find((p) => p.id === 'notes')).toMatchObject({ installed: false, status: 'not_installed' });
    const r = w.manager.apply({ kind: 'install', id: 'notes' });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Nothing is connected or allowed yet/);
    const notes = r.snapshot.plugins.find((p) => p.id === 'notes');
    expect(notes?.installed).toBe(true);
    expect(notes?.permissions.some((p) => p.granted)).toBe(false);
    expect(notes?.status).toBe('missing_permission');
    expect(w.manager.apply({ kind: 'install', id: 'notes' })).toMatchObject({ ok: false });
  });

  it('connecting WhatsApp is the person\'s own switch in Communication Access — the same one, not a second authority', () => {
    const w = world();
    expect(w.policy.allowed(w.policy.apps().find((a) => a.id === 'whatsapp') as never)).toBe(false);
    const r = w.manager.apply({ kind: 'connect', id: 'whatsapp' });
    expect(r.ok).toBe(true);
    expect(w.policy.allowed(w.policy.apps().find((a) => a.id === 'whatsapp') as never)).toBe(true);
    expect(r.snapshot.plugins[0]?.connection).toBe('connected');
    // connected is not authorized: nothing was granted by connecting
    expect(r.snapshot.plugins[0]?.status).toBe('missing_permission');
  });

  it('connecting WhatsApp never quietly allows another chat app', () => {
    const w = world();
    w.manager.apply({ kind: 'connect', id: 'whatsapp' });
    const s = w.access.get();
    expect(s.enabled).toBe(true);
    expect(s.apps['whatsapp']).toBe(true);
    for (const other of ['telegram', 'instagram', 'messenger', 'discord', 'slack', 'teams', 'signal', 'skype']) {
      expect(w.policy.allowed(w.policy.apps().find((a) => a.id === other) as never), other).toBe(false);
    }
  });

  it('an app the person had already allowed stays allowed when WhatsApp is connected', () => {
    const w = world({ access: { enabled: false, apps: { telegram: true } } });
    w.manager.apply({ kind: 'connect', id: 'whatsapp' });
    expect(w.policy.allowed(w.policy.apps().find((a) => a.id === 'telegram') as never)).toBe(true);
    expect(w.policy.allowed(w.policy.apps().find((a) => a.id === 'instagram') as never)).toBe(false);
  });

  it('disconnecting turns only WhatsApp off', () => {
    const w = world({ access: ON });
    const r = w.manager.apply({ kind: 'disconnect', id: 'whatsapp' });
    expect(r.ok).toBe(true);
    expect(r.snapshot.plugins[0]?.connection).toBe('not_connected');
    expect(w.policy.allowed(w.policy.apps().find((a) => a.id === 'telegram') as never)).toBe(true);
    expect(w.manager.blockFor('find_chat')?.reason).toMatch(/not connected/);
  });

  it('a connection that could not be saved is said not to have happened', () => {
    const w = world();
    w.accessFiles.failWrites.on = true;
    const r = w.manager.apply({ kind: 'connect', id: 'whatsapp' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not connected/);
    expect(w.manager.list()[0]?.connection).toBe('not_connected');
  });

  it('permissions are granted and revoked one at a time; an unknown one is refused', () => {
    const w = world({ access: { enabled: true, apps: {} } });
    w.manager.apply({ kind: 'revoke', id: 'whatsapp', permission: 'messages.send' });
    expect(w.manager.apply({ kind: 'revoke', id: 'whatsapp', permission: 'messages.send' })).toMatchObject({ ok: false });
    expect(w.manager.list()[0]?.permissions.find((p) => p.id === 'messages.send')?.granted).toBe(false);
    expect(w.manager.apply({ kind: 'grant', id: 'whatsapp', permission: 'messages.send' }).ok).toBe(true);
    expect(w.manager.apply({ kind: 'grant', id: 'whatsapp', permission: 'messages.send' }).ok).toBe(false);
    expect(w.manager.apply({ kind: 'grant', id: 'whatsapp', permission: 'messages.read' })).toMatchObject({ ok: false });
    expect(w.manager.apply({ kind: 'grant', id: 'nothing', permission: 'x.y' })).toMatchObject({ ok: false, message: 'There is no such plugin.' });
  });

  it('enabling and disabling', () => {
    const w = world({ access: ON });
    expect(w.manager.apply({ kind: 'enable', id: 'whatsapp' })).toMatchObject({ ok: false });
    expect(w.manager.apply({ kind: 'disable', id: 'whatsapp' }).ok).toBe(true);
    expect(w.manager.list()[0]).toMatchObject({ enabled: false, status: 'disabled' });
    expect(w.manager.blockFor('find_chat')?.reason).toMatch(/switched off/);
    expect(w.manager.apply({ kind: 'enable', id: 'whatsapp' }).ok).toBe(true);
    expect(w.manager.blockFor('find_chat')).toBeNull();
  });

  it('uninstalling takes the permissions and the account link away, and the plugin is not put back by itself', () => {
    const w = world({ access: ON });
    const r = w.manager.apply({ kind: 'uninstall', id: 'whatsapp' });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/disconnected/);
    expect(r.snapshot.plugins[0]).toMatchObject({ installed: false, status: 'not_installed' });
    expect(w.policy.allowed(w.policy.apps().find((a) => a.id === 'whatsapp') as never)).toBe(false);
    expect(w.manager.blockFor('find_chat')?.reason).toMatch(/not installed/);
    // after a restart it is still gone
    const again = w.restart();
    expect(again.manager.list()[0]?.installed).toBe(false);
    // …until the person installs it again, with nothing granted
    const back = again.manager.apply({ kind: 'install', id: 'whatsapp' });
    expect(back.ok).toBe(true);
    expect(back.snapshot.plugins[0]?.permissions.some((p) => p.granted)).toBe(false);
  });

  it('what the person chose survives a restart', () => {
    const w = world({ access: ON });
    w.manager.apply({ kind: 'revoke', id: 'whatsapp', permission: 'files.send' });
    w.manager.apply({ kind: 'disable', id: 'whatsapp' });
    const again = w.restart();
    const v = again.manager.list()[0];
    expect(v?.enabled).toBe(false);
    expect(v?.permissions.find((p) => p.id === 'files.send')?.granted).toBe(false);
    expect(v?.permissions.find((p) => p.id === 'chats.read')?.granted).toBe(true);
  });

  it('a saved file that is damaged is the same as none, never a guess', () => {
    expect(parseState(null)).toMatchObject({ plugins: {} });
    expect(parseState({ plugins: { whatsapp: { installedVersion: 3, enabled: 'yes' } } })).toMatchObject({ plugins: {} });
    expect(parseState({ plugins: { whatsapp: { installedVersion: '1.0.0', enabled: true, granted: ['a.b', 7, 'a.b'] } } }).plugins['whatsapp']?.granted).toEqual(['a.b']);
    const w = world({ state: new Map([['plugins.json', '{ not json']]) });
    expect(w.manager.list()[0]?.installed).toBe(true); // bundled, as on a first run
  });

  it('updating: a newer version is taken, a permission it newly asks for is NOT given, one it dropped goes', () => {
    const v1: PluginManifest = { ...NOTES };
    const v2: PluginManifest = {
      ...NOTES,
      version: '1.1.0',
      permissions: [...NOTES.permissions, { id: 'notes.share', label: 'Share notes', description: 'Share.', risk: 'send' as const }].filter((p) => p.id !== 'notes.read'),
      // (the new version has a new action that needs the new permission, and no longer has the one that read)
      actions: [...NOTES.actions.filter((a) => a.id === 'save_note'), { id: 'share_note', label: 'Share a note', description: 'Share a note.', tools: ['notes_read'], gate: 'registry', permission: 'notes.share', verify: 'Reads it back.' }],
    };
    const w = world({ catalog: catalogOf(v1), extraTools: ['notes_read', 'notes_save'] });
    w.manager.apply({ kind: 'install', id: 'notes' });
    w.manager.apply({ kind: 'grant_all', id: 'notes' });
    const next = w.restart({ catalog: catalogOf(v2) });
    const before = next.manager.list()[0];
    expect(before).toMatchObject({ installedVersion: '1.0.0', version: '1.1.0', updateAvailable: true });
    const r = next.manager.apply({ kind: 'update', id: 'notes' });
    expect(r.ok).toBe(true);
    const after = r.snapshot.plugins[0];
    expect(after).toMatchObject({ installedVersion: '1.1.0', updateAvailable: false });
    expect(after?.permissions.find((p) => p.id === 'notes.write')?.granted).toBe(true);
    expect(after?.permissions.find((p) => p.id === 'notes.share')?.granted).toBe(false);
    expect(after?.permissions.some((p) => p.id === 'notes.read')).toBe(false);
    expect(next.manager.apply({ kind: 'update', id: 'notes' })).toMatchObject({ ok: false, message: expect.stringContaining('up to date') });
  });

  it('an update that does not work with this Eya is refused, and what is installed is left alone', () => {
    const v1 = NOTES;
    const v2: PluginManifest = { ...NOTES, version: '2.0.0', compat: { minEya: '9.0.0' } };
    const w = world({ catalog: catalogOf(v1), extraTools: ['notes_read', 'notes_save'] });
    w.manager.apply({ kind: 'install', id: 'notes' });
    const next = w.restart({ catalog: catalogOf(v2) });
    const r = next.manager.apply({ kind: 'update', id: 'notes' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Needs Eya 9\.0\.0/);
    expect(r.message).toMatch(/left as it is/);
    expect(r.snapshot.plugins[0]).toMatchObject({ installedVersion: '1.0.0', status: 'incompatible', compatible: false });
    expect(next.manager.blockFor('notes_read')?.reason).toMatch(/does not work with this version/);
    expect(next.manager.apply({ kind: 'enable', id: 'notes' }).ok).toBe(false);
  });

  it('a plugin that does not work with this Eya cannot be installed', () => {
    const w = world({ catalog: catalogOf({ ...NOTES, compat: { minEya: '9.0.0' } }), extraTools: ['notes_read', 'notes_save'] });
    const r = w.manager.apply({ kind: 'install', id: 'notes' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/cannot be installed/);
    expect(w.manager.list()[0]?.installed).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------------------ may this tool run?
describe('which tools may run', () => {
  it('a plugin that is not ready hides its tools from the AI and refuses them if they are called, saying what the person can do', async () => {
    const w = world(); // installed, not connected
    const offered = w.tools.toAISchema().map((t) => t.name);
    for (const owned of ['find_chat', 'find_chat_files', 'live_chat', 'learn_chat_names', 'share_file_to_chat', 'attach_file', 'verify_sent']) expect(offered, owned).not.toContain(owned);
    // (the general browser tools are not WhatsApp's: they stay)
    expect(offered).toContain('fill_on_page');
    expect(offered).toContain('click_on_page');
    const r = await w.tools.invoke('find_chat', {});
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('plugin not available');
    expect(r.data).toMatchObject({ pluginBlocked: true, plugin: 'whatsapp' });
    expect(r.error).toMatch(/not connected/);
    expect(r.error).toMatch(/Connect it on the Plugins page/);
    expect(r.error).toMatch(/do not try another way/);
    // (the person's own words carry no instruction to the AI)
    expect(String(r.data?.['forPerson'])).toMatch(/Connect it on the Plugins page\.$/);
    expect(String(r.data?.['forPerson'])).not.toMatch(/do not try/);
    expect(w.calls).toEqual([]); // the tool itself never ran
  });

  it('once the person has connected and granted, the tools are offered and run', async () => {
    const w = world();
    w.manager.apply({ kind: 'connect', id: 'whatsapp' });
    expect((await w.tools.invoke('find_chat', {})).error).toMatch(/has not been given the permission/);
    w.manager.apply({ kind: 'grant', id: 'whatsapp', permission: 'chats.read' });
    expect(w.tools.toAISchema().map((t) => t.name)).toContain('find_chat');
    expect((await w.tools.invoke('find_chat', {})).ok).toBe(true);
    // a permission not granted still holds back its own tools
    expect((await w.tools.invoke('share_file_to_chat', {})).error).toMatch(/Send files/);
    // (a tool whose permission is not granted is not offered either: the AI is never shown what it cannot use)
    expect(w.tools.toAISchema().map((t) => t.name)).not.toContain('share_file_to_chat');
    w.manager.apply({ kind: 'grant', id: 'whatsapp', permission: 'files.send' });
    expect(w.tools.toAISchema().map((t) => t.name)).toContain('share_file_to_chat');
  });

  it('every reason is its own sentence: not installed, off, not connected, no permission', () => {
    const w = world({ access: ON });
    expect(w.manager.blockFor('find_chat')).toBeNull();
    w.manager.apply({ kind: 'revoke', id: 'whatsapp', permission: 'chats.read' });
    expect(w.manager.blockFor('find_chat')?.reason).toMatch(/"Find chats and contacts"/);
    w.manager.apply({ kind: 'disconnect', id: 'whatsapp' });
    expect(w.manager.blockFor('find_chat')?.reason).toMatch(/not connected/);
    w.manager.apply({ kind: 'disable', id: 'whatsapp' });
    expect(w.manager.blockFor('find_chat')?.reason).toMatch(/switched off/);
    w.manager.apply({ kind: 'uninstall', id: 'whatsapp' });
    expect(w.manager.blockFor('find_chat')?.reason).toMatch(/not installed/);
  });

  it('a tool no plugin owns is never held back', async () => {
    const w = world({ extraTools: ['read_file'] });
    expect(w.manager.blockFor('read_file')).toBeNull();
    expect(w.tools.toAISchema().map((t) => t.name)).toContain('read_file');
    expect((await w.tools.invoke('read_file', {})).ok).toBe(true);
    expect((await w.tools.invoke('no_such_tool', {})).summary).toBe('unknown tool');
  });

  it('the AI is told in one line what it can and cannot use, and who can change that', () => {
    const off = world();
    expect(off.manager.summary()).toMatch(/WhatsApp is NOT usable: Installed, but not connected/);
    expect(off.manager.summary()).toMatch(/Only the person can change that, on the Plugins page/);
    const on = world({ access: ON });
    expect(on.manager.summary()).toMatch(/WhatsApp is ready \(it can: find a chat, remember chat names, find a file in the chats, live chat companion, send a text message, send a file, check a send\)/);
    on.manager.apply({ kind: 'revoke', id: 'whatsapp', permission: 'files.send' });
    expect(on.manager.summary()).not.toMatch(/send a file/);
    // what is not supported is never in that line
    expect(on.manager.summary()).not.toMatch(/find messages|save a file received/i);
  });

  it('two plugins are held to their own permissions, independently', async () => {
    const w = world({ access: ON, catalog: catalogOf(WHATSAPP_PLUGIN, NOTES), extraTools: ['notes_read', 'notes_save'] });
    w.manager.apply({ kind: 'install', id: 'notes' });
    w.manager.apply({ kind: 'grant', id: 'notes', permission: 'notes.read' });
    expect((await w.tools.invoke('notes_read', {})).ok).toBe(true);
    expect((await w.tools.invoke('notes_save', {})).error).toMatch(/Save notes/);
    expect((await w.tools.invoke('find_chat', {})).ok).toBe(true);
    // taking one away does not touch the other
    w.manager.apply({ kind: 'uninstall', id: 'notes' });
    expect((await w.tools.invoke('notes_read', {})).ok).toBe(false);
    expect((await w.tools.invoke('find_chat', {})).ok).toBe(true);
  });

  it('what went wrong in a plugin\'s tool is shown on its card, a success clears it, and a refusal or a question is not an error', async () => {
    const w = world({ access: ON });
    const fails = new ToolRegistry();
    fails.setGuard({ blocked: (n) => w.manager.blockFor(n), observe: (n, r) => w.manager.observe(n, r) });
    let mode: 'fail' | 'ask' | 'ok' = 'fail';
    fails.register({
      schema: { name: 'find_chat', description: 'x', args: {} },
      execute: async (): Promise<ToolResult> => (mode === 'fail' ? { ok: false, summary: 'could not look', error: 'secret detail' } : mode === 'ask' ? { ok: true, summary: '2 chats', data: { status: 'ambiguous' } } : { ok: true, summary: 'opened' }),
    });
    await fails.invoke('find_chat', {});
    expect(w.manager.list()[0]?.lastError).toBe('could not look');
    expect(JSON.stringify(w.manager.snapshot())).not.toContain('secret detail');
    mode = 'ok';
    await fails.invoke('find_chat', {});
    expect(w.manager.list()[0]?.lastError).toBeNull();
    // a refusal by the manager itself is not the plugin failing
    w.manager.apply({ kind: 'disconnect', id: 'whatsapp' });
    await fails.invoke('find_chat', {});
    expect(w.manager.list()[0]?.lastError).toBeNull();
  });

  it('the person is told when something changes', () => {
    const w = world();
    let n = 0;
    w.manager.onChange(() => (n += 1));
    w.manager.apply({ kind: 'connect', id: 'whatsapp' });
    w.manager.apply({ kind: 'grant', id: 'whatsapp', permission: 'chats.read' });
    w.manager.apply({ kind: 'grant', id: 'whatsapp', permission: 'chats.read' }); // refused: no change
    expect(n).toBe(2);
  });
});

// ------------------------------------------------------------------------------------------------------------------ a Send in a chat app
describe('a Send is held to the plugin\'s permission', () => {
  function chatWorld(granted: 'all' | 'none') {
    const w = world({ access: ON });
    if (granted === 'none') for (const p of ['chats.read', 'chats.live', 'files.find', 'messages.send', 'files.send']) w.manager.apply({ kind: 'revoke', id: 'whatsapp', permission: p });
    const app = new FakeChatApp();
    const session = new ChatSession();
    const policy = new CommunicationPolicy(() => ON);
    const tools = new ToolRegistry();
    for (const t of createChatTools({ service: app, policy, session, folders, files: new FakeDisk(), sleep: async () => undefined })) tools.register(t);
    for (const t of createBrowserTools(app, undefined, { chatGate: createChatSendGate(session, policy, w.manager) })) tools.register(t);
    tools.setGuard({ blocked: (n) => w.manager.blockFor(n), observe: (n, r) => w.manager.observe(n, r) });
    return { w, app, session, tools };
  }

  it('without "send text messages" a Send click is refused outright — and a yes does not change that', async () => {
    const r = chatWorld('none');
    r.app.open = r.app.rows[0] ?? null;
    r.app.draft = 'hello';
    const plain = await r.tools.invoke('click_on_page', { text: 'Send' });
    expect(plain.ok).toBe(false);
    expect(plain.summary).toBe('not allowed');
    expect(plain.data).toMatchObject({ status: 'plugin_blocked', pluginBlocked: true });
    expect(plain.error).toMatch(/"Send text messages"/);
    const yes = await r.tools.invoke('click_on_page', { text: 'Send', confirm: true });
    expect(yes.ok).toBe(false);
    expect(yes.summary).toBe('not allowed');
    expect(r.app.thread).toEqual([]);
  });

  it('pressing Enter in the message box to send is refused the same way', async () => {
    const r = chatWorld('none');
    r.app.open = r.app.rows[0] ?? null;
    const out = await r.tools.invoke('fill_on_page', { label: 'Type a message', value: 'hello', submit: true });
    expect(out.ok).toBe(false);
    expect(out.data).toMatchObject({ pluginBlocked: true });
    expect(r.app.draft).toBe(''); // nothing was even typed
  });

  it('a file waiting to go needs "send files", not the text permission', async () => {
    const r = chatWorld('all');
    r.w.manager.apply({ kind: 'revoke', id: 'whatsapp', permission: 'files.send' });
    r.app.open = r.app.rows[0] ?? null;
    r.session.attached('report.pdf', 'name_visible');
    r.session.authorize({ chat: r.app.rows[0]?.name ?? '', file: 'report.pdf' });
    const out = await r.tools.invoke('click_on_page', { text: 'Send', confirm: true });
    expect(out.summary).toBe('not allowed');
    expect(out.error).toMatch(/"Send files"/);
    expect(r.app.thread).toEqual([]);
  });

  it('with the permission, the ordinary rules apply as before (a yes is still asked for)', async () => {
    const r = chatWorld('all');
    r.app.open = r.app.rows[0] ?? null;
    r.app.draft = 'hello';
    const asked = await r.tools.invoke('click_on_page', { text: 'Send' });
    expect(asked.summary).toBe('needs confirmation');
    expect(asked.data?.['pluginBlocked']).toBeUndefined();
    expect(r.app.thread).toEqual([]);
  });

  it('a page that is not a chat app is not affected', async () => {
    const r = chatWorld('none');
    r.app.url = 'https://example.org/';
    r.app.open = null;
    const out = await r.tools.invoke('click_on_page', { text: 'Send' });
    expect(out.data?.['pluginBlocked']).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------------------------ the connector alone
describe('the WhatsApp connector', () => {
  it('reports each state in words, and an unknown app as an error rather than "connected"', () => {
    const files = memoryIo();
    const store = new CommunicationAccessStore('a.json', files.io);
    const policy = new CommunicationPolicy(() => store.get());
    const c: PluginConnector = whatsappConnector(policy, store);
    expect(c.status()).toMatchObject({ state: 'not_connected', detail: 'Chats are switched off in Eya.' });
    store.set({ enabled: true, apps: { whatsapp: false } });
    expect(c.status()).toMatchObject({ state: 'not_connected', detail: 'WhatsApp is switched off in Eya.' });
    store.set({ enabled: true, apps: {} });
    expect(c.status().state).toBe('connected');
    expect(c.status().detail).toMatch(/never sees your password/);
    const none = whatsappConnector(new CommunicationPolicy(() => store.get()), store);
    expect(none.status().state).toBe('connected');
  });
});
