import { checkoutFacts } from '@main/browser/checkoutFacts';
import type { PageSnapshot } from '@main/browser/pageSnapshot';
import type { ToolArgs, ToolResult } from '@main/tools/types';
import { controls, pageOf } from './pageReading';
import type { Page } from './pageReading';

/**
 * The checkout after "Buy now", walked by the application with no AI, and stopped where the person has to say something:
 *  - the sign-in (theirs), an item that cannot be delivered to the address, which of several saved addresses to use (the person's pick), and HOW TO PAY (once: UPI, cash on
 *    delivery, card …) — those are the only questions; "shall I proceed?" is never asked on the way;
 *  - then, after the method, ONE confirmation with the item, the total, the address and the method; only a clear yes presses the button that pays or places the order.
 * The steps in between that cost nothing (the delivery address that is already chosen, "Deliver Here", the order summary's "Continue") are pressed. Card numbers, PINs and
 * passwords are never typed: for a card the person types on the page; UPI is approved in their own UPI app.
 *
 * The person's answers ("UPI", "the second one", "yes") arrive as their next message: the engine keeps the PendingCheckout and gives it to continueCheckout (within 20 minutes).
 */
export type PendingStage = 'address' | 'payment' | 'confirm';

export interface PendingCheckout {
  readonly site: string;
  readonly product: string;
  readonly stage: PendingStage;
  /** The addresses (stage address) or the payment methods (stage payment) that were offered. */
  readonly options: readonly string[];
  /** What the final question says is being bought, for how much, and where to. */
  readonly summary: string;
  readonly method?: string;
  readonly at: number;
}

export interface CheckoutDeps {
  invoke(name: string, args: ToolArgs): Promise<ToolResult>;
  say(message: string): void;
  stopped?(): boolean;
  sleep?(ms: number): Promise<void>;
}

export interface CheckoutResult {
  /** Said to the person as it is. Null when the model should carry on from where the page is. */
  readonly answer: string | null;
  readonly pending: PendingCheckout | null;
  readonly needsUser: boolean;
  readonly steps: readonly string[];
  readonly tools: readonly string[];
  readonly note: string;
}

export const PENDING_MS = 20 * 60_000;

// ------------------------------------------------------------------------------------------------------------------ reading the checkout

export type CheckoutStage = 'login' | 'unavailable' | 'address' | 'summary' | 'payment' | 'unknown';

const UNAVAILABLE = /\bout of stock\b|\bsold out\b|\bcurrently unavailable\b|not deliverable|(?:cannot|can't|can not|won't) be delivered|does not deliver|unserviceable|delivery (?:is )?not available|not available (?:for|at|in|to) (?:your |this )?(?:pin ?code|address|location|area)/i;

const METHODS: ReadonlyArray<readonly [string, RegExp]> = [
  ['UPI', /\bupi\b|google ?pay|gpay|phone ?pe|paytm/i],
  ['Cash on Delivery', /cash on delivery|pay on delivery|\bcod\b/i],
  ['Card', /credit|debit|atm card|\bcards?\b/i],
  ['Net Banking', /net ?banking/i],
  ['EMI', /\bemi\b/i],
  ['Wallet', /\bwallets?\b/i],
  ['Gift Card', /gift card/i],
];

/** The ways to pay the page offers: named on its controls, or on a short line of its text (not in a sentence about something else). */
export function paymentMethods(page: Page, text: string): string[] {
  const candidates = [...controls(page), ...text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && l.length <= 60)];
  const found: string[] = [];
  for (const [label, re] of METHODS) if (candidates.some((c) => re.test(c)) && !found.includes(label)) found.push(label);
  return found;
}

