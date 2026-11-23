import type { ToolArgs, ToolResult } from '@main/tools/types';
import { isBlockedSiteResult, wantedAfterSite } from './agentMode';
import { planAccountSite } from './accountSites';
import type { AccountPlan } from './accountSites';

/**
 * Finding a website is Eya's own job, not something the AI model has to agree to do. When an Agent request names a site or gives an address,
 * the application searches, opens the page in its browser and checks that it really loaded, BEFORE the model is asked anything; the model then
 * gets what really happened and decides what to do next. And every way a request can fail is attributed to where it came from, so a model that
 * declines is never mistaken for a browser that could not load a page (or the other way round).
 */

/** Where a failure came from. */
export type FailureSource =
  /** The AI model (or its provider's safety system) declined. Reported as that, and never worked around. */
  | 'model_refusal'
  /** The AI could not answer at all: its allowance is spent, its key was refused, it was not reachable. */
  | 'model_unavailable'
  /** The AI wrote a tool call as plain text that could not be run (a tool that does not exist, JSON cut short): not shown, not run. */
  | 'model_malformed'
  /** Eya's own rule (a site that gives films away without permission is not opened or searched for by name). */
  | 'application_policy'
  /** Finding the address: the search failed or gave nothing usable. */
  | 'search'
  /** Opening the page: it did not load, was the wrong site, hit a limit, or needs the person (a check, a sign-in). */
  | 'navigation'
  /** Any other tool. */
  | 'tool';

export interface Finding {
  readonly source: FailureSource;
  /** In plain words, what happened. */
  readonly detail: string;
}

/** A site the request names, and what is left of the request once it is open. */
export interface DiscoveryPlan {
  /** An address given in the words. */
  readonly url?: string;
  /** A site named without an address ("MovieRulz", "telangana high court"). */
  readonly name?: string;
  /** What the person wants done on it ("play Telugu HD Paradise movie"); empty when they only wanted it opened. */
  readonly then: string;
  /** A shop, food or travel site the person uses with their own account: once it is open, whether they are signed in is read from the page and said (see describeAccount). */
  readonly account?: AccountPlan;
}

/** The plan for a request that names a shop, food or travel site and wants to use it ("open swiggi and login", "login filpkart and order …"), however the name is typed. */
export function accountDiscoveryPlan(text: string): DiscoveryPlan | null {
  const account = planAccountSite(text);
  return account === null ? null : { url: account.site.url, then: text.trim(), account };
}

