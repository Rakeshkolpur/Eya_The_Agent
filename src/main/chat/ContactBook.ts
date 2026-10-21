import type { Sql } from '@main/memory/sqlite';
import { looksLikeControl, normalizeText, resolveChat } from './contactMatch';
import type { ChatCandidate, ChatMatch } from './contactMatch';

/**
 * The names of the chats Eya has learned, so "message Ravi" can find the right chat without asking the model and without
 * reading the chat list again.
 *
 * What is kept: a chat's NAME as the app shows it, how often Eya opened it, and what the user calls it ("mom" for "Amma") once
 * they have confirmed a send under that name. What is never kept: a message, a preview, a time, a phone number or a picture.
 * Nothing is learned until the user has said yes (`learning()` is 'on'), and the names of an app are erased when the user turns
 * Chats off for it. All of it lives in the memory database on this PC.
 */

export type LearnChoice = 'on' | 'off' | 'unasked';

export interface Contact {
  readonly id: number;
  readonly app: string;
  readonly name: string;
  readonly useCount: number;
  readonly aliases: readonly string[];
}

interface ContactRow {
  id: number;
  app: string;
  name: string;
  name_norm: string;
  use_count: number;
}

export type ContactResolution =
  /** `via` 'usage': several fit, but one is plainly the chat the user messages (see `dominant`). */
  | { readonly kind: 'unique'; readonly contact: Contact; readonly via: 'name' | 'alias' | 'usage' }
  | { readonly kind: 'ambiguous'; readonly contacts: readonly Contact[] }
  | { readonly kind: 'none' };

const MAX_PER_APP = 2000;
const MAX_ALIASES_PER_CONTACT = 5;
// One chat is "the one" when it was opened at least this many times and this many times as often as any other that fits. A wrong guess
// is still caught — Eya always says who she found before anything is sent — but it is a guess, so it needs real evidence.
const DOMINANT_MIN_USES = 3;
const DOMINANT_RATIO = 3;

/** The one of several that is clearly the user's usual (opened often, and much more often than the rest), or null. */
function dominant<T>(items: readonly T[], uses: (item: T) => number): T | null {
  const ranked = [...items].sort((a, b) => uses(b) - uses(a));
  const top = ranked[0];
  if (top === undefined) return null;
  const next = ranked[1] === undefined ? 0 : uses(ranked[1]);
  return uses(top) >= DOMINANT_MIN_USES && uses(top) >= DOMINANT_RATIO * next ? top : null;
}

/** The words a chat app shows that are times and dates, not people. */
const TIME_WORDS = /^(today|yesterday|now|just now|mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|typing|online|offline|you|unread|muted|pinned|archived)$/;

/**
 * Whether a piece of text a chat app shows could be a person's or group's name — as opposed to a message, a link, a time, a
 * number or a button. This is the guard that keeps message text out of the list, so it is deliberately strict: a real name it
 * turns away costs a slower search once, a message it lets in would be a privacy mistake.
 */
