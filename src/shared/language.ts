/**
 * Which language Eya answers in. Without a rule every AI picks its own: Gemini's live voice follows the accent it hears, and each model
 * a backup falls to has its own habit, so one conversation could come back in Hindi, then Telugu, then English. Now there is one rule, said
 * to every AI the same way, and it is the person's to change.
 */
export type EyaLanguage = 'english' | 'hindi' | 'telugu' | 'auto';

export const LANGUAGE_OPTIONS: ReadonlyArray<{ readonly id: EyaLanguage; readonly label: string }> = [
  { id: 'english', label: 'English' },
  { id: 'hindi', label: 'Hindi (हिन्दी)' },
  { id: 'telugu', label: 'Telugu (తెలుగు)' },
  { id: 'auto', label: 'Same language as I speak' },
];

export const DEFAULT_LANGUAGE: EyaLanguage = 'english';

export function isEyaLanguage(value: unknown): value is EyaLanguage {
  return value === 'english' || value === 'hindi' || value === 'telugu' || value === 'auto';
}

/** The sentence put into the instructions of every AI (the written one and the live voice). */
export function languageRule(language: EyaLanguage): string {
  switch (language) {
    case 'hindi':
      return 'Language: always answer in Hindi (हिन्दी), whatever language or accent you hear, and never switch language on your own. Keep names, numbers, file names and web addresses as they are. Only if the person clearly asks for another language, change to it until they ask for Hindi again.';
    case 'telugu':
      return 'Language: always answer in Telugu (తెలుగు), whatever language or accent you hear, and never switch language on your own. Keep names, numbers, file names and web addresses as they are. Only if the person clearly asks for another language, change to it until they ask for Telugu again.';
    case 'auto':
      return 'Language: answer in the language the person speaks or writes to you in, and stay in that language for the whole conversation: never change language between replies unless they do. When it is not clear which language it is, answer in English.';
    default:
      return 'Language: always answer in English, whatever language or accent you hear, and never switch language on your own. Only if the person clearly asks you to speak another language, change to it until they ask for English again.';
  }
}
