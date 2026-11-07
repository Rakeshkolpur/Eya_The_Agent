import { appendFileSync } from 'node:fs';
import { normalizePageState } from '@main/chrome/pageState';
import type { BrowserName } from '@main/chrome/protocol';
import { maskStructure, probeReport, probeSignature } from '@main/chat/pageProbe';
import type { ProbeStructure, RawProbe } from '@main/chat/pageProbe';

/**
 * Only when EYA_PAGE_PROBE is set (see main.ts): every few seconds, looks at the tab of one site through the extension that is already paired
 * (the same read-only look every Eya step starts with), and writes what the page is made of — never what it says (see pageProbe) — whenever that
 * changes. It clicks nothing, types nothing and sends nothing.
 */
export interface ProbeBridge {
  connectedBrowsers(): readonly BrowserName[];
  request<T = unknown>(op: string, args?: Readonly<Record<string, unknown>>, timeoutMs?: number, browser?: BrowserName): Promise<T>;
}

interface TabsReply {
  readonly tabs?: ReadonlyArray<{ readonly tabId?: number; readonly url?: string; readonly active?: boolean }>;
}

export function startPageProbe(opts: { readonly bridge: ProbeBridge; readonly file: string; readonly host: string; readonly everyMs?: number; readonly maxReports?: number }): () => void {
  let last = '';
  let written = 0;
  let lastError = '';
  const write = (record: unknown): void => {
    try {
      appendFileSync(opts.file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // nothing to do: the probe is a convenience
    }
  };
  let lastStatus = '';
  const status = (record: Record<string, unknown>): void => {
    const key = JSON.stringify(record);
    if (key === lastStatus) return;
    lastStatus = key;
    write({ at: new Date().toISOString(), status: record });
  };
  const tick = async (): Promise<void> => {
    if (written >= (opts.maxReports ?? 60)) return;
    const connected = opts.bridge.connectedBrowsers();
    if (connected.length === 0) {
      status({ connected: [] });
      return;
    }
    for (const browser of connected) {
      try {
        const listed = await opts.bridge.request<TabsReply>('list_tabs', {}, 8000, browser);
        const tab = (listed.tabs ?? []).filter((t) => typeof t.tabId === 'number' && typeof t.url === 'string' && t.url.includes(opts.host)).sort((a, b) => Number(b.active === true) - Number(a.active === true))[0];
        status({ connected, browser, tabs: (listed.tabs ?? []).length, found: tab !== undefined });
        if (tab === undefined) continue;
        const raw = await opts.bridge.request<{ state?: unknown }>('observe', { tabId: tab.tabId }, 15_000, browser);
        const base = probeReport(normalizePageState(raw.state), new Date().toISOString());
        // How the fields and file inputs are built: the extension may be an older one without this look, which is fine.
        let structure: ProbeStructure | null = null;
        try {
          const built = await opts.bridge.request<{ probe?: RawProbe }>('probe', { tabId: tab.tabId }, 10_000, browser);
          structure = maskStructure(built.probe);
        } catch {
          structure = null;
        }
        const report = { ...base, structure };
        const signature = probeSignature(report);
        if (signature === last) continue;
        last = signature;
        written += 1;
        write({ browser, ...report });
      } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 200) : 'unknown error';
        if (message !== lastError) {
          lastError = message;
          write({ at: new Date().toISOString(), browser, error: message });
        }
      }
    }
  };
  const timer = setInterval(() => void tick(), opts.everyMs ?? 3000);
  timer.unref?.();
  return () => clearInterval(timer);
}
