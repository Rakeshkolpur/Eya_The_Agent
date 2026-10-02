import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { rootLogger } from '@main/logging/logger';
import {
  BRIDGE_HOST,
  BRIDGE_PATH,
  BRIDGE_PORT,
  BROWSER_NAMES,
  EXTENSION_ORIGIN,
  EYA_EXTENSION_ID,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
  parseExtensionMessage,
  toBrowserName,
} from './protocol';
import type { BrowserName, DesktopMessage, ExtensionMessage, RefusalReason, WireHello } from './protocol';

const log = rootLogger.child('chrome.bridge');

const DEFAULT_PAIRING_WINDOW_MS = 120_000;
const DEFAULT_HELLO_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
const LIVENESS_MS = 75_000;
const KNOCK_MEMORY_MS = 90_000;

/** Only a hash of each pairing secret is kept on this side; the secret itself lives in the extension's own storage. */
export interface SecretStore {
  loadHash(browser: BrowserName): string | null;
  saveHash(browser: BrowserName, hash: string): void;
  /** Forget one browser's pairing, or all of them. */
  clear(browser?: BrowserName): void;
}

interface StoredSecrets {
  hashes?: Partial<Record<BrowserName, string>>;
  /** Written by the first version, before Chrome and Edge were paired separately: valid for whichever browser uses it first. */
  secretHash?: string;
}

export class FileSecretStore implements SecretStore {
  constructor(private readonly path: string) {}

  private read(): StoredSecrets {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoredSecrets;
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  private write(data: StoredSecrets): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(data), 'utf8');
  }

  loadHash(browser: BrowserName): string | null {
    const data = this.read();
    const own = data.hashes?.[browser];
    if (typeof own === 'string' && own.length > 0) return own;
    return typeof data.secretHash === 'string' && data.secretHash.length > 0 ? data.secretHash : null;
  }

  saveHash(browser: BrowserName, hash: string): void {
    const data = this.read();
    const hashes = { ...(data.hashes ?? {}), [browser]: hash };
    const { secretHash: legacy, ...rest } = data;
    // A legacy hash that has now been claimed by a browser is no longer "anybody's".
    this.write({ ...rest, hashes, ...(legacy !== undefined && legacy !== hash ? { secretHash: legacy } : {}) });
  }

  clear(browser?: BrowserName): void {
    if (browser === undefined) {
      rmSync(this.path, { force: true });
      return;
    }
    const data = this.read();
    const hashes = { ...(data.hashes ?? {}) };
    delete hashes[browser];
    this.write({ ...data, hashes });
  }
}

export type BridgeErrorCode = 'not_connected' | 'timeout' | 'disconnected' | 'extension_error' | 'ambiguous';

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

export interface BrowserLinkInfo {
  readonly connected: boolean;
  readonly paired: boolean;
  readonly extensionVersion?: string;
  readonly browserVersion?: string;
  readonly capabilities?: readonly string[];
}

export interface BridgeInfo {
  readonly listening: boolean;
  readonly pairingOpen: boolean;
  readonly anyConnected: boolean;
  /** Each browser that is connected, paired, or has an unpaired extension currently knocking. */
  readonly browsers: Readonly<Partial<Record<BrowserName, BrowserLinkInfo>>>;
  /** Browsers whose extension is running and trying to connect but has not been paired yet. */
  readonly waitingToPair: readonly BrowserName[];
  /** The subset of those whose extension is an older version than this Eya needs: it has to be reloaded, not installed or paired. */
  readonly outdated: readonly BrowserName[];
}

export interface BridgeConnectionEvent {
  readonly browser: BrowserName;
  readonly connected: boolean;
  /** The handshake the browser opened with (present when it connected). */
  readonly hello?: WireHello;
}

