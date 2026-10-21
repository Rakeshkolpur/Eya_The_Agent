import type { MenuItemConstructorOptions } from 'electron';

/** What the tray and the bubble's right-click menu can do. (They are the user's own controls: no voice command or tool can reach them.) */
export interface MenuHost {
  chatsOn(): boolean;
  /** Turning Chats OFF is always one click; turning it ON is not offered here — it needs the explanation in Settings. */
  turnChatsOff(): void;
  /** Writing Watch: whether Eya is watching a document being written. It is the user's own switch, and always off at start-up. */
  writingWatchOn(): boolean;
  setWritingWatch(on: boolean): void;
  showBubble(): boolean;
  setShowBubble(on: boolean): void;
  /** Null when it cannot be offered (running from source). */
  startWithWindows(): boolean | null;
  setStartWithWindows(on: boolean): void;
  openApp(page?: string): void;
  askEya(): void;
  quit(): void;
}

/** One menu for the tray icon and the bubble, so they never disagree. */
export function buildMenuTemplate(host: MenuHost): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [
    { label: 'Open Eya', click: () => host.openApp() },
    { label: 'Ask Eya', click: () => host.askEya() },
    { type: 'separator' },
    host.chatsOn()
      ? { label: 'Chats: ON — turn off', click: () => host.turnChatsOff() }
      : { label: 'Chats: OFF — set up in Settings…', click: () => host.openApp('settings') },
    { label: 'Watch my writing (Word, Notepad)', type: 'checkbox', checked: host.writingWatchOn(), click: () => host.setWritingWatch(!host.writingWatchOn()) },
    { label: 'Show the floating bubble', type: 'checkbox', checked: host.showBubble(), click: () => host.setShowBubble(!host.showBubble()) },
  ];
  const login = host.startWithWindows();
  if (login !== null) items.push({ label: 'Start with Windows', type: 'checkbox', checked: login, click: () => host.setStartWithWindows(!login) });
  items.push({ type: 'separator' }, { label: 'Quit Eya', click: () => host.quit() });
  return items;
}
