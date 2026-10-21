import { BrowserWindow, screen } from 'electron';
import type { NativeImage } from 'electron';
import { join } from 'node:path';
import { IpcChannels } from '@shared/ipcContract';
import type { WindowAnchor, WindowMode, WindowModeState } from '@shared/ipcContract';
import type { OrbState } from '@shared/types';
import type { AppSettingsStore, WindowStateStore } from '@main/settings/appSettings';
import { APP_URL } from './appProtocol';
import { rootLogger } from '@main/logging/logger';
import {
  anchorOf,
  appBounds,
  ASSISTANT_WINDOW,
  between,
  BUBBLE_WINDOW,
  bubbleWithin,
  clampRect,
  defaultBubble,
  dragged,
  expandedBounds,
  overlaps,
  snapToEdge,
} from './geometry';
import type { Point, Rect } from './geometry';

const log = rootLogger.child('orbwindow');

const SETTLE_MS = 160;
const SETTLE_STEP_MS = 16;

export interface OrbWindowDeps {
  readonly settings: AppSettingsStore;
  readonly state: WindowStateStore;
  /** Shown in the taskbar while the full app is open. */
  readonly icon?: NativeImage;
}

/**
 * Eya's one window, in three shapes (all the same page, so the microphone, wake word and live conversation never have to move):
 *
 *  - bubble: a small round window, always on top, that the user drags anywhere and that settles against the nearer side edge;
 *  - assistant: the quick panel, which grows out of the bubble — the bubble stays where it was and the panel opens away from the edge;
 *  - app: the full window, centred, an ordinary window in the taskbar. Closing it goes back to the bubble; it never quits Eya.
 */
export class OrbWindow {
  private win: BrowserWindow | null = null;
  private mode: WindowMode = 'bubble';
  /** Where the bubble rests (its own rectangle), whatever shape the window is in. */
  private bubble: Rect = { x: 0, y: 0, ...BUBBLE_WINDOW };
  private anchor: WindowAnchor = 'bottom-right';
  private quitting = false;
  private dragging: { readonly cursor: Point; readonly start: Rect; readonly timer: ReturnType<typeof setInterval> } | null = null;
  private settling: ReturnType<typeof setInterval> | null = null;
  private readonly modeListeners = new Set<(state: WindowModeState) => void>();

  constructor(private readonly deps: OrbWindowDeps) {}

