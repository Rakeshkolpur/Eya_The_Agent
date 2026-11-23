import { basename, extname } from 'node:path';
import { rootLogger } from '@main/logging/logger';
import { ReferenceStore } from './ReferenceStore';
import type { StoredReference } from './ReferenceStore';
import {
  buildProfile,
  buildSections,
  compareLooks,
  compareSections,
  describeLook,
  normalizeTitle,
  pageMap,
  parseBody,
} from './referenceAnalyzer';
import type { Comparison, Look, ParaInfo, Profile, SectionInfo } from './referenceAnalyzer';
import type { WordAnswer, WordCommand } from './WordControl';

const log = rootLogger.child('word.reference');

export interface ReferenceHost {
  run(cmd: WordCommand, args?: Record<string, unknown>): Promise<WordAnswer>;
}

export type ServiceResult<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly why: string };

interface Analysis {
  readonly name: string;
  readonly pages: number;
  readonly words: number;
  readonly tables: number;
  readonly tablesOfContents: number;
  readonly pageSetup?: StoredReference['pageSetup'];
  readonly header: string;
  readonly footer: string;
  readonly pageNumbers: boolean;
  readonly paras: readonly ParaInfo[];
  readonly sections: SectionInfo[];
  readonly profile: Profile;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** "Page 3 of 12" -> page_n_of_m; "- 3 -" -> dash; "Page 3" -> page_n; "3" -> number. */
export function numberFormatOf(sample: string): 'number' | 'page_n' | 'page_n_of_m' | 'n_of_m' | 'dash' {
  const s = sample.trim();
  if (/page\s*\d+\s*of\s*\d+/i.test(s)) return 'page_n_of_m';
  if (/^\d+\s*of\s*\d+$/i.test(s)) return 'n_of_m';
  if (/^[-–—]\s*\d+\s*[-–—]$/.test(s)) return 'dash';
  if (/page\s*\d+/i.test(s)) return 'page_n';
  return 'number';
}

export class ReferenceService {
  constructor(
    private readonly word: ReferenceHost,
    private readonly store: ReferenceStore,
  ) {}

  // ------------------------------------------------------------------------------------------------ reading a document
  /** The document in Word (the one in front, or a file opened in Word's own hidden copy) as sections, with the page each starts on. */
  private async analyze(path: string | undefined, withPages: boolean): Promise<ServiceResult<{ analysis: Analysis }>> {
    try {
      const got = await this.word.run('analyze', path !== undefined ? { path } : {});
      if (!got.ok) return { ok: false, why: text(got.why) || 'Word would not give the document' };
      const bodyXml = text(got['bodyXml']);
      if (bodyXml === '') return { ok: false, why: 'the document came back empty' };
      const normal = got['normal'] as Record<string, unknown> | undefined;
      const alignOf = ['left', 'center', 'right', 'justify'] as const;
      const fallback = {
        font: text(normal?.['font']) || null,
        sizePt: num(normal?.['size']) || null,
        align: typeof normal?.['align'] === 'number' ? (alignOf[normal['align'] as number] ?? null) : null,
      };
      const parsed = parseBody(bodyXml);
      const sections = buildSections(parsed).map((s) => ({ ...s, titleLook: withStyleDefaults(s.titleLook, fallback), bodyLook: withStyleDefaults(s.bodyLook, fallback) }));
      const base = buildProfile(parsed, sections);
      const profile: Profile = { ...base, body: withStyleDefaults(base.body, fallback), titles: withStyleDefaults(base.titles, fallback) };
      const paras = parsed;
      const pages = num(got['pages']);
      if (withPages) {
        const titled = sections.filter((s) => s.titleLines.length > 0);
        const found = titled.length === 0 ? null : await this.word.run('pages_of', { titles: titled.map((s) => s.title), ...(path !== undefined ? { useAnalyzed: true } : {}) });
        if (found !== null && found.ok && Array.isArray(found['pages'])) {
          const starts = found['pages'] as number[];
          titled.forEach((s, i) => {
            const p = starts[i];
            if (typeof p === 'number' && p > 0) s.startPage = p;
          });
          // a part runs up to the page before the next one starts
          const order = sections.filter((s) => s.startPage !== undefined);
          order.forEach((s, i) => {
            const next = order[i + 1];
            s.endPage = next?.startPage !== undefined ? Math.max(s.startPage as number, next.startPage === s.startPage ? (s.startPage as number) : next.startPage - 1) : Math.max(pages, s.startPage as number);
          });
        }
      }
      const setup = got['pageSetup'] as Record<string, unknown> | undefined;
      const analysis: Analysis = {
        name: text(got['name']),
        pages,
        words: num(got['words']),
        tables: num(got['tables']),
        tablesOfContents: num(got['tablesOfContents']),
        header: text(got['header']),
        footer: text(got['footer']),
        pageNumbers: got['pageNumbers'] === true,
        paras,
        sections,
        profile,
        ...(setup !== undefined
          ? {
              pageSetup: {
                paper: text(setup['paper']),
                orientation: text(setup['orientation']),
                marginTopCm: num(setup['marginTopCm']),
                marginBottomCm: num(setup['marginBottomCm']),
                marginLeftCm: num(setup['marginLeftCm']),
                marginRightCm: num(setup['marginRightCm']),
              },
            }
          : {}),
      };
      return { ok: true, analysis };
    } finally {
      if (path !== undefined) await this.word.run('analyze_close');
    }
  }

