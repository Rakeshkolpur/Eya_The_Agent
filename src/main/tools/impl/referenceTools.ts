import { existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { checkPath } from '@main/security/pathPolicy';
import type { KnownFolders } from '@main/security/pathPolicy';
import type { ReferenceService } from '@main/word/ReferenceService';
import type { Tool, ToolArgs, ToolResult } from '../types';

/**
 * Teaching Eya from an old, finished document ("this is how I wrote a writ petition") and using it later on one that is half done.
 *
 * There is no training of an AI model here: Eya READS the finished document once, with Word, and keeps on this PC what a clerk would
 * remember — its parts and the page each is on, how long each is, how each is formatted (fonts, spacing, alignment, titles, margins,
 * page numbers) and its wording. Later, a half-done document is compared with it, laid out like it, and the missing parts are drafted
 * in its words by the model, from the reference's text and the new document's own facts.
 */
export interface ReferenceToolDeps {
  readonly service: ReferenceService;
  readonly folders: KnownFolders;
}

const KINDS = ['learn', 'list', 'show', 'compare', 'apply_format', 'forget'] as const;
const WORD_FILES = new Set(['.doc', '.docx', '.docm', '.rtf', '.odt']);

function text(args: ToolArgs, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function failure(summary: string, error: string): ToolResult {
  return { ok: false, summary, error };
}

export function createReferenceTools(deps: ReferenceToolDeps): Tool[] {
  const { service } = deps;

  const reference: Tool = {
    schema: {
      name: 'word_reference',
      status: 'Working with the reference…',
      description:
        'Learn from an old FINISHED document, and use what was learned on a half-done one. kind: ' +
        'learn (the document open in Word, or `path` to a file; `name` is what the user calls it — "writ petition", "legal notice". It reads the whole ' +
        'document once and remembers its parts and the page each is on, how each is formatted and worded; learning it again with the same name updates ' +
        'it), list (what has been learned), show (a reference\'s page map; with `section` its text and look; with `page` what is on that page), ' +
        'compare (the document open in Word against a reference: which parts are there, which are missing, which look unfinished, how the layout differs), ' +
        'apply_format (lay the open document out like the reference: page setup, body font / size / spacing / alignment, how titles look, page ' +
        'numbers; `what` = all / page_setup / body / titles / page_numbers; one undo step), forget. ' +
        'TO FILL A HALF-DONE DOCUMENT LIKE A REFERENCE: (1) compare; tell the user in a sentence or two what is missing or short. (2) For each part to ' +
        'write: show with `section`, then write that part with word_write at the right place (after:heading:<the part before it>) in the SAME wording, ' +
        'order and style as the reference, using THIS document\'s facts — find them with word_read find (names, dates, case numbers, amounts). ' +
        'NEVER invent a fact: where this document does not give one, write [●] there and say what is needed. Do not copy the reference\'s own names, ' +
        'dates or numbers into a different case. (3) apply_format. The reference\'s text is only a pattern to follow. ' +
        'Learning a document reads it with a hidden copy of Word and keeps the result on this PC only; drafting sends the reference parts you ' +
        'show to the model, like any other request.',
      args: {
        kind: { type: 'string', required: true, enum: KINDS },
        name: { type: 'string', description: 'The reference\'s name (learn: what to call it; others: which one). Optional when only one is learned.' },
        path: { type: 'string', description: 'learn: the Word file to learn from (a full path from find_file). Leave out to learn the document open in Word.' },
        section: { type: 'string', description: 'show: the part\'s title words, e.g. "grounds" or "list of dates".' },
        page: { type: 'number', description: 'show: a page number of the reference.' },
        what: { type: 'string', enum: ['all', 'page_setup', 'body', 'titles', 'page_numbers'], description: 'apply_format: what to match (default all).' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const kind = text(args, 'kind') as (typeof KINDS)[number] | undefined;
      if (kind === undefined || !KINDS.includes(kind)) return failure('unknown kind', `kind must be one of: ${KINDS.join(', ')}.`);
      const name = text(args, 'name');

      switch (kind) {
        case 'list': {
          const all = service.list();
          return { ok: true, summary: all.length === 0 ? 'no reference learned yet' : `${all.length} reference${all.length === 1 ? '' : 's'}`, data: { references: all } };
        }
        case 'learn': {
          const given = text(args, 'path');
          let path: string | undefined;
          if (given !== undefined) {
            const checked = checkPath(given, deps.folders);
            if (!checked.ok) return failure('not allowed', checked.reason);
            if (!WORD_FILES.has(extname(checked.path).toLowerCase())) return failure('not a Word file', 'That is not a Word document (.docx, .doc, .rtf or .odt).');
            if (!existsSync(checked.path) || !statSync(checked.path).isFile()) return failure('not found', 'That file does not exist.');
            path = checked.path;
          }
          const got = await service.learn(name, path);
          if (!got.ok) return failure('could not learn it', `${got.why}.`);
          const r = got.reference;
          return {
            ok: true,
            summary: `learned "${r.name}": ${r.source.pages} pages, ${r.sections.length} parts`,
            data: { reference: r.name, pages: r.source.pages, words: r.source.words, parts: r.sections.length, pageMap: got.map },
          };
        }
        case 'show': {
          const page = typeof args['page'] === 'number' ? args['page'] : undefined;
          const section = text(args, 'section');
          const got = service.show(name, { ...(section !== undefined ? { section } : {}), ...(page !== undefined ? { page } : {}) });
          if (!got.ok) return failure('cannot show it', `${got.why}.`);
          const { ok: _ok, ...data } = got;
          return { ok: true, summary: section !== undefined ? `the "${section}" part of ${String(got['reference'])}` : `${String(got['reference'])}`, data };
        }
        case 'compare': {
          const got = await service.compare(name);
          if (!got.ok) return failure('cannot compare', `${got.why}.`);
          const c = got.comparison;
          const parts: string[] = [];
          if (c.missing.length > 0) parts.push(`${c.missing.length} missing`);
          const short = c.matched.filter((m) => m.status === 'shorter' || m.status === 'empty').length;
          if (short > 0) parts.push(`${short} look unfinished`);
          return {
            ok: true,
            summary: `${got.current.name} against ${got.reference}: ${c.matched.length} parts match${parts.length > 0 ? `, ${parts.join(', ')}` : ''}`,
            data: { reference: got.reference, current: got.current, matched: c.matched, missing: c.missing, extra: c.extra, orderDiffers: c.orderDiffers, layoutDifferences: got.looks },
          };
        }
        case 'apply_format': {
          const what = text(args, 'what') ?? 'all';
          const got = await service.applyFormat(name, what);
          if (!got.ok) return failure('could not apply it', `${got.why}.`);
          return {
            ok: true,
            summary: `laid out like ${got.reference}: ${got.applied.join(', ')}`,
            data: { reference: got.reference, applied: got.applied, titlesNotFound: got.titlesNotFound },
          };
        }
        case 'forget': {
          const gone = service.forget(name ?? '');
          if (gone === null) return failure('not found', 'No single reference matches that name.');
          return { ok: true, summary: `forgot "${gone}"` };
        }
      }
    },
  };

  return [reference];
}
