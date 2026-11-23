import { Menu, Tray, nativeImage } from 'electron';
import type { BrowserWindow, NativeImage } from 'electron';
import { iconBitmap } from './iconBitmap';
import { buildMenuTemplate } from './trayMenu';
import type { MenuHost } from './trayMenu';

/** Eya's icon, for the tray and the taskbar (drawn in code; see iconBitmap). Drawn at twice the size so it stays sharp on a high-DPI screen. */
export function appIcon(): NativeImage {
  return nativeImage.createFromBitmap(iconBitmap(32), { width: 32, height: 32, scaleFactor: 2 });
}

export interface EyaTray {
  /** Rebuilds the menu (after Chats or a setting changed). */
  refresh(): void;
  /** Shows the same menu at the pointer, for a right-click on the bubble. */
  popupFor(window: BrowserWindow): void;
  destroy(): void;
}

/**
 * The tray icon: always there, even with the bubble hidden, so Eya can always be opened — and closed. A click opens the app; the
 * menu has Chats, the bubble, starting with Windows, and Quit.
 */
export function createTray(host: MenuHost, icon: NativeImage): EyaTray {
  const tray = new Tray(icon);
  tray.setToolTip('Eya');
  const menu = (): Menu => Menu.buildFromTemplate(buildMenuTemplate(host));
  const refresh = (): void => tray.setContextMenu(menu());
  tray.on('click', () => host.openApp());
  refresh();
  return {
    refresh,
    popupFor: (window) => menu().popup({ window }),
    destroy: () => tray.destroy(),
  };
}
