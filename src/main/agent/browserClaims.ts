/**
 * A model that has the user's browser in its hands sometimes says it has not: "I can't interact with your browser", "I'm unable to open websites",
 * "please share your screen so I can see the page". That is not a fact about Eya, it is a guess, and it sends the user to do by hand what Eya was asked to
 * do (and to turn on screen sharing, which a web page never needs: the page is read through the extension). This recognises that kind of answer, so the
 * engine can answer it with what is true instead of passing it on.
 *
 * It looks for a claim about a BROWSER or a WEB PAGE, or a request to share the screen / send a screenshot of one. A request that really is about the
 * screen ("what is on my screen?") is not this: the engine does not apply it to those (see `aboutTheScreen`).
 */

const SHARE_SCREEN = /\b(?:shar(?:e|ing) (?:with me )?(?:your |the |this |that )?(?:screen|window|tab|browser|display|page)|screen[- ]?shar(?:e|ing)|send (?:me )?(?:a |the |an )?(?:screenshot|screen ?shot|picture of (?:the|your) (?:screen|page))|take a screenshot (?:and|so)|show me (?:the |your )?(?:screen|page))\b/i;

const CANT = String.raw`(?:i\s+(?:can'?t|cannot|can not|am not able to|am unable to|'m not able to|'m unable to|don'?t have (?:the )?(?:ability|access|permission) to|do not have (?:the )?(?:ability|access|permission) to)|unable to|not able to)`;
const VERB = String.raw`(?:interact(?:ing)? with|control(?:ling)?|use|using|access(?:ing)?|operate|operating|browse|browsing|open(?:ing)?|navigate|navigating|click(?:ing)?(?: on)?|see|view|read|reach|work in|work with)`;
const THING = String.raw`(?:your |the |a |any |that |this )?(?:web ?browser|browser|web ?sites?|web ?pages?|pages?|tabs?|chrome|edge|internet|links?|buttons?)`;
const CANT_USE_BROWSER = new RegExp(String.raw`\b${CANT}\s+${VERB}\s+${THING}\b`, 'i');
const NO_BROWSER_TOOLS = /\b(?:i (?:don'?t|do not) have (?:a |any |the )?(?:browser|browsing|web)(?: tool| access| ability| capabilit)|(?:as an? (?:ai|language model|text[- ]based)[^.]{0,80})?(?:can'?t|cannot|unable to) (?:browse|interact with (?:the )?(?:web|websites|internet)))/i;

/** Does this answer say Eya cannot work in the browser, or ask the user to share the screen (or send a picture) for a web page? */
export function claimsNoBrowserAccess(answer: string): boolean {
  const text = answer.replace(/\s+/g, ' ').trim();
  if (text === '') return false;
  return SHARE_SCREEN.test(text) || CANT_USE_BROWSER.test(text) || NO_BROWSER_TOOLS.test(text);
}

/** A request that is itself about the screen: sharing it, looking at it, a screenshot. A model asking for screen sharing there is not mistaken. */
export function aboutTheScreen(request: string): boolean {
  return /\b(screen|screenshot|screen ?shot|what('?s| is) (on|in) (my |the )?(window|monitor|desktop)|look at (my|this) (desktop|window)|share my)\b/i.test(request);
}

/** What the model is told when it claimed it cannot work in the browser while it can: what is true, and to go on. Said once, never as the answer. */
export function browserAccessNudge(offered: readonly string[]): string {
  const tools = ['open_website', 'inspect_page', 'find_on_page', 'click_on_page', 'fill_on_page', 'read_page'].filter((n) => offered.includes(n));
  return (
    `(Eya) What you just said is not right. You DO have the user's own browser: ${tools.length > 0 ? tools.join(', ') : 'the browser tools'} work in it directly, they are already allowed, ` +
    'and a web page never needs the screen shared or a screenshot (you read the page itself, and every result shows the page as it is now). Do not ask the user to share their screen or to do it themselves. ' +
    'Do what they asked with those tools now. If a tool fails, tell them exactly what it reported.'
  );
}

// ------------------------------------------------------------------------------------------------------------------------------ "I need your login credentials"
// 6 Nov 2026: "open swiggi and login with phone number …" was answered "I can't access Swiggi or any other website without your login credentials" — a guess too: logging in is an
// ordinary request (the page shows whether the person is already signed in; a phone number or email they gave is typed into the page's box; a password is theirs), and the browser
// they use keeps their sign-ins.
const CANT_WITHOUT_CREDENTIALS = new RegExp(String.raw`\b${CANT}\s+(?:log ?in|sign ?in|login|access|open|use|go to|visit|enter|continue|proceed|do that|help)\b[^.!?]{0,90}?\b(?:without|unless|until|before)\b[^.!?]{0,60}\b(?:credentials|log ?in|login|password|username|account|sign ?in|sign ?up)\b`, 'i');
const CANT_LOG_IN = new RegExp(String.raw`\b${CANT}\s+(?:log ?in|sign ?in|login)\b`, 'i');
const NEED_CREDENTIALS = /\b(?:you(?:'ll| will)? (?:need|have) to (?:log ?in|sign ?in)|please (?:log ?in|sign ?in) (?:first|yourself|manually)|(?:i )?need(?:s)? your (?:login|log-?in|credentials|password|account details))\b/i;

/** Does this answer refuse a log-in, or say the person's credentials are needed first? */
export function claimsNoLogin(answer: string): boolean {
  const text = answer.replace(/\s+/g, ' ').trim();
  return text !== '' && (CANT_WITHOUT_CREDENTIALS.test(text) || CANT_LOG_IN.test(text) || NEED_CREDENTIALS.test(text));
}

/** The request asks to log in (or sign in) to something. */
export function asksToLogIn(request: string): boolean {
  return /\b(?:log ?in|login|sign ?in)\b/i.test(request);
}

/** What the model is told when it refused a log-in, or asked for credentials first. Said once, never as the answer. */
export function loginNudge(): string {
  return (
    "(Eya) What you just said is not right. A request to log in is an ordinary request: you are not refused anything, and you do not need their credentials first. Open the site with the tools; " +
    'the page shows whether the user is ALREADY signed in (signedIn in its result): if it does, say so and carry on with what they asked, in their account. If they are not, and they gave a phone number or an ' +
    "email, type exactly that into the page's box with fill_on_page (it is not a password), press the page's own Continue / Request OTP / Login button with click_on_page, then ask them for the one-time code " +
    'and type it when they say it; a password is always theirs to type. Do it now.'
  );
}
