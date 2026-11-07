import { rootLogger } from '@main/logging/logger';
import { realIo } from '@main/privacy/communicationAccessStore';
import type { StoreIo } from '@main/privacy/communicationAccessStore';
import type { DoneCall, PluginTaskInfo, TaskEntity, TaskEvidence, TaskPhase, TaskState } from '@shared/tasks';
import { CoalescedWriter } from '@main/storage/CoalescedWriter';
import { MAX_DONE } from './ledger';

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
  /** The exact calls that changed something and worked, so that going at it again (even after Eya was closed) does not do them twice. */
  readonly done?: readonly DoneCall[];
  /**
   * Set for a task done through a plugin (a message or file sent in WhatsApp): which plugin and action, how far it has got, who it is for and what was seen
   * to happen. Such a task owns its own life: it is never carried on by itself (running it again is how a message would go twice).
   */
  readonly plugin?: PluginTaskInfo;
}

const STATES: readonly TaskState[] = ['running', 'waiting', 'needs_you', 'done', 'failed', 'cancelled'];
const PHASES: readonly TaskPhase[] = ['received', 'planning', 'executing', 'verifying', 'completed', 'waiting_clarification', 'waiting_permission', 'failed', 'cancelled', 'uncertain'];

function pluginOf(raw: unknown): { plugin?: PluginTaskInfo } {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const phase = PHASES.find((p) => p === r['phase']);
  if (typeof r['key'] !== 'string' || typeof r['plugin'] !== 'string' || typeof r['action'] !== 'string' || phase === undefined) return {};
  const entities = Array.isArray(r['entities'])
    ? r['entities'].flatMap((e): TaskEntity[] => {
        if (typeof e !== 'object' || e === null) return [];
        const x = e as Record<string, unknown>;
        return (x['kind'] === 'recipient' || x['kind'] === 'file') && typeof x['label'] === 'string' && typeof x['evidence'] === 'string'
          ? [{ kind: x['kind'], label: x['label'].slice(0, 120), evidence: x['evidence'].slice(0, 80), verified: x['verified'] === true }]
          : [];
      }).slice(-6)
    : [];
  const evidence = Array.isArray(r['evidence'])
    ? r['evidence'].flatMap((e): TaskEvidence[] => {
        if (typeof e !== 'object' || e === null) return [];
        const x = e as Record<string, unknown>;
        return typeof x['at'] === 'number' && Number.isFinite(x['at']) && typeof x['what'] === 'string' ? [{ at: x['at'], what: x['what'].slice(0, 160) }] : [];
      }).slice(-20)
    : [];
  const retries = typeof r['retries'] === 'number' && Number.isFinite(r['retries']) ? Math.max(0, Math.trunc(r['retries'])) : 0;
  return {
    plugin: {
      key: r['key'].slice(0, 60),
      plugin: r['plugin'].slice(0, 60),
      action: r['action'].slice(0, 60),
      phase,
      entities,
      evidence,
      retries,
      ...(typeof r['question'] === 'string' ? { question: r['question'].slice(0, 300) } : {}),
    },
  };
}

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
    ...doneOf(r['done']),
    ...pluginOf(r['plugin']),
  };
}

function doneOf(raw: unknown): { done?: DoneCall[] } {
  if (!Array.isArray(raw)) return {};
  const done = raw
    .filter((d): d is { key: string; summary: string } => typeof d === 'object' && d !== null && typeof (d as Record<string, unknown>)['key'] === 'string' && typeof (d as Record<string, unknown>)['summary'] === 'string')
    .slice(-MAX_DONE)
    .map((d) => ({ key: d.key.slice(0, 600), summary: d.summary.slice(0, 200) }));
  return done.length > 0 ? { done } : {};
}

/**
 * Where the tasks are kept: one small file in Eya's data folder, so a task survives the conversation ending, the app closing and the
 * PC restarting. It holds what the person asked for and what was done — never the contents of a chat or a file.
 */
export class TaskStore {
  /** For the progress of a task that is still going: many small changes in a row are written once, a moment after the last. */
  private readonly later = new CoalescedWriter(250);

  constructor(
    private readonly path: string,
    private readonly io: StoreIo = realIo,
  ) {}

  /** Writes the tasks in a moment (progress of a running task). A `save` or a `flush` before then writes at once. */
  saveSoon(tasks: readonly StoredTask[]): void {
    this.later.schedule(() => this.write(tasks));
  }

  /** Writes what is waiting to be written (the app is closing). */
  flush(): void {
    this.later.flush();
  }

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
    // (a fuller save is being written now, so what was waiting for later would only be older)
    this.later.cancel();
    this.write(tasks);
  }

  private write(tasks: readonly StoredTask[]): void {
    try {
      this.io.write(this.path, JSON.stringify({ version: 1, tasks }, null, 1));
    } catch (err) {
      log.warn('could not save the tasks; they last until Eya is closed', { err: String(err) });
    }
  }
}
