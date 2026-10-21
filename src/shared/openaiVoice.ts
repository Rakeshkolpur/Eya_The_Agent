/**
 * The voices OpenAI's speech models can speak with. Eya speaks with one of these (and only these) while ChatGPT is the AI she was set to
 * use, the way she speaks with a Gemini voice while Gemini is.
 */
export interface OpenAIVoiceOption {
  readonly id: string;
  readonly label: string;
}

export const OPENAI_VOICES: readonly OpenAIVoiceOption[] = [
  { id: 'coral', label: 'Coral — warm and friendly' },
  { id: 'nova', label: 'Nova — bright and lively' },
  { id: 'shimmer', label: 'Shimmer — soft and gentle' },
  { id: 'sage', label: 'Sage — calm and clear' },
  { id: 'alloy', label: 'Alloy — neutral and even' },
  { id: 'ballad', label: 'Ballad — smooth and thoughtful' },
  { id: 'ash', label: 'Ash — relaxed and direct' },
  { id: 'echo', label: 'Echo — steady and warm' },
  { id: 'fable', label: 'Fable — expressive storyteller' },
  { id: 'onyx', label: 'Onyx — deep and calm' },
  { id: 'verse', label: 'Verse — rich and expressive' },
];

export const DEFAULT_OPENAI_VOICE = 'coral';

export function isOpenAIVoice(value: unknown): value is string {
  return typeof value === 'string' && OPENAI_VOICES.some((v) => v.id === value);
}

/** The first, older speech model (tts-1) knows only these six voices. */
export const CLASSIC_OPENAI_VOICES: readonly string[] = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

/** The voice an older model can use that is closest to a newer one's. */
export function voiceForClassicModel(voice: string): string {
  if (CLASSIC_OPENAI_VOICES.includes(voice)) return voice;
  const nearest: Readonly<Record<string, string>> = { coral: 'nova', sage: 'shimmer', ballad: 'alloy', ash: 'echo', verse: 'fable' };
  return nearest[voice] ?? 'alloy';
}
