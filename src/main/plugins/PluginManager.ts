import { rootLogger } from '@main/logging/logger';
import type { ConnectionState, PluginActionView, PluginChange, PluginChangeResult, PluginPermissionView, PluginsSnapshot, PluginStatus, PluginView } from '@shared/plugins';
import { compareVersions, compatibility, soundEntries, supportedPermissions } from './manifest';
import { EMPTY_STATE } from './PluginStateStore';
import type { CatalogEntry, CatalogSource, PluginConnector, PluginManifest, PluginRecord, PluginState, ToolBlock } from './types';

const log = rootLogger.child('plugins');

export interface PluginManagerDeps {
  readonly catalog: CatalogSource;
  readonly store: { load(): PluginState | null; save(state: PluginState): void };
  /** Eya's own code for each plugin's account, by plugin id. A plugin with none is treated as having nothing to connect. */
  readonly connectors: Readonly<Record<string, PluginConnector>>;
  /** This version of Eya, to check that a plugin works with it. */
  readonly eyaVersion: string;
  /** The tools that are registered, so a manifest cannot name one that is not. */
  readonly knownTools: () => ReadonlySet<string>;
  readonly now?: () => number;
}

interface Owner {
  readonly plugin: string;
  readonly action: string;
}

/** What went wrong lately in a plugin's own tools (said on its card; kept in memory only). */
interface RecentError {
  readonly message: string;
  readonly at: number;
}

/**
 * The lifecycle of plugins: discover (the catalogue), install, switch on, connect the account, grant permissions — each a separate step the person takes —
 * and the one question every tool call asks: may this tool run right now? Installing never connects anything or grants anything, and connecting and granting
 * can only come from the person's own click on the Plugins page.
 */
