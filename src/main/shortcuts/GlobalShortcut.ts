import { globalShortcut } from 'electron';
import { GLOBAL_SHORTCUT_TOGGLE } from '@shared/constants';
import { rootLogger } from '@main/logging/logger';

const log = rootLogger.child('shortcuts');

export class GlobalShortcutManager {
  register(onToggle: () => void): boolean {
    if (globalShortcut.isRegistered(GLOBAL_SHORTCUT_TOGGLE)) {
      globalShortcut.unregister(GLOBAL_SHORTCUT_TOGGLE);
    }
    const ok = globalShortcut.register(GLOBAL_SHORTCUT_TOGGLE, () => {
      log.debug('global shortcut fired', { shortcut: GLOBAL_SHORTCUT_TOGGLE });
      onToggle();
    });
    if (!ok) log.error('failed to register shortcut', { shortcut: GLOBAL_SHORTCUT_TOGGLE });
    return ok;
  }

  unregisterAll(): void {
    globalShortcut.unregisterAll();
  }
}
