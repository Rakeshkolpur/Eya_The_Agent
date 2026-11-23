import { rootLogger } from '@main/logging/logger';
import { clockPhrase } from '@shared/quotaReset';
import {
  MAX_FAMILY_KEYS,
  cleanKeyName,
  extractKey,
  keyHint,
  looksLikeGeminiKey,
  parseKeyLines,
  whyNotAKey,
} from '@shared/geminiKeys';
import type { GeminiKeysInput, GeminiKeysResult, GeminiKeysStatus, KeyLine } from '@shared/geminiKeys';
import type { KeyCheck, KeyCrypto, KeyFiles } from './geminiKey';
import { keyId } from './geminiKeyPool';
import type { GeminiKeyPool } from './geminiKeyPool';

const log = rootLogger.child('ai.keys');

interface StoredKey {
  readonly name: string;
  readonly key: string;
}

function parseStored(text: string): StoredKey[] {
  const raw = JSON.parse(text) as { keys?: unknown };
  if (!Array.isArray(raw.keys)) return [];
  const out: StoredKey[] = [];
  for (const item of raw.keys) {
    const o = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const key = typeof o['key'] === 'string' ? o['key'].trim() : '';
    if (!looksLikeGeminiKey(key) || out.some((k) => k.key === key)) continue;
    out.push({ name: typeof o['name'] === 'string' ? cleanKeyName(o['name']) : '', key });
  }
  return out.slice(0, MAX_FAMILY_KEYS);
}

/**
 * The extra Gemini keys (family, friends): one small file in Eya's data folder, encrypted by Windows for this user, like the others. If
 * Windows cannot protect it nothing is saved at all.
 */
export class FamilyKeyStore {
  constructor(
    private readonly path: string,
    private readonly crypto: KeyCrypto,
    private readonly files: KeyFiles,
  ) {}

  get canSave(): boolean {
    try {
      return this.crypto.isAvailable();
    } catch {
      return false;
    }
  }

  load(): StoredKey[] {
    const data = this.files.read(this.path);
    if (data === null || data.length === 0) return [];
    try {
      return parseStored(this.crypto.decrypt(data));
    } catch {
      return [];
    }
  }

  save(keys: readonly StoredKey[]): boolean {
    if (!this.canSave) return false;
    try {
      this.files.write(this.path, this.crypto.encrypt(JSON.stringify({ version: 1, keys })));
      return true;
    } catch {
      return false;
    }
  }
}

export interface GeminiKeysDeps {
  readonly store: FamilyKeyStore;
  readonly pool: GeminiKeyPool;
  /** The person's own key (from .env or Settings), if they have one. */
  readonly mainKey: () => string | null;
  /** Asks Google whether a key is accepted. Without it a well-formed key is saved unchecked. */
  readonly check?: (key: string) => Promise<KeyCheck>;
  readonly now?: () => number;
  /** Called when a key has just been added or found working: Gemini may have been left alone as a whole (every key was used up), and must be asked again now. */
  readonly revive?: () => void;
}

/** The person's own key and the extra ones, as one list the person manages: add, remove, test; the pool does the using. */
export class GeminiKeysService {
  private family: StoredKey[] = [];
  private startedWithKey = false;

  constructor(private readonly deps: GeminiKeysDeps) {}

  /** Call once at start-up: loads the saved extra keys and puts them to work after the person's own. */
  start(): void {
    this.family = this.deps.store.load();
    this.apply();
    this.startedWithKey = this.deps.pool.hasKey();
  }

  status(): GeminiKeysStatus {
    return {
      canSave: this.deps.store.canSave,
      max: MAX_FAMILY_KEYS,
      entries: this.deps.pool.status(),
      pendingRestart: !this.startedWithKey && this.deps.pool.hasKey(),
    };
  }

  async add(input: unknown): Promise<GeminiKeysResult> {
    if (!this.deps.store.canSave) {
      return this.result(false, "Windows can't protect saved keys on this account, so I haven't saved any. Nothing was changed.");
    }
    const { lines, skippedLines, problem } = this.read(input);
    if (lines.length === 0) return this.result(false, problem);
    const accepted: StoredKey[] = [];
    const notes: string[] = [];
    const taken = new Set<string>([...this.all().map((k) => keyId(k.key))]);
    for (const line of lines) {
      const who = line.name !== '' ? line.name : `Key ${this.family.length + accepted.length + 2}`;
      if (taken.has(keyId(line.key))) {
        notes.push(`${who} was already added`);
        continue;
      }
      if (this.family.length + accepted.length >= MAX_FAMILY_KEYS) {
        notes.push(`${who} was left out: ${MAX_FAMILY_KEYS} extra keys is the most`);
        continue;
      }
      if (this.deps.check !== undefined) {
        const verdict = await this.deps.check(line.key).catch((): KeyCheck => 'unreachable');
        if (verdict === 'invalid') {
          notes.push(`Google says ${who}'s key is not valid (${keyHint(line.key)})`);
          continue;
        }
        if (verdict === 'unreachable') notes.push(`I couldn't reach Google to check ${who}'s key, so it is saved unchecked`);
      }
      accepted.push({ name: who, key: line.key });
      taken.add(keyId(line.key));
    }
    if (accepted.length === 0) return this.result(false, `${notes.length > 0 ? `${notes.join('. ')}. ` : ''}Nothing was saved.`);
    // Put them into the list as it is NOW: while Google was being asked, another add (a second press of the button) or a removal may have
    // finished, and writing back the list as it was before would lose it.
    const next = [...this.family];
    const added: string[] = [];
    for (const a of accepted) {
      if (next.length >= MAX_FAMILY_KEYS || next.some((k) => keyId(k.key) === keyId(a.key))) continue;
      const name = this.uniqueName(a.name, next);
      next.push({ name, key: a.key });
      added.push(name);
    }
    if (added.length === 0) return this.result(false, `${notes.length > 0 ? `${notes.join('. ')}. ` : ''}Nothing new was saved.`);
    if (!this.deps.store.save(next)) return this.result(false, "I couldn't save the keys. Nothing was changed.");
    this.family = next;
    this.apply();
    this.deps.revive?.();
    log.info('extra Gemini keys added', { added: added.length, total: this.family.length });
    const skipped = skippedLines.length > 0 ? ` I couldn't find a key on line${skippedLines.length === 1 ? '' : 's'} ${skippedLines.join(', ')}.` : '';
    const tail = notes.length > 0 ? ` ${notes.join('. ')}.` : '';
    return this.result(true, `Added ${added.join(', ')}. Eya now uses ${this.deps.pool.status().length} keys, one after another, moving to the next when one's free allowance for the day is used up.${tail}${skipped}`);
  }

