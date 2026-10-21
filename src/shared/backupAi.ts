/**
 * The "backup AIs": other online AIs Eya switches to when Gemini's free allowance for the day is used up (or Gemini is overloaded).
 * Any service that speaks the common OpenAI chat format works, so this is a list of the well-known ones (each address checked to exist)
 * plus a custom address for anything else. A person can add several at once, each with its own key: more keys, more allowance.
 * Pure data: the page shows it, the main process connects with it.
 */
export type BackupAiProvider =
  | 'mistral'
  | 'cerebras'
  | 'google'
  | 'openrouter'
  | 'groq'
  | 'sambanova'
  | 'nvidia'
  | 'huggingface'
  | 'together'
  | 'deepseek'
  | 'xai'
  | 'fireworks'
  | 'openai'
  | 'custom';

export interface BackupAiPreset {
  readonly id: BackupAiProvider;
  readonly label: string;
  /** Where requests go (the part before /chat/completions). Empty for a custom one: the user gives it. */
  readonly baseUrl: string;
  /** Preferred models, best first. The first one the service actually offers is used; the user can also type their own. */
  readonly models: readonly string[];
  /** Where the user gets a key. */
  readonly keyPage: string;
  /** One line on what to expect. */
  readonly note: string;
  /** How this service's keys begin, when they all begin the same way: shown to the user, and used to spot a key pasted under the wrong service. */
  readonly keyStart?: string;
  /**
   * The service lists its models to anyone, so asking for the list proves nothing about the key: a one-word test message is sent
   * once, when the key is saved, to find out whether it really works.
   */
  readonly publicList?: boolean;
}

export const BACKUP_AI_PRESETS: readonly BackupAiPreset[] = [
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-small-latest', 'mistral-medium-latest', 'open-mistral-nemo'],
    keyPage: 'console.mistral.ai/api-keys',
    note: 'Free plan with a large allowance: the best fit for Eya.',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    models: ['llama-3.3-70b', 'gpt-oss-120b', 'qwen-3-32b', 'llama3.1-8b'],
    keyPage: 'cloud.cerebras.ai',
    keyStart: 'csk-',
    note: 'Free key, very fast, with a good daily allowance.',
  },
  {
    id: 'google',
    label: 'Google AI Studio (another Gemini key)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-3.6-flash', 'gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview', 'gemini-flash-latest'],
    keyPage: 'aistudio.google.com/apikey',
    keyStart: 'AIza',
    note: 'A key from a different Google account (or project) has its own free allowance, so it is a second Gemini when the first one runs out.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'nvidia/nemotron-3-super-120b-a12b:free',
      'google/gemma-4-31b-it:free',
      'google/gemma-4-26b-a4b-it:free',
      'poolside/laguna-s-2.1:free',
      'meta-llama/llama-3.3-70b-instruct:free',
    ],
    keyPage: 'openrouter.ai/keys',
    keyStart: 'sk-or-',
    note: 'Many models; Eya only picks the ":free" ones that can use tools. They cost nothing but allow only a small number of requests a day, and free models may keep what you send.',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'],
    keyPage: 'console.groq.com/keys',
    keyStart: 'gsk_',
    note: 'Groq (groq.com) is not Grok (xAI). Free key and very fast, but its free daily allowance is small (counted in words processed per day).',
  },
  {
    id: 'sambanova',
    label: 'SambaNova',
    baseUrl: 'https://api.sambanova.ai/v1',
    models: ['Meta-Llama-3.3-70B-Instruct', 'gpt-oss-120b', 'DeepSeek-V3.2'],
    keyPage: 'cloud.sambanova.ai/apis',
    note: 'Free tier, fast.',
    publicList: true,
  },
  {
    id: 'nvidia',
    label: 'NVIDIA (build.nvidia.com)',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: ['nvidia/nemotron-3-super-120b-a12b', 'meta/llama-3.3-70b-instruct', 'openai/gpt-oss-120b'],
    keyPage: 'build.nvidia.com',
    keyStart: 'nvapi-',
    note: 'Free credits for developers.',
    publicList: true,
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    baseUrl: 'https://router.huggingface.co/v1',
    models: ['meta-llama/Llama-3.3-70B-Instruct', 'openai/gpt-oss-120b'],
    keyPage: 'huggingface.co/settings/tokens',
    keyStart: 'hf_',
    note: 'A small free monthly credit; many models.',
    publicList: true,
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    keyPage: 'api.together.ai/settings/api-keys',
    note: 'Has a free Llama model; others are paid by use.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat'],
    keyPage: 'platform.deepseek.com/api_keys',
    keyStart: 'sk-',
    note: 'Paid, but very cheap.',
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4-fast', 'grok-3-mini'],
    keyPage: 'console.x.ai',
    keyStart: 'xai-',
    note: 'xAI\'s Grok (x.ai) is not Groq (groq.com). Paid by use: the account needs credit.',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    models: ['accounts/fireworks/models/llama-v3p3-70b-instruct'],
    keyPage: 'fireworks.ai/account/api-keys',
    keyStart: 'fw_',
    note: 'Paid by use, with a small starting credit.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    // Quick, tool-following models first (a spoken assistant waits for every answer); the account's own list decides what exists.
    models: ['gpt-4.1-mini', 'gpt-4o-mini', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o'],
    keyPage: 'platform.openai.com/api-keys',
    keyStart: 'sk-',
    note: 'Paid: a few paise per request.',
  },
  {
    id: 'custom',
    label: 'Another service (give its address)',
    baseUrl: '',
    models: [],
    keyPage: '',
    note: 'Any service or program on this PC (Ollama, LM Studio) that accepts the OpenAI chat format. You give its address and model name.',
  },
];

