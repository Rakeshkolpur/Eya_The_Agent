/**
 * Reading a document the way a clerk would, to learn from it: which parts it has (cause title, synopsis, list of dates, grounds, prayer…),
 * how long each is, how each is formatted, and what it says. Pure: it works on Word's own XML for the body of the document, so it can be
 * tested without Word and runs in milliseconds. The page each part starts on needs Word's layout and is filled in afterwards.
 */

export type Align = 'left' | 'center' | 'right' | 'justify';

export interface ParaInfo {
  /** Position among the body's paragraphs (a table row counts as one). */
  readonly index: number;
  readonly text: string;
  readonly style: string;
  readonly align: Align | null;
  readonly bold: boolean;
  readonly underline: boolean;
  readonly caps: boolean;
  readonly sizePt: number | null;
  readonly font: string | null;
  readonly numbered: boolean;
  readonly firstLineCm: number | null;
  readonly leftCm: number | null;
  readonly lineSpacing: number | null;
  readonly inTable: boolean;
  /** This paragraph is where a hard page break sits. */
  readonly pageBreak: boolean;
  readonly isTitle: boolean;
  readonly level: number;
}

export interface Look {
  readonly align: Align | null;
  readonly bold: boolean;
  readonly underline: boolean;
  readonly caps: boolean;
  readonly sizePt: number | null;
  readonly font: string | null;
  readonly lineSpacing: number | null;
  readonly firstLineCm: number | null;
  readonly leftCm: number | null;
}

export interface SectionInfo {
  /** The first title line of the part ("SYNOPSIS"). */
  readonly title: string;
  /** Every title line when several came together (a cause title is a block of them). */
  readonly titleLines: readonly string[];
  readonly level: number;
  readonly startParagraph: number;
  readonly paragraphs: number;
  readonly words: number;
  readonly tables: number;
  readonly tableRows: number;
  readonly numberedShare: number;
  /** How the title lines look, and how the body of the part looks. */
  readonly titleLook: Look;
  readonly bodyLook: Look;
  readonly sample: string;
  /** The part's text, one paragraph per line (a table row is "a | b | c"), cut to a fair length. */
  readonly text: string;
  startPage?: number;
  endPage?: number;
}

export interface Profile {
  readonly body: Look;
  readonly titles: Look;
  /** How many of the body's paragraphs are numbered (1. 2. 3. or (a) (b)). */
  readonly numberedShare: number;
  readonly paragraphs: number;
  readonly sections: number;
}

const MAX_SECTION_TEXT = 8000;
const TWIPS_PER_CM = 567;

// ------------------------------------------------------------------------------------------------------------------ the XML
function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

const attr = (chunk: string, tag: string, name: string): string | null => {
  const m = new RegExp(`<w:${tag}\\b[^>]*\\bw:${name}="([^"]*)"`).exec(chunk);
  return m === null ? null : (m[1] as string);
};

/** `<w:b/>` is on; `<w:b w:val="0"/>` (or false / off) is off; absent is off. */
function flag(rPr: string, tag: string): boolean {
  const m = new RegExp(`<w:${tag}(?:\\s[^>]*)?/?>`).exec(rPr);
  if (m === null) return false;
  const val = /w:val="([^"]*)"/.exec(m[0]);
  return val === null ? true : !/^(0|false|off|none)$/i.test(val[1] as string);
}

interface RunFacts {
  readonly text: string;
  readonly bold: boolean;
  readonly underline: boolean;
  readonly caps: boolean;
  readonly sizePt: number | null;
  readonly font: string | null;
  readonly pageBreak: boolean;
}