export function isPlausibleChatName(label: string): boolean {
  const text = label.trim();
  if (text.length < 2 || text.length > 40) return false;
  if (looksLikeControl(text)) return false;
  const norm = normalizeText(text);
  if (norm === '' || TIME_WORDS.test(norm)) return false;
  if (!/\p{L}/u.test(text)) return false; // a name has letters
  if (text.split(/\s+/).length > 5) return false; // a sentence is a message
  if (/[?!:;"“”]|\.{2,}|…|https?:|www\.|@|\.(?:com|in|org|net|io)\b/i.test(text)) return false; // sentence marks, links, e-mail addresses
  if ((text.match(/\d/g) ?? []).length > 4) return false; // a phone number is shown for someone not saved; numbers are not kept
  if (/^\d{1,2}[:.]\d{2}\b/.test(text)) return false; // a time
  return true;
}

export class ContactBook {
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

  // ------------------------------------------------------------------------------ the user's choice
  learning(): LearnChoice {
    const value = this.db.get<{ value: string }>("SELECT value FROM contacts_meta WHERE key = 'learn'")?.value;
    return value === 'on' ? 'on' : value === 'off' ? 'off' : 'unasked';
  }

  setLearning(choice: 'on' | 'off'): void {
    this.db.run("INSERT INTO contacts_meta (key, value) VALUES ('learn', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [choice]);
    // Saying no also means: keep nothing.
    if (choice === 'off') this.forgetAll();
    else this.changed();
  }

  // ---------------------------------------------------------------------------------------- learning
  /**
   * Remembers names the app showed. Does nothing unless the user said yes. Only plausible names are kept; the rest is ignored
   * without a trace. Returns how many were new.
   */
  learn(app: string, labels: readonly string[]): number {
    if (this.learning() !== 'on') return 0;
    const now = this.clock();
    let added = 0;
    this.db.transaction(() => {
      let known = this.countFor(app);
      for (const label of labels) {
        const name = label.trim();
        if (!isPlausibleChatName(name)) continue;
        const norm = normalizeText(name);
        const exists = this.db.get<{ id: number }>('SELECT id FROM contacts WHERE app = ? AND name_norm = ?', [app, norm]);
        if (exists !== undefined) {
          this.db.run('UPDATE contacts SET last_seen = ? WHERE id = ?', [now, exists.id]); // the spelling first seen stays
          continue;
        }
        if (known >= MAX_PER_APP) break;
        this.db.run('INSERT INTO contacts (app, name, name_norm, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)', [app, name, norm, now, now]);
        known += 1;
        added += 1;
      }
    });
    if (added > 0) this.changed();
    return added;
  }

  /** A chat was opened for the user: remember it (even if it was not on the list yet) and that it is used. */
  used(app: string, label: string): void {
    if (this.learning() !== 'on' || !isPlausibleChatName(label)) return;
    this.learn(app, [label]);
    this.db.run('UPDATE contacts SET use_count = use_count + 1, last_used = ? WHERE app = ? AND name_norm = ?', [this.clock(), app, normalizeText(label)]);
    this.changed();
  }

  /** "mom" now means "Amma" — only called after the user confirmed a send to that chat under that name. */
  addAlias(app: string, name: string, alias: string): boolean {
    if (this.learning() !== 'on') return false;
    const aliasNorm = normalizeText(alias);
    if (aliasNorm === '' || aliasNorm === normalizeText(name) || !isPlausibleChatName(alias)) return false;
    const contact = this.db.get<ContactRow>('SELECT * FROM contacts WHERE app = ? AND name_norm = ?', [app, normalizeText(name)]);
    if (contact === undefined) return false;
    const have = this.db.get<{ n: number }>('SELECT count(*) AS n FROM contact_aliases WHERE contact_id = ?', [contact.id])?.n ?? 0;
    const exists = this.db.get<{ id: number }>('SELECT id FROM contact_aliases WHERE contact_id = ? AND alias_norm = ?', [contact.id, aliasNorm]);
    if (exists !== undefined || have >= MAX_ALIASES_PER_CONTACT) return false;
    this.db.run('INSERT INTO contact_aliases (contact_id, alias_norm, alias_text) VALUES (?, ?, ?)', [contact.id, aliasNorm, alias.trim()]);
    this.changed();
    return true;
  }

  /**
   * The user said what a word means ("when I say akka I mean Lakshmi Akka"): that word now opens that chat, whatever it meant before.
   * Their asking is their yes to Eya keeping it. Returns false when the name or the word is not something that can be kept.
   */
  setAlias(app: string, name: string, alias: string): boolean {
    const label = name.trim();
    const word = alias.trim();
    const aliasNorm = normalizeText(word);
    if (!isPlausibleChatName(label) || !isPlausibleChatName(word) || aliasNorm === '' || aliasNorm === normalizeText(label)) return false;
    if (this.learning() !== 'on') this.setLearning('on');
    this.learn(app, [label]);
    const contact = this.db.get<ContactRow>('SELECT * FROM contacts WHERE app = ? AND name_norm = ?', [app, normalizeText(label)]);
    if (contact === undefined) return false;
    this.db.transaction(() => {
      // One meaning for a word: any other chat that had it loses it.
      this.db.run('DELETE FROM contact_aliases WHERE alias_norm = ? AND contact_id IN (SELECT id FROM contacts WHERE app = ?)', [aliasNorm, app]);
      const have = this.db.get<{ n: number }>('SELECT count(*) AS n FROM contact_aliases WHERE contact_id = ?', [contact.id])?.n ?? 0;
      if (have >= MAX_ALIASES_PER_CONTACT) {
        this.db.run('DELETE FROM contact_aliases WHERE id = (SELECT min(id) FROM contact_aliases WHERE contact_id = ?)', [contact.id]);
      }
      this.db.run('INSERT INTO contact_aliases (contact_id, alias_norm, alias_text) VALUES (?, ?, ?)', [contact.id, aliasNorm, word]);
    });
    this.changed();
    return true;
  }

  /** Of these chat names (all of them showing for one search), the one the user messages most clearly, or null when none stands out. */
  favourite(app: string, labels: readonly string[]): string | null {
    const wanted = new Set(labels.map(normalizeText));
    const rows = this.db.all<ContactRow>('SELECT * FROM contacts WHERE app = ?', [app]).filter((r) => wanted.has(r.name_norm));
    return dominant(rows, (r) => r.use_count)?.name ?? null;
  }

  // ----------------------------------------------------------------------------------------- reading
  countFor(app: string): number {
    return this.db.get<{ n: number }>('SELECT count(*) AS n FROM contacts WHERE app = ?', [app])?.n ?? 0;
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT count(*) AS n FROM contacts')?.n ?? 0;
  }

  /** The most used first. For the Memory screen, where the user can see and delete them. */
  list(app?: string, limit = 500): Contact[] {
    const rows =
      app === undefined
        ? this.db.all<ContactRow>('SELECT * FROM contacts ORDER BY app, use_count DESC, name_norm LIMIT ?', [limit])
        : this.db.all<ContactRow>('SELECT * FROM contacts WHERE app = ? ORDER BY use_count DESC, name_norm LIMIT ?', [app, limit]);
    return rows.map((r) => this.toContact(r));
  }

  private toContact(r: ContactRow): Contact {
    const aliases = this.db.all<{ alias_text: string }>('SELECT alias_text FROM contact_aliases WHERE contact_id = ? ORDER BY id', [r.id]).map((a) => a.alias_text);
    return { id: r.id, app: r.app, name: r.name, useCount: r.use_count, aliases };
  }

  /**
   * Which saved chat the user means by `spoken`, using the same matching as the chat tools (whole name, first or last name, a
   * close spelling) plus the names they gave. A single clear answer is `unique`; if two could be meant it says so — nothing is guessed.
   */
  resolve(app: string, spoken: string): ContactResolution {
    const rows = this.db.all<ContactRow>('SELECT * FROM contacts WHERE app = ?', [app]);
    if (rows.length === 0) return { kind: 'none' };
    type Cand = ChatCandidate & { readonly row: ContactRow; readonly via: 'name' | 'alias' };
    const candidates: Cand[] = rows.map((row) => ({ label: row.name, row, via: 'name' as const }));
    for (const a of this.db.all<{ contact_id: number; alias_text: string }>(
      'SELECT contact_id, alias_text FROM contact_aliases WHERE contact_id IN (SELECT id FROM contacts WHERE app = ?)',
      [app],
    )) {
      const row = rows.find((r) => r.id === a.contact_id);
      if (row !== undefined) candidates.push({ label: a.alias_text, row, via: 'alias' });
    }
    const resolution = resolveChat(spoken, candidates);
    if (resolution.kind === 'none') return { kind: 'none' };
    if (resolution.kind === 'unique') return { kind: 'unique', contact: this.toContact(resolution.match.candidate.row), via: resolution.match.candidate.via };
    // The same person matched twice (by name and by what the user calls them) is one person.
    const ids = new Map<number, ChatMatch<Cand>>();
    for (const m of resolution.matches) if (!ids.has(m.candidate.row.id)) ids.set(m.candidate.row.id, m);
    if (ids.size === 1) {
      const only = [...ids.values()][0] as ChatMatch<Cand>;
      return { kind: 'unique', contact: this.toContact(only.candidate.row), via: only.candidate.via };
    }
    // Several people fit, but if one of them is plainly the chat this user messages ("akka" is the one opened ten times, the others once),
    // that is the one — and the question before sending still names who it is.
    const usual = dominant([...ids.values()], (m) => m.candidate.row.use_count);
    if (usual !== null) return { kind: 'unique', contact: this.toContact(usual.candidate.row), via: 'usage' };
    return { kind: 'ambiguous', contacts: [...ids.values()].map((m) => this.toContact(m.candidate.row)) };
  }

  /** Whether the first `count` words of `words` clearly name one saved chat (an exact or whole-word match, never a guess). */
  namesPrefix(app: string, words: readonly string[], count: number): ContactResolution {
    return this.resolve(app, words.slice(0, count).join(' '));
  }

  // ----------------------------------------------------------------------------------------- forgetting
  forget(id: number): boolean {
    this.db.run('DELETE FROM contact_aliases WHERE contact_id = ?', [id]);
    const gone = this.db.run('DELETE FROM contacts WHERE id = ?', [id]).changes > 0;
    if (gone) this.changed();
    return gone;
  }

  forgetApp(app: string): number {
    this.db.run('DELETE FROM contact_aliases WHERE contact_id IN (SELECT id FROM contacts WHERE app = ?)', [app]);
    const n = this.db.run('DELETE FROM contacts WHERE app = ?', [app]).changes;
    if (n > 0) this.changed();
    return n;
  }

  forgetAll(): number {
    this.db.run('DELETE FROM contact_aliases');
    const n = this.db.run('DELETE FROM contacts').changes;
    if (n > 0) this.changed();
    return n;
  }

  /** The names of chat apps that hold names right now (for erasing the ones Chats was turned off for). */
  apps(): string[] {
    return this.db.all<{ app: string }>('SELECT DISTINCT app FROM contacts').map((r) => r.app);
  }
}
