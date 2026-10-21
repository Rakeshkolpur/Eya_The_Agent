import { rootLogger } from '@main/logging/logger';

const log = rootLogger.child('word');

/** What the Word helper answers: `ok`, and either its facts or `why` it could not. */
export interface WordAnswer {
  readonly ok: boolean;
  readonly why?: string;
  readonly detail?: string;
  readonly [key: string]: unknown;
}

/** The line to the PowerShell helper (writing/ReaderProcess.ts speaks it). */
export interface WordBackend {
  ask(cmd: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  close(): void;
}

export type WordCommand =
  | 'status'
  | 'read'
  | 'write'
  | 'format'
  | 'page_numbers'
  | 'toc'
  | 'table'
  | 'index'
  | 'fill_index'
  | 'header_footer'
  | 'page_setup'
  | 'break'
  | 'fields'
  | 'replace'
  | 'delete'
  | 'undo'
  | 'redo'
  | 'save'
  | 'goto'
  | 'scroll'
  | 'new'
  | 'analyze'
  | 'pages_of'
  | 'analyze_close'
  | 'apply_profile';

/**
 * Microsoft Word, driven through its own automation interface by a helper that stays running (word-helper.ps1). One method:
 * ask for a command, get the answer — a failure always comes back as `{ ok: false, why }` in words the model can pass on.
 * What is in the document is never logged.
 */
export class WordControl {
  constructor(private readonly backend: WordBackend) {}

  async run(cmd: WordCommand, args: Record<string, unknown> = {}): Promise<WordAnswer> {
    const started = Date.now();
    const answer = await this.backend.ask({ cmd, ...args });
    if (answer === null) {
      log.warn('word helper gave no answer', { cmd });
      return { ok: false, why: 'Eya could not reach Word just now (it may be busy with a dialog open). Try again in a moment.' };
    }
    const ok = answer['ok'] === true;
    log.info('word command', { cmd, ok, ms: Date.now() - started, ...(ok ? {} : { why: String(answer['why'] ?? '') }) });
    return { ...answer, ok } as WordAnswer;
  }

  close(): void {
    this.backend.close();
  }
}
