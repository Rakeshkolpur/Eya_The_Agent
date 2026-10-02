/**
 * The connection from this extension to the Eya desktop app on the same PC.
 *
 * It only ever dials 127.0.0.1. The desktop side refuses any connection that
 * does not come from this extension's own origin, and — after the one-time
 * pairing the user starts from Eya — any connection that does not present the
 * secret it was given then. The secret lives in this extension's own storage.
 */
export const BRIDGE_URL = 'ws://127.0.0.1:47821/eya-bridge';
const PING_MS = 20000;
const MAX_BACKOFF_MS = 15000;

export class Bridge {
  constructor({ onRequest, onStatus, version, browserName }) {
    this.onRequest = onRequest;
    this.onStatus = onStatus;
    this.version = version;
    this.browserName = browserName;
    this.ws = null;
    this.backoffMs = 1500;
    this.retryTimer = null;
    this.pingTimer = null;
    this.status = 'connecting';
  }

  setStatus(status, detail = '') {
    if (status !== this.status) console.info(`[eya-bridge] ${this.status} -> ${status}${detail ? ` (${detail})` : ''}`);
    this.status = status;
    this.onStatus(status, detail);
  }

  /** Safe to call as often as you like (every wake-up of the service worker does). */
  ensureConnected() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.connect();
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
      console.info(`[eya-bridge] connected to Eya, saying hello (${eyaSecret ? 'with' : 'without'} a stored pairing)`);
      this.send({
        t: 'hello',
        ext: chrome.runtime.id,
        version: this.version,
        browser: this.browserName,
        ...(eyaSecret ? { secret: eyaSecret } : {}),
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
        // Not paired yet (or the pairing window is closed): wait politely rather than hammer.
        if (msg.reason === 'bad_secret') await chrome.storage.local.remove('eyaSecret');
        this.setStatus(msg.reason === 'not_pairing' ? 'waiting_for_pairing' : `refused:${msg.reason}`);
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
