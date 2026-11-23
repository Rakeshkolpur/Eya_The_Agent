/**
 * The new Word abilities against REAL Word, through the real PowerShell helper — in a PRIVATE hidden Word of its own (EYA_WORD_PRIVATE=1), so that nothing the person has open in
 * their own Word is ever touched: building a whole document from a layout (what a photo showed), finding and fixing a table that does not look right, turning lines of text into a
 * table, and typing live.
 *
 * Opt-in (it starts a hidden Word on this PC):  EYA_LIVE_WORD=1 npx vitest run tests/live/wordoffice.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createWordImageTool } from '../../src/main/tools/impl/wordImageTool';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReaderProcess } from '../../src/main/writing/ReaderProcess';
import { WordControl } from '../../src/main/word/WordControl';
import type { WordAnswer } from '../../src/main/word/WordControl';
import helper from '../../src/main/word/word-helper.ps1?raw';

const live = process.env['EYA_LIVE_WORD'] === '1' && existsSync('C:\\Program Files\\Microsoft Office\\Root\\Office16\\WINWORD.EXE');

const ps = (script: string): string => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60_000 }).trim();
const wordPids = (): number[] => {
  const out = ps(`@(Get-Process winword -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) -join ','`);
  return out === '' ? [] : out.split(',').map(Number);
};
const usersWord = (): string => {
  try {
    return ps(`$w = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application'); ($w.Documents | ForEach-Object { $_.FullName + ':' + $_.Content.End + ':' + $_.Saved }) -join '|'`);
  } catch {
    return '(no Word running)';
  }
};

describe.skipIf(!live)('the new Word abilities with real Word (a private hidden instance)', () => {
  let dir = '';
  let control: WordControl;
  let pidsBefore: number[] = [];
  let usersBefore = '';

  const run = async (cmd: Parameters<WordControl['run']>[0], args: Record<string, unknown> = {}): Promise<WordAnswer> => control.run(cmd, args);
  const ok = async (cmd: Parameters<WordControl['run']>[0], args: Record<string, unknown> = {}): Promise<WordAnswer> => {
    const a = await run(cmd, args);
    expect(a.ok, `${cmd}: ${String(a.why ?? '')} ${String(a.detail ?? '')}`).toBe(true);
    return a;
  };
  const text = async (): Promise<string> => {
    const a = await ok('read', { from: 1, to: 200 });
    return (a['paragraphs'] as Array<{ text: string }>).map((p) => p.text).join('\n');
  };

  beforeAll(() => {
    usersBefore = usersWord();
    pidsBefore = wordPids();
    process.env['EYA_WORD_PRIVATE'] = '1';
    dir = mkdtempSync(join(tmpdir(), 'eya-wordoffice-'));
    control = new WordControl(new ReaderProcess(join(dir, 'scripts'), undefined, 150_000, { fileName: 'word-helper.ps1', text: helper }));
  }, 60_000);

  afterAll(async () => {
    control?.close();
    await new Promise((r) => setTimeout(r, 4000));
    for (const pid of wordPids()) {
      if (pidsBefore.includes(pid)) continue;
      try {
        ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
      } catch {
        // (already gone)
      }
    }
    rmSync(dir, { recursive: true, force: true });
    // the person's own Word: exactly what it was
    expect(usersWord()).toBe(usersBefore);
  }, 60_000);

  const SPEC = {
    page: { paper: 'a4', orientation: 'portrait', marginTopCm: 2.5, marginBottomCm: 2.5, marginLeftCm: 3, marginRightCm: 2 },
    defaults: { font: 'Times New Roman', size: 12, lineSpacing: 1.15, spaceAfter: 6 },
    blocks: [
      { type: 'heading', level: 1, text: 'LEGAL NOTICE', align: 'center', bold: true, size: 16 },
      { type: 'paragraph', align: 'justify', runs: [{ text: 'This is ' }, { text: 'bold', bold: true }, { text: ' and ' }, { text: 'italic', italic: true }, { text: ' and ' }, { text: 'red', color: '#FF0000' }, { text: ' text.' }] },
      { type: 'paragraph', list: 'bullet', text: 'First point' },
      { type: 'paragraph', list: 'bullet', text: 'Second point' },
      {
        type: 'table',
        headerRows: 1,
        colWidthsPct: [10, 60, 30],
        rows: [
          [{ text: 'S.No', bold: true, shade: '#D9D9D9', align: 'center' }, { text: 'Particulars', bold: true, shade: '#D9D9D9' }, { text: 'Amount', bold: true, shade: '#D9D9D9', align: 'right' }],
          [{ text: '1' }, { text: 'Fees' }, { text: '1,000', align: 'right' }],
          [{ text: 'Total', colSpan: 2, bold: true }, { text: '1,000', align: 'right', bold: true }],
        ],
      },
      { type: 'paragraph', text: 'After the table.' },
      { type: 'pagebreak' },
      { type: 'paragraph', text: 'Second page.' },
    ],
  };

  it('builds a whole document from a layout: heading, runs, list, a table with a merged cell, a page break', async () => {
    const a = await ok('build', { spec: SPEC, target: 'new' });
    expect(a['headings']).toBe(1);
    expect(a['tables']).toBe(1);
    expect(a['tableRows']).toEqual([3]);
    expect(a['tableColumns']).toEqual([3]);
    expect(a['pageBreaks']).toBe(1);
    expect(a['pages']).toBe(2);
    expect(a['warnings']).toEqual([]);
    const t = await text();
    expect(t).toContain('LEGAL NOTICE');
    expect(t).toContain('This is bold and italic and red text.');
    expect(t).toContain('First point');
    expect(t).toContain('Fees');
    expect(t).toContain('Second page.');
  }, 150_000);

  it('the formatting is really there: the heading is bold and centred, a run is bold, another italic, another red', async () => {
    const a = await ok('read', { from: 1, to: 3, detail: true });
    const paras = a['paragraphs'] as Array<Record<string, unknown>>;
    console.log('[build] formatting as Word reports it:', JSON.stringify(paras.map((p) => ({ n: p['n'], text: String(p['text']).slice(0, 30), bold: p['bold'], align: p['align'], size: p['size'], style: p['style'] }))));
    const heading = paras[0] as Record<string, unknown>;
    expect(String(heading['text'])).toBe('LEGAL NOTICE');
    expect(String(heading['align'] ?? '').toLowerCase()).toMatch(/center|1/);
  }, 60_000);

  it('a table with no borders, an empty last row and columns wider than the page is FOUND, then fixed, and what was fixed is checked', async () => {
    await ok('new');
    await ok('build', {
      target: 'end',
      spec: {
        blocks: [
          { type: 'paragraph', text: 'A table that does not look right:' },
          {
            type: 'table',
            borders: 'none',
            colWidthsPct: [60, 60, 60],
            rows: [[{ text: 'Name' }, { text: 'Age' }, { text: 'City' }], [{ text: 'Asha' }, { text: '31' }, { text: 'Pune' }], [{ text: '' }, { text: '' }, { text: '' }], [{ text: '' }, { text: '' }, { text: '' }]],
          },
        ],
      },
    });
    const found = await ok('tables');
    const problems = (found['problems'] as string[]).join(' | ');
    console.log('[tables] found:', problems);
    expect(problems).toMatch(/no borders/);
    expect(problems).toMatch(/empty row/);
    const fixed = await ok('fix_table', { table: 'all' });
    const report = (fixed['tables'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    console.log('[fix_table] did:', JSON.stringify(report['did']), 'problems left:', JSON.stringify(report['problemsAfter']));
    expect((report['did'] as string[]).join(' ')).toMatch(/borders/);
    const after = await ok('tables');
    const info = (after['tables'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(info['hasBorders']).toBe(true);
    expect(info['fitsPage']).toBe(true);
    expect(info['emptyRows']).toEqual([]);
    expect(info['rows']).toBeLessThan(4);
    // the words in the table were not touched
    const t = await text();
    expect(t).toContain('Asha');
    expect(t).toContain('Pune');
  }, 150_000);

  it('lines of text separated by tabs become a table, with borders and the page width', async () => {
    await ok('new');
    await ok('build', { target: 'end', spec: { blocks: [{ type: 'paragraph', text: 'Name\tAge\tCity' }, { type: 'paragraph', text: 'Asha\t31\tPune' }, { type: 'paragraph', text: 'Ravi\t45\tDelhi' }] } });
    const a = await ok('fix_table', { actions: ['from_text'], target: 'paragraphs:1-3' });
    expect(a['converted']).toBe(true);
    const t = await ok('tables');
    expect(t['count']).toBe(1);
    const info = (t['tables'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(info['rows']).toBe(3);
    expect(info['columns']).toBe(3);
    expect(info['hasBorders']).toBe(true);
    expect(info['fitsPage']).toBe(true);
  }, 150_000);

  it('typing live: it takes time like typing, the words arrive intact (no automatic list, no capital fixed), and it is ONE undo step', async () => {
    await ok('new');
    const typed = '1. first item, in lowercase\nsecond line (c) stays as typed';
    const a = await ok('type', { text: typed, cps: 40 });
    console.log('[type] typed', a['typed'], 'characters in', a['seconds'], 'seconds');
    expect(a['typed']).toBe(typed.length);
    expect(Number(a['seconds'])).toBeGreaterThan(0.8);
    const t = await text();
    expect(t).toContain('1. first item, in lowercase');
    expect(t).toContain('second line (c) stays as typed');
    // one undo step takes all of it back
    await ok('undo', { kind: 'undo', times: 1 });
    expect((await text()).trim()).toBe('');
  }, 150_000);

  it('the whole "recreate this picture in Word" tool, with a stand-in for the vision model and the REAL Word: recognised, built, and the shape compared', async () => {
    const picture = join(dir, 'page.png');
    writeFileSync(picture, Buffer.from('a picture'));
    const tool = createWordImageTool({
      word: control,
      brain: { hasKey: () => true, analyzeFile: async () => '```json\n' + JSON.stringify(SPEC) + '\n```' },
      folders: { home: dir, desktop: dir, documents: dir, downloads: dir, pictures: dir, videos: dir, music: dir, temp: dir },
      attachmentsDir: dir,
    });
    const r = await tool.execute({ path: picture });
    console.log('[word_from_image]', r.summary, JSON.stringify({ same: r.data?.['sameShapeAsRecognised'], differences: r.data?.['differences'], warnings: r.data?.['warnings'], pages: r.data?.['pages'] }));
    expect(r.ok, r.error).toBe(true);
    expect(r.data?.['sameShapeAsRecognised']).toBe(true);
    expect(r.data?.['warnings']).toEqual([]);
    expect(String(r.summary)).toContain('table 1 (3 rows × 3 columns)');
    expect(await text()).toContain('LEGAL NOTICE');
  }, 150_000);

  it('typing with a style: the typed words become a heading', async () => {
    await ok('new');
    const a = await ok('type', { text: 'A Typed Heading', style: 'Heading 1', cps: 80 });
    expect(a['formatted']).toContain('style');
    const s = await ok('status');
    const headings = (s['headings'] as Array<{ text: string }>).map((h) => h.text);
    expect(headings).toContain('A Typed Heading');
  }, 90_000);
});
