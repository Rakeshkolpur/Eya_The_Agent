/**
 * A document as a layout: what a picture of a page shows, written down so that Word can be told to build it. Pure.
 *
 * The model that reads the picture answers in JSON; it is untrusted text, so it is cleaned here before anything reaches Word: wrong types are fixed or dropped, numbers are kept in sensible
 * ranges, only known kinds of block are kept, and the size is limited. After Word has built it, `compareBuilt` says whether what Word holds has the same shape as the layout.
 */

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  font?: string;
  size?: number;
  color?: string;
  highlight?: string;
}

export interface ParaLook {
  align?: 'left' | 'center' | 'right' | 'justify';
  spaceBefore?: number;
  spaceAfter?: number;
  lineSpacing?: number;
  indentLeftCm?: number;
  indentRightCm?: number;
  firstLineCm?: number;
  hangingCm?: number;
  keepWithNext?: boolean;
  list?: 'bullet' | 'number';
  listLevel?: number;
}

export interface ParagraphBlock extends ParaLook, Omit<Run, 'text'> {
  type: 'paragraph';
  text?: string;
  runs?: Run[];
}

export interface HeadingBlock extends ParaLook, Omit<Run, 'text'> {
  type: 'heading';
  level: number;
  text?: string;
  runs?: Run[];
}

export interface Cell extends Omit<Run, 'text'> {
  text?: string;
  runs?: Run[];
  align?: 'left' | 'center' | 'right' | 'justify';
  vAlign?: 'top' | 'center' | 'bottom';
  shade?: string;
  colSpan?: number;
  rowSpan?: number;
}

export interface TableBlock {
  type: 'table';
  rows: Cell[][];
  colWidthsPct?: number[];
  borders?: 'all' | 'none' | 'outer';
  headerRows?: number;
  align?: 'left' | 'center' | 'right';
  size?: number;
}

export type Block = ParagraphBlock | HeadingBlock | TableBlock | { type: 'pagebreak' } | { type: 'line' };

export interface DocSpec {
  page?: { paper?: 'a4' | 'letter' | 'legal' | 'a3' | 'a5'; orientation?: 'portrait' | 'landscape'; marginTopCm?: number; marginBottomCm?: number; marginLeftCm?: number; marginRightCm?: number };
  defaults?: { font?: string; size?: number; lineSpacing?: number; spaceAfter?: number };
  blocks: Block[];
}

export const LIMITS = { blocks: 600, tableRows: 80, tableCols: 20, runs: 60, textChars: 20_000 } as const;

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const num = (v: unknown, min: number, max: number): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (typeof v === 'string' && (allowed as readonly string[]).includes(v.trim().toLowerCase()) ? (v.trim().toLowerCase() as T) : undefined);

