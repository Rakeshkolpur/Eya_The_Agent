import React, { useMemo, useState } from 'react';
import type { PluginActionView, PluginChange, PluginStatus, PluginView } from '../../shared/plugins';
import type { EyaControl } from '../control';
import { Icon } from '../ui/icons';
import { Toggle } from '../ui/widgets';

/** The word and the look for each way a plugin can stand. Installed, connected and allowed are three different things, and the page keeps them apart. */
const STATUS_WORD: Readonly<Record<PluginStatus, string>> = {
  ready: 'Ready',
  not_installed: 'Not installed',
  disabled: 'Switched off',
  not_connected: 'Not connected',
  missing_permission: 'Nothing allowed yet',
  incompatible: 'Needs an update',
  error: 'Problem',
};

const RISK_WORD = { read: 'Looks only', write: 'Saves things', send: 'Sends things', destructive: 'Can delete' } as const;

function ActionRow({ a }: { a: PluginActionView }): React.ReactElement {
  return (
    <li className={`plugin-action ${a.supported ? '' : 'unsupported'}`}>
      <div className="plugin-action-head">
        <span className="plugin-action-name">{a.label}</span>
        {a.consequential && a.supported && <span className="plugin-tag send">Changes something outside Eya</span>}
        {!a.supported && <span className="plugin-tag off">Not supported yet</span>}
      </div>
      <div className="plugin-action-desc">{a.description}</div>
      {a.supported ? (
        <div className="plugin-action-verify">
          <strong>How it is checked:</strong> {a.verify}
        </div>
      ) : (
        <div className="plugin-action-verify">{a.unsupportedReason}</div>
      )}
    </li>
  );
}

