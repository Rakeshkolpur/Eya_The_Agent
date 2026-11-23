import { describe, it, expect } from 'vitest';
import { runtimeFiles } from '../src/renderer/ortRuntimePaths';

describe("the speech runtime's own files", () => {
  const worker = 'eya-app://app/assets/sttWorker-AbC123.js';

  it('are found beside the worker when the build wrote them as relative names', () => {
    const files = runtimeFiles('./ort-wasm-simd-threaded.jsep-X1.mjs', './ort-wasm-simd-threaded.jsep-Y2.wasm', worker);
    expect(files.mjs).toBe('eya-app://app/assets/ort-wasm-simd-threaded.jsep-X1.mjs');
    expect(files.wasm).toBe('eya-app://app/assets/ort-wasm-simd-threaded.jsep-Y2.wasm');
  });

  it('are found from the site root when the build wrote them as rooted paths (the development server does)', () => {
    const files = runtimeFiles('/@fs/C:/app/node_modules/x/ort.jsep.mjs', '/assets/ort.jsep.wasm', 'http://localhost:5173/src/sttWorker.ts');
    expect(files.mjs).toBe('http://localhost:5173/@fs/C:/app/node_modules/x/ort.jsep.mjs');
    expect(files.wasm).toBe('http://localhost:5173/assets/ort.jsep.wasm');
  });

  it('never point at the internet when given Eya\'s own page as the base', () => {
    const files = runtimeFiles('./a.mjs', './a.wasm', worker);
    for (const url of Object.values(files)) expect(url.startsWith('eya-app://app/')).toBe(true);
  });
});
