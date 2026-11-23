/**
 * Writing Watch in a plain editor, through Windows UI Automation: a real Notepad window with a made-up file, where the keyboard is. Eya
 * reads its text (nothing else on the screen) and finds the slips, but cannot fix them there (she does not edit Notepad).
 *
 * Opt-in (it opens Notepad on this PC):  EYA_LIVE_NOTEPAD=1 npx vitest run tests/live/writingnotepad.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FocusedTextSource, ReaderProcess } from '../../src/main/writing/ReaderProcess';
import { WritingWatch } from '../../src/main/writing/WritingWatch';
import type { WatchState } from '../../src/main/writing/WritingWatch';

const live = process.env['EYA_LIVE_NOTEPAD'] === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!live)('Writing Watch in Notepad', () => {
  let dir = '';
  let notepad: ChildProcess;
  let reader: ReaderProcess;
  let source: FocusedTextSource;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'eya-notepad-live-'));
    const file = join(dir, 'draft.txt');
    writeFileSync(file, 'The Petitioner states that the the order is wrong.\r\n\r\nSecond line here.\r\nThird line is where the cursor is');
    notepad = spawn('notepad.exe', [file], { stdio: 'ignore' });
    await sleep(2500);
    // Put the keyboard in the Notepad window and the cursor at the end of the text.
    execFileSync('powershell.exe', ['-NoProfile', '-Command', "$s = New-Object -ComObject WScript.Shell; [void]$s.AppActivate('draft'); Start-Sleep -Milliseconds 700; $s.SendKeys('^{END}')"]);
    await sleep(800);
    reader = new ReaderProcess(join(dir, 'scripts'));
    source = new FocusedTextSource(reader);
  }, 60_000);

  afterAll(() => {
    reader?.close();
    try {
      execFileSync('taskkill', ['/IM', 'notepad.exe', '/F'], { stdio: 'ignore' });
    } catch {
      // already closed
    }
    notepad?.kill();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('reads the text box that has the keyboard, with the cursor line, and says which program it is', async (ctx) => {
    const doc = await source.read();
    if (doc === null) return ctx.skip(); // Windows would not give Notepad the keyboard from a background test run
    expect(doc).toMatchObject({ app: 'other', program: 'notepad' });
    expect(doc.paragraphs[0]).toBe('The Petitioner states that the the order is wrong.');
    expect(doc.paragraphs).toHaveLength(4);
    expect(doc.active).toBe(4); // the cursor is on the last line
  }, 30_000);

  it('finds the slips on request, and offers no fix there (Eya does not edit Notepad)', async (ctx) => {
    if ((await source.read()) === null) return ctx.skip();
    const states: WatchState[] = [];
    const watch = new WritingWatch({ sources: [source], onChange: (s) => void states.push(s) });
    expect(await watch.checkAll()).toBe(1);
    const last = states[states.length - 1] as WatchState;
    expect(last.source).toBe('Notepad');
    expect(last.findings[0]).toMatchObject({ kind: 'repeated_word', paragraph: 1, canFix: false });
  }, 30_000);

  it('reads nothing when the keyboard is somewhere else (the terminal running this test)', async () => {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', "(New-Object -ComObject WScript.Shell).AppActivate((Get-Process -Id " + String(process.pid) + " -ErrorAction SilentlyContinue).MainWindowTitle) | Out-Null"]);
    await sleep(500);
    // Whatever has the keyboard now, it is not a program on the short list unless it is Notepad itself.
    const doc = await source.read();
    if (doc !== null) expect(doc.program).toBe('notepad');
  }, 30_000);
});
