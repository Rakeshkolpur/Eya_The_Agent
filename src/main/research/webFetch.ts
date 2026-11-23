import { isPrivateHost } from '@main/tools/impl/downloadTools';
import { parseWebUrl } from '@main/tools/impl/openTools';

/**
 * Reading pages and checking documents over plain HTTP, the way a browser's address bar would — but fast, in parallel, and with the
 * rules a research tool needs: only web addresses, never this PC or the local network, a size cap, a time cap.
 */

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

export interface WebFetchDeps {
  /** Electron's `net.fetch` in the app (system proxy and certificates); Node's `fetch` in tests. */
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Tests only: allow addresses on this PC. */
  readonly allowPrivateHosts?: boolean;
}

export interface FetchedPage {
  readonly ok: boolean;
  readonly status: number;
  /** Where it ended up after redirects. */
  readonly url: string;
  readonly contentType: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly error?: string;
}

export interface DocumentProbe {
  readonly ok: boolean;
  readonly isPdf: boolean;
  readonly contentType: string;
  readonly sizeBytes: number | null;
  readonly url: string;
  readonly reason?: string;
}

export interface FetchOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 1_500_000;
const DEFAULT_TIMEOUT_MS = 12_000;

function charsetOf(contentType: string): string {
  const m = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType);
  return (m?.[1] ?? 'utf-8').toLowerCase();
}

function decode(bytes: Uint8Array, contentType: string): string {
  try {
    return new TextDecoder(charsetOf(contentType), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

async function readUpTo(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (res.body === null) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let at = 0;
  for (const c of chunks) {
    const room = out.length - at;
    if (room <= 0) break;
    out.set(c.length > room ? c.subarray(0, room) : c, at);
    at += Math.min(c.length, room);
  }
  return { bytes: out, truncated };
}

export class WebFetcher {
  private readonly fetchFn: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(private readonly deps: WebFetchDeps = {}) {
    this.fetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
  }

  /** Why an address may not be fetched at all, or null when it may. */
  private refusal(raw: string): string | null {
    const url = parseWebUrl(raw);
    if (url === null) return 'not a web address';
    if (this.deps.allowPrivateHosts !== true && isPrivateHost(url.hostname)) return 'an address on this PC or network';
    return null;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'user-agent': BROWSER_UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html,application/xhtml+xml,application/pdf;q=0.8,*/*;q=0.5', ...extra };
  }

  /** A page's text (HTML or plain), up to a size cap. Never throws. */
  async page(raw: string, options: FetchOptions = {}): Promise<FetchedPage> {
    const refused = this.refusal(raw);
    if (refused !== null) return { ok: false, status: 0, url: raw, contentType: '', text: '', truncated: false, error: refused };
    try {
      const res = await this.fetchFn(raw, { headers: this.headers(), redirect: 'follow', signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
      const finalUrl = res.url !== '' ? res.url : raw;
      const after = this.refusal(finalUrl);
      if (after !== null) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, status: res.status, url: finalUrl, contentType: '', text: '', truncated: false, error: `redirected to ${after}` };
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, status: res.status, url: finalUrl, contentType, text: '', truncated: false, error: `HTTP ${res.status}` };
      }
      if (/pdf|image\/|video\/|audio\/|zip|octet-stream/i.test(contentType)) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: true, status: res.status, url: finalUrl, contentType, text: '', truncated: false };
      }
      const { bytes, truncated } = await readUpTo(res, options.maxBytes ?? DEFAULT_MAX_BYTES);
      return { ok: true, status: res.status, url: finalUrl, contentType, text: decode(bytes, contentType), truncated };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 0, url: raw, contentType: '', text: '', truncated: false, error: /abort|timeout/i.test(message) ? 'timed out' : message.slice(0, 120) };
    }
  }

  /** Whether an address really is a PDF (it starts with the PDF marker), and how big, without downloading it. Never throws. */
  async probeDocument(raw: string, timeoutMs = 10_000): Promise<DocumentProbe> {
    const refused = this.refusal(raw);
    if (refused !== null) return { ok: false, isPdf: false, contentType: '', sizeBytes: null, url: raw, reason: refused };
    try {
      const res = await this.fetchFn(raw, { headers: this.headers({ range: 'bytes=0-1023', accept: 'application/pdf,*/*;q=0.5' }), redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      const finalUrl = res.url !== '' ? res.url : raw;
      if (this.refusal(finalUrl) !== null) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, isPdf: false, contentType: '', sizeBytes: null, url: finalUrl, reason: 'redirected somewhere not allowed' };
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (res.status !== 200 && res.status !== 206) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, isPdf: false, contentType, sizeBytes: null, url: finalUrl, reason: `HTTP ${res.status}` };
      }
      const { bytes } = await readUpTo(res, 1024);
      const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
      const isPdf = /^\s*%PDF-/.test(head) || (/pdf/i.test(contentType) && head.includes('%PDF-'));
      const range = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
      const length = res.headers.get('content-length');
      const sizeBytes = range?.[1] !== undefined ? Number(range[1]) : res.status === 200 && length !== null && Number(length) > 0 ? Number(length) : null;
      return { ok: true, isPdf, contentType, sizeBytes, url: finalUrl, ...(isPdf ? {} : { reason: /html/i.test(contentType) ? 'a web page, not a PDF' : 'not a PDF' }) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, isPdf: false, contentType: '', sizeBytes: null, url: raw, reason: /abort|timeout/i.test(message) ? 'timed out' : message.slice(0, 100) };
    }
  }

  /** A JSON answer (for the few public APIs worth asking, such as the Internet Archive's). Null when it cannot be had. */
  async json<T>(raw: string, timeoutMs = 12_000): Promise<T | null> {
    const refused = this.refusal(raw);
    if (refused !== null) return null;
    try {
      const res = await this.fetchFn(raw, { headers: this.headers({ accept: 'application/json' }), signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
}
