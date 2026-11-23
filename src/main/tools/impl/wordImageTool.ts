import { promises as fs } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { describeAIFailure } from '@main/agent/AgentEngine';
import type { AttachedFiles } from '@main/files/attachedFiles';
import { checkReadablePath, isBlockedFileName } from '@main/security/pathPolicy';
import type { KnownFolders } from '@main/security/pathPolicy';
import { compareBuilt, describeSpec, EXTRACTION_PROMPT, normalizeDocSpec, parseModelJson } from '@main/word/docSpec';
import type { WordAnswer, WordCommand } from '@main/word/WordControl';
import { attachmentInfo, MAX_ATTACHMENT_BYTES } from '@shared/attachments';
import type { Tool, ToolResult } from '../types';

/** Rebuilding a page is slow work for Word (every cell and run is a call): it is given a long time. */
const BUILD_TIMEOUT_MS = 170_000;

export interface WordImageDeps {
  readonly word: { run(cmd: WordCommand, args?: Record<string, unknown>, options?: { readonly timeoutMs?: number }): Promise<WordAnswer> };
  readonly brain: { hasKey(): boolean; analyzeFile(dataBase64: string, mimeType: string, question: string): Promise<string> };
  readonly folders: KnownFolders;
  readonly attached?: AttachedFiles;
  readonly attachmentsDir?: string;
}

const isInside = (dir: string, target: string): boolean => {
  const rel = relative(resolve(dir), resolve(target));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

const failure = (summary: string, error: string, data?: Record<string, unknown>): ToolResult => ({ ok: false, summary, error, ...(data !== undefined ? { data } : {}) });

/**
 * "Recreate this photo in Word": a picture of a page (a photo, a scan, a screenshot) is read by the vision model into a layout (headings, paragraphs with their bold / italic / size / colour,
 * lists, tables with merged cells, widths, shading, borders, page breaks), the layout is cleaned, and Word builds it in a NEW document: the document the person has open is never touched.
 * Afterwards what Word holds is compared with what was recognised. How close it looks is only as good as the reading of the picture: the result says what was recognised so that the person can
 * check the words and the numbers, and what differs is fixed with the other Word tools.
 */
export function createWordImageTool(deps: WordImageDeps): Tool {
  return {
    schema: {
      name: 'word_from_image',
      status: 'Reading the picture and rebuilding it in Word…',
      description:
        'Recreate a picture of a document in Microsoft Word with the same formatting: a photo, a scan or a screenshot of a page, a letter, a notice, a form, a table. It reads the picture (words exactly as printed, alignment, bold / italic / underline, sizes, ' +
        'colours, lists, tables with merged cells, column widths, shading, borders, page breaks) and builds it in a NEW Word document, so the document the user has open is not touched. Do it AT ONCE when the user sends a picture and says to ' +
        'recreate / copy / make it in Word. A picture the user attached is given to you with its path: use that path. Then tell the user what it recognised (the result says) and ask them to check the words and numbers; if they say something ' +
        'looks different (a table, a size, an alignment) fix exactly that with word_structure (fix_table), word_format or word_edit. It is only as exact as the picture is clear: never claim it is identical.',
      args: {
        path: { type: 'string', required: true, description: 'Full path to the picture (png, jpg, webp ...).' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const path = typeof args['path'] === 'string' ? args['path'].trim() : '';
      if (path === '') return failure('missing input', 'A path to the picture is required.');
      if (!deps.brain.hasKey()) return failure('no Gemini key', 'Reading a picture needs the Gemini key.');
      const kept = deps.attachmentsDir !== undefined && isInside(deps.attachmentsDir, path);
      const given = deps.attached?.has(path) === true && !isBlockedFileName(basename(path));
      const check = kept || given ? { ok: true as const, path: resolve(path) } : checkReadablePath(path, deps.folders);
      if (!check.ok) return failure('not allowed', check.reason);
      const info = attachmentInfo(check.path);
      if (info === null || !info.mime.startsWith('image/')) return failure('not a picture', 'That is not a picture I can read (a png, jpg or webp image).');
      let bytes: Buffer;
      try {
        const stat = await fs.stat(check.path);
        if (!stat.isFile()) return failure('not a file', 'That is not a file.');
        if (stat.size > MAX_ATTACHMENT_BYTES) return failure('too large', `That picture is too large for me to read (over ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB).`);
        bytes = await fs.readFile(check.path);
      } catch {
        return failure('could not read', 'I could not open that picture.');
      }
      const b64 = bytes.toString('base64');

      // 1. the picture, read into a layout (asked a second time, once, if the answer cannot be read as JSON)
      let parsed: unknown = null;
      for (let attempt = 0; attempt < 2 && parsed === null; attempt += 1) {
        let answer: string;
        try {
          answer = await deps.brain.analyzeFile(b64, info.mime, attempt === 0 ? EXTRACTION_PROMPT : `${EXTRACTION_PROMPT}\n\nYour previous answer could not be read as JSON. Answer again with ONLY the JSON object.`);
        } catch (err) {
          return failure('could not read the picture', describeAIFailure(err));
        }
        parsed = parseModelJson(answer);
      }
      if (parsed === null) return failure('unreadable answer', 'I could not turn that picture into a layout (the answer was not usable). Try a clearer, straighter picture.');
      const norm = normalizeDocSpec(parsed);
      if (!norm.ok || norm.spec === undefined) return failure('nothing to build', `I could not find a page layout in that picture: ${norm.error ?? 'nothing recognised'}.`);

      // 2. Word builds it, in a new document
      const built = await deps.word.run('build', { spec: norm.spec, target: 'new' }, { timeoutMs: BUILD_TIMEOUT_MS });
      if (!built.ok) {
        const why = typeof built.why === 'string' && built.why !== '' ? built.why : 'Word would not build it';
        return failure('Word would not build it', `${why}. ${why === 'Word is not open' ? 'Open Word (open_application "Word") and try again.' : ''}`.trim());
      }

      // 3. what Word holds is compared with what was recognised
      const cmp = compareBuilt(norm.spec, built);
      const warnings = Array.isArray(built['warnings']) ? (built['warnings'] as unknown[]).map(String) : [];
      return {
        ok: true,
        summary: `rebuilt the picture in a new Word document: ${describeSpec(norm.spec)}`,
        data: {
          recognised: describeSpec(norm.spec),
          document: built['name'],
          pages: built['pages'],
          sameShapeAsRecognised: cmp.same,
          differences: cmp.differences,
          warnings,
          notUnderstood: norm.dropped,
          note: 'This is a rebuild from a picture: ask the user to check the words, numbers and the look against the original, and fix what differs (a table with word_structure fix_table, looks with word_format).',
        },
      };
    },
  };
}
