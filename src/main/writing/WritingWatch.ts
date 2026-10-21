import { createHash } from 'node:crypto';
import { rootLogger } from '@main/logging/logger';
import { checkDocument, checkParagraph } from './checks';
import type { DocumentText, Finding, FindingKind, RawFinding, TextSource } from './types';

const log = rootLogger.child('writing');

/**
 * Watching a draft as it is written. While it is on, it reads the document every second or so; when the writing pauses it checks only
 * the paragraphs that CHANGED since it started looking (what is already in an old document is left alone until the user asks for a full
 * check), and keeps the slips it finds until the words they are in change — fixed, deleted or rewritten — or the user ignores them.
 *
 * It never changes the document by itself: a fix is made only when asked for (`fix`). Nothing it reads is stored or logged.
 */

export interface FindingView extends Finding {
  /** Whether a click can fix it (a certain fix exists, and the program being watched lets Eya make it). */
  readonly canFix: boolean;
}

export interface WatchState {
  readonly watching: boolean;
  /** What is being watched ("Word", "Notepad"), or null when nothing readable is open. */
  readonly source: string | null;
  /** The document's name, for the card. */
  readonly title: string;
  readonly cloudAllowed: boolean;
  readonly findings: readonly FindingView[];
  /** How many more there are than are shown. */
  readonly more: number;
  /** When the last check finished (epoch ms; 0 = none yet). */
  readonly checkedAt: number;
  /** A short line when there is something to tell the user instead of findings. */
  readonly note: string;
}

export interface WatchDeps {
  /** Tried in order; the first that has text is the one watched. */
  readonly sources: readonly TextSource[];
  /** The optional deeper check by a model, called only while the user has allowed it, with one paragraph. */
  readonly cloud?: { check(paragraph: string): Promise<readonly RawFinding[]> };
  readonly onChange: (state: WatchState) => void;
  readonly now?: () => number;
  /** How long the writing has to stand still before it is checked. */
  readonly pauseMs?: number;
  readonly pollMs?: number;
  /** Runs `fn` after `ms`; returns how to cancel it. (A test drives time itself.) */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

const SHOWN = 6;
const CLOUD_GAP_MS = 6_000;
const CLOUD_MIN_WORDS = 8;
// Brackets and quotation marks are open while a sentence is being typed: they are only judged once the cursor has left the paragraph.
const WHILE_TYPING_SKIP: ReadonlySet<FindingKind> = new Set(['brackets', 'quotes']);
// Words a speller doubts that are really names or abbreviations: not worth a card.
const looksLikeAbbreviation = (w: string): boolean => /^[A-Z]{2,6}$/.test(w) || /\d|_/.test(w);

const PROGRAM_NAMES: Readonly<Record<string, string>> = { notepad: 'Notepad', wordpad: 'WordPad', 'notepad++': 'Notepad++', soffice: 'LibreOffice', 'soffice.bin': 'LibreOffice', write: 'WordPad' };
const friendlyProgram = (p: string): string => PROGRAM_NAMES[p.toLowerCase()] ?? p;

const shortHash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 12);

interface Held {
  readonly finding: Finding;
  /** The paragraph's words when found; the slip stays only while a paragraph still has exactly these words. */
  readonly text: string;
  readonly dismissId: string;
}

export class WritingWatch {
  private watching = false;
  private cloudAllowed = false;
  private held = new Map<string, Held>();
  private readonly dismissed = new Set<string>();
  private readonly seen = new Set<string>();
  private source: TextSource | null = null;
  private sourceKey = '';
  private title = '';
  private sourceName: string | null = null;
  private note = '';
  private signature = '';
  private changedAt = 0;
  private pending = false;
  private checkedAt = 0;
  private cancelTimer: (() => void) | null = null;
  private busy = false;
  private lastEmitted = '';
  private lastCloudAt = 0;
  private lastCloudText = '';
  private cloudBusy = false;
  private latest: DocumentText | null = null;

