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

/** Gemini prebuilt voices that suit an assistant, as named by Google. */
export const VOICE_OPTIONS = [
  { id: 'Aoede', label: 'Aoede - breezy' },
  { id: 'Zephyr', label: 'Zephyr - bright' },
  { id: 'Leda', label: 'Leda - youthful' },
  { id: 'Sulafat', label: 'Sulafat - warm' },
  { id: 'Laomedeia', label: 'Laomedeia - upbeat' },
  { id: 'Achernar', label: 'Achernar - soft' },
  { id: 'Callirrhoe', label: 'Callirrhoe - easy-going' },
  { id: 'Kore', label: 'Kore - firm' },
] as const;
export const DEFAULT_VOICE = 'Aoede';

export const INTENT_CONFIDENCE_THRESHOLD = 0.75;
