import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import type { MemoryService } from './MemoryService';
import { applyPanelAction, snapshotOf } from './panel';

/** The Memory panel's two requests: what is there, and a change. (The pushes — changed, suggestion — go out through MemoryService's notify.) */
export function registerMemoryIpc(getService: () => MemoryService | null): void {
  ipcMain.handle(IpcChannels.memoryGet, () => snapshotOf(getService()));
  ipcMain.handle(IpcChannels.memoryAct, (_evt, action: unknown) => applyPanelAction(getService(), action));
}
