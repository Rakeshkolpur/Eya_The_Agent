import { describe, expect, it } from 'vitest';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { closestPhones, matchingResults, productFromRequest, runShopOrder, shortName, wantedFrom } from '../src/main/agent/shopRunner';
import { ConversationContext } from '../src/main/context/ConversationContext';
import type { AIChatMessage, AICompletion, AIProvider, AIToolSpec } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';
import type { AgentRequest, AgentResult } from '../src/shared/types';

// ------------------------------------------------------------------------------------------------------------------ the real Flipkart's words (read from its public pages)
const SEARCH_RESULTS = [
  'Add to Compare BOLTT ACE 5G (Sky Blue, 128 GB) 3.92,885 Ratings & 787 Reviews 6 GB RAM | 1…',
  'Add to Compare POCO M7 Pro 5G (Lavender Frost, 128 GB) 4.338,576 Ratings & 3,320 Reviews 6 GB RAM |…',
  'Currently unavailable Dasiana Front and Back Screen Guard for POCO M6 PRO 5G Scratch Resis…',
  'Add to Compare POCO M8x 5G (Leather Green, 128 GB) 3.91,095 Ratings & 184 Reviews 6 GB RAM…',
  'Currently unavailable KML Crafts Villa Edge To Edge Tempered Glass for Poco M6 Pro Anti Fi…',
  'Add to Compare POCO M7 Pro 5G (Lavender Frost, 256 GB) 4.314,674 Ratings & 1,338 Reviews 8 GB…',
  'Add to Compare POCO M7 5G (Ocean Blue, 128 GB) 4.177,535 Ratings & 4,384 Reviews 6 GB RAM…',
];
const M6_RESULTS = [
  'Currently unavailable Dasiana Front and Back Screen Guard for POCO M6 PRO 5G Scratch Resis…',
  'Add to Compare POCO M7 Pro 5G (Lavender Frost, 128 GB) 4.338,576 Ratings & 3,320 Reviews 6 GB RAM |…',
  'Currently unavailable KML Crafts Villa Edge To Edge Tempered Glass for Poco M6 Pro Anti Fi…',
  'Add to Compare POCO M8x 5G (Leather Green, 128 GB) 3.91,095 Ratings & 184 Reviews 6 GB RAM…',
  'Screen Guard for POCO M6 PRO 5G',
];

const page = (title: string, extra: Record<string, unknown> = {}): ToolResult => ({
  ok: true,
  summary: title,
  data: { currentPage: { url: 'https://www.flipkart.com/x', title, headings: [], links: [], buttons: [], inputs: [], ...extra } },
});

interface Script {
  readonly calls: Array<{ name: string; args: ToolArgs }>;
  readonly invoke: (name: string, args: ToolArgs) => Promise<ToolResult>;
}
const HOME = page('Online Shopping Site for Mobiles', { inputs: ['Search for Products, Brands and More'] });
/**
 * A pretend shop. Each tool answers from the function given for it; a page that a click or a fill returns becomes the page that inspect_page and read_page report afterwards
 * (as in a browser); every call is recorded.
 */
function shop(answers: Record<string, (args: ToolArgs, n: number) => ToolResult>): Script {
  const calls: Array<{ name: string; args: ToolArgs }> = [];
  const seen = new Map<string, number>();
  let cur: ToolResult = HOME;
  return {
    calls,
    invoke: async (name, args) => {
      calls.push({ name, args });
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      const f = answers[name];
      let r: ToolResult;
      if (f !== undefined) r = f(args, n);
      else if (name === 'inspect_page') r = cur;
      else if (name === 'read_page') r = { ok: true, summary: 'read', data: { text: String((cur.data?.['currentPage'] as Record<string, unknown> | undefined)?.['visibleText'] ?? '') } };
      else r = { ok: false, summary: 'no such tool', error: name };
      if ((name === 'fill_on_page' || name === 'click_on_page') && r.ok) cur = r;
      return r;
    },
  };
}
const slept: number[] = [];
const run = (s: Script, product: string, stopped?: () => boolean, siteId?: string) =>
  runShopOrder({ invoke: s.invoke, say: () => undefined, sleep: async (ms) => void slept.push(ms), ...(stopped !== undefined ? { stopped } : {}) }, { site: 'Flipkart', product, ...(siteId !== undefined ? { siteId } : {}) });

