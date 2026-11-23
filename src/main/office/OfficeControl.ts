import { rootLogger } from '@main/logging/logger';

const log = rootLogger.child('office');

/** What the Excel / PowerPoint helper answers: `ok`, and either its facts or `why` it could not (and `needsConfirm` when it wants a yes first). */
export interface OfficeAnswer {
  readonly ok: boolean;
  readonly why?: string;
  readonly needsConfirm?: boolean;
  readonly detail?: string;
  readonly [key: string]: unknown;
}

export interface OfficeBackend {
  ask(cmd: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown> | null>;
  close(): void;
}

export type OfficeApp = 'excel' | 'powerpoint';

/** Excel and PowerPoint, driven through their own automation interfaces by a helper that stays running (office-helper.ps1). What is in a workbook or a slide is never logged. */
export class OfficeControl {
  constructor(private readonly backend: OfficeBackend) {}

  async run(app: OfficeApp, op: string, args: Record<string, unknown> = {}, options: { readonly timeoutMs?: number } = {}): Promise<OfficeAnswer> {
    const started = Date.now();
    const answer = await this.backend.ask({ cmd: app, op, ...args }, options.timeoutMs);
    if (answer === null) {
      log.warn('office helper gave no answer', { app, op });
      return { ok: false, why: `Eya could not reach ${app === 'excel' ? 'Excel' : 'PowerPoint'} just now (it may be busy with a dialog open). Try again in a moment.` };
    }
    const ok = answer['ok'] === true;
    log.info('office command', { app, op, ok, ms: Date.now() - started, ...(ok ? {} : { why: String(answer['why'] ?? '') }) });
    return { ...answer, ok } as OfficeAnswer;
  }

  close(): void {
    this.backend.close();
  }
}