export interface BridgeBrowserEvent {
  readonly browser: BrowserName;
  readonly name: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** A view of the bridge bound to ONE browser, which is all a per-browser service needs. */
export interface BrowserLink {
  isConnected(): boolean;
  request<T = unknown>(op: string, args?: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<T>;
}

interface ActiveConnection {
  readonly ws: WebSocket;
  readonly browser: BrowserName;
  readonly hello: WireHello;
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
 * extension dials into — one connection for each browser (Chrome and Edge are
 * tracked independently and can both be connected at once). Independent checks
 * stand between any caller and the user's browser:
 *   1. the handshake must carry the extension's exact origin (a web page
 *      cannot forge the Origin header of its own requests);
 *   2. the first message must speak this protocol version and offer the
 *      capabilities Eya relies on (an out-of-date extension is refused with
 *      a plain reason, never half-used);
 *   3. it must present the pairing secret for ITS browser — handed out only
 *      inside a short window the user opens from Eya itself, once per browser;
 *   4. one connection per browser; a newer authenticated one replaces the old.
 * There is no unauthenticated way to send a command.
 */
export class ChromeBridge {
  private wss: WebSocketServer | null = null;
  private readonly conns = new Map<BrowserName, ActiveConnection>();
  private readonly pending = new Map<number, PendingRequest>();
  /** Extensions that tried to connect and were turned away. `outdated`: refused because their version/abilities do not match this Eya. */
  private readonly knocks = new Map<BrowserName, { at: number; version: string; outdated: boolean }>();
  private readonly pairedThisWindow = new Set<BrowserName>();
  private nextId = 1;
  private pairingUntil = 0;
  private liveness: NodeJS.Timeout | null = null;
  private readonly connectionListeners = new Set<(e: BridgeConnectionEvent) => void>();
  private readonly eventListeners = new Set<(e: BridgeBrowserEvent) => void>();
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
        maxPayload: 8 * 1024 * 1024,
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
    this.closePairingWindow(); // a restarted bridge never inherits a pairing window the user opened earlier
    this.pairedThisWindow.clear();
    const wss = this.wss;
    this.wss = null;
    this.conns.clear();
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

  /** True when this browser is connected, or — with no browser named — when any is. */
  isConnected(browser?: BrowserName): boolean {
    if (browser !== undefined) {
      const c = this.conns.get(browser);
      return c !== undefined && c.ws.readyState === WebSocket.OPEN;
    }
    return this.connectedBrowsers().length > 0;
  }

  connectedBrowsers(): BrowserName[] {
    return BROWSER_NAMES.filter((b) => this.isConnected(b));
  }

  /** The handshake a connected browser opened with: its version, capabilities and the tabs it had open. */
  handshakeOf(browser: BrowserName): WireHello | null {
    return this.conns.get(browser)?.hello ?? null;
  }

  /** Extensions that are running and trying to connect but are not paired yet (seen within the last minute and a half). */
  waitingToPair(): BrowserName[] {
    const cutoff = this.now() - KNOCK_MEMORY_MS;
    return BROWSER_NAMES.filter((b) => (this.knocks.get(b)?.at ?? 0) >= cutoff && !this.isConnected(b));
  }

  /**
   * Extensions that are installed and running but were refused because they are an older version than this Eya needs
   * (seen within the last minute and a half). They are not "missing" and not "switched off": they need reloading once.
   */
  outdated(): BrowserName[] {
    const cutoff = this.now() - KNOCK_MEMORY_MS;
    return BROWSER_NAMES.filter((b) => {
      const k = this.knocks.get(b);
      return k !== undefined && k.outdated && k.at >= cutoff && !this.isConnected(b);
    });
  }

  info(): BridgeInfo {
    const browsers: Partial<Record<BrowserName, BrowserLinkInfo>> = {};
    const waiting = this.waitingToPair();
    for (const b of BROWSER_NAMES) {
      const conn = this.isConnected(b) ? this.conns.get(b) : undefined;
      const paired = this.options.secrets.loadHash(b) !== null;
      if (conn === undefined && !paired && !waiting.includes(b)) continue;
      browsers[b] = {
        connected: conn !== undefined,
        paired,
        ...(conn !== undefined
          ? { extensionVersion: conn.hello.extensionVersion, browserVersion: conn.hello.browserVersion, capabilities: conn.hello.capabilities }
          : {}),
      };
    }
    return { listening: this.wss !== null, pairingOpen: this.pairingOpen(), anyConnected: this.isConnected(), browsers, waitingToPair: waiting, outdated: this.outdated() };
  }

