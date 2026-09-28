import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import { IpcChannels } from '@shared/ipcContract';
import type { TTSStreamRequest, TTSStreamStartResult } from '@shared/ipcContract';
import { rootLogger } from '@main/logging/logger';
import type { GeminiTTS } from './GeminiTTS';

const log = rootLogger.child('tts.stream');

/**
 * Bridges the renderer to cloud speech: the renderer asks for a phrase, audio
 * chunks are pushed back as they are generated, and either side can cancel.
 * The API key never leaves the main process.
 */
export class TtsStreamService {
  private readonly active = new Map<string, AbortController>();
  private counter = 0;

  constructor(
    private readonly tts: GeminiTTS,
    private readonly getSender: () => WebContents | null,
  ) {}

  register(): void {
    ipcMain.handle(IpcChannels.ttsStream, (_evt, req: TTSStreamRequest) => this.start(req));
    ipcMain.on(IpcChannels.ttsStreamCancel, (_evt, streamId: unknown) => {
      if (typeof streamId === 'string') this.cancel(streamId);
    });
  }

  private start(req: TTSStreamRequest): TTSStreamStartResult {
    if (typeof req?.text !== 'string' || typeof req.voice !== 'string' || req.text.trim().length === 0) {
      return { ok: false, error: 'invalid request' };
    }
    if (!/^[A-Za-z]{2,24}$/.test(req.voice)) return { ok: false, error: 'invalid voice' };
    if (!this.tts.hasKey()) return { ok: false, error: 'no Gemini key' };

    this.counter += 1;
    const streamId = `s_${Date.now()}_${this.counter}`;
    const controller = new AbortController();
    this.active.set(streamId, controller);

    const send = (channel: string, payload: unknown): void => {
      const sender = this.getSender();
      if (sender !== null && !sender.isDestroyed()) sender.send(channel, payload);
    };

    void this.tts
      .stream(
        req.text,
        req.voice,
        // Copy into a fresh buffer: Node's pooled Buffers share memory, and
        // structured clone would ship the whole pool to the renderer.
        (pcm) => send(IpcChannels.ttsChunk, { streamId, pcm: new Uint8Array(pcm) }),
        controller.signal,
      )
      .then((result) => {
        log.info('speech streamed', { model: result.model, ms: result.ms, bytes: result.bytes });
        send(IpcChannels.ttsStreamEnd, { streamId, ok: true, model: result.model });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!controller.signal.aborted) log.warn('speech stream failed', { err: message.slice(0, 160) });
        send(IpcChannels.ttsStreamEnd, { streamId, ok: false, error: message });
      })
      .finally(() => this.active.delete(streamId));

    return { ok: true, streamId };
  }

  cancel(streamId: string): void {
    this.active.get(streamId)?.abort();
  }

  cancelAll(): void {
    for (const controller of this.active.values()) controller.abort();
  }
}
