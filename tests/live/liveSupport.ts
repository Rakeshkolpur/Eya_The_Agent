/**
 * Shared helpers for the live tests (real Chrome / Edge, the real extension, the real bridge).
 *
 *  - The extension is loaded from a COPY whose bridge port is changed, so these tests never collide with an Eya you
 *    are actually running on the normal port.
 *  - Test browsers use throwaway profiles and are killed by their own process id only — never the user's browsers.
 *  - `userNavigate` / `userEval` / `userOpenTab` / `userCloseTab` act like a PERSON using the browser directly
 *    (over the browser's debugging port, not through Eya), which is how "the user logged in themselves" is simulated.
 */
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type TestBrowserKind = 'chrome' | 'edge';

const CANDIDATES: Record<TestBrowserKind, string[]> = {
  chrome: [
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ],
  edge: [
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ],
};

export function findBrowserExe(kind: TestBrowserKind): string | undefined {
  return CANDIDATES[kind].find((p) => existsSync(p));
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A copy of the extension that dials `port` instead of the normal one. The extension ID is unchanged (it comes from the manifest key). */
export function prepareExtensionCopy(port: number): { dir: string; cleanup: () => void } {
  const source = join(process.cwd(), 'eya-chrome-extension');
  const dir = mkdtempSync(join(tmpdir(), 'eya-ext-copy-'));
  cpSync(source, dir, { recursive: true });
  const bridgeFile = join(dir, 'bridge.js');
  const text = readFileSync(bridgeFile, 'utf8');
  if (!text.includes('ws://127.0.0.1:47821/')) throw new Error('bridge.js no longer contains the expected address');
  writeFileSync(bridgeFile, text.replace('ws://127.0.0.1:47821/', `ws://127.0.0.1:${port}/`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface TestBrowser {
  readonly kind: TestBrowserKind;
  readonly debugPort: number;
  readonly profile: string;
  readonly downloads: string;
  readonly proc: ChildProcess;
  kill(): void;
  cleanup(): void;
}

/** Asks the browser's debugging port to load the unpacked extension — the stand-in for the user's "Load unpacked" click. */
export async function loadUnpackedOverCdp(port: number, path: string): Promise<void> {
  let version: { webSocketDebuggerUrl: string } | null = null;
  await waitFor(
    async () => {
      try {
        version = (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json())) as { webSocketDebuggerUrl: string };
        return true;
      } catch {
        return false;
      }
    },
    30_000,
    "the browser's debugging port",
  );
  const socket = new WebSocket((version as unknown as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('could not open the debugging socket')));
  });
  const reply = await new Promise<{ result?: { id?: string }; error?: { message?: string } }>((resolve) => {
    socket.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: { id?: string }; error?: { message?: string } };
      if (m.id === 1) resolve(m);
    });
    socket.send(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path } }));
  });
  socket.close();
  if (reply.error !== undefined || reply.result?.id === undefined) throw new Error(`loading the extension failed: ${JSON.stringify(reply)}`);
}

export interface StartOptions {
  readonly kind: TestBrowserKind;
  readonly extensionDir: string;
  readonly debugPort: number;
  readonly headed?: boolean;
  /** Opened as the first tab (like a normal browser launched with an address). */
  readonly url?: string;
}

/** Starts a throwaway browser with the extension loaded; resolves once the extension has been handed to it. */
export async function startTestBrowser(opts: StartOptions): Promise<TestBrowser> {
  const exe = findBrowserExe(opts.kind);
  if (exe === undefined) throw new Error(`${opts.kind} is not installed; cannot run this live test.`);
  const profile = mkdtempSync(join(tmpdir(), `eya-live-${opts.kind}-`));
  const downloads = mkdtempSync(join(tmpdir(), `eya-live-dl-${opts.kind}-`));
  mkdirSync(join(profile, 'Default'), { recursive: true });
  writeFileSync(
    join(profile, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false }, savefile: { default_directory: downloads } }),
  );
  const proc = spawn(
    exe,
    [
      `--remote-debugging-port=${opts.debugPort}`,
      `--user-data-dir=${profile}`,
      // Edge honours --load-extension; Chrome 137+ ignores it and takes the extension over its debugging protocol.
      ...(opts.kind === 'edge'
        ? [`--load-extension=${opts.extensionDir}`, `--disable-extensions-except=${opts.extensionDir}`, '--disable-features=DisableLoadExtensionCommandLineSwitch']
        : ['--enable-unsafe-extension-debugging']),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      ...(opts.headed === true ? ['--window-size=1100,850'] : ['--headless=new']),
      opts.url ?? 'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const kill = () => {
    if (proc.pid === undefined) return;
    try {
      // Only the browser this test started (and its children) — never the user's own.
      execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
  };
  if (opts.kind === 'chrome') await loadUnpackedOverCdp(opts.debugPort, opts.extensionDir);
  return {
    kind: opts.kind,
    debugPort: opts.debugPort,
    profile,
    downloads,
    proc,
    kill,
    cleanup: () => {
      rmSync(profile, { recursive: true, force: true });
      rmSync(downloads, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Acting like a person at the keyboard: straight to the browser's debugging port, never through Eya.

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

async function targets(port: number): Promise<CdpTarget[]> {
  return (await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())) as CdpTarget[];
}

async function sessionCall<T = unknown>(wsUrl: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('debugging socket failed')));
  });
  const reply = await new Promise<{ result?: T; error?: { message?: string } }>((resolve) => {
    socket.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; result?: T; error?: { message?: string } };
      if (m.id === 1) resolve(m);
    });
    socket.send(JSON.stringify({ id: 1, method, params }));
  });
  socket.close();
  if (reply.error !== undefined) throw new Error(`${method}: ${reply.error.message ?? 'failed'}`);
  return reply.result as T;
}

async function pageTarget(port: number, urlPart?: string): Promise<CdpTarget> {
  const pages = (await targets(port)).filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  const found = urlPart === undefined ? pages[0] : pages.find((t) => t.url.includes(urlPart) || t.title.includes(urlPart));
  if (found === undefined) throw new Error(`no tab matching "${urlPart ?? '(any)'}" in the browser on port ${port}`);
  return found;
}

/** The user types an address into a tab (the first one, or the one whose address/title contains `inTab`). */
export async function userNavigate(port: number, url: string, inTab?: string): Promise<void> {
  const t = await pageTarget(port, inTab);
  await sessionCall(t.webSocketDebuggerUrl, 'Page.navigate', { url });
}

/** The user does something in a page — fills in a form and presses the button, say — by running a script in it. */
export async function userEval(port: number, inTab: string | undefined, expression: string): Promise<unknown> {
  const t = await pageTarget(port, inTab);
  const r = await sessionCall<{ result?: { value?: unknown } }>(t.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.value;
}

/** The user opens a new tab. */
export async function userOpenTab(port: number, url: string): Promise<void> {
  const version = (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json())) as { webSocketDebuggerUrl: string };
  await sessionCall(version.webSocketDebuggerUrl, 'Target.createTarget', { url });
}

/** The user closes a tab. */
export async function userCloseTab(port: number, inTab: string): Promise<void> {
  const t = await pageTarget(port, inTab);
  await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
}

export async function userTabUrls(port: number): Promise<string[]> {
  return (await targets(port)).filter((t) => t.type === 'page' && !t.url.startsWith('devtools://')).map((t) => t.url);
}
