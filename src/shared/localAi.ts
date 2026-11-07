/**
 * Local AI: the model Eya runs on this PC through Ollama (no key, nothing leaves the computer). What the main process finds out about it and
 * what the pages show; pure, so both sides (and the tests) say the same thing.
 */

/** The small model Eya asks for unless the person picks another: 1.3 GB, fits an 8 GB laptop with room for everything else. */
export const DEFAULT_LOCAL_MODEL = 'llama3.2:1b';

export const DEFAULT_OLLAMA_ADDRESS = 'http://127.0.0.1:11434';

export type LocalAiState = 'connected' | 'not-running' | 'model-missing';

export interface LocalAiStatus {
  readonly state: LocalAiState;
  /** The model Eya asks for. */
  readonly model: string;
  /** The models installed in Ollama (what can be picked). */
  readonly models: readonly string[];
  readonly address: string;
  /** What is going on, in words. */
  readonly message: string;
  /** What to do about it (a command to run, an app to open), or null when nothing is wrong. */
  readonly fix: string | null;
  /** The model is fixed by EYA_OLLAMA_MODEL (in the environment or the .env file), which wins over the choice in Settings. */
  readonly modelFromEnv?: boolean;
}

/** A model name as Ollama prints it ("llama3.2:1b", "llama3.1:latest"); anything else is not passed on to Ollama. */
export function isModelName(text: unknown): text is string {
  return typeof text === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(text);
}

/** Whether a model is among the installed ones ("llama3.2" means "llama3.2:latest"). */
export function modelInstalled(installed: readonly string[], model: string): boolean {
  const want = model.includes(':') ? model : `${model}:latest`;
  return installed.some((m) => m === want || m === model);
}

export function describeLocalAi(input: { readonly running: boolean; readonly installed: readonly string[]; readonly model: string; readonly address?: string }): LocalAiStatus {
  const address = input.address ?? DEFAULT_OLLAMA_ADDRESS;
  const base = { model: input.model, models: input.installed, address };
  if (!input.running) {
    return {
      ...base,
      state: 'not-running',
      message: `Ollama is not running (nothing answered at ${address}), so the local AI cannot answer.`,
      fix: 'Open the Ollama app from the Start menu, or run: ollama serve',
    };
  }
  if (!modelInstalled(input.installed, input.model)) {
    return {
      ...base,
      state: 'model-missing',
      message: `Ollama is running, but the model ${input.model} is not installed.`,
      fix: `Run: ollama pull ${input.model}`,
    };
  }
  return { ...base, state: 'connected', message: `Connected. ${input.model} is installed and ready.`, fix: null };
}
