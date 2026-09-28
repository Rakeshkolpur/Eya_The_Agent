import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));

import { RendererTTSBridge } from '../src/main/providers/tts/RendererTTSBridge';
import { ipcMain } from 'electron';
import { IpcChannels } from '../src/shared/ipcContract';

interface Sent {
  channel: string;
  payload: unknown;
}

function fakeSender(sent: Sent[]) {
  return { send: (channel: string, payload?: unknown) => sent.push({ channel, payload }) } as unknown as Electron.WebContents;
}

describe('RendererTTSBridge', () => {
  it('serializes overlapping speak() calls — only one in flight at a time', async () => {
    const sent: Sent[] = [];
    const sender = fakeSender(sent);
    const bridge = new RendererTTSBridge(() => sender);
    await bridge.init();

    const p1 = bridge.speak('first line');
    const p2 = bridge.speak('second line');

    // Only the first utterance should have been dispatched so far.
    expect(sent).toHaveLength(1);
    const firstId = (sent[0]?.payload as { utteranceId: string }).utteranceId;

    // Simulate the renderer finishing the first utterance.
    const doneListener = vi.mocked(ipcMain.on).mock.calls.find(
      (c) => c[0] === IpcChannels.ttsDone,
    )?.[1] as ((e: unknown, id: string) => void) | undefined;
    expect(doneListener).toBeDefined();
    doneListener?.({}, firstId);

    await p1;
    // Second utterance should now have been dispatched.
    expect(sent).toHaveLength(2);
    const secondId = (sent[1]?.payload as { utteranceId: string }).utteranceId;
    expect(secondId).not.toBe(firstId);

    doneListener?.({}, secondId);
    await p2;
  });

  it('advances the queue even if a done ack never arrives (timeout path)', async () => {
    const sent: Sent[] = [];
    // Tiny real timeout so the test doesn't need to wait 15s or fight with
    // fake-timer/promise-microtask interleaving.
    const bridge = new RendererTTSBridge(() => fakeSender(sent), 30);
    await bridge.init();

    const p1 = bridge.speak('stuck utterance');
    const p2 = bridge.speak('next utterance');
    expect(sent).toHaveLength(1);

    await p1; // resolves once the 30ms timeout fires
    expect(sent).toHaveLength(2);

    const doneListener = vi.mocked(ipcMain.on).mock.calls.find(
      (c) => c[0] === IpcChannels.ttsDone,
    )?.[1] as ((e: unknown, id: string) => void) | undefined;
    const secondId = (sent[1]?.payload as { utteranceId: string }).utteranceId;
    doneListener?.({}, secondId);
    await p2;
  });
});
