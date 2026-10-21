import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OrbState, AgentResult } from '../shared/types';
import type { AiRouteStatus } from '../shared/aiRoute';
import type { TaskAction, TasksSnapshot } from '../shared/tasks';
import type {
  ActivityAction,
  ActivitySnapshot,
  CommunicationAccessChange,
  CommunicationAccessState,
  AiUsageStatus,
  BackupAiInput,
  BackupAiStatus,
  GeminiKeyStatus,
  MemoryAction,
  MemorySnapshot,
  ScreenAskRequest,
  ScreenFrame,
  ScreenShareStatus,
  SettingsPatch,
  WritingPatch,
  WritingState,
  SettingsSnapshot,
  StatusMessage,
  WindowMode,
  WindowModeState,
} from '../shared/ipcContract';
import { AppShell } from './AppShell';
import type { PageRequest } from './AppShell';
import { AssistantPanel } from './AssistantPanel';
import { Bubble } from './Bubble';
import { APP_PAGES, IDLE_SCREEN_ASK } from './control';
import type { AppPage, EyaControl, ScreenAskState } from './control';
import { addMessage, emptyThread, liveEnded, liveHeard, liveSaid } from './thread';
import type { ThreadState } from './thread';
import { statusLine } from './ui/format';
import { DEFAULT_VOICE, VOICE_OPTIONS } from '../shared/constants';
import { CuePicker } from '../shared/humanCues';
import { carryOnLine, shouldCarryOn, talkWay } from '../shared/liveFallback';
import type { LiveStop } from '../shared/liveFallback';
import { initRendererTTS, previewCloudVoice, setOfflineVoiceAllowed, setTTSEngine, setTTSMuted, setTTSVoice, speakPreview, stopSpeaking } from './tts';
import { DEFAULT_OPENAI_VOICE, isOpenAIVoice } from '../shared/openaiVoice';
import { createLiveListener } from './liveListener';
import { setMotionRate, useMotion } from './motion';
import type { LiveAudio } from './liveListener';
import { LocalStt } from './localStt';
import type { SttState } from './localStt';
import { TARGET_RATE, bytesToBase64, encodeWavPcm16 } from './wav';
import { LiveConversation } from './liveConversation';
import type { ConversationEnd, ConversationPhase } from './liveConversation';
import { LiveSession } from './liveSession';
import type { SocketLike } from './liveSession';
import { createPcmPlayback } from './pcmPlayer';
import { isConversationTrigger } from '../shared/wake';
import { WakeWordUplink } from './wakeWord';

