import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import type { CommunicationAccessChange, CommunicationAccessState } from '@shared/ipcContract';
import { parseSettings } from './communicationAccess';
import type { CommunicationPolicy, CommunicationSettings } from './communicationAccess';
import type { CommunicationAccessStore } from './communicationAccessStore';

/** What the panel shows: the master switch, and for each chat app whether Eya may use it. */
export function stateOf(policy: CommunicationPolicy): CommunicationAccessState {
  const s = policy.settings();
  return {
    enabled: s.enabled,
    apps: policy
      .apps()
      .filter((a) => a.hosts.length > 0 || a.processes.length > 0)
      .map((a) => ({ id: a.id, name: a.name, allowed: s.apps[a.id] !== false })),
  };
}

/**
 * Turns a request from the panel into the new settings. Only booleans and known app ids are accepted; anything else
 * changes nothing. (Only Eya's own panel can send this — no tool, voice command or web page can.)
 */
export function applyChange(current: CommunicationSettings, request: unknown, knownIds: readonly string[]): CommunicationSettings {
  if (typeof request !== 'object' || request === null) return current;
  const r = request as Partial<CommunicationAccessChange>;
  let next = current;
  if (typeof r.enabled === 'boolean') next = { ...next, enabled: r.enabled };
  if (typeof r.app === 'object' && r.app !== null && typeof r.app.id === 'string' && typeof r.app.allowed === 'boolean' && knownIds.includes(r.app.id)) {
    next = { ...next, apps: { ...next.apps, [r.app.id]: r.app.allowed } };
  }
  return parseSettings(next, knownIds);
}

export interface CommunicationIpcDeps {
  readonly store: CommunicationAccessStore;
  readonly policy: CommunicationPolicy;
  /** Tells the panel the choice changed (so it stays right even if something else changed it). */
  readonly notify: (state: CommunicationAccessState) => void;
}

export function registerCommunicationAccessIpc(deps: CommunicationIpcDeps): void {
  const knownIds = deps.policy.apps().map((a) => a.id);
  ipcMain.handle(IpcChannels.getCommunicationAccess, () => stateOf(deps.policy));
  ipcMain.handle(IpcChannels.setCommunicationAccess, (_evt, request: unknown) => {
    deps.store.set(applyChange(deps.store.get(), request, knownIds));
    return stateOf(deps.policy);
  });
  deps.store.onChange(() => deps.notify(stateOf(deps.policy)));
}
