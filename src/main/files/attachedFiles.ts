import { resolve } from 'node:path';

const KEEP = 200;

function keyOf(path: string): string {
  const full = resolve(path.trim());
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

/**
 * The files the person attached to a message, by exact path. Reading one is allowed wherever it sits (a file from a temp folder, an e-mail's
 * attachment cache, another drive) because the person chose it; only they can add to this list, from the attach button, a drop or a paste,
 * never the AI. Nothing else in the same folder becomes readable. The oldest entries are forgotten after a while.
 */
export class AttachedFiles {
  private readonly paths = new Map<string, true>();

  allow(paths: readonly string[]): void {
    for (const p of paths) {
      if (typeof p !== 'string' || p.trim() === '') continue;
      const key = keyOf(p);
      this.paths.delete(key);
      this.paths.set(key, true);
    }
    while (this.paths.size > KEEP) {
      const oldest = this.paths.keys().next().value;
      if (oldest === undefined) break;
      this.paths.delete(oldest);
    }
  }

  has(path: string): boolean {
    return path.trim() !== '' && this.paths.has(keyOf(path));
  }
}
