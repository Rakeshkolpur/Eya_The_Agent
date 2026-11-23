import type { PageSnapshot } from '@main/browser/pageSnapshot';
import { parseYesNo } from '@main/local/chatIntents';
import { allowance } from './pacing';
import type { PublishAction } from './pacing';
import type { SocialStore } from './SocialStore';
import { checkSocialText, hasErrors, preview, sayProblems, textHash, tidyPostText } from './socialRules';
import type { SocialKind } from './socialRules';
import { siteOfUrl } from './socialSites';
import type { SocialSite, SocialSiteId } from './socialSites';

/**
 * The last step before something goes out in the person's name on a public site: pressing Post, Comment or Reply. At that click — the one place nothing can get around — Eya checks, in code:
 *   1. the text really is fit to publish (no client matter, no promise of a result, not too long);
 *   2. the plugin for the site has been given the permission by the PERSON, on the Plugins page;
 *   3. the limits are kept (a few a day, not too fast, not at night, never the same text twice);
 *   4. the person said yes — to THIS text, in their own words (a model's "confirm" alone is never enough), or wrote the text themself in this very request.
 * When one of 1–3 fails, no yes can change it (the person is told what is wrong). Only after the click went ahead is it written to the ledger.
 */
export interface PublishDecision {
  /** Why this click is held (null: it may go ahead). */
  readonly reason: string | null;
  /** What to ask the person, word for word, when the answer is a question. */
  readonly question?: string;
  /** Not allowed at all: a sentence for the person; no yes changes it. */
  readonly blocked?: string;
}

export interface PublishTarget {
  readonly name: string;
  readonly role?: string;
}

export interface PublishGate {
  /** A click on a page of a public site: null when it is not the control that publishes (or nothing was written to publish), so the ordinary rules apply. */
  forClick(page: PageSnapshot | null, target: PublishTarget, confirmed: boolean): PublishDecision | null;
  /** Pressing Enter in a box of such a page. */
  forSubmit(page: PageSnapshot | null, fieldLabel: string, confirmed: boolean): PublishDecision | null;
  /** Something was typed in a field of such a page: it is what the next Post / Comment / Reply would publish. */
  typed(page: PageSnapshot | null, fieldLabel: string, value: string): void;
  /** The click that publishes went ahead: it is written to the ledger (a fingerprint, never the text) and its draft is done. */
  published(page: PageSnapshot | null, target: PublishTarget): void;
}

export interface PublishGateDeps {
  readonly store: SocialStore;
  /** Whether the plugin of this site may do something needing this permission: null when it may, otherwise why not. */
  readonly permits: (site: SocialSiteId, permission: string) => string | null;
  readonly now?: () => number;
  /** The words the person said (or typed) in the request being served. */
  readonly userWords?: () => string;
}

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
const TYPED_FRESH_MS = 30 * 60_000;
/** The fingerprint of a post whose text Eya did not write (nothing to check it against). */
const UNKNOWN_TEXT = 'unknown-text';
const ASKED_FRESH_MS = 20 * 60_000;

// What each control is called on LinkedIn. (A button that only OPENS a box says "Comment" too, but with nothing typed it is not a publish: see forClick.)
const CONTROL: ReadonlyArray<readonly [RegExp, SocialKind]> = [
  [/^(post|post now|publish|post it)$/, 'post'],
  [/^(comment|post comment|send comment)$/, 'comment'],
  [/^(reply|post reply|send reply)$/, 'reply'],
];

const PERMISSION: Readonly<Record<SocialKind, string>> = { post: 'posts.publish', comment: 'comments.publish', reply: 'comments.publish' };

function controlKind(name: string): SocialKind | null {
  const n = normalize(name);
  for (const [pattern, kind] of CONTROL) if (pattern.test(n)) return kind;
  return null;
}

/** The kind of box a field is, by its label ("Add a comment…", "Text editor for creating content"). */
function boxKind(label: string): SocialKind | null {
  const n = normalize(label);
  if (/\breply\b/.test(n)) return 'reply';
  if (/\bcomment\b/.test(n)) return 'comment';
  if (/\b(post|editor|share|talk about|what do you want)\b/.test(n)) return 'post';
  return null;
}

