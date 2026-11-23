/**
 * Writing Watch against REAL Word, through the real PowerShell helper: a throwaway document (never saved, closed at the end) gets a made-up
 * draft with deliberate mistakes, typed in the way a person does (a paragraph at a time, the cursor at the end of the last one); the
 * watcher must notice them after the pause, leave an untouched old paragraph alone, show Word's own spelling suggestion, and make a fix
 * only when asked — which Word then shows, and can undo.
 *
 * Opt-in (it opens Word on this PC):  EYA_LIVE_WORD=1 npx vitest run tests/live/writingword.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FocusedTextSource, ReaderProcess, WordSource } from '../../src/main/writing/ReaderProcess';
import { WritingWatch } from '../../src/main/writing/WritingWatch';
import type { WatchState } from '../../src/main/writing/WritingWatch';

const live = process.env['EYA_LIVE_WORD'] === '1' && existsSync('C:\\Program Files\\Microsoft Office\\Root\\Office16\\WINWORD.EXE');

const ps = (script: string): string => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60_000 }).trim();
const word = (body: string): string =>
  ps(`$w = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application'); $d = $w.ActiveDocument; ${body}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!live)('Writing Watch with real Word', () => {
  let dir = '';
  let reader: ReaderProcess;
  let watch: WritingWatch;
  let states: WatchState[] = [];
  const last = (): WatchState => states[states.length - 1] as WatchState;
  /** The watcher looks every 300 ms here, and treats 700 ms of stillness as a pause. */
  const until = async (ok: () => boolean, label: string, ms = 20_000): Promise<void> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (ok()) return;
      await sleep(150);
    }
    throw new Error(`timed out waiting for: ${label}`);
  };

  // This test finds "the" Word through the running-object table and, at the end, closes the document and quits it. That is only safe when the
  // Word is the throwaway one made below: with the person's own Word open it would close THEIR document without saving. So it will not run then.
  let safe = false;

  beforeAll(async () => {
    const running = ps(`@(Get-Process winword -ErrorAction SilentlyContinue).Count`);
    if (running !== '0') throw new Error('Word is already open on this PC: this test would close it. Close Word first, or run tests/live/wordcontrol.live.test.ts (which uses a private Word).');
    safe = true;
    dir = mkdtempSync(join(tmpdir(), 'eya-writing-live-'));
    // A throwaway Word with an "old" document already open: two paragraphs, the first with a slip in it that was there before.
    ps(`$w = New-Object -ComObject Word.Application; $w.Visible = $true; $d = $w.Documents.Add();
        $d.Content.Text = 'IN THE HIGH COURT' + [char]13 + 'An old paragraph that already has the the slip in it.';
        $w.Selection.EndKey(6) | Out-Null`);
    reader = new ReaderProcess(join(dir, 'scripts'));
    watch = new WritingWatch({
      sources: [new WordSource(reader), new FocusedTextSource(reader)],
      onChange: (s) => void states.push(s),
      pauseMs: 700,
      pollMs: 300,
    });
    watch.start();
  }, 90_000);

  afterAll(() => {
    watch?.stop();
    reader?.close();
    if (safe) {
      try {
        ps(`$w = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application'); $w.ActiveDocument.Close(0); $w.Quit()`);
      } catch {
        // Word was already closed
      }
    }
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('sees the document and leaves what was already written alone', async () => {
    await until(() => last()?.source === 'Word', 'the watcher to find Word');
    await sleep(2500);
    expect(last().findings).toEqual([]);
    expect(last().title).toMatch(/Document/);
  }, 60_000);

  it('notices mistakes in a new paragraph after the pause: a doubled word, an impossible date, an amount that disagrees, a misspelling', async () => {
    word(`$w.Selection.InsertAfter([string][char]13 + '1. The Petitioner submits that the the order dated 31.02.2026 is illegal and Rs. 5,00,000/- (Rupees five lakh fifty thousand only) was recieved.'); $w.Selection.EndKey(6) | Out-Null`);
    await until(() => last().findings.length >= 4, 'four findings', 30_000);
    const kinds = last().findings.map((f) => f.kind).sort();
    expect(kinds).toEqual(['amount', 'date', 'repeated_word', 'spelling']);
    const spelling = last().findings.find((f) => f.kind === 'spelling');
    expect(spelling).toMatchObject({ canFix: true, replace: { from: 'recieved', to: 'received' } }); // Word's own suggestion
    expect(last().findings.every((f) => f.paragraph === 3)).toBe(true);
    // And Word was not touched by looking.
    expect(word(`$d.Paragraphs.Item(3).Range.Text`)).toContain('the the order');
  }, 90_000);

  it('makes a fix only when asked, in Word, and it can be undone', async () => {
    const repeated = last().findings.find((f) => f.kind === 'repeated_word');
    expect(repeated?.canFix).toBe(true);
    expect(await watch.fix(repeated?.id as string)).toBe(true);
    expect(word(`$d.Paragraphs.Item(3).Range.Text`)).not.toContain('the the');
    expect(word(`$d.Paragraphs.Item(3).Range.Text`)).toContain('that the order dated');
    await until(() => !last().findings.some((f) => f.kind === 'repeated_word'), 'the fixed slip to go from the card');
    word(`$d.Undo(1) | Out-Null`); // the user presses Ctrl+Z
    expect(word(`$d.Paragraphs.Item(3).Range.Text`)).toContain('the the order');
    await until(() => last().findings.some((f) => f.kind === 'repeated_word'), 'the slip to come back after the undo', 30_000);
  }, 90_000);

  it('"check this" reads the whole document, old paragraphs included', async () => {
    const n = await watch.checkAll();
    expect(n).toBeGreaterThanOrEqual(5);
    expect(last().findings.some((f) => f.paragraph === 2 && f.kind === 'repeated_word')).toBe(true);
  }, 60_000);

  it('stops cleanly', () => {
    watch.stop();
    expect(last()).toMatchObject({ watching: false, findings: [] });
  });
});
