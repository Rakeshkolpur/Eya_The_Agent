import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '../shared/ipcContract';
import type {
  AudioRequest,
  CommunicationAccessState,
  EyaBridge,
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
  onToggleInput: (cb) => {
    const listener = () => cb();
    ipcRenderer.on(IpcChannels.toggleInput, listener);
    return () => ipcRenderer.off(IpcChannels.toggleInput, listener);
  },
  setExpanded: (expanded) => ipcRenderer.send(IpcChannels.setExpanded, expanded),
  onShowPanel: (cb) => {
    const listener = () => cb();
    ipcRenderer.on(IpcChannels.showPanel, listener);
    return () => ipcRenderer.off(IpcChannels.showPanel, listener);
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
  getLiveConfig: (voice) => ipcRenderer.invoke(IpcChannels.liveConfig, voice),
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
};

contextBridge.exposeInMainWorld('eya', bridge);