function parseRun(run: string): RunFacts {
  const rPr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run)?.[1] ?? '';
  let text = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>|<w:noBreakHyphen\/>/g;
  let m: RegExpExecArray | null;
  let pageBreak = false;
  while ((m = re.exec(run)) !== null) {
    if (m[1] !== undefined) text += decode(m[1]);
    else if (m[0] === '<w:tab/>') text += '\t';
    else if (m[0] === '<w:noBreakHyphen/>') text += '-';
    else if (/w:type="page"/.test(m[0])) pageBreak = true;
    else text += '\n';
  }
  const underline = ((): boolean => {
    const u = attr(rPr, 'u', 'val');
    return u !== null && u !== 'none';
  })();
  const sz = attr(rPr, 'sz', 'val');
  return {
    text,
    bold: flag(rPr, 'b'),
    underline,
    caps: flag(rPr, 'caps') || flag(rPr, 'smallCaps'),
    sizePt: sz !== null && /^\d+$/.test(sz) ? Number(sz) / 2 : null,
    font: attr(rPr, 'rFonts', 'ascii') ?? attr(rPr, 'rFonts', 'hAnsi'),
    pageBreak,
  };
}

const ALIGN: Readonly<Record<string, Align>> = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' };

/** Share of letters that are capitals (letters from scripts without case count as not capitals, so only Latin text is judged). */
function capitalShare(text: string): number {
  let letters = 0;
  let caps = 0;
  for (const ch of text) {
    if (ch.toLowerCase() !== ch.toUpperCase()) {
      letters += 1;
      if (ch === ch.toUpperCase()) caps += 1;
    }
  }
  return letters === 0 ? 0 : caps / letters;
}

function words(text: string): number {
  const t = text.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

const NUMBERED_START = /^\s*(?:\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|\([ivxlc]+\)|[ivxlc]+[.)])\s+\S/;

interface RawParagraph {
  readonly text: string;
  readonly style: string;
  readonly align: Align | null;
  readonly bold: boolean;
  readonly underline: boolean;
  readonly caps: boolean;
  readonly sizePt: number | null;
  readonly font: string | null;
  readonly numPr: boolean;
  readonly firstLineCm: number | null;
  readonly leftCm: number | null;
  readonly lineSpacing: number | null;
  readonly pageBreak: boolean;
  readonly pageBreakBefore: boolean;
}

function parseParagraph(chunk: string): RawParagraph {
  const pPr = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(chunk)?.[1] ?? '';
  // Properties of the paragraph itself, not those of its paragraph mark.
  const own = pPr.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, '');
  const runs = [...chunk.matchAll(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g)].map((m) => parseRun(m[0]));
  const spoken = runs.filter((r) => r.text.trim() !== '');
  const jc = attr(own, 'jc', 'val');
  const spacingLine = attr(own, 'spacing', 'line');
  const rule = attr(own, 'spacing', 'lineRule');
  const first = attr(own, 'ind', 'firstLine');
  const hanging = attr(own, 'ind', 'hanging');
  const left = attr(own, 'ind', 'left') ?? attr(own, 'ind', 'start');
  const twips = (v: string | null): number | null => (v !== null && /^-?\d+$/.test(v) ? Math.round((Number(v) / TWIPS_PER_CM) * 10) / 10 : null);
  const sizes = spoken.map((r) => r.sizePt).filter((x): x is number => x !== null);
  const fonts = spoken.map((r) => r.font).filter((x): x is string => x !== null);
  return {
    text: runs.map((r) => r.text).join(''),
    style: attr(own, 'pStyle', 'val') ?? '',
    align: jc !== null ? (ALIGN[jc] ?? null) : null,
    bold: spoken.length > 0 && spoken.every((r) => r.bold),
    underline: spoken.length > 0 && spoken.every((r) => r.underline),
    caps: spoken.length > 0 && spoken.every((r) => r.caps),
    sizePt: sizes.length > 0 ? Math.max(...sizes) : null,
    font: fonts[0] ?? null,
    numPr: /<w:numPr>/.test(own),
    firstLineCm: first !== null ? twips(first) : hanging !== null && twips(hanging) !== null ? -(twips(hanging) as number) : null,
    leftCm: twips(left),
    lineSpacing: spacingLine !== null && /^\d+$/.test(spacingLine) && (rule === null || rule === 'auto') ? Math.round((Number(spacingLine) / 240) * 100) / 100 : null,
    pageBreak: runs.some((r) => r.pageBreak),
    pageBreakBefore: /<w:pageBreakBefore\b(?![^>]*w:val="(?:0|false)")/.test(own),
  };
}

