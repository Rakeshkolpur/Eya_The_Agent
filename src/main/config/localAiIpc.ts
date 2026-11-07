import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import type { LocalAiStatus } from '@shared/localAi';
import { isModelName } from '@shared/localAi';
import type { AppSettingsStore } from '@main/settings/appSettings';
import type { OllamaAIProvider } from '@main/providers/ai/OllamaAIProvider';

/**
 * The local AI's page: whether Ollama is running and has the model (looked at fresh each time it is asked), and which model to use.
 * A model name is only passed on if it looks like one; the model itself is chosen from what Ollama has installed on the page.
 */
export function registerLocalAiIpc(provider: OllamaAIProvider, settings: AppSettingsStore, modelFromEnv: () => boolean): void {
  const status = async (): Promise<LocalAiStatus> => ({ ...(await provider.status()), modelFromEnv: modelFromEnv() });
  ipcMain.handle(IpcChannels.localAiGet, status);
  ipcMain.handle(IpcChannels.localAiSetModel, async (_evt, model: unknown): Promise<LocalAiStatus> => {
    if (isModelName(model)) {
      settings.update({ localModel: model });
      // A model the person is now using is loaded ahead of the first question (only while the local AI is the one being used).
      const first = settings.get().aiFirst;
      if (first === 'local' || first === 'local-only') void provider.warm();
    }
    return status();
  });
}
