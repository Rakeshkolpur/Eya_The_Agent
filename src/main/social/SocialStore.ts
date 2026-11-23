import { randomUUID } from 'node:crypto';
import { realIo } from '@main/privacy/communicationAccessStore';
import type { StoreIo } from '@main/privacy/communicationAccessStore';
import { DEFAULT_PACING } from './pacing';
import type { LedgerEntry, PacingSettings, PublishAction } from './pacing';
import { textHash } from './socialRules';
import type { SocialKind, SocialProblem } from './socialRules';
import type { SocialSiteId } from './socialSites';

export interface SocialDraft {
  readonly id: string;
  readonly site: SocialSiteId;
  readonly kind: SocialKind;
  readonly text: string;
  /** A post's first line, said apart when the person wants one ("title"); empty when there is none. */
  readonly title: string;
  readonly hashtags: readonly string[];
  /** The picture to attach (a file on this PC), or empty. */
  readonly imagePath: string;
  readonly altText: string;
  /** For a comment or a reply: where, and who it is to. */
  readonly target: { readonly url: string; readonly who: string; readonly excerpt: string };
  readonly status: 'draft' | 'published' | 'skipped';
  readonly problems: readonly SocialProblem[];
  readonly hash: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly publishedAt: number | null;
}

export interface SocialProfile {
  readonly name: string;
  readonly headline: string;
  /** The true things about the person that a post may say about them (their practice, years, courts, what they offer). Nothing else about them is ever stated. */
  readonly facts: readonly string[];
  /** How they like to sound. */
  readonly tone: string;
}

export const EMPTY_PROFILE: SocialProfile = { name: '', headline: '', facts: [], tone: '' };

export const MAX_DRAFTS = 100;
export const MAX_LEDGER = 2000;
const LEDGER_KEEP_MS = 400 * 24 * 60 * 60_000;

interface File {
  readonly version: 1;
  readonly drafts: readonly SocialDraft[];
  readonly ledger: readonly LedgerEntry[];
  readonly profile: SocialProfile;
  readonly pacing?: Partial<PacingSettings>;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const SITES: readonly string[] = ['linkedin', 'fiverr'];
const KINDS: readonly string[] = ['post', 'comment', 'reply'];
const ACTIONS: readonly string[] = ['post', 'comment', 'reply', 'apply', 'proposal'];

function readDraft(raw: unknown): SocialDraft | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || !SITES.includes(String(o['site'])) || !KINDS.includes(String(o['kind'])) || typeof o['text'] !== 'string') return null;
  const t = (typeof o['target'] === 'object' && o['target'] !== null ? o['target'] : {}) as Record<string, unknown>;
  return {
    id: o['id'].slice(0, 40),
    site: o['site'] as SocialSiteId,
    kind: o['kind'] as SocialKind,
    text: o['text'].slice(0, 4000),
    title: str(o['title'], 200),
    hashtags: Array.isArray(o['hashtags']) ? o['hashtags'].filter((h): h is string => typeof h === 'string').slice(0, 40).map((h) => h.slice(0, 60)) : [],
    imagePath: str(o['imagePath'], 500),
    altText: str(o['altText'], 300),
    target: { url: str(t['url'], 500), who: str(t['who'], 120), excerpt: str(t['excerpt'], 400) },
    status: o['status'] === 'published' || o['status'] === 'skipped' ? o['status'] : 'draft',
    problems: Array.isArray(o['problems'])
      ? o['problems'].flatMap((p) => {
          const q = p as Record<string, unknown>;
          return typeof q['code'] === 'string' && typeof q['text'] === 'string' ? [{ code: q['code'].slice(0, 40), severity: q['severity'] === 'error' ? ('error' as const) : ('warn' as const), text: q['text'].slice(0, 300) }] : [];
        })
      : [],
    hash: str(o['hash'], 32),
    createdAt: typeof o['createdAt'] === 'number' ? o['createdAt'] : 0,
    updatedAt: typeof o['updatedAt'] === 'number' ? o['updatedAt'] : 0,
    publishedAt: typeof o['publishedAt'] === 'number' ? o['publishedAt'] : null,
  };
}

function readPacing(raw: unknown): Partial<PacingSettings> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const out: { caps?: Record<PublishAction, number>; minGapMinutes?: Record<PublishAction, number>; quiet?: { from: number; to: number }; duplicateDays?: number } = {};
  const num = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback);
  if (typeof o['caps'] === 'object' && o['caps'] !== null) {
    const c = o['caps'] as Record<string, unknown>;
    out.caps = { ...DEFAULT_PACING.caps };
    for (const a of ACTIONS) out.caps[a as PublishAction] = num(c[a], 0, 100, DEFAULT_PACING.caps[a as PublishAction]);
  }
  if (typeof o['minGapMinutes'] === 'object' && o['minGapMinutes'] !== null) {
    const c = o['minGapMinutes'] as Record<string, unknown>;
    out.minGapMinutes = { ...DEFAULT_PACING.minGapMinutes };
    for (const a of ACTIONS) out.minGapMinutes[a as PublishAction] = num(c[a], 0, 1440, DEFAULT_PACING.minGapMinutes[a as PublishAction]);
  }
  if (typeof o['quiet'] === 'object' && o['quiet'] !== null) {
    const q = o['quiet'] as Record<string, unknown>;
    out.quiet = { from: num(q['from'], 0, 23, DEFAULT_PACING.quiet.from), to: num(q['to'], 0, 23, DEFAULT_PACING.quiet.to) };
  }
  if (o['duplicateDays'] !== undefined) out.duplicateDays = num(o['duplicateDays'], 1, 365, DEFAULT_PACING.duplicateDays);
  return out;
}