/** How many backup AIs can be set up at once. */
export const MAX_BACKUPS = 6;

export function backupPreset(id: BackupAiProvider): BackupAiPreset {
  const preset = BACKUP_AI_PRESETS.find((p) => p.id === id);
  if (preset === undefined) throw new Error(`unknown backup AI provider: ${id}`);
  return preset;
}

/**
 * The service a key belongs to, when its first characters say so. Mistral, Groq-less formats and the like have no distinctive start
 * and are never guessed; OpenAI's "sk-" is shared by several services, so it is not guessed either.
 */
export function providerFromKey(key: string): BackupAiProvider | undefined {
  const k = key.trim();
  if (/^sk-or-/i.test(k)) return 'openrouter';
  if (/^gsk_/.test(k)) return 'groq';
  if (/^csk-/.test(k)) return 'cerebras';
  if (/^hf_/.test(k)) return 'huggingface';
  if (/^nvapi-/.test(k)) return 'nvidia';
  if (/^xai-/.test(k)) return 'xai';
  if (/^fw_/.test(k)) return 'fireworks';
  if (/^AIza/.test(k)) return 'google';
  return undefined;
}

export function isBackupAiProvider(value: unknown): value is BackupAiProvider {
  return typeof value === 'string' && BACKUP_AI_PRESETS.some((p) => p.id === value);
}

/**
 * The host of an address, with its port when it has one ("api.example.com", "localhost:1234"), or the whole text when it is not an
 * address. The port matters: two programs on this PC are told apart only by it.
 */
export function hostOf(url: string): string {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(url.trim());
  return m?.[1]?.toLowerCase() ?? url.trim().toLowerCase();
}

/**
 * What identifies one backup AI: its service (each well-known service once), or for a custom one its address, so two different
 * custom services can live side by side.
 */
export function backupId(provider: BackupAiProvider, baseUrl: string): string {
  return provider === 'custom' ? `custom-${hostOf(baseUrl)}` : provider;
}

/** The name shown for a backup AI. */
export function backupLabelFor(provider: BackupAiProvider, baseUrl: string): string {
  return provider === 'custom' ? hostOf(baseUrl) : backupPreset(provider).label;
}
