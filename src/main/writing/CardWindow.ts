import { BrowserWindow, screen } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import type { WritingState } from '@shared/ipcContract';
import { rootLogger } from '@main/logging/logger';
import { CARD_WIDTH, clampHeight, placeCard } from './cardPlacement';
import type { Box } from './cardPlacement';
import { CARD_HTML } from './cardHtml';

const log = rootLogger.child('writing');

/**
 * The small card that shows what Eya noticed. A separate little window that is shown WITHOUT taking the keyboard (so the user's typing
 * in Word never stops), stays above other windows, is left out of screen captures, and can only do what cardPreload.ts lets it. It shows
 * only while there is something to show; "Hide" puts it away until something new turns up.
 */
export class CardWindow {
  private win: BrowserWindow | null = null;
  private loaded = false;
  private height = 160;
  private last: WritingState | null = null;
  /** The findings the user hid the card for: it stays away until the set changes. */
  private hiddenFor = '';

  constructor(
    private readonly bubbleBounds: () => Box | null,
    private readonly preloadPath: string,
  ) {}

  private static signature(state: WritingState): string {
    return state.findings.map((f) => f.id).join(',');
  }

  update(state: WritingState): void {
    this.last = state;
    const sig = CardWindow.signature(state);
    if (state.findings.length === 0) {
      this.hiddenFor = '';
      this.win?.hide();
      return;
    }
    if (sig === this.hiddenFor) return; // the user hid the card for exactly these; something new brings it back
    this.hiddenFor = '';
    const win = this.ensure();
    this.send(win, state);
    this.place();
    if (!win.isVisible()) win.showInactive();
  }

  /** The page says it has loaded: give it what to show. */
  ready(): void {
    this.loaded = true;
    if (this.win !== null && this.last !== null) this.send(this.win, this.last);
  }

  hide(): void {
    if (this.last !== null) this.hiddenFor = CardWindow.signature(this.last);
    this.win?.hide();
  }

  resize(height: number): void {
    this.height = clampHeight(height);
    this.place();
  }

  private send(win: BrowserWindow, state: WritingState): void {
    if (this.loaded && !win.isDestroyed()) win.webContents.send(IpcChannels.writingCardState, state);
  }

  private place(): void {
    const win = this.win;
    if (win === null || win.isDestroyed()) return;
    const bubble = this.bubbleBounds();
    const near = bubble ?? { x: 0, y: 0, width: 1, height: 1 };
    const workArea = screen.getDisplayMatching(near).workArea;
    const box = placeCard(bubble, this.height, workArea);
    win.setBounds(box, false);
  }

  private ensure(): BrowserWindow {
    if (this.win !== null && !this.win.isDestroyed()) return this.win;
    this.loaded = false;
    const win = new BrowserWindow({
      width: CARD_WIDTH,
      height: this.height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      focusable: false, // clicking its buttons must not take the keyboard away from the document
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      title: 'Eya',
      webPreferences: { preload: this.preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setMenu(null);
    win.setContentProtection(true); // not part of any screen capture or screen share
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => {
      if (this.win === win) this.win = null;
    });
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(CARD_HTML)}`).catch((err: unknown) => log.warn('the card could not load', { err: String(err) }));
    this.win = win;
    return win;
  }

  dispose(): void {
    if (this.win !== null && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
