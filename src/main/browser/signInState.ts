import type { PageSnapshot } from './pageSnapshot';

/**
 * Is the person signed in on this page? Worked out from what the page shows, so that Eya never has to guess — and never tells someone to sign in to a site they are already
 * signed in to (6 Nov 2026: Flipkart and Swiggy were both signed in in the person's own Chrome, and Eya said "the page is ready for you to sign in" and "I can't access Swiggy without
 * your login credentials"). The only sign-in check there was before looked for a visible PASSWORD box, and these sites sign in by phone number and one-time code: no password
 * box, so nothing was ever reported, in either direction.
 *
 *  - 'yes'      a control that signs OUT is on the page (Logout / Sign out), or its menu holds one.
 *  - 'no'       a control that signs IN is in the header (Login, Sign in, "Hello, sign in"), or a sign-in form is open (a phone or email box with a Login / Request OTP button), or a
 *               password box or a verification-code step of a sign-in is showing.
 *  - 'likely'   nothing says "not signed in", and something says signed in: a greeting by name ("Hello, Rakesh"), or — on a shop, food or travel site that always shows a Login
 *               button when signed out — a page with its whole header and no such button.
 *  - 'unknown'  anything else (a page that has nothing to do with accounts, or one still loading).
 * An account menu's other items (My Profile, Orders, Wishlist) prove nothing: Flipkart lists them under its Login button even when nobody is signed in.
 */
export type SignInAnswer = 'yes' | 'likely' | 'no' | 'unknown';

export interface SignIn {
  readonly answer: SignInAnswer;
  /** Short, plain words for what the page showed (never the person's own name or number). */
  readonly evidence: readonly string[];
}

/** A control's own words: the item it belongs to ("ADD — Paneer Tikka") is not part of its name. */
const own = (s: string): string => (s.split(' — ')[0] ?? s).toLowerCase().replace(/\s+/g, ' ').trim();

const LOGIN_CONTROL = /^(?:log ?in|login|sign ?in|signin|(?:log ?in|login|sign ?in) ?(?:\/|or|&|and) ?(?:sign ?up|signup|register|create (?:an )?account)|sign ?in to (?:your account|continue)|log ?in to (?:your account|continue)|login to continue)$/;
const HELLO_SIGN_IN = /^hello,? sign ?in\b/;
const LOGOUT_CONTROL = /^(?:log ?out|logout|sign ?out|signout|log ?off)$/;
/** "Hello, Rakesh", "Hi Rakesh", "Welcome, Rakesh": a greeting by name in the header. (Not "Hello, sign in", "Hi there", "Welcome back".) */
const GREETING = /^(?:hi|hello|welcome),? (?!sign|guest|there\b|back\b|user\b|customer\b|friend\b)[a-z][a-z .'-]{1,30}$/;
const PHONE_OR_EMAIL_BOX = /(?:e-?mail|mobile|phone|contact)\b/;
const LOGIN_BUTTON = /^(?:request otp|get otp|send otp|send code|continue|login|log ?in|sign ?in|verify|proceed)$/;
const SIGN_IN_WORDS = /\b(?:log ?in|sign ?in)\b/;

/** Shop, food, travel and payment sites that show a Login button in their header whenever nobody is signed in. */
const ACCOUNT_SITES = /(?:^|\.)(?:flipkart|amazon|swiggy|zomato|myntra|meesho|bigbasket|blinkit|zeptonow|bookmyshow|irctc|makemytrip|goibibo|redbus|nykaa|ajio|paytm)\.(?:com|in|co\.in|net)$/;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function signInState(s: Pick<PageSnapshot, 'url' | 'links' | 'buttons' | 'inputs' | 'headings' | 'dialogs'> & Partial<Pick<PageSnapshot, 'navigation' | 'collapsedMenus' | 'challenge'>>): SignIn {
  const menus = Object.values(s.collapsedMenus ?? {}).flat();
  const controls = [...s.links, ...s.buttons, ...(s.navigation ?? []), ...menus].map(own).filter((t) => t !== '');
  const evidence: string[] = [];

  // 1. A way OUT on the page: signed in, whatever else is shown.
  if (controls.some((t) => LOGOUT_CONTROL.test(t))) return { answer: 'yes', evidence: ['a Logout / Sign out control is on the page (in the account menu)'] };

  // 2. A way IN: signed out.
  const loginControl = controls.find((t) => LOGIN_CONTROL.test(t) || HELLO_SIGN_IN.test(t));
  if (loginControl !== undefined) evidence.push(`a "${loginControl.length > 30 ? 'Login' : loginControl}" control in the header`);
  if (s.challenge?.kind === 'login') evidence.push('a password box is showing');
  if (s.challenge?.kind === 'mfa') evidence.push('a verification-code step is showing');
  const asked = [...s.dialogs, ...s.headings].map((t) => t.toLowerCase());
  const mentionsSignIn = asked.some((t) => SIGN_IN_WORDS.test(t)) || /login|signin|sign-in|log-in/i.test(s.url);
  const hasPhoneOrEmailBox = s.inputs.some((i) => PHONE_OR_EMAIL_BOX.test(i.toLowerCase()));
  const hasLoginButton = controls.some((t) => LOGIN_BUTTON.test(t));
  if (hasPhoneOrEmailBox && hasLoginButton && mentionsSignIn) evidence.push('a sign-in form is open (a phone or email box with a Login / OTP button)');
  if (evidence.length > 0) return { answer: 'no', evidence: evidence.slice(0, 3) };

  // 3. Nothing says signed out. Something that says signed in:
  const greeting = controls.find((t) => GREETING.test(t));
  if (greeting !== undefined) return { answer: 'likely', evidence: ['a greeting by name in the header ("Hello, …")'] };
  // ...or a full page of a site that shows a Login button whenever nobody is signed in, with no such button.
  if (ACCOUNT_SITES.test(hostOf(s.url)) && controls.length >= 8 && s.challenge === undefined) {
    return { answer: 'likely', evidence: ['the page is fully shown and has no Login button (this site shows one when nobody is signed in)'] };
  }
  return { answer: 'unknown', evidence: [] };
}

/** What the model is shown with every page: nothing when nothing is known. */
export function signInFields(s: Parameters<typeof signInState>[0]): Record<string, unknown> {
  const r = signInState(s);
  return r.answer === 'unknown' ? {} : { signedIn: r.answer, signInEvidence: r.evidence };
}