export class PluginManager {
  private state: PluginState;
  private readonly entries = new Map<string, CatalogEntry>();
  private readonly refused: ReadonlyArray<{ readonly id: string; readonly problems: readonly string[] }>;
  private readonly owners = new Map<string, Owner>();
  private readonly errors = new Map<string, RecentError>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly deps: PluginManagerDeps) {
    this.now = deps.now ?? Date.now;
    const { good, refused } = soundEntries(deps.catalog.entries(), { knownTools: deps.knownTools() });
    this.refused = refused;
    for (const entry of good) this.entries.set(entry.manifest.id, entry);
    for (const r of refused) log.warn('a plugin in the catalogue was left out', { id: r.id, problems: r.problems });
    this.buildOwners();
    const saved = deps.store.load();
    this.state = saved ?? EMPTY_STATE;
    this.installBundled(saved === null);
  }

  // ----------------------------------------------------------------------------------------------------------------------- first run
  /**
   * A plugin that ships with Eya and that the person has not removed is there from the start, switched on, with NOTHING granted — except what they had already
   * allowed through the switch the plugin stands for (WhatsApp in Communication Access): that carries over, so what worked before still works.
   */
  private installBundled(firstRun: boolean): void {
    let changed = firstRun;
    const plugins: Record<string, PluginRecord> = { ...this.state.plugins };
    for (const entry of this.entries.values()) {
      const m = entry.manifest;
      if (m.bundled !== true || plugins[m.id] !== undefined || this.state.removed.includes(m.id)) continue;
      const connected = this.connectorStatus(m.id).state === 'connected';
      plugins[m.id] = { installedVersion: m.version, enabled: true, granted: connected ? supportedPermissions(m) : [] };
      changed = true;
    }
    if (!changed) return;
    this.state = { ...this.state, plugins };
    this.deps.store.save(this.state);
  }

  private buildOwners(): void {
    for (const entry of this.entries.values()) {
      for (const action of entry.manifest.actions) {
        if (action.unsupported !== undefined || action.gate !== 'registry') continue;
        for (const tool of action.tools) if (!this.owners.has(tool)) this.owners.set(tool, { plugin: entry.manifest.id, action: action.id });
      }
    }
  }

  // ------------------------------------------------------------------------------------------------------------------------ reading
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  /** Something the plugins depend on changed outside them (the Communication Access switch): the page is told so it shows the new state. */
  refresh(): void {
    this.changed();
  }

  private connectorStatus(id: string): { readonly state: ConnectionState; readonly detail: string } {
    const connector = this.deps.connectors[id];
    if (connector === undefined) return { state: 'connected', detail: 'Nothing to connect.' };
    try {
      return connector.status();
    } catch (err) {
      return { state: 'error', detail: `Could not check the connection: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private record(id: string): PluginRecord | undefined {
    return this.state.plugins[id];
  }

  private manifest(id: string): PluginManifest | undefined {
    return this.entries.get(id)?.manifest;
  }

  /** The status of a plugin and what is wrong, in the order the person has to fix it. */
  private statusOf(m: PluginManifest): { readonly status: PluginStatus; readonly text: string } {
    const rec = this.record(m.id);
    if (rec === undefined) return { status: 'not_installed', text: 'Not installed.' };
    if (!compatibility(m, this.deps.eyaVersion).ok) return { status: 'incompatible', text: compatibility(m, this.deps.eyaVersion).note };
    if (!rec.enabled) return { status: 'disabled', text: 'Installed, but switched off.' };
    const conn = this.connectorStatus(m.id);
    if (conn.state === 'error') return { status: 'error', text: conn.detail };
    if (conn.state !== 'connected') return { status: 'not_connected', text: `Installed, but not connected. ${conn.detail}` };
    if (rec.granted.length === 0) return { status: 'missing_permission', text: 'Connected, but no permission is granted yet: grant the ones you want Eya to use.' };
    return { status: 'ready', text: 'Ready.' };
  }

  list(): PluginView[] {
    return [...this.entries.values()].map((e) => this.view(e.manifest));
  }

  private view(m: PluginManifest): PluginView {
    const rec = this.record(m.id);
    const conn = this.connectorStatus(m.id);
    const status = this.statusOf(m);
    const compat = compatibility(m, this.deps.eyaVersion);
    const granted = new Set(rec?.granted ?? []);
    const permissions: PluginPermissionView[] = m.permissions.map((p) => ({ id: p.id, label: p.label, description: p.description, risk: p.risk, granted: granted.has(p.id) }));
    const actions: PluginActionView[] = m.actions.map((a) => ({
      id: a.id,
      label: a.label,
      description: a.description,
      permission: a.unsupported === undefined ? (a.permission ?? null) : null,
      consequential: a.consequential === true,
      verify: a.verify,
      supported: a.unsupported === undefined,
      unsupportedReason: a.unsupported ?? null,
    }));
    const error = this.errors.get(m.id);
    return {
      id: m.id,
      name: m.name,
      description: m.description,
      version: m.version,
      installedVersion: rec?.installedVersion ?? null,
      updateAvailable: rec !== undefined && compareVersions(m.version, rec.installedVersion) > 0,
      installed: rec !== undefined,
      enabled: rec?.enabled === true,
      connection: conn.state,
      connectionDetail: conn.detail,
      authDescription: m.auth.describe,
      status: status.status,
      statusText: status.text,
      compatible: compat.ok,
      compatibilityNote: compat.note,
      origin: this.deps.catalog.name,
      author: m.author,
      permissions,
      actions,
      lastError: error?.message ?? null,
    };
  }

  snapshot(): PluginsSnapshot {
    const remote = this.deps.catalog.remote;
    return {
      plugins: this.list(),
      catalogue: {
        source: this.deps.catalog.name,
        remote,
        note: remote ? 'Plugins offered by a remote catalogue.' : 'These plugins ship with Eya. No online catalogue is connected, so there is nothing to download.',
      },
    };
  }

  /** Catalogue entries that were left out because they were not sound (for a test and for the log). */
  leftOut(): ReadonlyArray<{ readonly id: string; readonly problems: readonly string[] }> {
    return this.refused;
  }

  // ----------------------------------------------------------------------------------------------------------------------- the question
  /**
   * May this tool run now? Null when it may, or when no plugin owns it (every other tool is unaffected). Otherwise why not, in words the person can act on.
   * This is the one place the answer is worked out; the registry asks it before a tool is offered to the AI and before it is run.
   */
  blockFor(tool: string): ToolBlock | null {
    const owner = this.owners.get(tool);
    if (owner === undefined) return null;
    const m = this.manifest(owner.plugin);
    if (m === undefined) return null;
    const action = m.actions.find((a) => a.id === owner.action);
    const why = this.whyNot(m, action?.permission);
    return why === null ? null : { plugin: m.id, reason: why };
  }

  /**
   * May the plugin that stands for this app (its Communication Access id) do something needing this permission? Null when it may or when no plugin stands for the
   * app. Used at the page gate that guards every Send in a chat app, which cannot ask by tool name because the tools there are general browser tools.
   */
  permitsApp(app: string, permission: string): string | null {
    for (const entry of this.entries.values()) {
      const m = entry.manifest;
      if (m.auth.kind !== 'app_switch' || m.auth.app !== app) continue;
      return this.whyNot(m, permission);
    }
    return null;
  }

  private whyNot(m: PluginManifest, permission: string | undefined): string | null {
    const rec = this.record(m.id);
    if (rec === undefined) return `The ${m.name} plugin is not installed. Install it on the Plugins page.`;
    const compat = compatibility(m, this.deps.eyaVersion);
    if (!compat.ok) return `The ${m.name} plugin does not work with this version of Eya. ${compat.note}`;
    if (!rec.enabled) return `The ${m.name} plugin is switched off. Switch it on on the Plugins page.`;
    const conn = this.connectorStatus(m.id);
    if (conn.state !== 'connected') return `The ${m.name} plugin is not connected. ${conn.detail} Connect it on the Plugins page.`;
    if (permission !== undefined && !rec.granted.includes(permission)) {
      const label = m.permissions.find((p) => p.id === permission)?.label ?? permission;
      return `The ${m.name} plugin has not been given the permission "${label}". Allow it on the Plugins page.`;
    }
    return null;
  }

  /** A tool of a plugin finished: what went wrong is shown on the plugin's card, and a success clears it. Never what was in the chat. */
  observe(tool: string, result: { readonly ok: boolean; readonly summary: string; readonly error?: string; readonly data?: Readonly<Record<string, unknown>> }): void {
    const owner = this.owners.get(tool);
    if (owner === undefined) return;
    const data = result.data ?? {};
    // (a refusal by this very manager, or a question the person has to answer, is not the plugin failing)
    if (data['pluginBlocked'] === true) return;
    const hadError = this.errors.has(owner.plugin);
    if (result.ok) {
      if (hadError) {
        this.errors.delete(owner.plugin);
        this.changed();
      }
      return;
    }
    const status = typeof data['status'] === 'string' ? data['status'] : '';
    if (['ambiguous', 'none', 'ready_to_send', 'needs_confirmation'].includes(status) || result.summary === 'needs confirmation') return;
    const message = result.summary.slice(0, 120);
    if (this.errors.get(owner.plugin)?.message === message) return;
    this.errors.set(owner.plugin, { message, at: this.now() });
    this.changed();
  }

  /** One line for the AI's context: which plugins it can use now, and which it cannot and why — so it never promises what is not there. */
  summary(): string {
    const parts: string[] = [];
    for (const entry of this.entries.values()) {
      const m = entry.manifest;
      const status = this.statusOf(m);
      if (status.status === 'ready') {
        const granted = new Set(this.record(m.id)?.granted ?? []);
        const can = m.actions.filter((a) => a.unsupported === undefined && a.permission !== undefined && granted.has(a.permission)).map((a) => a.label.toLowerCase());
        parts.push(`${m.name} is ready (it can: ${can.join(', ')})`);
      } else {
        parts.push(`${m.name} is NOT usable: ${status.text.replace(/\.$/, '')}. Only the person can change that, on the Plugins page`);
      }
    }
    return parts.length === 0 ? '' : `Plugins: ${parts.join('; ')}.`;
  }

  // ---------------------------------------------------------------------------------------------------------------------- the person's choices
  /** Applies one choice the person made on the Plugins page. */
  apply(change: PluginChange): PluginChangeResult {
    const outcome = this.perform(change);
    if (outcome.ok) {
      log.info('plugin choice', { kind: change.kind, plugin: change.id });
      this.changed();
    }
    return { ...outcome, snapshot: this.snapshot() };
  }

  private perform(change: PluginChange): { readonly ok: boolean; readonly message: string } {
    const m = this.manifest(change.id);
    if (m === undefined) return { ok: false, message: 'There is no such plugin.' };
    const rec = this.record(m.id);
    const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });
    switch (change.kind) {
      case 'install': {
        if (rec !== undefined) return fail(`${m.name} is already installed.`);
        const compat = compatibility(m, this.deps.eyaVersion);
        if (!compat.ok) return fail(`${m.name} cannot be installed: ${compat.note}`);
        this.save({ ...this.state, plugins: { ...this.state.plugins, [m.id]: { installedVersion: m.version, enabled: true, granted: [] } }, removed: this.state.removed.filter((x) => x !== m.id) });
        return { ok: true, message: `${m.name} is installed. Nothing is connected or allowed yet: connect your account and grant what you want next.` };
      }
      case 'uninstall': {
        if (rec === undefined) return fail(`${m.name} is not installed.`);
        // Taking a plugin off takes its access away too: its permissions go with it, and so does the link to the account.
        const connector = this.deps.connectors[m.id];
        let note = '';
        if (connector !== undefined && this.connectorStatus(m.id).state === 'connected') {
          const r = connector.disconnect();
          note = r.ok ? ' Its account was disconnected.' : ` (Could not disconnect its account: ${r.message})`;
        }
        const { [m.id]: _gone, ...rest } = this.state.plugins;
        this.errors.delete(m.id);
        this.save({ ...this.state, plugins: rest, removed: m.bundled === true ? [...new Set([...this.state.removed, m.id])] : this.state.removed });
        return { ok: true, message: `${m.name} is uninstalled and its permissions are gone.${note}` };
      }
      case 'enable':
      case 'disable': {
        if (rec === undefined) return fail(`${m.name} is not installed.`);
        const on = change.kind === 'enable';
        if (on && !compatibility(m, this.deps.eyaVersion).ok) return fail(`${m.name} cannot be switched on: ${compatibility(m, this.deps.eyaVersion).note}`);
        if (rec.enabled === on) return fail(`${m.name} is already ${on ? 'on' : 'off'}.`);
        this.patch(m.id, { enabled: on });
        return { ok: true, message: `${m.name} is switched ${on ? 'on' : 'off'}.` };
      }
      case 'connect':
      case 'disconnect': {
        if (rec === undefined) return fail(`${m.name} is not installed, so there is nothing to connect.`);
        const connector = this.deps.connectors[m.id];
        if (connector === undefined) return fail(`${m.name} has nothing to connect.`);
        if (change.kind === 'connect' && !compatibility(m, this.deps.eyaVersion).ok) return fail(`${m.name} cannot be connected: ${compatibility(m, this.deps.eyaVersion).note}`);
        const r = change.kind === 'connect' ? connector.connect() : connector.disconnect();
        if (r.ok) this.errors.delete(m.id);
        return r;
      }
      case 'grant':
      case 'revoke': {
        if (rec === undefined) return fail(`${m.name} is not installed.`);
        const permission = m.permissions.find((p) => p.id === change.permission);
        if (permission === undefined) return fail(`${m.name} has no permission called "${change.permission}".`);
        const has = rec.granted.includes(permission.id);
        if (change.kind === 'grant') {
          if (has) return fail(`"${permission.label}" is already allowed.`);
          this.patch(m.id, { granted: [...rec.granted, permission.id] });
          return { ok: true, message: `${m.name} may now: ${permission.label.toLowerCase()}.` };
        }
        if (!has) return fail(`"${permission.label}" was not allowed.`);
        this.patch(m.id, { granted: rec.granted.filter((g) => g !== permission.id) });
        return { ok: true, message: `${m.name} may no longer: ${permission.label.toLowerCase()}.` };
      }
      case 'grant_all': {
        if (rec === undefined) return fail(`${m.name} is not installed.`);
        const all = supportedPermissions(m);
        this.patch(m.id, { granted: [...new Set([...rec.granted, ...all])] });
        return { ok: true, message: `${m.name} may now use everything it supports.` };
      }
      case 'update': {
        if (rec === undefined) return fail(`${m.name} is not installed.`);
        if (compareVersions(m.version, rec.installedVersion) <= 0) return fail(`${m.name} is up to date (${rec.installedVersion}).`);
        const compat = compatibility(m, this.deps.eyaVersion);
        if (!compat.ok) return fail(`${m.name} ${m.version} cannot be installed here: ${compat.note} The version you have (${rec.installedVersion}) was left as it is.`);
        // An update never gives itself more: a permission that is new is not granted, and one that is gone is dropped.
        const known = new Set(m.permissions.map((p) => p.id));
        this.patch(m.id, { installedVersion: m.version, granted: rec.granted.filter((g) => known.has(g)) });
        return { ok: true, message: `${m.name} is updated to ${m.version}. Any new permission still has to be granted by you.` };
      }
    }
  }

  private patch(id: string, change: Partial<PluginRecord>): void {
    const rec = this.state.plugins[id];
    if (rec === undefined) return;
    this.save({ ...this.state, plugins: { ...this.state.plugins, [id]: { ...rec, ...change } } });
  }

  private save(next: PluginState): void {
    this.state = next;
    this.deps.store.save(next);
  }
}
