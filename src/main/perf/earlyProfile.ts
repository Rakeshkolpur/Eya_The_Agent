import { readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { parsePerformanceSetting } from '@shared/performance';
import type { Hardware, PerformanceSetting } from '@shared/performance';

/**
 * What Eya needs to know about the performance level BEFORE the app is ready: Chromium's graphics acceleration can only be switched
 * off before it starts, so the saved choice is read straight from the settings file (no Electron, no logger) and the machine is asked
 * what it has. A missing, unreadable or damaged file means "automatic".
 */

export function readSavedPerformance(settingsPath: string): PerformanceSetting {
  try {
    const text = readFileSync(settingsPath, 'utf8').replace(/^﻿/, '');
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsePerformanceSetting((parsed as Record<string, unknown>)['performance']) : 'auto';
  } catch {
    return 'auto';
  }
}

export function currentHardware(): Hardware {
  return { totalMemBytes: totalmem(), logicalCores: cpus().length };
}
