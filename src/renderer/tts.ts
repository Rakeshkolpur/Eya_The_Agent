import type { TTSSpeakMessage } from '../shared/ipcContract';
import { DEFAULT_VOICE } from '../shared/constants';
import { loadAudio, saveAudio } from './phraseStore';
import type { StoredAudio } from './phraseStore';
import { concatBytes } from './pcm';
import { createPcmPlayback } from './pcmPlayer';
import { GenerationQueue } from './ttsQueue';
import type { Priority } from './ttsQueue';
import type { TtsWorkerRequest, TtsWorkerResponse } from './ttsWorker';

type SpeakFn = (text: string) => Promise<void>;
type Sound = { stop(): void };

const MAX_CACHED_PHRASES = 80;
// Cloud speech normally starts in ~1s. A model that fails fast (rate limit)
// hands over to the next, which gets a few seconds; beyond this the user hears
// the system voice rather than silence.
const CLOUD_FIRST_AUDIO_MS = 3500;
// After a cloud failure, skip the cloud briefly so each phrase doesn't pay the wait.
const CLOUD_COOLDOWN_MS = 30_000;
// Local (offline) voice: Kokoro takes seconds per sentence on CPU, so long
// replies go straight to the system voice.
const LOCAL_MAX_CHARS = 60;
const LOCAL_PATIENCE_MS = 1200;
const LOCAL_STORE_ONLY_PATIENCE_MS = 200;

let stopRequested = false;
let muted = false;
let currentVoice: string = DEFAULT_VOICE;
let activePlayback: Sound | null = null;
let activePhrase: PhraseStream | null = null;
let cloudCooldownUntil = 0;
let speakerFn: SpeakFn | null = null;

// Saved audio is keyed by everything that changes how it sounds.
const cloudKey = (voice: string, text: string): string => `gemini|v1|${voice}|${text}`;
// Same key as phrases saved by the earlier local voice, so those stay valid.
const localKey = (text: string): string => `af_heart|q8|v1|${text}`;

const toBytes = (stored: StoredAudio): Uint8Array =>
  stored instanceof Uint8Array ? stored : new Uint8Array(stored);

