import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { rootLogger } from '@main/logging/logger';
import {
  BRIDGE_HOST,
  BRIDGE_PATH,
  BRIDGE_PORT,
  EXTENSION_ORIGIN,
  EYA_EXTENSION_ID,
  parseExtensionMessage,
} from './protocol';
import type { DesktopMessage, ExtensionMessage, RefusalReason } from './protocol';

const log = rootLogger.child('chrome.bridge');

const DEFAULT_PAIRING_WINDOW_MS = 120_000;
const DEFAULT_HELLO_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
const LIVENESS_MS = 75_000;

/** Only a hash of the pairing secret is kept on this side; the secret itself lives in the extension's own storage. */
export interface SecretStore {
  loadHash(): string | null;
  saveHash(hash: string): void;
  clear(): void;
}

export class FileSecretStore implements SecretStore {
  constructor(private readonly path: string) {}

  loadHash(): string | null {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { secretHash?: unknown };
      return typeof parsed.secretHash === 'string' && parsed.secretHash.length > 0 ? parsed.secretHash : null;
    } catch {
      return null;
    }
  }

  saveHash(hash: string): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ secretHash: hash }), 'utf8');
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }
}

export type BridgeErrorCode = 'not_connected' | 'timeout' | 'disconnected' | 'extension_error';

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

export interface BridgeOptions {
  readonly secrets: SecretStore;
  readonly port?: number;
  readonly host?: string;
  readonly pairingWindowMs?: number;
  readonly helloTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
}

export interface BridgeInfo {
  readonly listening: boolean;
  readonly connected: boolean;
  readonly browser?: string;
  readonly version?: string;
  readonly paired: boolean;
  readonly pairingOpen: boolean;
}

interface ActiveConnection {
  readonly ws: WebSocket;
  readonly browser: string;
  readonly version: string;
  lastSeen: number;
}

interface PendingRequest {
  readonly ws: WebSocket;
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * A WebSocket server on the loopback interface that the Eya Browser Bridge
 * extension dials into. Three independent checks stand between any caller and
 * the user's browser:
 *   1. the handshake must carry the extension's exact origin (a web page
 *      cannot forge the Origin header of its own requests);
 *   2. the first message must present the pairing secret — which is only ever
 *      handed out inside a short window the user opens from Eya itself;
 *   3. one connection at a time; a newer authenticated one replaces the old.
 * There is no unauthenticated way to send a command.
 */
export class ChromeBridge {
  private wss: WebSocketServer | null = null;
  private active: ActiveConnection | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private pairingUntil = 0;
  private liveness: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<(connected: boolean) => void>();
  private readonly now: () => number;

  constructor(private readonly options: BridgeOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Starts listening. Resolves false (instead of throwing) when the port is already taken, so Eya still starts. */
  async start(): Promise<boolean> {
    if (this.wss !== null) return true;
    const port = this.options.port ?? BRIDGE_PORT;
    const host = this.options.host ?? BRIDGE_HOST;
    const wss = await new Promise<WebSocketServer | null>((resolve) => {
      const server = new WebSocketServer({
        host,
        port,
        path: BRIDGE_PATH,
        maxPayload: 4 * 1024 * 1024,
        verifyClient: (info, done) => {
          if (info.origin !== EXTENSION_ORIGIN) {
            log.warn('bridge refused a connection with the wrong origin', { origin: info.origin || '(none)' });
            done(false, 403, 'forbidden');
            return;
          }
          done(true);
        },
      });
      server.once('listening', () => resolve(server));
      server.once('error', (err) => {
        log.warn('bridge could not listen', { port, err: String(err) });
        server.close();
        resolve(null);
      });
    });
    if (wss === null) return false;
    this.wss = wss;
    wss.on('connection', (ws) => this.onConnection(ws));
    wss.on('error', (err) => log.warn('bridge server error', { err: String(err) }));
    this.liveness = setInterval(() => this.checkLiveness(), 15_000);
    this.liveness.unref();
    log.info('chrome bridge listening', { host, port });
    return true;
  }

  async stop(): Promise<void> {
    if (this.liveness !== null) clearInterval(this.liveness);
    this.liveness = null;
    const wss = this.wss;
    this.wss = null;
    this.active = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BridgeError('disconnected', 'Eya is shutting down.'));
      this.pending.delete(id);
    }
    if (wss === null) return;
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  // ------------------------------------------------------------------ state
  /** The port actually bound (differs from the configured one only when that was 0). */
  port(): number | null {
    const address = this.wss?.address();
    return typeof address === 'object' && address !== null ? address.port : null;
  }

  isConnected(): boolean {
    return this.active !== null && this.active.ws.readyState === WebSocket.OPEN;
  }

  info(): BridgeInfo {
    return {
      listening: this.wss !== null,
      connected: this.isConnected(),
      ...(this.active !== null ? { browser: this.active.browser, version: this.active.version } : {}),
      paired: this.options.secrets.loadHash() !== null,
      pairingOpen: this.pairingOpen(),
    };
  }

  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------------------------------------------------------------- pairing
  /** The user asked Eya to connect their browser: for a short while, an extension with no secret yet may pair. */
  openPairingWindow(): number {
    this.pairingUntil = this.now() + (this.options.pairingWindowMs ?? DEFAULT_PAIRING_WINDOW_MS);
    log.info('bridge pairing window opened');
    return this.pairingUntil;
  }