export function methodFromReply(reply: string): string | null {
  const r = reply.toLowerCase();
  if (/\bupi\b|g ?pay|google ?pay|phone ?pe|paytm/.test(r)) return 'UPI';
  if (/\bcash\b|\bcod\b|pay on delivery|\bpod\b/.test(r)) return 'Cash on Delivery';
  if (/net ?banking/.test(r)) return 'Net Banking';
  if (/\bcard\b|credit|debit/.test(r)) return 'Card';
  if (/\bemi\b/.test(r)) return 'EMI';
  if (/\bwallet\b/.test(r)) return 'Wallet';
  return null;
}

export function detectStage(page: Page, text: string): CheckoutStage {
  const ctl = controls(page);
  const heads = `${page.title} ${page.headings.join(' ')}`;
  if (page.signedIn === 'no' || (/\b(?:log ?in|sign ?in)\b/i.test(heads) && page.inputs.some((i) => /mobile|e-?mail|phone/i.test(i)))) return 'login';
  if (UNAVAILABLE.test(`${heads}\n${text}`)) return 'unavailable';
  if (ctl.some((c) => /^deliver here$/i.test(c))) return 'address';
  if (ctl.some((c) => /^continue$/i.test(c)) && /order summary/i.test(`${heads}\n${text}`)) return 'summary';
  if (paymentMethods(page, text).length >= 2 || (/payment (?:options?|method)/i.test(`${heads}\n${text}`) && ctl.some((c) => /^(?:pay\b|place order)/i.test(c)))) return 'payment';
  return 'unknown';
}

/** The saved delivery addresses the page lists (each shows its 6-digit pincode), in the part of the page about the delivery address. */
export function parseAddresses(text: string): string[] {
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l !== '');
  const from = lines.findIndex((l) => /delivery address/i.test(l));
  let slice = from >= 0 ? lines.slice(from + 1) : lines;
  const to = slice.findIndex((l) => /^(?:order summary|price details|payment options?|payment method)/i.test(l));
  if (to >= 0) slice = slice.slice(0, to);
  const out: string[] = [];
  for (const l of slice) {
    if (l.length < 12 || l.length > 220 || !/\b\d{6}\b/.test(l)) continue;
    const pin = /\b\d{6}\b/.exec(l)?.[0] ?? '';
    if (!out.some((o) => o.includes(pin) && o.slice(0, 18) === l.slice(0, 18))) out.push(l);
    if (out.length >= 5) break;
  }
  return out;
}

// ("the second one": the word "one" alone is only "the first" when it is the whole reply)
const ORDINALS: ReadonlyArray<readonly [RegExp, number]> = [[/\b(?:5|5th|fifth|five)\b/, 4], [/\b(?:4|4th|fourth|four)\b/, 3], [/\b(?:3|3rd|third|three)\b/, 2], [/\b(?:2|2nd|second|two)\b/, 1], [/\b(?:1|1st|first)\b|^\s*one\s*$/, 0]];

/** Which of the listed addresses a reply picks: its number, or a word (a place, a pincode) from exactly one of them. */
export function addressIndex(reply: string, options: readonly string[]): number | null {
  const r = reply.toLowerCase();
  for (const [re, i] of ORDINALS) if (re.test(r) && i < options.length) return i;
  const words = r.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  const hits = options.map((o, i) => ({ i, n: words.filter((w) => o.toLowerCase().includes(w)).length })).filter((h) => h.n > 0);
  return hits.length === 1 ? (hits[0] as { i: number }).i : null;
}