  constructor(private readonly deps: WatchDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // ------------------------------------------------------------------------------------------------------- on and off
  start(): void {
    if (this.watching) return;
    this.watching = true;
    this.note = 'Open your document in Word (or Notepad) and I will watch it as you write.';
    this.resetDocument();
    this.emit();
    this.loop();
  }

  stop(): void {
    if (!this.watching) return;
    this.watching = false;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.held.clear();
    this.resetDocument();
    this.note = '';
    for (const s of this.deps.sources) s.close?.();
    this.emit();
  }

  isWatching(): boolean {
    return this.watching;
  }

  setCloudAllowed(on: boolean): void {
    if (this.cloudAllowed === on) return;
    this.cloudAllowed = on;
    this.lastCloudText = '';
    this.emit();
    if (on && this.watching) this.pending = true;
  }

  private resetDocument(): void {
    this.source = null;
    this.sourceKey = '';
    this.title = '';
    this.sourceName = null;
    this.signature = '';
    this.seen.clear();
    this.pending = false;
    this.latest = null;
  }

  private loop(): void {
    if (!this.watching) return;
    const schedule = this.deps.schedule ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
    this.cancelTimer = schedule(() => {
      void this.tick().finally(() => this.loop());
    }, this.deps.pollMs ?? 1000);
  }

  // ------------------------------------------------------------------------------------------------------------ one look
  /** One look at the document. (Public so a test, or "check this", can ask for it.) */
  async tick(): Promise<void> {
    if (!this.watching || this.busy) return;
    this.busy = true;
    try {
      const doc = await this.read();
      if (!this.watching) return; // switched off while the look was in flight
      if (doc === null) {
        if (this.sourceKey !== '' || this.held.size > 0) {
          this.held.clear();
          this.resetDocument();
        }
        this.note = 'Open your document in Word (or Notepad) and I will watch it as you write.';
        this.emit();
        return;
      }
      this.latest = doc;
      const key = `${doc.app}|${doc.title}`;
      if (key !== this.sourceKey) {
        // A different document: what is in it now is the starting point; only what is written from here is checked.
        this.held.clear();
        this.seen.clear();
        this.sourceKey = key;
        this.signature = '';
        // Both ways (cursor in it, cursor elsewhere): moving the cursor into or out of an old paragraph is not writing in it.
        for (const p of doc.paragraphs) {
          if (p.trim() === '') continue;
          this.seen.add(this.seenKey(p, true));
          this.seen.add(this.seenKey(p, false));
        }
      }
      this.title = doc.title;
      this.note = '';
      const signature = `${doc.active}\u0002${doc.paragraphs.join('\u0001')}`;
      if (signature !== this.signature) {
        this.signature = signature;
        this.changedAt = this.now();
        this.pending = true;
      }
      this.revalidate(doc);
      if (this.pending && this.now() - this.changedAt >= (this.deps.pauseMs ?? 1800)) {
        this.pending = false;
        await this.analyze(doc, false);
      }
      this.forgetGone(doc);
      this.emit();
    } catch (err) {
      log.warn('a look at the document failed; trying again', { err: String(err) });
    } finally {
      this.busy = false;
    }
  }

  private async read(): Promise<DocumentText | null> {
    for (const source of this.deps.sources) {
      let doc: DocumentText | null = null;
      try {
        doc = await source.read();
      } catch {
        doc = null;
      }
      if (doc !== null) {
        this.source = source;
        this.sourceName = doc.program === undefined ? source.name : friendlyProgram(doc.program);
        return doc;
      }
    }
    this.source = null;
    this.sourceName = null;
    return null;
  }

  private seenKey(text: string, active: boolean): string {
    return `${active ? 'a' : 'n'}|${text}`;
  }

  /**
   * Forgets the paragraphs that are no longer in the document, so that words which come back (an Undo of a fix, say) are looked at again
   * instead of being taken for something already checked.
   */
  private forgetGone(doc: DocumentText): void {
    const present = new Set<string>();
    for (const p of doc.paragraphs) {
      present.add(this.seenKey(p, true));
      present.add(this.seenKey(p, false));
    }
    for (const key of [...this.seen]) if (!present.has(key)) this.seen.delete(key);
  }

  // ---------------------------------------------------------------------------------------------------------------- check
  /**
   * Checks the document. `full`: every paragraph (the user asked); otherwise only the paragraphs not seen before — and, for the one the
   * cursor is in, only the rules that make sense while a sentence is still being typed.
   */
  private async analyze(doc: DocumentText, full: boolean): Promise<void> {
    const found: Array<{ raw: RawFinding; paragraph: number }> = [];
    const touched = new Set<number>();
    doc.paragraphs.forEach((text, i) => {
      if (text.trim() === '') return;
      const active = doc.active === i + 1;
      const key = this.seenKey(text, active);
      if (!full && this.seen.has(key)) return;
      this.seen.add(key);
      touched.add(i + 1);
      for (const raw of checkParagraph(text)) {
        if (active && !full && WHILE_TYPING_SKIP.has(raw.kind)) continue;
        found.push({ raw, paragraph: i + 1 });
      }
    });
    // Across the draft: only what concerns the paragraphs just written (a typo in an untouched old paragraph waits for "check this").
    for (const d of checkDocument(doc.paragraphs)) {
      if (full || touched.has(d.paragraph) || d.paragraph === doc.active) found.push({ raw: d, paragraph: d.paragraph });
    }
    // The program's own spell checker, where there is one (Word does it here on this PC).
    const counts = new Map<string, number>();
    for (const p of doc.paragraphs) for (const w of p.match(/\b[A-Za-z][A-Za-z']{2,}\b/g) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1);
    const near = full ? doc.paragraphs.map((_, i) => i + 1) : [...new Set([...touched, ...(doc.active > 0 ? [doc.active] : [])])];
    let misspelled = doc.misspelled;
    if (misspelled === undefined && near.length > 0 && this.source?.spell !== undefined) {
      try {
        misspelled = await this.source.spell(near.slice(0, 12).map((n) => ({ paragraph: n, text: doc.paragraphs[n - 1] ?? '' })));
      } catch {
        misspelled = undefined; // no spell checker answered: the other checks still stand
      }
    }
    for (const s of misspelled ?? []) {
      if (!full && !touched.has(s.paragraph) && s.paragraph !== doc.active) continue;
      if (looksLikeAbbreviation(s.word)) continue;
      // Word reports "the the" as a spelling error on the second word; Eya already says that, in plainer words.
      const sentence = doc.paragraphs[s.paragraph - 1] ?? '';
      const doubled = new RegExp(`\\b(${s.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s+\\1\\b`, 'i');
      if (doubled.test(sentence)) continue;
      // A name written the same way several times is the user's spelling, not a slip.
      if (/^[A-Z]/.test(s.word) && (counts.get(s.word) ?? 0) >= 2) continue;
      const best = s.suggestions[0];
      const options = s.suggestions.slice(0, 3).map((x) => `"${x}"`);
      found.push({
        paragraph: s.paragraph,
        raw: {
          kind: 'spelling',
          message: options.length > 0 ? `"${s.word}" may be misspelled — did you mean ${options.join(' or ')}?` : `"${s.word}" may be misspelled`,
          excerpt: s.word,
          ...(best !== undefined ? { replace: { from: s.word, to: best } } : {}),
        },
      });
    }
    if (process.env['EYA_WRITING_DEBUG'] === '1') {
      // Paragraph numbers and counts only — never the words.
      log.info('writing check', { full, paragraphs: doc.paragraphs.length, active: doc.active, touched: [...touched], asked: near, spelling: (misspelled ?? []).map((m) => m.paragraph), found: found.map((f) => `${f.raw.kind}@${f.paragraph}`) });
    }
    this.keep(doc, found);
    this.checkedAt = this.now();
    if (this.cloudAllowed) void this.cloudCheck(doc);
  }

  /** Puts new findings into the held set, unless the user ignored the same slip. */
  private keep(doc: DocumentText, found: ReadonlyArray<{ raw: RawFinding; paragraph: number }>): void {
    for (const { raw, paragraph } of found) {
      const text = doc.paragraphs[paragraph - 1] ?? '';
      const dismissId = raw.kind === 'spelling' ? `spelling:${raw.excerpt.toLowerCase()}` : `${raw.kind}:${raw.replace?.from ?? raw.excerpt}`;
      if (this.dismissed.has(dismissId)) continue;
      const id = shortHash(`${dismissId}|${text}`);
      if (this.held.has(id)) continue;
      this.held.set(id, { finding: { ...raw, id, paragraph }, text, dismissId });
    }
  }

  /** Drops what no longer applies (the words changed, or went), and moves the rest to where its paragraph is now. */
  private revalidate(doc: DocumentText): void {
    for (const [id, held] of [...this.held]) {
      const at = doc.paragraphs.indexOf(held.text);
      if (at === -1) {
        this.held.delete(id);
        continue;
      }
      // A paragraph can have been inserted above: the slip is wherever its words are now (the nearest copy when there are several).
      let best = at;
      doc.paragraphs.forEach((p, i) => {
        if (p === held.text && Math.abs(i + 1 - held.finding.paragraph) < Math.abs(best + 1 - held.finding.paragraph)) best = i;
      });
      if (best + 1 !== held.finding.paragraph) this.held.set(id, { ...held, finding: { ...held.finding, paragraph: best + 1 } });
    }
  }

  // ------------------------------------------------------------------------------------------------------- the deeper check
  private async cloudCheck(doc: DocumentText): Promise<void> {
    const cloud = this.deps.cloud;
    if (cloud === undefined || !this.cloudAllowed || this.cloudBusy) return;
    const at = doc.active > 0 ? doc.active : doc.paragraphs.length;
    const text = doc.paragraphs[at - 1] ?? '';
    if (text.trim().split(/\s+/).length < CLOUD_MIN_WORDS || text === this.lastCloudText) return;
    if (this.now() - this.lastCloudAt < CLOUD_GAP_MS) {
      this.pending = true; // look again once the gap has passed
      return;
    }
    this.cloudBusy = true;
    this.lastCloudAt = this.now();
    this.lastCloudText = text;
    try {
      const raws = await cloud.check(text);
      if (!this.watching || !this.cloudAllowed) return;
      const current = this.latest ?? doc;
      const paragraph = current.paragraphs.indexOf(text) + 1;
      if (paragraph > 0) this.keep(current, raws.map((raw) => ({ raw: { ...raw, kind: 'ai' as const }, paragraph })));
      this.emit();
    } catch (err) {
      log.warn('the cloud check failed; carrying on without it', { err: String(err) });
    } finally {
      this.cloudBusy = false;
    }
  }

  // ------------------------------------------------------------------------------------------------------------- the user
  /** A full check of the document as it is now, because the user asked (works whether or not watching is on). Returns how many slips. */
  async checkAll(): Promise<number> {
    const doc = await this.read();
    if (doc === null) {
      this.note = 'I can\'t see a document to check. Open it in Word (or Notepad) and ask again.';
      this.emit();
      return 0;
    }
    this.latest = doc;
    this.sourceKey = `${doc.app}|${doc.title}`;
    this.title = doc.title;
    this.note = '';
    this.held.clear();
    await this.analyze(doc, true);
    this.emit();
    return this.held.size;
  }

  dismiss(id: string): boolean {
    const held = this.held.get(id);
    if (held === undefined) return false;
    this.dismissed.add(held.dismissId);
    this.held.delete(id);
    this.emit();
    return true;
  }

  /** Makes the fix the user clicked. False when it cannot be made (no certain fix, or the words have changed since). */
  async fix(id: string): Promise<boolean> {
    const held = this.held.get(id);
    const replace = held?.finding.replace;
    if (held === undefined || replace === undefined || this.source?.replace === undefined) return false;
    const done = await this.source.replace(held.finding.paragraph, replace.from, replace.to, held.text);
    if (!done) return false;
    this.held.delete(id);
    // If the user undoes the fix, these words are back and must be looked at again.
    this.seen.delete(this.seenKey(held.text, true));
    this.seen.delete(this.seenKey(held.text, false));
    this.pending = true;
    this.changedAt = this.now();
    this.emit();
    return true;
  }

  /** What is on the card now. */
  state(): WatchState {
    const ordered = [...this.held.values()]
      .map((h) => h.finding)
      .sort((a, b) => Math.abs(a.paragraph - (this.latest?.active ?? 0)) - Math.abs(b.paragraph - (this.latest?.active ?? 0)) || a.paragraph - b.paragraph);
    return {
      watching: this.watching,
      source: this.sourceName,
      title: this.title,
      cloudAllowed: this.cloudAllowed,
      findings: ordered.slice(0, SHOWN).map((f) => ({ ...f, canFix: f.replace !== undefined && this.source?.replace !== undefined })),
      more: Math.max(0, ordered.length - SHOWN),
      checkedAt: this.checkedAt,
      note: this.note,
    };
  }

  private emit(): void {
    const state = this.state();
    const signature = JSON.stringify([state.watching, state.source, state.title, state.cloudAllowed, state.findings.map((f) => [f.id, f.paragraph]), state.more, state.note]);
    if (signature === this.lastEmitted) return;
    this.lastEmitted = signature;
    this.deps.onChange(state);
  }
}