  closePairingWindow(): void {
    this.pairingUntil = 0;
  }

  pairingOpen(): boolean {
    return this.now() < this.pairingUntil;
  }

  /** Forget the pairing entirely; the connected browser (if any) is dropped and must be paired again. */
  forgetPairing(): void {
    this.options.secrets.clear();
    this.active?.ws.close(4003, 'pairing removed');
  }

  // --------------------------------------------------------------- requests
  async request<T = unknown>(op: string, args: Readonly<Record<string, unknown>> = {}, timeoutMs?: number): Promise<T> {
    const conn = this.active;
    if (conn === null || conn.ws.readyState !== WebSocket.OPEN) {
      throw new BridgeError('not_connected', 'Eya is not connected to your browser.');
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('timeout', `Your browser did not answer "${op}" in time.`));
      }, timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { ws: conn.ws, resolve: (v) => resolve(v as T), reject, timer });
      this.send(conn.ws, { t: 'req', id, op, args });
    });
  }

  // --------------------------------------------------------------- internals
  private send(ws: WebSocket, message: DesktopMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  private refuse(ws: WebSocket, reason: RefusalReason, code: number): void {
    log.info('bridge refused a connection', { reason });
    this.send(ws, { t: 'refused', reason });
    ws.close(code, reason);
  }

  private onConnection(ws: WebSocket): void {
    let authenticated = false;
    const helloTimer = setTimeout(() => {
      if (!authenticated) ws.close(4000, 'no hello');
    }, this.options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS);

    ws.on('message', (data) => {
      const msg = parseExtensionMessage(data.toString());
      if (msg === null) {
        this.refuse(ws, 'protocol', 4001);
        return;
      }
      if (!authenticated) {
        if (msg.t !== 'hello') {
          this.refuse(ws, 'protocol', 4001);
          return;
        }
        authenticated = this.authenticate(ws, msg);
        if (authenticated) clearTimeout(helloTimer);
        return;
      }
      this.onMessage(ws, msg);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      for (const [id, p] of this.pending) {
        if (p.ws !== ws) continue;
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new BridgeError('disconnected', 'Your browser disconnected from Eya.'));
      }
      if (this.active?.ws === ws) {
        this.active = null;
        log.info('browser bridge disconnected');
        this.notify(false);
      }
    });
    ws.on('error', (err) => log.warn('bridge socket error', { err: String(err) }));
  }

  private authenticate(ws: WebSocket, hello: Extract<ExtensionMessage, { t: 'hello' }>): boolean {
    if (hello.ext !== EYA_EXTENSION_ID) {
      this.refuse(ws, 'protocol', 4001);
      return false;
    }
    const storedHash = this.options.secrets.loadHash();
    if (hello.secret !== undefined) {
      if (storedHash === null || !sameHash(hashSecret(hello.secret), storedHash)) {
        log.warn('bridge refused a wrong pairing secret');
        this.refuse(ws, 'bad_secret', 4003);
        return false;
      }
      this.becomeActive(ws, hello);
      this.send(ws, { t: 'ready' });
      return true;
    }
    if (!this.pairingOpen()) {
      this.refuse(ws, 'not_pairing', 4002);
      return false;
    }
    const secret = randomBytes(32).toString('hex');
    this.options.secrets.saveHash(hashSecret(secret));
    this.closePairingWindow(); // one pairing per window
    this.becomeActive(ws, hello);
    this.send(ws, { t: 'paired', secret });
    log.info('browser paired with Eya', { browser: hello.browser });
    return true;
  }

  private becomeActive(ws: WebSocket, hello: Extract<ExtensionMessage, { t: 'hello' }>): void {
    const previous = this.active;
    this.active = { ws, browser: hello.browser, version: hello.version, lastSeen: this.now() };
    if (previous !== null && previous.ws !== ws) previous.ws.close(4009, 'replaced');
    log.info('browser bridge connected', { browser: hello.browser, version: hello.version });
    this.notify(true);
  }

  private onMessage(ws: WebSocket, msg: ExtensionMessage): void {
    if (this.active?.ws !== ws) return;
    this.active.lastSeen = this.now();
    switch (msg.t) {
      case 'ping':
        this.send(ws, { t: 'pong' });
        break;
      case 'res': {
        const p = this.pending.get(msg.id);
        if (p === undefined || p.ws !== ws) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new BridgeError('extension_error', msg.error ?? 'The browser reported an error.'));
        break;
      }
      default:
        break;
    }
  }

  private checkLiveness(): void {
    const conn = this.active;
    if (conn !== null && this.now() - conn.lastSeen > LIVENESS_MS) {
      log.warn('browser bridge went quiet; dropping it');
      conn.ws.terminate();
    }
  }

  private notify(connected: boolean): void {
    for (const l of this.listeners) l(connected);
  }
}