const YES = /^\s*(?:yes|yeah|yep|yup|ok(?:ay)?|sure|go ahead|place (?:it|the order)|confirm(?:ed)?|do it|proceed|please do|continue)\b/i;
const NO = /^\s*(?:no|nope|nah|cancel|stop|don'?t|do not|leave it|not now)\b/i;

// ------------------------------------------------------------------------------------------------------------------ walking it

async function sleeper(deps: CheckoutDeps): Promise<(ms: number) => Promise<void>> {
  return deps.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
}

interface View {
  readonly page: Page;
  readonly text: string;
}

function money(view: View): { total?: string; deliverTo?: string; items: readonly string[] } {
  const facts = checkoutFacts({ ...(view.page.raw as unknown as PageSnapshot), headings: view.page.headings, links: view.page.links, buttons: view.page.buttons, inputs: view.page.inputs, visibleText: view.text } as PageSnapshot);
  return { ...(facts?.amounts[0] !== undefined ? { total: facts.amounts[0] } : {}), ...(facts?.deliverTo !== undefined ? { deliverTo: facts.deliverTo } : {}), items: facts?.items ?? [] };
}

class Walk {
  readonly steps: string[] = [];
  readonly tools: string[] = [];
  constructor(readonly deps: CheckoutDeps) {}

  async call(name: string, args: ToolArgs, say: string): Promise<ToolResult | null> {
    if (this.deps.stopped?.() === true) return null;
    this.deps.say(say);
    this.tools.push(name);
    return this.deps.invoke(name, args);
  }

  async look(say = 'Reading the page…'): Promise<View | null> {
    const inspected = await this.call('inspect_page', {}, say);
    if (inspected === null) return null;
    const page = pageOf(inspected);
    if (page === null) return null;
    let text = '';
    const read = await this.call('read_page', {}, say);
    const t = read?.data?.['text'];
    if (typeof t === 'string') text = t;
    if (text === '' && typeof page.raw['visibleText'] === 'string') text = page.raw['visibleText'];
    return { page, text };
  }

  result(answer: string | null, pending: PendingCheckout | null, needsUser: boolean, note = ''): CheckoutResult {
    return { answer, pending, needsUser, steps: this.steps, tools: this.tools, note: note === '' && answer !== null ? answer : note };
  }

  /** Where it stopped without anything to ask: the model carries on from the page (it is told the steps done). */
  handOver(site: string, why: string, view: View | null): CheckoutResult {
    return this.result(null, null, false, `Eya went through ${site}'s checkout herself: ${this.steps.join('; ') || 'no steps'}. She stopped because ${why}. ${view !== null ? `The page shows "${view.page.title}". ` : ''}Carry on from the page as it is (read it first): ask the person ONE question at the payment step (which way to pay) and ONE confirmation before the click that pays or places the order; never ask "shall I proceed".`);
  }
}

function paymentQuestion(site: string, product: string, methods: readonly string[], summary: string): string {
  const list = methods.length > 0 ? methods.join(', ') : 'UPI, cash on delivery, card or net banking';
  return `I'm at the payment step on ${site}. ${summary} How do you want to pay — ${list}? I never type card numbers or PINs (for a card you type them on the page; UPI you approve in your own UPI app). Tell me which, and I'll choose it and ask you once before placing the order.`;
}

/** From the page just reached after "Buy now": goes on, step by step, until something has to be asked. */
export async function advanceCheckout(deps: CheckoutDeps, ctx: { readonly site: string; readonly product: string }): Promise<CheckoutResult> {
  const { site, product } = ctx;
  const sleep = await sleeper(deps);
  const w = new Walk(deps);
  let lastKey = '';
  let repeats = 0;
  let view: View | null = null;
  for (let round = 0; round < 10; round += 1) {
    view = await w.look(round === 0 ? 'Looking at the checkout…' : 'Reading the next page…');
    if (view === null) return w.result(null, null, false, `Eya went through ${site}'s checkout herself: ${w.steps.join('; ') || 'no steps'}. The page could not be read, or the request was stopped.`);
    const stage = detectStage(view.page, view.text);
    const key = `${stage}|${view.page.title}`;
    // (a page that is not a step yet is waited on below, with its own limit; only a real step that comes back again and again is a loop)
    repeats = key === lastKey && stage !== 'unknown' ? repeats + 1 : 0;
    lastKey = key;
    if (repeats >= 2) return w.handOver(site, `the same ${stage} step came up three times`, view);
    const facts = money(view);
    if (stage === 'login') return w.result(`${site} asks to sign in before the checkout. Sign in on the page (I never type a password; tell me the one-time code if it asks for one) and say "continue".`, null, true);
    if (stage === 'unavailable') {
      return w.result(`${site} says ${product} is not available for delivery to ${facts.deliverTo ?? 'the address that is chosen'}. I stopped before anything was bought. I can try another saved address, another variant or another phone: tell me which.`, null, false);
    }
    if (stage === 'address') {
      const addresses = parseAddresses(view.text);
      if (addresses.length >= 2) {
        const list = addresses.map((a, i) => `${i + 1}) ${a.slice(0, 110)}`).join(' ');
        return w.result(`You have ${addresses.length} delivery addresses on ${site}: ${list} Which one should I deliver to? Say the number.`, { site, product, stage: 'address', options: addresses, summary: '', at: Date.now() }, false);
      }
      const pressed = await w.call('click_on_page', { text: 'Deliver Here' }, 'Using your delivery address…');
      if (pressed === null) return w.result(null, null, false);
      if (!pressed.ok) return w.handOver(site, `"Deliver Here" did not work (${pressed.summary})`, view);
      w.steps.push(`Used the delivery address${addresses[0] !== undefined ? ` (${addresses[0].slice(0, 60)})` : ''}`);
      await sleep(1200);
      continue;
    }
    if (stage === 'summary') {
      const pressed = await w.call('click_on_page', { text: 'Continue' }, 'Going on from the order summary…');
      if (pressed === null) return w.result(null, null, false);
      if (!pressed.ok) return w.handOver(site, `"Continue" on the order summary did not work (${pressed.summary})`, view);
      w.steps.push('Went on from the order summary');
      await sleep(1200);
      continue;
    }
    if (stage === 'payment') {
      const methods = paymentMethods(view.page, view.text);
      const addr = facts.deliverTo ?? parseAddresses(view.text)[0];
      const summary = `${product}${facts.total !== undefined ? `, ${facts.total}` : ''}${addr !== undefined ? `, delivering to ${addr.slice(0, 90)}` : ''}.`;
      return w.result(paymentQuestion(site, product, methods, summary), { site, product, stage: 'payment', options: methods, summary, at: Date.now() }, false);
    }
    // unknown: the first round it may still be loading
    if (round < 2) {
      await sleep(1300);
      continue;
    }
    return w.handOver(site, 'the page is not one of the checkout steps she knows (address, order summary, payment)', view);
  }
  return w.handOver(site, 'the checkout took more steps than she follows on her own', view);
}

function finalButton(page: Page): string | undefined {
  const ctl = controls(page);
  return ctl.find((c) => /^place order\b/i.test(c)) ?? ctl.find((c) => /^pay\b/i.test(c)) ?? ctl.find((c) => /^confirm order\b/i.test(c)) ?? ctl.find((c) => /^continue$/i.test(c));
}

const PLACED = /order (?:placed|confirmed|successful)|thank you for (?:your )?order|payment (?:successful|received)|your order has been placed/i;

/**
 * The person's next words, for the checkout that stopped waiting for them. Null: those words are not an answer to it (the model is asked instead).
 * Pays only after a clear yes to the one confirmation; and never types a card number.
 */
export async function continueCheckout(deps: CheckoutDeps, pending: PendingCheckout, reply: string): Promise<CheckoutResult | null> {
  const { site, product } = pending;
  const w = new Walk(deps);
  const sleep = await sleeper(deps);
  if (NO.test(reply)) return w.result(`Ok, I've stopped. Nothing was paid or placed on ${site}.`, null, false);

  if (pending.stage === 'address') {
    const i = addressIndex(reply, pending.options);
    if (i === null) return null;
    const chosen = pending.options[i] as string;
    const clicked = await w.call('click_on_page', { text: chosen.slice(0, 60) }, 'Choosing that address…');
    if (clicked === null) return w.result(null, null, false);
    if (!clicked.ok) return w.handOver(site, `choosing that address did not work (${clicked.summary})`, null);
    w.steps.push(`Chose the address ${i + 1}`);
    await sleep(1000);
    const more = await advanceCheckout(deps, ctx(site, product));
    return { ...more, steps: [...w.steps, ...more.steps], tools: [...w.tools, ...more.tools] };
  }

  if (pending.stage === 'payment') {
    const method = methodFromReply(reply);
    if (method === null) return null;
    const view0 = await w.look('Looking at the payment options…');
    if (view0 === null) return w.result(null, null, false);
    const re = METHODS.find(([label]) => label === method)?.[1];
    const control = re === undefined ? undefined : controls(view0.page).find((c) => re.test(c)) ?? view0.text.split('\n').map((l) => l.trim()).find((l) => l.length > 0 && l.length <= 60 && re.test(l));
    const clicked = await w.call('click_on_page', { text: control ?? method }, `Choosing ${method}…`);
    if (clicked === null) return w.result(null, null, false);
    if (!clicked.ok) return w.handOver(site, `choosing ${method} did not work (${clicked.summary})`, view0);
    w.steps.push(`Chose ${method}`);
    if (method === 'Card') {
      return w.result(`I opened the card option on ${site}. I never type card numbers, expiry or CVV: please type them on the page yourself, and tell me when to carry on.`, null, true);
    }
    await sleep(1000);
    const view = await w.look('Reading the page…');
    if (view === null) return w.result(null, null, false);
    const facts = money(view);
    const addr = facts.deliverTo ?? parseAddresses(view.text)[0];
    const built = `${product}${facts.total !== undefined ? `, ${facts.total}` : ''}${addr !== undefined ? `, delivering to ${addr.slice(0, 90)}` : ''}`;
    const line = built !== product ? `${built}.` : pending.summary;
    return w.result(`I chose ${method}. ${line} Shall I place the order now? Say yes and I'll place it; no and I'll stop.`, { ...pending, stage: 'confirm', method, options: [], summary: line, at: Date.now() }, false);
  }

  // confirm: only a clear yes pays
  if (!YES.test(reply)) return null;
  const view = await w.look('Getting ready to place the order…');
  if (view === null) return w.result(null, null, false);
  const button = finalButton(view.page);
  if (button === undefined) return w.handOver(site, 'the button that places the order could not be seen', view);
  const pressed = await w.call('click_on_page', { text: button, confirm: true }, `Placing the order (${button})…`);
  if (pressed === null) return w.result(null, null, false);
  if (!pressed.ok) return w.handOver(site, `pressing "${button}" did not work (${pressed.summary})`, view);
  w.steps.push(`Pressed "${button}" after the person's yes`);
  let after: View | null = null;
  for (let i = 0; i < 6; i += 1) {
    await sleep(1300);
    after = await w.look('Checking what happened…');
    if (after === null) break;
    if (PLACED.test(`${after.page.title} ${after.page.headings.join(' ')} ${after.text}`) || after.page.title !== view.page.title) break;
  }
  const shown = after === null ? '' : `${after.page.title} ${after.page.headings.join(' ')} ${after.text}`;
  const id = /order\s*(?:id|no\.?|number)?\s*[:#]?\s*(OD\d{6,}|[A-Z0-9-]{8,})/i.exec(shown)?.[1];
  if (PLACED.test(shown)) return w.result(`Done: the order for ${product} is placed on ${site}${id !== undefined ? ` (order ${id})` : ''}. ${pending.summary}`, null, false);
  return w.result(`I pressed "${button}". ${after !== null ? `The page now shows "${after.page.title}", ` : ''}but I can't see an order confirmation yet. If ${site} is waiting for you (a UPI approval on your phone, a code), do that now, and tell me when it's done; I'll check the page.`, null, pending.method === 'UPI' || pending.method === 'Card');
}

function ctx(site: string, product: string): { readonly site: string; readonly product: string } {
  return { site, product };
}
