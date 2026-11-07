import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import type { AudioRequest } from '@shared/ipcContract';
import type { AgentRequest, AgentResult, AgentUpdate, OrbState } from '@shared/types';
import { rootLogger } from '@main/logging/logger';
import { traceFileFromEnv, traceRequest } from '@main/agent/trace';
import { cleanAttachments } from '@shared/attachments';

const log = rootLogger.child('ipc');

export interface RequestHandler {
  handle(req: AgentRequest, onUpdate: (u: AgentUpdate) => void): Promise<AgentResult>;
  /** Ends every request being worked on, on the spot. Returns how many there were. */
  stopAll?(): number;
}

export interface AudioHandler {
  handleAudio(req: AudioRequest, onUpdate: (u: AgentUpdate) => void): Promise<AgentResult>;
}

export class IpcRouter {
  constructor(
    private readonly textHandler: RequestHandler,
    private readonly audioHandler: AudioHandler,
    /** Told of every update of a request, and when it ends (so the PC is kept awake exactly while she works). Optional. */
    private readonly onUpdate?: (update: AgentUpdate) => void,
  ) {}

  register(getSender: () => WebContents | null): void {
    ipcMain.handle(IpcChannels.submitAgentRequest, async (_evt, req: AgentRequest) => {
      if (typeof req?.text !== 'string' || typeof req.requestId !== 'string') {
        throw new Error('Invalid agent request');
      }
      // What the window sent as attached files is cleaned here: a plain list of known kinds, nothing else gets through.
      const { mode: _mode, ...rest } = req;
      const mode = req.mode === 'chat' || req.mode === 'agent' ? req.mode : undefined;
      const clean: AgentRequest = { ...rest, ...(mode !== undefined ? { mode } : {}), ...(req.attachments === undefined ? {} : { attachments: cleanAttachments(req.attachments) }) };
      const traceFile = traceFileFromEnv();
      if (traceFile !== null) traceRequest(traceFile, req.text, mode);
      log.info('text request', { requestId: req.requestId, source: req.source, ...(clean.attachments !== undefined && clean.attachments.length > 0 ? { attachments: clean.attachments.length } : {}) });
      let result: AgentResult;
      try {
        result = await this.textHandler.handle(clean, (update) => {
          this.onUpdate?.(update);
          getSender()?.send(IpcChannels.agentUpdate, update);
        });
      } finally {
        this.onUpdate?.({ requestId: req.requestId, state: 'idle' }); // (however it ended: the work is over)
      }
      log.info('text done', { requestId: req.requestId, ok: result.ok });
      return result;
    });

    // Stop (the chat box, the Browser page, the panel): every request being worked on ends in this moment, whatever it was in the middle of.
    ipcMain.handle(IpcChannels.stopRequests, (): number => {
      const stopped = this.textHandler.stopAll?.() ?? 0;
      log.info('stop pressed', { requests: stopped });
      return stopped;
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
      let result: AgentResult;
      try {
        result = await this.audioHandler.handleAudio(req, (update) => {
          this.onUpdate?.(update);
          getSender()?.send(IpcChannels.agentUpdate, update);
        });
      } finally {
        this.onUpdate?.({ requestId: req.requestId, state: 'idle' });
      }
      log.info('audio done', { requestId: req.requestId, ok: result.ok });
      return result;
    });
  }

  sendOrbState(sender: WebContents, state: OrbState): void {
    sender.send(IpcChannels.setOrbState, state);
  }
}