const PRODUCT_128_6 = page('POCO M7 Pro 5G (128 GB Storage, 6 GB RAM) Online at Best Price On Flipkart.com', {
  links: ['Login', 'Cart'],
  buttons: ['128 GB + 6 GB ↓21% 18,999 ₹14,999', '256 GB + 8 GB ↓10% 20,999 ₹16,999', 'Buy at ₹14,249', 'Buy now'],
});
/** The payment step of Flipkart's checkout: the ways to pay, the total, the address. */
const PAYMENT = page('Payment - Flipkart', {
  headings: ['Payment Options'],
  buttons: ['UPI', 'Cash on Delivery', 'Credit / Debit / ATM Card', 'Net Banking', 'Pay ₹14,249'],
  signedIn: 'likely',
  visibleText: 'Payment Options\nUPI\nCash on Delivery\nNet Banking\nTotal Payable ₹14,249\nDelivering to Rakesh, H.No 1-2 Main Road, Makthal, Narayanpet - 509208',
});

describe('what the person asked to buy', () => {
  it('is taken out of the sentence, without the site, the filler or the dots', () => {
    expect(productFromRequest('login flipkart and order POCO M7 Pro 5G 6GB 128GB')).toBe('POCO M7 Pro 5G 6GB 128GB');
    expect(productFromRequest('login filpkart and order POCO M6 pro 5G .. 6GB ram 128GB one any color')).toBe('POCO M6 pro 5G 6GB ram 128GB');
    expect(productFromRequest('buy a red cotton shirt from myntra please')).toBe('red cotton shirt');
    expect(productFromRequest('open flipkart')).toBe('');
    expect(productFromRequest('order')).toBe('');
    // (an order that already exists is not a new one to place)
    for (const text of ['check my order status on flipkart', 'track my flipkart order', 'cancel the order on flipkart', 'show my orders on flipkart', 'order status flipkart', 'reorder on flipkart']) expect(productFromRequest(text), text).toBe('');
    // (but "my" elsewhere in the sentence does not matter)
    expect(productFromRequest('login to my flipkart and order POCO M7 Pro 5G')).toBe('POCO M7 Pro 5G');
  });

  it('is split into the name every result must have and the memory sizes', () => {
    expect(wantedFrom('POCO M7 Pro 5G 6GB RAM 128GB')).toEqual({ name: ['poco', 'm7', 'pro', '5g'], specs: ['6gb', '128gb'] });
  });
});

describe('which result is the phone that was named', () => {
  const wanted = wantedFrom('POCO M7 Pro 5G 6GB 128GB');
  it('the model itself with the sizes asked for comes first; other sizes of it come after; other models and accessories never', () => {
    const r = matchingResults(SEARCH_RESULTS, wanted);
    expect(r[0]).toContain('POCO M7 Pro 5G (Lavender Frost, 128 GB)');
    expect(r).toHaveLength(2);
    expect(r[1]).toContain('256 GB');
  });

  it('a screen guard "for POCO M6 PRO 5G" is not the phone, and nothing is picked when only guards and other models came up', () => {
    expect(matchingResults(M6_RESULTS, wantedFrom('POCO M6 Pro 5G 6GB 128GB'))).toEqual([]);
  });

  it('a case or a charger that carries the name of the model, and an item that is "currently unavailable", are not the phone', () => {
    const results = ['Currently unavailable POCO M7 Pro 5G (Lavender Frost, 128 GB) 6 GB RAM', 'POCO M7 Pro 5G Back Case Cover (Black)', 'Original Fast Wall Plug for POCO M7 PRO 5G 6GB', 'Add to Compare POCO M7 Pro 5G (Lavender Frost, 128 GB) 6 GB RAM'];
    expect(matchingResults(results, wanted)).toEqual([results[3]]);
  });

  it('the result with the sizes asked for comes before one that has the model but other sizes, wherever it is in the list', () => {
    const results = ['Add to Compare POCO M7 Pro 5G (Lavender Frost, 256 GB) 8 GB RAM', 'Add to Compare POCO M7 Pro 5G (Lavender Frost, 128 GB) 6 GB RAM'];
    expect(matchingResults(results, wanted)[0]).toBe(results[1]);
  });

  it('the closest phones are named briefly, never an accessory', () => {
    const close = closestPhones(M6_RESULTS);
    expect(close).toEqual(['POCO M7 Pro 5G (Lavender Frost, 128 GB)', 'POCO M8x 5G (Leather Green, 128 GB)']);
    expect(shortName(SEARCH_RESULTS[1] as string)).toBe('POCO M7 Pro 5G (Lavender Frost, 128 GB)');
  });
});

