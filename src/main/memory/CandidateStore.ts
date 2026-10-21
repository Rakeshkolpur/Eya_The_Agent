import type { Sql } from './sqlite';
import type { NewStep } from './types';

export interface Candidate {
  readonly signature: string;
  readonly count: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly declined: boolean;
  /** Words the final page had in EVERY run so far — what a "the page says…" check can safely rest on. */
  readonly commonWords: readonly string[];
  readonly steps: readonly NewStep[];
  /** The short wordings the user used, most used first (the one said first wins a tie). */
  readonly phrases: ReadonlyArray<{ readonly norm: string; readonly text: string; readonly count: number }>;
}

const MAX_CANDIDATES = 200;
const MAX_PHRASES = 8;
const STALE_DAYS = 45;

interface CandidateRow {
  signature: string;
  count: number;
  first_seen: string;
  last_seen: string;
  declined: number;
  common_words: string;
}

/**
 * Tasks Eya has done successfully the same way — kept only as a step signature, a count, the steps, and the short wordings used.
 * Not a log of what the user did or said: it exists so Eya can notice "you've done this several times" and offer to save it.
 * Old ones that never repeated are dropped, and the table is capped.
 */
export class CandidateStore {
  constructor(private readonly db: Sql) {}

  get(signature: string): Candidate | undefined {
    const c = this.db.get<CandidateRow>('SELECT * FROM task_candidates WHERE signature = ?', [signature]);
    if (c === undefined) return undefined;
    const steps = this.db
      .all<{ action: string; target: string; value: string; submit: number; verify_kind: string; verify_text: string }>(
        'SELECT action, target, value, submit, verify_kind, verify_text FROM task_candidate_steps WHERE signature = ? ORDER BY position',
        [signature],
      )
      .map((r): NewStep => ({ action: r.action as NewStep['action'], target: r.target, value: r.value, submit: r.submit === 1, verifyKind: r.verify_kind as NewStep['verifyKind'], verifyText: r.verify_text }));
    const phrases = this.db
      .all<{ phrase_norm: string; phrase_text: string; count: number }>('SELECT phrase_norm, phrase_text, count FROM task_candidate_phrases WHERE signature = ? ORDER BY count DESC, rowid', [signature])
      .map((p) => ({ norm: p.phrase_norm, text: p.phrase_text, count: p.count }));
    return {
      signature,
      count: c.count,
      firstSeen: c.first_seen,
      lastSeen: c.last_seen,
      declined: c.declined === 1,
      commonWords: c.common_words === '' ? [] : c.common_words.split(' '),
      steps,
      phrases,
    };
  }

  /** Counts one more successful run of this signature, keeping its latest steps, wording and the words every run's final page shared. */
  observe(signature: string, steps: readonly NewStep[], phrase: { norm: string; text: string } | null, words: readonly string[], at: string): Candidate {
    this.db.transaction(() => {
      const existing = this.db.get<CandidateRow>('SELECT * FROM task_candidates WHERE signature = ?', [signature]);
      if (existing === undefined) {
        this.db.run('INSERT INTO task_candidates (signature, count, first_seen, last_seen, declined, common_words) VALUES (?, 1, ?, ?, 0, ?)', [signature, at, at, words.join(' ')]);
      } else {
        const before = new Set(existing.common_words === '' ? [] : existing.common_words.split(' '));
        const kept = existing.count === 0 ? [...words] : words.filter((w) => before.has(w));
        this.db.run('UPDATE task_candidates SET count = count + 1, last_seen = ?, common_words = ? WHERE signature = ?', [at, kept.join(' '), signature]);
      }
      this.db.run('DELETE FROM task_candidate_steps WHERE signature = ?', [signature]);
      steps.forEach((s, i) =>
        this.db.run('INSERT INTO task_candidate_steps (signature, position, action, target, value, submit, verify_kind, verify_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
          signature,
          i + 1,
          s.action,
          s.target,
          s.value,
          s.submit ? 1 : 0,
          s.verifyKind,
          s.verifyText,
        ]),
      );
      if (phrase !== null && phrase.norm !== '') {
        const have = this.db.get<{ count: number }>('SELECT count FROM task_candidate_phrases WHERE signature = ? AND phrase_norm = ?', [signature, phrase.norm]);
        if (have === undefined) this.db.run('INSERT INTO task_candidate_phrases (signature, phrase_norm, phrase_text, count) VALUES (?, ?, ?, 1)', [signature, phrase.norm, phrase.text]);
        else this.db.run('UPDATE task_candidate_phrases SET count = count + 1, phrase_text = ? WHERE signature = ? AND phrase_norm = ?', [phrase.text, signature, phrase.norm]);
        this.db.run(
          'DELETE FROM task_candidate_phrases WHERE signature = ? AND phrase_norm NOT IN (SELECT phrase_norm FROM task_candidate_phrases WHERE signature = ? ORDER BY count DESC, rowid LIMIT ?)',
          [signature, signature, MAX_PHRASES],
        );
      }
    });
    return this.get(signature) as Candidate;
  }

  /** "No thanks": never offer this one again (the signature stays, so it is remembered as declined). */
  decline(signature: string): void {
    this.db.run('UPDATE task_candidates SET declined = 1 WHERE signature = ?', [signature]);
  }

  remove(signature: string): void {
    this.db.run('DELETE FROM task_candidates WHERE signature = ?', [signature]);
  }

  /** Drops candidates that never repeated and have gone stale, and the oldest beyond a cap. Declined ones are kept (that is the point). */
  prune(now: Date): number {
    const cutoff = new Date(now.getTime() - STALE_DAYS * 86_400_000).toISOString();
    let removed = this.db.run('DELETE FROM task_candidates WHERE declined = 0 AND last_seen < ?', [cutoff]).changes;
    removed += this.db.run(
      'DELETE FROM task_candidates WHERE declined = 0 AND signature NOT IN (SELECT signature FROM task_candidates ORDER BY last_seen DESC LIMIT ?)',
      [MAX_CANDIDATES],
    ).changes;
    return removed;
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT count(*) AS n FROM task_candidates')?.n ?? 0;
  }
}
