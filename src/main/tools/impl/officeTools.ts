import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { checkPath, checkReadablePath } from '@main/security/pathPolicy';
import type { KnownFolders } from '@main/security/pathPolicy';
import type { OfficeAnswer, OfficeApp } from '@main/office/OfficeControl';
import type { Tool, ToolArgs, ToolResult } from '../types';

/**
 * Excel and PowerPoint, in the file the user has open: read it, fill it, format it, build tables, charts and slides. Two tools, deliberately (every tool is read by the model on every turn):
 * `action` picks the operation and `options` holds its settings. Excel and PowerPoint cannot undo what automation does, so these tools protect instead: they refuse to write over cells that
 * already hold something or to delete a sheet or slide unless the user said yes (confirm), they never save unless asked, and a file is only ever saved inside the user's own folders.
 */
export interface OfficeToolDeps {
  readonly office: { run(app: OfficeApp, op: string, args?: Record<string, unknown>, options?: { readonly timeoutMs?: number }): Promise<OfficeAnswer> };
  readonly folders: KnownFolders;
  readonly exists?: (path: string) => boolean;
}

type Bag = Record<string, unknown>;

const failure = (summary: string, error: string, data?: Bag): ToolResult => ({ ok: false, summary, error, ...(data !== undefined ? { data } : {}) });

function parseOptions(args: ToolArgs, example: string): { options: Bag } | { error: ToolResult } {
  const given = typeof args['options'] === 'string' ? args['options'].trim() : '';
  if (given === '') return { options: {} };
  try {
    const value: unknown = JSON.parse(given);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    return { options: value as Bag };
  } catch {
    return { error: failure('bad options', `options must be a JSON object, for example ${example}`) };
  }
}

function toResult(app: string, answer: OfficeAnswer, summary: string, extra: Bag = {}): ToolResult {
  if (answer.needsConfirm === true) {
    return failure('needs confirmation', `${String(answer.why ?? 'This changes something that cannot be undone')}, and ${app} cannot undo it. Tell the user what it would do and ask whether to go ahead; call again with confirm=true only after they say yes.`, { needsConfirmation: true });
  }
  if (!answer.ok) {
    const why = typeof answer.why === 'string' && answer.why !== '' ? answer.why : `${app} would not do that`;
    const missing = /is not open|no workbook is open|no presentation is open/.test(why);
    return failure(missing ? `${app} is not open` : `${app} would not do that`, `${why}.${missing ? ` Open ${app} (open_application "${app}") or ask the user to open the file first.` : ''}`);
  }
  const { ok: _ok, id: _id, why: _why, ...facts } = answer as Record<string, unknown>;
  return { ok: true, summary, data: { ...facts, ...extra } };
}

const EXCEL_ACTIONS = ['status', 'read', 'write', 'formula', 'format', 'table', 'sheet', 'chart', 'sort', 'new', 'save'] as const;
const PPT_ACTIONS = ['status', 'read', 'add_slide', 'set_text', 'format_text', 'add_table', 'add_picture', 'slide', 'new', 'save'] as const;

/** Where a file may be saved: inside the user's own folders, with a plain document extension, and not over a file that is already there unless the user said yes. */
function savePath(options: Bag, exts: readonly string[], confirm: boolean, folders: KnownFolders, exists: (p: string) => boolean): { path?: string; error?: ToolResult } {
  const p = typeof options['path'] === 'string' ? options['path'].trim() : '';
  if (p === '') return {};
  const check = checkPath(p, folders);
  if (!check.ok) return { error: failure('not allowed', check.reason) };
  const ext = extname(check.path).toLowerCase();
  if (!exts.includes(ext)) return { error: failure('not a document file', `Save it as one of: ${exts.join(', ')}.`) };
  if (exists(check.path) && !confirm) return { error: failure('needs confirmation', `A file ${check.path} already exists, and saving would replace it. Ask the user whether to replace it; call again with confirm=true only after they say yes.`, { needsConfirmation: true }) };
  return { path: check.path };
}