  // --------------------------------------------------------------------------------------------------------------- learn
  async learn(name: string | undefined, path: string | undefined): Promise<ServiceResult<{ reference: StoredReference; map: string[] }>> {
    const got = await this.analyze(path, true);
    if (!got.ok) return got;
    const a = got.analysis;
    if (a.sections.length === 0 || a.profile.paragraphs === 0) return { ok: false, why: 'that document has no text to learn from' };
    const fileName = path !== undefined ? basename(path) : a.name;
    const chosen = (name ?? '').trim() !== '' ? (name as string).trim() : basename(fileName, extname(fileName));
    const reference = this.store.save({
      name: chosen,
      learnedAt: new Date().toISOString(),
      source: { fileName, pages: a.pages, words: a.words, paragraphs: a.profile.paragraphs, fromFile: path !== undefined },
      ...(a.pageSetup !== undefined ? { pageSetup: a.pageSetup } : {}),
      ...(a.header !== '' ? { header: a.header } : {}),
      ...(a.footer !== '' ? { footer: a.footer } : {}),
      pageNumbers: a.pageNumbers,
      tablesOfContents: a.tablesOfContents,
      tables: a.tables,
      profile: a.profile,
      sections: a.sections,
    });
    log.info('learned a reference', { pages: a.pages, sections: a.sections.length, paragraphs: a.profile.paragraphs });
    return { ok: true, reference, map: pageMap(reference.sections) };
  }

  list(): ReturnType<ReferenceStore['list']> {
    return this.store.list();
  }

  forget(name: string): string | null {
    return this.store.forget(name);
  }

  private pick(name: string | undefined): ServiceResult<{ reference: StoredReference }> {
    const r = this.store.find(name ?? '');
    if (r !== null) return { ok: true, reference: r };
    const all = this.store.list();
    if (all.length === 0) return { ok: false, why: 'no reference has been learned yet: learn one first (open the finished document in Word, or give its file)' };
    return { ok: false, why: `${(name ?? '').trim() === '' ? 'Which reference?' : `No single reference matches "${name}".`} Learned: ${all.map((x) => x.name).join(', ')}.` };
  }

  // ---------------------------------------------------------------------------------------------------------------- show
  show(name: string | undefined, query: { section?: string; page?: number }): ServiceResult<Record<string, unknown>> {
    const got = this.pick(name);
    if (!got.ok) return got;
    const r = got.reference;
    const header = { reference: r.name, pages: r.source.pages, learnedFrom: r.source.fileName };
    if (query.section !== undefined && query.section.trim() !== '') {
      const n = normalizeTitle(query.section);
      const found =
        r.sections.find((s) => normalizeTitle(s.title) === n) ??
        r.sections.find((s) => s.titleLines.some((l) => normalizeTitle(l).includes(n) || n.includes(normalizeTitle(l)))) ??
        r.sections.find((s) => normalizeTitle(s.text.slice(0, 200)).includes(n));
      if (found === undefined) return { ok: false, why: `"${query.section}" is not a part of ${r.name}. Its parts: ${r.sections.map((s) => s.title).join('; ')}.` };
      return {
        ok: true,
        ...header,
        section: {
          title: found.title,
          titleLines: found.titleLines,
          pages: found.startPage === undefined ? null : found.endPage !== undefined && found.endPage > found.startPage ? `${found.startPage}-${found.endPage}` : String(found.startPage),
          paragraphs: found.paragraphs,
          words: found.words,
          tableRows: found.tableRows,
          numbered: found.numberedShare >= 0.5,
          titleLooks: describeLook(found.titleLook),
          bodyLooks: describeLook(found.bodyLook),
          text: found.text,
        },
      };
    }
    if (query.page !== undefined) {
      const on = r.sections.filter((s) => s.startPage !== undefined && s.startPage <= (query.page as number) && (s.endPage ?? s.startPage) >= (query.page as number));
      if (on.length === 0) return { ok: false, why: `${r.name} has nothing recorded on page ${query.page} (it has ${r.source.pages} pages)` };
      return { ok: true, ...header, page: query.page, parts: on.map((s) => ({ title: s.title, startPage: s.startPage, words: s.words, looks: describeLook(s.bodyLook), text: s.text.slice(0, 2500) })) };
    }
    return {
      ok: true,
      ...header,
      pageMap: pageMap(r.sections),
      pageSetup: r.pageSetup ?? null,
      pageNumbers: r.pageNumbers,
      header: r.header ?? '',
      footer: r.footer ?? '',
      tablesOfContents: r.tablesOfContents,
      tables: r.tables,
      bodyLooks: describeLook(r.profile.body),
      titleLooks: describeLook(r.profile.titles),
      numberedShare: Math.round(r.profile.numberedShare * 100),
    };
  }

