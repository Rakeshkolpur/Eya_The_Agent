import { describe, expect, it } from 'vitest';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { accountDiscoveryPlan, describeDiscovery } from '../src/main/agent/discovery';
import { planAccountSite, siteNamed } from '../src/main/agent/accountSites';
import { asksToLogIn, claimsNoLogin } from '../src/main/agent/browserClaims';
import { ConversationContext } from '../src/main/context/ConversationContext';
import type { AIChatMessage, AICompletion, AIProvider, AIToolSpec } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';
import type { AgentRequest, AgentResult } from '../src/shared/types';

/**
 * 6 Nov 2026, in the person's own Chrome where Swiggy and Flipkart were already signed in: "open swiggi and login with phone number …" → "I can't access Swiggi or any other website
 * without your login credentials"; "login filpkart and order POCO M6 pro 5G …" → the product page was opened and Eya said the page was "ready for you to sign in", and stopped. Both
 * requests misspell the site and carry no word like "site", so Eya never opened them herself; and she was never told whether anyone was signed in (only a PASSWORD box was ever noticed,
 * and these sites sign in by phone number and one-time code). Now: the site is opened by the application, the page says whether the person is signed in, and the model (or Eya
 * herself, when all that was asked was to log in) goes on from that.
 */

const SWIGGY = 'open swiggi and login with phone number  6303345974';
const FLIPKART = 'login filpkart and order POCO M6 pro 5G .. 6GB ram 128GB one any color';

describe('which request is about a shop, food or travel site the person uses with their account', () => {
  it('the two real requests, typos and all', () => {
    expect(planAccountSite(SWIGGY)).toEqual({ site: expect.objectContaining({ id: 'swiggy' }), intent: 'login', phone: '6303345974' });
    expect(planAccountSite(FLIPKART)).toEqual({ site: expect.objectContaining({ id: 'flipkart' }), intent: 'order' });
  });

  it('names written the way people write them: run together or apart, in capitals, with a slip in a long one', () => {
    for (const [text, id] of [
      ['open Zomato', 'zomato'],
      ['book tickets on book my show', 'bookmyshow'],
      ['order something from amazon', 'amazon'],
      ['go to make my trip and book a flight', 'makemytrip'],
      ['login bigbasket', 'bigbasket'],
      ['buy shoes on myntra', 'myntra'],
      ['open FLIPCART', 'flipkart'],
      ['login blinkit', 'blinkit'],
      ['book a bus on red bus', 'redbus'],
      // (not in any typo list: only the tolerance for slips in a LONG name can find these)
      ['login flipkrat', 'flipkart'],
      ['order from bigbaskit', 'bigbasket'],
      ['book on bookmyshw', 'bookmyshow'],
      ['buy a ticket on makemytrp', 'makemytrip'],
    ] as const) {
      expect(planAccountSite(text)?.site.id, text).toBe(id);
    }
  });

  it('a phone number is found however it is written; an email too; what the person wants is told apart', () => {
    expect(planAccountSite('login swiggy with +91 63033 45974')?.phone).toBe('6303345974');
    expect(planAccountSite('sign in to amazon with rakesh@example.com')?.email).toBe('rakesh@example.com');
    expect(planAccountSite('open swiggy')?.intent).toBe('open');
    expect(planAccountSite('order biryani on swiggy')?.intent).toBe('order');
    expect(planAccountSite('login to flipkart and buy a phone')?.intent).toBe('order');
  });

  it('is NOT fooled by ordinary words that are one letter from a site\'s name, nor by a passing mention', () => {
    for (const text of ['order tomato soup', 'buy a mantra book', 'open the amazing race page', 'book a table at a restaurant', 'what is the capital of India', 'amazon rainforest facts', 'check amazon river length', 'open movierulz site in chrome', 'open notepad']) {
      expect(planAccountSite(text), text).toBeNull();
    }
    expect(siteNamed('tomato')).toBeNull();
    expect(siteNamed('mantra')).toBeNull();
    expect(siteNamed('ajio')?.id).toBe('ajio');
  });
});

