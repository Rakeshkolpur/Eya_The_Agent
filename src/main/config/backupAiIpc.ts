import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ipcMain, net, safeStorage } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import { rootLogger } from '@main/logging/logger';
import type { AiUsageStatus } from '@shared/ipcContract';
import type { AiRouteStatus } from '@shared/aiRoute';
import { OpenAICompatibleProvider, checkBackupKey, probeBackupModel } from '@main/providers/ai/OpenAICompatibleProvider';
import type { SwitchableAIProvider } from '@main/providers/ai/SwitchableAIProvider';
import type { ChainState, ChainStore } from '@main/providers/ai/ChainedAIProvider';
import { BackupAiService, BackupAiStore, configId } from './backupAi';

/** Electron's own fetch follows the system's proxy and certificates, as a browser would. */
const netFetch = ((url: unknown, init?: unknown) => net.fetch(url as string, init as RequestInit)) as typeof fetch;

/**
 * Wires the backup AIs to Windows and the disk: the keys are encrypted by Windows for this user (safeStorage), each checked with its
 * service before it is saved, and put to work in `slots` (one slot per backup, in the order they are asked) straight away, so no
 * restart is needed.
 */
export function createBackupAiService(
  filePath: string,
  slots: readonly SwitchableAIProvider[],
  clearRests?: (id?: string) => void,
  noteFailure?: (id: string, kind: 'credit' | 'auth') => void,
): BackupAiService {
  const store = new BackupAiStore(
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
  // What each slot holds now, so a change to one backup does not replace (and make forget its rests) the others.
  const held: string[] = slots.map(() => '');
  return new BackupAiService({
    store,
    env: process.env,
    check: (baseUrl, apiKey) => checkBackupKey(baseUrl, apiKey, netFetch),
    probe: (baseUrl, apiKey, model) => probeBackupModel(baseUrl, apiKey, model, netFetch),
    ...(clearRests !== undefined ? { clearRests } : {}),
    ...(noteFailure !== undefined ? { noteFailure } : {}),
    // EYA_OPENAI_BASE_URL: for a proxy, or a test server on this PC (loopback http or any https address).
    baseUrlFor: (provider) => (provider === 'openai' ? process.env['EYA_OPENAI_BASE_URL']?.trim() || undefined : undefined),
    apply: (configs) => {
      slots.forEach((slot, i) => {
        const config = configs[i];
        const signature = config === undefined ? '' : JSON.stringify(config);
        if (signature === held[i]) return;
        held[i] = signature;
        slot.set(
          config === undefined
            ? null
            : new OpenAICompatibleProvider({
                label: configId(config),
                baseUrl: config.baseUrl,
                apiKey: config.apiKey,
                model: config.model,
                ...(config.fallbackModels !== undefined ? { fallbackModels: config.fallbackModels } : {}),
                fetchFn: netFetch,
              }),
        );
      });
    },
  });
}

/** What the chain keeps between runs (which AI is resting, how many requests each answered today): a small plain file, no secrets. */
export function createChainStore(filePath: string): ChainStore {
  return {
    load: (): ChainState | null => {
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<ChainState>;
        if (typeof raw.day !== 'string' || typeof raw.rests !== 'object' || raw.rests === null || typeof raw.usage !== 'object' || raw.usage === null) return null;
        return { day: raw.day, rests: raw.rests, usage: raw.usage };
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

export function registerBackupAiIpc(service: BackupAiService, usage: () => AiUsageStatus, route: () => AiRouteStatus): void {
  ipcMain.handle(IpcChannels.backupAiSetModel, (_evt, model: unknown, id: unknown) => {
    rootLogger.child('ai.backup').info('model chosen in the interface', { model: typeof model === 'string' ? model : null, backup: typeof id === 'string' ? id : null });
    return service.use(model, typeof id === 'string' ? id : undefined);
  });
  ipcMain.handle(IpcChannels.aiRouteGet, () => route());
  ipcMain.handle(IpcChannels.backupAiGet, () => service.status());
  ipcMain.handle(IpcChannels.backupAiSet, (_evt, input: unknown) => service.set(input));
  ipcMain.handle(IpcChannels.backupAiTest, (_evt, id: unknown) => service.test(typeof id === 'string' && id !== '' ? id : undefined));
  ipcMain.handle(IpcChannels.backupAiClear, (_evt, id: unknown) => service.clear(typeof id === 'string' && id !== '' ? id : undefined));
  ipcMain.handle(IpcChannels.aiUsageGet, () => usage());
}
