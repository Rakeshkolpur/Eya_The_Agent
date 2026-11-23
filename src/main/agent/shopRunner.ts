import { checkoutFacts } from '@main/browser/checkoutFacts';
import type { PageSnapshot } from '@main/browser/pageSnapshot';
import type { ToolArgs, ToolResult } from '@main/tools/types';
import { controls, own, pageOf } from './pageReading';
import type { Page } from './pageReading';
import { advanceCheckout } from './checkoutRunner';
import type { PendingCheckout } from './checkoutRunner';

/**
 * "login flipkart and order POCO M7 Pro 5G 6GB 128GB", done by the application itself, step by step, with no AI call: search the shop, pick the phone that is really what was
 * named (not a screen guard for it), choose the variant, press Add to cart (or the page's own Buy button), and read where that leads. It stops at the first page where the
 * person decides: the cart or checkout (with what it charges and where it goes), a phone that is not on the shop, a variant it does not offer, a sign-in wall. It never
 * presses a button that pays or places the order, and never types a password or a card.
 *
 * Why it exists: a real run on a free AI allowance spent 146 s and 299,000 tokens on one order, and with the AI down the small fallback model refused it. The steps are all
 * the same on any shop (search box, results, a product page, a buy button), so they are not worth an AI call each.
 *
 * Measured on the real Flipkart (signed out, read in a browser): a phone page has no "Add to cart", its way to buy is "Buy at ₹14,249"; a search for a phone that is no longer
 * sold returns only cases and screen guards for it, plus newer models.
 */
export const SHOP_SITES: ReadonlySet<string> = new Set(['flipkart', 'amazon', 'myntra', 'meesho', 'ajio', 'nykaa']);

/**
 * Shops whose "Buy now" only OPENS the checkout (sign-in, address, order summary and payment follow, each with its own click): pressing it is how an order is started there, and the
 * person's own "order …" is the yes to that. On any other shop it is asked first. Paying and placing the order are never pressed by the runner on any shop.
 */
const BUY_NOW_STARTS_CHECKOUT: ReadonlySet<string> = new Set(['flipkart', 'amazon']);

export interface ShopRunDeps {
  invoke(name: string, args: ToolArgs): Promise<ToolResult>;
  say(message: string): void;
  stopped?(): boolean;
  /** Waits (a page that is still loading); the real clock unless a test gives its own. */
  sleep?(ms: number): Promise<void>;
}

export interface ShopRunResult {
  /** Said to the person as it is (no AI): the order is at a point where they decide, or it cannot go on. Null when the model should carry on from where the page is. */
  readonly answer: string | null;
  /** What was done, one line each, for the record of steps. */
  readonly steps: readonly string[];
  readonly tools: readonly string[];
  /** The page needs the person (a sign-in). */
  readonly needsUser: boolean;
  /** Where the checkout stopped for the person's answer (see checkoutRunner.ts). */
  readonly pending?: PendingCheckout;
  /** Facts for the model when it is asked next: what was done and where the page is. */
  readonly note: string;
}

// ------------------------------------------------------------------------------------------------------------------ what was asked for

const SITE_WORDS = /\b(?:flipkart|flipcart|filpkart|amazon(?:\.in)?|amazone|amzon|myntra|mintra|meesho|mesho|ajio|nykaa)\b/gi;

