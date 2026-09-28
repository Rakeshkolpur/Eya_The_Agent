import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import type { AudioRequest } from '@shared/ipcContract';
import type { AgentRequest, AgentResult, AgentUpdate, OrbState } from '@shared/types';
import { rootLogger } from '@main/logging/logger';

const log = rootLogger.child('ipc');

export interface RequestHandler {
  handle(req: AgentRequest, onUpdate: (u: AgentUpdate) => void): Promise<AgentResult>;
}

export interface AudioHandler {
  handleAudio(req: AudioRequest, onUpdate: (u: AgentUpdate) => void): Promise<AgentResult>;
}

export class IpcRouter {
  constructor(
    private readonly textHandler: RequestHandler,
    private readonly audioHandler: AudioHandler,
  ) {}

  register(getSender: () => WebContents | null): void {
    ipcMain.handle(IpcChannels.submitAgentRequest, async (_evt, req: AgentRequest) => {
      if (typeof req?.text !== 'string' || typeof req.requestId !== 'string') {
        throw new Error('Invalid agent request');
      }
      log.info('text request', { requestId: req.requestId, source: req.source });
      const result = await this.textHandler.handle(req, (update) => {
        getSender()?.send(IpcChannels.agentUpdate, update);
      });
      log.info('text done', { requestId: req.requestId, ok: result.ok });
      return result;
    });

    ipcMain.handle(IpcChannels.submitAudioRequest, async (_evt, req: AudioRequest) => {
      if (typeof req?.audioBase64 !== 'string' || typeof req.requestId !== 'string') {
        throw new Error('Invalid audio request');
      }
      log.info('audio request', {
        requestId: req.requestId,
        mimeType: req.mimeType,
        bytes: Math.round(req.audioBase64.length * 0.75),
      });
      const result = await this.audioHandler.handleAudio(req, (update) => {
        getSender()?.send(IpcChannels.agentUpdate, update);
      });
      log.info('audio done', { requestId: req.requestId, ok: result.ok });
      return result;
    });
  }

  sendOrbState(sender: WebContents, state: OrbState): void {
    sender.send(IpcChannels.setOrbState, state);
  }
}
