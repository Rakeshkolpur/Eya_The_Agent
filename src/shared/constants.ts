export const APP_NAME = 'Eya';
export const APP_ID = 'com.rakesh.eya';

export const ORB_WINDOW = {
  width: 96,
  height: 96,
  panelExpandedHeight: 360,
  panelExpandedWidth: 380,
  bottomMargin: 24,
} as const;

export const GLOBAL_SHORTCUT_TOGGLE = 'Control+Space';

export const GREETING = "Hi, I'm Eya. How can I help?";
export const ACK_WORKING = 'Working on it.';

/**
 * Gemini prebuilt voices that suit an assistant, as named by Google. Gender
 * here is Google's own published classification (Cloud Text-to-Speech's
 * Gemini-TTS voice table), not a guess — the one-word style after each name
 * is Google's own documented characteristic for that voice.
 *
 * The five male voices are a deliberate curation, not the full 16-voice male
 * roster: each is picked to match one requested persona, using Google's own
 * descriptor as the closest fit. Google doesn't document pitch/depth, so
 * "deep" for Schedar is an inference from "even" (steady, measured), not a
 * confirmed acoustic property — said plainly rather than overclaimed. All
 * five were confirmed live against both the streaming voice API and the Live
 * conversation API before being added.
 */
export const VOICE_OPTIONS = [
  { id: 'Aoede', label: 'Aoede - breezy', gender: 'female' },
  { id: 'Zephyr', label: 'Zephyr - bright', gender: 'female' },
  { id: 'Leda', label: 'Leda - youthful', gender: 'female' },
  { id: 'Sulafat', label: 'Sulafat - warm', gender: 'female' },
  { id: 'Laomedeia', label: 'Laomedeia - upbeat', gender: 'female' },
  { id: 'Achernar', label: 'Achernar - soft', gender: 'female' },
  { id: 'Callirrhoe', label: 'Callirrhoe - easy-going', gender: 'female' },
  { id: 'Kore', label: 'Kore - firm', gender: 'female' },
  { id: 'Achird', label: 'Achird - warm, friendly', gender: 'male' },
  { id: 'Schedar', label: 'Schedar - deep, calm', gender: 'male' },
  { id: 'Charon', label: 'Charon - professional', gender: 'male' },
  { id: 'Puck', label: 'Puck - young, energetic', gender: 'male' },
  { id: 'Zubenelgenubi', label: 'Zubenelgenubi - natural, conversational', gender: 'male' },
] as const;
export const DEFAULT_VOICE = 'Aoede';

export const INTENT_CONFIDENCE_THRESHOLD = 0.75;
