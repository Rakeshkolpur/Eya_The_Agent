import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import { parsePluginChange } from '@shared/plugins';
import type { PluginChangeResult, PluginsSnapshot } from '@shared/plugins';
import type { PluginManager } from './PluginManager';

export interface PluginsIpcDeps {
  readonly manager: PluginManager;
  /** Tells the page the plugins changed (so it stays right even when something else changed them, like Communication Access). */
  readonly notify: (snapshot: PluginsSnapshot) => void;
}

/**
 * The Plugins page's way in. Only Eya's own page can send these — no tool, voice command or web page is connected to them — and a choice that is not exactly
 * one of the known ones changes nothing.
 */
export function registerPluginsIpc(deps: PluginsIpcDeps): void {
  ipcMain.handle(IpcChannels.getPlugins, () => deps.manager.snapshot());
  ipcMain.handle(IpcChannels.changePlugin, (_evt, request: unknown): PluginChangeResult => {
    const change = parsePluginChange(request);
    if (change === null) return { ok: false, message: 'That is not something Eya can do.', snapshot: deps.manager.snapshot() };
    return deps.manager.apply(change);
  });
  deps.manager.onChange(() => deps.notify(deps.manager.snapshot()));
}
