import type { ChallengeKind } from './pageSnapshot';

/**
 * A CAPTCHA or a bot check is a site asking for a human: Eya stops and says so, and never tries to get past one. A verification-code
 * prompt (an SMS or authenticator code) is reported and the task is kept, but it is not a wall: the person can say the code out loud and
 * Eya types it (only into a one-time-code field, and only a code they said; never a password or a card number). A plain sign-in page is
 * reported but is not a wall either.
 *
 * What she does not do is forget the task or make the person say "continue": the request is kept as waiting for them, she watches the
 * page, and she carries on by herself the moment they have done it (see TaskCompleter).
 */
export function isBlockingChallenge(kind: ChallengeKind): boolean {
  return kind === 'captcha' || kind === 'bot_check';
}

const MESSAGES: Record<ChallengeKind, string> = {
  captcha:
    'This page is showing a CAPTCHA. I will not try to get past it — please complete it yourself in your browser, and I will carry on by myself the moment you have.',
  bot_check:
    'This site is checking that a real person is visiting. I will not try to get past that — please complete it in your browser, and I will carry on by myself the moment you have.',
  mfa: 'This page is asking for a verification code. Ask the user to tell you the code (it was sent to their phone or email, or their authenticator shows it): when they say it, type exactly that into the code field with fill_on_page and press the page\'s own Verify / Continue / Login button, then carry on with what they originally asked. They can also type it in their browser themselves, and Eya carries on by herself when they have.',
  login: 'This page is asking you to sign in. Please sign in yourself in your browser, and I will carry on by myself the moment you have.',
  payment:
    'This is the payment step. Card details, a UPI PIN or approval, and bank passwords are the user\'s: never type or read them. Tell the user in a few words that the payment is theirs to do in their browser, then call wait_for_user_in_browser. When it says they finished, look at the confirmation page and tell them the order or booking number and total. If a one-time code is sent to their phone and they say it out loud, type it as you do any verification code.',
};

export function challengeMessage(kind: ChallengeKind): string {
  return MESSAGES[kind];
}
