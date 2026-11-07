import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import type { BrowserPanelAction, BrowserPanelResult, BrowserViewBounds } from '@shared/browserPanel';
import { createBrowserPanelController } from './browserPanelController';
import type { BrowserPanelWiring } from './browserPanelController';

export { addressFrom } from './browserPanelController';
export type { BrowserPanelWiring } from './browserPanelController';

/** A rectangle from the page, or null: anything else is ignored. */
export function boundsFrom(v: unknown): BrowserViewBounds | null {
  if (typeof v !== 'object' || v === null) return null;
  const b = v as Record<string, unknown>;
  const nums = [b['x'], b['y'], b['width'], b['height']];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const [x, y, width, height] = nums as [number, number, number, number];
  if (width < 1 || height < 1 || width > 10_000 || height > 10_000) return null;
  return { x, y, width, height };
}

/** Connects the Browser page to the browser: its state, where it is drawn, its controls. Returns what to call when Eya shuts down. */
export function registerBrowserPanelIpc(w: BrowserPanelWiring): { dispose: () => void } {
  const controller = createBrowserPanelController(w);
  ipcMain.handle(IpcChannels.browserPanelGet, () => controller.get());
  ipcMain.handle(IpcChannels.browserPanelAct, (_evt, action: unknown): Promise<BrowserPanelResult> | BrowserPanelResult => {
    if (typeof action !== 'object' || action === null || typeof (action as { type?: unknown }).type !== 'string') {
      return { ok: false, message: 'Not an action.', state: w.panel.get() };
    }
    return controller.act(action as BrowserPanelAction);
  });
  ipcMain.on(IpcChannels.browserView, (_evt, bounds: unknown) => controller.setView(boundsFrom(bounds)));
  return { dispose: controller.dispose };
}
