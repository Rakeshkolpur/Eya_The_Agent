import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { rootLogger } from '@main/logging/logger';

const log = rootLogger.child('env');

/**
 * Minimal .env loader. No deps. Loads KEY=value lines from .env at project
 * root (or app root in packaged builds). Existing process.env values win.
 *
 * Never logs values. Only announces which keys were populated.
 */
export function loadDotEnv(): void {
  const candidates = [
    join(process.cwd(), '.env'),
    join(app.getAppPath(), '.env'),
  ];

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
