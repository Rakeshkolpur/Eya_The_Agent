import { describe, it, expect } from 'vitest';
import { LocalStt } from '../src/renderer/localStt';
import type { SttState, SttWorkerLike } from '../src/renderer/localStt';
import type { SttRequest, SttResponse } from '../src/renderer/sttWorker';

class FakeWorker implements SttWorkerLike {
  onmessage: ((event: MessageEvent<SttResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: SttRequest[] = [];
  postMessage(message: SttRequest): void {
    this.sent.push(message);
  }
  reply(message: SttResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<SttResponse>);
  }
  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
  get transcribes(): Array<Extract<SttRequest, { type: 'transcribe' }>> {
    return this.sent.filter((m): m is Extract<SttRequest, { type: 'transcribe' }> => m.type === 'transcribe');
  }
}

function ready(opts?: { transcribeTimeoutMs: number }) {
  const worker = new FakeWorker();
  const stt = new LocalStt(() => worker, opts);
  stt.start();
  worker.reply({ type: 'ready', loadMs: 100, threads: 3, backend: 'wasm' });
  return { worker, stt };
}

const audio = () => new Float32Array([0.1, 0.2, 0.3]);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LocalStt lifecycle', () => {
  it('loads in the background and reports its state and download progress', () => {
    const worker = new FakeWorker();
    const stt = new LocalStt(() => worker);
    const seen: Array<[SttState, string | undefined]> = [];
    stt.onState((s, d) => seen.push([s, d]));

    expect(stt.state).toBe('idle');
    stt.start();
    expect(stt.state).toBe('loading');
    expect(worker.sent).toEqual([{ type: 'init' }]);

    worker.reply({ type: 'progress', percent: 35 });
    worker.reply({ type: 'ready', loadMs: 2000, threads: 3, backend: 'wasm' });
    expect(stt.state).toBe('ready');
    expect(seen.map(([s]) => s)).toEqual(['loading', 'loading', 'ready']);
    expect(seen[1]?.[1]).toBe('downloading speech model 35%');
  });

  it('reports when the graphics chip takes over, and when it gives up and the processor resumes', () => {
    const { worker, stt } = ready();
    const details: Array<string | undefined> = [];
    stt.onState((_s, d) => details.push(d));
    expect(stt.backend).toBe('wasm');

    worker.reply({ type: 'ready', loadMs: 4000, threads: 3, backend: 'webgpu', note: 'graphics chip 300ms vs processor 1800ms' });
    expect(stt.state).toBe('ready');
    expect(stt.backend).toBe('webgpu');
    expect(details[0]).toContain('graphics chip');
    expect(details[0]).toContain('300ms vs processor 1800ms');

    worker.reply({ type: 'ready', loadMs: 0, threads: 3, backend: 'wasm', note: 'graphics chip failed, back to the processor: device lost' });
    expect(stt.backend).toBe('wasm');
    expect(details[1]).toContain('device lost');
  });

  it('starting twice does not start a second worker', () => {
    let made = 0;
    const stt = new LocalStt(() => {
      made += 1;
      return new FakeWorker();
    });
    stt.start();
    stt.start();
    expect(made).toBe(1);
  });

  it('is failed, not stuck loading, if the model cannot load', () => {
    const worker = new FakeWorker();
    const stt = new LocalStt(() => worker);
    stt.start();
    worker.reply({ type: 'init-failed', error: 'offline' });
    expect(stt.state).toBe('failed');
  });

  it('is failed if the worker cannot even be created', () => {
    const stt = new LocalStt(() => {
      throw new Error('no workers here');
    });
    stt.start();
    expect(stt.state).toBe('failed');
  });
});

describe('LocalStt.transcribe', () => {
  it('says "not available" instead of waiting while the model is still loading', async () => {
    const worker = new FakeWorker();
    const stt = new LocalStt(() => worker);
    stt.start();
    expect(await stt.transcribe(audio())).toBeNull();
    expect(worker.transcribes).toHaveLength(0);
  });

  it('returns cleaned text for a finished transcription', async () => {
    const { worker, stt } = ready();
    const pending = stt.transcribe(audio());
    await tick();
    const request = worker.transcribes[0];
    expect(request).toBeDefined();
    worker.reply({ type: 'result', id: request?.id ?? -1, text: ' Open Notepad.', ms: 300 });
    expect(await pending).toBe('Open Notepad.');
  });

  it('returns an empty string for silence and invented sign-offs', async () => {
    const { worker, stt } = ready();
    const pending = stt.transcribe(audio());
    await tick();
    worker.reply({ type: 'result', id: worker.transcribes[0]?.id ?? -1, text: ' Thank you.', ms: 300 });
    expect(await pending).toBe('');
  });

  it('gives the worker a copy, so the caller keeps its samples for a fallback', async () => {
    const { worker, stt } = ready();
    const samples = audio();
    void stt.transcribe(samples);
    await tick();
    expect(samples.length).toBe(3); // not detached by the transfer
    expect(worker.transcribes[0]?.samples).not.toBe(samples);
  });

  it('returns null (fall back) when the worker reports an error for that clip', async () => {
    const { worker, stt } = ready();
    const pending = stt.transcribe(audio());
    await tick();
    worker.reply({ type: 'result', id: worker.transcribes[0]?.id ?? -1, text: '', ms: 5, error: 'boom' });
    expect(await pending).toBeNull();
  });

  it('gives up on a transcription that never comes back, without hanging the command', async () => {
    const { stt } = ready({ transcribeTimeoutMs: 30 });
    expect(await stt.transcribe(audio())).toBeNull();
  });

  it('ignores a result that arrives after it timed out', async () => {
    const { worker, stt } = ready({ transcribeTimeoutMs: 20 });
    const pending = stt.transcribe(audio());
    await tick();
    const id = worker.transcribes[0]?.id ?? -1;
    expect(await pending).toBeNull();
    worker.reply({ type: 'result', id, text: 'too late', ms: 1 }); // must not throw
    expect(stt.state).toBe('ready');
  });

  it('handles one clip at a time, in order', async () => {
    const { worker, stt } = ready();
    const first = stt.transcribe(audio());
    const second = stt.transcribe(audio());
    await tick();
    expect(worker.transcribes).toHaveLength(1); // second waits for the first
    worker.reply({ type: 'result', id: worker.transcribes[0]?.id ?? -1, text: 'one', ms: 1 });
    expect(await first).toBe('one');
    await tick();
    expect(worker.transcribes).toHaveLength(2);
    worker.reply({ type: 'result', id: worker.transcribes[1]?.id ?? -1, text: 'two', ms: 1 });
    expect(await second).toBe('two');
  });

  it('a crash releases everything waiting and turns local recognition off', async () => {
    const { worker, stt } = ready();
    const pending = stt.transcribe(audio());
    await tick();
    worker.crash('out of memory');
    expect(await pending).toBeNull();
    expect(stt.state).toBe('failed');
    expect(await stt.transcribe(audio())).toBeNull();
  });
});
