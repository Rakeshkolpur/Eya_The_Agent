import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { rootLogger } from '@main/logging/logger';

const log = rootLogger.child('env');

/**
 * Where a .env file may live. From source: the project folder. Installed: beside Eya.exe or in Eya's own data folder, and never the
 * folder the program happened to be started from (that is arbitrary: a shortcut, a terminal, someone else's project).
 */
export function dotEnvCandidates(packaged: boolean, where: { cwd: string; appPath: string; exeDir: string; userData: string }): string[] {
  return packaged ? [join(where.exeDir, '.env'), join(where.userData, '.env')] : [join(where.cwd, '.env'), join(where.appPath, '.env')];
}

/**
 * Minimal .env loader. No deps. Loads KEY=value lines from a .env file (see dotEnvCandidates). Existing process.env values win.
 *
 * Never logs values. Only announces which keys were populated.
 */
export function loadDotEnv(): void {
  const candidates = dotEnvCandidates(app.isPackaged, {
    cwd: process.cwd(),
    appPath: app.getAppPath(),
    exeDir: dirname(process.execPath),
    userData: app.getPath('userData'),
  });

  const seen = new Set<string>();
  for (const path of candidates) {
    if (seen.has(path)) continue;
    seen.add(path);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const applied: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
        applied.push(key);
      }
    }
    if (applied.length > 0) log.info('.env loaded', { path, keys: applied });
  }
}
