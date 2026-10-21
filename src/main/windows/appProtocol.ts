import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { rootLogger } from '@main/logging/logger';
import { ISOLATION_HEADERS } from '@main/isolationHeaders';

const log = rootLogger.child('appprotocol');

/**
 * Eya's own page, served from her install folder at a private address (`eya-app://app/`) instead of as a `file://` page.
 *
 * Why: the speech engine and the offline voice run in module workers, and a browser will not start a module worker from a `file://`
 * page (that origin has no identity, so the worker script is refused). That worked when running from source, where the page comes from
 * a development server over http, and silently failed in an installed app: no speech recognition, no offline voice. Giving the page a
 * real, secure origin of its own fixes it, and also lets the page be "cross-origin isolated" (which the speech engine needs to use
 * several processor threads), so the headers for that are sent with every file here.
 *
 * Only plain web files from the built page's folder are served, and nothing outside it: the path is resolved first and refused unless
 * it lands inside.
 */

export const APP_SCHEME = 'eya-app';
export const APP_URL = `${APP_SCHEME}://app/index.html`;

const TYPES = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.wasm', 'application/wasm'], // must be this type for WebAssembly.instantiateStreaming
  ['.json', 'application/json'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

/** How this scheme is declared. All of Eya's private schemes are declared together, once (see registerPrivateSchemes). */
export const APP_SCHEME_PRIVILEGES: Electron.CustomScheme = {
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
};

/** The file a request means, or null if it is not a plain web file inside `root`. Pure, so it can be tested. */
export function resolveAppFile(root: string, urlPath: string): { readonly path: string; readonly type: string } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  let relativePath = decoded.replace(/^\/+/, '');
  if (relativePath === '') relativePath = 'index.html';
  if (relativePath.includes('\0')) return null;
  const type = TYPES.get(extname(relativePath).toLowerCase());
  if (type === undefined) return null;
  const base = resolve(root);
  const full = resolve(base, relativePath);
  const inside = relative(base, full);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null;
  return { path: full, type };
}

/**
 * Headers for every file. The page is cross-origin isolated (COOP/COEP, from isolationHeaders.ts), and a worker's own script has to come
 * with the same headers or the browser refuses to start it: so they are set here, and the app's header hook replaces (never appends)
 * them, so each appears once.
 */
const HEADERS: Record<string, string> = {
  ...ISOLATION_HEADERS,
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-cache',
};

export function handleAppProtocol(root: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const file = resolveAppFile(root, url.pathname);
    if (file === null) return new Response('not found', { status: 404 });
    try {
      const upstream = await net.fetch(pathToFileURL(file.path).toString());
      if (!upstream.ok) return new Response('not found', { status: 404 });
      return new Response(upstream.body, { status: 200, headers: { ...HEADERS, 'Content-Type': file.type } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
  log.info('the page is served from its install folder', { root });
}

/** Where the built page is: next to the main process's own file (out/renderer). */
export function appRoot(mainDir: string): string {
  return join(mainDir, '..', 'renderer');
}
