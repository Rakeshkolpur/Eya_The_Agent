/**
 * Learning from a reference document, against REAL Word. A finished petition is built with Word (sections on known pages: page breaks),
 * saved as a .docx, and then learned FROM THE FILE through the real helper (which opens it in its own hidden Word). A half-done document
 * is then compared with it and laid out like it. Everything runs in Words of its own (hidden): the person's own Word is never touched.
 *
 * Opt-in (starts hidden Words on this PC):  EYA_LIVE_WORD=1 npx vitest run tests/live/wordreference.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReaderProcess } from '../../src/main/writing/ReaderProcess';
import { WordControl } from '../../src/main/word/WordControl';
import { ReferenceService } from '../../src/main/word/ReferenceService';
import { ReferenceStore } from '../../src/main/word/ReferenceStore';
import { createWordTools } from '../../src/main/tools/impl/wordTools';
import type { Tool, ToolArgs, ToolResult } from '../../src/main/tools/types';
import { validateArgs } from '../../src/main/tools/types';
import helper from '../../src/main/word/word-helper.ps1?raw';

const live = process.env['EYA_LIVE_WORD'] === '1' && existsSync('C:\\Program Files\\Microsoft Office\\Root\\Office16\\WINWORD.EXE');

const ps = (script: string): string =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 120_000 }).trim();
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

/** A finished petition made with Word itself: each part on its own page, formatted the way a firm would. */
const BUILD_REFERENCE = String.raw`
param([string]$Out)
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject Word.Application
$app.Visible = $false
$app.DisplayAlerts = 0
try {
  $doc = $app.Documents.Add()
  $ps = $doc.PageSetup
  $ps.PaperSize = 7
  $ps.LeftMargin = $app.CentimetersToPoints(3.5)
  $ps.RightMargin = $app.CentimetersToPoints(2)
  $ps.TopMargin = $app.CentimetersToPoints(2.5)
  $ps.BottomMargin = $app.CentimetersToPoints(2.5)
  $n = $doc.Styles.Item(-1)
  $n.Font.Name = 'Times New Roman'
  $n.Font.Size = 12
  function Add-Para([string]$text, [string]$kind) {
    # the text goes into the last (empty) paragraph, and a new empty one follows it
    $r = $doc.Content
    $r.InsertAfter($text)
    $r.InsertParagraphAfter()
    $p = $doc.Paragraphs.Item($doc.Paragraphs.Count - 1)
    $p.Range.Font.Reset()
    $p.Format.Reset()
    $pf = $p.Format
    if ($kind -eq 'title') {
      $pf.Alignment = 1; $p.Range.Font.Bold = -1; $p.Range.Font.Underline = 1; $p.Range.Font.AllCaps = -1
      $pf.SpaceAfter = 12
    } elseif ($kind -eq 'court') {
      $pf.Alignment = 1; $p.Range.Font.Bold = -1; $p.Range.Font.Size = 14
    } else {
      $pf.Alignment = 3; $pf.LineSpacingRule = 1; $pf.FirstLineIndent = $app.CentimetersToPoints(1.27); $pf.SpaceAfter = 6
    }
  }
  function Break-Page() { $r = $doc.Content; $r.InsertParagraphAfter(); $e = $doc.Paragraphs.Item($doc.Paragraphs.Count).Range; $e.InsertBreak(7) }
  $doc.Content.Text = ''
  Add-Para 'IN THE HIGH COURT OF TELANGANA AT HYDERABAD' 'court'
  Add-Para 'WRIT PETITION NO. ______ OF 2026' 'court'
  Add-Para 'BETWEEN:' 'title'
  Add-Para 'A. Kumar, aged about 45 years, resident of Hyderabad, hereinafter called the Petitioner.' 'body'
  Break-Page
  Add-Para 'SYNOPSIS' 'title'
  Add-Para 'The Petitioner challenges the order dated 12.03.2026 passed by the Respondent as arbitrary, illegal and contrary to law.' 'body'
  Add-Para 'The Petitioner has no other efficacious remedy and therefore approaches this Hon''ble Court under Article 226.' 'body'
  Break-Page
  Add-Para 'LIST OF DATES AND EVENTS' 'title'
  $r = $doc.Paragraphs.Item($doc.Paragraphs.Count).Range
  $t = $doc.Tables.Add($r, 3, 3)
  $t.Borders.Enable = $true
  $vals = @(@('S.No','Date','Event'), @('1','12.03.2026','Order passed by the Respondent'), @('2','20.03.2026','Representation made by the Petitioner'))
  for ($i = 0; $i -lt 3; $i++) { for ($j = 0; $j -lt 3; $j++) { $t.Cell($i + 1, $j + 1).Range.Text = $vals[$i][$j] } }
  Break-Page
  Add-Para 'GROUNDS' 'title'
  Add-Para '1. That the impugned order is contrary to the settled law and is liable to be set aside.' 'body'
  Add-Para '2. That the Respondent did not give the Petitioner an opportunity of being heard.' 'body'
  Add-Para '3. That the Petitioner reserves the right to raise additional grounds at the hearing.' 'body'
  Break-Page
  Add-Para 'PRAYER' 'title'
  Add-Para 'It is therefore prayed that this Hon''ble Court may be pleased to set aside the order dated 12.03.2026.' 'body'
  $f = $doc.Sections.Item(1).Footers.Item(1)
  $f.Range.Text = 'Page [[P]] of [[N]]'
  foreach ($pair in @(@('[[P]]', 33), @('[[N]]', 26))) {
    $rr = $f.Range
    if ($rr.Find.Execute($pair[0])) { [void]$doc.Fields.Add($rr, $pair[1]) }
  }
  $f.Range.ParagraphFormat.Alignment = 1
  [void]$doc.Repaginate()
  $pages = $doc.ComputeStatistics(2)
  $doc.SaveAs([ref]$Out, [ref]16)
  Write-Output ('saved; pages=' + $pages)
  $doc.Saved = $true
  $doc.Close()
} finally { $app.Quit() }
`;

