import { env } from '@huggingface/transformers';
import { runtimeFiles } from './ortRuntimePaths';
// The two files of the WebAssembly runtime the speech engines run on. Vite copies them into the build and gives their addresses. (They are
// imported by path because the package does not list them in its "exports".)
import loaderUrl from '../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs?url';
import wasmUrl from '../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm?url';

/**
 * Makes the speech engine load its WebAssembly runtime from Eya's own files. Left alone, the library fetches that runtime from a public CDN
 * every time, so an installed Eya with no internet had no speech recognition at all (the model was local; the engine to run it was not).
 * Call before the first model is created, from inside the worker.
 */
export function useBundledRuntime(): void {
  const wasm = env.backends.onnx.wasm;
  if (wasm !== undefined) wasm.wasmPaths = runtimeFiles(loaderUrl, wasmUrl, self.location.href);
}
