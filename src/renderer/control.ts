import type { OrbState } from '../shared/types';
import type { TaskAction, TasksSnapshot } from '../shared/tasks';
import type { PluginChange, PluginChangeResult, PluginsSnapshot } from '../shared/plugins';
import type { LiveChatRequest, LiveChatResult, LiveChatView } from '../shared/liveChat';
import type { AiRouteStatus } from '../shared/aiRoute';
import type { LocalAiStatus } from '../shared/localAi';
import type { AttachmentRef } from '../shared/attachments';
import type { ChatSummary } from '../shared/chats';
import type { GeminiKeysInput, GeminiKeysResult, GeminiKeysStatus } from '../shared/geminiKeys';
import type { BrowserPanelAction, BrowserPanelResult, BrowserPanelState, BrowserViewBounds } from '../shared/browserPanel';
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

/** What the AI list lets the person pick. */
export type AiChoice = 'auto' | 'local' | 'local-only' | { readonly id: string; readonly model: string };

/** The conversations Eya keeps, and the ways to start a new one or open an old one (the chat history in the sidebar). */
export interface ChatsControl {
  /** Newest first. */
  readonly items: readonly ChatSummary[];
  /** The kept conversation that is on screen now; null for one that has not been kept yet (or is not being kept). */
  readonly currentId: string | null;
  /** Eya is answering: the conversation cannot be switched or deleted under her. */
  readonly busy: boolean;
  /** Whether new conversations are being kept (Settings → Privacy). */
  readonly keeping: boolean;
  readonly newChat: () => void;
  readonly openChat: (id: string) => void;
  readonly deleteChat: (id: string) => void;
  readonly renameChat: (id: string, title: string) => void;
  readonly clearChats: () => void;
}

/** The screens of the full app. */
export type AppPage = 'home' | 'chat' | 'livechat' | 'screen' | 'browser' | 'files' | 'plugins' | 'recent' | 'memory' | 'settings';

export const APP_PAGES: readonly AppPage[] = ['home', 'chat', 'livechat', 'screen', 'browser', 'files', 'plugins', 'recent', 'memory', 'settings'];

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
  /** The kept conversations: the list, a new chat, opening an old one. */
  readonly chats: ChatsControl;
  /**
   * Whether a request is being worked on with tools right now, and the step she is on ("Reading the document…"). Unlike the orb's state it is not
   * changed by the voice speaking an earlier answer, so the side panel can rely on it.
   */
  readonly agent: { readonly working: boolean; readonly message: string };

  readonly comm: CommunicationAccessState | null;
  /** The plugins: what is installed, connected and allowed (the Plugins page). */
  readonly plugins: PluginsSnapshot | null;
  /** The Live Chat Companion: the one chat being watched, its drafts and its controls (the Live chat page). */
  readonly liveChat: LiveChatView | null;
  /** Where the Gemini key stands (never the key itself). */
  readonly geminiKey: GeminiKeyStatus | null;
  readonly saveGeminiKey: (key: string) => Promise<GeminiKeyResult>;
  readonly removeGeminiKey: () => Promise<GeminiKeyResult>;
  /** The extra Gemini keys (family, friends) used one after another after the person's own: each key's name, hint and state (never a key). */
  readonly geminiKeys: GeminiKeysStatus | null;
  readonly addGeminiKeys: (input: GeminiKeysInput) => Promise<GeminiKeysResult>;
  /** The Browser page: where the task works, what it is doing, the steps, what holds it up, and the controls (never a typed value or a key). */
  readonly browserPanel: BrowserPanelState | null;
  readonly browserAct: (action: BrowserPanelAction) => Promise<BrowserPanelResult>;
  readonly setBrowserView: (bounds: BrowserViewBounds | null) => void;
  readonly removeGeminiKeyEntry: (id: string) => Promise<GeminiKeysResult>;
  readonly testGeminiKeyEntry: (id: string) => Promise<GeminiKeysResult>;
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
  /** Pick the AI: automatic (Gemini first), the local AI first (cloud AIs help) or alone (nothing leaves this PC), or one of the backup's models, which is then asked first. */
  readonly chooseAi: (choice: AiChoice) => Promise<void>;
  /** The local AI (Ollama): is it running, has it the model, what to do if not. Null until looked at. */
  readonly localAi: LocalAiStatus | null;
  /** Looks again now (the Check again button). */
  readonly refreshLocalAi: () => Promise<LocalAiStatus>;
  readonly setLocalModel: (model: string) => Promise<void>;
  /** The answer so far while the local AI is still writing it (empty otherwise). */
  readonly streaming: string;
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

  /**
   * Sends a typed message to Eya, with the files attached to it, if any (they are read by the same tool as everywhere else). It goes as chat or as an
   * agent task according to Agent mode, unless `options.agent` says (the quick panel and "do it again" are always tasks).
   */
  readonly submit: (text: string, attachments?: readonly AttachmentRef[], options?: { readonly agent?: boolean }) => Promise<void>;
  /** Stop: ends whatever Eya is working on, and silences her, on the spot. The chat box is released at once. */
  readonly stopAll: () => void;
  /** Agent mode (the button beside the message box). Off: plain chat. On: the request is carried out with the browser and the other tools. */
  readonly agentMode: boolean;
  readonly setAgentMode: (on: boolean) => void;
  readonly toggleTalk: () => void;
  readonly toggleVoice: () => void;
  readonly toggleInterrupt: () => void;
  readonly changeVoiceName: (id: string) => void;
  readonly changeComm: (change: CommunicationAccessChange) => void;
  readonly changePlugin: (change: PluginChange) => Promise<PluginChangeResult>;
  /** A request from the Live chat page (start, pause, edit, approve, send…): real actions, checked again in the main process. */
  readonly liveChatAct: (request: LiveChatRequest) => Promise<LiveChatResult>;
  readonly actOnMemory: (action: MemoryAction) => Promise<MemoryActionResult>;
  readonly changeSettings: (patch: SettingsPatch) => void;
  readonly actOnActivity: (action: ActivityAction) => void;
  readonly setWindowMode: (mode: WindowMode) => void;
  /** The full app fills the screen right now. */
  readonly maximized: boolean;
  /** The maximize / restore button of the full app. */
  readonly toggleMaximize: () => void;
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
