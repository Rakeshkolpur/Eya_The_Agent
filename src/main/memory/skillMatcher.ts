import { contentTokens, distinguishingTokens, editDistance, isTypoOf, normalizeUtterance } from './normalize';
import type { SkillStore } from './SkillStore';
import type { Skill } from './types';

export interface SkillMatch {
  readonly skill: Skill;
  /** The saved wording that matched. */
  readonly trigger: string;
  /** 1 for an exact match; below 1 for a close one. */
  readonly score: number;
  readonly via: 'exact' | 'fuzzy';
  /** Sure enough to run without asking a model (exact, or a very close wording). */
  readonly strong: boolean;
}

/** A close wording must be at least this similar to run on its own... */
export const STRONG_FUZZY = 0.9;
/** ...and this similar to be worth mentioning to the model as a possibility. */
export const HINT_FUZZY = 0.72;
/** The best close match must beat the next-best (a different routine) by this much, or it is not clear which was meant. */
const MARGIN = 0.06;

interface Entry {
  readonly skillId: number;
  readonly text: string;
  readonly norm: string;
  readonly tokens: readonly string[];
  readonly content: readonly string[];
  readonly distinct: string;
}

function similarity(a: Entry, norm: string, tokens: readonly string[], content: readonly string[]): number {
  const longest = Math.max(a.norm.length, norm.length);
  if (longest === 0) return 0;
  const limit = Math.ceil(longest * 0.3);
  const chars = 1 - Math.min(editDistance(a.norm, norm, limit), limit + 1) / longest;
  // Words: how much of each side the other covers, allowing a slip of the fingers ("cuase" for "cause") but not a different word.
  const mine = new Set(a.content);
  const theirs = new Set(content);
  let shared = 0;
  for (const w of mine) {
    if (theirs.has(w) || [...theirs].some((t) => isTypoOf(w, t))) shared += 1;
  }
  const union = mine.size + theirs.size - shared;
  const words = union === 0 ? 0 : shared / union;
  void tokens;
  return Math.max(0, 0.5 * chars + 0.5 * words);
}

/**
 * Finds which saved routine, if any, a command means — locally, with no model. An exact match on the plain form of the wording is a
 * single lookup in a table already in memory. A close wording is accepted only when it is very close AND clearly the best AND doesn't
 * differ in a date, day or number from what was saved (so "tomorrow's" never matches a routine saved as "today's").
 *
 * The lookup table is built from SQLite and rebuilt whenever the routines change, so a match never costs a database query.
 */
export class SkillMatcher {
  private exact = new Map<string, Entry>();
  private entries: Entry[] = [];
  private skills = new Map<number, Skill>();
  private loaded = false;
  private readonly off: () => void;

  constructor(private readonly store: SkillStore) {
    this.off = store.onChange(() => {
      this.loaded = false;
    });
  }

  dispose(): void {
    this.off();
  }

  /** (Re)builds the in-memory lookup from the database. */
  refresh(): void {
    const entries: Entry[] = [];
    for (const t of this.store.enabledTriggers()) {
      const tokens = t.norm.split(' ').filter((w) => w !== '');
      entries.push({ skillId: t.skillId, text: t.text, norm: t.norm, tokens, content: contentTokens(t.norm), distinct: distinguishingTokens(t.norm).join(' ') });
    }
    this.entries = entries;
    this.exact = new Map(entries.map((e) => [e.norm, e]));
    this.skills = new Map(this.store.list().filter((s) => s.enabled).map((s) => [s.id, s]));
    this.loaded = true;
  }

  match(utterance: string): SkillMatch | null {
    if (!this.loaded) this.refresh();
    const norm = normalizeUtterance(utterance);
    if (norm === '' || this.entries.length === 0) return null;

    const hit = this.exact.get(norm);
    if (hit !== undefined) {
      const skill = this.skills.get(hit.skillId);
      if (skill !== undefined) return { skill, trigger: hit.text, score: 1, via: 'exact', strong: true };
    }

    const tokens = norm.split(' ');
    const content = contentTokens(norm);
    if (content.length === 0) return null;
    const distinct = distinguishingTokens(norm).join(' ');

    const best = new Map<number, { entry: Entry; score: number }>();
    for (const e of this.entries) {
      if (e.distinct !== distinct) continue; // a different date, day or number is a different request
      const score = similarity(e, norm, tokens, content);
      const have = best.get(e.skillId);
      if (have === undefined || score > have.score) best.set(e.skillId, { entry: e, score });
    }
    const ranked = [...best.values()].sort((a, b) => b.score - a.score);
    const top = ranked[0];
    if (top === undefined || top.score < HINT_FUZZY) return null;
    const second = ranked[1];
    const clear = second === undefined || top.score - second.score >= MARGIN;
    const skill = this.skills.get(top.entry.skillId);
    if (skill === undefined || !clear) return null;
    return { skill, trigger: top.entry.text, score: top.score, via: 'fuzzy', strong: top.score >= STRONG_FUZZY };
  }
}
