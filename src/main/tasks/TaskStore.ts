import { rootLogger } from '@main/logging/logger';
import { realIo } from '@main/privacy/communicationAccessStore';
import type { StoreIo } from '@main/privacy/communicationAccessStore';
import type { TaskState } from '@shared/tasks';

const log = rootLogger.child('tasks');

/** One task as it is kept on disk. */
export interface StoredTask {
  readonly id: string;
  /** What the person asked for, in their words. */
  readonly request: string;
  readonly source: 'text' | 'voice' | 'live';
  readonly state: TaskState;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** How many times Eya has gone at it (the first go counts). */
  readonly attempts: number;
  readonly retryAt?: number;
  /** One line: what is happening, what is waited for, or how it ended. */
  readonly note: string;
  /** What had been done so far, so that going at it again does not repeat it. */
  readonly steps: readonly string[];
  /** The note is a question a yes or a no answers. */
  readonly asks?: boolean;
  /** Waiting for the person in the browser (a check, a sign-in): Eya watches and carries on by herself. */
  readonly watch?: 'browser';
  /** Whether the person has been told it is over (or that it needs them), so they are not told twice. */
  readonly told?: boolean;
}

const STATES: readonly TaskState[] = ['running', 'waiting', 'needs_you', 'done', 'failed', 'cancelled'];

function parseTask(raw: unknown): StoredTask | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || typeof r['request'] !== 'string' || r['request'] === '') return null;
  const state = STATES.find((s) => s === r['state']);
  if (state === undefined) return null;
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const source = r['source'] === 'voice' || r['source'] === 'live' ? r['source'] : 'text';
  return {
    id: r['id'],
    request: r['request'].slice(0, 500),
    source,
    state,
    createdAt: num(r['createdAt'], 0),
    updatedAt: num(r['updatedAt'], 0),
    attempts: Math.max(0, Math.trunc(num(r['attempts'], 0))),
    ...(typeof r['retryAt'] === 'number' && Number.isFinite(r['retryAt']) ? { retryAt: r['retryAt'] } : {}),
    note: typeof r['note'] === 'string' ? r['note'].slice(0, 400) : '',
    steps: Array.isArray(r['steps']) ? r['steps'].filter((s): s is string => typeof s === 'string').slice(-20).map((s) => s.slice(0, 200)) : [],
    ...(r['asks'] === true ? { asks: true } : {}),
    ...(r['watch'] === 'browser' ? { watch: 'browser' as const } : {}),
    ...(r['told'] === true ? { told: true } : {}),
  };
}

/**
 * Where the tasks are kept: one small file in Eya's data folder, so a task survives the conversation ending, the app closing and the
 * PC restarting. It holds what the person asked for and what was done — never the contents of a chat or a file.
 */
export class TaskStore {
  constructor(
    private readonly path: string,
    private readonly io: StoreIo = realIo,
  ) {}

  load(): StoredTask[] {
    const text = this.io.read(this.path);
    if (text === null) return [];
    try {
      const raw = JSON.parse(text) as { tasks?: unknown };
      const list = Array.isArray(raw.tasks) ? raw.tasks : [];
      return list.flatMap((t) => {
        const parsed = parseTask(t);
        return parsed === null ? [] : [parsed];
      });
    } catch {
      log.warn('the tasks file is not valid; starting with none');
      return [];
    }
  }

  save(tasks: readonly StoredTask[]): void {
    try {
      this.io.write(this.path, JSON.stringify({ version: 1, tasks }, null, 1));
    } catch (err) {
      log.warn('could not save the tasks; they last until Eya is closed', { err: String(err) });
    }
  }
}