const VOICE_STORAGE_KEY = 'eya.voice';
const VOICE_NAME_STORAGE_KEY = 'eya.voiceName';
const OPENAI_VOICE_STORAGE_KEY = 'eya.openaiVoice';
/** A hands-free conversation with ChatGPT ends after this long with nothing said (longer while Eya is keeping a task). */
const GPT_TALK_IDLE_MS = 45_000;
/** What ends a conversation when it is all that is said. */
const END_TALK_WORDS = /^(?:ok(?:ay)?[, ]+)?(?:stop|bye|good ?bye|that'?s all|that is all|thank you|thanks|never ?mind|enough)[\s.!]*$/i;
const LIVE_BAD_MODELS_KEY = 'eya.liveBadModels';
const INTERRUPT_STORAGE_KEY = 'eya.interrupt';

/** Talking over Eya is on by default (echo cancellation kept her voice out of the mic in testing); the pill turns it off. */
function readInterruptPreference(): boolean {
  try {
    return window.localStorage.getItem(INTERRUPT_STORAGE_KEY) !== 'off';
  } catch {
    return false;
  }
}

function readVoicePreference(): boolean {
  try {
    return window.localStorage.getItem(VOICE_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Escape hatch: localStorage['eya.sttBackend'] = 'wasm' keeps speech recognition on the processor. */
function readSttBackend(): 'auto' | 'wasm' {
  try {
    return window.localStorage.getItem('eya.sttBackend') === 'wasm' ? 'wasm' : 'auto';
  } catch {
    return 'auto';
  }
}

function readOpenaiVoice(): string {
  try {
    const saved = window.localStorage.getItem(OPENAI_VOICE_STORAGE_KEY);
    if (isOpenAIVoice(saved)) return saved;
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_OPENAI_VOICE;
}

function readVoiceName(): string {
  try {
    const saved = window.localStorage.getItem(VOICE_NAME_STORAGE_KEY);
    if (saved !== null && VOICE_OPTIONS.some((v) => v.id === saved)) return saved;
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_VOICE;
}

const PHASE_TO_ORB: Record<ConversationPhase, OrbState> = {
  connecting: 'thinking',
  listening: 'listening',
  thinking: 'thinking',
  working: 'working',
  speaking: 'speaking',
};

function endedMessage(reason: ConversationEnd, detail: string | undefined): string {
  switch (reason) {
    case 'user':
      return '';
    case 'idle':
      return 'Conversation ended after a quiet moment. Say "Hey Eya" to talk again.';
    case 'closed':
      return `Live voice disconnected${detail !== undefined && detail.length > 0 ? ` (${detail})` : ''}.`;
    case 'error':
      return 'Live voice hit a problem.';
  }
}

function randomId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function OrbApp(): JSX.Element {
  const [state, setState] = useState<OrbState>('idle');
  const [transcript, setTranscript] = useState<string>('');
  // Eya's one window is a bubble, the quick assistant that grows out of it, or the full app. The main process owns which (and where).
  const [win, setWin] = useState<WindowModeState>({ mode: 'bubble', anchor: 'bottom-right' });
  const [pageRequest, setPageRequest] = useState<PageRequest | null>(null);
  const [thread, setThread] = useState<ThreadState>(emptyThread);
  // What was said so far, for a live conversation that has to start again (it ended, or the connection was cut): it is told, so it does not
  // begin knowing nothing and ask the user to explain it all again.
  const threadRef = useRef(thread);
  threadRef.current = thread;
  /** When the last Live conversation ended: for a while after it, what is said next is sent with the conversation so far. */
  const liveEndedAt = useRef(0);
  const canHearRef = useRef(false);
  /** Live voice stopped and the chat carries on in the other way of talking: the voice follows the AI that can answer, not only the chosen one. */
  const [liveFallback, setLiveFallback] = useState(false);
  const carryOnRef = useRef<(stop: LiveStop) => void>(() => undefined);
  /**
   * The conversation so far, to send along with what is said next while a chat is being carried from one way of talking to another (a
   * hands-free chat is going, or a Live conversation ended a few minutes ago): the AI that answers carries on instead of starting blank.
   * Nothing is sent for an ordinary request, which keeps the usual small size.
   */
  const historyFor = (currentText: string): { history: Array<{ who: 'user' | 'eya'; text: string }> } | Record<string, never> => {
    if (!(gptTalkRef.current || Date.now() - liveEndedAt.current < 10 * 60_000)) return {};
    const lines = threadRef.current.messages
      .filter((m) => m.text !== currentText)
      .slice(-12)
      .map((m) => ({ who: m.role, text: m.text }));
    return lines.length > 0 ? { history: lines } : {};
  };
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [activity, setActivity] = useState<ActivitySnapshot | null>(null);
  // Screen sharing: whether Eya is looking, the newest picture of the screen, and the latest question asked about it.
  const [share, setShare] = useState<ScreenShareStatus>({ active: false, paused: null, startedAt: null, frames: 0 });
  const [frame, setFrame] = useState<ScreenFrame | null>(null);
  const [screenAsk, setScreenAsk] = useState<ScreenAskState>(IDLE_SCREEN_ASK);
  const [providerStatus, setProviderStatus] = useState<StatusMessage | null>(null);
  const [voiceOn, setVoiceOn] = useState<boolean>(readVoicePreference);
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const [interruptOn, setInterruptOn] = useState<boolean>(readInterruptPreference);
  const levelLog = useRef<Array<[number, number]>>([]); // dev only: recent microphone levels
  const [wakeAvailable, setWakeAvailable] = useState<boolean>(false);
  const wakeUplink = useMemo(() => new WakeWordUplink((samples16k) => window.eya.sendWakeAudio(samples16k)), []);
  const [ttsBusy, setTtsBusy] = useState(false);
  const [voiceName, setVoiceName] = useState<string>(readVoiceName);
  const [openaiVoiceName, setOpenaiVoiceName] = useState<string>(readOpenaiVoice);
  /** A hands-free conversation with ChatGPT (heard on this PC, answered by ChatGPT, spoken in its voice). The Gemini Live one is `talk`. */
  const [gptTalk, setGptTalk] = useState(false);
  const [sttState, setSttState] = useState<SttState>('idle');
  const [talk, setTalk] = useState<'off' | 'connecting' | 'on'>('off');
  // Communication Access: the user's switch for whether Eya may look at or use chat apps. OFF until they turn it on here.
  const [comm, setComm] = useState<CommunicationAccessState | null>(null);
  const [geminiKey, setGeminiKey] = useState<GeminiKeyStatus | null>(null);
  useEffect(() => {
    void window.eya.getGeminiKey().then(setGeminiKey).catch(() => undefined);
  }, []);
  const saveGeminiKey = useCallback(async (key: string) => {
    const result = await window.eya.setGeminiKey(key);
    setGeminiKey(result.status);
    return result;
  }, []);
  const removeGeminiKey = useCallback(async () => {
    const result = await window.eya.clearGeminiKey();
    setGeminiKey(result.status);
    return result;
  }, []);
  // The tasks Eya is keeping, kept up to date as they change. While any is open a quiet live conversation is not ended (see below).
  const [tasks, setTasks] = useState<TasksSnapshot | null>(null);
  const tasksOpenRef = useRef(0);
  tasksOpenRef.current = tasks?.open ?? 0;
  useEffect(() => {
    void window.eya.getTasks().then(setTasks).catch(() => undefined);
    return window.eya.onTasksChanged(setTasks);
  }, []);
  const actOnTasks = useCallback((action: TaskAction) => {
    void window.eya.actOnTasks(action).then(setTasks).catch(() => undefined);
  }, []);
  const [backupAi, setBackupAi] = useState<BackupAiStatus | null>(null);
  const [aiRoute, setAiRoute] = useState<AiRouteStatus | null>(null);
  useEffect(() => {
    void window.eya.getAiRoute().then(setAiRoute).catch(() => undefined);
    return window.eya.onAiRoute(setAiRoute);
  }, []);
  // Nothing announces the moment Gemini's rest ends, so look again then: the badge goes back to "Gemini connected" by itself.
  const geminiBackAt = aiRoute?.geminiBackAt ?? null;
  useEffect(() => {
    if (geminiBackAt === null) return undefined;
    const t = window.setTimeout(() => void window.eya.getAiRoute().then(setAiRoute).catch(() => undefined), Math.max(1000, geminiBackAt - Date.now() + 1000));
    return () => window.clearTimeout(t);
  }, [geminiBackAt]);
  const [aiUsage, setAiUsage] = useState<AiUsageStatus | null>(null);
  const refreshAiUsage = useCallback(() => {
    void window.eya.getAiUsage().then(setAiUsage).catch(() => undefined);
  }, []);
  useEffect(() => {
    void window.eya.getBackupAi().then(setBackupAi).catch(() => undefined);
    refreshAiUsage();
  }, [refreshAiUsage]);
  const chooseAi = useCallback(async (choice: 'auto' | { readonly id: string; readonly model: string }) => {
    if (choice !== 'auto') {
      const r = await window.eya.setBackupAiModel(choice.model, choice.id).catch(() => null);
      if (r !== null) setBackupAi(r.status);
      if (r === null || !r.ok) return;
    }
    const snapshot = await window.eya.setSettings({ aiFirst: choice === 'auto' ? 'auto' : 'backup' }).catch(() => null);
    if (snapshot !== null) setSettings(snapshot);
    void window.eya.getAiRoute().then(setAiRoute).catch(() => undefined);
    if (choice !== 'auto') {
      // Find out at once whether the one just chosen can answer, and say so, instead of leaving the person to wonder why another AI
      // keeps answering (its account may be empty, its key refused).
      void window.eya
        .testBackupAi(choice.id)
        .then((t) => {
          setBackupAi(t.status);
          void window.eya.getAiRoute().then(setAiRoute).catch(() => undefined);
          setTranscript(t.message);
        })
        .catch(() => undefined);
    }
  }, []);
  const saveBackupAi = useCallback(
    async (input: BackupAiInput) => {
      const result = await window.eya.setBackupAi(input);
      setBackupAi(result.status);
      // The OpenAI key is for using ChatGPT: it becomes the AI Eya asks first (and speaks with), until the person picks another.
      if (result.ok && input.provider === 'openai') {
        const entry = result.status.entries.find((e) => e.id === 'openai');
        if (entry !== undefined) {
          await chooseAi({ id: 'openai', model: entry.model });
          return { ...result, message: `${result.message} ChatGPT is now the main AI, and Eya speaks with ChatGPT's voice. To change it, use the AI list at the top (Automatic goes back to Gemini first).` };
        }
      }
      return result;
    },
    [chooseAi],
  );
  const removeBackupAi = useCallback(async (id?: string) => {
    const result = await window.eya.clearBackupAi(id);
    setBackupAi(result.status);
    return result;
  }, []);
  const testBackupAi = useCallback(async (id?: string) => {
    const result = await window.eya.testBackupAi(id);
    setBackupAi(result.status);
    void window.eya.getAiRoute().then(setAiRoute).catch(() => undefined);
    return result;
  }, []);
  const [writing, setWritingState] = useState<WritingState | null>(null);
  useEffect(() => {
    void window.eya.getWriting().then(setWritingState).catch(() => undefined);
    return window.eya.onWritingChanged(setWritingState);
  }, []);
  const setWriting = useCallback(async (patch: WritingPatch) => {
    setWritingState(await window.eya.setWriting(patch));
  }, []);
  const checkWriting = useCallback(() => window.eya.checkWriting(), []);
  useEffect(() => {
    void window.eya.getCommunicationAccess().then(setComm).catch(() => undefined);
    return window.eya.onCommunicationAccessChanged(setComm);
  }, []);
  useEffect(() => {
    void window.eya.getWindowMode().then((m) => setWin({ mode: m.mode, anchor: m.anchor })).catch(() => undefined);
    return window.eya.onWindowMode((m) => {
      setWin({ mode: m.mode, anchor: m.anchor });
      const page = m.page;
      if (m.mode === 'app' && page !== undefined && (APP_PAGES as readonly string[]).includes(page)) {
        setPageRequest((prev) => ({ page: page as AppPage, n: (prev?.n ?? 0) + 1 }));
      }
    });
  }, []);
  useEffect(() => {
    void window.eya.getSettings().then(setSettings).catch(() => undefined);
    return window.eya.onSettingsChanged(setSettings);
  }, []);
  // The performance level running decides how fast things may move and whether the offline voice may load.
  const runningPerformance = settings?.info.performance;
  useEffect(() => {
    if (runningPerformance === undefined) return;
    setMotionRate(runningPerformance.motionPerSecond);
    setOfflineVoiceAllowed(runningPerformance.offlineVoice);
  }, [runningPerformance?.motionPerSecond, runningPerformance?.offlineVoice]);
  useEffect(() => {
    void window.eya.getActivity().then(setActivity).catch(() => undefined);
    return window.eya.onActivityChanged(setActivity);
  }, []);
  const changeSettings = useCallback((patch: SettingsPatch) => {
    void window.eya.setSettings(patch).then(setSettings).catch(() => undefined);
  }, []);
  const actOnActivity = useCallback((action: ActivityAction) => {
    void window.eya.actOnActivity(action).then(setActivity).catch(() => undefined);
  }, []);
  const setWindowMode = useCallback((mode: WindowMode) => window.eya.setWindowMode(mode), []);
  const applyShareStatus = useCallback((s: ScreenShareStatus) => {
    setShare(s);
    // Nothing is shown from a screen that is not being shared, or while it is paused (a chat app is showing).
    if (!s.active || s.paused !== null) setFrame(null);
  }, []);
  useEffect(() => {
    void window.eya.getScreenShare().then(applyShareStatus).catch(() => undefined);
    const offStatus = window.eya.onScreenShareStatus(applyShareStatus);
    const offFrame = window.eya.onScreenFrame(setFrame);
    return () => {
      offStatus();
      offFrame();
    };
  }, [applyShareStatus]);
  const startShare = useCallback(() => {
    void window.eya.startScreenShare().then(applyShareStatus).catch(() => undefined);
  }, [applyShareStatus]);
  const stopShare = useCallback(() => {
    void window.eya.stopScreenShare().then(applyShareStatus).catch(() => undefined);
    setScreenAsk(IDLE_SCREEN_ASK);
  }, [applyShareStatus]);
  // Memory: what Eya was asked to remember and the routines she has learned (a local database), and any open offer to save one.
  const [memory, setMemory] = useState<MemorySnapshot | null>(null);
  useEffect(() => {
    void window.eya.getMemory().then(setMemory).catch(() => undefined);
    return window.eya.onMemoryChanged(setMemory);
  }, []);
  const actOnMemory = useCallback(async (action: MemoryAction) => {
    const result = await window.eya.actOnMemory(action);
    setMemory(result.snapshot);
    return result;
  }, []);
  const changeComm = useCallback((change: CommunicationAccessChange) => {
    void window.eya.setCommunicationAccess(change).then(setComm).catch(() => undefined);
  }, []);
  const voiceNameRef = useRef(voiceName);
  voiceNameRef.current = voiceName;
  const micSink = useRef<((chunk: Float32Array, sampleRate: number) => void) | null>(null);
  const hearRef = useRef<((samples16k: Float32Array) => Promise<void>) | null>(null);
  const listener = useMemo(() => createLiveListener(), []);
  const slowCue = useRef<(name: string, args?: Readonly<Record<string, unknown>>, stage?: 'start' | 'slow' | 'long') => void>(() => undefined);
  const cuePicker = useMemo(() => new CuePicker(), []);
  const localStt = useMemo(
    () =>
      new LocalStt(() => new Worker(new URL('./sttWorker.ts', import.meta.url), { type: 'module' }), {
        transcribeTimeoutMs: 12_000,
        backend: readSttBackend(),
      }),
    [],
  );

  // A live spoken conversation with Gemini (its own voice, tools, interruptions).
  const conversation = useMemo(() => {
    let heardShown = '';
    let saidShown = '';
    const show = (): void => {
      const lines = [heardShown && `You: ${heardShown}`, saidShown && `Eya: ${saidShown}`].filter(Boolean);
      setTranscript(lines.length > 0 ? lines.join('\n\n') : 'Listening…');
    };
    return new LiveConversation(
      {
        getConfig: () => window.eya.getLiveConfig(voiceNameRef.current, threadRef.current.messages.slice(-14).map((m) => ({ who: m.role, text: m.text }))),
        runTool: async (name, args, context) => {
          const started = performance.now();
          const { content } = await window.eya.runLiveTool({
            name,
            args,
            ...(context !== undefined ? { ...(context.heard !== '' ? { heard: context.heard } : {}), turn: context.turn } : {}),
          });
          console.info(`[eya] live: tool ${name} finished in ${Math.round(performance.now() - started)}ms`);
          return content;
        },
        makeSession: () => new LiveSession((url) => new WebSocket(url) as unknown as SocketLike),
        // Which Live models have been cutting conversations off: kept across restarts, so a broken one is not tried first again.
        modelHealth: {
          load: () => {
            try {
              const parsed: unknown = JSON.parse(window.localStorage.getItem(LIVE_BAD_MODELS_KEY) ?? '{}');
              return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, number>) : {};
            } catch {
              return {};
            }
          },
          save: (triedLastUntil) => {
            try {
              window.localStorage.setItem(LIVE_BAD_MODELS_KEY, JSON.stringify(triedLastUntil));
            } catch {
              // Not being able to remember is fine.
            }
          },
        },
        createPlayback: () => createPcmPlayback(),
        keepOpen: () => tasksOpenRef.current > 0,
        setFrameSink: (sink) => {
          micSink.current = sink;
          listener.setFrameSink(sink);
        },
      },
      {
        onPhase: (phase) => {
          console.info(`[eya] live: ${phase}`);
          if (phase === 'speaking') stopSpeaking(); // the real voice takes over from any short cue
          setTalk(phase === 'connecting' ? 'connecting' : 'on');
          setState(PHASE_TO_ORB[phase]);
        },
        onHeard: (text) => {
          console.info(`[eya] live: heard "${text}"`);
          heardShown = text;
          setThread((t) => liveHeard(t, text));
          show();
        },
        onSaid: (text) => {
          if (text.length > 0) console.info(`[eya] live: said "${text}"`);
          saidShown = text;
          setThread((t) => liveSaid(t, text));
          show();
        },
        onReconnecting: (failedModel, reason) => {
          console.info(`[eya] live: ${failedModel} was cut off (${reason}); reopening on another model`);
        },
        onSlowTool: (name, args, stage) => {
          console.info(`[eya] live: ${name} is slow, saying so (${stage ?? 'start'})`);
          slowCue.current(name, args, stage);
        },
        onEnded: (reason, detail) => {
          console.info(`[eya] live: ended (${reason})${detail !== undefined ? ` ${detail}` : ''}`);
          heardShown = '';
          saidShown = '';
          setThread(liveEnded);
          setTalk('off');
          setState('idle');
          setTranscript(endedMessage(reason, detail));
          liveEndedAt.current = Date.now();
          // It gave out (its limit, a dropped connection): the chat does not end, it carries on the other way.
          if (reason === 'closed' || reason === 'error') carryOnRef.current(reason);
        },
      },
    );
  }, [listener]);

  // A tool is taking a while: say so in Eya's usual voice, with the mic muted so
  // she cannot hear herself and answer.
  useEffect(() => {
    slowCue.current = (name, args, stage) => {
      conversation.muteMicFor(30_000);
      const started = performance.now();
      const phrase = cuePicker.pick({ tool: name, args, stage: stage ?? 'start' });
      void speakPreview(phrase).finally(() => {
        console.info(`[eya] live: cue "${phrase}" finished after ${Math.round(performance.now() - started)}ms`);
        conversation.muteMicFor(300);
      });
    };
  }, [conversation, cuePicker]);

  // In a live conversation Eya's offer to save a repeated task is hers to say (the live model never hears it): wait until the model
  // has stopped speaking, then say it in her usual voice with the mic muted so she cannot hear herself and answer. Outside a live
  // conversation the offer is already part of the reply she just spoke, so nothing is said twice.
  const talkRef = useRef(talk);
  talkRef.current = talk;
  const orbStateRef = useRef(state);
  orbStateRef.current = state;
  useEffect(
    () =>
      window.eya.onMemorySuggestion((text) => {
        if (talkRef.current !== 'on') return;
        void (async () => {
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline && (orbStateRef.current === 'speaking' || orbStateRef.current === 'working')) {
            await new Promise<void>((resolve) => setTimeout(resolve, 300));
          }
          if (talkRef.current !== 'on') return;
          conversation.muteMicFor(30_000);
          await speakPreview(text).catch(() => undefined);
          conversation.muteMicFor(300);
        })();
      }),
    [conversation],
  );

  useEffect(() => {
    window.eya.wakeAvailable().then(setWakeAvailable).catch(() => setWakeAvailable(false));
  }, []);

  // ChatGPT is the main AI when the person chose it (it is the first backup and "the backup first" is on): then Eya speaks with its voice only.
  const gptFirst = aiRoute !== null && aiRoute.prefer === 'backup' && aiRoute.backups[0]?.id === 'openai';
  const aiRouteRef = useRef(aiRoute);
  aiRouteRef.current = aiRoute;
  // ChatGPT's voice also speaks when the chat was carried over from Gemini Live and ChatGPT can answer (it has a key, and is not out of credit).
  const openaiUsable = (aiRoute?.backups.some((b) => b.id === 'openai') ?? false) && !(aiRoute?.passedOver ?? []).some((p) => p.label === 'OpenAI' && (p.why === 'credit' || p.why === 'refused'));
  const speakWithOpenai = gptFirst || (liveFallback && openaiUsable);
  useEffect(() => {
    setTTSEngine(speakWithOpenai ? 'openai' : 'gemini', openaiVoiceName);
  }, [speakWithOpenai, openaiVoiceName]);
  const changeOpenaiVoice = useCallback((next: string) => {
    if (!isOpenAIVoice(next)) return;
    setOpenaiVoiceName(next);
    try {
      window.localStorage.setItem(OPENAI_VOICE_STORAGE_KEY, next);
    } catch {
      // Preference just won't persist.
    }
  }, []);
  /** Plays a sample in one of ChatGPT's voices; false when it could not (no key, no credit, no connection). */
  const previewOpenaiVoice = useCallback((voice: string) => previewCloudVoice('openai', voice, "Hi, I'm Eya. This is how I sound."), []);

  const gptTalkRef = useRef(false);
  const gptLastActive = useRef(0);
  const startGptTalk = useCallback(async (): Promise<string> => {
    if (gptTalkRef.current) return 'ok';
    gptTalkRef.current = true;
    gptLastActive.current = Date.now();
    setGptTalk(true);
    setState('listening');
    setTranscript('Listening…');
    return 'ok';
  }, []);
  const endGptTalk = useCallback(() => {
    if (!gptTalkRef.current) return;
    gptTalkRef.current = false;
    setGptTalk(false);
    setLiveFallback(false);
    setState((s) => (s === 'listening' ? 'idle' : s));
  }, []);
  // Ends itself after a quiet while (not while she is answering, and later while she is keeping a task for the person).
  useEffect(() => {
    if (!gptTalk) return undefined;
    const t = window.setInterval(() => {
      const s = orbStateRef.current;
      if (s === 'speaking' || s === 'thinking' || s === 'working') {
        gptLastActive.current = Date.now();
        return;
      }
      const limit = tasksOpenRef.current > 0 ? 10 * 60_000 : GPT_TALK_IDLE_MS;
      if (Date.now() - gptLastActive.current > limit) {
        endGptTalk();
        setTranscript('We stopped talking after a quiet while. Say "Hey Eya" to start again.');
      }
    }, 2000);
    return () => window.clearInterval(t);
  }, [gptTalk, endGptTalk]);
  /** Ends whichever conversation is going: Gemini Live's or ChatGPT's. */
  const endTalk = useCallback(() => {
    endGptTalk();
    conversation.stop('user');
  }, [endGptTalk, conversation]);

  const startTalk = useCallback(async (): Promise<string> => {
    // Which way to talk follows the AI that is chosen (or can answer), decided from the freshest word on it: Gemini's live voice would answer
    // with Gemini whatever was chosen, and would only fail when Gemini cannot answer.
    const route = (await window.eya.getAiRoute().catch(() => null)) ?? aiRouteRef.current;
    if (talkWay(route) === 'hands-free') {
      if (route?.prefer !== 'backup') setLiveFallback(true);
      return startGptTalk();
    }
    if (conversation.active) return 'ok';
    const result = await conversation.start();
    if (result.ok) {
      setLiveFallback(false);
      return 'ok';
    }
    setTalk('off');
    setState('idle');
    setTranscript(result.reason);
    // Live voice cannot start (its limit, no connection): the chat still goes on, the other way.
    if (shouldCarryOn({ stop: 'start-failed', voiceOn: voiceOnRef.current, canHear: canHearRef.current, alreadyTalking: gptTalkRef.current })) {
      carryOnRef.current('start-failed');
      return 'ok';
    }
    return result.reason;
  }, [conversation, startGptTalk]);

  // Carrying the chat over from Gemini Live to the other way of talking: heard on this PC, answered by the next AI that can (ChatGPT when it
  // is set up), spoken in an AI voice, with the conversation so far sent along so nothing has to be said again.
  carryOnRef.current = (stop) => {
    if (!shouldCarryOn({ stop, voiceOn: voiceOnRef.current, canHear: canHearRef.current, alreadyTalking: gptTalkRef.current })) return;
    setLiveFallback(true);
    void startGptTalk().then(() => {
      const line = carryOnLine(stop);
      setTranscript(line);
      // The microphone is paused while she speaks, but that starts with "thinking" and there is none here: pause it before the first
      // word, or her own voice is heard as the person's and answered.
      setState('speaking');
      void speakPreview(line)
        .catch(() => undefined)
        .finally(() => setState((s) => (s === 'speaking' ? 'listening' : s)));
    });
  };

  useEffect(() => {
    conversation.setBargeIn(interruptOn);
  }, [interruptOn, conversation]);

  const toggleInterrupt = useCallback(() => {
    const next = !interruptOn;
    setInterruptOn(next);
    try {
      window.localStorage.setItem(INTERRUPT_STORAGE_KEY, next ? 'on' : 'off');
    } catch {
      // The choice still applies for this session.
    }
  }, [interruptOn]);

  const toggleTalk = useCallback(() => {
    if (talk === 'off' && !gptTalk) void startTalk();
    else endTalk();
  }, [talk, gptTalk, startTalk, endTalk]);

  // Acoustic wake word: "hey Eya" is recognized as sound on this PC (a small
  // keyword-spotting model), not by waiting for a whole utterance to be
  // transcribed. Falls back to noticing the name in transcribed text (below)
  // if the model could not be loaded.
  useEffect(() => {
    return window.eya.onWakeDetected((which) => {
      if (talk !== 'off' || gptTalkRef.current || !voiceOn) return;
      console.info(`[eya] wake word heard (${which}); opening a live conversation`);
      void startTalk();
    });
  }, [talk, voiceOn, startTalk]);

  useEffect(() => {
    const active = wakeAvailable && voiceOn && talk === 'off' && !gptTalk;
    listener.setWakeSink(active ? (chunk, rate) => wakeUplink.push(chunk, rate) : null);
    if (!active) wakeUplink.reset();
  }, [wakeAvailable, voiceOn, talk, gptTalk, listener, wakeUplink]);

  // Load on-device speech recognition in the background. Until it is ready
  // (first run downloads the model), speech goes to the cloud instead.
  useEffect(() => {
    const off = localStt.onState((state, detail) => {
      setSttState(state);
      if (detail !== undefined) console.info(`[eya] speech model: ${state}, ${detail}`);
    });
    localStt.start();
    if (import.meta.env.DEV) {
      window.__eyaDebug = {
        transcribeLocal: (samples) => localStt.transcribe(samples),
        sttState: () => localStt.state,
        startTalk: () => startTalk(),
        stopTalk: () => endTalk(),
        setBargeIn: (on) => setInterruptOn(on),
        micLevels: () => levelLog.current.slice(),
        talkActive: () => conversation.active,
        // Runs a spoken clip through the same handler the microphone uses.
        hearUtterance: (samples16k) => hearRef.current?.(samples16k) ?? Promise.resolve(),
        // Feeds microphone-style audio into the conversation, as if spoken.
        pushMic: (samples16k) => {
          for (let i = 0; i < samples16k.length; i += 128) {
            micSink.current?.(samples16k.subarray(i, i + 128), 16_000);
          }
        },
        // Feeds 16kHz audio straight to the wake-word model, bypassing capture.
        pushWakeAudio: (samples16k) => window.eya.sendWakeAudio(samples16k),
        previewMemory: (snapshot) => setMemory(snapshot as MemorySnapshot),
        seedThread: (lines) => setThread((t) => lines.reduce((acc, l) => addMessage(acc, l.who, l.text, 'live'), t)),
        gptTalkActive: () => gptTalkRef.current,
      };
    }
    return off;
  }, [localStt, startTalk, conversation]);

  useEffect(() => {
    initRendererTTS(
      () => {
        setTtsBusy(true);
        setState('speaking');
      },
      () => {
        setTtsBusy(false);
        setState((s) => (s === 'speaking' ? 'idle' : s));
      },
    );
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener?.('voiceschanged', () => {
      window.speechSynthesis.getVoices();
    });
  }, []);

  useEffect(() => {
    const offState = window.eya.onSetOrbState((s) => setState(s));
    const offStatus = window.eya.onStatus((s) => setProviderStatus(s));
    const offUpdate = window.eya.onAgentUpdate((update) => {
      setState(update.state);
      if (update.message !== undefined) setTranscript(update.message);
    });
    return () => {
      offState();
      offStatus();
      offUpdate();
    };
  }, []);

  const submitText = useCallback(async (text: string) => {
    const t = text.trim();
    if (t.length === 0) return;
    setTranscript(`" ${t} "`);
    setThread((th) => addMessage(th, 'user', t, 'typed'));
    try {
      const result: AgentResult = await window.eya.submit({
        text: t,
        source: 'text',
        requestId: randomId(),
        ...historyFor(t),
      });
      setTranscript(result.spoken);
      setThread((th) => addMessage(th, 'eya', result.spoken, 'typed'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTranscript(message);
      setThread((th) => addMessage(th, 'eya', message, 'typed'));
      setState('error');
    }
  }, []);

  const submitUtterance = useCallback(async (audio: LiveAudio) => {
    setState('thinking');
    setTranscript('Transcribing…');
    const showResult = (result: AgentResult): void => {
      // Noise that produced no words comes back with nothing to say.
      setTranscript(result.spoken.length > 0 ? result.spoken : '');
      setThread((th) => addMessage(th, 'eya', result.spoken, 'voice'));
    };
    try {
      // 1. On this PC: no request, no quota, no network round trip.
      const started = performance.now();
      const text = await localStt.transcribe(audio.samples16k);
      if (text !== null) {
        console.info(`[eya] heard on this PC in ${Math.round(performance.now() - started)}ms: "${text}"`);
        if (text.length === 0) {
          setState((s) => (s === 'thinking' ? 'idle' : s));
          setTranscript('');
          return;
        }
        // Just calling her by name ("Hey Eya") opens a live conversation.
        if (isConversationTrigger(text)) {
          console.info('[eya] called by name; opening a live conversation');
          await startTalk();
          return;
        }
        setTranscript(`Heard: "${text}"`);
        setThread((th) => addMessage(th, 'user', text, 'voice'));
        // In a conversation with ChatGPT everything said to her is meant for her (so she answers questions too); "thanks" or "bye" ends it.
        const chatting = gptTalkRef.current;
        if (chatting && END_TALK_WORDS.test(text)) {
          endGptTalk();
          setState('idle');
          setTranscript('Okay.');
          void speakPreview('Okay.');
          return;
        }
        if (chatting) gptLastActive.current = Date.now();
        showResult(await window.eya.submit({ text, source: 'voice', requestId: randomId(), ...(chatting ? {} : { live: true }), ...historyFor(text) }));
        if (chatting) gptLastActive.current = Date.now();
        return;
      }

      // 2. Not ready or failed: have Gemini transcribe it instead.
      showResult(
        await window.eya.submitAudio({
          requestId: randomId(),
          audioBase64: bytesToBase64(encodeWavPcm16(audio.samples16k, TARGET_RATE)),
          mimeType: 'audio/wav',
          live: true,
        }),
      );
    } catch (err) {
      console.error('[eya] could not process speech', err instanceof Error ? err.message : String(err));
      setTranscript(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  }, [localStt, startTalk, endGptTalk]);

  useEffect(() => {
    hearRef.current = (samples16k) => submitUtterance({ samples16k, durationMs: (samples16k.length / 16) });
  }, [submitUtterance]);

  // Voice = listening + speaking. One switch controls both.
  const canTranscribe = providerStatus?.ai === 'gemini' && providerStatus.aiReady;

  useEffect(() => {
    setTTSMuted(!voiceOn);
    // Turning voice off ends any live conversation too.
    if (!voiceOn) endTalk();
  }, [voiceOn, endTalk]);

  useEffect(() => {
    setTTSVoice(voiceName);
  }, [voiceName]);

  const changeVoiceName = useCallback((next: string) => {
    setVoiceName(next);
    setTTSVoice(next);
    try {
      window.localStorage.setItem(VOICE_NAME_STORAGE_KEY, next);
    } catch {
      // Preference just won't persist.
    }
    void speakPreview("Hi, I'm Eya. This is how I sound.");
  }, []);

  // Listen whenever anything can turn speech into text: on this PC (works even
  // when Gemini is out of quota, for simple commands) or via Gemini.
  const canHear = canTranscribe || sttState === 'ready';
  canHearRef.current = canHear;

  useEffect(() => {
    if (!voiceOn || !canHear) return undefined;
    void listener
      .start({
        onSpeechStart: () => {
          setState((s) => (s === 'idle' ? 'listening' : s));
          setTranscript('Listening…');
        },
        onDiscard: () => {
          setState((s) => (s === 'listening' ? 'idle' : s));
          setTranscript('');
        },
        onUtterance: (audio) => void submitUtterance(audio),
        onLevel: (l) => {
          setLevel(l);
          if (import.meta.env.DEV) {
            levelLog.current.push([performance.now(), l]);
            if (levelLog.current.length > 3000) levelLog.current.splice(0, 1000);
          }
        },
        onError: (msg) => {
          console.error('[eya] voice listening error', msg);
          setListening(false);
          setLevel(0);
          setTranscript(`Voice stopped: ${msg}`);
        },
      })
      .then((ok) => setListening(ok));
    return () => {
      listener.stop();
      setListening(false);
      setLevel(0);
    };
  }, [voiceOn, canHear, listener, submitUtterance]);

  // Never listen while Eya is talking or working: her own voice would
  // otherwise be picked up as a new command.
  useEffect(() => {
    listener.setPaused(ttsBusy || state === 'thinking' || state === 'working' || state === 'speaking');
  }, [ttsBusy, state, listener]);

  const toggleVoice = useCallback(() => {
    const next = !voiceOn;
    setVoiceOn(next);
    try {
      window.localStorage.setItem(VOICE_STORAGE_KEY, next ? 'on' : 'off');
    } catch {
      // Preference just won't persist.
    }
    if (!next) {
      setState((s) => (s === 'listening' || s === 'speaking' ? 'idle' : s));
      setTranscript('Voice is off.');
    } else {
      setTranscript('');
    }
  }, [voiceOn]);

  // Clicking the bubble opens the quick assistant (and, like tapping a phone assistant, starts a live conversation if that is switched on);
  // clicking it again puts it away.
  const onBubbleClick = useCallback(() => {
    if (win.mode !== 'bubble') {
      // Tapping the bubble again is "stop": it ends the conversation the first tap started, as well as putting the panel away.
      if (talk !== 'off' || gptTalk) endTalk();
      window.eya.setWindowMode('bubble');
      return;
    }
    window.eya.setWindowMode('assistant');
    if (settings?.settings.tapToTalk !== false && voiceOn && talk === 'off' && !gptTalk && canHear) void startTalk();
  }, [win.mode, settings, voiceOn, talk, gptTalk, canHear, startTalk, endTalk]);

  // Escape puts the quick assistant away. (Not the full app, and not while typing in a box: those use Escape to cancel an edit.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || win.mode !== 'assistant') return;
      const target = e.target instanceof HTMLElement ? e.target.tagName : '';
      if (target === 'INPUT' || target === 'SELECT' || target === 'TEXTAREA') return;
      window.eya.setWindowMode('bubble');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [win.mode]);

  // ---- looking at the screen together
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;

  // Eya has something to say about a task nobody has said yet (a step that finished late, a question that is now waiting for their yes).
  // In a live conversation the model is told, so it says it in its own voice and waits for their answer; otherwise she says it herself.
  useEffect(
    () =>
      window.eya.onTasksSay((say) => {
        void (async () => {
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline && (orbStateRef.current === 'speaking' || orbStateRef.current === 'working')) {
            await new Promise<void>((resolve) => setTimeout(resolve, 300));
          }
          if (talkRef.current === 'on') {
            const line =
              say.kind === 'ask'
                ? `[Eya's note] The step you started has finished, and it asks the user this: "${say.text}" Ask the user exactly that in your own words, wait for THEIR answer, then call quick_command again so it is carried out. Never answer it for them.`
                : say.kind === 'done'
                  ? `[Eya's note] The step that was taking long has finished: "${say.text}" Tell the user in a few words.`
                  : `[Eya's note] Tell the user in a few words: ${say.text}`;
            if (conversation.tell(line)) return;
          }
          if (voiceOnRef.current && say.text.trim() !== '') await speakPreview(say.text).catch(() => undefined);
        })();
      }),
    [conversation],
  );
  const frameRef = useRef<ScreenFrame | null>(null);
  frameRef.current = frame;

  // While a live conversation is going and the screen is shared, it sees what the user sees: every new picture goes to it, and one goes
  // the moment the conversation starts (the screen may not have changed since).
  useEffect(() => {
    if (frame !== null) conversation.sendScreenFrame(frame.jpeg);
  }, [frame, conversation]);
  useEffect(() => {
    if (talk === 'on' && frameRef.current !== null) conversation.sendScreenFrame(frameRef.current.jpeg);
  }, [talk, conversation]);

  // Talking about the screen counts as being here, so sharing does not switch itself off for being idle.
  const lastTouch = useRef(0);
  useEffect(() => {
    if (!share.active || talk !== 'on') return;
    const now = Date.now();
    if (now - lastTouch.current > 20_000) {
      lastTouch.current = now;
      window.eya.touchScreenShare();
    }
  }, [thread, share.active, talk]);

  const askScreen = useCallback((request: ScreenAskRequest) => {
    const labels: Record<ScreenAskRequest['mode'], string> = { analyze: "What's on my screen?", explain: 'Explain what is on my screen.', next: 'What should I do next?', ask: '' };
    const question = request.question?.trim() || labels[request.mode];
    setScreenAsk({ phase: 'working', question, answer: '', error: '', note: '' });
    setThread((t) => addMessage(t, 'user', question, 'typed'));
    const failed = (error: string): void => {
      setScreenAsk({ phase: 'error', question, answer: '', error, note: '' });
      setThread((t) => addMessage(t, 'eya', error, 'typed'));
    };
    window.eya
      .askAboutScreen(request)
      .then((r) => {
        if (!r.ok || r.answer === undefined) return failed(r.error ?? "I couldn't read the screen just now.");
        setScreenAsk({ phase: 'done', question, answer: r.answer, error: '', note: '' });
        setThread((t) => addMessage(t, 'eya', r.answer ?? '', 'typed'));
        // Read it aloud unless voice is off, or a live conversation is already talking.
        if (voiceOnRef.current && talkRef.current === 'off') void speakPreview(r.answer);
      })
      .catch(() => failed("I couldn't reach the screen reader just now."));
  }, []);
  const captureScreen = useCallback(() => {
    setScreenAsk((a) => ({ ...a, note: 'Saving a picture…' }));
    void window.eya
      .captureScreen()
      .then((r) => setScreenAsk((a) => ({ ...a, note: r.message })))
      .catch(() => setScreenAsk((a) => ({ ...a, note: "I couldn't save a picture." })));
  }, []);
  const speakText = useCallback((text: string) => {
    if (voiceOnRef.current && talkRef.current === 'off' && text.trim() !== '') void speakPreview(text);
  }, []);
  const speakAnswer = useCallback(() => {
    if (screenAsk.answer !== '') void speakPreview(screenAsk.answer);
  }, [screenAsk.answer]);

  const control: EyaControl = {
    state,
    statusText: statusLine({ state, talk: talk !== 'off' ? talk : gptTalk ? 'on' : 'off', voiceOn, listening, wakeReady: wakeAvailable }),
    talk: talk !== 'off' ? talk : gptTalk ? 'on' : 'off',
    voiceOn,
    listening,
    wakeReady: wakeAvailable,
    level,
    sttState,
    interruptOn,
    voiceName,
    voiceEngine: gptFirst ? 'openai' : 'gemini',
    openaiVoice: openaiVoiceName,
    changeOpenaiVoice,
    previewOpenaiVoice,
    providerStatus,
    transcript,
    thread: thread.messages,
    comm,
    memory,
    settings,
    activity,
    share,
    frame,
    screenAsk,
    submit: submitText,
    toggleTalk,
    toggleVoice,
    toggleInterrupt,
    changeVoiceName,
    changeComm,
    actOnMemory,
    changeSettings,
    geminiKey,
    saveGeminiKey,
    removeGeminiKey,
    tasks,
    actOnTasks,
    backupAi,
    aiRoute,
    chooseAi,
    saveBackupAi,
    removeBackupAi,
    testBackupAi,
    aiUsage,
    refreshAiUsage,
    writing,
    setWriting,
    checkWriting,
    actOnActivity,
    setWindowMode,
    startShare,
    stopShare,
    askScreen,
    captureScreen,
    speakAnswer,
    speakText,
    quit: () => window.eya.quitApp(),
    relaunch: () => window.eya.relaunchApp(),
  };

  // Anything that moves — the bubble while she listens, thinks, works or speaks, a conversation in progress, an offer waiting, the screen
  // being shared — holds the page's motion clock; when nothing does, nothing runs and the whole page is still.
  useMotion(state !== 'idle' || talk !== 'off' || memory?.suggestion != null || share.active);

  return (
    <div className="app" data-mode={win.mode} data-anchor={win.anchor}>
      {win.mode === 'assistant' && <AssistantPanel c={control} />}
      {win.mode === 'app' && <AppShell c={control} request={pageRequest} />}
      {win.mode !== 'app' && (
        <Bubble
          state={state}
          live={listening}
          open={win.mode === 'assistant'}
          chatsOn={comm?.enabled === true}
          offer={memory?.suggestion != null}
          sharing={share.active}
          onClick={onBubbleClick}
        />
      )}
    </div>
  );
}
