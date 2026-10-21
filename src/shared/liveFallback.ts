import type { AiRouteStatus } from './aiRoute';

/**
 * When Gemini's live voice stops (its limit, a dropped connection) or cannot start, the conversation does not end: Eya carries on in the
 * other way of talking, with the same chat (your voice heard on this PC, the next AI that can answer, an AI voice) and says so in a few
 * human words. Pure, so the decision and the words can be tested.
 */
export type LiveStop = 'user' | 'idle' | 'closed' | 'error' | 'start-failed';

export function shouldCarryOn(input: { readonly stop: LiveStop; readonly voiceOn: boolean; readonly canHear: boolean; readonly alreadyTalking: boolean }): boolean {
  // Someone who ended it themselves, or let it go quiet, wants it ended; voice off or no way to hear them means there is nothing to carry on with.
  if (!input.voiceOn || !input.canHear || input.alreadyTalking) return false;
  return input.stop === 'closed' || input.stop === 'error' || input.stop === 'start-failed';
}

const DROPPED: readonly string[] = [
  "Okay, the live voice dropped, but I'm still here. Go ahead, I'm listening.",
  "The live voice stopped for a moment. No problem, we'll carry on this way. I'm with you.",
  "Live voice gave out, so I'll carry on from here. Go on, I'm listening.",
];
const UNAVAILABLE: readonly string[] = [
  "Live voice isn't available right now, so let's talk this way. Go ahead.",
  "The live voice is out for now, but I'm here. Tell me what you need.",
];

/** What she says when she carries on in the other way, different each time. */
export function carryOnLine(stop: LiveStop, random: () => number = Math.random): string {
  const pool = stop === 'start-failed' ? UNAVAILABLE : DROPPED;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] as string;
}

/**
 * How a spoken conversation is held right now: Gemini's live voice, or the hands-free way (heard on this PC, answered by the AI that is
 * chosen or can answer, spoken aloud). Gemini's live voice answers with Gemini whatever was chosen, so a person who picked another AI is
 * never put through it; and when Gemini cannot answer at all, it would only fail.
 */
export function talkWay(route: AiRouteStatus | null): 'live' | 'hands-free' {
  if (route === null || route.backups.length === 0) return 'live';
  if (route.prefer === 'backup') return 'hands-free';
  return route.gemini === 'limit' || route.gemini === 'refused' || route.gemini === 'no-key' ? 'hands-free' : 'live';
}
