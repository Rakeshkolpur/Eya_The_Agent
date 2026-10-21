import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ipcMain, net, safeStorage } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import { GeminiKeyService, GeminiKeyStore, checkGeminiKey } from './geminiKey';

/**
 * Wires the Gemini key to Windows and the disk: the key is encrypted by Windows for this user (safeStorage) into one file, checked with
 * Google before it is saved, and the page only ever asks for its status (where it came from, last four characters).
 */
export function createGeminiKeyService(filePath: string): GeminiKeyService {
  const store = new GeminiKeyStore(
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
  return new GeminiKeyService({
    store,
    env: process.env,
    // Electron's own fetch follows the system's proxy and certificates, as a browser would.
    check: (key) => checkGeminiKey(key, (url, init) => net.fetch(url as string, init as RequestInit)),
  });
}

export function registerGeminiKeyIpc(service: GeminiKeyService): void {
  ipcMain.handle(IpcChannels.geminiKeyGet, () => service.status());
  ipcMain.handle(IpcChannels.geminiKeySet, (_evt, key: unknown) => service.set(key));
  ipcMain.handle(IpcChannels.geminiKeyClear, () => service.clear());
}
