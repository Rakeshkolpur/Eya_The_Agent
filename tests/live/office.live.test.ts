/**
 * Excel and PowerPoint against REAL Office, through the real PowerShell helper — in PRIVATE hidden instances of their own (EYA_OFFICE_PRIVATE=1), so that whatever the person has open in their
 * own Excel or PowerPoint is never touched: a workbook with values, formulas, formatting, a table, a chart and a sort, the protection against writing over cells, and a presentation with
 * slides, text, a table and notes; both are saved to a temporary folder and the files are checked.
 *
 * Opt-in (it starts hidden Excel and PowerPoint on this PC):  EYA_LIVE_OFFICE=1 npx vitest run tests/live/office.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReaderProcess } from '../../src/main/writing/ReaderProcess';
import { OfficeControl } from '../../src/main/office/OfficeControl';
import type { OfficeAnswer, OfficeApp } from '../../src/main/office/OfficeControl';
import helper from '../../src/main/office/office-helper.ps1?raw';

const live = process.env['EYA_LIVE_OFFICE'] === '1' && existsSync('C:\\Program Files\\Microsoft Office\\Root\\Office16\\EXCEL.EXE') && existsSync('C:\\Program Files\\Microsoft Office\\Root\\Office16\\POWERPNT.EXE');

const ps = (script: string): string => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60_000 }).trim();
const pids = (name: string): number[] => {
  const out = ps(`@(Get-Process ${name} -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) -join ','`);
  return out === '' ? [] : out.split(',').map(Number);
};

describe.skipIf(!live)('Excel and PowerPoint with real Office (private hidden instances)', () => {
  let dir = '';
  let control: OfficeControl;
  const before = { excel: [] as number[], powerpnt: [] as number[] };

  const run = (app: OfficeApp, op: string, args: Record<string, unknown> = {}): Promise<OfficeAnswer> => control.run(app, op, args);
  const ok = async (app: OfficeApp, op: string, args: Record<string, unknown> = {}): Promise<OfficeAnswer> => {
    const a = await run(app, op, args);
    expect(a.ok, `${app} ${op}: ${String(a.why ?? '')} ${String(a.detail ?? '')}`).toBe(true);
    return a;
  };

  beforeAll(() => {
    before.excel = pids('excel');
    before.powerpnt = pids('powerpnt');
    process.env['EYA_OFFICE_PRIVATE'] = '1';
    dir = mkdtempSync(join(tmpdir(), 'eya-office-'));
    control = new OfficeControl(new ReaderProcess(join(dir, 'scripts'), undefined, 90_000, { fileName: 'office-helper.ps1', text: helper }));
  }, 60_000);

  afterAll(async () => {
    control?.close();
    await new Promise((r) => setTimeout(r, 5000));
    for (const [name, list] of [['excel', before.excel], ['powerpnt', before.powerpnt]] as const) {
      for (const pid of pids(name)) if (!list.includes(pid)) ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
    }
    rmSync(dir, { recursive: true, force: true });
    // nothing of the person's own was closed
    for (const pid of before.excel) expect(pids('excel')).toContain(pid);
    for (const pid of before.powerpnt) expect(pids('powerpnt')).toContain(pid);
  }, 60_000);

  it('Excel: a new workbook, values, a formula down a column that calculates, and a read back', async () => {
    await ok('excel', 'new');
    const w = await ok('excel', 'write', { range: 'A1', values: [['Item', 'Qty', 'Price', 'Total'], ['Pen', 5, 12.5, null], ['Book', 2, 80, null], ['Bag', 1, 450, null]] });
    expect(w['written']).toBe(16);
    const f = await ok('excel', 'formula', { range: 'D2:D4', formula: '=B2*C2' });
    expect(f['first']).toBe('62.5');
    const r = await ok('excel', 'read', { range: 'A1:D4', formulas: true });
    const values = r['values'] as unknown[][];
    expect(values[0]).toEqual(['Item', 'Qty', 'Price', 'Total']);
    expect(values[1]).toEqual(['Pen', 5, 12.5, 62.5]);
    expect(values[3]).toEqual(['Bag', 1, 450, 450]);
    expect((r['formulas'] as string[][])[2]?.[3]).toBe('=B3*C3');
  }, 90_000);

  it('Excel: it will not write over cells that already have something unless it is told to, and says how many', async () => {
    const refused = await run('excel', 'write', { range: 'A1', values: [['Changed']] });
    expect(refused.ok).toBe(false);
    expect(refused.needsConfirm).toBe(true);
    expect(String(refused.why)).toContain('already have something');
    expect(((await ok('excel', 'read', { range: 'A1' }))['values'] as unknown[][])[0]).toEqual(['Item']);
    await ok('excel', 'write', { range: 'A1', values: [['Product']], overwrite: true });
    expect(((await ok('excel', 'read', { range: 'A1' }))['values'] as unknown[][])[0]).toEqual(['Product']);
  }, 90_000);

  it('Excel: format, an Excel table, a sort, a chart and sheets', async () => {
    const f = await ok('excel', 'format', { range: 'A1:D1', bold: true, fill: '#1F4E78', color: '#FFFFFF', align: 'center', borders: true });
    expect(f['applied']).toEqual(expect.arrayContaining(['bold', 'fill', 'colour', 'alignment', 'borders']));
    await ok('excel', 'format', { range: 'C2:D4', numberFormat: '#,##0.00', autofit: true });
    const t = await ok('excel', 'table', { range: 'A1:D4', name: 'Sales' });
    expect(t['table']).toBe('Sales');
    await ok('excel', 'sort', { range: 'A1:D4', column: 4, order: 'desc', header: true });
    const sorted = (await ok('excel', 'read', { range: 'A1:D4' }))['values'] as unknown[][];
    expect(sorted[1]?.[0]).toBe('Bag');
    const c = await ok('excel', 'chart', { range: 'A1:B4', type: 'column', title: 'Quantity' });
    expect(c['type']).toBe('column');
    const added = await ok('excel', 'sheet', { action: 'add', name: 'Notes' });
    expect(added['sheet']).toBe('Notes');
    await ok('excel', 'sheet', { action: 'rename', sheet: 'Notes', newName: 'Summary' });
    const del = await run('excel', 'sheet', { action: 'delete', sheet: 'Summary' });
    expect(del.needsConfirm).toBe(true);
    await ok('excel', 'sheet', { action: 'delete', sheet: 'Summary', confirm: true });
    const status = await ok('excel', 'status');
    const names = ((status['workbooks'] as Array<{ sheets: Array<{ name: string }> }>)[0]?.sheets ?? []).map((s) => s.name);
    expect(names).not.toContain('Summary');
  }, 120_000);

  it('Excel: it is saved as a real .xlsx file only when a path is given', async () => {
    const path = join(dir, 'sales.xlsx');
    const noPath = await run('excel', 'save', {});
    expect(noPath.ok).toBe(false);
    expect(String(noPath.why)).toContain('never been saved');
    await ok('excel', 'save', { path });
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(4000);
  }, 90_000);

  it('PowerPoint: a new presentation with a title slide and a bullet slide, text, formatting, a table and notes', async () => {
    await ok('powerpoint', 'new');
    const a = await ok('powerpoint', 'add_slide', { layout: 'title', title: 'Quarterly Plan', subtitle: 'Prepared by Rakesh' });
    expect(a['slide']).toBe(1);
    const b = await ok('powerpoint', 'add_slide', { layout: 'title_content', title: 'Goals', bullets: ['Grow users', 'Cut costs', 'Ship the app'], notes: 'Say the numbers aloud.' });
    expect(b['slide']).toBe(2);
    await ok('powerpoint', 'set_text', { slide: 2, shape: 'title', text: 'Our Goals' });
    const f = await ok('powerpoint', 'format_text', { slide: 2, shape: 'title', bold: true, fontSize: 40, color: '#1F4E78', align: 'center' });
    expect(f['applied']).toEqual(expect.arrayContaining(['bold', 'size', 'colour', 'alignment']));
    await ok('powerpoint', 'add_slide', { layout: 'title_only', title: 'Budget' });
    const t = await ok('powerpoint', 'add_table', { slide: 3, rows: [['Item', 'Cost'], ['Pen', '5'], ['Book', '80']] });
    expect(t['rows']).toBe(3);
    const r = await ok('powerpoint', 'read', {});
    const slides = r['slides'] as Array<{ slide: number; shapes: Array<{ name: string; kind: string; text: string }>; notes: string }>;
    expect(slides).toHaveLength(3);
    expect(slides[1]?.shapes.some((s) => s.text === 'Our Goals')).toBe(true);
    expect(slides[1]?.shapes.some((s) => s.text.includes('Cut costs'))).toBe(true);
    expect(slides[1]?.notes).toContain('Say the numbers aloud');
    expect(slides[2]?.shapes.some((s) => s.kind === 'table')).toBe(true);
    const status = await ok('powerpoint', 'status');
    expect(status['count']).toBe(3);
  }, 120_000);

  it('PowerPoint: duplicate, move, and a delete that must be confirmed; saved as a real .pptx file', async () => {
    const d = await ok('powerpoint', 'slide', { action: 'duplicate', slide: 2 });
    expect(d['count']).toBe(4);
    await ok('powerpoint', 'slide', { action: 'move', slide: 4, to: 1 });
    const del = await run('powerpoint', 'slide', { action: 'delete', slide: 1 });
    expect(del.needsConfirm).toBe(true);
    expect(((await ok('powerpoint', 'status'))['count'])).toBe(4);
    await ok('powerpoint', 'slide', { action: 'delete', slide: 1, confirm: true });
    expect(((await ok('powerpoint', 'status'))['count'])).toBe(3);
    const path = join(dir, 'talk.pptx');
    await ok('powerpoint', 'save', { path });
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(10_000);
  }, 120_000);
});
