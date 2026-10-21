import { describe, it, expect, vi } from 'vitest';

const { fetchMock, handleMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), handleMock: vi.fn() }));
vi.mock('electron', () => ({ net: { fetch: fetchMock }, protocol: { handle: handleMock, registerSchemesAsPrivileged: vi.fn() } }));

import { join } from 'node:path';
import { APP_SCHEME, APP_URL, appRoot, handleAppProtocol, resolveAppFile } from '../src/main/windows/appProtocol';

const ROOT = 'C:\\Program Files\\Eya\\resources\\app.asar\\out\\renderer';

describe('which file the page asks for', () => {
  it('serves the built page and its assets with the right type', () => {
    expect(resolveAppFile(ROOT, '/index.html')).toEqual({ path: join(ROOT, 'index.html'), type: 'text/html; charset=utf-8' });
    expect(resolveAppFile(ROOT, '/')?.path).toBe(join(ROOT, 'index.html')); // the bare address is the page
    expect(resolveAppFile(ROOT, '/assets/orb-abc123.js')?.type).toBe('text/javascript; charset=utf-8');
    expect(resolveAppFile(ROOT, '/assets/sttWorker-xyz.js')?.path).toBe(join(ROOT, 'assets', 'sttWorker-xyz.js'));
    expect(resolveAppFile(ROOT, '/assets/orb.css')?.type).toBe('text/css; charset=utf-8');
  });

  it('serves WebAssembly as application/wasm (the browser refuses to compile it as anything else)', () => {
    expect(resolveAppFile(ROOT, '/assets/ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm')?.type).toBe('application/wasm');
  });

  it('refuses anything outside the page folder, however it is written', () => {
    for (const bad of [
      '/../main/index.js',
      '/..%2fmain%2findex.js',
      '/%2e%2e/%2e%2e/secret.json',
      '/assets/../../preload/index.js',
      '/..\\..\\x.js',
      '/C:/Windows/system32/x.js',
      '/C:\\Windows\\x.js',
      '/a\0.js',
      '/%00.js',
      '/%E0%A4%A.js',
    ]) {
      expect(resolveAppFile(ROOT, bad), bad).toBeNull();
    }
  });

  it('serves only web files, never a program, a script host file or an unknown type', () => {
    for (const bad of ['/a.exe', '/a.dll', '/a.ps1', '/a.bat', '/a.node', '/a.map', '/noextension', '/a.js.exe']) {
      expect(resolveAppFile(ROOT, bad), bad).toBeNull();
    }
  });

  it('knows where the built page is relative to the main process', () => {
    expect(appRoot(join('C:', 'app', 'out', 'main'))).toBe(join('C:', 'app', 'out', 'renderer'));
    expect(APP_URL).toBe('eya-app://app/index.html');
    expect(APP_SCHEME).toBe('eya-app');
  });
});

describe('what the served files come with', () => {
  async function serve(path: string): Promise<Response> {
    fetchMock.mockResolvedValue(new Response('body', { status: 200 }));
    handleMock.mockClear();
    handleAppProtocol('C:\app\out\renderer');
    const handler = handleMock.mock.calls[0]?.[1] as (request: { url: string }) => Promise<Response>;
    return handler({ url: `eya-app://app${path}` });
  }

  it('the right type for each file, and the isolation headers once each (a worker script needs them too)', async () => {
    const wasm = await serve('/assets/ort.wasm');
    expect(wasm.status).toBe(200);
    expect(wasm.headers.get('content-type')).toBe('application/wasm');
    // Once each, as single values (not "same-origin, same-origin", which the browser reads as invalid and so switches isolation off).
    expect(wasm.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(wasm.headers.get('cross-origin-embedder-policy')).toBe('credentialless');
    expect(wasm.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });

  it('says "not found" for anything it will not serve', async () => {
    // (a plain "/../" never arrives: the address parser removes it first; an encoded backslash does reach the check)
    expect((await serve('/..%5c..%5cmain%5cindex.js')).status).toBe(404);
    expect((await serve('/..%2f..%2fmain%2findex.js')).status).toBe(404);
    expect((await serve('/run.exe')).status).toBe(404);
    fetchMock.mockResolvedValue(new Response('no', { status: 404 }));
    handleMock.mockClear();
    handleAppProtocol('C:\app\out\renderer');
    const handler = handleMock.mock.calls[0]?.[1] as (request: { url: string }) => Promise<Response>;
    expect((await handler({ url: 'eya-app://app/missing.js' })).status).toBe(404);
  });
});
