import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Profile, SectionInfo } from './referenceAnalyzer';

/** A document Eya has learned from: how it is laid out, formatted and worded, and which page each part is on. Kept on this PC only. */
export interface StoredReference {
  readonly id: string;
  readonly name: string;
  readonly learnedAt: string;
  readonly source: {
    readonly fileName: string;
    readonly pages: number;
    readonly words: number;
    readonly paragraphs: number;
    /** Opened from a file (true) or learned from the document that was open in Word (false). */
    readonly fromFile: boolean;
  };
  readonly pageSetup?: {
    readonly paper: string;
    readonly orientation: string;
    readonly marginTopCm: number;
    readonly marginBottomCm: number;
    readonly marginLeftCm: number;
    readonly marginRightCm: number;
  };
  readonly header?: string;
  readonly footer?: string;
  readonly pageNumbers: boolean;
  readonly tablesOfContents: number;
  readonly tables: number;
  readonly profile: Profile;
  readonly sections: readonly SectionInfo[];
}

export interface ReferenceSummary {
  readonly id: string;
  readonly name: string;
  readonly learnedAt: string;
  readonly pages: number;
  readonly sections: number;
  readonly fileName: string;
}

/** Each reference is one file in a folder of its own (userData/references). Reading one never needs Word. */
const slug = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'reference';

const MAX_TOTAL_TEXT = 400_000;

export class ReferenceStore {
  constructor(private readonly dir: string) {}

  private fileFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private readAll(): StoredReference[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: StoredReference[] = [];
    for (const n of names) {
      try {
        const parsed = JSON.parse(readFileSync(join(this.dir, n), 'utf8')) as StoredReference;
        if (typeof parsed.id === 'string' && typeof parsed.name === 'string' && Array.isArray(parsed.sections)) out.push(parsed);
      } catch {
        // a damaged file is skipped, not fatal
      }
    }
    return out.sort((a, b) => b.learnedAt.localeCompare(a.learnedAt));
  }

  list(): ReferenceSummary[] {
    return this.readAll().map((r) => ({ id: r.id, name: r.name, learnedAt: r.learnedAt, pages: r.source.pages, sections: r.sections.length, fileName: r.source.fileName }));
  }

  /** By name: exact (any case), else the one whose name contains the words — and only when that is unambiguous. */
  find(query: string): StoredReference | null {
    const all = this.readAll();
    const q = query.trim().toLowerCase();
    if (q === '') return all.length === 1 ? (all[0] as StoredReference) : null;
    const exact = all.find((r) => r.name.toLowerCase() === q || r.id === slug(q));
    if (exact !== undefined) return exact;
    const partial = all.filter((r) => r.name.toLowerCase().includes(q) || q.includes(r.name.toLowerCase()));
    return partial.length === 1 ? (partial[0] as StoredReference) : null;
  }

  /** Saves (replacing one of the same name: learning it again updates it). Text is cut when the whole would be unreasonably large. */
  save(reference: Omit<StoredReference, 'id'>): StoredReference {
    const id = slug(reference.name);
    const total = reference.sections.reduce((n, s) => n + s.text.length, 0);
    const sections =
      total <= MAX_TOTAL_TEXT
        ? reference.sections
        : reference.sections.map((s) => {
            const keep = Math.max(500, Math.floor((s.text.length / total) * MAX_TOTAL_TEXT));
            return s.text.length > keep ? { ...s, text: `${s.text.slice(0, keep)}\n[…cut]` } : s;
          });
    const stored: StoredReference = { ...reference, id, sections };
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.fileFor(id), JSON.stringify(stored), 'utf8');
    return stored;
  }

  forget(query: string): string | null {
    const r = this.find(query);
    if (r === null) return null;
    rmSync(this.fileFor(r.id), { force: true });
    return r.name;
  }
}
