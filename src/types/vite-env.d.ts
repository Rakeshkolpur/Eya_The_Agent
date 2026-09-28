/// <reference types="vite/client" />

interface Window {
  /** Present only in development builds; lets test scripts reach into the running page. */
  __eyaDebug?: {
    transcribeLocal(samples: Float32Array): Promise<string | null>;
    sttState(): string;
    /** Opens a live conversation; resolves 'ok' or the reason it could not. */
    startTalk(): Promise<string>;
    stopTalk(): void;
    /** Lets the user talk over Eya, as the Interrupt button does (not saved). */
    setBargeIn(on: boolean): void;
    /** Recent microphone levels as [ms timestamp, 0..1]. */
    micLevels(): Array<[number, number]>;
    talkActive(): boolean;
    /** Runs a spoken clip (16kHz) through the same handler the microphone uses. */
    hearUtterance(samples16k: Float32Array): Promise<void>;
    /** Feeds 16kHz microphone-style audio into the conversation. */
    pushMic(samples16k: Float32Array): void;
    /** Feeds 16kHz audio straight to the wake-word model, bypassing microphone capture. */
    pushWakeAudio(samples16k: Float32Array): void;
  };
}
