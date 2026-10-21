import { rootLogger } from '@main/logging/logger';
import { siteRestriction } from '@main/research/queries';
import type { ResearchKind } from '@main/research/queries';
import type { ResearchReport } from '@main/research/Researcher';
import type { Tool, ToolArgs, ToolResult } from '../types';

const log = rootLogger.child('research-tool');

/** The part of the researcher this tool needs (so tests can give it a fake). */
export interface ResearchRunner {
  research(req: { readonly question: string; readonly kind: ResearchKind; readonly site?: string; readonly thorough?: boolean }, onProgress?: (message: string) => void): Promise<ResearchReport>;
}

export interface ResearchToolDeps {
  readonly researcher: ResearchRunner;
  /** Shown to the user while it works ("Reading sites (3 of 7)…"). */
  readonly progress?: (message: string) => void;
}

const KINDS: readonly ResearchKind[] = ['answer', 'documents', 'media'];

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What the model is shown of a report: enough to answer and to act on, not a whole web page. */
export function reportForModel(report: ResearchReport): Record<string, unknown> {
  return {
    topic: report.topic,
    kind: report.kind,
    searches: report.searched,
    pagesRead: report.pagesRead,
    seconds: Math.round(report.elapsedMs / 1000),
    ...(report.fromCache === true ? { fromEarlierResearch: true } : {}),
    ...(report.namedSite !== undefined ? { namedSite: report.namedSite } : {}),
    documents: report.documents.slice(0, 5).map((d) => ({ title: d.title, url: d.url, site: d.domain, sizeMB: d.sizeBytes === null ? null : Math.round((d.sizeBytes / 1_048_576) * 10) / 10, verifiedPdf: d.verified, foundOn: d.from })),
    sources: report.sources.slice(0, 6).map((s) => ({ title: clip(s.title, 100), url: s.url, kind: s.siteKind, why: s.why, excerpts: s.excerpts.slice(0, 2).map((e) => clip(e, 220)) })),
    ...(report.watch !== undefined ? { whereToWatchOrListen: report.watch.slice(0, 6).map((w) => ({ platform: w.platform, title: clip(w.title, 90), url: w.url, freeWithAds: w.free, ...(w.note !== undefined ? { caution: w.note } : {}) })) } : {}),
    ...(report.freeCopies !== undefined
      ? { freeToKeepCopies: report.freeCopies.slice(0, 4).map((c) => ({ title: clip(c.title, 90), year: c.year, kind: c.kind, page: c.url, ...(c.fileUrl !== undefined ? { downloadUrl: c.fileUrl, sizeMB: c.fileSizeBytes == null ? null : Math.round(c.fileSizeBytes / 104_857.6) / 10 } : {}) })) }
      : {}),
    notes: report.notes,
  };
}

/** The line of guidance that goes back with the findings, by what was asked. */
function nextStep(report: ResearchReport): string {
  if (report.kind === 'documents') {
    return report.documents.length > 0
      ? 'Tell the user what you found in a sentence or two and name the best document. Offer to download it: call download_file for it (it asks the user first) or open it with open_url. Say which site it came from.'
      : 'No PDF was confirmed. Say so plainly, tell the user which pages were found (the best one by name), and offer to open it and look for the document there with the browser tools, or to try a more specific search.';
  }
  if (report.kind === 'media') {
    return (
      'Say where it can be watched or heard, free options first. For a film or song on YouTube offer to play it with play_on_youtube (it skips the adverts). ' +
      'A free-to-keep copy may be downloaded with download_file (it asks the user first). Never name, search or open a site that gives films or songs away without permission, and say plainly that you only use legal sources.'
    );
  }
  return 'Answer the question from the sources in a few spoken sentences. Name the most trustworthy site, and say if the sources disagree or none was good.';
}