describe('the order, step by step, with no AI', () => {
  it('searches, opens the right phone, presses "Buy at …", walks to the payment step and asks HOW TO PAY — no "shall I proceed", and pays nothing', async () => {
    const s = shop({
      fill_on_page: () => page('Search results', { links: SEARCH_RESULTS }),
      click_on_page: (a) => (String(a['text']).startsWith('Buy at') ? PAYMENT : PRODUCT_128_6),
    });
    const r = await run(s, 'POCO M7 Pro 5G 6GB 128GB');
    expect(s.calls.map((c) => c.name)).toEqual(['inspect_page', 'fill_on_page', 'click_on_page', 'click_on_page', 'inspect_page', 'read_page']);
    expect(s.calls[1]?.args).toEqual({ label: 'Search for Products, Brands and More', value: 'POCO M7 Pro 5G 6GB 128GB', submit: true });
    expect(String(s.calls[2]?.args['text'])).toContain('POCO M7 Pro 5G (Lavender Frost, 128 GB)');
    expect(s.calls[3]?.args).toEqual({ text: 'Buy at ₹14,249' });
    expect(r.answer).toMatch(/pressed "Buy at ₹14,249"/);
    expect(r.answer).toMatch(/payment step/);
    expect(r.answer).toMatch(/How do you want to pay — UPI, Cash on Delivery, Card, Net Banking\?/);
    expect(r.answer).toMatch(/Total Payable ₹14,249/);
    expect(r.answer).not.toMatch(/shall I proceed/i);
    expect(r.pending).toMatchObject({ stage: 'payment', options: ['UPI', 'Cash on Delivery', 'Card', 'Net Banking'] });
    expect(r.needsUser).toBe(false);
    expect(s.calls.some((c) => /buy now|place order|pay\b/i.test(String(c.args['text'] ?? '')))).toBe(false);
  });

  it('a phone that is not sold (only guards and other models): says so, names the closest, presses nothing', async () => {
    const s = shop({ fill_on_page: () => page('Search results', { links: M6_RESULTS }), click_on_page: () => PRODUCT_128_6 });
    const r = await run(s, 'POCO M6 pro 5G 6GB ram 128GB');
    expect(r.answer).toMatch(/has no phone with that name/);
    expect(r.answer).toMatch(/POCO M7 Pro 5G \(Lavender Frost, 128 GB\); POCO M8x 5G/);
    expect(s.calls.map((c) => c.name)).toEqual(['inspect_page', 'fill_on_page']);
  });

  it('chooses the variant when the page opened on another one', async () => {
    const other = page('POCO M7 Pro 5G (256 GB Storage, 8 GB RAM) Online at Best Price', { buttons: (PRODUCT_128_6.data?.['currentPage'] as { buttons: string[] }).buttons });
    const s = shop({
      fill_on_page: () => page('Search results', { links: SEARCH_RESULTS }),
      click_on_page: (a, n) => (n === 1 ? other : String(a['text']).startsWith('128 GB') ? PRODUCT_128_6 : PAYMENT),
    });
    const r = await run(s, 'POCO M7 Pro 5G 6GB 128GB');
    expect(s.calls.filter((c) => c.name === 'click_on_page').map((c) => String(c.args['text']).slice(0, 14))).toEqual(['Add to Compare', '128 GB + 6 GB ', 'Buy at ₹14,249']);
    expect(r.answer).toMatch(/pressed "Buy at ₹14,249"/);
  });

  it('a variant the page does not offer is said, with what it does offer; nothing is pressed', async () => {
    const only8 = page('POCO M7 Pro 5G (256 GB Storage, 8 GB RAM)', { buttons: ['256 GB + 8 GB ₹16,999', 'Buy at ₹16,249'] });
    const s = shop({ fill_on_page: () => page('r', { links: SEARCH_RESULTS }), click_on_page: () => only8 });
    const r = await run(s, 'POCO M7 Pro 5G 6GB 128GB');
    expect(r.answer).toMatch(/does not offer 6gb \+ 128gb \(it offers: 256 GB \+ 8 GB ₹16,999\)/);
    expect(s.calls.filter((c) => c.name === 'click_on_page')).toHaveLength(1);
  });

  it('a shop with "Add to cart" (not a phone page): presses it, then opens the cart', async () => {
    const product = page('Red cotton shirt', { buttons: ['Add to cart', 'Buy now'] });
    const cart = page('Shopping Cart', { links: ['Proceed to checkout'], visibleText: 'Subtotal ₹1,099' });
    const s = shop({
      fill_on_page: () => page('r', { links: ['Red cotton shirt (M) ₹1,099', 'Blue denim shirt'] }),
      click_on_page: (a) => (String(a['text']) === 'Add to cart' ? page('Added', { links: ['Go to cart'] }) : String(a['text']) === 'Go to cart' ? cart : product),
    });
    const r = await run(s, 'red cotton shirt');
    expect(s.calls.filter((c) => c.name === 'click_on_page').map((c) => String(c.args['text']))).toEqual(['Red cotton shirt (M) ₹1,099', 'Add to cart', 'Go to cart']);
    expect(r.answer).toMatch(/pressed "Add to cart"/);
    expect(r.answer).toMatch(/Shopping Cart/);
  });

  it('only "Buy now" on the page of a shop where it may start something else: it is NOT pressed; the person is asked', async () => {
    const onlyNow = page('Shirt', { buttons: ['Buy now'] });
    const s = shop({ fill_on_page: () => page('r', { links: ['Red cotton shirt (M) ₹1,099'] }), click_on_page: () => onlyNow });
    const r = await run(s, 'red cotton shirt', undefined, 'myntra');
    expect(r.answer).toMatch(/only buy button is "Buy now"/);
    expect(s.calls.some((c) => /^buy now/i.test(String(c.args['text'] ?? '')))).toBe(false);
  });

  it('a sign-in wall after the press is the person\'s: said, and flagged', async () => {
    const login = page('Login & Signup', { signedIn: 'no', inputs: ['Enter Email/Mobile number'] });
    const s = shop({ fill_on_page: () => page('r', { links: SEARCH_RESULTS }), click_on_page: (a) => (String(a['text']).startsWith('Buy at') ? login : PRODUCT_128_6) });
    const r = await run(s, 'POCO M7 Pro 5G 6GB 128GB');
    expect(r.needsUser).toBe(true);
    expect(r.answer).toMatch(/asks to sign in/);
    expect(r.answer).toMatch(/never type a password/);
  });

  it('a step that fails hands over: no answer, the steps done, and what the page shows now (the AI carries on from there)', async () => {
    const s = shop({ fill_on_page: () => page('Search results', { links: SEARCH_RESULTS }), click_on_page: () => ({ ok: false, summary: 'not found', error: 'x' }) });
    const r = await run(s, 'POCO M7 Pro 5G 6GB 128GB');
    expect(r.answer).toBeNull();
    expect(r.steps).toEqual(['Searched Flipkart for "POCO M7 Pro 5G 6GB 128GB"']);
    expect(r.note).toMatch(/Eya already did these steps herself on Flipkart: Searched Flipkart/);
    expect(r.note).toMatch(/opening "POCO M7 Pro 5G \(Lavender Frost, 128 GB\)" did not work/);
  });

  it('a search box that is not drawn yet is waited for, then clicked into (both were needed on the real Flipkart)', async () => {
    const s = shop({
      fill_on_page: (_a, n) => (n < 3 ? { ok: false, summary: 'not found', error: 'No field matching "Search for Products, Brands and More" is visible' } : page('Search results', { links: SEARCH_RESULTS })),
      click_on_page: (a) => (String(a['text']).startsWith('Search for') ? page('Home', {}) : String(a['text']).startsWith('Buy at') ? PAYMENT : PRODUCT_128_6),
    });
    slept.length = 0;
    const r = await run(s, 'POCO M7 Pro 5G 6GB 128GB');
    expect(s.calls.filter((c) => c.name === 'fill_on_page')).toHaveLength(3);
    expect(s.calls.some((c) => c.name === 'click_on_page' && String(c.args['text']).startsWith('Search for Products'))).toBe(true);
    expect(slept.length).toBeGreaterThanOrEqual(2);
    expect(r.answer).toMatch(/payment step/);
  });

  it('a search box that never takes the words is handed over, not reported as "no such phone"', async () => {
    const s = shop({ fill_on_page: () => ({ ok: false, summary: 'not found', error: 'no field' }), click_on_page: () => page('Home', {}) });
    const r = await run(s, 'POCO M7 Pro 5G 6GB 128GB');
    expect(r.answer).toBeNull();
    expect(r.steps).toEqual([]);
    expect(s.calls.filter((c) => c.name === 'fill_on_page')).toHaveLength(4);
  });

  it('a product page that is still LOADING (no buttons yet, as on the real Flipkart) is read again until it has them', async () => {
    const loading = page('POCO M7 Pro 5G (128 GB Storage, 6 GB RAM) Online at Best Price', { links: ['Login'], buttons: [] });
    let inspected = 0;
    const s = shop({
      inspect_page: () => (++inspected <= 1 ? HOME : inspected <= 3 ? loading : inspected === 4 ? PRODUCT_128_6 : PAYMENT),
      fill_on_page: () => page('Search results', { links: SEARCH_RESULTS }),
      click_on_page: (a) => (String(a['text']).startsWith('Buy') ? PAYMENT : loading),
    });
    slept.length = 0;
    const r = await run(s, 'POCO M7 Pro 5G 6GB 128GB');
    expect(slept.length).toBeGreaterThanOrEqual(2);
    expect(r.answer).toMatch(/pressed "Buy at ₹14,249"/);
  });

  it('a page that never gets its buttons: after the wait the model is handed over to, not told it was bought', async () => {
    const loading = page('POCO M7 Pro 5G (128 GB Storage, 6 GB RAM)', { buttons: [] });
    const s = shop({ fill_on_page: () => page('r', { links: SEARCH_RESULTS }), click_on_page: () => loading });
    const r = await run(s, 'POCO M7 Pro 5G 6GB 128GB');
    expect(r.answer).toBeNull();
    expect(r.note).toMatch(/no Add to cart or Buy button could be seen/);
  });

  it('on Flipkart "Buy now" (the yellow button) is how a phone is bought: pressed with the person\'s own order as the yes, BEFORE the "Buy at" offers box', async () => {
    const s = shop({
      fill_on_page: () => page('r', { links: SEARCH_RESULTS }),
      click_on_page: (a) => (String(a['text']).startsWith('Buy') ? PAYMENT : PRODUCT_128_6),
    });
    const r = await run(s, 'POCO M7 Pro 5G 6GB 128GB', undefined, 'flipkart');
    const pressed = s.calls.filter((c) => /^Buy/.test(String(c.args['text'] ?? '')));
    expect(pressed).toEqual([{ name: 'click_on_page', args: { text: 'Buy now', confirm: true } }]);
    expect(r.answer).toMatch(/pressed "Buy now"/);
    expect(r.answer).toMatch(/How do you want to pay/);
  });

  it('a button that changes nothing is not taken for success: "Buy now" does nothing, so "Buy at" is tried', async () => {
    const s = shop({
      fill_on_page: () => page('r', { links: SEARCH_RESULTS }),
      click_on_page: (a) => (String(a['text']).startsWith('Buy at') ? PAYMENT : PRODUCT_128_6),
    });
    const r = await run(s, 'POCO M7 Pro 5G 6GB 128GB', undefined, 'flipkart');
    expect(s.calls.filter((c) => /^Buy/.test(String(c.args['text'] ?? ''))).map((c) => c.args['text'])).toEqual(['Buy now', 'Buy at ₹14,249']);
    expect(r.answer).toMatch(/pressed "Buy at ₹14,249"/);
  });

  it('nothing takes the page anywhere: handed over, never reported as done', async () => {
    const s = shop({ fill_on_page: () => page('r', { links: SEARCH_RESULTS }), click_on_page: () => PRODUCT_128_6 });
    const r = await run(s, 'POCO M7 Pro 5G 6GB 128GB', undefined, 'flipkart');
    expect(r.answer).toBeNull();
    expect(r.note).toMatch(/pressing "Buy now" and "Buy at ₹14,249" did not take the page anywhere/);
  });

  it('Stop ends it where it is: nothing further is called', async () => {
    let calls = 0;
    const s = shop({ inspect_page: () => (calls++, HOME), fill_on_page: () => (calls++, page('r', { links: SEARCH_RESULTS })), click_on_page: () => (calls++, PRODUCT_128_6) });
    const r = await run(s, 'POCO M7 Pro 5G 6GB 128GB', () => calls >= 1);
    expect(calls).toBe(1);
    expect(r.answer).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------------------------ through the engine
class Recording implements AIProvider {
  readonly name = 'recording';
  readonly sent: AIChatMessage[][] = [];
  constructor(private readonly script: AICompletion[]) {}
  isReady(): boolean {
    return true;
  }
  async complete(messages: readonly AIChatMessage[], _tools: readonly AIToolSpec[]): Promise<AICompletion> {
    this.sent.push([...messages]);
    const next = this.script.shift();
    if (next === undefined) throw new Error('script exhausted');
    return next;
  }
}
const quietTTS: TTSProvider = { name: 'quiet', init: async () => undefined, speak: async () => undefined, prefetch: () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };
const ARGS = { url: { type: 'string' as const }, text: { type: 'string' as const }, label: { type: 'string' as const }, value: { type: 'string' as const }, keywords: { type: 'string' as const }, name: { type: 'string' as const }, submit: { type: 'boolean' as const }, confirm: { type: 'boolean' as const } };
const tool = (name: string, respond: (args: ToolArgs) => ToolResult): Tool => ({ schema: { name, description: name, args: ARGS, status: `${name}…` }, execute: async (args) => respond(args) });
const opened = (signedIn: 'likely' | 'no'): ToolResult => ({
  ok: true,
  summary: 'opened Flipkart',
  data: { currentPage: { url: 'https://www.flipkart.com/', title: 'Flipkart', links: ['Cart'], signedIn, signInEvidence: ['a test'] } },
});

function engine(script: AICompletion[], signedIn: 'likely' | 'no', click: (a: ToolArgs) => ToolResult) {
  const ai = new Recording(script);
  const tools = new ToolRegistry();
  const ran: string[] = [];
  const clicks: ToolArgs[] = [];
  let cur: ToolResult = HOME;
  const reg = (n: string, f: (a: ToolArgs) => ToolResult): void => tools.register(tool(n, (a) => (ran.push(n), f(a))));
  reg('find_and_open_website', () => opened(signedIn));
  reg('inspect_page', () => cur);
  reg('read_page', () => ({ ok: true, summary: 'read', data: { text: String((cur.data?.['currentPage'] as Record<string, unknown>)['visibleText'] ?? '') } }));
  reg('fill_on_page', () => (cur = page('Search results', { links: SEARCH_RESULTS })));
  reg('click_on_page', (a) => {
    clicks.push(a);
    const r = click(a);
    if (r.ok) cur = r;
    return r;
  });
  for (const n of ['open_website', 'find_on_page', 'web_search']) reg(n, () => ({ ok: true, summary: n }));
  const e = new AgentEngine({ router: new IntentRouter(), tools, composer: new ResponseComposer(), tts: quietTTS, context: new ConversationContext(), ai, now: () => new Date('2026-11-07T10:00:00Z') });
  return { e, ai, ran, clicks };
}
const send = (e: AgentEngine, text: string): Promise<AgentResult> => e.handle({ requestId: `r${Math.random().toString(36).slice(2, 6)}`, text, source: 'text', mode: 'agent' } as AgentRequest, () => undefined);
const say = (text: string): AICompletion => ({ text, toolCalls: [] });
const buy = (a: ToolArgs): ToolResult => (String(a['text']).startsWith('Buy') ? PAYMENT : PRODUCT_128_6);

describe('"login flipkart and order …" through the engine', () => {
  it('signed in: Eya does the whole run to the payment step and asks how to pay — the AI is never asked (the AI being out no longer stops an order)', async () => {
    const s = engine([], 'likely', buy);
    const r = await send(s.e, 'login flipkart and order POCO M7 Pro 5G 6GB 128GB');
    expect(s.ai.sent).toHaveLength(0);
    expect(s.ran.slice(0, 5)).toEqual(['find_and_open_website', 'inspect_page', 'fill_on_page', 'click_on_page', 'click_on_page']);
    expect(r.spoken).toMatch(/pressed "Buy now"/);
    expect(r.spoken).toMatch(/How do you want to pay/);
    expect(r.spoken).not.toMatch(/shall I proceed/i);
  });

  it('the person\'s answers are understood as answers to it, with no AI: the way to pay, then ONE confirmation, then (only on yes) the button that places the order', async () => {
    const afterUpi = page('Payment - Flipkart', { buttons: ['Pay ₹14,249'], visibleText: 'UPI selected\nTotal Payable ₹14,249\nDelivering to Rakesh, H.No 1-2 Main Road, Makthal, Narayanpet - 509208' });
    const placed = page('Order Placed', { headings: ['Order placed successfully'], visibleText: 'Order placed successfully\nOrder ID OD123456789012' });
    const s = engine([], 'likely', (a) => (String(a['text']).startsWith('Buy') ? PAYMENT : String(a['text']) === 'UPI' ? afterUpi : String(a['text']).startsWith('Pay') ? placed : PRODUCT_128_6));
    await send(s.e, 'login flipkart and order POCO M7 Pro 5G 6GB 128GB');
    const second = await send(s.e, 'UPI');
    expect(s.ai.sent).toHaveLength(0);
    expect(second.spoken).toMatch(/I chose UPI/);
    expect(second.spoken).toMatch(/Shall I place the order now\?/);
    expect(s.clicks.some((c) => /^pay/i.test(String(c['text'])))).toBe(false); // (nothing pays before the yes)
    const third = await send(s.e, 'yes');
    expect(s.ai.sent).toHaveLength(0);
    expect(third.spoken).toMatch(/Done: the order for POCO M7 Pro 5G 6GB 128GB is placed on Flipkart \(order OD123456789012\)/);
    expect(s.clicks[s.clicks.length - 1]).toEqual({ text: 'Pay ₹14,249', confirm: true });
  });

  it('"no" at the confirmation stops: nothing is placed, and the next "yes" is not taken for it', async () => {
    const afterCod = page('Payment', { buttons: ['Place order'], visibleText: 'Cash on Delivery selected\nTotal Payable ₹14,249' });
    const s = engine([say('Sure.')], 'likely', (a) => (String(a['text']).startsWith('Buy') ? PAYMENT : String(a['text']) === 'Cash on Delivery' ? afterCod : PRODUCT_128_6));
    await send(s.e, 'login flipkart and order POCO M7 Pro 5G 6GB 128GB');
    await send(s.e, 'cash on delivery');
    const stopped = await send(s.e, 'no');
    expect(stopped.spoken).toMatch(/Nothing was paid or placed/);
    expect(s.clicks.some((c) => /place order/i.test(String(c['text'])))).toBe(false);
    await send(s.e, 'yes'); // (nothing is waiting: an ordinary message now, for the AI)
    expect(s.ai.sent).toHaveLength(1);
  });

  it('a long message while a checkout waits is another request, not an answer to it', async () => {
    const s = engine([say('ok')], 'likely', buy);
    await send(s.e, 'login flipkart and order POCO M7 Pro 5G 6GB 128GB');
    await send(s.e, 'actually forget that for now and tell me whether UPI refunds are instant when a payment fails on shopping sites');
    expect(s.ai.sent).toHaveLength(1);
  });

  it('the typo\'d request of the first report does the same', async () => {
    const s = engine([], 'likely', buy);
    const r = await send(s.e, 'login filpkart and order POCO M7 pro 5G .. 6GB ram 128GB one any color');
    expect(s.ai.sent).toHaveLength(0);
    expect(r.spoken).toMatch(/How do you want to pay/);
  });

  it('signed OUT: the application does not run the order (the model signs in first, with the person)', async () => {
    const s = engine([say('Please tell me your phone number to sign in.')], 'no', buy);
    await send(s.e, 'login flipkart and order POCO M7 Pro 5G 6GB 128GB');
    expect(s.ran).toEqual(['find_and_open_website']);
    expect(s.ai.sent).toHaveLength(1);
  });

  it('a step that fails: the model is asked, and is told the steps already done', async () => {
    const s = engine([say('I will look at the page.')], 'likely', () => ({ ok: false, summary: 'not found', error: 'x' }));
    await send(s.e, 'login flipkart and order POCO M7 Pro 5G 6GB 128GB');
    expect(s.ai.sent).toHaveLength(1);
    const told = String(s.ai.sent[0]?.[(s.ai.sent[0]?.length ?? 1) - 1]?.content);
    expect(told).toMatch(/Eya already did these steps herself on Flipkart: Searched Flipkart/);
  });

  it('a food or travel site is not run this way', async () => {
    const food = engine([say('ok')], 'likely', buy);
    await send(food.e, 'order biryani on swiggy');
    expect(food.ran).not.toContain('fill_on_page');
  });
});
