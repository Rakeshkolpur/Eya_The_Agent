export type SttBackend = 'wasm' | 'webgpu';

/** The graphics chip must be clearly faster, not just marginally, to be worth the switch. */
export const GPU_MIN_SPEEDUP = 1.25;

/** Picks the backend from how long the same audio took on each (milliseconds). */
export function chooseBackend(cpuMs: number, gpuMs: number): SttBackend {
  if (!Number.isFinite(cpuMs) || !Number.isFinite(gpuMs) || gpuMs <= 0) return 'wasm';
  return cpuMs / gpuMs >= GPU_MIN_SPEEDUP ? 'webgpu' : 'wasm';
}