/**
 * Eya's drafts for the person's public writing, what has gone out (a fingerprint of each text, never the text), what they have told Eya about themselves, and the limits. One small file in
 * Eya's data folder. The limits can be changed only by editing this file by hand: no tool, page or model can raise them.
 */
export class SocialStore {
  private data: File = { version: 1, drafts: [], ledger: [], profile: EMPTY_PROFILE };

  constructor(
    private readonly path: string,
    private readonly io: StoreIo = realIo,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {
    try {
      const text = io.read(path);
      if (text !== null) {
        const raw = JSON.parse(text) as Record<string, unknown>;
        const p = (typeof raw['profile'] === 'object' && raw['profile'] !== null ? raw['profile'] : {}) as Record<string, unknown>;
        this.data = {
          version: 1,
          drafts: (Array.isArray(raw['drafts']) ? raw['drafts'] : []).flatMap((d) => readDraft(d) ?? []).slice(-MAX_DRAFTS),
          ledger: (Array.isArray(raw['ledger']) ? raw['ledger'] : []).flatMap((e) => {
            const q = e as Record<string, unknown>;
            return typeof q['at'] === 'number' && SITES.includes(String(q['site'])) && ACTIONS.includes(String(q['action'])) && typeof q['hash'] === 'string'
              ? [{ at: q['at'], site: q['site'] as SocialSiteId, action: q['action'] as PublishAction, hash: q['hash'].slice(0, 32) }]
              : [];
          }),
          profile: {
            name: str(p['name'], 80),
            headline: str(p['headline'], 200),
            facts: Array.isArray(p['facts']) ? p['facts'].filter((f): f is string => typeof f === 'string').slice(0, 40).map((f) => f.slice(0, 300)) : [],
            tone: str(p['tone'], 200),
          },
          ...(readPacing(raw['pacing']) !== undefined ? { pacing: readPacing(raw['pacing']) as Partial<PacingSettings> } : {}),
        };
      }
    } catch {
      // a file that cannot be read starts empty: nothing is lost that was not already unreadable
    }
  }

  private save(next: Partial<File>): void {
    this.data = { ...this.data, ...next };
    try {
      this.io.write(this.path, JSON.stringify(this.data));
    } catch {
      // the next change writes it again
    }
  }

  // ------------------------------------------------------------------ drafts
  drafts(filter?: { readonly status?: SocialDraft['status']; readonly site?: SocialSiteId }): readonly SocialDraft[] {
    return this.data.drafts.filter((d) => (filter?.status === undefined || d.status === filter.status) && (filter?.site === undefined || d.site === filter.site));
  }

  draft(id: string): SocialDraft | null {
    return this.data.drafts.find((d) => d.id === id) ?? null;
  }

  add(input: Omit<SocialDraft, 'id' | 'hash' | 'createdAt' | 'updatedAt' | 'publishedAt' | 'status'>): SocialDraft {
    const at = this.now();
    const draft: SocialDraft = { ...input, id: `s_${this.newId().replace(/-/g, '').slice(0, 8)}`, hash: textHash(input.text), status: 'draft', createdAt: at, updatedAt: at, publishedAt: null };
    this.save({ drafts: [...this.data.drafts, draft].slice(-MAX_DRAFTS) });
    return draft;
  }

  update(id: string, patch: Partial<Pick<SocialDraft, 'text' | 'title' | 'hashtags' | 'imagePath' | 'altText' | 'target' | 'problems' | 'status'>>): SocialDraft | null {
    const old = this.draft(id);
    if (old === null) return null;
    const next: SocialDraft = { ...old, ...patch, hash: patch.text !== undefined ? textHash(patch.text) : old.hash, updatedAt: this.now() };
    this.save({ drafts: this.data.drafts.map((d) => (d.id === id ? next : d)) });
    return next;
  }

  /** The text of this fingerprint went out: the draft (if any) is done, and the ledger remembers it. */
  published(site: SocialSiteId, action: PublishAction, hash: string): void {
    const at = this.now();
    const kind = action as string;
    const drafts = this.data.drafts.map((d) => (d.status === 'draft' && d.site === site && d.hash === hash && d.kind === kind ? { ...d, status: 'published' as const, publishedAt: at, updatedAt: at } : d));
    const ledger = [...this.data.ledger, { at, site, action, hash }].filter((e) => at - e.at < LEDGER_KEEP_MS).slice(-MAX_LEDGER);
    this.save({ drafts, ledger });
  }

  // ------------------------------------------------------------------ the ledger and the limits
  ledger(): readonly LedgerEntry[] {
    return this.data.ledger;
  }

  pacing(): PacingSettings {
    return { ...DEFAULT_PACING, ...(this.data.pacing ?? {}) };
  }

  // ------------------------------------------------------------------ the person
  profile(): SocialProfile {
    return this.data.profile;
  }

  setProfile(patch: Partial<SocialProfile>): SocialProfile {
    const p = this.data.profile;
    const next: SocialProfile = {
      name: patch.name !== undefined ? str(patch.name, 80) : p.name,
      headline: patch.headline !== undefined ? str(patch.headline, 200) : p.headline,
      facts: patch.facts !== undefined ? patch.facts.map((f) => str(f, 300).trim()).filter((f) => f !== '').slice(0, 40) : p.facts,
      tone: patch.tone !== undefined ? str(patch.tone, 200) : p.tone,
    };
    this.save({ profile: next });
    return next;
  }
}