const COLOR_NAMES = ['black', 'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'gray', 'grey', 'white', 'darkblue', 'darkred'];
const HIGHLIGHTS = ['yellow', 'green', 'turquoise', 'pink', 'blue', 'red', 'gray', 'none'];
const ALIGNS = ['left', 'center', 'right', 'justify'] as const;

function color(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (COLOR_NAMES.includes(s)) return s;
  const m = /^#?([0-9a-f]{6})$/.exec(s);
  return m?.[1] !== undefined ? `#${m[1].toUpperCase()}` : undefined;
}

function runLook(o: Raw): Omit<Run, 'text'> {
  const out: Omit<Run, 'text'> = {};
  const b = bool(o['bold']);
  if (b !== undefined) out.bold = b;
  const i = bool(o['italic']);
  if (i !== undefined) out.italic = i;
  const u = bool(o['underline']);
  if (u !== undefined) out.underline = u;
  const s = bool(o['strike']);
  if (s !== undefined) out.strike = s;
  const sup = bool(o['superscript']);
  if (sup === true) out.superscript = true;
  const sub = bool(o['subscript']);
  if (sub === true) out.subscript = true;
  const font = str(o['font'], 60)?.trim();
  if (font !== undefined && font !== '') out.font = font;
  const size = num(o['size'], 1, 400);
  if (size !== undefined) out.size = Math.round(size * 2) / 2;
  const c = color(o['color']);
  if (c !== undefined) out.color = c;
  const h = oneOf(o['highlight'], HIGHLIGHTS);
  if (h !== undefined) out.highlight = h;
  return out;
}

function runs(v: unknown): Run[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Run[] = [];
  for (const r of v.slice(0, LIMITS.runs)) {
    if (typeof r === 'string') {
      if (r !== '') out.push({ text: r });
    } else if (isObj(r) && typeof r['text'] === 'string' && r['text'] !== '') out.push({ text: r['text'].slice(0, LIMITS.textChars), ...runLook(r) });
  }
  return out.length > 0 ? out : undefined;
}

function paraLook(o: Raw): ParaLook {
  const out: ParaLook = {};
  const a = oneOf(o['align'], ALIGNS);
  if (a !== undefined) out.align = a;
  for (const k of ['spaceBefore', 'spaceAfter'] as const) {
    const n = num(o[k], 0, 200);
    if (n !== undefined) out[k] = n;
  }
  const ls = num(o['lineSpacing'], 0.5, 5);
  if (ls !== undefined) out.lineSpacing = ls;
  for (const k of ['indentLeftCm', 'indentRightCm', 'firstLineCm', 'hangingCm'] as const) {
    const n = num(o[k], 0, 30);
    if (n !== undefined && n > 0) out[k] = n;
  }
  const kwn = bool(o['keepWithNext']);
  if (kwn !== undefined) out.keepWithNext = kwn;
  const list = typeof o['list'] === 'string' ? o['list'].trim().toLowerCase() : '';
  if (list === 'bullet' || list === 'bullets') out.list = 'bullet';
  else if (list === 'number' || list === 'numbers' || list === 'numbered') out.list = 'number';
  const lvl = num(o['listLevel'], 1, 9);
  if (lvl !== undefined && out.list !== undefined) out.listLevel = Math.round(lvl);
  return out;
}

function cell(v: unknown): Cell {
  if (typeof v === 'string' || typeof v === 'number') return { text: String(v).slice(0, LIMITS.textChars) };
  if (!isObj(v)) return { text: '' };
  const out: Cell = { ...runLook(v) };
  const r = runs(v['runs']);
  if (r !== undefined) out.runs = r;
  else if (typeof v['text'] === 'string' || typeof v['text'] === 'number') out.text = String(v['text']).slice(0, LIMITS.textChars);
  else out.text = '';
  const a = oneOf(v['align'], ALIGNS);
  if (a !== undefined) out.align = a;
  const va = oneOf(v['vAlign'], ['top', 'center', 'bottom'] as const) ?? (v['vAlign'] === 'middle' ? 'center' : undefined);
  if (va !== undefined) out.vAlign = va;
  const sh = color(v['shade']);
  if (sh !== undefined) out.shade = sh;
  const cs = num(v['colSpan'], 1, LIMITS.tableCols);
  if (cs !== undefined && cs > 1) out.colSpan = Math.round(cs);
  const rs = num(v['rowSpan'], 1, LIMITS.tableRows);
  if (rs !== undefined && rs > 1) out.rowSpan = Math.round(rs);
  return out;
}

export interface Normalized {
  readonly ok: boolean;
  readonly spec?: DocSpec;
  readonly dropped: string[];
  readonly error?: string;
}

/** A layout from whatever the model returned: only what is known and sensible is kept, and what was dropped is said. */
export function normalizeDocSpec(raw: unknown): Normalized {
  const dropped: string[] = [];
  if (!isObj(raw)) return { ok: false, dropped, error: 'the layout is not an object' };
  const blocksIn = raw['blocks'];
  if (!Array.isArray(blocksIn) || blocksIn.length === 0) return { ok: false, dropped, error: 'the layout has no blocks' };
  if (blocksIn.length > LIMITS.blocks) dropped.push(`only the first ${LIMITS.blocks} of ${blocksIn.length} blocks were kept`);
  const blocks: Block[] = [];
  blocksIn.slice(0, LIMITS.blocks).forEach((b, i) => {
    if (!isObj(b)) {
      dropped.push(`block ${i + 1} was not an object`);
      return;
    }
    const type = typeof b['type'] === 'string' ? b['type'].trim().toLowerCase() : '';
    if (type === 'paragraph' || type === 'heading') {
      const r = runs(b['runs']);
      const text = typeof b['text'] === 'string' ? b['text'].slice(0, LIMITS.textChars) : undefined;
      if (r === undefined && (text === undefined || text === '')) {
        // an empty line in the picture is kept as an empty paragraph (it is spacing), as a single space
        blocks.push({ type: 'paragraph', text: ' ' });
        return;
      }
      const base = { ...runLook(b), ...paraLook(b), ...(r !== undefined ? { runs: r } : { text: text as string }) };
      if (type === 'heading') blocks.push({ type: 'heading', level: Math.round(num(b['level'], 1, 6) ?? 1), ...base });
      else blocks.push({ type: 'paragraph', ...base });
    } else if (type === 'table') {
      const rowsIn = b['rows'];
      if (!Array.isArray(rowsIn) || rowsIn.length === 0) {
        dropped.push(`block ${i + 1}: a table with no rows`);
        return;
      }
      const rows = rowsIn.slice(0, LIMITS.tableRows).map((row) => (Array.isArray(row) ? row.slice(0, LIMITS.tableCols).map(cell) : [cell(row)]));
      if (rowsIn.length > LIMITS.tableRows) dropped.push(`block ${i + 1}: only the first ${LIMITS.tableRows} rows of the table were kept`);
      const t: TableBlock = { type: 'table', rows };
      if (Array.isArray(b['colWidthsPct'])) {
        const w = b['colWidthsPct'].map((x) => num(x, 1, 100)).filter((x): x is number => x !== undefined);
        const total = w.reduce((s, x) => s + x, 0);
        // widths that add up to more than the page are scaled to 100 (a table wider than the page is the usual fault, not what the picture shows)
        if (w.length > 0) t.colWidthsPct = total > 100 ? w.map((x) => Math.round((x * 1000) / total) / 10) : w;
      }
      const bd = oneOf(b['borders'], ['all', 'none', 'outer'] as const);
      if (bd !== undefined) t.borders = bd;
      const hr = num(b['headerRows'], 0, rows.length);
      if (hr !== undefined && hr > 0) t.headerRows = Math.round(hr);
      const al = oneOf(b['align'], ['left', 'center', 'right'] as const);
      if (al !== undefined) t.align = al;
      const sz = num(b['size'], 1, 400);
      if (sz !== undefined) t.size = sz;
      blocks.push(t);
    } else if (type === 'pagebreak' || type === 'page_break') blocks.push({ type: 'pagebreak' });
    else if (type === 'line' || type === 'rule' || type === 'hr') blocks.push({ type: 'line' });
    else dropped.push(`block ${i + 1}: "${type.slice(0, 20)}" is not a kind I can build`);
  });
  if (blocks.length === 0) return { ok: false, dropped, error: 'nothing in the layout could be built' };
  const spec: DocSpec = { blocks };
  if (isObj(raw['page'])) {
    const p = raw['page'];
    const page: NonNullable<DocSpec['page']> = {};
    const paper = oneOf(p['paper'], ['a4', 'letter', 'legal', 'a3', 'a5'] as const);
    if (paper !== undefined) page.paper = paper;
    const orientation = oneOf(p['orientation'], ['portrait', 'landscape'] as const);
    if (orientation !== undefined) page.orientation = orientation;
    for (const k of ['marginTopCm', 'marginBottomCm', 'marginLeftCm', 'marginRightCm'] as const) {
      const n = num(p[k], 0, 10);
      if (n !== undefined) page[k] = n;
    }
    if (Object.keys(page).length > 0) spec.page = page;
  }
  if (isObj(raw['defaults'])) {
    const d = raw['defaults'];
    const defaults: NonNullable<DocSpec['defaults']> = {};
    const font = str(d['font'], 60)?.trim();
    if (font !== undefined && font !== '') defaults.font = font;
    const size = num(d['size'], 6, 72);
    if (size !== undefined) defaults.size = size;
    const ls = num(d['lineSpacing'], 0.5, 5);
    if (ls !== undefined) defaults.lineSpacing = ls;
    const sa = num(d['spaceAfter'], 0, 100);
    if (sa !== undefined) defaults.spaceAfter = sa;
    if (Object.keys(defaults).length > 0) spec.defaults = defaults;
  }
  return { ok: true, spec, dropped };
}

/** JSON out of a model's answer: it may come in a code fence, with words around it, or with a trailing comma. Null when there is none. */
export function parseModelJson(text: string): unknown {
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence?.[1] !== undefined) s = fence[1].trim();
  const from = s.indexOf('{');
  const to = s.lastIndexOf('}');
  if (from < 0 || to <= from) return null;
  s = s.slice(from, to + 1);
  const attempts = [s, s.replace(/,\s*([}\]])/g, '$1')];
  for (const a of attempts) {
    try {
      return JSON.parse(a) as unknown;
    } catch {
      // (try the next form)
    }
  }
  return null;
}

