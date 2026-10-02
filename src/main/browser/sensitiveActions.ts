/**
 * Which clicks on a real web page need the user's explicit yes first.
 *
 * Eya is working inside the user's own signed-in browser, where a click can
 * spend money, send a message or delete something for real. These rules look
 * at what the control SAYS (and, for vague words like "Confirm", at what kind
 * of page it is on) — never at what Eya was asked to do, so a request phrased
 * innocently can't talk its way past the check.
 *
 * Deliberately narrow: asking before every "Submit" or "Send" link would make
 * Eya useless for ordinary browsing, so each rule is anchored to wording that
 * actually means "this is the final, hard-to-undo step".
 */

export interface PageContext {
  readonly url: string;
  readonly title: string;
  readonly headings: readonly string[];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

const PURCHASE =
  /\b(buy now|place (?:your |my |the )?order|pay now|pay (?:securely|[$₹€£]\s?\d+)|complete (?:your |my |the )?(?:purchase|order|payment)|confirm (?:and pay|order|purchase|payment)|submit (?:your |my |the )?order|proceed to pay(?:ment)?|make (?:a )?payment|donate now)\b/;

const SEND = /^(send|send (?:message|email|mail|now|reply)|reply all|post|post now|publish|tweet|share now|send it)$/;

const DELETE =
  /^(delete|delete forever|delete permanently|delete all|permanently delete|erase|empty trash|empty bin|empty recycle bin|empty spam)$|\b(delete|close|deactivate|terminate|remove) (?:my |your |the )?(?:account|profile)\b|\bpermanently delete\b/;

const SETTINGS =
  /\b(change|update|reset|save) (?:my |your |the )?(?:password|email address|e-mail|phone number|payment method|security (?:settings|questions))\b|\b(?:disable|turn off|unlink) (?:2fa|two[- ]factor|two[- ]step|authenticator)\b/;

// Vague finishing words: only a problem on a page that is plainly about money, an application or a booking.
const VAGUE_FINISH = /^(submit|confirm|finish|complete|place|proceed|pay|book|register|apply|finalize|finalise|continue to pay)(?: \w+){0,2}$/;
const FINISHING_PAGE = /checkout|payment|\bpay\b|billing|order summary|\border\b|booking|reservation|application|registration|declaration|e-?filing|\bcart\b/;

/** A plain-English description of why this click needs a yes, or null when it can just go ahead. */
export function sensitiveActionReason(name: string, role?: string, page?: PageContext): string | null {
  const n = normalize(name);
  if (n === '' || n.length > 90) return null; // a long link is a headline, not a button
  if (PURCHASE.test(n)) return 'completing a purchase or payment';
  if (DELETE.test(n)) return 'deleting something that may not be recoverable';
  if (SETTINGS.test(n)) return 'changing important account settings';
  if (role !== 'link' && SEND.test(n)) return 'sending or publishing something';
  if (page !== undefined && VAGUE_FINISH.test(n) && FINISHING_PAGE.test(normalize(`${page.url} ${page.title} ${page.headings.join(' ')}`))) {
    return 'submitting something that may not be undoable';
  }
  return null;
}

/** Pressing Enter after typing: harmless in a search box, a real "send" in a message or comment box. */
export function sensitiveSubmitReason(fieldLabel: string): string | null {
  return /\b(message|chat|comment|reply|post|tweet|status|caption)\b/.test(normalize(fieldLabel))
    ? 'sending or publishing what was just typed'
    : null;
}
