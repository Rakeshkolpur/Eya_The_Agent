import { env, pipeline } from '@huggingface/transformers';
import { chooseBackend } from './sttBackend';
import type { SttBackend } from './sttBackend';

// On-device speech recognition. Runs in a worker: transcribing is seconds of
// CPU, and on the page's own thread it would freeze the app while you talk.
//
// It starts on the CPU (small cached download, ready in ~1.5 s) and then, in the
// background, tries to move the heavy part (the encoder) onto the GPU. It only
// switches if the GPU is measurably faster on this machine.

export type SttRequest =
  | { readonly type: 'init'; readonly backend?: 'auto' | SttBackend }
  | { readonly type: 'transcribe'; readonly id: number; readonly samples: Float32Array };

export type SttResponse =
  | { readonly type: 'progress'; readonly percent: number }
  | { readonly type: 'ready'; readonly loadMs: number; readonly threads: number; readonly backend: SttBackend; readonly note?: string }
  | { readonly type: 'init-failed'; readonly error: string }
  | { readonly type: 'result'; readonly id: number; readonly text: string; readonly ms: number; readonly backend?: SttBackend; readonly error?: string };

// English-only "tiny". CPU: int8 weights, ~43 MB. GPU: the encoder in full
// precision (~33 MB more; this chip has no 16-bit shader support, so the smaller
// fp16 files cannot run) with the same int8 decoder, which is cheap on the CPU
// for a short command.
const MODEL = 'onnx-community/whisper-tiny.en';

const scope = self as unknown as {
  postMessage(message: SttResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<SttRequest>) => void) | null;
  crossOriginIsolated: boolean;
};

type Transcriber = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<{ text: string } | { text: string }[]>;

let cpu: Transcriber | null = null;
let gpu: Transcriber | null = null;
let threads = 1;
let started = 0;

/** All model runs go one at a time, including the background timing runs. */
let queue: Promise<unknown> = Promise.resolve();
function inQueue<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}

function progressReporter(): (info: { status?: string; progress?: number }) => void {
  let lastPercent = -1;
  return (info) => {
    if (info.status !== 'progress' || typeof info.progress !== 'number') return;
    const percent = Math.round(info.progress / 5) * 5; // every 5%
    if (percent !== lastPercent) {
      lastPercent = percent;
      scope.postMessage({ type: 'progress', percent });
    }
  };
}

async function loadCpu(): Promise<Transcriber> {
  const built = await pipeline('automatic-speech-recognition', MODEL, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: progressReporter(),
  });
  return built as unknown as Transcriber;
}

async function loadGpu(): Promise<Transcriber> {
  const built = await pipeline('automatic-speech-recognition', MODEL, {
    device: { encoder_model: 'webgpu', decoder_model_merged: 'wasm' },
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
    progress_callback: progressReporter(),
  });
  return built as unknown as Transcriber;
}