/** The thing to buy, in the person's words, without the filler ("one any color", "from flipkart", "please"). Empty when no order verb is found. */
export function productFromRequest(text: string): string {
  // (about an order that already exists, not a new one to place: "check my order status", "track my flipkart order", "cancel the order", "order again")
  if (/\bmy\s+orders?\b|\b(?:track|check|cancel|return|refund|status of)\b[^.]{0,24}\border/i.test(text) || /\borders?\s+(?:status|history|details|id|number|tracking|again)\b|\breorder\b/i.test(text)) return '';
  const m = /\b(?:order|buy|purchase|get|add)\b\s+(?:me\s+)?(?:a\s+|an\s+|the\s+|one\s+)?(.+)$/i.exec(text);
  if (m === null) return '';
  let p = m[1] ?? '';
  p = p.replace(/\b(?:from|on|in|at|using|through|via)\s+(?:the\s+)?(?:flipkart|flipcart|filpkart|amazon(?:\.in)?|amazone|amzon|myntra|mintra|meesho|mesho|ajio|nykaa)\b.*$/i, ' ');
  p = p.replace(SITE_WORDS, ' ');
  p = p.replace(/\.{2,}/g, ' ').replace(/\b(?:any\s+colou?r|one|please|pls|now|for me)\b/gi, ' ');
  p = p.replace(/[^\p{L}\p{N}+\s.-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return p.length >= 3 ? p : '';
}

const FILLER = new Set(['ram', 'rom', 'storage', 'memory', 'and', 'with', 'the', 'a', 'an', 'new', 'latest', 'phone', 'mobile', 'smartphone']);
const ACCESSORY = /\b(case|cover|guard|glass|protector|tempered|charger|cable|adapter|earphones?|headphones?|earbuds?|stand|holder|skin|pouch|strap|lens|mount|cleaner|screen)\b/;

function norm(s: string): string {
  return s.toLowerCase().replace(/(\d+)\s*(gb|tb)\b/g, '$1$2').replace(/[^a-z0-9]+/g, ' ').trim();
}

export interface Wanted {
  /** Words of the model's name: all must be in a result ("poco", "m7", "pro", "5g"). */
  readonly name: readonly string[];
  /** Memory sizes the person named ("6gb", "128gb"). */
  readonly specs: readonly string[];
}

export function wantedFrom(product: string): Wanted {
  const specs = [...product.toLowerCase().matchAll(/(\d+)\s*(gb|tb)\b/g)].map((m) => `${m[1]}${m[2]}`);
  const name = norm(product.replace(/(\d+)\s*(gb|tb)\b/gi, ' ')).split(' ').filter((t) => t !== '' && !FILLER.has(t));
  return { name, specs };
}

/** A phone-like result that is the model that was named (not a case or a screen guard for it, not unavailable), best first. */
export function matchingResults(links: readonly string[], wanted: Wanted): string[] {
  const scored: Array<{ link: string; score: number; index: number }> = [];
  links.forEach((link, index) => {
    const text = norm(link);
    const words = new Set(text.split(' '));
    if (/^currently unavailable\b/.test(text) || ACCESSORY.test(text)) return;
    if (!wanted.name.every((t) => words.has(t))) return;
    // "Screen Guard for POCO M6 PRO 5G": the model's name right after "for" is another product's compatibility line
    const first = wanted.name[0];
    if (first !== undefined && new RegExp(`\\bfor\\s+(?:the\\s+)?${first}\\b`).test(text)) return;
    const specsOk = wanted.specs.every((s) => words.has(s));
    scored.push({ link, score: (specsOk ? 10 : 0) - index * 0.01, index });
  });
  return scored.sort((a, b) => b.score - a.score).map((s) => s.link);
}

/** The phones a search did give (when the named one was not among them), by a short name, for the person to choose from. */
export function closestPhones(links: readonly string[]): string[] {
  const out: string[] = [];
  for (const link of links) {
    const text = norm(link);
    if (/^currently unavailable\b/.test(text) || ACCESSORY.test(text) || !/\d+gb/.test(text)) continue;
    const name = shortName(link);
    if (name !== '' && !out.includes(name)) out.push(name);
    if (out.length >= 3) break;
  }
  return out;
}

export function shortName(link: string): string {
  let s = link.replace(/^Add to Compare\s*/i, '').replace(/…$/u, '');
  const rating = /\s\d\.\d[\d,.]*\s*(?:Ratings?|&)/i.exec(s);
  if (rating !== null) s = s.slice(0, rating.index);
  return s.replace(/\s+/g, ' ').trim().slice(0, 70);
}

// ------------------------------------------------------------------------------------------------------------------ the page, as the tools report it

const ADD_TO_CART = /^(?:add to (?:cart|bag|basket))\b/i;
const BUY_AT = /^buy at\b/i;
const BUY_NOW = /^buy now\b/i;
const GO_TO_CART = /^(?:go to (?:cart|bag)|view (?:cart|bag)|cart|bag)\b/i;

function stoppedResult(steps: string[], tools: string[]): ShopRunResult {
  return { answer: null, steps, tools, needsUser: false, note: '' };
}

// ------------------------------------------------------------------------------------------------------------------ the run

export async function runShopOrder(deps: ShopRunDeps, input: { readonly site: string; readonly product: string; readonly siteId?: string }): Promise<ShopRunResult> {
  const { site, product } = input;
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const steps: string[] = [];
  const tools: string[] = [];
  const wanted = wantedFrom(product);
  let page: Page | null = null;

  const call = async (name: string, args: ToolArgs, say: string): Promise<ToolResult | null> => {
    if (deps.stopped?.() === true) return null;
    deps.say(say);
    tools.push(name);
    const r = await deps.invoke(name, args);
    const p = pageOf(r);
    if (p !== null) page = p;
    return r;
  };
  /** Where it stopped: the model carries on from here (if it can), and the person is told what was done either way. */
  const handOver = (why: string): ShopRunResult => ({
    answer: null,
    steps,
    tools,
    needsUser: false,
    note: `Eya already did these steps herself on ${site}: ${steps.join('; ') || 'none'}. She stopped because ${why}. ${page !== null ? `The page now shows "${(page as Page).title}". ` : ''}Carry on from the page as it is (read it first); do not repeat the steps that were done.`,
  });
  const said = (answer: string, needsUser = false): ShopRunResult => ({ answer, steps, tools, needsUser, note: answer });

  // 1. the shop's own search box
  const looked = await call('inspect_page', {}, `Looking at ${site}…`);
  if (looked === null) return stoppedResult(steps, tools);
  const label = (page as Page | null)?.inputs.map(own).find((i) => /search/i.test(i)) ?? 'Search';
  let searched = await call('fill_on_page', { label, value: product, submit: true }, `Searching ${site} for ${product}…`);
  // (a box that is not there yet is waited for, then clicked into first: both were needed on the real Flipkart)
  for (let attempt = 0; searched !== null && !searched.ok && searched.summary === 'not found' && attempt < 3; attempt += 1) {
    if (deps.stopped?.() === true) return stoppedResult(steps, tools);
    await sleep(1300);
    if (attempt >= 1 && (await call('click_on_page', { text: label }, `Clicking into the search box…`)) === null) return stoppedResult(steps, tools);
    searched = await call('fill_on_page', { label, value: product, submit: true }, `Searching ${site} for ${product}…`);
  }
  if (searched === null) return stoppedResult(steps, tools);
  if (!searched.ok || page === null) return handOver(`the search box did not take "${product}" (${searched.summary})`);
  steps.push(`Searched ${site} for "${product}"`);

  // 2. the phone that is really the one named
  const results = matchingResults((page as Page).links, wanted);
  const chosen = results[0];
  if (chosen === undefined) {
    const close = closestPhones((page as Page).links);
    return said(
      `I searched ${site} for "${product}" but it has no phone with that name` +
        (close.length > 0 ? ` (a search for it shows only other models; the closest are: ${close.join('; ')}). Tell me which of them you want and I'll continue, or give me another name.` : ` (only accessories and other products came up). Give me another name and I'll search again.`),
    );
  }
  const clickedResult = await call('click_on_page', { text: chosen }, `Opening ${shortName(chosen)}…`);
  if (clickedResult === null) return stoppedResult(steps, tools);
  if (!clickedResult.ok || page === null) return handOver(`opening "${shortName(chosen)}" did not work (${clickedResult.summary})`);
  steps.push(`Opened ${shortName(chosen)}`);
  // (a product page shows a loading screen first, with no buttons: read it again until it has them, for up to about 10 s)
  const buyable = (p: Page): boolean => controls(p).some((c) => ADD_TO_CART.test(c) || BUY_AT.test(c) || BUY_NOW.test(c));
  for (let waited = 0; waited < 8 && page !== null && !buyable(page as Page); waited += 1) {
    if (deps.stopped?.() === true) return stoppedResult(steps, tools);
    await sleep(1300);
    if ((await call('inspect_page', {}, 'Waiting for the page to finish loading…')) === null) return stoppedResult(steps, tools);
  }

  // 3. the variant (memory sizes) the person named, if the page has not already got it chosen
  if (wanted.specs.length > 0) {
    const titleWords = new Set(norm(`${(page as Page).title} ${(page as Page).headings.join(' ')}`).split(' '));
    if (!wanted.specs.every((s) => titleWords.has(s))) {
      const tile = controls(page as Page).find((c) => {
        const words = new Set(norm(c).split(' '));
        return wanted.specs.every((s) => words.has(s)) && !/\bratings?\b|compare/i.test(c);
      });
      if (tile === undefined) {
        const offered = controls(page as Page).filter((c) => /\d+\s*gb/i.test(c) && !/\bratings?\b|compare/i.test(c)).slice(0, 4);
        return said(`I opened ${shortName(chosen)} on ${site}, but it does not offer ${wanted.specs.join(' + ')}${offered.length > 0 ? ` (it offers: ${offered.join('; ')})` : ''}. Tell me which one you want and I'll continue.`);
      }
      const picked = await call('click_on_page', { text: tile }, `Choosing ${tile.slice(0, 40)}…`);
      if (picked === null) return stoppedResult(steps, tools);
      if (!picked.ok || page === null) return handOver(`choosing the variant "${tile.slice(0, 50)}" did not work (${picked.summary})`);
      steps.push(`Chose the variant ${tile.slice(0, 40)}`);
    }
  }

  // 4. Add to cart; else "Buy now" where that only opens the checkout (Flipkart, Amazon); else the page's own "Buy at ₹…". Each starts the purchase and none pays. A button that changes
  //    nothing (Flipkart's "Buy at" box is an offers panel on some pages) is not taken for success: the next one is tried.
  const all = controls(page as Page);
  const add = all.find((c) => ADD_TO_CART.test(c));
  const buyAt = all.find((c) => BUY_AT.test(c));
  const buyNow = all.find((c) => BUY_NOW.test(c));
  const nowIsSafe = input.siteId !== undefined && BUY_NOW_STARTS_CHECKOUT.has(input.siteId);
  const candidates = [add, nowIsSafe ? buyNow : undefined, buyAt].filter((c): c is string => c !== undefined);
  if (candidates.length === 0) {
    if (buyNow !== undefined) return said(`I'm on ${shortName(chosen)} on ${site} and have chosen the variant. The page's only buy button is "${buyNow}", which starts the purchase. Say yes and I'll press it; I won't pay or place the order without asking you again.`);
    return handOver('no Add to cart or Buy button could be seen on the product page');
  }
  /** Reads the page again until it is no longer the one it was (the checkout, the cart or a sign-in appeared), for up to about 9 s. */
  const movedOn = async (before: string): Promise<boolean> => {
    for (let i = 0; i < 8; i += 1) {
      const p = page as Page | null;
      if (p !== null && (p.title !== before || p.signedIn === 'no' || /order summary|checkout|cart|log ?in|sign ?in|address|payment/i.test(p.headings.join(' ')))) return true;
      if (deps.stopped?.() === true) return false;
      await sleep(1200);
      if ((await call('inspect_page', {}, 'Waiting for the next page…')) === null) return false;
    }
    return false;
  };
  let press: string | undefined;
  for (const candidate of candidates) {
    const before = (page as Page).title;
    const confirm = BUY_NOW.test(candidate);
    const pressed = await call('click_on_page', confirm ? { text: candidate, confirm: true } : { text: candidate }, `Pressing ${candidate.slice(0, 30)}…`);
    if (pressed === null) return stoppedResult(steps, tools);
    if (!pressed.ok || page === null) {
      if (pressed.summary === 'needs confirmation') return said(`I'm on ${shortName(chosen)} on ${site}. The next button, "${candidate}", starts the purchase: say yes and I'll press it.`);
      continue;
    }
    if (await movedOn(before)) {
      steps.push(`Pressed "${candidate}"`);
      press = candidate;
      break;
    }
  }
  if (press === undefined) return handOver(`pressing ${candidates.map((c) => `"${c}"`).join(' and ')} did not take the page anywhere`);

  // 5. an Add to cart leads to the cart: open it and read what it says
  if (ADD_TO_CART.test(press) && page !== null) {
    const cart = controls(page as Page).find((c) => GO_TO_CART.test(c));
    if (cart !== undefined) {
      const opened = await call('click_on_page', { text: cart }, 'Opening the cart…');
      if (opened === null) return stoppedResult(steps, tools);
      if (opened.ok) steps.push('Opened the cart');
    }
  }

  // 5b. a Buy button leads into the checkout: the application walks it (the address that is already chosen, the order summary) and stops at what the person must say: which
  //     of several addresses, how to pay, and then one confirmation (see checkoutRunner.ts)
  if (!ADD_TO_CART.test(press)) {
    const co = await advanceCheckout({ invoke: deps.invoke, say: deps.say, ...(deps.stopped !== undefined ? { stopped: deps.stopped } : {}), sleep }, { site, product });
    steps.push(...co.steps);
    tools.push(...co.tools);
    if (co.answer === null) return { answer: null, steps, tools, needsUser: false, note: co.note };
    const started = `I searched ${site} for "${product}", opened ${shortName(chosen)}${wanted.specs.length > 0 ? `, chose ${wanted.specs.join(' + ')}` : ''} and pressed "${press}".`;
    return { answer: `${started} ${co.answer}`, steps, tools, needsUser: co.needsUser, ...(co.pending !== null ? { pending: co.pending } : {}), note: co.answer };
  }

  // 6. where that leads, said as it is: nothing is paid and nothing is placed
  const end = page as Page | null;
  if (end === null) return handOver('the page after the last step could not be read');
  const facts = checkoutFacts({ ...(end.raw as unknown as PageSnapshot), headings: end.headings, links: end.links, buttons: end.buttons, inputs: end.inputs } as PageSnapshot);
  const did = `I searched ${site} for "${product}", opened ${shortName(chosen)}${wanted.specs.length > 0 ? `, chose ${wanted.specs.join(' + ')}` : ''} and pressed "${press}".`;
  if (end.signedIn === 'no') {
    return said(`${did} ${site} now asks to sign in, so I stopped. Sign in on the page (I never type a password; tell me the one-time code if it asks for one) and say "continue".`, true);
  }
  const money = facts !== null && facts.amounts.length > 0 ? ` It shows ${facts.amounts.slice(0, 2).join('; ')}${facts.deliverTo !== undefined ? `, delivering to ${facts.deliverTo}` : ''}.` : '';
  return said(`${did} The page now shows "${end.title}".${money} I have not paid or placed any order. Say "continue" and I'll go on to the next step; I'll check with you before the last click that places the order.`);
}
