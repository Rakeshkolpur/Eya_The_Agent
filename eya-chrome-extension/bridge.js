/**
 * The connection from this extension to the Eya desktop app on the same PC.
 *
 * It only ever dials 127.0.0.1. The desktop side refuses any connection that
 * does not come from this extension's own origin, and — after the one-time
 * pairing the user starts from Eya — any connection that does not present the
 * secret it was given then. The secret lives in this extension's own storage.
 *
 * The first thing sent is a handshake: which browser this is and its version,
 * which protocol and extension version this is, what it can do, and what is open
 * in the browser right now (windows, tabs, which tab is in front). After that the
 * extension keeps Eya up to date with live events.
 */
export const BRIDGE_URL = 'ws://127.0.0.1:47821/eya-bridge';
/**
 * The same address as a plain web request, used to LOOK for Eya before connecting. A connection that fails is written to the browser's
 * "Errors" list for this extension every time ("WebSocket connection … failed: net::ERR_CONNECTION_REFUSED") — and the extension tries
 * whenever the browser wakes it, so with Eya not running that list grew all day. A web request that finds nobody is not recorded as an
 * error (measured in a real Chrome), so the extension asks quietly first and opens the connection only when Eya answers.
 */
export const PROBE_URL = BRIDGE_URL.replace(/^ws:/, 'http:');
const PROBE_TIMEOUT_MS = 2000;
/**
 * The key Eya leaves in this extension's own folder. With no pairing secret of its own yet (a fresh load, a reinstall, a secret Eya no
 * longer knows), the extension presents it in its handshake and Eya pairs it by itself — nobody has to ask Eya to "connect my browser".
 * Only this extension can read its own folder's files from here; the file is not listed as a web-accessible resource, so no page can.
 */
const BOOTSTRAP_FILE = 'eya-pairing.json';

async function readFolderKey() {
  try {
    const response = await fetch(chrome.runtime.getURL(BOOTSTRAP_FILE), { cache: 'no-store' });
    if (!response.ok) return undefined;
    const { token } = await response.json();
    return typeof token === 'string' && token.length >= 32 && token.length <= 200 ? token : undefined;
  } catch {
    return undefined; // an older Eya, or a folder she cannot write to: the pairing window is the way then
  }
}
/** Bumped together with the desktop side whenever the messages change incompatibly. */
export const PROTOCOL_VERSION = 2;
const PING_MS = 20000;
const MAX_BACKOFF_MS = 15000;

export class Bridge {
  constructor({ onRequest, onStatus, version, browserName, browserVersion, capabilities, getSnapshot }) {
    this.onRequest = onRequest;
    this.onStatus = onStatus;
    this.version = version;
    this.browserName = browserName;
    this.browserVersion = browserVersion;
    this.capabilities = capabilities;
    this.getSnapshot = getSnapshot;
    this.ws = null;
    this.backoffMs = 1500;
    this.retryTimer = null;
    this.pingTimer = null;
    this.probing = false;
    this.status = 'connecting';
  }

  setStatus(status, detail = '') {
    if (status !== this.status) console.info(`[eya-bridge] ${this.status} -> ${status}${detail ? ` (${detail})` : ''}`);
    this.status = status;
    this.onStatus(status, detail);
  }

  /** Whether anything answers at Eya's address. Never throws, and never leaves an error in the browser's list when nobody does. */
  async eyaIsThere() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      await fetch(PROBE_URL, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
      return true; // any answer at all (Eya's bridge answers a plain request with "upgrade required")
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Safe to call as often as you like (every wake-up of the service worker does). Connects only when Eya is there to answer. */
  ensureConnected() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this.probing) return;
    this.probing = true;
    void this.eyaIsThere().then((there) => {
      this.probing = false;
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
      if (there) this.connect();
      else this.scheduleRetry();
    });
  }

  connect() {
    clearTimeout(this.retryTimer);
    let ws;
    try {
      ws = new WebSocket(BRIDGE_URL);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    this.setStatus('connecting');

    ws.onopen = async () => {
      const { eyaSecret } = await chrome.storage.local.get('eyaSecret');
      const folderKey = eyaSecret ? undefined : await readFolderKey();
      let snapshot = { tabs: [], windows: [] };
      try {
        snapshot = await this.getSnapshot();
      } catch {
        // the handshake still goes ahead; the first events will fill the picture in
      }
      console.info(`[eya-bridge] connected to Eya, saying hello (${eyaSecret ? 'with' : folderKey ? 'with the folder key, no' : 'without'} a stored pairing)`);
      this.send({
        t: 'hello',
        ext: chrome.runtime.id,
        protocolVersion: PROTOCOL_VERSION,
        extensionVersion: this.version,
        browser: this.browserName,
        browserVersion: this.browserVersion,
        capabilities: this.capabilities,
        ...snapshot,
        ...(eyaSecret ? { secret: eyaSecret } : folderKey ? { bootstrap: folderKey } : {}),
      });
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      void this.handle(msg);
    };

    ws.onclose = (event) => {
      console.info(`[eya-bridge] socket closed (code ${event.code}); retrying in ${this.backoffMs} ms`);
      clearInterval(this.pingTimer);
      if (this.ws === ws) this.ws = null;
      if (this.status === 'connected') this.setStatus('disconnected');
      this.scheduleRetry();
    };
    ws.onerror = () => {
      // onclose follows; nothing to add. (Eya simply not running is the usual cause.)
    };
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.ensureConnected(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /** A live browser event for Eya; dropped silently when not connected (the next handshake carries the full picture). */
  sendEvent(name, data) {
    if (this.status === 'connected') this.send({ t: 'event', name, data });
  }

  async handle(msg) {
    switch (msg.t) {
      case 'paired':
        await chrome.storage.local.set({ eyaSecret: msg.secret });
        this.markReady();
        break;
      case 'ready':
        this.markReady();
        break;
      case 'refused':
        // Not paired yet, a stale secret, or a version mismatch: wait politely rather than hammer.
        if (msg.reason === 'bad_secret') await chrome.storage.local.remove('eyaSecret');
        this.setStatus(
          msg.reason === 'not_pairing' ? 'waiting_for_pairing' : msg.reason === 'incompatible' ? 'incompatible' : `refused:${msg.reason}`,
          msg.detail ?? '',
        );
        this.backoffMs = MAX_BACKOFF_MS;
        break;
      case 'ping':
        this.send({ t: 'pong' });
        break;
      case 'req': {
        let reply;
        try {
          reply = { t: 'res', id: msg.id, ok: true, result: await this.onRequest(msg.op, msg.args ?? {}) };
        } catch (err) {
          reply = { t: 'res', id: msg.id, ok: false, error: String(err?.message ?? err) };
        }
        this.send(reply);
        break;
      }
      default:
        break;
    }
  }

  markReady() {
    this.backoffMs = 1500;
    this.setStatus('connected');
    clearInterval(this.pingTimer);
    // Steady traffic also keeps Chrome from putting the service worker to sleep.
    this.pingTimer = setInterval(() => this.send({ t: 'ping' }), PING_MS);
  }
}
