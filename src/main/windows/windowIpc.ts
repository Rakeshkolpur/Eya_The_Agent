import { app, ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import type { ActivityAction, ActivitySnapshot, SettingsPatch, SettingsSnapshot, WindowMode } from '@shared/ipcContract';
import type { ActivityStore } from '@main/memory/ActivityStore';
import { activitySnapshot, cleanSettingsPatch } from './snapshots';
import type { AppSettingsStore } from '@main/settings/appSettings';
import type { PerformanceInfo } from '@shared/performance';
import type { OrbWindow } from './OrbWindow';

const MODES: readonly WindowMode[] = ['bubble', 'assistant', 'app'];

export interface WindowIpcDeps {
  readonly orb: OrbWindow;
  readonly settings: AppSettingsStore;
  /** Null when the memory database could not be opened: the history is then simply empty. */
  readonly activity: () => ActivityStore | null;
  readonly memoryPath: string;
  readonly startWithWindows: { get(): boolean | null; set(on: boolean): void };
  /** The performance level running and the one the saved setting asks for. */
  readonly performance: () => PerformanceInfo;
  readonly onQuit: () => void;
  /** Start Eya again; only offered for the installed app. */
  readonly onRelaunch: () => void;
  readonly showBubbleMenu: () => void;
  /** Pushes to the page. */
  readonly send: (channel: string, payload: unknown) => void;
}

export function settingsSnapshot(deps: Pick<WindowIpcDeps, 'settings' | 'memoryPath' | 'startWithWindows' | 'performance'>): SettingsSnapshot {
  return {
    settings: deps.settings.get(),
    info: { version: app.getVersion(), packaged: app.isPackaged, memoryPath: deps.memoryPath, startWithWindows: deps.startWithWindows.get(), performance: deps.performance() },
  };
}

export function registerWindowIpc(deps: WindowIpcDeps): void {
  const { orb, settings } = deps;
  ipcMain.on(IpcChannels.windowSetMode, (_evt, mode: unknown) => {
    if (typeof mode === 'string' && (MODES as readonly string[]).includes(mode)) orb.setMode(mode as WindowMode);
  });
  ipcMain.handle(IpcChannels.windowGetMode, () => orb.getModeState());
  ipcMain.on(IpcChannels.windowDrag, (_evt, phase: unknown) => {
    if (phase === 'start') orb.beginDrag();
    else if (phase === 'end') orb.endDrag();
  });
  ipcMain.on(IpcChannels.windowMenu, () => deps.showBubbleMenu());
  ipcMain.on(IpcChannels.appQuit, () => deps.onQuit());
  ipcMain.on(IpcChannels.appRelaunch, () => {
    if (app.isPackaged) deps.onRelaunch();
  });

  const snapshot = (): SettingsSnapshot => settingsSnapshot(deps);
  ipcMain.handle(IpcChannels.settingsGet, snapshot);
  ipcMain.handle(IpcChannels.settingsSet, (_evt, raw: unknown) => {
    const { patch, startWithWindows } = cleanSettingsPatch(raw as SettingsPatch);
    if (Object.keys(patch).length > 0) settings.update(patch);
    if (startWithWindows !== undefined && deps.startWithWindows.get() !== null) deps.startWithWindows.set(startWithWindows);
    return snapshot();
  });
  settings.onChange(() => {
    orb.applySettings();
    deps.send(IpcChannels.settingsChanged, snapshot());
    deps.send(IpcChannels.activityChanged, activitySnapshot(deps.activity(), settings.get().keepHistory));
  });

  const history = (): ActivitySnapshot => activitySnapshot(deps.activity(), settings.get().keepHistory);
  ipcMain.handle(IpcChannels.activityGet, history);
  ipcMain.handle(IpcChannels.activityAct, (_evt, raw: unknown) => {
    const action = raw as Partial<ActivityAction> | null;
    const store = deps.activity();
    if (store !== null && action !== null && typeof action === 'object') {
      if (action.kind === 'clear') store.clear();
      else if (action.kind === 'delete' && typeof (action as { id?: unknown }).id === 'number') store.delete((action as { id: number }).id);
    }
    return history();
  });
}
