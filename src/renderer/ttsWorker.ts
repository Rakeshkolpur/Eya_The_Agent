import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';

// Runs Kokoro off the UI thread. Generating a sentence takes seconds of pure
// CPU; on the page's own thread that froze the whole app (and delayed every
// IPC message, including the reply it was generating).

export type TtsWorkerRequest =
  | { readonly type: 'init' }
  | { readonly type: 'generate'; readonly id: number; readonly text: string };

export type TtsWorkerResponse =
  | { readonly type: 'ready'; readonly threads: number; readonly loadMs: number }
  | { readonly type: 'init-failed'; readonly error: string }
  | { readonly type: 'result'; readonly id: number; readonly wav?: ArrayBuffer; readonly ms: number; readonly error?: string };

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

const scope = self as unknown as {
  postMessage(message: TtsWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<TtsWorkerRequest>) => void) | null;
  crossOriginIsolated: boolean;
};

let engine: KokoroTTS | null = null;

async function init(): Promise<void> {
  const started = performance.now();
  // Multi-threaded WebAssembly needs SharedArrayBuffer, which the browser only
  // allows on a cross-origin-isolated page. Fall back to one thread otherwise.
  const threads = scope.crossOriginIsolated
    ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))
    : 1;
  const wasm = env.backends.onnx.wasm;
  if (wasm !== undefined) wasm.numThreads = threads;
  try {
    engine = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm' });
    scope.postMessage({ type: 'ready', threads, loadMs: Math.round(performance.now() - started) });
  } catch (err) {
    scope.postMessage({ type: 'init-failed', error: err instanceof Error ? err.message : String(err) });
  }
}

async function generate(id: number, text: string): Promise<void> {
  if (engine === null) {
    scope.postMessage({ type: 'result', id, ms: 0, error: 'engine not ready' });
    return;
  }
  const started = performance.now();
  try {
    const audio = await engine.generate(text, { voice: 'af_heart', speed: 1 });
    const wav = audio.toWav();
    scope.postMessage({ type: 'result', id, wav, ms: Math.round(performance.now() - started) }, [wav]);
  } catch (err) {
    scope.postMessage({
      type: 'result',
      id,
      ms: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

scope.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'init') void init();
  else void generate(msg.id, msg.text);
};
