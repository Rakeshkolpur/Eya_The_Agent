import type { ActivityKind } from '@shared/ipcContract';
import type { Sql } from './sqlite';

export interface NewActivity {
  readonly kind: ActivityKind;
  readonly title: string;
  readonly detail: string;
  readonly ok: boolean;
  /** What to run again for "Repeat" — empty for anything that must not be kept (chat apps, private requests). */
  readonly request: string;
  /** The site opened, for "frequently used websites"; empty otherwise. */
  readonly site: string;
}

export interface Activity extends NewActivity {
  readonly id: number;
  readonly at: string;
}

interface Row {
  id: number;
  at: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  ok: number;
  request: string;
  site: string;
}

const toActivity = (r: Row): Activity => ({ id: r.id, at: r.at, kind: r.kind, title: r.title, detail: r.detail, ok: r.ok === 1, request: r.request, site: r.site });

/** How much history is kept: the newest of these, and nothing older than the age limit. */
export const KEEP_ACTIVITIES = 300;
export const KEEP_ACTIVITY_DAYS = 90;

/**
 * The list of what Eya has done, in the memory database. Short titles and one line of outcome — enough for a Recent screen and a
 * "do that again" button, not a record of conversations. It is capped, ages out, and can be cleared at any time.
 */
export class ActivityStore {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly db: Sql,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  record(entry: NewActivity): number {
    const at = this.clock();
    const result = this.db.run('INSERT INTO activity (at, kind, title, detail, ok, request, site) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      at,
      entry.kind,
      entry.title,
      entry.detail,
      entry.ok ? 1 : 0,
      entry.request,
      entry.site,
    ]);
    this.prune(at);
    this.changed();
    return Number(result.lastInsertRowid);
  }

  /** Newest first. */
  list(limit = 100): Activity[] {
    return this.db.all<Row>('SELECT * FROM activity ORDER BY at DESC, id DESC LIMIT ?', [limit]).map(toActivity);
  }

  /** The sites opened most often lately. */
  sites(limit = 6): Array<{ site: string; count: number }> {
    return this.db.all<{ site: string; n: number }>(
      "SELECT site, count(*) AS n FROM activity WHERE site <> '' GROUP BY site ORDER BY n DESC, max(at) DESC LIMIT ?",
      [limit],
    ).map((r) => ({ site: r.site, count: r.n }));
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT count(*) AS n FROM activity')?.n ?? 0;
  }

  delete(id: number): boolean {
    const changed = this.db.run('DELETE FROM activity WHERE id = ?', [id]).changes > 0;
    if (changed) this.changed();
    return changed;
  }

  clear(): void {
    this.db.run('DELETE FROM activity');
    this.changed();
  }

  private prune(now: string): void {
    const cutoff = new Date(new Date(now).getTime() - KEEP_ACTIVITY_DAYS * 86_400_000).toISOString();
    this.db.run('DELETE FROM activity WHERE at < ?', [cutoff]);
    this.db.run('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY at DESC, id DESC LIMIT ?)', [KEEP_ACTIVITIES]);
  }
}