function sleep<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function trim<K, V>(map: Map<K, V>): void {
  while (map.size > MAX_CACHED_PHRASES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function stopAllSound(): void {
  stopRequested = true;
  window.speechSynthesis.cancel();
  activePlayback?.stop();
  activePhrase?.cancel();
}

// ---------------------------------------------------------------- cloud voice

interface CloudHandle {
  /** Resolves true when the whole phrase streamed, false on failure or cancel. */
  readonly done: Promise<boolean>;
  cancel(): void;
}

interface CloudListener {
  onChunk(pcm: Uint8Array): void;
  end(ok: boolean): void;
}

const cloudStreams = new Map<string, CloudListener>();

async function startCloud(
  text: string,
  voice: string,
  onChunk: (pcm: Uint8Array) => void,
): Promise<CloudHandle | null> {
  const started = await window.eya.startTTSStream({ text, voice });
  if (!started.ok) {
    console.info(`[eya] cloud voice unavailable: ${started.error}`);
    return null;
  }
  const { streamId } = started;
  let finish: (ok: boolean) => void = () => undefined;
  const done = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  cloudStreams.set(streamId, { onChunk, end: (ok) => finish(ok) });
  void done.finally(() => cloudStreams.delete(streamId));
  return {
    done,
    cancel: () => {
      window.eya.cancelTTSStream(streamId);
      finish(false);
    },
  };
}

/**
 * One phrase being (or already) generated. Speaking and prefetching share it,
 * so the same sentence is never requested twice, and playback can begin on the
 * first chunk even while the rest is still arriving.
 */
class PhraseStream {
  readonly chunks: Uint8Array[] = [];
  status: 'streaming' | 'done' | 'failed' = 'streaming';
  done: Promise<boolean> = Promise.resolve(false);
  private readonly listeners = new Set<(pcm: Uint8Array) => void>();
  private handle: CloudHandle | null = null;

  static completed(pcm: Uint8Array): PhraseStream {
    const stream = new PhraseStream();
    stream.chunks.push(pcm);
    stream.status = 'done';
    stream.done = Promise.resolve(true);
    return stream;
  }

  attach(handle: CloudHandle, onSettled: (ok: boolean) => void): void {
    this.handle = handle;
    this.done = handle.done.then((ok) => {
      const complete = ok && this.chunks.length > 0;
      this.status = complete ? 'done' : 'failed';
      onSettled(complete);
      return complete;
    });
  }

  push(pcm: Uint8Array): void {
    this.chunks.push(pcm);
    for (const listener of this.listeners) listener(pcm);
  }

  /** Delivers everything received so far, then whatever arrives next. */
  subscribe(listener: (pcm: Uint8Array) => void): () => void {
    for (const chunk of this.chunks) listener(chunk);
    if (this.status === 'streaming') this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cancel(): void {
    if (this.status === 'streaming') this.handle?.cancel();
  }
}

const phraseStreams = new Map<string, PhraseStream>();
const acquiring = new Map<string, Promise<PhraseStream | null>>();

/** The saved phrase, one already in flight, or a new cloud request. */
function acquirePhrase(text: string, voice: string): Promise<PhraseStream | null> {
  const key = cloudKey(voice, text);
  const existing = phraseStreams.get(key);
  if (existing !== undefined) return Promise.resolve(existing);
  const pending = acquiring.get(key);
  if (pending !== undefined) return pending;

  const job = (async (): Promise<PhraseStream | null> => {
    const stored = await loadAudio(key);
    if (stored !== null) {
      const saved = PhraseStream.completed(toBytes(stored));
      phraseStreams.set(key, saved);
      trim(phraseStreams);
      return saved;
    }
    if (Date.now() < cloudCooldownUntil) return null;

    const stream = new PhraseStream();
    const handle = await startCloud(text, voice, (pcm) => stream.push(pcm));
    if (handle === null) {
      cloudCooldownUntil = Date.now() + CLOUD_COOLDOWN_MS;
      return null;
    }
    stream.attach(handle, (complete) => {
      if (complete) {
        void saveAudio(key, concatBytes(stream.chunks));
      } else {
        phraseStreams.delete(key); // let a later request try again
        if (stream.chunks.length === 0) cloudCooldownUntil = Date.now() + CLOUD_COOLDOWN_MS;
      }
    });
    phraseStreams.set(key, stream);
    trim(phraseStreams);
    return stream;
  })().finally(() => acquiring.delete(key));
  acquiring.set(key, job);
  return job;
}

/** Plays a phrase from the cloud (or the saved copy), starting on the first chunk. */
async function speakCloud(text: string, voice: string, requestedAt: number): Promise<'played' | 'failed'> {
  const phrase = await acquirePhrase(text, voice);
  if (phrase === null) return 'failed';

  const player = createPcmPlayback();
  activePlayback = player;
  activePhrase = phrase;
  let heard = false;
  let bytes = 0;
  let onFirst: () => void = () => undefined;
  const firstAudio = new Promise<void>((resolve) => {
    onFirst = resolve;
  });
  const unsubscribe = phrase.subscribe((pcm) => {
    if (stopRequested || muted) return;
    bytes += pcm.length;
    player.push(pcm);
    if (!heard) {
      heard = true;
      onFirst();
    }
  });
  const cleanup = (): void => {
    unsubscribe();
    if (activePlayback === player) activePlayback = null;
    if (activePhrase === phrase) activePhrase = null;
  };

  await Promise.race([firstAudio, phrase.done, sleep(CLOUD_FIRST_AUDIO_MS, null)]);
  if (!heard) {
    phrase.cancel();
    player.stop();
    cleanup();
    return 'failed';
  }
  console.info(`[eya] voice: first audio ${Math.round(performance.now() - requestedAt)}ms after request: "${text}"`);

  await phrase.done;
  player.end();
  await player.finished;
  console.info(`[eya] voice: finished ${(bytes / 48_000).toFixed(1)}s of audio ${Math.round(performance.now() - requestedAt)}ms after request`);
  cleanup();
  return 'played';
}

// ---------------------------------------------------- local (offline) voice

let worker: Worker | null = null;
let engineReady = false;
const pendingResults = new Map<number, (r: Extract<TtsWorkerResponse, { type: 'result' }>) => void>();
let nextJobId = 1;

const localQueue = new GenerationQueue(async (text) => {
  const w = worker;
  if (w === null) return null;
  const id = nextJobId++;
  const result = await new Promise<Extract<TtsWorkerResponse, { type: 'result' }>>((resolve) => {
    pendingResults.set(id, resolve);
    const request: TtsWorkerRequest = { type: 'generate', id, text };
    w.postMessage(request);
  });
  if (result.error !== undefined || result.wav === undefined) {
    console.warn(`[eya] local voice failed: ${result.error ?? 'no audio'}`);
    return null;
  }
  console.info(`[eya] local voice generated in ${result.ms}ms: "${text}"`);
  return result.wav;
});

const localCache = new Map<string, Promise<ArrayBuffer | null>>();

function getLocalPhrase(text: string, priority: Priority): Promise<ArrayBuffer | null> {
  const hit = localCache.get(text);
  if (hit !== undefined) {
    if (priority === 'high') localQueue.bump(text);
    return hit;
  }
  const job = (async () => {
    const stored = await loadAudio(localKey(text));
    if (stored !== null) return stored instanceof ArrayBuffer ? stored : (stored.buffer as ArrayBuffer);
    const wav = await localQueue.enqueue(text, priority);
    if (wav !== null) void saveAudio(localKey(text), wav);
    return wav;
  })().then((wav) => {
    if (wav === null) localCache.delete(text);
    return wav;
  });
  localCache.set(text, job);
  trim(localCache);
  return job;
}

/** The offline voice is only loaded once the cloud has actually failed. */
function ensureLocalWorker(): void {
  if (worker !== null) return;
  try {
    worker = new Worker(new URL('./ttsWorker.ts', import.meta.url), { type: 'module' });
  } catch (err) {
    console.warn('[eya] could not start the local voice worker', err);
    return;
  }
  worker.onmessage = (event: MessageEvent<TtsWorkerResponse>) => {
    const msg = event.data;
    if (msg.type === 'ready') {
      engineReady = true;
      console.info(`[eya] local voice loaded in ${msg.loadMs}ms (${msg.threads} thread${msg.threads === 1 ? '' : 's'})`);
      localQueue.setReady(true);
    } else if (msg.type === 'init-failed') {
      console.warn(`[eya] local voice load failed: ${msg.error}`);
      localQueue.failAll();
    } else {
      const done = pendingResults.get(msg.id);
      pendingResults.delete(msg.id);
      done?.(msg);
    }
  };
  worker.onerror = (event) => {
    console.warn(`[eya] local voice worker crashed: ${event.message}`);
    engineReady = false;
    localQueue.failAll();
    for (const [id, done] of pendingResults) done({ type: 'result', id, ms: 0, error: 'worker crashed' });
    pendingResults.clear();
  };
  const init: TtsWorkerRequest = { type: 'init' };
  worker.postMessage(init);
}

async function speakLocal(text: string, system: SpeakFn): Promise<void> {
  ensureLocalWorker();
  const known = localCache.has(text);
  if (text.length > LOCAL_MAX_CHARS && !known) {
    await system(text);
    return;
  }
  const patience = engineReady || known ? LOCAL_PATIENCE_MS : LOCAL_STORE_ONLY_PATIENCE_MS;
  const wav = await Promise.race([getLocalPhrase(text, 'high'), sleep(patience, null)]);
  if (stopRequested || muted) return;
  if (wav === null) {
    await system(text);
    return;
  }
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  try {
    await playUrl(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ------------------------------------------------------------------ public

/**
 * Renderer-side TTS, in order of preference:
 *  1. Gemini's natural voice, streamed from the cloud (~1s to first audio);
 *     a phrase spoken before is saved and replays instantly,
 *  2. the offline Kokoro voice, then the system voice, if the cloud fails.
 */
export function initRendererTTS(
  onSpeakStart: (m: TTSSpeakMessage) => void,
  onSpeakEnd: (m: TTSSpeakMessage) => void,
): void {
  const speaker = createSpeaker();
  speakerFn = speaker;

  window.eya.onTTSChunk((msg) => cloudStreams.get(msg.streamId)?.onChunk(msg.pcm));
  window.eya.onTTSStreamEnd((msg) => cloudStreams.get(msg.streamId)?.end(msg.ok));
  window.eya.onTTSStop(() => stopAllSound());
  window.eya.onTTSPrefetch(({ text }) => {
    if (!muted) void acquirePhrase(text, currentVoice);
  });
  window.eya.onTTSSpeak(async (msg) => {
    if (muted) {
      window.eya.ttsDone(msg.utteranceId);
      return;
    }
    onSpeakStart(msg);
    stopRequested = false;
    try {
      await speaker(msg.text);
    } catch (err) {
      console.warn('tts speak failed', err);
    } finally {
      onSpeakEnd(msg);
      window.eya.ttsDone(msg.utteranceId);
    }
  });
  window.eya.ttsReady();
}

/** Silences Eya immediately (and drops anything queued) or lets it speak again. */
export function setTTSMuted(next: boolean): void {
  if (muted === next) return;
  muted = next;
  if (next) stopAllSound();
  else stopRequested = false;
}

export function setTTSVoice(voice: string): void {
  currentVoice = voice;
}

/** Plays a sample line in the current voice, e.g. after the user picks one. */
export function speakPreview(text: string): Promise<void> {
  if (muted || speakerFn === null) return Promise.resolve();
  stopAllSound();
  stopRequested = false;
  return speakerFn(text).catch((err: unknown) => console.warn('tts preview failed', err));
}

/** Cuts off whatever this module is saying, e.g. a short cue when the real voice takes over. */
export function stopSpeaking(): void {
  stopAllSound();
}

function createSpeaker(): SpeakFn {
  const system = createSystemSpeaker();
  return async (text: string) => {
    if (stopRequested || muted) return;
    const voice = currentVoice;
    const requestedAt = performance.now();

    if (Date.now() >= cloudCooldownUntil) {
      const outcome = await speakCloud(text, voice, requestedAt);
      if (outcome === 'played' || stopRequested || muted) return;
      cloudCooldownUntil = Date.now() + CLOUD_COOLDOWN_MS;
      console.info(`[eya] voice: cloud gave no audio in time; using the offline voice for "${text}"`);
    }
    await speakLocal(text, system);
  };
}

function createSystemSpeaker(): SpeakFn {
  return (text: string) =>
    new Promise<void>((resolve) => {
      if (stopRequested) return resolve();

      // Defensive: Chromium's speechSynthesis queue can jam if a previous
      // utterance never fired onend (a known issue on Windows/SAPI voices).
      // Callers already serialize speak() calls, so a stray cancel() here
      // just guarantees we start from a clean queue state every time.
      window.speechSynthesis.cancel();

      const u = new SpeechSynthesisUtterance(text);
      const voice = pickBestVoice();
      if (voice !== undefined) u.voice = voice;
      u.rate = 1;
      u.pitch = 1;

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        resolve();
      };
      u.onend = finish;
      u.onerror = finish;

      // Watchdog: if the engine never fires onend/onerror (it has been
      // observed to silently drop utterances), don't hang the queue.
      const estimatedMs = Math.max(2000, text.length * 90);
      const watchdog = setTimeout(finish, estimatedMs);

      window.speechSynthesis.speak(u);
    });
}

function pickBestVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const preferences = [
    /Zira/i, /Aria/i, /Jenny/i, /Michelle/i, /Ava/i,
    /Natural/i, /Neural/i,
  ];
  for (const re of preferences) {
    const match = voices.find((v) => re.test(v.name) && /en/i.test(v.lang));
    if (match !== undefined) return match;
  }
  return voices.find((v) => /en/i.test(v.lang));
}

function playUrl(url: string): Promise<void> {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (activePlayback === handle) activePlayback = null;
      resolve();
    };
    const handle: Sound = {
      stop: () => {
        audio.pause();
        finish();
      },
    };
    activePlayback = handle;
    audio.onended = finish;
    audio.onerror = finish;
    const watchdog = setTimeout(finish, 20_000);
    void audio.play().catch(() => finish());
  });
}