/**
 * The body's paragraphs in order. A table's rows come out as one entry each ("cell | cell | cell"), marked as in a table; titles are
 * decided here from how a line looks (a heading style, or short capitals / bold / centred / underlined), which is how legal drafts are
 * actually laid out — they rarely use Word's heading styles.
 */
export function parseBody(bodyXml: string): ParaInfo[] {
  const out: ParaInfo[] = [];
  const token = /<w:tbl>|<\/w:tbl>|<w:tr(?:\s[^>]*)?>|<\/w:tr>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  let tableDepth = 0;
  let rowCells: string[] = [];
  let m: RegExpExecArray | null;
  const push = (raw: RawParagraph, inTable: boolean, textOverride?: string): void => {
    const text = (textOverride ?? raw.text).replace(/[  ]/g, ' ');
    const style = raw.style;
    const headingStyle = /^(?:Heading\s*\d|Title|Subtitle)/i.test(style);
    const trimmed = text.trim();
    const numberedText = NUMBERED_START.test(trimmed);
    const wordCount = words(trimmed);
    let score = 0;
    if (!inTable && trimmed.length > 0) {
      if (headingStyle) score += 4;
      if (trimmed.length >= 3 && capitalShare(trimmed) >= 0.8) score += 2;
      if (raw.bold) score += 1;
      if (raw.align === 'center') score += 1;
      if (raw.underline) score += 1;
      if (raw.caps) score += 1;
      // A very short line that stands out is a title even in ordinary case: "Synopsis", "Grounds" in bold, centred.
      if (wordCount <= 5 && trimmed.length <= 60 && (raw.bold || raw.align === 'center' || raw.underline)) score += 1;
      if (numberedText || raw.numPr) score -= 3;
      if (wordCount > 12) score -= 3;
      if (trimmed.length > 100) score -= 3;
      if (/[.;,]$/.test(trimmed) && wordCount > 6) score -= 2;
    }
    const level = /^Heading\s*(\d)/i.exec(style)?.[1];
    out.push({
      index: out.length,
      text: trimmed,
      style,
      align: raw.align,
      bold: raw.bold || headingStyle,
      underline: raw.underline,
      caps: raw.caps,
      sizePt: raw.sizePt,
      font: raw.font,
      numbered: raw.numPr || numberedText,
      firstLineCm: raw.firstLineCm,
      leftCm: raw.leftCm,
      lineSpacing: raw.lineSpacing,
      inTable,
      pageBreak: raw.pageBreak || raw.pageBreakBefore,
      isTitle: !inTable && trimmed.length > 0 && score >= 3,
      level: level !== undefined ? Number(level) : 1,
    });
  };
  while ((m = token.exec(bodyXml)) !== null) {
    const t = m[0];
    if (t === '<w:tbl>') tableDepth += 1;
    else if (t === '</w:tbl>') tableDepth = Math.max(0, tableDepth - 1);
    else if (t.startsWith('<w:tr')) rowCells = [];
    else if (t === '</w:tr>') {
      const cells = rowCells.filter((c) => c.trim() !== '');
      if (cells.length > 0) {
        push({ text: '', style: '', align: null, bold: false, underline: false, caps: false, sizePt: null, font: null, numPr: false, firstLineCm: null, leftCm: null, lineSpacing: null, pageBreak: false, pageBreakBefore: false }, true, cells.join(' | '));
      }
      rowCells = [];
    } else {
      const para = parseParagraph(t);
      if (tableDepth > 0) rowCells.push(para.text.replace(/\s+/g, ' ').trim());
      else push(para, false);
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------------------------------- looks
function mode<T>(items: readonly (T | null)[], weights?: readonly number[]): T | null {
  const tally = new Map<string, { value: T; weight: number }>();
  items.forEach((v, i) => {
    if (v === null) return;
    const key = String(v);
    const w = weights?.[i] ?? 1;
    const cur = tally.get(key);
    if (cur === undefined) tally.set(key, { value: v, weight: w });
    else cur.weight += w;
  });
  let best: { value: T; weight: number } | null = null;
  for (const e of tally.values()) if (best === null || e.weight > best.weight) best = e;
  return best === null ? null : best.value;
}

const share = (flags: readonly boolean[]): number => (flags.length === 0 ? 0 : flags.filter(Boolean).length / flags.length);

export function lookOf(paras: readonly ParaInfo[]): Look {
  const weights = paras.map((p) => Math.max(1, p.text.length));
  return {
    align: mode(paras.map((p) => p.align), weights),
    bold: share(paras.map((p) => p.bold)) >= 0.6,
    underline: share(paras.map((p) => p.underline)) >= 0.6,
    caps: share(paras.map((p) => p.caps)) >= 0.6,
    sizePt: mode(paras.map((p) => p.sizePt), weights),
    font: mode(paras.map((p) => p.font), weights),
    lineSpacing: mode(paras.map((p) => p.lineSpacing), weights),
    firstLineCm: mode(paras.map((p) => p.firstLineCm), weights),
    leftCm: mode(paras.map((p) => p.leftCm), weights),
  };
}

// ----------------------------------------------------------------------------------------------------------------- sections
const EMPTY_LOOK: Look = { align: null, bold: false, underline: false, caps: false, sizePt: null, font: null, lineSpacing: null, firstLineCm: null, leftCm: null };

/**
 * The parts of the document. Every title starts one, so a title with nothing under it is a part that is still empty (which is exactly what
 * matters when a half-done document is compared). Whatever comes before the first title is the opening.
 */
export function buildSections(paras: readonly ParaInfo[]): SectionInfo[] {
  interface Draft {
    titles: ParaInfo[];
    body: ParaInfo[];
    start: number;
  }
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  for (const p of paras) {
    if (p.isTitle) {
      current = { titles: [p], body: [], start: p.index };
      drafts.push(current);
    } else {
      if (current === null) {
        current = { titles: [], body: [], start: p.index };
        drafts.push(current);
      }
      current.body.push(p);
    }
  }
  return drafts
    .filter((d) => d.titles.length > 0 || d.body.some((p) => p.text !== ''))
    .map((d): SectionInfo => {
      const lines = d.body.map((p) => p.text).filter((t) => t !== '');
      const fullText = lines.join('\n');
      const prose = d.body.filter((p) => !p.inTable && p.text !== '');
      const tableRows = d.body.filter((p) => p.inTable).length;
      const titleLines = d.titles.map((t) => t.text);
      return {
        title: titleLines[0] ?? 'Opening (before the first heading)',
        titleLines,
        level: d.titles[0]?.level ?? 1,
        startParagraph: d.start,
        paragraphs: prose.length,
        words: words(fullText),
        tables: tableRows > 0 ? 1 : 0,
        tableRows,
        numberedShare: prose.length === 0 ? 0 : share(prose.map((p) => p.numbered)),
        titleLook: d.titles.length > 0 ? lookOf(d.titles) : EMPTY_LOOK,
        bodyLook: prose.length > 0 ? lookOf(prose) : EMPTY_LOOK,
        sample: fullText.slice(0, 240),
        text: fullText.length > MAX_SECTION_TEXT ? `${fullText.slice(0, MAX_SECTION_TEXT)}\n[…cut: ${fullText.length - MAX_SECTION_TEXT} more characters]` : fullText,
      };
    });
}

export function buildProfile(paras: readonly ParaInfo[], sections: readonly SectionInfo[]): Profile {
  const body = paras.filter((p) => !p.isTitle && !p.inTable && p.text.length > 20);
  const titles = paras.filter((p) => p.isTitle);
  return {
    body: body.length > 0 ? lookOf(body) : EMPTY_LOOK,
    titles: titles.length > 0 ? lookOf(titles) : EMPTY_LOOK,
    numberedShare: body.length === 0 ? 0 : share(body.map((p) => p.numbered)),
    paragraphs: paras.filter((p) => p.text !== '').length,
    sections: sections.length,
  };
}

// ------------------------------------------------------------------------------------------------------------------ describing
const lookWords = (l: Look): string =>
  [
    l.font !== null ? l.font : null,
    l.sizePt !== null ? `${l.sizePt} pt` : null,
    l.align !== null ? l.align : null,
    l.bold ? 'bold' : null,
    l.underline ? 'underlined' : null,
    l.caps ? 'capitals' : null,
    l.lineSpacing !== null ? `${l.lineSpacing} line spacing` : null,
    l.firstLineCm !== null && l.firstLineCm !== 0 ? `${l.firstLineCm > 0 ? 'first line indent' : 'hanging indent'} ${Math.abs(l.firstLineCm)} cm` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(', ');

export function describeLook(l: Look): string {
  const w = lookWords(l);
  return w === '' ? 'as the document\'s default' : w;
}

/** "p1 — IN THE HIGH COURT… (cause title; 6 lines) / p2-3 — SYNOPSIS (12 paragraphs, 340 words; justified…)": the page map. */
export function pageMap(sections: readonly SectionInfo[]): string[] {
  // Heading lines that have nothing under them (a cause title: court, case number, "BETWEEN:") read as one block with the part that has text.
  const blocks: SectionInfo[][] = [];
  let run: SectionInfo[] = [];
  for (const s of sections) {
    run.push(s);
    if (s.words > 0 || s.tableRows > 0) {
      blocks.push(run);
      run = [];
    }
  }
  if (run.length > 0) blocks.push(run);

  return blocks.map((block) => {
    const first = block[0] as SectionInfo;
    const last = block[block.length - 1] as SectionInfo;
    const from = first.startPage;
    const to = last.endPage ?? last.startPage;
    const pages = from === undefined || from === 0 ? 'page ?' : to !== undefined && to > from ? `pages ${from}-${to}` : `page ${from}`;
    const bits = [
      last.paragraphs > 0 ? `${last.paragraphs} paragraph${last.paragraphs === 1 ? '' : 's'}` : null,
      last.tableRows > 0 ? `table of ${last.tableRows} rows` : null,
      `${last.words} words`,
      last.numberedShare >= 0.5 ? 'numbered' : null,
      last.paragraphs > 0 ? describeLook(last.bodyLook) : null,
    ].filter((x): x is string => x !== null);
    const more = block.length > 1 ? ` (+${block.length - 1} more title lines)` : '';
    return `${pages}: ${first.title}${more} — ${bits.join('; ')}`;
  });
}

// ------------------------------------------------------------------------------------------------------------------ comparing
export function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\b(?:the|of|and|in|to|a|an|for|no|nos)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similar(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const wa = new Set(a.split(' '));
  const wb = new Set(b.split(' '));
  let common = 0;
  for (const w of wa) if (wb.has(w)) common += 1;
  return common / Math.max(wa.size, wb.size) >= 0.6;
}

export interface Matched {
  readonly title: string;
  readonly currentTitle: string;
  readonly referencePage?: number;
  readonly currentPage?: number;
  readonly referenceParagraphs: number;
  readonly currentParagraphs: number;
  readonly referenceWords: number;
  readonly currentWords: number;
  /** A part that is much shorter than the reference's is probably unfinished. */
  readonly status: 'similar' | 'shorter' | 'longer' | 'empty';
}

export interface Comparison {
  readonly matched: readonly Matched[];
  readonly missing: readonly { readonly title: string; readonly referencePage?: number; readonly paragraphs: number; readonly words: number; readonly after?: string }[];
  readonly extra: readonly string[];
  readonly orderDiffers: boolean;
}

export function compareSections(reference: readonly SectionInfo[], current: readonly SectionInfo[]): Comparison {
  const used = new Set<number>();
  const matched: Matched[] = [];
  const missing: Array<{ title: string; referencePage?: number; paragraphs: number; words: number; after?: string }> = [];
  const order: number[] = [];
  let previousTitle: string | undefined;
  for (const r of reference) {
    const rn = normalizeTitle(r.title);
    let at = current.findIndex((c, i) => !used.has(i) && normalizeTitle(c.title) === rn);
    if (at < 0) at = current.findIndex((c, i) => !used.has(i) && (similar(normalizeTitle(c.title), rn) || c.titleLines.some((l) => similar(normalizeTitle(l), rn))));
    if (at < 0) {
      missing.push({ title: r.title, ...(r.startPage !== undefined ? { referencePage: r.startPage } : {}), paragraphs: r.paragraphs, words: r.words, ...(previousTitle !== undefined ? { after: previousTitle } : {}) });
    } else {
      used.add(at);
      order.push(at);
      const c = current[at] as SectionInfo;
      const ratio = r.words === 0 ? 1 : c.words / r.words;
      matched.push({
        title: r.title,
        currentTitle: c.title,
        ...(r.startPage !== undefined ? { referencePage: r.startPage } : {}),
        ...(c.startPage !== undefined ? { currentPage: c.startPage } : {}),
        referenceParagraphs: r.paragraphs,
        currentParagraphs: c.paragraphs,
        referenceWords: r.words,
        currentWords: c.words,
        status: c.words === 0 && r.words > 0 ? 'empty' : ratio < 0.5 ? 'shorter' : ratio > 2 ? 'longer' : 'similar',
      });
      previousTitle = c.title;
    }
  }
  const extra = current.filter((_c, i) => !used.has(i)).map((c) => c.title);
  const orderDiffers = order.some((v, i) => i > 0 && v < (order[i - 1] as number));
  return { matched, missing, extra, orderDiffers };
}

/** What differs in how the two are laid out, in plain words, only where the reference had a clear habit. */
export function compareLooks(reference: Profile, current: Profile): string[] {
  const out: string[] = [];
  const diff = <T,>(label: string, a: T | null, b: T | null, show: (v: T) => string): void => {
    if (a !== null && b !== null && a !== b) out.push(`${label}: the reference uses ${show(a)}, this document ${show(b)}`);
    else if (a !== null && b === null) out.push(`${label}: the reference uses ${show(a)}; this document has no clear setting`);
  };
  diff('Body font', reference.body.font, current.body.font, (v) => v);
  diff('Body size', reference.body.sizePt, current.body.sizePt, (v) => `${v} pt`);
  diff('Body alignment', reference.body.align, current.body.align, (v) => v);
  diff('Line spacing', reference.body.lineSpacing, current.body.lineSpacing, (v) => String(v));
  diff('First-line indent', reference.body.firstLineCm, current.body.firstLineCm, (v) => `${v} cm`);
  diff('Title alignment', reference.titles.align, current.titles.align, (v) => v);
  if (reference.titles.bold !== current.titles.bold && current.sections > 0) out.push(`Titles: the reference ${reference.titles.bold ? 'has them bold' : 'does not bold them'}, this document ${current.titles.bold ? 'does' : 'does not'}`);
  if (reference.titles.caps !== current.titles.caps && current.sections > 0) out.push(`Titles: the reference ${reference.titles.caps ? 'uses capitals' : 'does not use capitals'}, this document ${current.titles.caps ? 'does' : 'does not'}`);
  if (Math.abs(reference.numberedShare - current.numberedShare) > 0.4) out.push(`Numbering: ${Math.round(reference.numberedShare * 100)}% of the reference's paragraphs are numbered, ${Math.round(current.numberedShare * 100)}% of this document's`);
  return out;
}
