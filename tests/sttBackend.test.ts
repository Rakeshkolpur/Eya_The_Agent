import { describe, it, expect } from 'vitest';
import { chooseBackend, GPU_MIN_SPEEDUP } from '../src/renderer/sttBackend';

describe('chooseBackend', () => {
  it('switches to the graphics chip only when it is clearly faster', () => {
    expect(chooseBackend(1800, 300)).toBe('webgpu');
    expect(chooseBackend(1000, 1000 / GPU_MIN_SPEEDUP)).toBe('webgpu'); // exactly the bar
  });

  it('stays on the processor when the gain is marginal or the chip is slower', () => {
    expect(chooseBackend(1000, 900)).toBe('wasm');
    expect(chooseBackend(1000, 1000)).toBe('wasm');
    expect(chooseBackend(500, 2000)).toBe('wasm');
  });

  it('stays on the processor if a timing is nonsense', () => {
    expect(chooseBackend(Number.NaN, 300)).toBe('wasm');
    expect(chooseBackend(1000, 0)).toBe('wasm');
    expect(chooseBackend(1000, Number.POSITIVE_INFINITY)).toBe('wasm');
  });
});