  // -------------------------------------------------------------------------------------------------------------- compare
  async compare(name: string | undefined): Promise<ServiceResult<{ reference: string; comparison: Comparison; looks: string[]; current: { name: string; pages: number; sections: number } }>> {
    const got = this.pick(name);
    if (!got.ok) return got;
    const now = await this.analyze(undefined, true);
    if (!now.ok) return now;
    const a = now.analysis;
    const comparison = compareSections(got.reference.sections, a.sections);
    return {
      ok: true,
      reference: got.reference.name,
      comparison,
      looks: compareLooks(got.reference.profile, a.profile),
      current: { name: a.name, pages: a.pages, sections: a.sections.length },
    };
  }

  // ---------------------------------------------------------------------------------------------------------- apply format
  async applyFormat(name: string | undefined, what: string): Promise<ServiceResult<{ reference: string; applied: string[]; titlesNotFound: string[] }>> {
    const got = this.pick(name);
    if (!got.ok) return got;
    const r = got.reference;
    const wanted = (part: string): boolean => what === 'all' || what === part;
    const now = await this.analyze(undefined, false);
    if (!now.ok) return now;
    const request: Record<string, unknown> = {};

    if (wanted('page_setup') && r.pageSetup !== undefined && r.pageSetup.paper !== '') {
      request['pageSetup'] = {
        ...(r.pageSetup.paper !== 'other' ? { paper: r.pageSetup.paper } : {}),
        orientation: r.pageSetup.orientation,
        marginTopCm: r.pageSetup.marginTopCm,
        marginBottomCm: r.pageSetup.marginBottomCm,
        marginLeftCm: r.pageSetup.marginLeftCm,
        marginRightCm: r.pageSetup.marginRightCm,
      };
    }
    if (wanted('body')) request['body'] = lookToFormat(r.profile.body, true);
    if (wanted('titles')) {
      const titles = now.analysis.paras.filter((p) => p.isTitle && !p.inTable);
      request['titles'] = titles.map((t) => {
        const n = normalizeTitle(t.text);
        const match = r.sections.find((s) => s.titleLines.some((l) => normalizeTitle(l) === n)) ?? r.sections.find((s) => normalizeTitle(s.title) === n);
        const look: Look = match !== undefined && match.titleLines.length > 0 ? match.titleLook : r.profile.titles;
        return { text: t.text, ...lookToFormat(look, false) };
      });
    }
    if (wanted('page_numbers') && r.pageNumbers) {
      const inHeader = /\d/.test(r.header ?? '') && !/\d/.test(r.footer ?? '');
      const sample = inHeader ? (r.header ?? '') : (r.footer ?? '');
      request['pageNumbers'] = { present: true, where: inHeader ? 'header' : 'footer', align: 'center', format: numberFormatOf(sample) };
    }
    if (Object.keys(request).length === 0) return { ok: false, why: 'there is nothing in that reference to apply for that' };
    const done = await this.word.run('apply_profile', request);
    if (!done.ok) return { ok: false, why: text(done.why) || 'Word would not apply it' };
    return {
      ok: true,
      reference: r.name,
      applied: Array.isArray(done['applied']) ? (done['applied'] as string[]) : [],
      titlesNotFound: Array.isArray(done['titlesNotFound']) ? (done['titlesNotFound'] as string[]) : [],
    };
  }
}

/**
 * Text that carries no font or size of its own has the one the document's Normal style gives it; only a look that has something to say
 * is given them (an empty look stays empty).
 */
function withStyleDefaults(look: Look, normal: { font: string | null; sizePt: number | null; align: Look['align'] }): Look {
  const empty = look.align === null && look.font === null && look.sizePt === null && look.lineSpacing === null && look.firstLineCm === null && !look.bold && !look.caps && !look.underline;
  if (empty) return look;
  return { ...look, font: look.font ?? normal.font, sizePt: look.sizePt ?? normal.sizePt, align: look.align ?? normal.align };
}

/** A learned look as the properties the Word helper applies; only what the reference clearly had. */
function lookToFormat(l: Look, body: boolean): Record<string, unknown> {
  return {
    ...(l.font !== null ? { fontName: l.font } : {}),
    ...(l.sizePt !== null ? { fontSize: l.sizePt } : {}),
    ...(l.align !== null ? { align: l.align } : {}),
    ...(l.lineSpacing !== null && body ? { lineSpacing: l.lineSpacing } : {}),
    ...(l.firstLineCm !== null && body ? { firstLineIndentCm: Math.max(0, l.firstLineCm) } : {}),
    ...(body ? {} : { bold: l.bold, underline: l.underline, allCaps: l.caps }),
  };
}
