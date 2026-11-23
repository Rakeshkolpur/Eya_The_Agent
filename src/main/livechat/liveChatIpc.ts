import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import { parseLiveChatRequest } from '@shared/liveChat';
import type { LiveChatResult, LiveChatView } from '@shared/liveChat';
import type { LiveChatController } from './LiveChatController';

export interface LiveChatIpcDeps {
  readonly controller: Pick<LiveChatController, 'view' | 'handle' | 'onChange'>;
  /** Tells the page the live chat changed (a message came, a draft is ready, it paused). */
  readonly notify: (view: LiveChatView) => void;
}

/**
 * The Live chat page's way in. Only Eya's own page can send these: no tool, voice command or web page is connected to approve or send a reply, to confirm a chat or
 * to switch automatic replies on. A request that is not exactly one of the known ones changes nothing.
 */
export function registerLiveChatIpc(deps: LiveChatIpcDeps): void {
  ipcMain.handle(IpcChannels.getLiveChat, () => deps.controller.view());
  ipcMain.handle(IpcChannels.liveChatAction, async (_evt, raw: unknown): Promise<LiveChatResult> => {
    const request = parseLiveChatRequest(raw);
    if (request === null) return { ok: false, message: 'That is not something the live chat can do.', view: deps.controller.view() };
    return deps.controller.handle(request);
  });
  deps.controller.onChange((view) => deps.notify(view));
}
