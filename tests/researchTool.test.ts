import { describe, it, expect } from 'vitest';
import { createResearchTool, reportForModel } from '../src/main/tools/impl/researchTools';
import type { ResearchRunner } from '../src/main/tools/impl/researchTools';
import type { ResearchReport } from '../src/main/research/Researcher';

const emptyReport = (over: Partial<ResearchReport> = {}): ResearchReport => ({
  question: 'q',
  kind: 'documents',
  topic: 'q',
  queries: ['q'],
  searched: 3,
  pagesRead: 4,
  sources: [],
  documents: [],
  notes: [],
  elapsedMs: 12_000,
  ...over,
});

function runner(report: ResearchReport): { runner: ResearchRunner; requests: Array<Record<string, unknown>> } {
  const requests: Array<Record<string, unknown>> = [];
  return {
    requests,
    runner: {
      research: async (req) => {
        requests.push({ ...req });
        return report;
      },
    },
  };
}

const doc = { title: 'Kesavananda Bharati judgment', url: 'https://www.sci.gov.in/a.pdf', domain: 'sci.gov.in', sizeBytes: 3_145_728, verified: true, from: 'sci.gov.in', trust: 95 };
const source = { title: 'The case', url: 'https://www.sci.gov.in/case', domain: 'sci.gov.in', siteKind: 'official' as const, trust: 95, why: 'official site · mentions 3 of 3 key words', excerpts: ['one', 'two', 'three'] };

describe('deep_research: asks first', () => {
  it('for documents, the first call researches nothing and hands back the question to ask', async () => {
    const r = runner(emptyReport());
    const tool = createResearchTool({ researcher: r.runner });
    const result = await tool.execute({ question: 'Kesavananda Bharati case', kind: 'documents' });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('ask the user first');
    expect((result.data as { askUser?: boolean }).askUser).toBe(true);
    expect(String((result.data as { question?: string }).question)).toMatch(/Do you know a website/);
    expect(r.requests).toHaveLength(0);
  });

  it('for films and songs too', async () => {
    const r = runner(emptyReport({ kind: 'media' }));
    const result = await createResearchTool({ researcher: r.runner }).execute({ question: 'Kesari', kind: 'media' });
    expect(result.summary).toBe('ask the user first');
    expect(r.requests).toHaveLength(0);
  });

  it('a named site goes in as the site to look at first', async () => {
    const r = runner(emptyReport({ documents: [doc], sources: [source] }));
    const result = await createResearchTool({ researcher: r.runner }).execute({ question: 'Kesavananda Bharati case', kind: 'documents', site: 'indiankanoon.org' });
    expect(result.ok).toBe(true);
    expect(r.requests[0]).toMatchObject({ kind: 'documents', site: 'indiankanoon.org' });
  });

  it('something that is not a web address is asked about again, not searched', async () => {
    const r = runner(emptyReport());
    const result = await createResearchTool({ researcher: r.runner }).execute({ question: 'x case', kind: 'documents', site: 'ecourts' });
    expect(result.summary).toBe('ask the user first');
    expect(String((result.data as { question?: string }).question)).toMatch(/couldn't make a web address/);
    expect(r.requests).toHaveLength(0);
  });

  it('"no site" searches the whole internet, without a site restriction', async () => {
    const r = runner(emptyReport({ documents: [doc] }));
    const result = await createResearchTool({ researcher: r.runner }).execute({ question: 'Kesavananda Bharati case', kind: 'documents', no_site: true, thorough: true });
    expect(result.ok).toBe(true);
    expect(r.requests[0]).toEqual({ question: 'Kesavananda Bharati case', kind: 'documents', thorough: true });
  });

  it('an answer question needs no asking', async () => {
    const r = runner(emptyReport({ kind: 'answer', sources: [source] }));
    const result = await createResearchTool({ researcher: r.runner }).execute({ question: 'what is the basic structure doctrine' });
    expect(result.ok).toBe(true);
    expect(r.requests[0]).toMatchObject({ kind: 'answer' });
  });
});

describe('deep_research: what comes back', () => {
  it('summarises what was found, names the next step, and keeps the report small', async () => {
    const r = runner(emptyReport({ documents: [doc], sources: [source] }));
    const result = await createResearchTool({ researcher: r.runner }).execute({ question: 'x', kind: 'documents', no_site: true });
    expect(result.summary).toBe('researched: 1 document confirmed, 1 sources');
    const data = result.data as { documents: Array<Record<string, unknown>>; sources: Array<{ excerpts: string[] }>; nextStep: string };
    expect(data.documents[0]).toMatchObject({ verifiedPdf: true, sizeMB: 3 });
    expect(data.sources[0]?.excerpts).toHaveLength(2);
    expect(data.nextStep).toMatch(/download_file/);
  });

  it('says plainly when nothing was found', async () => {
    const r = runner(emptyReport({ notes: ['Nothing useful came back'] }));
    const result = await createResearchTool({ researcher: r.runner }).execute({ question: 'x', kind: 'documents', no_site: true });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('nothing found');
  });

  it('for a film the guidance is legal-only and the report carries the legal copies and platforms', async () => {
    const report = emptyReport({
      kind: 'media',
      watch: [{ platform: 'YouTube', title: 'Kesari Full Movie', url: 'https://www.youtube.com/watch?v=1', free: true, note: 'check the channel' }],
      freeCopies: [{ title: 'Old film', year: '1913', url: 'https://archive.org/details/x', identifier: 'x', kind: 'film', freeToKeep: true, license: null, downloads: 10, fileUrl: 'https://archive.org/download/x/x.mp4', fileSizeBytes: 60_000_000 }],
    });
    const result = await createResearchTool({ researcher: runner(report).runner }).execute({ question: 'Kesari', kind: 'media', no_site: true });
    const data = result.data as { whereToWatchOrListen: Array<{ caution?: string }>; freeToKeepCopies: Array<{ downloadUrl?: string }>; nextStep: string };
    expect(data.whereToWatchOrListen[0]?.caution).toBe('check the channel');
    expect(data.freeToKeepCopies[0]?.downloadUrl).toBe('https://archive.org/download/x/x.mp4');
    expect(data.nextStep).toMatch(/Never name, search or open a site that gives films or songs away without permission/);
    expect(reportForModel(report)).not.toHaveProperty('freeCopies');
  });

  it('a research that fails is reported, not thrown', async () => {
    const tool = createResearchTool({
      researcher: {
        research: async () => {
          throw new Error('boom');
        },
      },
    });
    const result = await tool.execute({ question: 'x', kind: 'answer' });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('research failed');
  });
});
