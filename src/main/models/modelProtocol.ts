import { stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, net, protocol } from 'electron';
import { rootLogger } from '@main/logging/logger';

const log = rootLogger.child('models');

/**
 * Eya's speech models, served to her own page from files on this PC.
 *
 * The speech-recognition model used to be downloaded from huggingface.co the first time Eya started, so a first run without internet
 * heard nothing, and every installation depended on that site. The installer now carries the model, and this private address
 * (`eya-models://app/<path>`) hands it to the page's speech worker from the install folder. A file that is not there answers "not
 * found", and the speech library then falls back to downloading it as before, so running from source without the models still works.
 *
 * Only the page that belongs to Eya can reach this scheme, only plain model files can be read, and nothing outside the models folder:
 * the path is resolved first and refused unless it lands inside it.
 */

export const MODEL_SCHEME = 'eya-models';
const ALLOWED = new Map<string, string>([
  ['.json', 'application/json'],
  ['.onnx', 'application/octet-stream'],
  ['.txt', 'text/plain'],
  ['.model', 'application/octet-stream'],
  ['.bin', 'application/octet-stream'],
]);

/** How this scheme is declared. All of Eya's private schemes are declared together, once (see registerPrivateSchemes). */
export const MODEL_SCHEME_PRIVILEGES: Electron.CustomScheme = {
  scheme: MODEL_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
};

/** Where the models are: next to the app's resources when installed, the project's own folder when run from source. */
export function modelsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'models') : join(app.getAppPath(), 'models');
}

/** The file a request means, or null if it is not a plain model file inside `dir`. Pure, so it can be tested. */
export function resolveModelFile(dir: string, urlPath: string): { readonly path: string; readonly type: string } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const relativePath = decoded.replace(/^\/+/, '');
  if (relativePath === '' || relativePath.includes('\0')) return null;
  const type = ALLOWED.get(extname(relativePath).toLowerCase());
  if (type === undefined) return null;
  const base = resolve(dir);
  const full = resolve(base, relativePath);
  const inside = relative(base, full);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null;
  return { path: full, type };
}

const HEADERS = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };

/** Starts answering `eya-models://` requests. Call once the app is ready. */
export function handleModelProtocol(dir: string): void {
  protocol.handle(MODEL_SCHEME, async (request) => {
    const url = new URL(request.url);
    const file = resolveModelFile(dir, url.pathname);
    if (file === null) return new Response('not found', { status: 404, headers: HEADERS });
    try {
      // The size goes with the file: without it the speech library cannot size its buffer ahead and grows it piece by piece while a
      // 30 MB model arrives, which made loading take 10 s instead of 2.
      const { size } = await stat(file.path);
      const upstream = await net.fetch(pathToFileURL(file.path).toString());
      if (!upstream.ok) return new Response('not found', { status: 404, headers: HEADERS });
      return new Response(upstream.body, { status: 200, headers: { ...HEADERS, 'Content-Type': file.type, 'Content-Length': String(size) } });
    } catch {
      return new Response('not found', { status: 404, headers: HEADERS }); // not installed: the library will download it instead
    }
  });
  log.info('speech models are served locally', { dir });
}