/** How many rows and columns the grid of a table needs, counting merged cells the way Word will lay them out. */
export function gridOf(t: TableBlock): { rows: number; columns: number } {
  const taken = new Set<string>();
  let columns = 0;
  let rows = t.rows.length;
  t.rows.forEach((row, ri) => {
    let c = 1;
    for (const cellIn of row) {
      while (taken.has(`${ri + 1},${c}`)) c += 1;
      const cs = cellIn.colSpan ?? 1;
      const rs = cellIn.rowSpan ?? 1;
      for (let dr = 0; dr < rs; dr += 1) for (let dc = 0; dc < cs; dc += 1) taken.add(`${ri + 1 + dr},${c + dc}`);
      rows = Math.max(rows, ri + rs);
      c += cs;
    }
    columns = Math.max(columns, c - 1);
  });
  return { rows, columns };
}

export interface Shape {
  readonly headings: number;
  readonly paragraphs: number;
  readonly tables: ReadonlyArray<{ rows: number; columns: number }>;
  readonly pageBreaks: number;
}

export function shapeOf(spec: DocSpec): Shape {
  const tables = spec.blocks.filter((b): b is TableBlock => b.type === 'table').map(gridOf);
  return { headings: spec.blocks.filter((b) => b.type === 'heading').length, paragraphs: spec.blocks.filter((b) => b.type === 'paragraph').length, tables, pageBreaks: spec.blocks.filter((b) => b.type === 'pagebreak').length };
}

