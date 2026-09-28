import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { ORB_WINDOW } from '@shared/constants';
import { IpcChannels } from '@shared/ipcContract';
import type { OrbState } from '@shared/types';
import { rootLogger } from '@main/logging/logger';

const log = rootLogger.child('orbwindow');

export class OrbWindow {
  private win: BrowserWindow | null = null;
  private expanded = false;

  create(): BrowserWindow {
    if (this.win !== null && !this.win.isDestroyed()) return this.win;

    const primary = screen.getPrimaryDisplay();
    const { workArea } = primary;
    const width = ORB_WINDOW.width;
    const height = ORB_WINDOW.height;
    const x = Math.round(workArea.x + (workArea.width - width) / 2);
    const y = Math.round(workArea.y + workArea.height - height - ORB_WINDOW.bottomMargin);

    const win = new BrowserWindow({
      width,
      height,
      x,
      y,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Live listening and speech must start without a user click.
        autoplayPolicy: 'no-user-gesture-required',
      },
    });

    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
    if (rendererUrl !== undefined) {
      void win.loadURL(rendererUrl);
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'));
    }

    win.once('ready-to-show', () => {
      win.show();
      log.info('orb window ready');
    });

    win.on('closed', () => {
      this.win = null;
    });

    this.win = win;
    return win;
  }

  /**
   * Asks the page to open or close its panel. The page owns that state and
   * reports it back through setExpanded(); keeping one owner is what stops the
   * window size and the panel from disagreeing.
   */
  toggleInput(): void {
    const win = this.win;
    if (win === null || win.isDestroyed()) return;
    win.webContents.send(IpcChannels.toggleInput);
  }

  /** Grow the window to fit the open panel, or shrink it back to just the orb. */
  setExpanded(expanded: boolean): void {
    const win = this.win;
    if (win === null || win.isDestroyed()) return;
    this.expanded = expanded;
    if (expanded) {
      win.setSize(ORB_WINDOW.panelExpandedWidth, ORB_WINDOW.panelExpandedHeight, false);
      this.recenterAtBottom();
      win.focus();
    } else {
      win.setSize(ORB_WINDOW.width, ORB_WINDOW.height, false);
      this.recenterAtBottom();
    }
  }

  setState(state: OrbState): void {
    const win = this.win;
    if (win === null || win.isDestroyed()) return;
    win.webContents.send(IpcChannels.setOrbState, state);
  }

  hide(): void {
    this.win?.hide();
  }

  show(): void {
    this.win?.show();
  }

  destroy(): void {
    if (this.win !== null && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  private recenterAtBottom(): void {
    const win = this.win;
    if (win === null || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
    const { workArea } = display;
    const x = Math.round(workArea.x + (workArea.width - bounds.width) / 2);
    const y = Math.round(workArea.y + workArea.height - bounds.height - ORB_WINDOW.bottomMargin);
    win.setPosition(x, y, false);
  }
}
