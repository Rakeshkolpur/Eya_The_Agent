import { contextBridge, ipcRenderer } from 'electron';

/**
 * The suggestion card's bridge: the few things the small card window may do. It can be told what to show, and it can say "I am ready",
 * "fix this", "ignore this", "this tall" and "hide me" — nothing else, and it has no way to read anything from the rest of Eya.
 *
 * It imports NOTHING but electron, and spells its five channel names out. That is deliberate: when two preload scripts share code the
 * bundler moves the shared part into a separate file, and a sandboxed preload cannot load a separate file — which silently broke the main
 * window's own preload (and with it the whole app) the first time this was run. tests/writingPreload.test.ts keeps both true.
 */
const CHANNELS = {
  state: 'eya:writing:card:state',
  ready: 'eya:writing:card:ready',
  act: 'eya:writing:card:act',
  size: 'eya:writing:card:size',
  hide: 'eya:writing:card:hide',
} as const;

contextBridge.exposeInMainWorld('eyaCard', {
  onState: (cb: (state: unknown) => void): void => {
    ipcRenderer.on(CHANNELS.state, (_e: Electron.IpcRendererEvent, state: unknown) => cb(state));
  },
  ready: (): void => ipcRenderer.send(CHANNELS.ready),
  act: (id: string, action: 'fix' | 'ignore'): void => ipcRenderer.send(CHANNELS.act, { id, action }),
  size: (height: number): void => ipcRenderer.send(CHANNELS.size, height),
  hide: (): void => ipcRenderer.send(CHANNELS.hide),
});
