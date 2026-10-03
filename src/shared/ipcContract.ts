import type { AgentRequest, AgentResult, AgentUpdate, OrbState } from './types';

export const IpcChannels = {
  submitAgentRequest: 'eya:agent:submit',
  submitAudioRequest: 'eya:agent:submitAudio',
  agentUpdate: 'eya:agent:update',
  agentResult: 'eya:agent:result',
  setOrbState: 'eya:orb:setState',
  toggleInput: 'eya:orb:toggleInput',
  showPanel: 'eya:orb:showPanel',
  setExpanded: 'eya:orb:setExpanded',
  hideOrb: 'eya:orb:hide',
  ttsSpeak: 'eya:tts:speak',
  ttsPrefetch: 'eya:tts:prefetch',
  liveConfig: 'eya:live:config',
  liveToolCall: 'eya:live:toolCall',
  wakeAvailable: 'eya:wake:available',
  wakeAudioChunk: 'eya:wake:audioChunk',
  wakeDetected: 'eya:wake:detected',
  ttsStream: 'eya:tts:stream',
  ttsStreamCancel: 'eya:tts:streamCancel',
  ttsChunk: 'eya:tts:chunk',
  ttsStreamEnd: 'eya:tts:streamEnd',
  ttsStop: 'eya:tts:stop',
  ttsDone: 'eya:tts:done',
  ttsReady: 'eya:tts:ready',
  status: 'eya:status',
  getCommunicationAccess: 'eya:comm:get',
  setCommunicationAccess: 'eya:comm:set',
  communicationAccessChanged: 'eya:comm:changed',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];

export interface TTSSpeakMessage {
  readonly utteranceId: string;
  readonly text: string;
}

/** Everything the page needs to open a Gemini Live conversation. */
export interface LiveConfig {
  /** Includes the API key: keep it in memory only, never log it. */
  readonly url: string;
  /** Models to try, best first. */
  readonly models: readonly string[];
  readonly voice: string;
  readonly systemInstruction: string;
  readonly tools: readonly { readonly name: string; readonly description: string; readonly parameters: unknown }[];
}

export interface LiveToolCallRequest {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface LiveToolCallResult {
  /** The tool's result as JSON text, ready to hand back to the model. */
  readonly content: string;
}

/** What "hey Eya" was recognized as, e.g. "HEY_EYA" or "HEY_AYA" (for logging; any of them means the same thing). */
export type WakeDetection = string;

/** Ask the main process to synthesize speech and stream it back as audio chunks. */
export interface TTSStreamRequest {
  readonly text: string;
  readonly voice: string;
}

export type TTSStreamStartResult =
  | { readonly ok: true; readonly streamId: string }
  | { readonly ok: false; readonly error: string };

/** Raw 24kHz mono 16-bit little-endian PCM. */
export interface TTSChunkMessage {
  readonly streamId: string;
  readonly pcm: Uint8Array;
}

export interface TTSStreamEndMessage {
  readonly streamId: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly model?: string;
}

export interface TTSPrefetchMessage {
  readonly text: string;
  /** high: a reply is about to be spoken. low: background pre-generation. */
  readonly priority: 'high' | 'low';
}

export interface AudioRequest {
  readonly requestId: string;
  readonly audioBase64: string;
  readonly mimeType: string;
  /** Captured by always-on listening rather than an explicit mic press. */
  readonly live?: boolean;
}

export interface StatusMessage {
  readonly ai: 'gemini' | 'ollama' | 'none';
  readonly aiReady: boolean;
  readonly ttsEngine: 'kokoro' | 'browser' | 'pending';
}

/** The Communication Access choice as the panel shows it. */
export interface CommunicationAccessState {
  /** The master switch: may Eya look at or use chat apps at all. OFF by default. */
  readonly enabled: boolean;
  readonly apps: readonly { readonly id: string; readonly name: string; readonly allowed: boolean }[];
}

/** What the panel can ask for: flip the master switch, and/or allow or exclude one app. */
export interface CommunicationAccessChange {
  readonly enabled?: boolean;
  readonly app?: { readonly id: string; readonly allowed: boolean };
}

export interface EyaBridge {
  submit(request: AgentRequest): Promise<AgentResult>;
  submitAudio(request: AudioRequest): Promise<AgentResult>;
  onAgentUpdate(cb: (update: AgentUpdate) => void): () => void;
  onSetOrbState(cb: (state: OrbState) => void): () => void;
  onToggleInput(cb: () => void): () => void;
  /** Tell the main process whether the panel is open, so it can size the window. */
  setExpanded(expanded: boolean): void;
  onShowPanel(cb: () => void): () => void;
  onStatus(cb: (status: StatusMessage) => void): () => void;
  onTTSSpeak(cb: (msg: TTSSpeakMessage) => void): () => void;
  onTTSPrefetch(cb: (msg: TTSPrefetchMessage) => void): () => void;
  /** Null if Live voice isn't available (no Gemini key). */
  getLiveConfig(voice: string): Promise<LiveConfig | null>;
  runLiveTool(request: LiveToolCallRequest): Promise<LiveToolCallResult>;
  /** False if the on-device wake-word model could not be loaded (unsupported platform, missing files, ...). */
  wakeAvailable(): Promise<boolean>;
  /** 16kHz mono audio, sent for wake-word listening only (fire-and-forget). */
  sendWakeAudio(samples16k: Float32Array): void;
  onWakeDetected(cb: (which: WakeDetection) => void): () => void;
  startTTSStream(request: TTSStreamRequest): Promise<TTSStreamStartResult>;
  cancelTTSStream(streamId: string): void;
  onTTSChunk(cb: (msg: TTSChunkMessage) => void): () => void;
  onTTSStreamEnd(cb: (msg: TTSStreamEndMessage) => void): () => void;
  onTTSStop(cb: () => void): () => void;
  ttsDone(utteranceId: string): void;
  ttsReady(): void;
  /** The privacy switch for chat apps (WhatsApp, Telegram, Instagram…). Only this panel can change it. */
  getCommunicationAccess(): Promise<CommunicationAccessState>;
  setCommunicationAccess(change: CommunicationAccessChange): Promise<CommunicationAccessState>;
  onCommunicationAccessChanged(cb: (state: CommunicationAccessState) => void): () => void;
}

declare global {
  interface Window {
    readonly eya: EyaBridge;
  }
}
