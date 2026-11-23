/**
 * Notepad against the REAL Notepad: the tool opens a Notepad window of its own, types into it live (special keyboard characters, a new line, a tab, Telugu), saves it, and the saved file is
 * checked. Only the Notepad this test opened is closed (by its process id); anything else is left alone.
 *
 * Opt-in (it opens a window and types into it):  EYA_LIVE_NOTEPAD=1 npx vitest run tests/live/notepad.live.test.ts
 * Windows decides who may take the focus: if it will not give it to Notepad, the tool types NOTHING and says so (that refusal is correct behaviour, and is reported here, not hidden).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotepadTool } from '../../src/main/tools/impl/notepadTools';

const live = process.env['EYA_LIVE_NOTEPAD'] === '1' && process.platform === 'win32';
const ps = (script: string): string => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60_000 }).trim();

describe.skipIf(!live)('Notepad with the real Notepad', () => {
  const home = mkdtempSync(join(tmpdir(), 'eya-notepad-'));
  const folders = { home, desktop: home, documents: home, downloads: home, pictures: home, videos: home, music: home, temp: home };
  const tool = createNotepadTool({ folders });
  const opened: number[] = [];

  afterAll(() => {
    for (const pid of opened) {
      try {
        ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
      } catch {
        // (already gone)
      }
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('types live into a new Notepad and saves the file: the words are exactly what was given', async () => {
    const file = join(home, 'note.txt');
    const text = 'Hello, world! (a test) 100% sure + 2 = 4 ~ ^ [x] {braces}\nSecond line\twith a tab\nతెలుగు పరీక్ష';
    const r = await tool.execute({ text, path: file, save: true, speed: 'fast' });
    console.log('[notepad]', r.ok ? `typed ${String(r.data?.['typed'])} characters in ${String(r.data?.['seconds'])} s (pid ${String(r.data?.['pid'])})` : `REFUSED: ${r.error}`);
    if (typeof r.data?.['pid'] === 'number') opened.push(r.data['pid']);
    if (!r.ok) {
      // Windows would not give Notepad the focus: the safe answer is that nothing was typed
      expect(r.error).toMatch(/front|focus|window/i);
      expect(readFileSync(file, 'utf8')).toBe('');
      return;
    }
    expect(r.data?.['typed']).toBe(text.length);
    const saved = readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
    expect(saved).toBe(text);
  }, 120_000);
});