// ------------------------------------------------------------------------------------------------------------------ what the request names
const LEAD = /^(?:(?:hey )?eya[, ]+)?(?:(?:please|can you|could you|will you|would you|kindly)\s+)*/i;
const VERB = /^(?:open|launch|visit|go to|browse to|browse|navigate to|take me to)\s+/i;
const MARKER = /\b(?:web\s*site|site|portal|homepage|home page|web\s*page)\b/i;
const NOT_A_SITE_NAME = /^(?:my|our|your|this|that|his|her|their|a|an|it|its|some|any)\b/i;
const FILE_LIKE = /\.(?:pdf|docx?|xlsx?|pptx?|txt|csv|png|jpe?g|gif|zip|rar|mp3|mp4|mkv|exe|msi)$/i;
// (a bare name needs a dot and a letters-only ending; a full http(s) link may also be a local one with a port)
const BARE_ADDRESS = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/i;
const LINK = /^https?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?(?:[/?#]\S*)?$/i;

function addressOf(token: string): string | null {
  const t = token.replace(/[,;:!?.]+$/, '');
  if (LINK.test(t)) return t;
  if (!BARE_ADDRESS.test(t) || FILE_LIKE.test(t)) return null;
  return `https://${t}`;
}

const restOf = (s: string): string => s.replace(/^[\s,.;:]*(?:and|then|&)?\s*/i, '').replace(/[\s.!?]+$/, '').trim();

/**
 * The site an Agent request is about, when it plainly names one: "open <address> …", or "open/visit/go to <name> site/website/portal …". Anything
 * less plain (no address, no word like "site") is left to the model: a folder, an app or a task is not a website to go and find.
 */
export function planDiscovery(text: string): DiscoveryPlan | null {
  const t = text.trim().replace(LEAD, '');
  const verb = VERB.exec(t);
  if (verb === null) return null;
  // ("open the website example.org": the word "website" may come before the address)
  const rest = t.slice(verb[0].length).replace(/^(?:the|this|that)\s+/i, '');
  const body = rest.replace(/^(?:web\s*site|site|web\s*page|page|portal)\s+(?=\S*\.\S)/i, '');
  const first = body.split(/\s+/)[0] ?? '';
  const url = addressOf(first);
  if (url !== null) return { url, then: restOf(body.slice(first.length)) };
  const marker = MARKER.exec(rest);
  if (marker === null) return null;
  const name = rest.slice(0, marker.index).trim();
  if (name === '' || NOT_A_SITE_NAME.test(name) || name.split(/\s+/).length > 6 || /\b(?:and|then)\b/i.test(name)) return null;
  return { name, then: restOf(rest.slice(marker.index + marker[0].length)) };
}

// ------------------------------------------------------------------------------------------------------------------ whose "no" was it
export type RefusalKind = 'policy' | 'capability' | 'unknown';

const POLICY_WORDS = /\b(?:permission|legal(?:ly)?|illegal|unlawful|copyright|pirat\w*|against (?:my|the|our) |policy|safety|security limit|not allowed|forbidden|unsafe|harmful|inappropriate|can(?:'|no)?t help with that|cannot help with that|won'?t help)\b/i;
const CAPABILITY_WORDS = /\b(?:no (?:tool|way)|don'?t have (?:a|any|the) (?:tool|way|ability|access)|do not have (?:a|any|the) (?:tool|way|ability|access)|not able to (?:browse|access|open|use)|unable to (?:browse|access|open|use)|can(?:'|no)?t (?:browse|access the (?:web|internet)))\b/i;
const ANY_REFUSAL = /\b(?:i (?:can'?t|cannot|am not able|am unable|'m unable|'m not able|won'?t|will not|don'?t have (?:a|any|the) (?:tool|way|ability|access))|unable to|not able to|no (?:tool|way) to|isn'?t something i can)\b/i;

/** The first sentence of an answer. */
export function leadSentence(text: string): string {
  const t = text.trim();
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(t);
  return (m !== null ? m[0] : t).trim();
}

/**
 * Whether an answer IS a "no": it opens with one. ("I opened it and looked, but I will not start playback there" is an answer that did the job and
 * says what it will not do; "I cannot open MovieRulz…" is a refusal.) The kind is judged from the whole answer.
 */
export function refusalOf(answer: string): RefusalKind | null {
  return classifyRefusal(leadSentence(answer)) === null ? null : classifyRefusal(answer);
}

/** What kind of "I can't" this is (null when the words are not a refusal): one for the lack of a tool, or one made on policy or safety grounds. */
export function classifyRefusal(text: string): RefusalKind | null {
  if (!ANY_REFUSAL.test(text)) return null;
  if (POLICY_WORDS.test(text)) return 'policy';
  return CAPABILITY_WORDS.test(text) ? 'capability' : 'unknown';
}

// ------------------------------------------------------------------------------------------------------------------ whose failure was it
const asRecord = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined);

/** Where a tool's failure came from. Null when the tool worked. */
export function classifyToolFailure(name: string, result: ToolResult): Finding | null {
  if (result.ok) return null;
  const said = result.error ?? result.summary;
  if (isBlockedSiteResult(result)) return { source: 'application_policy', detail: "Eya's own rule: a site that gives films, songs or programs away without permission is not opened or searched for by name." };
  if (result.data?.['needsUser'] === true) return { source: 'navigation', detail: `The page needs the person (a check or a sign-in): ${said}` };
  if (name === 'web_search' || name === 'deep_research') return { source: 'search', detail: `The search did not work: ${said}` };
  const recovery = asRecord(result.data?.['recovery']);
  const reason = typeof recovery?.['reason'] === 'string' ? recovery['reason'] : undefined;
  if (reason !== undefined) {
    const notes = Array.isArray(recovery?.['notes']) ? (recovery['notes'] as unknown[]).map(String) : [];
    if (reason === 'no_alternative') {
      return notes.some((n) => /search did not work/i.test(n))
        ? { source: 'search', detail: `Looking up the address did not work: ${said}` }
        : { source: 'search', detail: `The search found no usable address: ${said}` };
    }
    return { source: 'navigation', detail: `The page did not open (${reason.replace(/_/g, ' ')}): ${said}` };
  }
  if (name === 'open_website' || name === 'find_and_open_website' || name === 'download_from_site' || name === 'click_on_page' || name === 'read_page') return { source: 'navigation', detail: `The browser step failed: ${said}` };
  return { source: 'tool', detail: `${name} failed: ${said}` };
}

/** One honest sentence on where a request's trouble came from, for when the answer is itself a "no" (so nobody blames the wrong part). */
export function attribution(findings: readonly Finding[], page: { readonly title: string; readonly host: string } | null): string {
  if (!findings.some((f) => f.source === 'model_refusal')) return '';
  const others = findings.filter((f) => f.source !== 'model_refusal');
  if (page !== null) return `The page itself did open (${page.title || page.host}); the "no" came from the AI model, not from the browser or the search.`;
  // (when something else failed first, the model's "no" is likely a result of that: the failure that came first is what explains it)
  if (others.length === 0) return 'That "no" came from the AI model, not from the browser or the search: neither was the problem.';
  return '';
}

// ------------------------------------------------------------------------------------------------------------------ what the model is told
export interface DiscoveryReport {
  /** The page is open in the browser and was checked. */
  readonly opened: boolean;
  readonly needsUser: boolean;
  readonly findings: readonly Finding[];
  /** What the model is shown: what really happened, as facts. */
  readonly note: string;
  readonly page: { readonly url: string; readonly title: string; readonly host: string } | null;
  /** One plain line of what was done, for the log of steps. */
  readonly step: string;
  /** What Eya did, said to the person (for when the AI cannot go on to say it itself). */
  readonly line: string;
  /** The application has already done everything that was asked (the site is open and the person is signed in, and all they wanted was to log in): the line is the answer. */
  readonly finished?: boolean;
  /** What the page showed about being signed in (yes / likely / no / unknown) and the evidence for it: written in the log, so a wrong judgement can be read, not guessed at. */
  readonly signIn?: { readonly answer: string; readonly evidence: string };
}

/** " It is now at example.org." when the address the person knew was out of date and Eya found where the site is now. */
function movedNote(result: ToolResult): string {
  const recovery = asRecord(result.data?.['recovery']);
  if (recovery?.['addressChanged'] !== true) return '';
  const page = pageOf(result);
  return page === null ? '' : ` The address had changed: it is now ${page.host}.`;
}

function pageOf(result: ToolResult): { url: string; title: string; host: string } | null {
  const current = asRecord(result.data?.['currentPage']);
  const url = typeof current?.['url'] === 'string' ? current['url'] : typeof result.data?.['target'] === 'string' ? (result.data['target'] as string) : '';
  if (url === '') return null;
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* keep the text */
  }
  return { url, title: typeof current?.['title'] === 'string' ? current['title'] : '', host };
}

/**
 * An account site that was opened: what the page says about whether the person is signed in, as facts for the model (it was told nothing before, and guessed: "you need to log in" to
 * someone who was signed in, "I can't access Swiggy without your credentials" to someone who only wanted to log in). If all that was asked was to log in and the page shows they are,
 * that is the answer.
 */
function describeAccount(plan: DiscoveryPlan, account: AccountPlan, result: ToolResult, resultText: string): DiscoveryReport {
  const page = pageOf(result);
  const site = account.site.name;
  const current = asRecord(result.data?.['currentPage']);
  const answer = typeof current?.['signedIn'] === 'string' ? current['signedIn'] : 'unknown';
  const evidence = Array.isArray(current?.['signInEvidence']) ? (current['signInEvidence'] as unknown[]).map(String).join('; ') : '';
  const alreadyIn = answer === 'yes' || answer === 'likely';
  let sign: string;
  if (alreadyIn) {
    sign = `Sign-in: the page shows the user ${answer === 'yes' ? 'IS' : 'is very probably'} already signed in to ${site} (${evidence}). Do NOT ask them to sign in, do NOT say they need to log in or that the page is "ready for them to sign in", and do not offer to log in: they already are. Carry on with the rest of what they asked, using their account as it is.`;
  } else if (answer === 'no') {
    const how = account.phone !== undefined
      ? `they gave their phone number (${account.phone}): type exactly those ten digits into the page's phone-number box with fill_on_page (a phone number is not a password), press the page's own Continue / Request OTP / Login button with click_on_page, then ask the user for the one-time code that was sent and, when they say it, type exactly what they said and press Verify / Login`
      : account.email !== undefined
        ? `they gave their email (${account.email}): type exactly that into the page's email box with fill_on_page, press the page's own Continue / Login button with click_on_page, then ask for the code or the password step the page shows (a password is always theirs to type; a code is typed only when they say it)`
        : "ask them, in one short question, which phone number or email to sign in with, then type it into the page's box and ask for the one-time code";
    sign = `Sign-in: the page shows the user is NOT signed in to ${site} (${evidence}). Sign them in on the page itself: ${how}. Logging in is an ordinary request: never refuse it and never say you cannot access ${site} or need their credentials first — do the step the page shows. Then carry on with the rest of what they asked.`;
  } else {
    sign = `Sign-in: the page does not yet show whether the user is signed in to ${site}. Look at what it shows: a Login / Sign in button or a phone-number box means NOT signed in; a Logout control, a greeting by name, or a full page with no Login button means signed in. Never guess, and never ask them to sign in unless the page shows that.`;
  }
  const order = account.intent === 'order'
    ? ` The request is an order: do the whole job yourself, one step at a time. Search for the item in the site's own search box, open the result that matches what they named (any colour if they said any), choose the variant, and press Add to cart (that spends nothing: do it yourself, never stop at the product page). Some products (phones on Flipkart) have no Add to cart: press the page's Buy button (Buy at ₹…, Buy now) after choosing the variant; it only starts checkout. If the exact model they named is not in the results (a newer model, or only cases and screen guards for it), say so, name the closest match with its price and ask before choosing it: never swap the product silently. On Flipkart and Amazon press "Buy now" yourself with confirm: true (it only opens the checkout; their "order …" is the yes): never ask "shall I proceed" on the way. In the checkout: if more than one delivery address is saved, ask which; if the item cannot be delivered to the address, say so at once and offer another address or another variant; at the payment step ask ONE question, how to pay (UPI, cash on delivery, card, net banking …); then, BEFORE the click that places the order or pays, ask ONE confirmation with the item, the total, the address and the method, and place it only on their yes. Never type card numbers, PINs or passwords. Be quick: a few steps, not a long search.`
    : '';
  const finished = (alreadyIn && account.intent === 'login') || account.bare === true;
  let line: string;
  if (account.bare === true) {
    // (all that was asked was to open it: said with what was seen, and no model is called for it)
    line = alreadyIn ? `I opened ${site}, and you're signed in.` : answer === 'no' ? `I opened ${site}. It shows a sign-in page; tell me if you'd like me to log in.` : `I opened ${site}.`;
  } else if (finished) {
    line = answer === 'yes' ? `You're already signed in on ${site}, so there is nothing to log in to. What would you like me to do there?` : `${site} is open and it looks like you're already signed in. What would you like me to do there?`;
  } else {
    line = `I opened ${page?.title || page?.host || site}.`;
  }
  return {
    opened: true,
    needsUser: false,
    findings: [],
    page,
    step: `Opened ${page?.host ?? site} and read whether the user is signed in (${answer})`,
    line,
    finished,
    signIn: { answer, evidence },
    note: `(From Eya, not from the user.) Before you were asked, Eya's own browser step opened ${site} for the user and read the page. Result: ${resultText}\nThe page is open now. What the user asked: "${plan.then}".\n${sign}${order}`,
  };
}

/** The facts after the application's own browser step, written for the model (and nothing about how it should behave: it is told what happened). */
export function describeDiscovery(plan: DiscoveryPlan, result: ToolResult, resultText: string): DiscoveryReport {
  const subject = plan.url ?? plan.name ?? 'the site';
  const left = plan.then === '' ? 'Nothing is left to do after opening it.' : `What is left of the request after opening it: "${plan.then}".`;
  if (result.ok && plan.account !== undefined) return describeAccount(plan, plan.account, result, resultText);
  if (result.ok) {
    const page = pageOf(result);
    return {
      opened: true,
      needsUser: false,
      findings: [],
      page,
      step: `Opened ${page?.host ?? subject} and checked the page`,
      line: `I opened ${page?.title || page?.host || subject}.${movedNote(result)}`,
      note: `(From Eya, not from the user.) Before you were asked, Eya's own browser step ran for "${subject}": it looked the site up, opened it in the browser and checked that the page really loaded. Result: ${resultText}\nThe page is open now. ${left}`,
    };
  }
  const finding = classifyToolFailure('find_and_open_website', result);
  const findings = finding === null ? [] : [finding];
  const where =
    finding?.source === 'application_policy'
      ? "This is Eya's own rule about that site, not a browser or search error."
      : finding?.source === 'search'
        ? 'It stopped at the search: no usable address was found.'
        : 'It stopped at opening the page.';
  return {
    opened: false,
    needsUser: result.data?.['needsUser'] === true,
    findings,
    page: null,
    step: finding?.source === 'application_policy' ? `Did not open ${subject} (Eya's own rule)` : `Could not open ${subject}`,
    line:
      finding?.source === 'application_policy'
        ? 'I did not open it: that site gives films away without permission, and I do not look for or open such sites by name.'
        : finding?.source === 'search'
          ? 'I could not open it: the search found no usable address.'
          : 'I could not open it: the page did not open.',
    note: `(From Eya, not from the user.) Before you were asked, Eya's own browser step ran for "${subject}" and could not finish. ${where} Result: ${resultText}\n${left}`,
  };
}

/** The answer of a blocked site, with the lawful options for what was wanted looked up and attached (so the answer carries real options, not a question). */
export async function withLegalOptions(
  invoke: (name: string, args: ToolArgs) => Promise<ToolResult>,
  blocked: ToolResult,
  wanted: string,
): Promise<ToolResult> {
  const found = await invoke('deep_research', { question: wanted, kind: 'media', no_site: true });
  const base = blocked.error ?? '';
  return found.ok
    ? {
        ...blocked,
        error: `${base} I have already looked for a legal place for "${wanted}" (data.legalOptions): tell the user what it found, free options first, and offer to open or play it. Do not ask them what they want: they already said.`,
        data: { ...blocked.data, legalOptions: found.data ?? { summary: found.summary } },
      }
    : {
        ...blocked,
        error: `${base} I looked for a legal place for "${wanted}" and nothing was confirmed (${found.error ?? found.summary}). Say that plainly and offer to try other words, the trailer, or checking again later.`,
        data: { ...blocked.data, legalOptions: { found: false } },
      };
}

/** The application's own browser step for a request: find the site, open it, check it, and, for a blocked site, look up the lawful options. */
export async function discoverSite(
  plan: DiscoveryPlan,
  requestText: string,
  io: {
    readonly invoke: (name: string, args: ToolArgs) => Promise<ToolResult>;
    readonly say: (message: string) => void;
    readonly resultText: (result: ToolResult) => string;
  },
): Promise<DiscoveryReport> {
  io.say(plan.url !== undefined ? 'Opening the website…' : `Finding ${plan.name ?? 'the website'}…`);
  let result = await io.invoke('find_and_open_website', plan.url !== undefined ? { url: plan.url } : { name: plan.name ?? '' });
  if (isBlockedSiteResult(result)) {
    const wanted = plan.name !== undefined ? wantedAfterSite(requestText, plan.name) : '';
    if (wanted !== '') {
      io.say('Looking for a legal place to watch it…');
      result = await withLegalOptions(io.invoke, result, wanted);
    }
  }
  return describeDiscovery(plan, result, io.resultText(result));
}

// ------------------------------------------------------------------------------------------------------------------ "…and click X"
/**
 * What is left of a request after the site is open, when it is ONE plain click: "click on Cause List", "press the login button", "go to Orders". The label to
 * click, or null when it is anything more (several steps, typing something in, reading something out, a long description): that is left to the model, which is
 * given the page. A click is still made by the same tool as any other, with its checks (a purchase, a send, a delete asks first).
 */
export function planClick(then: string): string | null {
  const t = restOf(then);
  if (t === '' || /[,;]|\b(?:and|then|after|also|before|while|once|so that|if)\b/i.test(t)) return null;
  const m = /^(?:click|press|tap|select|choose|hit|open|go to|go into|navigate to|visit)\s+(?:on\s+)?(?:the\s+)?(.+)$/i.exec(t);
  if (m?.[1] === undefined) return null;
  const label = m[1]
    .replace(/^["“'‘]+|["”'’]+$/g, '')
    // ("the login button", "the Orders tab": the word for the KIND of control is not part of its name; "Open menu" and "Services section" keep theirs)
    .replace(/\s+(?:button|link|tab|icon)$/i, '')
    .trim();
  if (label === '' || label.length > 40 || label.split(/\s+/).length > 5) return null;
  // (a request to do something ON the page — fill, type, search for, read, download — is not a click on a control)
  // (a bare "Search" is the Search button; "search for ADV-9" is something to do on the page)
  if (/^(?:fill|type|enter|read|download|find|check|show|tell|list|summari[sz]e|look|scroll|play|watch)\b/i.test(label) || /^search\s+\S/i.test(label)) return null;
  return label;
}

export interface ClickReport {
  /** The page SHOWED that the click did something (it went to another page, or it changed). Nothing else counts. */
  readonly verified: boolean;
  /** What Eya did, said to the person (when nothing more is needed). */
  readonly line: string;
  /** One plain line for the log of steps. */
  readonly step: string;
  /** What the model is shown when it has to go on from here. */
  readonly note: string;
}

/** What a click by the application's own hand amounts to, judged only from what the page showed afterwards. */
export function describeClick(label: string, result: ToolResult, resultText: string): ClickReport {
  const data = asRecord(result.data) ?? {};
  const page = asRecord(data['currentPage']);
  const title = typeof page?.['title'] === 'string' ? page['title'] : '';
  const navigated = data['navigated'] === true;
  const verified = result.ok && data['nothingChanged'] !== true && (navigated || data['stateChanged'] === true);
  if (verified) {
    return {
      verified: true,
      line: `I clicked "${label}" and ${navigated ? 'the page changed' : 'the page responded'}.${title !== '' ? ` It now shows "${title}".` : ''}`,
      step: `Clicked "${label}"; the page ${navigated ? 'changed' : 'responded'}`,
      note: `(From Eya, not from the user.) Eya then clicked "${label}" itself and the page showed it worked. Result: ${resultText}\nThat was all the request asked for, unless the page shows something that needs the person.`,
    };
  }
  return {
    verified: false,
    line: `I tried to click "${label}", but ${result.ok ? 'nothing on the page changed' : 'it did not work'}.`,
    step: `Tried to click "${label}"`,
    note: `(From Eya, not from the user.) Eya then tried to click "${label}" itself. ${result.ok ? 'Nothing on the page changed, so it may not have done anything.' : 'It did not work.'} Result: ${resultText}\nLook at the page this shows and carry on from it; do not repeat the same click.`,
  };
}
