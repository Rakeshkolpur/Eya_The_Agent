import { mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'node-sqlite3-wasm';

/**
 * Eya's one local database: a real SQLite file, opened in-process (SQLite compiled to WebAssembly: no server to install and no
 * native module to build, so it behaves the same in the app and in the tests). Everything goes through parameterised
 * statements — values are never pasted into SQL text.
 */

export type SqlValue = string | number | boolean | null;

export interface Sql {
  run(sql: string, params?: readonly SqlValue[]): { readonly changes: number; readonly lastInsertRowid: number };
  get<T>(sql: string, params?: readonly SqlValue[]): T | undefined;
  all<T>(sql: string, params?: readonly SqlValue[]): T[];
  exec(sql: string): void;
  /** Runs `work` as one all-or-nothing change. */
  transaction<T>(work: () => T): T;
  close(): void;
}

class WasmSql implements Sql {
  private depth = 0;

  constructor(private readonly db: Database) {}

  run(sql: string, params: readonly SqlValue[] = []): { changes: number; lastInsertRowid: number } {
    const r = this.db.run(sql, [...params]);
    return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T>(sql: string, params: readonly SqlValue[] = []): T | undefined {
    return (this.db.get(sql, [...params]) ?? undefined) as T | undefined;
  }

  all<T>(sql: string, params: readonly SqlValue[] = []): T[] {
    return this.db.all(sql, [...params]) as unknown as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(work: () => T): T {
    // A change made inside another change simply joins it.
    if (this.depth > 0) return work();
    this.depth += 1;
    this.db.exec('BEGIN');
    try {
      const out = work();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // the original error is the one that matters
      }
      throw err;
    } finally {
      this.depth -= 1;
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

/** Opens (creating the folder and file if needed) the database at `path`. Use ':memory:'-style paths only in tests via a temp file. */
export function openDatabase(path: string): Sql {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec('PRAGMA foreign_keys = ON');
  return new WasmSql(db);
}

/**
 * If the file exists but is not a usable database (damaged, or not SQLite at all), it is moved aside — never deleted, so
 * nothing is lost for good — and a fresh one is started. Returns where the old one went, or null if it was fine.
 */
export function openDatabaseSafely(path: string, now: () => number = Date.now): { readonly db: Sql; readonly movedAside: string | null } {
  try {
    const db = openDatabase(path);
    db.get('SELECT count(*) AS n FROM sqlite_master'); // touches the file: a damaged one fails here
    return { db, movedAside: null };
  } catch (err) {
    if (!existsSync(path)) throw err;
    const aside = `${path}.damaged-${now()}`;
    renameSync(path, aside);
    return { db: openDatabase(path), movedAside: aside };
  }
}

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export class DatabaseTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(`The memory database is from a newer Eya (schema ${found}); this Eya understands up to ${supported}.`);
    this.name = 'DatabaseTooNewError';
  }
}

/**
 * Brings the database up to the latest schema, one numbered step at a time, each in its own transaction, recording the
 * version in SQLite's own `user_version`. Safe to run on every start. A database from a newer Eya is refused rather than guessed at.
 */
export function migrate(db: Sql, migrations: readonly Migration[]): { readonly from: number; readonly to: number } {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const latest = ordered[ordered.length - 1]?.version ?? 0;
  const from = db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
  if (from > latest) throw new DatabaseTooNewError(from, latest);
  for (const m of ordered) {
    if (m.version <= from) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
  }
  return { from, to: latest };
}