describe('a "no" that is really a guess: "I can\'t access it without your credentials"', () => {
  it('the real answer, and the other ways a model says it', () => {
    for (const answer of [
      "I can't access Swiggi or any other website without your login credentials. If you need to access Swiggi, I suggest you log in to your account.",
      "I'm unable to log in to your account for you.",
      'I cannot log in on your behalf.',
      'You will need to log in first, then tell me.',
      'Please log in first and then I can order it.',
      'I need your login credentials to continue.',
    ]) {
      expect(claimsNoLogin(answer), answer).toBe(true);
    }
  });

  it('what is true is not a refusal', () => {
    for (const answer of [
      'You are already signed in to Swiggy, so there is nothing to log in to.',
      "I typed your number and asked Swiggy for the code. Tell me the code when it arrives, and I'll type it.",
      'Swiggy shows a Sign in button, so you are not signed in yet. I will enter the number you gave.',
      'I have opened Flipkart. It looks like you are signed in.',
      "I can't type your password, that's yours to enter.",
    ]) {
      expect(claimsNoLogin(answer), answer).toBe(false);
    }
    expect(asksToLogIn(SWIGGY)).toBe(true);
    expect(asksToLogIn('open swiggy and order biryani')).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------------------ what the model is told, and when Eya just answers
const pageResult = (signedIn: 'yes' | 'likely' | 'no' | null, host = 'www.swiggy.com', title = 'Swiggy'): ToolResult => ({
  ok: true,
  summary: `opened ${title}`,
  data: { currentPage: { url: `https://${host}/`, title, links: ['Offers', 'Cart'], ...(signedIn !== null ? { signedIn, signInEvidence: [signedIn === 'no' ? 'a "sign in" control in the header' : 'a Logout / Sign out control is on the page (in the account menu)'] } : {}) } },
});

describe('what Eya says, and tells the model, once the site is open', () => {
  const plan = (text: string) => accountDiscoveryPlan(text) as NonNullable<ReturnType<typeof accountDiscoveryPlan>>;

  it('already signed in, and all they asked was to log in: that is the answer — no model needed', () => {
    const r = describeDiscovery(plan(SWIGGY), pageResult('yes'), 'text');
    expect(r.finished).toBe(true);
    expect(r.line).toBe("You're already signed in on Swiggy, so there is nothing to log in to. What would you like me to do there?");
    const probably = describeDiscovery(plan(SWIGGY), pageResult('likely'), 'text');
    expect(probably.finished).toBe(true);
    expect(probably.line).toMatch(/looks like you're already signed in/);
  });

  it('already signed in, and an ORDER asked: not finished — the model is told they are signed in, to carry on, and what carrying on means', () => {
    const r = describeDiscovery(plan(FLIPKART), pageResult('likely', 'www.flipkart.com', 'Flipkart'), 'RESULT');
    expect(r.finished).toBe(false);
    expect(r.note).toMatch(/very probably already signed in to Flipkart/);
    expect(r.note).toMatch(/Do NOT ask them to sign in, do NOT say they need to log in or that the page is "ready for them to sign in"/);
    expect(r.note).toMatch(/The request is an order: do the whole job yourself/);
    expect(r.note).toMatch(/press Add to cart \(that spends nothing: do it yourself, never stop at the product page\)/);
    expect(r.note).toMatch(/BEFORE the click that places the order or pays, ask ONE confirmation with the item, the total, the address and the method/);
    expect(r.note).toMatch(/never ask "shall I proceed"/);
    expect(r.note).toContain('RESULT');
  });

  it('not signed in, with a phone number given: the model is told to type exactly that number, press Continue, and ask for the code — and never to refuse', () => {
    const r = describeDiscovery(plan(SWIGGY), pageResult('no'), 'text');
    expect(r.finished).toBe(false);
    expect(r.note).toMatch(/NOT signed in to Swiggy/);
    expect(r.note).toMatch(/phone number \(6303345974\): type exactly those ten digits into the page's phone-number box with fill_on_page \(a phone number is not a password\)/);
    expect(r.note).toMatch(/ask the user for the one-time code/);
    expect(r.note).toMatch(/never refuse it and never say you cannot access Swiggy or need their credentials first/);
  });

  it('not signed in and no number given: one short question for which number; unknown: look at the page, never guess', () => {
    expect(describeDiscovery(plan('login swiggy'), pageResult('no'), 'text').note).toMatch(/ask them, in one short question, which phone number or email/);
    const unknown = describeDiscovery(plan(SWIGGY), pageResult(null), 'text');
    expect(unknown.finished).toBe(false);
    expect(unknown.note).toMatch(/does not yet show whether the user is signed in/);
    expect(unknown.note).toMatch(/Never guess, and never ask them to sign in unless the page shows that/);
  });

  it('a site that did not open is described as before (nothing is said about signing in)', () => {
    const r = describeDiscovery(plan(SWIGGY), { ok: false, summary: 'page did not open', error: 'x' }, 'text');
    expect(r.opened).toBe(false);
    expect(r.note).not.toMatch(/Sign-in:/);
  });
});

// ------------------------------------------------------------------------------------------------------------------ through the real engine, with a scripted model
const say = (text: string): AICompletion => ({ text, toolCalls: [] });

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
const ARGS = { url: { type: 'string' as const }, text: { type: 'string' as const }, query: { type: 'string' as const }, keywords: { type: 'string' as const }, name: { type: 'string' as const }, label: { type: 'string' as const } };
const tool = (name: string, ran: Array<{ name: string; args: ToolArgs }>, respond: (args: ToolArgs) => ToolResult = () => ({ ok: true, summary: `${name} done` })): Tool => ({
  schema: { name, description: name, args: ARGS, status: `${name}…` },
  execute: async (args): Promise<ToolResult> => (ran.push({ name, args }), respond(args)),
});

function engine(script: AICompletion[], open: ToolResult) {
  const ai = new Recording(script);
  const ran: Array<{ name: string; args: ToolArgs }> = [];
  const tools = new ToolRegistry();
  for (const n of ['web_search', 'open_website', 'click_on_page', 'inspect_page', 'read_page', 'fill_on_page', 'find_on_page', 'open_url', 'browser_status']) tools.register(tool(n, ran));
  tools.register(tool('find_and_open_website', ran, () => open));
  const e = new AgentEngine({ router: new IntentRouter(), tools, composer: new ResponseComposer(), tts: quietTTS, context: new ConversationContext(), ai, now: () => new Date('2026-11-06T10:00:00Z') });
  return { e, ai, ran };
}
const send = (e: AgentEngine, text: string, extra: Partial<AgentRequest> = {}): Promise<AgentResult> => e.handle({ requestId: `r${Math.random().toString(36).slice(2, 6)}`, text, source: 'text', mode: 'agent', ...extra }, () => undefined);
const lastUser = (ai: Recording, n: number): string => String(ai.sent[n]?.[(ai.sent[n]?.length ?? 1) - 1]?.content ?? '');

describe('the requests that went wrong, through the engine', () => {
  it('"open swiggi and login with phone number …" while Swiggy is already signed in: Eya opens it, sees it, and says so — the model is not even asked', async () => {
    const s = engine([], pageResult('yes'));
    const r = await send(s.e, SWIGGY);
    expect(s.ran.map((x) => x.name)).toEqual(['find_and_open_website']);
    expect(s.ran[0]?.args).toEqual({ url: 'https://www.swiggy.com/' });
    expect(s.ai.sent).toHaveLength(0);
    expect(r.spoken).toBe("You're already signed in on Swiggy, so there is nothing to log in to. What would you like me to do there?");
  });

  it('"login filpkart and order …" while Flipkart is signed in: the model is told they ARE signed in and to carry on with the order — and is never told to ask them to sign in', async () => {
    const s = engine([say('Flipkart is open and you are signed in. I will search for the POCO M6 Pro now.')], pageResult('likely', 'www.flipkart.com', 'Flipkart'));
    await send(s.e, FLIPKART);
    expect(s.ran[0]?.args).toEqual({ url: 'https://www.flipkart.com/' });
    expect(s.ai.sent).toHaveLength(1);
    const told = lastUser(s.ai, 0);
    expect(told).toContain(FLIPKART);
    expect(told).toMatch(/very probably already signed in to Flipkart/);
    expect(told).toMatch(/do the whole job yourself/);
    expect(told).not.toMatch(/ready for you to sign in\b(?!")/);
  });

  it('Swiggy NOT signed in: the model is told so, with the number, and what to do with it — the page, not a guess', async () => {
    const s = engine([say('I typed your number and asked Swiggy for the code. Please tell me the code when it arrives.')], pageResult('no'));
    const r = await send(s.e, SWIGGY);
    expect(s.ai.sent).toHaveLength(1);
    const told = lastUser(s.ai, 0);
    expect(told).toMatch(/NOT signed in to Swiggy/);
    expect(told).toContain('6303345974');
    expect(told).toMatch(/never refuse it/);
    expect(r.spoken).toContain('code');
  });

  it('a model that refuses anyway ("I can\'t access Swiggi without your login credentials") is told what is true and asked again — the person never sees the false "no"', async () => {
    const s = engine(
      [say("I can't access Swiggi or any other website without your login credentials. If you need to access Swiggi, I suggest you log in to your account."), say('Swiggy is open. I entered your number; tell me the code when it comes.')],
      pageResult('no'),
    );
    const r = await send(s.e, SWIGGY);
    expect(s.ai.sent).toHaveLength(2);
    expect(lastUser(s.ai, 1)).toMatch(/^\(Eya\) What you just said is not right\. A request to log in is an ordinary request/);
    expect(r.spoken).toBe('Swiggy is open. I entered your number; tell me the code when it comes.');
    expect(r.spoken).not.toMatch(/credentials/);
  });

  it('a request that does not name one of these sites is left exactly as it was (and chat mode never opens anything)', async () => {
    const plain = engine([say('Opening Notepad.')], pageResult('yes'));
    await send(plain.e, 'open notepad');
    expect(plain.ran.map((x) => x.name)).not.toContain('find_and_open_website');
    const chat = engine([say('That is what Agent mode is for.')], pageResult('yes'));
    await send(chat.e, SWIGGY, { mode: 'chat' });
    expect(chat.ran.map((x) => x.name)).not.toContain('find_and_open_website');
  });
});

describe('a plain "open <site>" is answered by Eya herself, saying what she found', () => {
  it('only when nothing but "open <site>" was said', () => {
    for (const text of ['open swiggy', 'Eya, please open the flipkart site in chrome', 'could you open Zomato for me', 'go to amazon now']) expect(planAccountSite(text)?.bare, text).toBe(true);
    for (const text of ['open flipkart and show my orders', 'open swiggy and order biryani', 'login to swiggy', 'open amazon and search for phones']) expect(planAccountSite(text)?.bare, text).toBeUndefined();
  });

  it('with the sign-in state: signed in, signed out, or not known yet — and no model call', () => {
    const plan = accountDiscoveryPlan('open swiggy') as NonNullable<ReturnType<typeof accountDiscoveryPlan>>;
    expect(describeDiscovery(plan, pageResult('yes'), 't').line).toBe("I opened Swiggy, and you're signed in.");
    expect(describeDiscovery(plan, pageResult('likely'), 't').line).toBe("I opened Swiggy, and you're signed in.");
    expect(describeDiscovery(plan, pageResult('no'), 't').line).toBe("I opened Swiggy. It shows a sign-in page; tell me if you'd like me to log in.");
    expect(describeDiscovery(plan, pageResult(null), 't').line).toBe('I opened Swiggy.');
    for (const sign of ['yes', 'no', null] as const) expect(describeDiscovery(plan, pageResult(sign), 't').finished).toBe(true);
  });

  it('through the engine: "open swiggy" opens it and answers without asking the model', async () => {
    const s = engine([], pageResult('yes'));
    const r = await send(s.e, 'open swiggy');
    expect(s.ai.sent).toHaveLength(0);
    expect(r.spoken).toBe("I opened Swiggy, and you're signed in.");
  });
});
