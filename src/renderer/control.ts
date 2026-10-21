import type { OrbState } from '../shared/types';
import type { TaskAction, TasksSnapshot } from '../shared/tasks';
import type { AiRouteStatus } from '../shared/aiRoute';
import type {
  ActivityAction,
  ActivitySnapshot,
  CommunicationAccessChange,
  CommunicationAccessState,
  AiUsageStatus,
  BackupAiInput,
  BackupAiResult,
  BackupAiStatus,
  GeminiKeyResult,
  GeminiKeyStatus,
  MemoryAction,
  MemoryActionResult,
  MemorySnapshot,
  ScreenAskRequest,
  ScreenFrame,
  ScreenShareStatus,
  SettingsPatch,
  SettingsSnapshot,
  StatusMessage,
  WindowMode,
  WritingPatch,
  WritingState,
} from '../shared/ipcContract';
import type { SttState } from './localStt';
import type { ChatMessage } from './thread';

/** The screens of the full app. */
export type AppPage = 'home' | 'chat' | 'screen' | 'files' | 'recent' | 'memory' | 'settings';

export const APP_PAGES: readonly AppPage[] = ['home', 'chat', 'screen', 'files', 'recent', 'memory', 'settings'];

/** The latest question about the screen and how it is going, shown on the Live Screen page. */
export interface ScreenAskState {
  readonly phase: 'idle' | 'working' | 'done' | 'error';
  readonly question: string;
  readonly answer: string;
  readonly error: string;
  /** A short note after Capture ("Saved a picture on the Desktop"). */
  readonly note: string;
}

export const IDLE_SCREEN_ASK: ScreenAskState = { phase: 'idle', question: '', answer: '', error: '', note: '' };

/**
 * Everything the views need from the running assistant — one object, so the bubble, the quick panel and the full app are all just
 * different faces of the same thing, and none of them owns the microphone, the voice or the conversation.
 */
export interface EyaControl {
  readonly state: OrbState;
  /** "Ready · Listening for "Hey Eya"", "Thinking…"… */
  readonly statusText: string;
  readonly talk: 'off' | 'connecting' | 'on';
  readonly voiceOn: boolean;
  readonly listening: boolean;
  readonly wakeReady: boolean;
  /** How loud the microphone is right now (0..1), for the little pulse on the voice button. */
  readonly level: number;
  readonly sttState: SttState;
  readonly interruptOn: boolean;
  readonly voiceName: string;
  /** Whose voice speaks: ChatGPT's while it is the main AI (and then no other cloud voice stands in for it), else Gemini's. */
  readonly voiceEngine: 'gemini' | 'openai';
  /** The ChatGPT voice chosen (alloy, coral, ...). */
  readonly openaiVoice: string;
  readonly changeOpenaiVoice: (id: string) => void;
  /** Plays a sample in a ChatGPT voice; false when it could not be played. */
  readonly previewOpenaiVoice: (id: string) => Promise<boolean>;
  readonly providerStatus: StatusMessage | null;
  /** The latest line the quick panel shows (what she heard, what she said). */
  readonly transcript: string;
  /** The conversation, for the Chat screen. */
  readonly thread: readonly ChatMessage[];

  readonly comm: CommunicationAccessState | null;
  /** Where the Gemini key stands (never the key itself). */
  readonly geminiKey: GeminiKeyStatus | null;
  readonly saveGeminiKey: (key: string) => Promise<GeminiKeyResult>;
  readonly removeGeminiKey: () => Promise<GeminiKeyResult>;
  /** The backup AI (a second online service for when Gemini's allowance is spent) and how much of each AI's day has been used. */
  readonly backupAi: BackupAiStatus | null;
  readonly saveBackupAi: (input: BackupAiInput) => Promise<BackupAiResult>;
  /** Remove one backup AI by its id (or every saved one when no id is given). */
  readonly removeBackupAi: (id?: string) => Promise<BackupAiResult>;
  /** Sends a real test message to one saved backup AI and says whether it works (and why not). */
  readonly testBackupAi: (id?: string) => Promise<BackupAiResult>;
  readonly aiUsage: AiUsageStatus | null;
  readonly refreshAiUsage: () => void;
  /** The tasks Eya is keeping for the person (open ones first, then the few that ended lately). */
  readonly tasks: TasksSnapshot | null;
  readonly actOnTasks: (action: TaskAction) => void;
  /** Which AI is answering right now and why (Gemini, or the backup's model once Gemini's allowance is over). */
  readonly aiRoute: AiRouteStatus | null;
  /** Pick the AI: automatic (Gemini first) or one of the backup's models, which is then asked first. */
  readonly chooseAi: (choice: 'auto' | { readonly id: string; readonly model: string }) => Promise<void>;
  /** Writing Watch: whether Eya is watching a document being written, and what she has noticed. */
  readonly writing: WritingState | null;
  readonly setWriting: (patch: WritingPatch) => Promise<void>;
  readonly checkWriting: () => Promise<number>;
  readonly memory: MemorySnapshot | null;
  readonly settings: SettingsSnapshot | null;
  readonly activity: ActivitySnapshot | null;
  /** Whether Eya is looking at the screen, and the newest picture of it (the same one the AI sees). */
  readonly share: ScreenShareStatus;
  readonly frame: ScreenFrame | null;
  readonly screenAsk: ScreenAskState;

  readonly submit: (text: string) => Promise<void>;
  readonly toggleTalk: () => void;
  readonly toggleVoice: () => void;
  readonly toggleInterrupt: () => void;
  readonly changeVoiceName: (id: string) => void;
  readonly changeComm: (change: CommunicationAccessChange) => void;
  readonly actOnMemory: (action: MemoryAction) => Promise<MemoryActionResult>;
  readonly changeSettings: (patch: SettingsPatch) => void;
  readonly actOnActivity: (action: ActivityAction) => void;
  readonly setWindowMode: (mode: WindowMode) => void;
  readonly startShare: () => void;
  readonly stopShare: () => void;
  readonly askScreen: (request: ScreenAskRequest) => void;
  readonly captureScreen: () => void;
  /** Says the last answer about the screen aloud again. */
  readonly speakAnswer: () => void;
  /** Says any text aloud, in Eya's voice (unless voice is off). */
  readonly speakText: (text: string) => void;
  /** Ends Eya (the only way besides the tray's Quit; closing the window just puts her away). */
  readonly quit: () => void;
  readonly relaunch: () => void;
}
