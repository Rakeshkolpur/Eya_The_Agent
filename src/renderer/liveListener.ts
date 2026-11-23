import { UtteranceDetector, computeRms } from './vad';
import { TARGET_RATE, resample } from './wav';

/** One spoken utterance, ready for speech recognition (mono, 16kHz). */
export interface LiveAudio {
  readonly samples16k: Float32Array;
  readonly durationMs: number;
}

export interface LiveListenerHandlers {
  onSpeechStart(): void;
  onDiscard(): void;
  onUtterance(audio: LiveAudio): void;
  onLevel(level: number): void;
  onError(message: string): void;
}

export type FrameSink = (chunk: Float32Array, sampleRate: number) => void;

export interface LiveListener {
  start(handlers: LiveListenerHandlers): Promise<boolean>;
  stop(): void;
  /** Pauses utterance detection (raw audio to a frame sink is unaffected). */
  setPaused(paused: boolean): void;
  /**
   * While set, every microphone block goes to the sink and utterance detection
   * is bypassed. This is how a live conversation takes over the microphone.
   */
  setFrameSink(sink: FrameSink | null): void;
  /**
   * Every microphone block also goes here (raw, whatever the actual sample
   * rate is), independent of the frame sink and of pausing, so the wake word
   * can keep listening for her name alongside normal utterance capture. It
   * only stops while a live conversation owns the microphone (the frame sink
   * is set), since calling her name then would not do anything useful.
   */
  setWakeSink(sink: FrameSink | null): void;
  isRunning(): boolean;
}

const RESUME_COOLDOWN_MS = 600;

// Runs on the audio thread; forwards each 128-sample block to the page.
const WORKLET_SRC = `
class EyaTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('eya-tap', EyaTap);
`;

/**
 * Keeps the microphone open and emits one WAV per spoken utterance. Nothing
 * leaves the renderer until the detector decides someone actually spoke, and
 * then only that utterance is sent on.
 */
export function createLiveListener(): LiveListener {
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let running = false;
  let paused = false;
  let frameSink: FrameSink | null = null;
  let wakeSink: FrameSink | null = null;
  const detector = new UtteranceDetector();

  function teardown(): void {
    running = false;
    try { node?.port.close(); } catch { /* already closed */ }
    try { node?.disconnect(); } catch { /* already disconnected */ }
    node = null;
    if (stream !== null) for (const t of stream.getTracks()) t.stop();
    stream = null;
    void ctx?.close().catch(() => undefined);
    ctx = null;
    detector.reset();
  }

  return {
    async start(handlers: LiveListenerHandlers): Promise<boolean> {
      if (running) return true;
      if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
        handlers.onError('Microphone not available in this build.');
        return false;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
        ctx = new AudioContext({ latencyHint: 'interactive' });
        await ctx.resume();

        const moduleUrl = URL.createObjectURL(
          new Blob([WORKLET_SRC], { type: 'application/javascript' }),
        );
        try {
          await ctx.audioWorklet.addModule(moduleUrl);
        } finally {
          URL.revokeObjectURL(moduleUrl);
        }

        const source = ctx.createMediaStreamSource(stream);
        node = new AudioWorkletNode(ctx, 'eya-tap', { numberOfInputs: 1, numberOfOutputs: 1 });
        // The worklet writes no output, so this stays silent; routing it to
        // the destination just guarantees the browser keeps pulling audio.
        const mute = ctx.createGain();
        mute.gain.value = 0;
        source.connect(node);
        node.connect(mute);
        mute.connect(ctx.destination);

        let lastLevelAt = 0;
        node.port.onmessage = (e: MessageEvent<Float32Array>) => {
          if (ctx === null) return;
          const chunk = e.data;
          const sampleRate = ctx.sampleRate;
          if (frameSink !== null) {
            frameSink(chunk, sampleRate);
            return;
          }
          if (paused) return;
          wakeSink?.(chunk, sampleRate);

          const now = performance.now();
          if (now - lastLevelAt > 80) {
            lastLevelAt = now;
            handlers.onLevel(Math.min(1, computeRms(chunk) * 6));
          }

          for (const ev of detector.push(chunk, sampleRate)) {
            if (ev.type === 'start') handlers.onSpeechStart();
            else if (ev.type === 'discard') handlers.onDiscard();
            else {
              handlers.onUtterance({
                samples16k: resample(ev.samples, ev.sampleRate, TARGET_RATE),
                durationMs: ev.durationMs,
              });
            }
          }
        };

        const track = stream.getAudioTracks()[0];
        if (track !== undefined) {
          track.onended = () => {
            handlers.onError('Microphone disconnected.');
            teardown();
          };
        }

        running = true;
        console.info('[eya] live listening started', { sampleRate: ctx.sampleRate });
        return true;
      } catch (err) {
        teardown();
        handlers.onError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },

    stop(): void {
      if (!running && stream === null) return;
      console.info('[eya] live listening stopped');
      teardown();
    },

    setPaused(next: boolean): void {
      if (next === paused) return;
      paused = next;
      // Discard anything half-captured when pausing; when resuming, ignore a
      // short window so the tail of Eya's own voice can't retrigger us.
      detector.reset(next ? 0 : RESUME_COOLDOWN_MS);
    },

    setFrameSink(sink: FrameSink | null): void {
      frameSink = sink;
      // Whatever the detector had half-heard belongs to the old mode.
      detector.reset();
    },

    setWakeSink(sink: FrameSink | null): void {
      wakeSink = sink;
    },

    isRunning(): boolean {
      return running;
    },
  };
}
