import { rootLogger } from '@main/logging/logger';
import { IpcChannels } from '@shared/ipcContract';
import type { WebContents } from 'electron';
import type { TTSProvider } from './TTSProvider';
import { ipcMain } from 'electron';

const log = rootLogger.child('tts.bridge');

interface QueueItem {
  readonly text: string;
  readonly resolve: () => void;
}

interface InFlight {
  readonly utteranceId: string;
  readonly resolve: () => void;
  readonly timer: NodeJS.Timeout;
  settled: boolean;
}

/**
 * TTS that runs in the renderer (Kokoro via kokoro-js, with SpeechSynthesis
 * fallback). Main dispatches text over IPC and awaits a "done" ack.
 *
 * Utterances are serialized through an internal queue: only one is ever in
 * flight to the renderer at a time. Without this, two AgentEngine requests
 * finishing close together (e.g. a typed command while a mic recording is
 * still transcribing) can fire overlapping speechSynthesis.speak() calls,
 * which jams Chromium's speech queue so neither utterance's "done" event
 * ever fires — every such utterance then hangs for the full timeout.
 */
export class RendererTTSBridge implements TTSProvider {
  readonly name = 'renderer-tts';
  private getSender: () => WebContents | null;
  private ready = false;
  private queue: QueueItem[] = [];
  private inFlight: InFlight | null = null;
  private counter = 0;
  private readonly timeoutMs: number;

  constructor(getSender: () => WebContents | null, timeoutMs = 15_000) {
    this.getSender = getSender;
    this.timeoutMs = timeoutMs;
  }

  async init(): Promise<void> {
    ipcMain.on(IpcChannels.ttsReady, () => {
      log.info('renderer tts ready');
      this.ready = true;
    });
    ipcMain.on(IpcChannels.ttsDone, (_e, utteranceId: string) => {
      this.settle(utteranceId);
    });
  }

  async speak(text: string): Promise<void> {
    const line = text.replace(/[\r\n]+/g, ' ').trim();
    if (line.length === 0) return;
    return new Promise<void>((resolve) => {
      this.queue.push({ text: line, resolve });
      this.pump();
    });
  }

  prefetch(text: string, priority: 'high' | 'low' = 'high'): void {
    const line = text.replace(/[\r\n]+/g, ' ').trim();
    if (line.length === 0) return;
    this.getSender()?.send(IpcChannels.ttsPrefetch, { text: line, priority });
  }

  private pump(): void {
    if (this.inFlight !== null) return;
    const next = this.queue.shift();
    if (next === undefined) return;

    const sender = this.getSender();
    if (sender === null) {
      log.warn('speak skipped: no renderer');
      next.resolve();
      this.pump();
      return;
    }

    this.counter += 1;
    const utteranceId = `u_${Date.now()}_${this.counter}`;
    const timer = setTimeout(() => {
      log.warn('speak timeout', { utteranceId });
      this.settle(utteranceId);
    }, this.timeoutMs);
    this.inFlight = { utteranceId, resolve: next.resolve, timer, settled: false };
    sender.send(IpcChannels.ttsSpeak, { utteranceId, text: next.text });
  }

  /** Resolves the in-flight utterance exactly once, however it finished. */
  private settle(utteranceId: string): void {
    const current = this.inFlight;
    if (current === null || current.utteranceId !== utteranceId || current.settled) return;
    current.settled = true;
    clearTimeout(current.timer);
    this.inFlight = null;
    current.resolve();
    this.pump();
  }

  stop(): void {
    const sender = this.getSender();
    sender?.send(IpcChannels.ttsStop);
    if (this.inFlight !== null) {
      const id = this.inFlight.utteranceId;
      this.settle(id);
    }
    for (const item of this.queue) item.resolve();
    this.queue = [];
  }

  isReady(): boolean {
    return this.ready;
  }

  async dispose(): Promise<void> {
    this.stop();
  }
}
