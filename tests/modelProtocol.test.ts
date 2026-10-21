import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'C:\\app' }, net: { fetch: vi.fn() }, protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() } }));

import { join } from 'node:path';
import { MODEL_SCHEME, resolveModelFile } from '../src/main/models/modelProtocol';

const DIR = 'C:\\Program Files\\Eya\\resources\\models';

describe('which file a model request means', () => {
  it('finds a plain model file inside the models folder', () => {
    expect(resolveModelFile(DIR, '/onnx-community/whisper-tiny.en/onnx/encoder_model.onnx')).toEqual({
      path: join(DIR, 'onnx-community', 'whisper-tiny.en', 'onnx', 'encoder_model.onnx'),
      type: 'application/octet-stream',
    });
    expect(resolveModelFile(DIR, '/onnx-community/whisper-tiny.en/config.json')?.type).toBe('application/json');
    expect(resolveModelFile(DIR, '/a/tokens.txt')?.type).toBe('text/plain');
    expect(resolveModelFile(DIR, '/a%20b/c.json')?.path).toBe(join(DIR, 'a b', 'c.json'));
  });

  it('refuses anything that leaves the models folder, however it is written', () => {
    for (const bad of [
      '/../secret.json',
      '/..%2f..%2fWindows%2fwin.ini.json',
      '/%2e%2e/%2e%2e/x.json',
      '/a/../../x.json',
      '/..\\..\\x.json',
      '/C:/Windows/win.ini.json',
      '/C:\\Windows\\x.json',
      '/.',
      '/',
      '',
      '/a\0b.json',
      '/%00.json',
      '/%E0%A4%A.json', // not valid percent-encoding
    ]) {
      expect(resolveModelFile(DIR, bad), bad).toBeNull();
    }
  });

  it('treats extra leading slashes as part of a path inside the folder, never as a network path', () => {
    expect(resolveModelFile(DIR, '//server/share/x.json')?.path).toBe(join(DIR, 'server', 'share', 'x.json'));
  });

  it('serves only model-shaped files, never a program or a script', () => {
    for (const bad of ['/a/run.exe', '/a/x.dll', '/a/x.js', '/a/x.html', '/a/x.ps1', '/a/noextension', '/a/x.json.exe']) {
      expect(resolveModelFile(DIR, bad), bad).toBeNull();
    }
  });

  it('has its own address scheme', () => {
    expect(MODEL_SCHEME).toBe('eya-models');
  });
});
