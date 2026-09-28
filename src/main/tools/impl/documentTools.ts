import { promises as fs } from 'node:fs';
import { basename, extname } from 'node:path';
import { checkPath } from '@main/security/pathPolicy';
import type { KnownFolders } from '@main/security/pathPolicy';
import type { SearchSource } from '@main/providers/ai/GeminiAIProvider';
import type { Tool, ToolArgs, ToolResult } from '../types';

/** The slice of the Gemini provider these tools need. */
export interface DocumentBrain {
  hasKey(): boolean;
  analyzeFile(dataBase64: string, mimeType: string, question: string): Promise<string>;
  groundedSearch(query: string): Promise<{ text: string; sources: SearchSource[] }>;
}

// Inline uploads are capped at ~20MB per request, and base64 adds a third.
const MAX_DOCUMENT_BYTES = 14 * 1024 * 1024;
const MAX_ANSWER_CHARS = 8000;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
};

export function mimeTypeFor(path: string): string | undefined {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()];
}

function stringArg(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function createDocumentTool(folders: KnownFolders, brain: DocumentBrain): Tool {
  return {
    schema: {
      name: 'analyze_document',
      status: 'Reading the document…',
      description:
        'Read a PDF, image or text document and answer a question about it (summarize it, find a date or case number, ' +
        'extract details, describe a picture). The document is sent to Gemini to be read. Word/Excel files are not supported.',
      args: {
        path: { type: 'string', required: true, description: 'Full path to the file.' },
        question: {
          type: 'string',
          required: true,
          description: 'What to find out, e.g. "Summarize the key points" or "What is the case number and hearing date?".',
        },
      },
    },
    async execute(args): Promise<ToolResult> {
      const path = stringArg(args, 'path');
      const question = stringArg(args, 'question');
      if (path === undefined || question === undefined) {
        return { ok: false, summary: 'missing input', error: 'A path and a question are required.' };
      }
      if (!brain.hasKey()) return { ok: false, summary: 'no Gemini key', error: 'Reading documents needs the Gemini key.' };

      const check = checkPath(path, folders);
      if (!check.ok) return { ok: false, summary: 'not allowed', error: check.reason };
      const mime = mimeTypeFor(check.path);
      if (mime === undefined) {
        return {
          ok: false,
          summary: 'unsupported type',
          error: 'I can read PDFs, images and text files, but not that type of file.',
        };
      }
      try {
        const stat = await fs.stat(check.path);
        if (!stat.isFile()) return { ok: false, summary: 'not a file', error: 'That is not a file.' };
        if (stat.size > MAX_DOCUMENT_BYTES) {
          return { ok: false, summary: 'too large', error: 'That file is too large for me to read (over 14 MB).' };
        }
        const bytes = await fs.readFile(check.path);
        const answer = await brain.analyzeFile(bytes.toString('base64'), mime, question);
        if (answer.length === 0) return { ok: false, summary: 'no answer', error: 'I could not get anything from that file.' };
        return {
          ok: true,
          summary: `read ${basename(check.path)}`,
          data: { file: basename(check.path), answer: answer.slice(0, MAX_ANSWER_CHARS) },
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return {
          ok: false,
          summary: 'could not read',
          error: code === 'ENOENT' ? 'That file does not exist.' : 'I could not read that file.',
        };
      }
    },
  };
}

export function createWebSearchTool(brain: DocumentBrain): Tool {
  return {
    schema: {
      name: 'web_search',
      status: 'Searching the web…',
      description:
        'Search the web with Google and get a short, sourced answer. Use it for current information, news, court orders, ' +
        'prices, or anything you are not sure about. To just show results in a browser instead, use open_url.',
      args: { query: { type: 'string', required: true, description: 'What to look up.' } },
    },
    async execute(args): Promise<ToolResult> {
      const query = stringArg(args, 'query');
      if (query === undefined) return { ok: false, summary: 'no query', error: 'A search query is required.' };
      if (!brain.hasKey()) return { ok: false, summary: 'no Gemini key', error: 'Web search needs the Gemini key.' };
      try {
        const { text, sources } = await brain.groundedSearch(query);
        if (text.length === 0) return { ok: false, summary: 'no results', error: 'The search returned nothing.' };
        return {
          ok: true,
          summary: 'searched the web',
          data: { answer: text.slice(0, MAX_ANSWER_CHARS), sources },
        };
      } catch {
        return { ok: false, summary: 'search failed', error: 'The web search failed.' };
      }
    },
  };
}