export function createResearchTool(deps: ResearchToolDeps): Tool {
  return {
    schema: {
      name: 'deep_research',
      status: 'Researching the web…',
      description:
        'Research a question across the whole open internet like a careful person: many differently-worded searches, the best pages read, leads followed, and any documents found are checked to be real PDFs. ' +
        'Use it for: "find me <case/Act/report> and the related PDF" (kind documents), "what is / explain / latest on <topic>" needing real sources (kind answer), and "I want <film/song>" (kind media: finds where it can be watched or heard legally, and free public-domain copies; it never searches pirate sites). ' +
        'It takes up to a minute; say a few words first. For kind documents or media you MUST first ask the user "Do you know a website where this is available? If you tell me I will look there first." ' +
        'If they name a site pass it as site; if they say no, pass no_site true. Without one of the two the first call only returns the question to ask. ' +
        'If a named site does not have it, call again with no_site true to search everywhere. It uses no AI itself, so it does not use up the AI allowance.',
      args: {
        question: { type: 'string', required: true, description: "What the user wants, in their own words (the case name, the topic, the film or song)." },
        kind: { type: 'string', enum: KINDS, description: 'documents = the user wants a file (PDF) of something; media = a film, song or video; answer (default) = a question to be answered.' },
        site: { type: 'string', description: 'A website or address the user told you to look at first, e.g. "indiankanoon.org".' },
        no_site: { type: 'boolean', description: 'True once the user said they do not know a site (or it was not on the site they named): search the whole internet.' },
        thorough: { type: 'boolean', description: 'True for a deeper, longer search (up to about 100 seconds). Use when the first search found too little or the user asked for it deeply.' },
      },
    },

    async execute(args: ToolArgs): Promise<ToolResult> {
      const question = typeof args['question'] === 'string' ? args['question'].trim() : '';
      if (question === '') return { ok: false, summary: 'no question', error: 'Tell me what to research.' };
      const kindRaw = typeof args['kind'] === 'string' ? args['kind'] : 'answer';
      const kind: ResearchKind = (KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as ResearchKind) : 'answer';
      const siteArg = typeof args['site'] === 'string' && args['site'].trim() !== '' ? args['site'].trim() : undefined;
      const parsedSite = siteRestriction(siteArg);
      const noSite = args['no_site'] === true;

      // First ask the person whether they already know where it is: their site is looked in first, and a document from the place they trust
      // is worth more than anything a search finds. Only when they say no does the whole internet get searched.
      if ((kind === 'documents' || kind === 'media') && parsedSite === null && !noSite) {
        const what = kind === 'documents' ? 'this document' : 'this';
        const bad = siteArg !== undefined ? ` I couldn't make a web address out of "${siteArg}".` : '';
        return {
          ok: true,
          summary: 'ask the user first',
          data: {
            askUser: true,
            question: `Do you know a website where ${what} is available? If you tell me, I'll look there first. If not, I'll search the whole internet for it.${bad}`,
            then: 'Ask exactly that, wait for the answer, then call deep_research again: with site set to the website they name, or with no_site true if they say no.',
          },
        };
      }

      try {
        const report = await deps.researcher.research(
          { question, kind, ...(parsedSite !== null && !noSite ? { site: siteArg as string } : {}), ...(args['thorough'] === true ? { thorough: true } : {}) },
          deps.progress,
        );
        const found = report.documents.length + report.sources.length + (report.watch?.length ?? 0) + (report.freeCopies?.length ?? 0);
        if (found === 0) {
          return {
            ok: false,
            summary: 'nothing found',
            error: report.notes.join(' ') || 'I could not find anything for that. Try different words or a specific website.',
            data: { ...reportForModel(report), nextStep: 'Say plainly that nothing useful turned up and offer to try again with more specific words, a thorough search, or a website the user knows.' },
          };
        }
        const bits = [
          report.documents.length > 0 ? `${report.documents.length} document${report.documents.length === 1 ? '' : 's'} confirmed` : null,
          report.watch !== undefined && report.watch.length > 0 ? `${report.watch.length} place${report.watch.length === 1 ? '' : 's'} to watch or listen` : null,
          report.freeCopies !== undefined && report.freeCopies.length > 0 ? `${report.freeCopies.length} free copy` : null,
          report.sources.length > 0 ? `${report.sources.length} sources` : null,
        ].filter((x): x is string => x !== null);
        log.info('deep_research done', { kind, found, ms: report.elapsedMs });
        return { ok: true, summary: `researched: ${bits.join(', ')}`, data: { ...reportForModel(report), nextStep: nextStep(report) } };
      } catch (err) {
        log.warn('deep_research failed', { err: err instanceof Error ? err.message : String(err) });
        return { ok: false, summary: 'research failed', error: 'The research could not finish. Check the internet connection and try again.' };
      }
    },
  };
}
