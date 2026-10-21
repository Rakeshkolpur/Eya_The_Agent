import type { Sql } from './sqlite';
import { contentTokens, looksSensitive, normalizeKey, normalizeUtterance } from './normalize';
import type { Memory, MemoryType } from './types';

const MAX_KEY = 120;
const MAX_VALUE = 500;

interface Row {
  id: number;
  type: MemoryType;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

const toMemory = (r: Row): Memory => ({ id: r.id, type: r.type, key: r.key, value: r.value, createdAt: r.created_at, updatedAt: r.updated_at });

export class MemoryRejected extends Error {
  constructor(
    readonly why: 'empty' | 'too_long' | 'sensitive' | 'bad_type',
    message: string,
  ) {
    super(message);
    this.name = 'MemoryRejected';
  }
}

/**
 * Preferences and facts the user asked Eya to keep. Small, structured, one row per (type, key): saying the same thing again
 * updates it rather than piling up. Passwords, one-time codes and card numbers are refused outright.
 */
export class MemoryStore {
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

  /** Saves, or updates what is already saved under the same key. Says which it did. */
  save(type: MemoryType, key: string, value: string): { readonly memory: Memory; readonly created: boolean } {
    if (type !== 'preference' && type !== 'fact') throw new MemoryRejected('bad_type', 'A memory is either a preference or a fact.');
    const k = key.trim();
    const v = value.trim();
    if (k === '' || v === '') throw new MemoryRejected('empty', 'There is nothing to remember: a name and a value are both needed.');
    if (k.length > MAX_KEY || v.length > MAX_VALUE) throw new MemoryRejected('too_long', 'That is too long to keep as a memory. Keep it short.');
    if (looksSensitive(k) || looksSensitive(v)) throw new MemoryRejected('sensitive', "I don't keep passwords, codes or card numbers.");
    const norm = normalizeKey(k);
    if (norm === '') throw new MemoryRejected('empty', 'There is nothing to remember: the name has no words in it.');
    const at = this.clock();
    const existing = this.db.get<Row>('SELECT * FROM memories WHERE type = ? AND key_norm = ?', [type, norm]);
    if (existing !== undefined) {
      this.db.run('UPDATE memories SET key = ?, value = ?, updated_at = ? WHERE id = ?', [k, v, at, existing.id]);
      this.changed();
      return { memory: toMemory({ ...existing, key: k, value: v, updated_at: at }), created: false };
    }
    const r = this.db.run('INSERT INTO memories (type, key, key_norm, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [type, k, norm, v, at, at]);
    this.changed();
    return { memory: { id: r.lastInsertRowid, type, key: k, value: v, createdAt: at, updatedAt: at }, created: true };
  }

  get(id: number): Memory | undefined {
    const r = this.db.get<Row>('SELECT * FROM memories WHERE id = ?', [id]);
    return r === undefined ? undefined : toMemory(r);
  }

  getByKey(type: MemoryType, key: string): Memory | undefined {
    const r = this.db.get<Row>('SELECT * FROM memories WHERE type = ? AND key_norm = ?', [type, normalizeKey(key)]);
    return r === undefined ? undefined : toMemory(r);
  }

  /** Newest first. */
  list(type?: MemoryType): Memory[] {
    const rows = type === undefined ? this.db.all<Row>('SELECT * FROM memories ORDER BY updated_at DESC, id DESC') : this.db.all<Row>('SELECT * FROM memories WHERE type = ? ORDER BY updated_at DESC, id DESC', [type]);
    return rows.map(toMemory);
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT count(*) AS n FROM memories')?.n ?? 0;
  }

  update(id: number, patch: { readonly key?: string; readonly value?: string }): Memory | undefined {
    const current = this.get(id);
    if (current === undefined) return undefined;
    const key = (patch.key ?? current.key).trim();
    const value = (patch.value ?? current.value).trim();
    if (key === '' || value === '') throw new MemoryRejected('empty', 'A memory needs both a name and a value.');
    if (key.length > MAX_KEY || value.length > MAX_VALUE) throw new MemoryRejected('too_long', 'That is too long to keep as a memory.');
    if (looksSensitive(key) || looksSensitive(value)) throw new MemoryRejected('sensitive', "I don't keep passwords, codes or card numbers.");
    const norm = normalizeKey(key);
    const clash = this.db.get<Row>('SELECT * FROM memories WHERE type = ? AND key_norm = ? AND id <> ?', [current.type, norm, id]);
    if (clash !== undefined) throw new MemoryRejected('empty', `There is already a ${current.type} called "${clash.key}".`);
    const at = this.clock();
    this.db.run('UPDATE memories SET key = ?, key_norm = ?, value = ?, updated_at = ? WHERE id = ?', [key, norm, value, at, id]);
    this.changed();
    return { ...current, key, value, updatedAt: at };
  }

  delete(id: number): boolean {
    const r = this.db.run('DELETE FROM memories WHERE id = ?', [id]);
    if (r.changes > 0) this.changed();
    return r.changes > 0;
  }

  /** Deletes the memory whose key matches (any type unless one is given). Returns what was removed. */
  deleteByKey(key: string, type?: MemoryType): Memory[] {
    const norm = normalizeKey(key);
    if (norm === '') return [];
    const rows = type === undefined ? this.db.all<Row>('SELECT * FROM memories WHERE key_norm = ?', [norm]) : this.db.all<Row>('SELECT * FROM memories WHERE key_norm = ? AND type = ?', [norm, type]);
    for (const r of rows) this.db.run('DELETE FROM memories WHERE id = ?', [r.id]);
    if (rows.length > 0) this.changed();
    return rows.map(toMemory);
  }

  /**
   * The memories worth putting in front of the model for this request: every preference (they apply to everything — there are
   * few) and the facts that share a word with the request, best overlap first. Plain code over a small table: no model involved.
   */
  relevant(text: string, limit = 12): Memory[] {
    const wanted = new Set(contentTokens(normalizeUtterance(text)));
    const prefs = this.list('preference').slice(0, limit);
    if (wanted.size === 0) return prefs;
    const facts = this.list('fact')
      .map((m) => ({ m, overlap: contentTokens(normalizeKey(`${m.key} ${m.value}`)).filter((w) => wanted.has(w)).length }))
      .filter((x) => x.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, Math.max(0, limit - prefs.length))
      .map((x) => x.m);
    return [...prefs, ...facts];
  }
}