/** What the Word helper answered after building: counts of what it made. */
export type Built = Readonly<Record<string, unknown>>;

/** Whether what Word holds has the shape of the layout (the same headings, tables, rows and columns, page breaks). */
export function compareBuilt(spec: DocSpec, built: Built): { readonly same: boolean; readonly differences: string[] } {
  const want = shapeOf(spec);
  const diff: string[] = [];
  const headings = built['headings'];
  const tables = built['tables'];
  const pageBreaks = built['pageBreaks'];
  if (typeof headings === 'number' && headings !== want.headings) diff.push(`${want.headings} heading(s) were recognised but Word has ${headings}`);
  if (typeof tables === 'number' && tables !== want.tables.length) diff.push(`${want.tables.length} table(s) were recognised but Word has ${tables}`);
  const rows = Array.isArray(built['tableRows']) ? (built['tableRows'] as number[]) : [];
  const cols = Array.isArray(built['tableColumns']) ? (built['tableColumns'] as number[]) : [];
  want.tables.forEach((t, i) => {
    if (rows[i] !== undefined && rows[i] !== t.rows) diff.push(`table ${i + 1} should have ${t.rows} rows but has ${rows[i]}`);
    if (cols[i] !== undefined && cols[i] !== t.columns) diff.push(`table ${i + 1} should have ${t.columns} columns but has ${cols[i]}`);
  });
  if (typeof pageBreaks === 'number' && pageBreaks !== want.pageBreaks) diff.push(`${want.pageBreaks} page break(s) were recognised but Word has ${pageBreaks}`);
  return { same: diff.length === 0, differences: diff };
}

