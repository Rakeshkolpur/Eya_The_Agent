import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '../shared/ipcContract';
import type {
  AudioRequest,
  CommunicationAccessState,
  ActivitySnapshot,
  EyaBridge,
  MemorySnapshot,
  ScreenFrame,
  ScreenShareStatus,
  SettingsSnapshot,
  WindowModeState,
  WritingState,
  StatusMessage,
  TTSChunkMessage,
  TTSPrefetchMessage,
  TTSSpeakMessage,
  TTSStreamEndMessage,
  WakeDetection,
} from '../shared/ipcContract';
import type { AgentRequest, AgentUpdate, OrbState } from '../shared/types';

const bridge: EyaBridge = {
  submit: (request: AgentRequest) => ipcRenderer.invoke(IpcChannels.submitAgentRequest, request),
  submitAudio: (request: AudioRequest) => ipcRenderer.invoke(IpcChannels.submitAudioRequest, request),
  onAgentUpdate: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, u: AgentUpdate) => cb(u);
    ipcRenderer.on(IpcChannels.agentUpdate, listener);
    return () => ipcRenderer.off(IpcChannels.agentUpdate, listener);
  },
  onSetOrbState: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, s: OrbState) => cb(s);
    ipcRenderer.on(IpcChannels.setOrbState, listener);
    return () => ipcRenderer.off(IpcChannels.setOrbState, listener);
  },
  onStatus: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, s: StatusMessage) => cb(s);
    ipcRenderer.on(IpcChannels.status, listener);
    return () => ipcRenderer.off(IpcChannels.status, listener);
  },
  onTTSSpeak: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, m: TTSSpeakMessage) => cb(m);
    ipcRenderer.on(IpcChannels.ttsSpeak, listener);
    return () => ipcRenderer.off(IpcChannels.ttsSpeak, listener);
  },
  onTTSPrefetch: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, m: TTSPrefetchMessage) => cb(m);
    ipcRenderer.on(IpcChannels.ttsPrefetch, listener);
    return () => ipcRenderer.off(IpcChannels.ttsPrefetch, listener);
  },
  getLiveConfig: (voice, recent) => ipcRenderer.invoke(IpcChannels.liveConfig, voice, recent),
  runLiveTool: (request) => ipcRenderer.invoke(IpcChannels.liveToolCall, request),
  wakeAvailable: () => ipcRenderer.invoke(IpcChannels.wakeAvailable),
  sendWakeAudio: (samples16k) => ipcRenderer.send(IpcChannels.wakeAudioChunk, samples16k),
  onWakeDetected: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, which: WakeDetection) => cb(which);
    ipcRenderer.on(IpcChannels.wakeDetected, listener);
    return () => ipcRenderer.off(IpcChannels.wakeDetected, listener);
  },
  startTTSStream: (request) => ipcRenderer.invoke(IpcChannels.ttsStream, request),
  cancelTTSStream: (streamId) => ipcRenderer.send(IpcChannels.ttsStreamCancel, streamId),
  onTTSChunk: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, m: TTSChunkMessage) => cb(m);
    ipcRenderer.on(IpcChannels.ttsChunk, listener);
    return () => ipcRenderer.off(IpcChannels.ttsChunk, listener);
  },
  onTTSStreamEnd: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, m: TTSStreamEndMessage) => cb(m);
    ipcRenderer.on(IpcChannels.ttsStreamEnd, listener);
    return () => ipcRenderer.off(IpcChannels.ttsStreamEnd, listener);
  },
  onTTSStop: (cb) => {
    const listener = () => cb();
    ipcRenderer.on(IpcChannels.ttsStop, listener);
    return () => ipcRenderer.off(IpcChannels.ttsStop, listener);
  },
  ttsDone: (utteranceId: string) => ipcRenderer.send(IpcChannels.ttsDone, utteranceId),
  ttsReady: () => ipcRenderer.send(IpcChannels.ttsReady),
  getCommunicationAccess: () => ipcRenderer.invoke(IpcChannels.getCommunicationAccess),
  setCommunicationAccess: (change) => ipcRenderer.invoke(IpcChannels.setCommunicationAccess, change),
  onCommunicationAccessChanged: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, s: CommunicationAccessState) => cb(s);
    ipcRenderer.on(IpcChannels.communicationAccessChanged, listener);
    return () => ipcRenderer.off(IpcChannels.communicationAccessChanged, listener);
  },
  getMemory: () => ipcRenderer.invoke(IpcChannels.memoryGet),
  actOnMemory: (action) => ipcRenderer.invoke(IpcChannels.memoryAct, action),
  onMemoryChanged: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, s: MemorySnapshot) => cb(s);
    ipcRenderer.on(IpcChannels.memoryChanged, listener);
    return () => ipcRenderer.off(IpcChannels.memoryChanged, listener);
  },
  onMemorySuggestion: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, text: string) => cb(text);
    ipcRenderer.on(IpcChannels.memorySuggestion, listener);
    return () => ipcRenderer.off(IpcChannels.memorySuggestion, listener);
  },
  setWindowMode: (mode) => ipcRenderer.send(IpcChannels.windowSetMode, mode),
  getWindowMode: () => ipcRenderer.invoke(IpcChannels.windowGetMode),
  onWindowMode: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, s: WindowModeState) => cb(s);
    ipcRenderer.on(IpcChannels.windowMode, listener);
    return () => ipcRenderer.off(IpcChannels.windowMode, listener);
  },
  dragWindow: (phase) => ipcRenderer.send(IpcChannels.windowDrag, phase),
  showBubbleMenu: () => ipcRenderer.send(IpcChannels.windowMenu),
  getSettings: () => ipcRenderer.invoke(IpcChannels.settingsGet),
  setSettings: (patch) => ipcRenderer.invoke(IpcChannels.settingsSet, patch),
  onSettingsChanged: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, s: SettingsSnapshot) => cb(s);
    ipcRenderer.on(IpcChannels.settingsChanged, listener);
    return () => ipcRenderer.off(IpcChannels.settingsChanged, listener);
  },
  getActivity: () => ipcRenderer.invoke(IpcChannels.activityGet),
  actOnActivity: (action) => ipcRenderer.invoke(IpcChannels.activityAct, action),
  onActivityChanged: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, s: ActivitySnapshot) => cb(s);
    ipcRenderer.on(IpcChannels.activityChanged, listener);
    return () => ipcRenderer.off(IpcChannels.activityChanged, listener);
  },
  quitApp: () => ipcRenderer.send(IpcChannels.appQuit),
  relaunchApp: () => ipcRenderer.send(IpcChannels.appRelaunch),
  getGeminiKey: () => ipcRenderer.invoke(IpcChannels.geminiKeyGet),
  setGeminiKey: (key) => ipcRenderer.invoke(IpcChannels.geminiKeySet, key),
  clearGeminiKey: () => ipcRenderer.invoke(IpcChannels.geminiKeyClear),
  getBackupAi: () => ipcRenderer.invoke(IpcChannels.backupAiGet),
  setBackupAi: (input) => ipcRenderer.invoke(IpcChannels.backupAiSet, input),
  clearBackupAi: (id) => ipcRenderer.invoke(IpcChannels.backupAiClear, id),
  testBackupAi: (id) => ipcRenderer.invoke(IpcChannels.backupAiTest, id),
  getAiUsage: () => ipcRenderer.invoke(IpcChannels.aiUsageGet),
  setBackupAiModel: (model, id) => ipcRenderer.invoke(IpcChannels.backupAiSetModel, model, id),
  getAiRoute: () => ipcRenderer.invoke(IpcChannels.aiRouteGet),
  getTasks: () => ipcRenderer.invoke(IpcChannels.tasksGet),
  actOnTasks: (action) => ipcRenderer.invoke(IpcChannels.tasksAct, action),
  onTasksChanged: (listener) => {
    const handler = (_evt: unknown, snapshot: Parameters<typeof listener>[0]): void => listener(snapshot);
    ipcRenderer.on(IpcChannels.tasksChanged, handler);
    return () => ipcRenderer.off(IpcChannels.tasksChanged, handler);
  },
  onTasksSay: (listener) => {
    const handler = (_evt: unknown, say: Parameters<typeof listener>[0]): void => listener(say);
    ipcRenderer.on(IpcChannels.tasksSay, handler);
    return () => ipcRenderer.off(IpcChannels.tasksSay, handler);
  },
  onAiRoute: (listener) => {
    const handler = (_evt: unknown, route: Parameters<typeof listener>[0]): void => listener(route);
    ipcRenderer.on(IpcChannels.aiRoute, handler);
    return () => ipcRenderer.off(IpcChannels.aiRoute, handler);
  },
  getWriting: () => ipcRenderer.invoke(IpcChannels.writingGet),
  setWriting: (patch) => ipcRenderer.invoke(IpcChannels.writingSet, patch),
  actOnWriting: (action) => ipcRenderer.invoke(IpcChannels.writingAct, action),
  checkWriting: () => ipcRenderer.invoke(IpcChannels.writingCheck),
  onWritingChanged: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, s: WritingState) => cb(s);
    ipcRenderer.on(IpcChannels.writingChanged, listener);
    return () => ipcRenderer.off(IpcChannels.writingChanged, listener);
  },
  startScreenShare: () => ipcRenderer.invoke(IpcChannels.screenShareStart),
  stopScreenShare: () => ipcRenderer.invoke(IpcChannels.screenShareStop),
  getScreenShare: () => ipcRenderer.invoke(IpcChannels.screenShareGet),
  touchScreenShare: () => ipcRenderer.send(IpcChannels.screenShareTouch),
  askAboutScreen: (request) => ipcRenderer.invoke(IpcChannels.screenShareAsk, request),
  captureScreen: () => ipcRenderer.invoke(IpcChannels.screenShareCapture),
  onScreenShareStatus: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, s: ScreenShareStatus) => cb(s);
    ipcRenderer.on(IpcChannels.screenShareStatus, listener);
    return () => ipcRenderer.off(IpcChannels.screenShareStatus, listener);
  },
  onScreenFrame: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, f: ScreenFrame) => cb(f);
    ipcRenderer.on(IpcChannels.screenShareFrame, listener);
    return () => ipcRenderer.off(IpcChannels.screenShareFrame, listener);
  },
  listFiles: (view) => ipcRenderer.invoke(IpcChannels.filesList, view),
  browseFolder: (path) => ipcRenderer.invoke(IpcChannels.filesBrowse, path),
  searchFiles: (query) => ipcRenderer.invoke(IpcChannels.filesSearch, query),
  openFileItem: (path) => ipcRenderer.invoke(IpcChannels.filesOpen, path),
  revealFileItem: (path) => ipcRenderer.invoke(IpcChannels.filesReveal, path),
  askAboutFile: (path, question) => ipcRenderer.invoke(IpcChannels.filesAsk, path, question),
  fileThumbnails: (paths) => ipcRenderer.invoke(IpcChannels.filesThumbs, paths),
};

contextBridge.exposeInMainWorld('eya', bridge);
