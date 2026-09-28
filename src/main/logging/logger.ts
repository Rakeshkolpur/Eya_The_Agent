import type { LogEntry } from '@shared/types';

type Level = LogEntry['level'];

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const activeLevel: Level = (process.env['EYA_LOG_LEVEL'] as Level) ?? 'info';

function emit(entry: LogEntry): void {
  if (LEVELS[entry.level] < LEVELS[activeLevel]) return;
  const line = JSON.stringify(entry);
  if (entry.level === 'error' || entry.level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  child(scope: string): Logger;
}

function make(scope: string): Logger {
  const at = (level: Level) => (message: string, data?: unknown) => {
    const entry: LogEntry = data === undefined
      ? { ts: Date.now(), level, scope, message }
      : { ts: Date.now(), level, scope, message, data };
    emit(entry);
  };
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (sub) => make(`${scope}.${sub}`),
  };
}

export const rootLogger = make('eya');
