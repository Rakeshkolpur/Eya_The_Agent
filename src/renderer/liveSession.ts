import { buildAudio, buildSetup, buildToolResponse, parseServerMessage } from './liveProtocol';
import type { LiveEvent, LiveSetupOptions, LiveToolResult } from './liveProtocol';

/** The slice of WebSocket this needs, so tests can supply a fake. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

/** What a conversation needs from a session; lets tests use a fake. */
export interface LiveSessionLike {
  readonly isOpen: boolean;
  open(url: string, setup: LiveSetupOptions, connectTimeoutMs?: number): Promise<void>;
  onEvent(listener: (event: LiveEvent) => void): () => void;
  onClose(listener: (info: LiveCloseInfo) => void): () => void;
  sendAudio(pcm: Uint8Array): void;
  sendToolResults(results: readonly LiveToolResult[]): void;
  close(): void;
}

export class LiveOpenError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'closed' | 'error',
    readonly code = 0,
    readonly reason = '',
  ) {
    super(message);
    this.name = 'LiveOpenError';
  }
}

export interface LiveCloseInfo {
  readonly code: number;
  readonly reason: string;
  /** True if we closed it; false if the server or the network did. */
  readonly byUs: boolean;
}

async function toText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return '';
}

/**
 * One Gemini Live connection. `open` resolves once the server confirms setup;
 * after that, audio goes out and events come in. Messages are handled strictly
 * in the order they arrive, even when the browser hands them over as Blobs
 * that take a moment to read.
 */
export class LiveSession implements LiveSessionLike {
  private socket: SocketLike | null = null;
  private ready = false;
  private closedByUs = false;
  private rx: Promise<void> = Promise.resolve();
  private readonly eventListeners = new Set<(event: LiveEvent) => void>();
  private readonly closeListeners = new Set<(info: LiveCloseInfo) => void>();

  constructor(private readonly makeSocket: SocketFactory) {}

  get isOpen(): boolean {
    return this.ready;
  }

  onEvent(listener: (event: LiveEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClose(listener: (info: LiveCloseInfo) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  open(url: string, setup: LiveSetupOptions, connectTimeoutMs = 8000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let socket: SocketLike;
      try {
        socket = this.makeSocket(url);
      } catch (err) {
        reject(new LiveOpenError(err instanceof Error ? err.message : String(err), 'error'));
        return;
      }
      this.socket = socket;

      const fail = (error: LiveOpenError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.detach();
        reject(error);
      };
      const timer = setTimeout(() => fail(new LiveOpenError('timed out connecting to Gemini Live', 'timeout')), connectTimeoutMs);

      socket.onopen = () => socket.send(buildSetup(setup));
      socket.onerror = () => fail(new LiveOpenError('could not connect to Gemini Live', 'error'));
      socket.onclose = (event) => {
        if (!settled) {
          fail(new LiveOpenError(`Gemini Live closed the connection (${event.code}) ${event.reason}`.trim(), 'closed', event.code, event.reason));
          return;
        }
        this.ready = false;
        const info: LiveCloseInfo = { code: event.code, reason: event.reason, byUs: this.closedByUs };
        for (const listener of this.closeListeners) listener(info);
      };
      socket.onmessage = (event) => {
        this.rx = this.rx.then(async () => {
          for (const parsed of parseServerMessage(await toText(event.data))) {
            if (parsed.type === 'setupComplete' && !settled) {
              settled = true;
              clearTimeout(timer);
              this.ready = true;
              resolve();
            }
            for (const listener of this.eventListeners) listener(parsed);
          }
        });
      };
    });
  }

  sendAudio(pcm: Uint8Array): void {
    if (this.ready && this.socket !== null) this.socket.send(buildAudio(pcm));
  }

  sendToolResults(results: readonly LiveToolResult[]): void {
    if (this.ready && this.socket !== null && results.length > 0) this.socket.send(buildToolResponse(results));
  }

  close(): void {
    this.closedByUs = true;
    this.socket?.close();
  }

  private detach(): void {
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    }
  }
}
