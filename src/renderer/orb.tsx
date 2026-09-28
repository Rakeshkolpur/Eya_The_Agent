import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OrbState, AgentResult } from '../shared/types';
import type { StatusMessage } from '../shared/ipcContract';
import { ACK_WORKING, DEFAULT_VOICE, VOICE_OPTIONS } from '../shared/constants';
import { initRendererTTS, setTTSMuted, setTTSVoice, speakPreview, stopSpeaking } from './tts';
import { createLiveListener } from './liveListener';
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

const STATUS_LABEL: Record<OrbState, string> = {
  idle: 'idle',
  listening: 'listening',
  thinking: 'thinking',
  working: 'working',
  speaking: 'speaking',
  error: 'error',
};

const VOICE_STORAGE_KEY = 'eya.voice';
const VOICE_NAME_STORAGE_KEY = 'eya.voiceName';
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
  const [expanded, setExpanded] = useState(false);
  const [transcript, setTranscript] = useState<string>('');
  const [input, setInput] = useState<string>('');
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
  const [sttState, setSttState] = useState<SttState>('idle');
  const [talk, setTalk] = useState<'off' | 'connecting' | 'on'>('off');
  const voiceNameRef = useRef(voiceName);
  voiceNameRef.current = voiceName;
  const micSink = useRef<((chunk: Float32Array, sampleRate: number) => void) | null>(null);
  const hearRef = useRef<((samples16k: Float32Array) => Promise<void>) | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listener = useMemo(() => createLiveListener(), []);
  const slowCue = useRef<() => void>(() => undefined);
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
        getConfig: () => window.eya.getLiveConfig(voiceNameRef.current),
        runTool: async (name, args) => {
          const started = performance.now();
          const { content } = await window.eya.runLiveTool({ name, args });
          console.info(`[eya] live: tool ${name} finished in ${Math.round(performance.now() - started)}ms`);
          return content;
        },
        makeSession: () => new LiveSession((url) => new WebSocket(url) as unknown as SocketLike),
        createPlayback: () => createPcmPlayback(),
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
          show();
        },
        onSaid: (text) => {
          if (text.length > 0) console.info(`[eya] live: said "${text}"`);
          saidShown = text;
          show();
        },
        onSlowTool: (name) => {
          console.info(`[eya] live: ${name} is slow, saying so`);
          slowCue.current();
        },
        onEnded: (reason, detail) => {
          console.info(`[eya] live: ended (${reason})${detail !== undefined ? ` ${detail}` : ''}`);
          heardShown = '';
          saidShown = '';
          setTalk('off');
          setState('idle');
          setTranscript(endedMessage(reason, detail));
        },
      },
    );
  }, [listener]);

  // A tool is taking a while: say so in Eya's usual voice, with the mic muted so
  // she cannot hear herself and answer.
  useEffect(() => {
    slowCue.current = () => {
      conversation.muteMicFor(30_000);
      const started = performance.now();
      void speakPreview(ACK_WORKING).finally(() => {
        console.info(`[eya] live: cue "${ACK_WORKING}" finished after ${Math.round(performance.now() - started)}ms`);
        conversation.muteMicFor(300);
      });
    };
  }, [conversation]);

  useEffect(() => {
    window.eya.wakeAvailable().then(setWakeAvailable).catch(() => setWakeAvailable(false));
  }, []);

  const startTalk = useCallback(async (): Promise<string> => {
    if (conversation.active) return 'ok';
    const result = await conversation.start();
    if (result.ok) return 'ok';
    setTalk('off');
    setState('idle');
    setTranscript(result.reason);
    return result.reason;
  }, [conversation]);

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
    if (talk === 'off') void startTalk();
    else conversation.stop('user');
  }, [talk, startTalk, conversation]);

  // Acoustic wake word: "hey Eya" is recognized as sound on this PC (a small
  // keyword-spotting model), not by waiting for a whole utterance to be
  // transcribed. Falls back to noticing the name in transcribed text (below)
  // if the model could not be loaded.
  useEffect(() => {
    return window.eya.onWakeDetected((which) => {
      if (talk !== 'off' || !voiceOn) return;
      console.info(`[eya] wake word heard (${which}); opening a live conversation`);
      void startTalk();
    });
  }, [talk, voiceOn, startTalk]);

  useEffect(() => {
    const active = wakeAvailable && voiceOn && talk === 'off';
    listener.setWakeSink(active ? (chunk, rate) => wakeUplink.push(chunk, rate) : null);
    if (!active) wakeUplink.reset();
  }, [wakeAvailable, voiceOn, talk, listener, wakeUplink]);

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
        stopTalk: () => conversation.stop('user'),
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
      };
    }
    return off;
  }, [localStt, startTalk, conversation]);

  // The window must be big enough for whatever is showing, or the panel is clipped.
  useEffect(() => {
    window.eya.setExpanded(expanded);
  }, [expanded]);

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
    const offToggle = window.eya.onToggleInput(() =>
      setExpanded((prev) => {
        const next = !prev;
        if (next) queueMicrotask(() => inputRef.current?.focus());
        return next;
      }),
    );
    const offShow = window.eya.onShowPanel(() => {
      setExpanded(true);
      queueMicrotask(() => inputRef.current?.focus());
    });
    const offStatus = window.eya.onStatus((s) => setProviderStatus(s));
    const offUpdate = window.eya.onAgentUpdate((update) => {
      setState(update.state);
      if (update.message !== undefined) setTranscript(update.message);
    });
    return () => {
      offState();
      offToggle();
      offShow();
      offStatus();
      offUpdate();
    };
  }, []);

  const submitText = useCallback(async (text: string) => {
    const t = text.trim();
    if (t.length === 0) return;
    setInput('');
    setTranscript(`" ${t} "`);
    try {
      const result: AgentResult = await window.eya.submit({
        text: t,
        source: 'text',
        requestId: randomId(),
      });
      setTranscript(result.spoken);
    } catch (err) {
      setTranscript(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  }, []);

  const submitUtterance = useCallback(async (audio: LiveAudio) => {
    setState('thinking');
    setTranscript('Transcribing…');
    const showResult = (result: AgentResult): void => {
      // Noise that produced no words comes back with nothing to say.
      setTranscript(result.spoken.length > 0 ? result.spoken : '');
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
        showResult(await window.eya.submit({ text, source: 'voice', requestId: randomId(), live: true }));
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
  }, [localStt, startTalk]);

  useEffect(() => {
    hearRef.current = (samples16k) => submitUtterance({ samples16k, durationMs: (samples16k.length / 16) });
  }, [submitUtterance]);

  // Voice = listening + speaking. One switch controls both.
  const canTranscribe = providerStatus?.ai === 'gemini' && providerStatus.aiReady;

  useEffect(() => {
    setTTSMuted(!voiceOn);
    // Turning voice off ends any live conversation too.
    if (!voiceOn) conversation.stop('user');
  }, [voiceOn, conversation]);

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

  const aiStatusLine = providerStatus === null
    ? 'Connecting…'
    : providerStatus.aiReady && providerStatus.ai === 'gemini'
      ? 'Gemini connected'
      : providerStatus.aiReady && providerStatus.ai === 'ollama'
        ? 'Ollama connected'
        : providerStatus.ai === 'none'
          ? 'No LLM — local commands only'
          : `${providerStatus.ai}: checking`;

  const earsHint =
    sttState === 'ready'
      ? 'hears on this PC · '
      : sttState === 'loading'
        ? 'loading speech model… · '
        : '';
  const voiceLabel = !voiceOn ? 'Voice OFF' : listening ? 'Voice ON' : 'Starting…';
  const voiceTitle = !voiceOn
    ? 'Voice is off. Click to let Eya listen and speak.'
    : !canHear && providerStatus !== null
      ? 'Waiting for speech recognition (the on-device model is loading, or add a Gemini key). Click to turn off.'
      : 'Eya is listening and speaking. Click to turn voice off.';

  return (
    <div className="app">
      {expanded && (
        <div className="panel">
          <div className="status-row">
            <span className="status">{STATUS_LABEL[state]}</span>
            <button
              type="button"
              className={`talk-pill ${talk !== 'off' ? 'on' : ''}`}
              onClick={toggleTalk}
              disabled={talk === 'off' && !voiceOn}
              title={
                talk === 'off'
                  ? voiceOn
                    ? 'Start a live conversation with Eya (or just say "Hey Eya")'
                    : 'Turn voice on first'
                  : 'End the conversation'
              }
              aria-pressed={talk !== 'off'}
            >
              {talk === 'off' ? 'Talk' : talk === 'connecting' ? 'Connecting…' : 'Live · End'}
            </button>
            <button
              type="button"
              className={`interrupt-pill ${interruptOn ? 'on' : ''}`}
              onClick={toggleInterrupt}
              title={
                interruptOn
                  ? 'You can talk over Eya and she will stop. Turn off if she cuts herself off.'
                  : 'Let me interrupt Eya while she talks. Works best with headphones.'
              }
              aria-pressed={interruptOn}
            >
              Interrupt
            </button>
            <span className="ai-badge">{aiStatusLine}</span>
          </div>
          <div className="transcript">
            {transcript || (listening ? 'Listening. Just say a command.' : 'Type a command.')}
          </div>
          <div className="input">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitText(input);
                if (e.key === 'Escape') setExpanded(false);
              }}
              placeholder="Type a command…"
              spellCheck={false}
              autoFocus
            />
            <button
              type="button"
              className={`voice-toggle ${voiceOn ? 'on' : ''}`}
              onClick={toggleVoice}
              title={voiceTitle}
              aria-pressed={voiceOn}
            >
              <span className="voice-dot" style={{ transform: `scale(${1 + level * 0.9})` }} />
              {voiceLabel}
            </button>
          </div>
          <div className="hint-row">
            <span className="hint">
              {voiceOn ? `Just speak · ${earsHint}` : 'Voice off · '}Ctrl + Space to hide
            </span>
            <select
              className="voice-select"
              value={voiceName}
              onChange={(e) => changeVoiceName(e.target.value)}
              title="Choose Eya's voice"
              aria-label="Eya's voice"
            >
              {VOICE_OPTIONS.map((v) => (
                <option key={v.id} value={v.id}>{v.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}
      <div
        className="orb"
        data-state={state}
        data-expanded={expanded ? 'true' : 'false'}
        data-live={listening ? 'true' : 'false'}
        onClick={() => setExpanded((v) => !v)}
        title="Eya"
      />
    </div>
  );
}
