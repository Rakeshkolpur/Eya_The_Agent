import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ipcMain, net, safeStorage } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import { checkGeminiKey } from './geminiKey';
import { FamilyKeyStore, GeminiKeysService } from './geminiKeys';
import type { GeminiKeyPool, PoolState, PoolStateStore } from './geminiKeyPool';

/** What the pool keeps between runs (which key is resting, how many requests each answered today): a small plain file with no keys in it. */
export function createPoolStateStore(filePath: string): PoolStateStore {
  return {
    load: (): PoolState | null => {
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PoolState>;
        if (typeof raw.day !== 'string' || typeof raw.rests !== 'object' || raw.rests === null || typeof raw.requests !== 'object' || raw.requests === null) return null;
        return { day: raw.day, rests: raw.rests, requests: raw.requests };
      } catch {
        return null;
      }
    },
    save: (state) => {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(state));
    },
  };
}

/**
 * Wires the extra Gemini keys to Windows and the disk: encrypted by Windows for this user (safeStorage) into one file, each checked with
 * Google before it is saved, put to work in `pool` straight away, and the page only ever asks for how each stands (never a key).
 */
export function createGeminiKeysService(filePath: string, pool: GeminiKeyPool, mainKey: () => string | null, revive?: () => void): GeminiKeysService {
  const store = new FamilyKeyStore(
    filePath,
    {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (data) => safeStorage.decryptString(data),
    },
    {
      read: (path) => {
        try {
          return readFileSync(path);
        } catch {
          return null;
        }
      },
      write: (path, data) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, data);
      },
      remove: (path) => unlinkSync(path),
    },
  );
  return new GeminiKeysService({
    store,
    pool,
    mainKey,
    ...(revive !== undefined ? { revive } : {}),
    // Electron's own fetch follows the system's proxy and certificates, as a browser would.
    check: (key) => checkGeminiKey(key, (url, init) => net.fetch(url as string, init as RequestInit)),
  });
}

export function registerGeminiKeysIpc(service: GeminiKeysService, pool: GeminiKeyPool): void {
  ipcMain.handle(IpcChannels.geminiKeysGet, () => service.status());
  ipcMain.handle(IpcChannels.geminiKeysAdd, (_evt, input: unknown) => service.add(input));
  ipcMain.handle(IpcChannels.geminiKeysRemove, (_evt, id: unknown) => service.remove(id));
  ipcMain.handle(IpcChannels.geminiKeysTest, (_evt, id: unknown) => service.test(id));
  ipcMain.handle(IpcChannels.liveTrouble, () => pool.liveTrouble());
}