/** What was recognised, in a few plain words, for telling the person. */
export function describeSpec(spec: DocSpec): string {
  const s = shapeOf(spec);
  const parts = [`${s.headings} heading${s.headings === 1 ? '' : 's'}`, `${s.paragraphs} paragraph${s.paragraphs === 1 ? '' : 's'}`];
  for (const [i, t] of s.tables.entries()) parts.push(`table ${i + 1} (${t.rows} rows × ${t.columns} columns)`);
  if (s.pageBreaks > 0) parts.push(`${s.pageBreaks} page break${s.pageBreaks === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/** What a model is asked when it reads the picture of a page. */
export const EXTRACTION_PROMPT = [
  'You are reading a picture of a document page so that it can be rebuilt in Microsoft Word EXACTLY as it looks. Answer with ONE JSON object and nothing else (no explanation, no code fence).',
  'Copy the words EXACTLY as printed or written: do not correct, translate, summarise or reorder anything, keep every language (English, Hindi, Telugu ...), numbers, dates, punctuation and line breaks as they are.',
  'Describe the layout in reading order, top to bottom, as "blocks". The schema:',
  '{"page":{"paper":"a4|letter|legal|a3|a5","orientation":"portrait|landscape","marginTopCm":2.5,"marginBottomCm":2.5,"marginLeftCm":3,"marginRightCm":2},',
  ' "defaults":{"font":"Times New Roman","size":12,"lineSpacing":1.15,"spaceAfter":6},',
  ' "blocks":[',
  '  {"type":"heading","level":1,"text":"…","align":"center","bold":true,"size":16},',
  '  {"type":"paragraph","align":"left|center|right|justify","runs":[{"text":"plain "},{"text":"bold","bold":true},{"text":"italic","italic":true},{"text":"underlined","underline":true},{"text":"red","color":"#FF0000"}],"spaceBefore":0,"spaceAfter":6,"lineSpacing":1.15,"indentLeftCm":0,"firstLineCm":1.27,"list":"bullet|number","listLevel":1},',
  '  {"type":"table","headerRows":1,"borders":"all|none|outer","colWidthsPct":[10,50,40],"rows":[[{"text":"S.No","bold":true,"shade":"#D9D9D9","align":"center"},{"text":"Particulars","bold":true},{"text":"Amount","align":"right"}],[{"text":"Total","colSpan":2,"bold":true},{"text":"1,000","align":"right"}]]},',
  '  {"type":"pagebreak"}, {"type":"line"} ]}',
  'Rules: use "runs" whenever a line mixes styles, otherwise "text". A title or section heading is a "heading" (level 1 for the biggest). An empty line used as spacing is {"type":"paragraph","text":" "}.',
  'Tables: one object per table; EVERY cell of every row in order; a cell that spans columns has "colSpan", one that spans rows has "rowSpan" (and the cells it covers are NOT repeated in the other rows); give "colWidthsPct" that add up to 100; "borders":"none" only if no lines are visible; "shade" for a coloured cell; "bold" for header cells.',
  'Sizes are in points as best you can tell from the picture (body text is usually 11 or 12, headings larger); the font is "Times New Roman" for serif text and "Arial" for sans-serif unless you can tell better. Colours are #RRGGBB. Page numbers, headers and footers that are printed on the page are blocks at the end or start like any other text.',
  'If a part is unreadable, give your best reading of it rather than leaving it out. Do not invent content that is not in the picture.',
].join('\n');