export function createOfficeTools(deps: OfficeToolDeps): Tool[] {
  const exists = deps.exists ?? existsSync;

  const excel: Tool = {
    schema: {
      name: 'excel_work',
      status: 'Working in Excel…',
      requiresConfirmation: true,
      description:
        'Microsoft Excel, in the workbook the user has open. `action` picks one; `options` is a JSON object for it (sheet: a sheet name, default the active sheet). ' +
        'status: {} — workbooks, sheets and their used ranges (start here). ' +
        'read: {"range":"A1:D20"} (default the used range, up to 600 cells; "formulas":true adds the formulas). ' +
        'write: {"range":"A1","values":[["Name","Qty"],["Pen",5]]} — a grid from that cell; a text starting with = is a formula; it refuses to write over cells that already have something unless confirm=true. ' +
        'formula: {"range":"C2:C20","formula":"=A2*B2"} — one formula down a range (relative references follow). ' +
        'format: {"range":"A1:D1","bold":true,"fontSize":12,"fontName":"Calibri","color":"#FFFFFF","fill":"#1F4E78","numberFormat":"#,##0.00","align":"center","vAlign":"center","wrap":true,"borders":true,"merge":true,"columnWidth":18,"rowHeight":22,"autofit":true}. ' +
        'table: {"range":"A1:D20","name":"Sales","style":"TableStyleMedium2","header":true} — turn a range into an Excel table. ' +
        'sheet: {"action":"add"|"rename"|"activate"|"delete","name":"Data","newName":"Summary"} (delete needs confirm=true). ' +
        'chart: {"range":"A1:B6","type":"column"|"bar"|"line"|"pie"|"area"|"scatter","title":"Sales"}. sort: {"range":"A1:D20","column":2,"order":"asc"|"desc","header":true}. ' +
        'new: {} — a new workbook. save: {} saves in place; {"path":"C:\\\\Users\\\\...\\\\Documents\\\\sales.xlsx"} saves a new file (only in the user\'s own folders; replacing a file needs confirm=true). ' +
        'Excel cannot undo this: tell the user what you changed. Do what the user asked at once; do not read the whole sheet when a few cells will do.',
      args: {
        action: { type: 'string', required: true, enum: EXCEL_ACTIONS },
        options: { type: 'string', description: 'A JSON object with the settings for this action (see above).' },
        confirm: { type: 'boolean', description: 'Set true only after the user said yes to overwriting cells, deleting a sheet, or replacing a file.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const action = typeof args['action'] === 'string' ? (args['action'] as (typeof EXCEL_ACTIONS)[number]) : undefined;
      if (action === undefined || !EXCEL_ACTIONS.includes(action)) return failure('unknown action', `action must be one of: ${EXCEL_ACTIONS.join(', ')}.`);
      const parsed = parseOptions(args, '{"range":"A1","values":[["Name","Qty"],["Pen",5]]}');
      if ('error' in parsed) return parsed.error;
      const confirm = args['confirm'] === true;
      const options: Bag = { ...parsed.options, ...(confirm ? { overwrite: true, confirm: true } : {}) };
      if (action === 'save') {
        const saved = savePath(options, ['.xlsx', '.xls', '.csv'], confirm, deps.folders, exists);
        if (saved.error !== undefined) return saved.error;
        if (saved.path !== undefined) options['path'] = saved.path;
        else delete options['path'];
      }
      const answer = await deps.office.run('excel', action, options);
      const summary: Record<string, string> = {
        status: 'looked at Excel',
        read: `read ${String(answer['address'] ?? 'the cells')}`,
        write: `wrote ${String(answer['written'] ?? '')} cells at ${String(answer['address'] ?? '')}`,
        formula: `put the formula in ${String(answer['address'] ?? '')}`,
        format: `formatted ${String(answer['address'] ?? '')}`,
        table: `made the table ${String(answer['table'] ?? '')}`,
        sheet: 'changed the sheets',
        chart: `added a ${String(answer['type'] ?? '')} chart`,
        sort: `sorted ${String(answer['address'] ?? '')}`,
        new: 'opened a new workbook',
        save: 'saved the workbook',
      };
      return toResult('Excel', answer, summary[action] ?? 'done');
    },
  };

  const powerpoint: Tool = {
    schema: {
      name: 'powerpoint_work',
      status: 'Working in PowerPoint…',
      requiresConfirmation: true,
      description:
        'Microsoft PowerPoint, in the presentation the user has open. `action` picks one; `options` is a JSON object for it. ' +
        'status: {} — the slides with their titles (start here). read: {"slide":3} (default every slide, up to 40) — the text of each shape, tables, pictures, notes. ' +
        'add_slide: {"layout":"title"|"title_content"|"two_content"|"title_only"|"blank","title":"Plan","bullets":["First","Second"],"subtitle":"…","notes":"…","index":2}. ' +
        'set_text: {"slide":2,"shape":"title"|"body"|"Content Placeholder 2"|3,"text":"New words"} replaces that shape\'s text. ' +
        'format_text: {"slide":2,"shape":"title","bold":true,"italic":false,"fontSize":32,"fontName":"Calibri","color":"#1F4E78","align":"center"}. ' +
        'add_table: {"slide":4,"rows":[["Item","Cost"],["Pen","5"]],"left":40,"top":120,"width":600}. add_picture: {"slide":2,"path":"C:\\\\…\\\\logo.png","left":60,"top":120,"width":300} (a picture file the user has). ' +
        'slide: {"action":"delete"|"duplicate"|"move"|"notes","slide":3,"to":1,"text":"speaker notes"} (delete needs confirm=true). new: {} — a new presentation. ' +
        'save: {} saves in place; {"path":"C:\\\\Users\\\\...\\\\Documents\\\\talk.pptx"} saves a new file (only in the user\'s own folders; replacing a file needs confirm=true). ' +
        'PowerPoint cannot undo this: tell the user what you changed. Do what the user asked at once.',
      args: {
        action: { type: 'string', required: true, enum: PPT_ACTIONS },
        options: { type: 'string', description: 'A JSON object with the settings for this action (see above).' },
        confirm: { type: 'boolean', description: 'Set true only after the user said yes to deleting a slide or replacing a file.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const action = typeof args['action'] === 'string' ? (args['action'] as (typeof PPT_ACTIONS)[number]) : undefined;
      if (action === undefined || !PPT_ACTIONS.includes(action)) return failure('unknown action', `action must be one of: ${PPT_ACTIONS.join(', ')}.`);
      const parsed = parseOptions(args, '{"layout":"title_content","title":"Plan","bullets":["First","Second"]}');
      if ('error' in parsed) return parsed.error;
      const confirm = args['confirm'] === true;
      const options: Bag = { ...parsed.options, ...(confirm ? { confirm: true } : {}) };
      if (action === 'save') {
        const saved = savePath(options, ['.pptx', '.ppt'], confirm, deps.folders, exists);
        if (saved.error !== undefined) return saved.error;
        if (saved.path !== undefined) options['path'] = saved.path;
        else delete options['path'];
      }
      if (action === 'add_picture') {
        const p = typeof options['path'] === 'string' ? options['path'].trim() : '';
        const check = checkReadablePath(p, deps.folders);
        if (!check.ok) return failure('not allowed', check.reason);
        if (!['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff'].includes(extname(check.path).toLowerCase())) return failure('not a picture', 'That is not a picture file (png, jpg, gif, bmp).');
        options['path'] = check.path;
      }
      const answer = await deps.office.run('powerpoint', action, options);
      const summary: Record<string, string> = {
        status: 'looked at PowerPoint',
        read: 'read the slides',
        add_slide: `added slide ${String(answer['slide'] ?? '')}`,
        set_text: `changed the text on slide ${String(answer['slide'] ?? '')}`,
        format_text: `formatted the text on slide ${String(answer['slide'] ?? '')}`,
        add_table: `added a table to slide ${String(answer['slide'] ?? '')}`,
        add_picture: `added the picture to slide ${String(answer['slide'] ?? '')}`,
        slide: 'changed the slides',
        new: 'opened a new presentation',
        save: 'saved the presentation',
      };
      return toResult('PowerPoint', answer, summary[action] ?? 'done');
    },
  };

  return [excel, powerpoint];
}