export function createPublishGate(deps: PublishGateDeps): PublishGate {
  const now = deps.now ?? Date.now;
  const userWords = deps.userWords ?? ((): string => '');
  let typedBox: { readonly site: SocialSiteId; readonly kind: SocialKind | null; readonly text: string; readonly at: number } | null = null;
  let asked: { readonly site: SocialSiteId; readonly hash: string; readonly at: number } | null = null;

  const siteOf = (page: PageSnapshot | null): SocialSite | null => (page === null ? null : siteOfUrl(page.url));

  function decide(site: SocialSite, kind: SocialKind): PublishDecision | null {
    const box = typedBox;
    const fresh = box !== null && box.site === site.id && now() - box.at <= TYPED_FRESH_MS && tidyPostText(box.text) !== '';
    // Nothing was typed by Eya (the person typed in the box themselves, or the text was forgotten): a Comment / Reply button is then only the button that OPENS a box, but the Post button would
    // put out text nobody has checked — so it is held to the permission, the limits and the person's own yes just the same, and the question says Eya did not write it.
    if (!fresh && kind !== 'post') return null;
    const text = fresh ? tidyPostText((box as NonNullable<typeof box>).text) : '';
    const hash = fresh ? textHash(text) : UNKNOWN_TEXT;
    const problems = fresh ? checkSocialText({ kind, text }) : [];
    if (hasErrors(problems)) return { reason: 'this text must not be published', blocked: `Nothing was published. ${sayProblems(problems.filter((p) => p.severity === 'error'))} Change the text, then type it again.` };
    const action: PublishAction = kind;
    const why = deps.permits(site.id, PERMISSION[kind]);
    if (why !== null) return { reason: 'not allowed', blocked: `Nothing was published. ${why}` };
    const room = allowance(deps.store.ledger(), site.id, action, hash, now(), deps.store.pacing());
    if (!room.ok) return { reason: 'a limit', blocked: `Nothing was published. ${room.why}${room.retryAt !== undefined ? ` Try again after ${new Date(room.retryAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.` : ''}` };

    const words = userWords();
    // (the person wrote this very text in their own request: that is their yes to it)
    const theirOwn = fresh && normalize(words).length >= 12 && normalize(words).includes(normalize(text));
    const yes = parseYesNo(words) === 'yes' || /\b(?:post it|publish it|post that|comment it|reply with (?:it|that)|go ahead and (?:post|comment|reply))\b/i.test(words);
    const asking = asked;
    const covered = theirOwn || (asking !== null && asking.site === site.id && asking.hash === hash && now() - asking.at < ASKED_FRESH_MS && yes);
    if (covered) return { reason: null };
    const what = kind === 'post' ? 'post this on' : kind === 'comment' ? 'post this comment on' : 'post this reply on';
    asked = { site: site.id, hash, at: now() };
    if (!fresh) {
      return {
        reason: 'publishing in the person\'s name',
        question: `Post what is in ${site.name}'s post box now, as you? I did not write it, so I cannot show it here: it will go out exactly as it is. Say yes to publish it.`,
      };
    }
    return {
      reason: 'publishing in the person\'s name',
      question: `${what[0]?.toUpperCase()}${what.slice(1)} ${site.name} as you?\n"${preview(text, 600)}"\nSay yes to publish it, or tell me what to change.`,
    };
  }

  return {
    forClick(page, target) {
      const site = siteOf(page);
      if (site === null || site.id !== 'linkedin') return null;
      const kind = controlKind(target.name);
      if (kind === null || target.role === 'link') return null;
      return decide(site, kind);
    },
    forSubmit(page, fieldLabel) {
      const site = siteOf(page);
      if (site === null || site.id !== 'linkedin') return null;
      const kind = boxKind(fieldLabel);
      return kind === null ? null : decide(site, kind);
    },
    typed(page, fieldLabel, value) {
      const site = siteOf(page);
      if (site === null || value.trim() === '') return;
      typedBox = { site: site.id, kind: boxKind(fieldLabel), text: value, at: now() };
    },
    published(page, target) {
      const site = siteOf(page);
      const box = typedBox;
      // (Enter pressed in a box names no button: the kind of box says what went out)
      const kind = controlKind(target.name) ?? box?.kind ?? null;
      if (site === null || kind === null) return;
      const known = box !== null && box.site === site.id && now() - box.at <= TYPED_FRESH_MS && tidyPostText(box.text) !== '';
      // (a Post of text Eya did not write is counted too: against the daily limit, under a fingerprint of the moment)
      if (!known && kind !== 'post') return;
      deps.store.published(site.id, kind, known ? textHash(tidyPostText((box as NonNullable<typeof box>).text)) : `${UNKNOWN_TEXT}:${now()}`);
      typedBox = null;
      asked = null;
    },
  };
}