async function gpuAvailable(): Promise<boolean> {
  try {
    const nav = navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } };
    return nav.gpu !== undefined && (await nav.gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

/** Noise shaped a little like speech: enough for the model to do real work. Deterministic. */
function benchmarkAudio(): Float32Array {
  const out = new Float32Array(16_000 * 3);
  let seed = 12345;
  for (let i = 0; i < out.length; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = (seed / 0xffffffff - 0.5) * 0.05;
    const voice = Math.sin(i / 16_000 * 2 * Math.PI * 180) * 0.1 * (0.5 + 0.5 * Math.sin(i / 16_000 * 2 * Math.PI * 3));
    out[i] = noise + voice;
  }
  return out;
}

async function timeRun(model: Transcriber, audio: Float32Array): Promise<number> {
  const t0 = performance.now();
  await model(audio, { return_timestamps: false });
  return performance.now() - t0;
}

async function init(requested: 'auto' | SttBackend): Promise<void> {
  started = performance.now();
  env.allowLocalModels = false; // never probe the dev server for a local copy
  // Multi-threaded WebAssembly needs cross-origin isolation; fall back to one thread.
  threads = scope.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  const wasm = env.backends.onnx.wasm;
  if (wasm !== undefined) wasm.numThreads = threads;

  try {
    cpu = await loadCpu();
  } catch (err) {
    scope.postMessage({ type: 'init-failed', error: err instanceof Error ? err.message : String(err) });
    return;
  }
  scope.postMessage({ type: 'ready', loadMs: Math.round(performance.now() - started), threads, backend: 'wasm' });

  if (requested === 'wasm') return;
  void upgradeToGpu(requested === 'webgpu');
}

/** Best effort and silent on failure: the CPU model keeps working either way. */
async function upgradeToGpu(force: boolean): Promise<void> {
  const cpuModel = cpu;
  if (cpuModel === null) return;
  try {
    if (!(await gpuAvailable())) return;
    const gpuStarted = performance.now();
    const gpuModel = await loadGpu();
    const audio = benchmarkAudio();
    // The first GPU run compiles shaders, so it isn't timed. After that, alternate
    // the two and compare their best runs: the machine is often busy right after
    // launch, and busyness only ever makes a run slower, never faster.
    await inQueue(() => gpuModel(audio, { return_timestamps: false }));
    const gpuRuns: number[] = [];
    const cpuRuns: number[] = [];
    for (let round = 0; round < 2; round += 1) {
      gpuRuns.push(await inQueue(() => timeRun(gpuModel, audio)));
      cpuRuns.push(await inQueue(() => timeRun(cpuModel, audio)));
    }
    const gpuMs = Math.min(...gpuRuns);
    const cpuMs = Math.min(...cpuRuns);
    const winner = force ? 'webgpu' : chooseBackend(cpuMs, gpuMs);
    const note = `graphics chip ${Math.round(gpuMs)}ms vs processor ${Math.round(cpuMs)}ms`;
    if (winner === 'webgpu') {
      gpu = gpuModel;
      scope.postMessage({
        type: 'ready',
        loadMs: Math.round(performance.now() - gpuStarted),
        threads,
        backend: 'webgpu',
        note,
      });
    } else {
      scope.postMessage({ type: 'ready', loadMs: 0, threads, backend: 'wasm', note: `kept processor: ${note}` });
    }
  } catch (err) {
    scope.postMessage({
      type: 'ready',
      loadMs: 0,
      threads,
      backend: 'wasm',
      note: `graphics chip unavailable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function run(model: Transcriber, samples: Float32Array): Promise<string> {
  const out = await model(samples, { return_timestamps: false }); // English-only models reject language/task options
  return (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim();
}

async function transcribe(id: number, samples: Float32Array): Promise<void> {
  const t0 = performance.now();
  const elapsed = (): number => Math.round(performance.now() - t0);
  try {
    if (cpu === null) {
      scope.postMessage({ type: 'result', id, text: '', ms: 0, error: 'not ready' });
      return;
    }
    if (gpu !== null) {
      try {
        const text = await run(gpu, samples);
        scope.postMessage({ type: 'result', id, text, ms: elapsed(), backend: 'webgpu' });
        return;
      } catch (err) {
        // A lost GPU device or driver hiccup: stop using it and answer on the processor.
        gpu = null;
        scope.postMessage({
          type: 'ready',
          loadMs: 0,
          threads,
          backend: 'wasm',
          note: `graphics chip failed, back to the processor: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    const text = await run(cpu, samples);
    scope.postMessage({ type: 'result', id, text, ms: elapsed(), backend: 'wasm' });
  } catch (err) {
    scope.postMessage({ type: 'result', id, text: '', ms: elapsed(), error: err instanceof Error ? err.message : String(err) });
  }
}

scope.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'init') void init(msg.backend ?? 'auto');
  else void inQueue(() => transcribe(msg.id, msg.samples));
};
