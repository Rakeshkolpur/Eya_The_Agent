import { readFileSync } from 'node:fs';
import { rootLogger } from '@main/logging/logger';
import { readSlangEntry, setCustomSlang } from './slangLibrary';
import type { SlangEntry } from './slangLibrary';

const log = rootLogger.child('persona');

/** At most this many of the person's own expressions are kept (the instructions stay small). */
export const MAX_CUSTOM = 60;

/**
 * Reads the person's own expressions from a small JSON file (a list of { expression, meaning, context, example, formality?, seriousOk?, kind?, tones? }) and adds them to what Eya
 * knows. A file that is missing or broken changes nothing; an entry that is incomplete is skipped. Returns how many were taken.
 */
export function loadCustomSlang(path: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): number {
  let entries: SlangEntry[] = [];
  try {
    const raw = JSON.parse(read(path)) as unknown;
    const list = Array.isArray(raw) ? raw : typeof raw === 'object' && raw !== null && Array.isArray((raw as { entries?: unknown }).entries) ? (raw as { entries: unknown[] }).entries : [];
    entries = list.map(readSlangEntry).filter((x): x is SlangEntry => x !== null).slice(0, MAX_CUSTOM);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('the personal slang file could not be read; using the built-in words', { err: String(err).slice(0, 120) });
    entries = [];
  }
  setCustomSlang(entries);
  return entries.length;
}