  onConnectionChange(listener: (e: BridgeConnectionEvent) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  /** Live happenings inside a connected browser: tabs opening, closing, navigating; windows focusing; downloads. */
  onBrowserEvent(listener: (e: BridgeBrowserEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Resolves true as soon as the browser is connected (immediately if it already is), false if it is not within `ms`. */
  waitForConnection(browser: BrowserName, ms: number): Promise<boolean> {
    if (this.isConnected(browser)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, ms);
      const off = this.onConnectionChange((e) => {
        if (e.browser === browser && e.connected) {
          clearTimeout(timer);
          off();
          resolve(true);
        }
      });
    });
  }

  // ---------------------------------------------------------------- pairing
  /**
   * The user asked Eya to connect their browser: for a short while, an extension with no secret yet may pair — each
   * browser once per window, so Chrome and Edge can both be done in one go.
   */
  openPairingWindow(): number {
    this.pairingUntil = this.now() + (this.options.pairingWindowMs ?? DEFAULT_PAIRING_WINDOW_MS);
    this.pairedThisWindow.clear();
    log.info('bridge pairing window opened');
    return this.pairingUntil;
  }

  closePairingWindow(): void {
    this.pairingUntil = 0;
  }

  pairingOpen(): boolean {
    return this.now() < this.pairingUntil;
  }

  /** Forget a pairing (one browser, or all); that browser is dropped and must be paired again. */
  forgetPairing(browser?: BrowserName): void {
    this.options.secrets.clear(browser);
    for (const [name, conn] of this.conns) {
      if (browser === undefined || browser === name) conn.ws.close(4003, 'pairing removed');
    }
  }

  // --------------------------------------------------------------- requests
  /** A view of the bridge for one browser; requests go to that browser's extension and no other. */
  forBrowser(browser: BrowserName): BrowserLink {
    return {
      isConnected: () => this.isConnected(browser),
      request: <T = unknown>(op: string, args: Readonly<Record<string, unknown>> = {}, timeoutMs?: number) => this.request<T>(op, args, timeoutMs, browser),
    };
  }

  async request<T = unknown>(op: string, args: Readonly<Record<string, unknown>> = {}, timeoutMs?: number, browser?: BrowserName): Promise<T> {
    let conn: ActiveConnection | undefined;
    if (browser !== undefined) conn = this.conns.get(browser);
    else {
      const open = this.connectedBrowsers();
      if (open.length > 1) throw new BridgeError('ambiguous', 'More than one browser is connected; say which one.');
      conn = open[0] !== undefined ? this.conns.get(open[0]) : undefined;
    }
    if (conn === undefined || conn.ws.readyState !== WebSocket.OPEN) {
      throw new BridgeError('not_connected', 'Eya is not connected to your browser.');
    }
    const target = conn;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('timeout', `Your browser did not answer "${op}" in time.`));
      }, timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { ws: target.ws, resolve: (v) => resolve(v as T), reject, timer });
      this.send(target.ws, { t: 'req', id, op, args });
    });
  }

  // --------------------------------------------------------------- internals
  private send(ws: WebSocket, message: DesktopMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  private refuse(ws: WebSocket, reason: RefusalReason, code: number, detail?: string): void {
    log.info('bridge refused a connection', { reason, ...(detail !== undefined ? { detail } : {}) });
    this.send(ws, { t: 'refused', reason, ...(detail !== undefined ? { detail } : {}) });
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
        // Before the handshake, anything unintelligible is refused. After it, one bad frame is ignored: it must not cost the
        // user their whole browser connection.
        if (!authenticated) this.refuse(ws, 'protocol', 4001);
        else log.warn('ignored a malformed message from the browser');
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
      for (const [browser, conn] of this.conns) {
        if (conn.ws !== ws) continue;
        this.conns.delete(browser);
        log.info('browser bridge disconnected', { browser });
        this.notify({ browser, connected: false });
      }
    });
    ws.on('error', (err) => log.warn('bridge socket error', { err: String(err) }));
  }

  private knock(browser: BrowserName, hello: WireHello, outdated = false): void {
    this.knocks.set(browser, { at: this.now(), version: hello.extensionVersion, outdated });
  }

  private authenticate(ws: WebSocket, hello: WireHello): boolean {
    if (hello.ext !== EYA_EXTENSION_ID) {
      this.refuse(ws, 'protocol', 4001);
      return false;
    }
    const browser = toBrowserName(hello.browser);

    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      this.knock(browser, hello, true);
      this.refuse(
        ws,
        'incompatible',
        4005,
        `Eya speaks browser-bridge protocol ${PROTOCOL_VERSION} but this extension speaks ${hello.protocolVersion}. Reload the Eya Browser Bridge extension (extensions page → reload) so it matches this version of Eya.`,
      );
      return false;
    }
    const missing = REQUIRED_CAPABILITIES.filter((c) => !hello.capabilities.includes(c));
    if (missing.length > 0) {
      this.knock(browser, hello, true);
      this.refuse(ws, 'incompatible', 4005, `The extension is missing abilities Eya needs (${missing.join(', ')}). Reload the Eya Browser Bridge extension.`);
      return false;
    }

    const storedHash = this.options.secrets.loadHash(browser);
    if (hello.secret !== undefined) {
      if (storedHash === null || !sameHash(hashSecret(hello.secret), storedHash)) {
        log.warn('bridge refused a wrong pairing secret', { browser });
        this.refuse(ws, 'bad_secret', 4003);
        return false;
      }
      this.options.secrets.saveHash(browser, storedHash); // a legacy hash is now this browser's own
      this.becomeActive(ws, hello, browser);
      this.send(ws, { t: 'ready', protocolVersion: PROTOCOL_VERSION });
      return true;
    }
    if (!this.pairingOpen() || this.pairedThisWindow.has(browser)) {
      this.knock(browser, hello);
      this.refuse(ws, 'not_pairing', 4002);
      return false;
    }
    const secret = randomBytes(32).toString('hex');
    this.options.secrets.saveHash(browser, hashSecret(secret));
    this.pairedThisWindow.add(browser); // this browser is done for this window; the other one may still pair
    this.becomeActive(ws, hello, browser);
    this.send(ws, { t: 'paired', secret, protocolVersion: PROTOCOL_VERSION });
    log.info('browser paired with Eya', { browser });
    return true;
  }

  private becomeActive(ws: WebSocket, hello: WireHello, browser: BrowserName): void {
    const previous = this.conns.get(browser);
    this.conns.set(browser, { ws, browser, hello, lastSeen: this.now() });
    this.knocks.delete(browser);
    if (previous !== undefined && previous.ws !== ws) previous.ws.close(4009, 'replaced');
    log.info('browser bridge connected', {
      browser,
      extension: hello.extensionVersion,
      browserVersion: hello.browserVersion,
      tabs: hello.tabs.length,
    });
    this.notify({ browser, connected: true, hello });
  }

  private connectionFor(ws: WebSocket): ActiveConnection | undefined {
    for (const conn of this.conns.values()) if (conn.ws === ws) return conn;
    return undefined;
  }

  private onMessage(ws: WebSocket, msg: ExtensionMessage): void {
    const conn = this.connectionFor(ws);
    if (conn === undefined) return;
    conn.lastSeen = this.now();
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
      case 'event':
        for (const l of this.eventListeners) l({ browser: conn.browser, name: msg.name, data: msg.data });
        break;
      default:
        break;
    }
  }

  private checkLiveness(): void {
    for (const conn of this.conns.values()) {
      if (this.now() - conn.lastSeen > LIVENESS_MS) {
        log.warn('browser bridge went quiet; dropping it', { browser: conn.browser });
        conn.ws.terminate();
      }
    }
  }

  private notify(e: BridgeConnectionEvent): void {
    for (const l of this.connectionListeners) l(e);
  }
}
