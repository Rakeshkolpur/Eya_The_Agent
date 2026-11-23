/**
 * Live test of the Windows controls against REAL Windows and a REAL Notepad window created (and closed) by the test:
 * list it, minimise, maximise, restore, switch to it, close it — each time checking the window's real state independently
 * of what the tool said. It moves a window on your screen for a few seconds.
 *
 * Opt-in: EYA_LIVE_WINDOWS=1 npx vitest run tests/live/windows.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWindowTools } from '../../src/main/tools/impl/windowTools';
import { createWindowControl } from '../../src/main/windowsApi/windowControl';
import type { WindowInfo } from '../../src/main/windowsApi/windowControl';

const live = process.env['EYA_LIVE_WINDOWS'] === '1';

describe.skipIf(!live || process.platform !== 'win32')('Windows controls: a real Notepad window', () => {
  const control = createWindowControl();
  const token = `eya_win_live_${process.pid}`;
  let dir = '';
  let notepad: ChildProcess;
  let handle = 0;
  let pid = 0;
  const [listTool, controlTool] = createWindowTools({ control, ownPids: () => [] }) as [ReturnType<typeof createWindowTools>[0], ReturnType<typeof createWindowTools>[1]];

  const mine = async (): Promise<WindowInfo | null> => (await control.list()).find((w) => w.title.includes(token)) ?? null;
  const state = async (): Promise<string> => (await control.info(handle))?.state ?? 'gone';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'eya-win-live-'));
    const file = join(dir, `${token}.txt`);
    writeFileSync(file, 'window control test\n');
    notepad = spawn('notepad.exe', [file], { stdio: 'ignore' });
    for (let i = 0; i < 60; i++) {
      const w = await mine();
      if (w !== null) {
        handle = w.handle;
        pid = w.pid;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (handle === 0) throw new Error('the test Notepad window never appeared');
  }, 60_000);

  afterAll(() => {
    try {
      notepad?.kill();
    } catch {
      // already closed by the test
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the real window, with its real application, state and size', async () => {
    const r = await listTool.execute({});
    expect(r.ok).toBe(true);
    const found = (r.data?.['windows'] as Array<{ app: string; title: string; state: string }>).find((w) => w.title.includes(token));
    expect(found).toMatchObject({ app: 'Notepad', state: expect.stringMatching(/normal|maximized/) });
    const real = await control.info(handle);
    expect(real?.process.toLowerCase()).toBe('notepad');
    expect(real?.pid).toBe(pid);
    expect(real?.width).toBeGreaterThan(200);
    expect(real?.height).toBeGreaterThan(100);
  }, 30_000);

  it('minimises it — and Windows really reports it minimised', async () => {
    const r = await controlTool.execute({ action: 'minimize', window: token });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, data: { stateAfter: 'minimized', verified: true } });
    expect(await state()).toBe('minimized');
  }, 30_000);

  it('restores it, then maximises it, then restores it again', async () => {
    const restored = await controlTool.execute({ action: 'restore', window: token });
    expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true, data: { verified: true } });
    expect(['normal', 'maximized']).toContain(await state());

    const maximized = await controlTool.execute({ action: 'maximize', window: token });
    expect(maximized, JSON.stringify(maximized)).toMatchObject({ ok: true, data: { stateAfter: 'maximized', verified: true } });
    expect(await state()).toBe('maximized');

    const back = await controlTool.execute({ action: 'restore', window: token });
    expect(back, JSON.stringify(back)).toMatchObject({ ok: true, data: { stateAfter: 'normal', verified: true } });
    expect(await state()).toBe('normal');
  }, 60_000);

  it('does nothing, and says so, when it is already so', async () => {
    const again = await controlTool.execute({ action: 'restore', window: token });
    expect(again).toMatchObject({ ok: true, data: { alreadyThere: true } });
  }, 30_000);

  it('switches to a minimised window: it comes back AND comes to the front', async () => {
    await controlTool.execute({ action: 'minimize', window: token });
    expect(await state()).toBe('minimized');
    const r = await controlTool.execute({ action: 'focus', window: token });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, summary: 'Switched to Notepad', data: { verified: true } });
    const real = await control.info(handle);
    expect(real?.state).not.toBe('minimized');
    expect(real?.foreground).toBe(true); // checked independently of the tool
  }, 60_000);

  it('says "not open" for something that is not, listing only application names', async () => {
    const r = await controlTool.execute({ action: 'minimize', window: 'zz-no-such-app-zz' });
    expect(r).toMatchObject({ ok: false, summary: 'not open' });
    expect(r.data?.['openApps']).toContain('Notepad');
    expect(JSON.stringify(r)).not.toContain(token); // titles are not listed
  }, 30_000);

  it('never touches a window it was told is its own', async () => {
    const [, guarded] = createWindowTools({ control, ownPids: () => [pid] });
    const r = await (guarded as NonNullable<typeof guarded>).execute({ action: 'close', window: token });
    expect(r.ok).toBe(false);
    expect(await state()).not.toBe('gone');
  }, 30_000);

  it('closes it politely — and it is really gone', async () => {
    const r = await controlTool.execute({ action: 'close', window: token });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, summary: 'Closed Notepad', data: { stateAfter: 'closed', verified: true } });
    expect(await control.info(handle)).toBeNull();
    expect(await mine()).toBeNull();
  }, 30_000);
});