  remove(id: unknown): GeminiKeysResult {
    const target = this.family.find((k) => keyId(k.key) === id);
    if (typeof id !== 'string' || target === undefined) return this.result(false, 'That key is not in the list of extra keys. (Your own key is changed under "Paste your key".)');
    const next = this.family.filter((k) => k !== target);
    if (!this.deps.store.save(next)) return this.result(false, "I couldn't save that change. Nothing was removed.");
    this.family = next;
    this.apply();
    return this.result(true, `Removed ${target.name}'s key.`);
  }

  /** Asks that key one tiny question and says plainly how it stands. */
  async test(id: unknown, now: Date = new Date(this.deps.now?.() ?? Date.now())): Promise<GeminiKeysResult> {
    const entry = typeof id === 'string' ? this.deps.pool.status().find((e) => e.id === id) : undefined;
    if (entry === undefined) return this.result(false, 'There is no such key in the list.');
    const r = await this.deps.pool.testKey(entry.id);
    const who = entry.main ? 'Your own key' : `${entry.name}'s key`;
    if (r.ok) {
      this.deps.revive?.();
      return this.result(true, `${who} works.`);
    }
    switch (r.kind) {
      case 'daily':
        return this.result(false, `${who} works, but its free allowance for today is used up${r.backAt !== null ? `. Eya will try it again ${clockPhrase(new Date(r.backAt), now)}` : ''}; she is using the next key meanwhile.`);
      case 'rate':
        return this.result(false, `${who} is being slowed down by Google for a minute (too many requests). Eya will use another key meanwhile and come back to it.`);
      case 'auth':
        return this.result(false, `Google refused ${who}: it is not valid, was deleted, or the Gemini API is switched off for that account. Remove it and add a new one.`);
      case 'overloaded':
        return this.result(false, `Gemini is overloaded for the moment, so ${who} could not be tested. Try again shortly.`);
      default:
        return this.result(false, `I couldn't test ${who} just now (no answer from Google). Check the internet and try again.`);
    }
  }

  // ---- internals

  /**
   * What was typed or pasted, as keys. The key box is read as forgivingly as the "several" box: a name or quotes around the key, a stray
   * line, two people's keys pasted together all still give the keys that are there. When there are none, `problem` says why.
   */
  private read(input: unknown): { lines: readonly KeyLine[]; skippedLines: readonly number[]; problem: string } {
    const o = (typeof input === 'object' && input !== null ? input : {}) as Partial<GeminiKeysInput> & Record<string, unknown>;
    const several = typeof o['lines'] === 'string';
    let text = several ? (o['lines'] as string) : typeof o['key'] === 'string' ? o['key'] : '';
    let rawName = typeof o['name'] === 'string' ? o['name'] : '';
    // The key typed into the name box and the name into the key box (an easy slip with two boxes): put them the right way round.
    if (!several && extractKey(text) === undefined && extractKey(rawName) !== undefined) [text, rawName] = [rawName, text];
    const boxName = cleanKeyName(rawName);
    const parsed = parseKeyLines(text);
    if (parsed.entries.length === 0) {
      const first = text.split('\n').find((line) => line.trim() !== '') ?? '';
      const why = whyNotAKey(first);
      return { lines: [], skippedLines: parsed.skippedLines, problem: several && first !== '' ? `I couldn't find a Gemini key in what you pasted. About the first line: ${why}` : why };
    }
    // (A name typed in the name box goes with the first key when the pasted text did not carry one.)
    const lines = parsed.entries.map((e, i) => ({ name: i === 0 && boxName !== '' && (!several || e.name === '') ? boxName : e.name, key: e.key }));
    return { lines, skippedLines: parsed.skippedLines, problem: '' };
  }

  private all(): Array<{ name: string; key: string; main: boolean }> {
    const main = this.deps.mainKey();
    return [...(main !== null && main !== '' ? [{ name: 'Your own key', key: main, main: true }] : []), ...this.family.map((k, i) => ({ name: k.name !== '' ? k.name : `Key ${i + 2}`, key: k.key, main: false }))];
  }

  private apply(): void {
    this.deps.pool.setKeys(this.all());
  }

  private uniqueName(name: string, existing: readonly StoredKey[]): string {
    const names = new Set(existing.map((k) => k.name.toLowerCase()));
    if (!names.has(name.toLowerCase())) return name;
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${name} ${n}`;
      if (!names.has(candidate.toLowerCase())) return candidate;
    }
    return name;
  }

  private result(ok: boolean, message: string): GeminiKeysResult {
    return { ok, message, status: this.status() };
  }
}