function PluginCard({ p, change, busy }: { p: PluginView; change: (c: PluginChange) => void; busy: boolean }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const grantedCount = p.permissions.filter((x) => x.granted).length;
  return (
    <section className={`card plugin-card status-${p.status}`} aria-label={`${p.name} plugin`}>
      <div className="plugin-head">
        <span className="plugin-logo" aria-hidden="true">
          <Icon name="plug" size={20} />
        </span>
        <div className="plugin-title">
          <h2>{p.name}</h2>
          <div className="plugin-sub">
            Version {p.installedVersion ?? p.version} · {p.author} · {p.origin}
          </div>
        </div>
        <span className={`plugin-status ${p.status}`} role="status">
          {STATUS_WORD[p.status]}
        </span>
      </div>
      <p className="plugin-desc">{p.description}</p>

      <ol className="plugin-steps" aria-label="Steps">
        <li className={p.installed ? 'done' : 'todo'}>
          <span className="plugin-step-name">1 · Installed</span>
          <span className="plugin-step-text">{p.installed ? 'On this PC.' : 'Not on this PC yet. Installing connects nothing and allows nothing.'}</span>
          <span className="plugin-step-act">
            {p.installed ? (
              <button type="button" className="btn" disabled={busy} onClick={() => change({ kind: 'uninstall', id: p.id })}>
                Uninstall
              </button>
            ) : (
              <button type="button" className="btn primary" disabled={busy || !p.compatible} onClick={() => change({ kind: 'install', id: p.id })}>
                Install
              </button>
            )}
          </span>
        </li>
        {p.installed && (
          <>
            <li className={p.enabled ? 'done' : 'todo'}>
              <span className="plugin-step-name">2 · Switched on</span>
              <span className="plugin-step-text">{p.enabled ? 'Eya may use it when she is allowed to.' : 'Switched off: Eya cannot use it.'}</span>
              <span className="plugin-step-act">
                <Toggle on={p.enabled} label={`Switch ${p.name} on`} disabled={busy || !p.compatible} onChange={(on) => change({ kind: on ? 'enable' : 'disable', id: p.id })} />
              </span>
            </li>
            <li className={p.connection === 'connected' ? 'done' : 'todo'}>
              <span className="plugin-step-name">3 · Connected</span>
              <span className="plugin-step-text">{p.connectionDetail}</span>
              <span className="plugin-step-act">
                {p.connection === 'connected' ? (
                  <button type="button" className="btn" disabled={busy} onClick={() => change({ kind: 'disconnect', id: p.id })}>
                    Disconnect
                  </button>
                ) : (
                  <button type="button" className="btn primary" disabled={busy || !p.compatible} onClick={() => change({ kind: 'connect', id: p.id })}>
                    Connect
                  </button>
                )}
              </span>
            </li>
            <li className={grantedCount > 0 ? 'done' : 'todo'}>
              <span className="plugin-step-name">4 · Allowed</span>
              <span className="plugin-step-text">
                {grantedCount === 0 ? 'Nothing is allowed yet. Choose what Eya may do below.' : `${grantedCount} of ${p.permissions.length} permissions allowed.`}
              </span>
              <span className="plugin-step-act">
                {grantedCount < p.permissions.length && (
                  <button type="button" className="btn" disabled={busy} onClick={() => change({ kind: 'grant_all', id: p.id })}>
                    Allow all
                  </button>
                )}
              </span>
            </li>
          </>
        )}
      </ol>

      {p.installed && (
        <ul className="plugin-perms" aria-label="Permissions">
          {p.permissions.map((perm) => (
            <li key={perm.id} className="plugin-perm">
              <div className="plugin-perm-text">
                <span className="plugin-perm-name">{perm.label}</span>
                <span className={`plugin-tag ${perm.risk}`}>{RISK_WORD[perm.risk]}</span>
                <div className="plugin-perm-desc">{perm.description}</div>
              </div>
              <Toggle on={perm.granted} label={`Allow: ${perm.label}`} disabled={busy} onChange={(on) => change({ kind: on ? 'grant' : 'revoke', id: p.id, permission: perm.id })} />
            </li>
          ))}
        </ul>
      )}

      {p.status !== 'ready' && <div className="plugin-note">{p.statusText}</div>}
      {p.lastError !== null && <div className="plugin-error">Last problem: {p.lastError}</div>}
      {p.updateAvailable && (
        <div className="plugin-update">
          Version {p.version} is available.{' '}
          <button type="button" className="btn" disabled={busy} onClick={() => change({ kind: 'update', id: p.id })}>
            Update
          </button>
        </div>
      )}
      {!p.compatible && <div className="plugin-error">{p.compatibilityNote}</div>}

      <button type="button" className="link plugin-more" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide what it can do' : 'What can it do?'}
      </button>
      {open && (
        <ul className="plugin-actions" aria-label="Actions">
          {p.actions.map((a) => (
            <ActionRow key={a.id} a={a} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Plugins: the things Eya can work in. Each one is installed, switched on, connected to the person's own account, and then allowed one permission at a time —
 * four separate steps, each the person's own. The list says where it comes from: there is no online catalogue here, only what ships with Eya.
 */
export function PluginsPage({ c }: { c: EyaControl }): React.ReactElement {
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const plugins = c.plugins?.plugins ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === '' ? plugins : plugins.filter((p) => `${p.name} ${p.description} ${p.actions.map((a) => a.label).join(' ')}`.toLowerCase().includes(q));
  }, [plugins, query]);

  const change = (next: PluginChange): void => {
    setBusy(true);
    void c
      .changePlugin(next)
      .then((r) => setMessage({ ok: r.ok, text: r.message }))
      .catch(() => setMessage({ ok: false, text: 'That did not work.' }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="plugins-page">
      <div className="plugins-intro">
        <h1>Plugins</h1>
        <p>
          A plugin lets Eya work in one service for you. It does nothing until you have installed it, connected your own account and allowed what you want. You can take any step back
          at any time.
        </p>
        <div className="plugins-source" role="note">
          {c.plugins === null ? 'Loading…' : `${c.plugins.catalogue.source}: ${c.plugins.catalogue.note}`}
        </div>
        <input className="ask-input plugins-search" type="search" aria-label="Search plugins" placeholder="Search plugins" value={query} onChange={(e) => setQuery(e.target.value)} />
        {message !== null && (
          <div className={`plugins-message ${message.ok ? 'ok' : 'bad'}`} role="status">
            {message.text}
          </div>
        )}
      </div>
      {c.plugins !== null && shown.length === 0 && <div className="empty">{plugins.length === 0 ? 'No plugins are available.' : 'No plugin matches that search.'}</div>}
      <div className="plugins-list">
        {shown.map((p) => (
          <PluginCard key={p.id} p={p} change={change} busy={busy} />
        ))}
      </div>
    </div>
  );
}
