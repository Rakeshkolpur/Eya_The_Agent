// "Eya" is not a common word, so speech recognition spells it many ways. These
// are ones actually seen (e.g. "Hey Eya" heard as "Hey, I" and "Hey, I-A").
export const EYA_NAME_PATTERN =
  '(?:eya|eyah|aya|ayah|aiya|iya|eia|eyeah|ayeh|ea|ia|i[\\s-]a|i[\\s-]ya|ee[\\s-]?ya|ay[\\s-]?ya|eye[\\s-]?a|aye[\\s-]?a)';

const GREETING = '(?:hey|hi|hello|ok|okay)';
const INVITATION =
  "(?:let'?s talk|talk to me|are you there|wake up|i want to talk|can we talk|start (?:a )?(?:conversation|chat))";

const TRIGGER = new RegExp(`^(?:${GREETING}\\s+)?${EYA_NAME_PATTERN}(?:\\s+${INVITATION})?$`);
// Recognition often clips the name to a bare "I": "Hey Eya" -> "Hey, I". On its own
// that two-word phrase is worth treating as a call; inside a longer sentence it is not.
const BARE_CLIPPED_CALL = /^(?:hey|hi|hello|okay) i$/;

/**
 * Whether a heard phrase is just calling Eya ("Hey Eya", "Eya, let's talk"),
 * as opposed to giving her something to do. Calling her opens a live
 * conversation; a request is handled as a command.
 */
export function isConversationTrigger(heard: string): boolean {
  const plain = heard
    .toLowerCase()
    .replace(/[.,!?;:"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 0 && (TRIGGER.test(plain) || BARE_CLIPPED_CALL.test(plain));
}