  create(): BrowserWindow {
    if (this.win !== null && !this.win.isDestroyed()) return this.win;

    this.bubble = this.restoredBubble();
    const win = new BrowserWindow({
      ...this.bubble,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false, // dragged by Eya's own code, so a click and a drag can be told apart and the bubble can settle on an edge
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      ...(this.deps.icon !== undefined ? { icon: this.deps.icon } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Live listening and speech must start without a user click, and keep going while the bubble is hidden or the app minimised.
        autoplayPolicy: 'no-user-gesture-required',
        backgroundThrottling: false,
      },
    });

    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
    if (rendererUrl !== undefined) {
      void win.loadURL(rendererUrl);
    } else {
      // The built page, from the install folder at its own address (module workers will not start from a file:// page).
      void win.loadURL(APP_URL);
    }

    win.once('ready-to-show', () => {
      if (this.deps.settings.get().showBubble) win.showInactive();
      log.info('orb window ready', { bubble: this.bubble });
    });

    // The close button (or Alt+F4) on the app window puts Eya away as a bubble; only "Quit Eya" ends her.
    win.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      this.setMode('bubble');
    });
    win.on('closed', () => {
      this.win = null;
    });

    screen.on('display-metrics-changed', this.onDisplaysChanged);
    screen.on('display-removed', this.onDisplaysChanged);

    this.win = win;
    return win;
  }

  /** Where the floating bubble is on the screen (null when it is hidden), so that a note can appear beside it. */
  bubbleBounds(): Rect | null {
    return this.deps.settings.get().showBubble ? { ...this.bubble } : null;
  }

  // ----------------------------------------------------------------------------------------------- modes
  getModeState(): WindowModeState {
    return { mode: this.mode, anchor: this.anchor };
  }

  onModeChange(listener: (state: WindowModeState) => void): () => void {
    this.modeListeners.add(listener);
    return () => this.modeListeners.delete(listener);
  }

  /** Changes the window's shape. `page` says which screen of the full app to open on. */
  setMode(mode: WindowMode, page?: string): void {
    const win = this.live();
    if (win === null) return;
    this.cancelSettle();
    if (this.dragging !== null) this.endDrag();

    // Coming out of an expanded shape, the bubble is wherever the expanded window says it is.
    if (this.mode === 'assistant') this.bubble = bubbleWithin(win.getBounds(), this.anchor);

    switch (mode) {
      case 'bubble': {
        win.setBounds(this.bubble, false);
        win.setSkipTaskbar(true);
        win.setAlwaysOnTop(true, 'floating');
        if (this.deps.settings.get().showBubble) win.showInactive();
        else win.hide();
        break;
      }
      case 'assistant': {
        const area = this.workAreaOf(this.bubble);
        this.anchor = anchorOf(this.bubble, area);
        win.setBounds(expandedBounds(this.bubble, ASSISTANT_WINDOW, area, this.anchor), false);
        win.setSkipTaskbar(true);
        win.setAlwaysOnTop(true, 'floating');
        win.show();
        win.focus();
        break;
      }
      case 'app': {
        win.setBounds(appBounds(this.workAreaOf(this.mode === 'bubble' ? this.bubble : win.getBounds())), false);
        win.setSkipTaskbar(false);
        win.setAlwaysOnTop(false);
        win.show();
        win.focus();
        break;
      }
    }
    this.mode = mode;
    log.info('window mode', { mode, anchor: this.anchor, bounds: win.getBounds() });
    this.announce(page);
  }

  /** The shortcut: bubble ⇄ quick assistant; from the full app, back to the bubble. */
  toggleAssistant(): void {
    this.setMode(this.mode === 'bubble' ? 'assistant' : 'bubble');
  }

  /** Opens the full app, from anywhere (the tray, a second launch). */
  openApp(page?: string): void {
    this.setMode('app', page);
  }

  // ------------------------------------------------------------------------------------------- dragging
  /** The pointer went down on the bubble and started to move: follow the pointer until it is let go. */
  beginDrag(): void {
    const win = this.live();
    if (win === null || this.mode !== 'bubble' || this.dragging !== null) return;
    this.cancelSettle();
    const cursor = screen.getCursorScreenPoint();
    const start = win.getBounds();
    const timer = setInterval(() => {
      const w = this.live();
      if (w === null || this.dragging === null) return;
      w.setBounds(dragged(this.dragging.start, this.dragging.cursor, screen.getCursorScreenPoint()), false);
    }, SETTLE_STEP_MS);
    this.dragging = { cursor, start, timer };
    log.info('bubble drag started', { from: { x: start.x, y: start.y } });
  }

  /** Let go: settle against the nearer edge of the screen it was dropped on, and remember the place. */
  endDrag(): void {
    const win = this.live();
    const drag = this.dragging;
    this.dragging = null;
    if (drag !== null) clearInterval(drag.timer);
    if (win === null || drag === null) return;
    const here = win.getBounds();
    const target = snapToEdge(here, this.workAreaOf(here));
    this.settleTo(here, target);
  }

  private settleTo(from: Rect, to: Rect): void {
    const win = this.live();
    if (win === null) return;
    const started = Date.now();
    this.cancelSettle();
    this.settling = setInterval(() => {
      const w = this.live();
      if (w === null) return this.cancelSettle();
      const t = (Date.now() - started) / SETTLE_MS;
      w.setBounds(between(from, to, t), false);
      if (t >= 1) {
        this.cancelSettle();
        w.setBounds(to, false);
        this.rest(to);
      }
    }, SETTLE_STEP_MS);
  }

  private cancelSettle(): void {
    if (this.settling !== null) clearInterval(this.settling);
    this.settling = null;
  }

  private rest(at: Rect): void {
    this.bubble = { x: at.x, y: at.y, ...BUBBLE_WINDOW };
    this.deps.state.saveBubble(this.bubble);
    log.info('bubble settled', { at: { x: at.x, y: at.y } });
  }

  // --------------------------------------------------------------------------------------------- others
  setState(state: OrbState): void {
    const win = this.live();
    if (win === null) return;
    win.webContents.send(IpcChannels.setOrbState, state);
  }

  /** Applies the "show the bubble" choice right away when the window is in its bubble shape. */
  applySettings(): void {
    const win = this.live();
    if (win === null || this.mode !== 'bubble') return;
    if (this.deps.settings.get().showBubble) win.showInactive();
    else win.hide();
  }

  hide(): void {
    this.win?.hide();
  }

  /** A second launch of Eya (or anything that just wants her up): show the full app. */
  show(): void {
    this.openApp();
  }

  /** The app is really quitting: let the window close for good. */
  prepareToQuit(): void {
    this.quitting = true;
  }

  destroy(): void {
    screen.off('display-metrics-changed', this.onDisplaysChanged);
    screen.off('display-removed', this.onDisplaysChanged);
    this.cancelSettle();
    if (this.dragging !== null) clearInterval(this.dragging.timer);
    if (this.win !== null && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  // --------------------------------------------------------------------------------------------- helpers
  private live(): BrowserWindow | null {
    return this.win !== null && !this.win.isDestroyed() ? this.win : null;
  }

  private announce(page?: string): void {
    const win = this.live();
    const state: WindowModeState = { ...this.getModeState(), ...(page !== undefined ? { page } : {}) };
    win?.webContents.send(IpcChannels.windowMode, state);
    for (const l of this.modeListeners) l(state);
  }

  private workAreaOf(r: Rect): Rect {
    return screen.getDisplayMatching(r).workArea;
  }

  /** Where the bubble was left last time — or its first home, if that screen is gone. */
  private restoredBubble(): Rect {
    const saved: Point | null = this.deps.state.load();
    if (saved !== null) {
      const rect: Rect = { ...saved, ...BUBBLE_WINDOW };
      if (screen.getAllDisplays().some((d) => overlaps(rect, d.workArea))) return snapToEdge(rect, this.workAreaOf(rect));
    }
    return defaultBubble(screen.getPrimaryDisplay().workArea);
  }

  /** A screen was unplugged or its size changed: keep the bubble reachable. */
  private readonly onDisplaysChanged = (): void => {
    const win = this.live();
    if (win === null || this.dragging !== null) return;
    const onSomeScreen = screen.getAllDisplays().some((d) => overlaps(this.bubble, d.workArea));
    this.bubble = onSomeScreen ? snapToEdge(this.bubble, this.workAreaOf(this.bubble)) : defaultBubble(screen.getPrimaryDisplay().workArea);
    this.deps.state.saveBubble(this.bubble);
    if (this.mode === 'bubble') win.setBounds(this.bubble, false);
    else if (this.mode === 'assistant') this.setMode('assistant');
    else win.setBounds(clampRect(win.getBounds(), this.workAreaOf(win.getBounds())), false);
    log.info('screens changed; bubble kept on screen', { bubble: this.bubble });
  };
}
