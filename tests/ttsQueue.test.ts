import { describe, it, expect } from 'vitest';
import { GenerationQueue } from '../src/renderer/ttsQueue';

function wav(tag: string): ArrayBuffer {
  return new TextEncoder().encode(tag).buffer as ArrayBuffer;
}

function harness() {
  const started: string[] = [];
  const finishers = new Map<string, () => void>();
  const queue = new GenerationQueue(
    (text) =>
      new Promise((resolve) => {
        started.push(text);
        finishers.set(text, () => resolve(wav(text)));
      }),
  );
  return { queue, started, finish: (text: string) => finishers.get(text)?.() };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('GenerationQueue', () => {
  it('holds jobs until the engine is ready', async () => {
    const { queue, started } = harness();
    void queue.enqueue('a', 'high');
    await tick();
    expect(started).toEqual([]);
    queue.setReady(true);
    await tick();
    expect(started).toEqual(['a']);
  });

  it('runs one job at a time', async () => {
    const { queue, started, finish } = harness();
    queue.setReady(true);
    const a = queue.enqueue('a', 'low');
    void queue.enqueue('b', 'low');
    await tick();
    expect(started).toEqual(['a']);
    finish('a');
    await a;
    await tick();
    expect(started).toEqual(['a', 'b']);
  });

  it('lets an urgent reply jump ahead of background pre-generation', async () => {
    const { queue, started, finish } = harness();
    queue.setReady(true);
    void queue.enqueue('warm1', 'low'); // starts immediately
    void queue.enqueue('warm2', 'low');
    void queue.enqueue('warm3', 'low');
    await tick();
    const urgent = queue.enqueue('reply', 'high');
    finish('warm1');
    await tick();
    expect(started).toEqual(['warm1', 'reply']);
    finish('reply');
    expect((await urgent)?.byteLength).toBe(5);
  });

  it('bump promotes an already-queued phrase', async () => {
    const { queue, started, finish } = harness();
    queue.setReady(true);
    void queue.enqueue('first', 'low');
    void queue.enqueue('second', 'low');
    void queue.enqueue('wanted', 'low');
    await tick();
    queue.bump('wanted');
    finish('first');
    await tick();
    expect(started).toEqual(['first', 'wanted']);
  });

  it('a failed job resolves null and does not stall the queue', async () => {
    const queue = new GenerationQueue(async (text) => {
      if (text === 'bad') throw new Error('boom');
      return wav(text);
    });
    queue.setReady(true);
    const bad = queue.enqueue('bad', 'high');
    const good = queue.enqueue('good', 'low');
    expect(await bad).toBeNull();
    expect((await good)?.byteLength).toBe(4);
  });

  it('failAll releases everything waiting with no audio', async () => {
    const { queue } = harness();
    const a = queue.enqueue('a', 'low');
    const b = queue.enqueue('b', 'low');
    queue.failAll();
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    expect(queue.queued).toBe(0);
  });
});
