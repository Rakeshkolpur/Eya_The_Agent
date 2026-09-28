import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createDocumentTool,
  createWebSearchTool,
  mimeTypeFor,
} from '../src/main/tools/impl/documentTools';
import type { DocumentBrain } from '../src/main/tools/impl/documentTools';
import type { KnownFolders } from '../src/main/security/pathPolicy';

let home = '';
let folders: KnownFolders;
let calls: Array<{ data: string; mime: string; question: string }>;
let searches: string[];
let answer = 'It is a court order.';
let hasKey = true;
let failing = false;

const brain: DocumentBrain = {
  hasKey: () => hasKey,
  analyzeFile: async (data, mime, question) => {
    if (failing) throw new Error('quota');
    calls.push({ data, mime, question });
    return answer;
  },
  groundedSearch: async (query) => {
    if (failing) throw new Error('quota');
    searches.push(query);
    return { text: 'The hearing moved to the 12th.', sources: [{ title: 'Court site', uri: 'https://court.example/orders' }] };
  },
};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'eya-docs-'));
  folders = {
    home,
    desktop: join(home, 'Desktop'),
    documents: join(home, 'Documents'),
    downloads: join(home, 'Downloads'),
    pictures: join(home, 'Pictures'),
    videos: join(home, 'Videos'),
    music: join(home, 'Music'),
  };
  await mkdir(folders.downloads, { recursive: true });
  await writeFile(join(folders.downloads, 'order.pdf'), 'PDFBYTES');
  await writeFile(join(folders.downloads, 'photo.png'), 'PNGBYTES');
  await writeFile(join(folders.downloads, 'letter.docx'), 'DOCX');
  await writeFile(join(folders.downloads, 'huge.pdf'), Buffer.alloc(14 * 1024 * 1024 + 1));
});

beforeEach(() => {
  calls = [];
  searches = [];
  answer = 'It is a court order.';
  hasKey = true;
  failing = false;
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('analyze_document', () => {
  const tool = () => createDocumentTool(folders, brain);

  it('sends the file and the question to Gemini and returns the answer', async () => {
    const result = await tool().execute({ path: join(folders.downloads, 'order.pdf'), question: 'What is it?' });
    expect(result.ok).toBe(true);
    expect(result.data?.['answer']).toBe('It is a court order.');
    expect(result.data?.['file']).toBe('order.pdf');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.mime).toBe('application/pdf');
    expect(calls[0]?.question).toBe('What is it?');
    expect(Buffer.from(calls[0]?.data ?? '', 'base64').toString()).toBe('PDFBYTES');
  });

  it('reads images too', async () => {
    const result = await tool().execute({ path: join(folders.downloads, 'photo.png'), question: 'Describe it' });
    expect(result.ok).toBe(true);
    expect(calls[0]?.mime).toBe('image/png');
  });

  it('is honest about what it cannot read', async () => {
    const word = await tool().execute({ path: join(folders.downloads, 'letter.docx'), question: 'Summarize' });
    expect(word.ok).toBe(false);
    expect(word.error).toMatch(/PDFs, images and text/);
    expect(calls).toEqual([]);
  });

  it('refuses secrets, outside paths, oversized and missing files without calling Gemini', async () => {
    const cases: Array<[string, RegExp?]> = [
      [join(folders.downloads, '.env')],
      ['C:\\Windows\\win.ini'],
      [join(folders.downloads, 'huge.pdf'), /too large/],
      [join(folders.downloads, 'ghost.pdf'), /does not exist/],
    ];
    for (const [path, message] of cases) {
      const result = await tool().execute({ path, question: 'What?' });
      expect(result.ok, path).toBe(false);
      if (message !== undefined) expect(result.error).toMatch(message);
    }
    expect(calls).toEqual([]);
  });

  it('needs the Gemini key, and copes with Gemini failing', async () => {
    hasKey = false;
    expect((await tool().execute({ path: join(folders.downloads, 'order.pdf'), question: 'q' })).ok).toBe(false);
    hasKey = true;
    failing = true;
    const result = await tool().execute({ path: join(folders.downloads, 'order.pdf'), question: 'q' });
    expect(result.ok).toBe(false);
    expect(result.error).not.toMatch(/quota/); // internals aren't read out to the user
  });

  it('fails cleanly on an empty answer', async () => {
    answer = '';
    expect((await tool().execute({ path: join(folders.downloads, 'order.pdf'), question: 'q' })).ok).toBe(false);
  });
});

describe('web_search', () => {
  it('returns the answer with its sources', async () => {
    const result = await createWebSearchTool(brain).execute({ query: 'latest order in case 12' });
    expect(result.ok).toBe(true);
    expect(result.data?.['answer']).toBe('The hearing moved to the 12th.');
    expect(result.data?.['sources']).toEqual([{ title: 'Court site', uri: 'https://court.example/orders' }]);
    expect(searches).toEqual(['latest order in case 12']);
  });

  it('handles a missing query, no key and a failing search', async () => {
    const tool = createWebSearchTool(brain);
    expect((await tool.execute({})).ok).toBe(false);
    hasKey = false;
    expect((await tool.execute({ query: 'x' })).ok).toBe(false);
    hasKey = true;
    failing = true;
    expect((await tool.execute({ query: 'x' })).ok).toBe(false);
  });
});

describe('mimeTypeFor', () => {
  it('maps supported types only', () => {
    expect(mimeTypeFor('a.PDF')).toBe('application/pdf');
    expect(mimeTypeFor('a.jpeg')).toBe('image/jpeg');
    expect(mimeTypeFor('a.docx')).toBeUndefined();
    expect(mimeTypeFor('a.exe')).toBeUndefined();
  });
});
