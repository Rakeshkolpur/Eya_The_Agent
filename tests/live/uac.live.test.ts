/**
 * Windows' REAL permission box, once, with something that cannot change anything: the PC is asked to be renamed to the name it ALREADY has.
 *
 * Opt-in: EYA_LIVE_UAC=1 npx vitest run tests/live/uac.live.test.ts
 * A box appears on the screen ("Do you want to allow this app to make changes to your device?" for Windows PowerShell). Answer it: Yes or No, either is fine, because nothing can change.
 *   - while the box is open, Eya must SEE it (this is the moment she tells the person to click Yes);
 *   - a No must come back as "declined", a Yes as "done" or "failed" (Windows may refuse a rename to the same name);
 *   - the PC's name must be exactly the same afterwards.
 * Set EYA_LIVE_UAC_EXPECT=declined or =accepted to make the test check which one you chose.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '.' } }));
import { realPcSystem } from '../../src/main/pc/pcSystem';

const live = process.env['EYA_LIVE_UAC'] === '1' && process.platform === 'win32';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!live)("Windows' real permission box", () => {
  it('is seen while it is open, the answer is read correctly, and the PC name is untouched', async () => {
    const sys = realPcSystem();
    const before = await sys.computerNames();
    expect(await sys.permissionBoxOpen()).toBe(false);
    let looks = 0;
    let seen = 0;
    let firstSeenAfterMs = -1;
    let running = true;
    const started = Date.now();
    const watcher = (async (): Promise<void> => {
      while (running) {
        looks += 1;
        if (await sys.permissionBoxOpen()) {
          seen += 1;
          if (firstSeenAfterMs < 0) firstSeenAfterMs = Date.now() - started;
        }
        await sleep(300);
      }
    })();
    const result = await sys.renameComputer(before.pending);
    running = false;
    await watcher;
    console.log(`[uac] answer: ${JSON.stringify(result)}; the box was seen in ${seen} of ${looks} looks, first after ${firstSeenAfterMs} ms; the answer came after ${Date.now() - started} ms`);
    expect(['done', 'declined', 'failed']).toContain(result.outcome);
    expect(seen).toBeGreaterThan(0);
    const expected = process.env['EYA_LIVE_UAC_EXPECT'];
    if (expected === 'declined') expect(result.outcome).toBe('declined');
    if (expected === 'accepted') expect(['done', 'failed']).toContain(result.outcome);
    expect(await sys.computerNames()).toEqual(before);
    expect(await sys.permissionBoxOpen()).toBe(false);
  }, 6 * 60_000);
});
