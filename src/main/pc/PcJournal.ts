import { randomUUID } from 'node:crypto';
import { realIo } from '@main/privacy/communicationAccessStore';
import type { StoreIo } from '@main/privacy/communicationAccessStore';
import { rootLogger } from '@main/logging/logger';

const log = rootLogger.child('pc');

/** How many changes are remembered (the oldest go first). */
export const MAX_JOURNAL = 50;

/** What a variable was (or is): not set, or a value of a kind. */
export interface EnvState {
  readonly exists: boolean;
  readonly value: string;
  readonly kind: 'String' | 'ExpandString';
}

/**
 * One change Eya made to the environment of this PC, with what it was BEFORE and what it is AFTER, so that it can be undone ("undo that") — and so that the person can see what was
 * changed and when. A variable whose name says it is private (a key, a token, a password) is recorded WITHOUT its values: it is said that it was changed, and it cannot be undone
 * from this record, because the record would otherwise keep the secret.
 */
export interface PcChange {
  readonly id: string;
  readonly at: number;
  /**
   * `env`: a variable; `path`: the user's PATH; `install` / `uninstall`: a program was installed or removed; `temp`: temporary files were cleared; `rename`: the PC was renamed (`before` / `after`
   * hold the old and the new name). Only the first two can be undone from here: for the others, Eya says what to ask for instead.
   */
  readonly kind: PcChangeKind;
  readonly name: string;
  /** What was done, in words ("set JAVA_HOME", "added C:\\x to the PATH"). */
  readonly what: string;
  readonly before: EnvState | null;
  readonly after: EnvState | null;
  readonly undone: boolean;
}

/** `startup`: start-up apps turned off (before: the ids that were on); `stopped`: background programs stopped (before: what was running, to start again); `command`: a command the person agreed to. */
export type PcChangeKind = 'env' | 'path' | 'install' | 'uninstall' | 'temp' | 'rename' | 'startup' | 'stopped' | 'command';
const CHANGE_KINDS: readonly string[] = ['env', 'path', 'install', 'uninstall', 'temp', 'rename', 'startup', 'stopped', 'command'];

const isKind = (v: unknown): v is 'String' | 'ExpandString' => v === 'String' || v === 'ExpandString';

function readState(raw: unknown): EnvState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o['exists'] !== 'boolean' || typeof o['value'] !== 'string') return null;
  return { exists: o['exists'], value: o['value'].slice(0, 32_000), kind: isKind(o['kind']) ? o['kind'] : 'String' };
}

/** The record of what Eya changed, in one small file in her data folder. Nothing in it is ever sent anywhere. */
export class PcJournal {
  private changes: PcChange[] = [];

  constructor(
    private readonly path: string,
    private readonly io: StoreIo = realIo,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {
    try {
      const text = io.read(path);
      if (text !== null) {
        const raw = JSON.parse(text) as unknown;
        if (Array.isArray(raw)) {
          for (const c of raw) {
            const o = c as Record<string, unknown>;
            if (typeof o['id'] !== 'string' || typeof o['at'] !== 'number' || typeof o['kind'] !== 'string' || !CHANGE_KINDS.includes(o['kind']) || typeof o['name'] !== 'string' || typeof o['what'] !== 'string') continue;
            this.changes.push({ id: o['id'], at: o['at'], kind: o['kind'] as PcChangeKind, name: o['name'].slice(0, 128), what: o['what'].slice(0, 300), before: readState(o['before']), after: readState(o['after']), undone: o['undone'] === true });
          }
          this.changes = this.changes.slice(-MAX_JOURNAL);
        }
      }
    } catch {
      log.warn('the saved record of PC changes is not valid; starting without it');
    }
  }

  /** Newest last. */
  list(): readonly PcChange[] {
    return this.changes;
  }

  /** The most recent change that has not been undone, or the one with this id. */
  find(id?: string): PcChange | undefined {
    if (id !== undefined) return this.changes.find((c) => c.id === id);
    return [...this.changes].reverse().find((c) => !c.undone);
  }

  record(change: Omit<PcChange, 'id' | 'at' | 'undone'>): PcChange {
    const saved: PcChange = { ...change, id: this.newId(), at: this.now(), undone: false };
    this.changes = [...this.changes, saved].slice(-MAX_JOURNAL);
    this.save();
    return saved;
  }

  markUndone(id: string): void {
    this.changes = this.changes.map((c) => (c.id === id ? { ...c, undone: true } : c));
    this.save();
  }

  private save(): void {
    try {
      this.io.write(this.path, JSON.stringify(this.changes));
    } catch (err) {
      log.warn('could not save the record of PC changes', { err: String(err) });
    }
  }
}
