import type { ChallengeKind } from './pageSnapshot';

/**
 * A CAPTCHA, a bot check or a verification-code prompt is a site asking for a
 * human. Eya stops and says so; she never tries to get past one, and never
 * types a code. A plain sign-in page is reported but is not a wall by itself.
 */
export function isBlockingChallenge(kind: ChallengeKind): boolean {
  return kind !== 'login';
}

const MESSAGES: Record<ChallengeKind, string> = {
  captcha:
    'This page is showing a CAPTCHA. I will not try to get past it — please complete it yourself in your browser, then tell me and I will carry on.',
  bot_check:
    'This site is checking that a real person is visiting. I will not try to get past that — please complete it in your browser, then tell me and I will carry on.',
  mfa: 'This page is asking for a verification code. I never enter those — please enter it yourself in your browser, then tell me and I will carry on.',
  login: 'This page is asking you to sign in. Please sign in yourself in your browser, then tell me and I will carry on.',
};

export function challengeMessage(kind: ChallengeKind): string {
  return MESSAGES[kind];
}
