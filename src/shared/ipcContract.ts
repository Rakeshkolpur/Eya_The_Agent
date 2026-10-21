import type { PerformanceInfo, PerformanceSetting } from './performance';
import type { AgentRequest, AgentResult, AgentUpdate, OrbState } from './types';
import type { BackupAiProvider } from './backupAi';
import type { AiRouteStatus } from './aiRoute';
import type { TaskAction, TaskSay, TasksSnapshot } from './tasks';

export const IpcChannels = {
  submitAgentRequest: 'eya:agent:submit',
  submitAudioRequest: 'eya:agent:submitAudio',
  agentUpdate: 'eya:agent:update',
  agentResult: 'eya:agent:result',
  setOrbState: 'eya:orb:setState',
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
  memoryGet: 'eya:memory:get',
  memoryAct: 'eya:memory:act',
  memoryChanged: 'eya:memory:changed',
  memorySuggestion: 'eya:memory:suggestion',
  windowSetMode: 'eya:window:setMode',
  windowGetMode: 'eya:window:getMode',
  windowMode: 'eya:window:mode',
  windowDrag: 'eya:window:drag',
  windowMenu: 'eya:window:menu',
  settingsGet: 'eya:settings:get',
  settingsSet: 'eya:settings:set',
  settingsChanged: 'eya:settings:changed',
  activityGet: 'eya:activity:get',
  activityAct: 'eya:activity:act',
  activityChanged: 'eya:activity:changed',
  appQuit: 'eya:app:quit',
  appRelaunch: 'eya:app:relaunch',
  geminiKeyGet: 'eya:geminikey:get',
  geminiKeySet: 'eya:geminikey:set',
  geminiKeyClear: 'eya:geminikey:clear',
  backupAiGet: 'eya:backupai:get',
  backupAiSet: 'eya:backupai:set',
  backupAiClear: 'eya:backupai:clear',
  backupAiTest: 'eya:backupai:test',
  aiUsageGet: 'eya:aiusage:get',
  backupAiSetModel: 'eya:backupai:setmodel',
  aiRouteGet: 'eya:airoute:get',
  aiRoute: 'eya:airoute',
  tasksGet: 'eya:tasks:get',
  tasksAct: 'eya:tasks:act',
  tasksChanged: 'eya:tasks:changed',
  tasksSay: 'eya:tasks:say',
  writingGet: 'eya:writing:get',
  writingSet: 'eya:writing:set',
  writingAct: 'eya:writing:act',
  writingCheck: 'eya:writing:check',
  writingChanged: 'eya:writing:changed',
  /** The small suggestion card's own channels (it is a separate window with its own tiny preload). */
  writingCardState: 'eya:writing:card:state',
  writingCardReady: 'eya:writing:card:ready',
  writingCardAct: 'eya:writing:card:act',
  writingCardSize: 'eya:writing:card:size',
  writingCardHide: 'eya:writing:card:hide',
  screenShareStart: 'eya:screen:start',
  screenShareStop: 'eya:screen:stop',
  screenShareGet: 'eya:screen:get',
  screenShareTouch: 'eya:screen:touch',
  screenShareAsk: 'eya:screen:ask',
  screenShareCapture: 'eya:screen:capture',
  screenShareStatus: 'eya:screen:status',
  screenShareFrame: 'eya:screen:frame',
  filesList: 'eya:files:list',
  filesBrowse: 'eya:files:browse',
  filesSearch: 'eya:files:search',
  filesOpen: 'eya:files:open',
  filesReveal: 'eya:files:reveal',
  filesAsk: 'eya:files:ask',
  filesThumbs: 'eya:files:thumbs',
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
  /**
   * What the user said that led to this call (the live transcript of their turn). Used only so Eya's memory can tell that several
   * tool calls were one task, and what it was called; it is never stored as a conversation.
   */
  readonly heard?: string;
  /** Which of the user's turns this call belongs to (counts up), so two identical requests in a row are not taken for one. */
  readonly turn?: number;
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
  /** Whose speech it is: Gemini's (the default) or OpenAI's. */
  readonly engine?: 'gemini' | 'openai';
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

/** The three shapes of Eya's one window: a small bubble, the quick assistant panel that grows out of it, and the full app. */
export type WindowMode = 'bubble' | 'assistant' | 'app';
/** Which corner of the window the bubble sits in while the assistant is open (the panel opens away from the screen edge). */
export type WindowAnchor = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface WindowModeState {
  readonly mode: WindowMode;
  readonly anchor: WindowAnchor;
  /** Which screen of the full app to show (set when something opens the app on a particular screen, like the tray's Chats item). */
  readonly page?: string;
}

/** Eya's own settings (the voice and Communication Access choices have their own homes). */
export interface AppSettings {
  /** Show the floating bubble when the app is closed. Off hides it; Eya is then opened from the tray icon. */
  readonly showBubble: boolean;
  /** Clicking the bubble starts a live conversation straight away, like tapping an assistant on a phone. */
  readonly tapToTalk: boolean;
  /** Keep a list of what Eya did (titles only, on this PC) for the Recent screen. */
  readonly keepHistory: boolean;
  /** How hard Eya works: automatic (matched to this laptop) or a level the user picked. Applies the next time Eya starts. */
  readonly performance: PerformanceSetting;
  /** Which AI is asked first: Gemini and then the backup when Gemini is out (auto), or the backup first (the user's choice). */
  readonly aiFirst: 'auto' | 'backup';
}

export interface AppInfo {
  readonly version: string;
  /** False when run from source (npm run dev): starting with Windows is only offered for the installed app. */
  readonly packaged: boolean;
  /** Where the memory database lives. */
  readonly memoryPath: string;
  /** Whether Eya starts when Windows does; null when that cannot be offered. */
  readonly startWithWindows: boolean | null;
  /** The performance level running, what this laptop would pick, and what is chosen. */
  readonly performance: PerformanceInfo;
}

/** Where Eya's Gemini key stands. The key itself is never sent to the page: only where it came from and its last four characters. */
export interface GeminiKeyStatus {
  /** The key in use came from the environment or a .env file ('env'), from Settings ('saved'), or there is none. */
  readonly source: 'env' | 'saved' | 'none';
  readonly hint: string | null;
  /** A key was saved or removed since Eya started: it takes effect when she restarts. */
  readonly pendingRestart: boolean;
  /** Whether Windows can protect a saved key on this account. */
  readonly canSave: boolean;
}

export interface GeminiKeyResult {
  readonly ok: boolean;
  /** What happened, in words the user can read. */
  readonly message: string;
  readonly status: GeminiKeyStatus;
}

/** One backup AI. The key itself is never sent to the page: only which service, which model and its last four characters. */
export interface BackupAiEntry {
  /** What names it: its service ("openrouter"), or for a custom one "custom-<address>". */
  readonly id: string;
  readonly provider: BackupAiProvider;
  readonly label: string;
  /** The model in use, then the others it will try. */
  readonly model: string;
  readonly models: readonly string[];
  readonly extraModels: number;
  readonly hint: string;
  readonly baseUrl: string | null;
  /** Saved in Settings (can be removed there), or from a .env file / the environment (which is read first). */
  readonly source: 'saved' | 'env';
}

/** Where the backup AIs stand. */
export interface BackupAiStatus {
  /** At least one backup AI is set up. */
  readonly configured: boolean;
  /** All of them, in the order Eya asks them. */
  readonly entries: readonly BackupAiEntry[];
  /** How many can be set up at once. */
  readonly max: number;
  /** The first backup, in the fields the pages had when there could only be one. */
  readonly provider: BackupAiProvider | null;
  readonly label: string | null;
  readonly model: string | null;
  /** How many other models Eya will try when that one fails (OpenRouter's free models). */
  readonly extraModels: number;
  /** Every model the user can pick from, the one in use first. */
  readonly models: readonly string[];
  readonly hint: string | null;
  /** The address, for a "custom" service only. */
  readonly baseUrl: string | null;
  readonly source: 'saved' | 'env' | 'none';
  /** Whether Windows can protect a saved key on this account. */
  readonly canSave: boolean;
}

export interface BackupAiInput {
  readonly provider: BackupAiProvider;
  readonly key: string;
  /** Leave out to let Eya pick the best model the service offers. */
  readonly model?: string;
  /** Only for the "custom" service. */
  readonly baseUrl?: string;
}

export interface BackupAiResult {
  readonly ok: boolean;
  readonly message: string;
  readonly status: BackupAiStatus;
}

/** How much of each AI's daily allowance Eya has used today, so "it ran out after N requests" is a fact the user can see. */
export interface AiUsageStatus {
  readonly day: string;
  readonly providers: ReadonlyArray<{
    readonly name: string;
    readonly requests: number;
    /** The number of requests it had answered when its day's allowance ran out. */
    readonly limitedAfter?: number;
    /** Epoch ms when it will be tried again, if it is being left alone. */
    readonly restingUntil?: number;
  }>;
}

/** One slip Writing Watch found, as the pages see it. */
export interface WritingFinding {
  readonly id: string;
  readonly kind: string;
  readonly message: string;
  readonly excerpt: string;
  readonly paragraph: number;
  /** A click on Fix can make the correction (a certain one exists, and the program being watched lets Eya make it). */
  readonly canFix: boolean;
  readonly replace?: { readonly from: string; readonly to: string };
}

/**
 * Writing Watch: while it is on, Eya reads the document being written (Word, or Notepad and a few plain editors), on this PC, and shows a
 * small card when she sees a slip. Nothing is changed unless the user clicks Fix.
 */
export interface WritingState {
  readonly watching: boolean;
  /** "Word", "Notepad"…; null when nothing readable is open. */
  readonly source: string | null;
  readonly title: string;
  /** The user allowed the deeper check by Gemini (one paragraph at a time) for this session. */
  readonly cloudAllowed: boolean;
  /** Whether a Gemini key exists, so the deeper check could run at all. */
  readonly cloudAvailable: boolean;
  readonly findings: readonly WritingFinding[];
  readonly more: number;
  readonly checkedAt: number;
  readonly note: string;
}

export interface WritingPatch {
  readonly watching?: boolean;
  readonly cloud?: boolean;
}

export interface WritingAction {
  readonly id: string;
  readonly action: 'fix' | 'ignore';
}

export interface SettingsSnapshot {
  readonly settings: AppSettings;
  readonly info: AppInfo;
}

export type SettingsPatch = Partial<AppSettings> & { readonly startWithWindows?: boolean };

/** What kind of thing Eya did, for the Recent screen's filters. */
export type ActivityKind = 'action' | 'file' | 'web' | 'chat';

export interface ActivityItemView {
  readonly id: number;
  readonly at: string;
  readonly kind: ActivityKind;
  readonly title: string;
  readonly detail: string;
  readonly ok: boolean;
  /** The request can be run again (it is kept only for ordinary tasks, never for chat apps). */
  readonly canRepeat: boolean;
  readonly request: string;
}

export interface ActivitySnapshot {
  /** Whether a history is being kept at all (Settings → Privacy). */
  readonly enabled: boolean;
  readonly items: readonly ActivityItemView[];
  /** The sites Eya has opened most, for the Memory screen. */
  readonly sites: readonly { readonly site: string; readonly count: number }[];
}

export type ActivityAction = { readonly kind: 'clear' } | { readonly kind: 'delete'; readonly id: number };

/** Whether Eya is looking at the screen, and if not why. */
export interface ScreenShareStatus {
  readonly active: boolean;
  /** Set while sharing is on but Eya is NOT looking: a chat app is showing and Chats are OFF for it. */
  readonly paused: { readonly reason: 'chat_app'; readonly app: string } | null;
  readonly startedAt: number | null;
  /** How many pictures have been taken since it started. */
  readonly frames: number;
  /** Why it last stopped, if it has. */
  readonly stopped?: 'user' | 'idle' | 'error' | 'quit';
  readonly message?: string;
}

/** One picture of the screen, small enough to send once a second. The same picture is what the preview shows and what the AI sees. */
export interface ScreenFrame {
  /** JPEG, base64. */
  readonly jpeg: string;
  readonly width: number;
  readonly height: number;
  readonly at: number;
}

/** What to ask about the screen: describe it, explain it, say what to do next, or the user's own question. */
export type ScreenAskMode = 'analyze' | 'explain' | 'next' | 'ask';

export interface ScreenAskRequest {
  readonly mode: ScreenAskMode;
  readonly question?: string;
}

export interface ScreenAskResult {
  readonly ok: boolean;
  readonly answer?: string;
  /** Why not, in words the user can read. */
  readonly error?: string;
}

/** The tabs of the Files screen. */
export type FilesView = 'recent' | 'documents' | 'images' | 'folders';
export type FileKind = 'folder' | 'document' | 'image' | 'other';

export interface FileEntryView {
  readonly path: string;
  readonly name: string;
  readonly kind: FileKind;
  /** Lower-case, no dot; empty for a folder. */
  readonly ext: string;
  readonly size: number;
  /** ISO time it was last changed. */
  readonly modified: string;
  /** Which folder it is in, in words ("Documents", "Downloads", or the folder's own name). */
  readonly where: string;
}

/** What the Files screen shows: a list of files or folders, and — when browsing one folder — where that is and how to go up. */
export interface FilesListing {
  readonly title: string;
  readonly folder: string | null;
  readonly parent: string | null;
  readonly items: readonly FileEntryView[];
  /** There was more than is shown. */
  readonly truncated: boolean;
  /** Why nothing could be shown, in words the user can read. */
  readonly error?: string;
}

export interface FileActionResult {
  readonly ok: boolean;
  readonly message: string;
  /** For "ask about this file": what came back. */
  readonly answer?: string;
}

/** One remembered preference or fact, as the Memory panel shows it. */
export interface MemoryItemView {
  readonly id: number;
  readonly type: 'preference' | 'fact';
  readonly value: string;
}

/** One saved routine, as the Memory panel shows it. The steps are for reading; what a routine DOES is edited by doing the task again. */
export interface RoutineView {
  readonly id: number;
  readonly name: string;
  readonly enabled: boolean;
  /** The wordings that run it. */
  readonly triggers: readonly string[];
  /** The steps in plain words, one per line. */
  readonly steps: readonly string[];
  readonly useCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly lastUsedAt: string | null;
}

/** One chat name Eya learned from a chat app the user allowed — the name only, what the user calls it, and how often it was used. */
export interface ChatNameView {
  readonly id: number;
  /** The chat app, as the user knows it ("WhatsApp"). */
  readonly app: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly uses: number;
}

/** Whether Eya is remembering chat names (the user's choice; 'unasked' until they have been asked), and the names she holds. */
export interface ChatNamesView {
  readonly learning: 'on' | 'off' | 'unasked';
  readonly names: readonly ChatNameView[];
}

export interface MemorySnapshot {
  /** False when the database could not be opened: Eya runs fine without memory, and the panel says so. */
  readonly available: boolean;
  readonly memories: readonly MemoryItemView[];
  readonly routines: readonly RoutineView[];
  readonly chatNames: ChatNamesView;
  /** An open offer ("save this as a routine?") the user can answer with a button. */
  readonly suggestion: { readonly text: string; readonly kind: 'save' | 'update' } | null;
}

/** What the Memory panel can ask for. Only Eya's own panel sends these; the model has its own, narrower tools. */
export type MemoryAction =
  | { readonly kind: 'add_memory'; readonly type: 'preference' | 'fact'; readonly text: string }
  | { readonly kind: 'edit_memory'; readonly id: number; readonly text: string }
  | { readonly kind: 'delete_memory'; readonly id: number }
  | { readonly kind: 'set_enabled'; readonly id: number; readonly enabled: boolean }
  | { readonly kind: 'rename_routine'; readonly id: number; readonly name: string }
  | { readonly kind: 'add_phrase'; readonly id: number; readonly text: string }
  | { readonly kind: 'remove_phrase'; readonly id: number; readonly text: string }
  | { readonly kind: 'delete_routine'; readonly id: number }
  | { readonly kind: 'forget_chat_name'; readonly id: number }
  | { readonly kind: 'forget_chat_names' }
  /** The user's own switch for remembering chat names. Turning it off also forgets every name. */
  | { readonly kind: 'set_chat_names'; readonly on: boolean }
  | { readonly kind: 'answer_suggestion'; readonly answer: 'yes' | 'no' };

export interface MemoryActionResult {
  readonly ok: boolean;
  /** Why not, in words the user can read. */
  readonly message?: string;
  readonly snapshot: MemorySnapshot;
}

export interface EyaBridge {
  submit(request: AgentRequest): Promise<AgentResult>;
  submitAudio(request: AudioRequest): Promise<AgentResult>;
  onAgentUpdate(cb: (update: AgentUpdate) => void): () => void;
  onSetOrbState(cb: (state: OrbState) => void): () => void;
  onStatus(cb: (status: StatusMessage) => void): () => void;
  onTTSSpeak(cb: (msg: TTSSpeakMessage) => void): () => void;
  onTTSPrefetch(cb: (msg: TTSPrefetchMessage) => void): () => void;
  /** Null if Live voice isn't available (no Gemini key). */
  /** `recent`: what was said earlier in this conversation, for one that has to start again (see main/tasks/progress.ts). */
  getLiveConfig(voice: string, recent?: ReadonlyArray<{ readonly who: 'user' | 'eya'; readonly text: string }>): Promise<LiveConfig | null>;
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
  /** What Eya remembers and the routines she has saved (kept in a local database on this PC). */
  getMemory(): Promise<MemorySnapshot>;
  actOnMemory(action: MemoryAction): Promise<MemoryActionResult>;
  onMemoryChanged(cb: (snapshot: MemorySnapshot) => void): () => void;
  /** Eya has just offered to save a repeated task as a routine: speak it (Talk mode) and show Yes/No. */
  onMemorySuggestion(cb: (text: string) => void): () => void;
  /** Eya's window: bubble, quick assistant, or the full app. The main process owns the geometry and tells the page what it did. */
  setWindowMode(mode: WindowMode): void;
  getWindowMode(): Promise<WindowModeState>;
  onWindowMode(cb: (state: WindowModeState) => void): () => void;
  /** The bubble is being dragged (the main process follows the pointer and settles it against an edge on release). */
  dragWindow(phase: 'start' | 'end'): void;
  /** The bubble's right-click menu (a native menu: open, Chats on/off, hide the bubble, quit). */
  showBubbleMenu(): void;
  getSettings(): Promise<SettingsSnapshot>;
  setSettings(patch: SettingsPatch): Promise<SettingsSnapshot>;
  onSettingsChanged(cb: (snapshot: SettingsSnapshot) => void): () => void;
  getActivity(): Promise<ActivitySnapshot>;
  actOnActivity(action: ActivityAction): Promise<ActivitySnapshot>;
  onActivityChanged(cb: (snapshot: ActivitySnapshot) => void): () => void;
  quitApp(): void;
  /** Starts Eya again (the installed app only), so a changed performance level takes effect. */
  relaunchApp(): void;
  /** The Gemini key: whether there is one, where it came from, its last four characters. Saving checks it with Google first. */
  getGeminiKey(): Promise<GeminiKeyStatus>;
  setGeminiKey(key: string): Promise<GeminiKeyResult>;
  clearGeminiKey(): Promise<GeminiKeyResult>;
  getBackupAi(): Promise<BackupAiStatus>;
  setBackupAi(input: BackupAiInput): Promise<BackupAiResult>;
  /** Remove one backup AI by its id, or every saved one when no id is given. */
  clearBackupAi(id?: string): Promise<BackupAiResult>;
  /** Sends a real test message to a saved backup AI and says whether it works. */
  testBackupAi(id?: string): Promise<BackupAiResult>;
  getAiUsage(): Promise<AiUsageStatus>;
  /** Use this model of this backup AI, and ask that backup before the others. */
  setBackupAiModel(model: string, id?: string): Promise<BackupAiResult>;
  /** Which AI is answering now, and why (changes when Gemini's limit runs out or comes back). */
  getAiRoute(): Promise<AiRouteStatus>;
  /** The tasks Eya is keeping (and the ones that ended lately). */
  getTasks(): Promise<TasksSnapshot>;
  actOnTasks(action: TaskAction): Promise<TasksSnapshot>;
  onTasksChanged(listener: (snapshot: TasksSnapshot) => void): () => void;
  /** Eya has something to say about a task (a late result, a question): speak it, or tell it to the live conversation. */
  onTasksSay(listener: (say: TaskSay) => void): () => void;
  onAiRoute(listener: (route: AiRouteStatus) => void): () => void;
  /** Writing Watch (see WritingState). Switching it on is always the user's own act; it is off every time Eya starts. */
  getWriting(): Promise<WritingState>;
  setWriting(patch: WritingPatch): Promise<WritingState>;
  actOnWriting(action: WritingAction): Promise<WritingState>;
  /** A full check of the open document, now, because the user pressed the button. Resolves with how many slips were found. */
  checkWriting(): Promise<number>;
  onWritingChanged(cb: (state: WritingState) => void): () => void;
  /** Screen sharing: Eya looks at the screen about once a second while it is on, only because the user turned it on. */
  startScreenShare(): Promise<ScreenShareStatus>;
  stopScreenShare(): Promise<ScreenShareStatus>;
  getScreenShare(): Promise<ScreenShareStatus>;
  /** The user is still here (talking about the screen): keeps sharing from stopping itself for being idle. */
  touchScreenShare(): void;
  askAboutScreen(request: ScreenAskRequest): Promise<ScreenAskResult>;
  /** Saves a picture of the screen on the Desktop (the user pressed Capture, which is their yes). */
  captureScreen(): Promise<{ readonly ok: boolean; readonly message: string }>;
  onScreenShareStatus(cb: (status: ScreenShareStatus) => void): () => void;
  onScreenFrame(cb: (frame: ScreenFrame) => void): () => void;
  /** The Files screen: your own folders as lists. Nothing here is sent anywhere unless you press "Ask Eya about this file". */
  listFiles(view: FilesView): Promise<FilesListing>;
  browseFolder(path: string): Promise<FilesListing>;
  searchFiles(query: string): Promise<FilesListing>;
  openFileItem(path: string): Promise<FileActionResult>;
  revealFileItem(path: string): Promise<FileActionResult>;
  /** Has Gemini read this file and answer (the file is sent to Gemini; the user pressed the button that says so). */
  askAboutFile(path: string, question: string): Promise<FileActionResult>;
  /** Small pictures for image files, as data URLs, by path. */
  fileThumbnails(paths: readonly string[]): Promise<Record<string, string>>;
}

declare global {
  interface Window {
    readonly eya: EyaBridge;
  }
}