describe.skipIf(!live)('learning from a reference with real Word (hidden Words of their own)', () => {
  let dir = '';
  let referenceFile = '';
  let reader: ReaderProcess;
  let control: WordControl;
  let service: ReferenceService;
  let tools: Map<string, Tool>;
  let pidsBefore: number[] = [];
  let usersBefore = '';

  const call = async (name: string, args: ToolArgs = {}): Promise<ToolResult> => {
    const tool = tools.get(name) as Tool;
    validateArgs(tool.schema, args);
    return tool.execute(args);
  };

  beforeAll(() => {
    usersBefore = usersWord();
    pidsBefore = wordPids();
    process.env['EYA_WORD_PRIVATE'] = '1';
    dir = mkdtempSync(join(tmpdir(), 'eya-wordref-'));
    referenceFile = join(dir, 'Old writ petition.docx');
    const script = join(dir, 'build-reference.ps1');
    writeFileSync(script, `\ufeff${BUILD_REFERENCE}`, 'utf8');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Out', referenceFile], { encoding: 'utf8', timeout: 180_000 });
    expect(out).toMatch(/saved; pages=5/);
    reader = new ReaderProcess(join(dir, 'scripts'), undefined, 90_000, { fileName: 'word-helper.ps1', text: helper });
    control = new WordControl(reader);
    service = new ReferenceService(control, new ReferenceStore(join(dir, 'references')));
    tools = new Map(createWordTools({ word: control }).map((t) => [t.schema.name, t]));
  }, 240_000);

  afterAll(async () => {
    control?.close();
    await new Promise((r) => setTimeout(r, 4000));
    for (const pid of wordPids()) {
      if (pidsBefore.includes(pid)) continue;
      try {
        ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
      } catch {
        // already gone
      }
    }
    delete process.env['EYA_WORD_PRIVATE'];
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('learns the finished petition from its FILE: every part, and the page each is on', async () => {
    const started = Date.now();
    const learned = await service.learn('writ petition', referenceFile);
    expect(learned.ok, learned.ok ? '' : learned.why).toBe(true);
    if (!learned.ok) return;
    // eslint-disable-next-line no-console
    console.log(`  [learned a 5-page petition from a file] ${Date.now() - started} ms\n    ${learned.map.join('\n    ')}`);
    const titles = learned.reference.sections.map((s) => s.title);
    expect(titles).toEqual(['IN THE HIGH COURT OF TELANGANA AT HYDERABAD', 'WRIT PETITION NO. ______ OF 2026', 'BETWEEN:', 'SYNOPSIS', 'LIST OF DATES AND EVENTS', 'GROUNDS', 'PRAYER']);
    const page = (t: string) => learned.reference.sections.find((s) => s.title === t)?.startPage;
    expect(page('IN THE HIGH COURT OF TELANGANA AT HYDERABAD')).toBe(1);
    expect(page('SYNOPSIS')).toBe(2);
    expect(page('LIST OF DATES AND EVENTS')).toBe(3);
    expect(page('GROUNDS')).toBe(4);
    expect(page('PRAYER')).toBe(5);
    expect(learned.reference.source).toMatchObject({ pages: 5, fromFile: true });
  }, 180_000);

  it('knows how the finished petition is laid out: page, fonts, spacing, titles, page numbers', async () => {
    const ref = service.show('writ petition', {});
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    expect(ref['pageSetup']).toMatchObject({ paper: 'a4', orientation: 'portrait', marginLeftCm: 3.5, marginRightCm: 2 });
    expect(ref['pageNumbers']).toBe(true);
    expect(String(ref['footer'])).toMatch(/^Page \d+ of \d+$/); // (the numbers in a file that was just saved are not refreshed; the FORMAT is what is learned)
    expect(String(ref['bodyLooks'])).toMatch(/Times New Roman/);
    expect(String(ref['bodyLooks'])).toMatch(/12 pt/);
    expect(String(ref['bodyLooks'])).toMatch(/justify/);
    expect(String(ref['titleLooks'])).toMatch(/center/);
    expect(String(ref['titleLooks'])).toMatch(/bold/);
    const grounds = service.show('writ petition', { section: 'grounds' });
    expect(grounds.ok).toBe(true);
    if (grounds.ok) {
      const part = grounds['section'] as { text: string; paragraphs: number; numbered: boolean; pages: string };
      expect(part).toMatchObject({ paragraphs: 3, numbered: true, pages: '4' });
      expect(part.text).toContain('opportunity of being heard');
    }
    const table = service.show('writ petition', { section: 'list of dates' });
    if (table.ok) expect((table['section'] as { text: string }).text).toContain('12.03.2026 | Order passed by the Respondent');
  }, 60_000);

  it('the reference file was opened in the helper\'s own Word and closed again', () => {
    // nothing of the reference remains open anywhere: only the Words this test started may exist, and the user's own is as it was
    expect(usersWord()).toBe(usersBefore);
  });

  it('compares a half-done document: what is missing, what is short, how the layout differs', async () => {
    expect((await call('word_edit', { kind: 'new_document' })).ok).toBe(true);
    await call('word_write', { text: 'IN THE HIGH COURT OF TELANGANA AT HYDERABAD', align: 'center', bold: true });
    await call('word_write', { text: 'WRIT PETITION NO. ______ OF 2026', align: 'center', bold: true });
    await call('word_write', { text: 'Synopsis', align: 'center', bold: true });
    await call('word_write', { text: 'The Petitioner challenges the order.', align: 'left', fontName: 'Arial', fontSize: 11 });
    await call('word_write', { text: 'Grounds', align: 'center', bold: true });
    await call('word_write', { text: '1. That the order is bad.', align: 'left', fontName: 'Arial', fontSize: 11 });

    const got = await service.compare('writ petition');
    expect(got.ok, got.ok ? '' : got.why).toBe(true);
    if (!got.ok) return;
    expect(got.comparison.missing.map((m) => m.title)).toEqual(['BETWEEN:', 'LIST OF DATES AND EVENTS', 'PRAYER']);
    expect(got.comparison.matched.find((m) => m.title === 'SYNOPSIS')).toMatchObject({ status: 'shorter', referencePage: 2 });
    expect(got.comparison.matched.find((m) => m.title === 'GROUNDS')).toMatchObject({ status: 'shorter' });
    const looks = got.looks.join('\n');
    expect(looks).toMatch(/Body font: the reference uses Times New Roman, this document Arial/);
    expect(looks).toMatch(/Body size: the reference uses 12 pt, this document 11 pt/);
    expect(looks).toMatch(/Body alignment: the reference uses justify, this document left/);
  }, 120_000);

  it('lays the half-done document out like the reference — one undo step — and the fonts, spacing, margins and page numbers really change', async () => {
    const applied = await service.applyFormat('writ petition', 'all');
    expect(applied.ok, applied.ok ? '' : applied.why).toBe(true);
    if (!applied.ok) return;
    expect(applied.applied.join(' ')).toMatch(/page setup/);
    expect(applied.applied.join(' ')).toMatch(/body text/);

    const read = await call('word_read', { from: 1, to: 6, detail: true });
    const p = read.data?.['paragraphs'] as Array<Record<string, unknown>>;
    // (a title given "all capitals" reads back in capitals from Word)
    const synopsisTitle = p.find((x) => String(x['text']).toLowerCase() === 'synopsis');
    const body = p.find((x) => String(x['text']).startsWith('The Petitioner challenges the order'));
    expect(body).toMatchObject({ font: 'Times New Roman', size: 12, align: 'justify' });
    expect(synopsisTitle).toMatchObject({ align: 'center', bold: true });

    const setup = await call('word_structure', { kind: 'page_setup', options: '{}' });
    expect((setup.data?.['marginsCm'] as { left: number }).left).toBe(3.5);
    const status = await call('word_status');
    expect(status.data?.['pageNumbers']).toBe(true);
    expect(String(status.data?.['footer'])).toMatch(/^Page 1 of \d+$/);

    // it is ONE undo step: undoing it puts the old look back
    expect((await call('word_edit', { kind: 'undo' })).ok).toBe(true);
    const after = (await call('word_read', { from: 4, to: 4, detail: true })).data?.['paragraphs'] as Array<Record<string, unknown>>;
    expect(after[0]).toMatchObject({ font: 'Arial', size: 11, align: 'left' });
  }, 120_000);

  it('forgets a reference when told to, and remembers it across a restart until then', async () => {
    const fresh = new ReferenceService(control, new ReferenceStore(join(dir, 'references')));
    expect(fresh.list().map((r) => r.name)).toEqual(['writ petition']);
    expect(fresh.forget('writ')).toBe('writ petition');
    expect(fresh.list()).toEqual([]);
  });

  it('left the person\'s own Word exactly as it was', () => {
    expect(usersWord()).toBe(usersBefore);
  });
});
