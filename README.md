# Eya

Windows-first AI desktop agent. Local-first where it can be, Gemini where it helps. Electron + TypeScript strict.

## What it does

- **Hears you on your own PC.** Always-on listening: voice-activity detection cuts real utterances out of the mic, and an on-device Whisper model (`whisper-tiny.en`, ~43 MB, downloaded once from Hugging Face and cached) turns them into text. Simple commands ("open Notepad") are then handled locally with **no cloud call at all**. Until the model has loaded, or if it fails, speech goes to Gemini instead. On first use it also times your graphics chip against your processor (a few seconds, once) and keeps whichever transcribes faster; an Intel UHG-class chip typically wins by about 2x.
- **A real wake word.** Saying "hey Eya" is recognized as *sound*, not by waiting for a whole sentence to be transcribed: a small always-on keyword-spotting model (~41 MB, downloaded once) listens continuously and opens Talk mode the moment it hears the name. If it misses (it catches roughly half of attempts by itself), the existing text-based check still catches most of the rest a moment later, once the utterance is transcribed — the two run side by side and either can start the conversation.
- **One voice button.** Listening and speaking are switched on and off together, and Eya goes silent immediately when you turn it off.
- **Talk mode (Gemini Live).** The **Talk** button, or just saying "Hey Eya", opens a real-time spoken conversation: Gemini's own voice, low latency, tools available mid-conversation. It ends when you press the button again, say so, or after a quiet spell. Only "Hey Eya" (or the name however it is misheard) starts it; a command such as "Hey Eya, open Notepad" is still handled as a plain command.
- **Interrupt her.** The **Interrupt** pill (on by default) lets you talk over Eya mid-sentence in Talk mode and have her stop and listen, the way a phone call works. Turn it off if your microphone picks up her own voice from the speakers and she ends up interrupting herself.
- **A natural voice.** Outside Talk mode Gemini's speech models stream audio in about a second. Replies heard before are saved and play instantly. Pick the voice from the dropdown in the panel. If the cloud voice is unavailable it falls back to the offline Kokoro voice, then the Windows voice.
- **Multi-step tasks.** "Find my latest PDF in Downloads, read it and tell me the hearing date" chains tools: the model picks a tool, gets the result, and repeats until it has an answer (typed/agent path: max 8 steps / 90 s). If a step takes more than a couple of seconds Eya says "Working on it." (in Talk mode a Live tool call is also given up on after 40 s, and Eya says it took too long).
- **Instant simple commands.** "Hey Eya, could you please open Notepad?" is matched locally.

### Tools

| Tool | What it does |
| --- | --- |
| `open_application` / `close_application` | Notepad, Calculator, File Explorer, Edge, Chrome, Firefox. Checks the app is installed first and offers an alternative if not. |
| `find_file` | Search Downloads/Desktop/Documents (or another folder) by name, type or recency. |
| `read_file` | Read plain-text files. |
| `analyze_document` | Read a PDF, image or text file and answer a question about it (sent to Gemini). |
| `web_search` | Google-grounded answer with sources. |
| `open_file` / `open_folder` / `open_url` | Open things the way Windows would. `open_url` can target a specific browser. |

### Safety

- Files: only inside your user folder. Secrets are blocked everywhere (`.env`, `.ssh`, `AppData`, `*.pem`, `credentials.json`, ...), including this project's own `.env`.
- Programs and scripts (`.exe`, `.ps1`, `.lnk`, ...) are never opened.
- Closing apps is polite: Eya asks the window to close and reports honestly if it stays open (for example "save changes?"). She never force-kills anything except Calculator, which ignores polite requests and has nothing to lose. Explorer windows are closed individually, never by ending `explorer.exe`, so your desktop and taskbar are untouched.
- Text inside files and web pages is treated as information, never instructions.
- Eya has no tools to delete, move, send or install anything.
- `analyze_document` uploads the file to Gemini to read it; that is inherent to the feature.

## Setup

Prerequisites: Node.js 20+, Windows 10/11.

```
npm install
copy .env.example .env    # then put your Gemini key in .env
npm run dev
```

The first run downloads the speech model (~43 MB, in the browser, cached by it). The wake-word model (~41 MB) is not downloaded automatically: it already lives in this checkout at `models/kws/` and is read straight from disk — there is no packaging step yet (the app only runs via `npm run dev`), so a future packaged build would need to ship that folder, and the native `sherpa-onnx-node` / `sherpa-onnx-win-x64` files from `node_modules`, alongside the app. If those files are missing or the native module fails to load on a given machine, the wake word is simply unavailable and Eya falls back to the text-based name check only (nothing breaks).

Note that `npm run dev` rebuilds the interface live but does **not** restart the main process when you edit it; restart the app after changing anything under `src/main` (this includes wake-word changes, since the model runs in the main process).

## Important: Gemini limits

A free Google AI Studio key has **daily request limits per model**, and the preview models are often "overloaded". A voice assistant spends requests quickly, so on the free tier you can run out mid-day. When that happens Eya says so ("I've used up today's free Gemini limit"), typed and spoken local commands keep working, and the offline voice takes over. Turning on billing for the project in Google AI Studio removes the practical limit.

Eya spreads load across models (limits are per model), retries "high demand" errors after a short wait, and stops asking a model whose daily quota is spent.

Where the quota goes:

- Local speech recognition means spoken commands no longer cost a request.
- Talk mode uses the Live API, which has its own quota and kept working in testing when the regular one was exhausted.
- `analyze_document`, `web_search`, the typed/agent path and the cloud voice use the regular quota.

## Configuration (`.env`)

| Variable | Purpose |
| --- | --- |
| `EYA_GEMINI_API_KEY` | Gemini key (needed for Talk mode, multi-step tasks, document reading, web search and the natural voice) |
| `EYA_GEMINI_MODEL` | Planning model(s), comma-separated, tried in order |
| `EYA_GEMINI_TRANSCRIBE_MODEL` | Cloud speech-to-text fallback model(s) |
| `EYA_TTS_MODELS` | Voice model(s), default `gemini-3.8-flash-lite-tts` then two fallbacks |
| `EYA_LIVE_MODELS` | Talk-mode model(s), tried in order; default `gemini-3.1-flash-live-preview`, `gemini-3.8-live`, `gemini-2.5-flash-native-audio-latest` |
| `EYA_OLLAMA_URL` / `EYA_OLLAMA_MODEL` | Optional local fallback |
| `EYA_LOG_LEVEL` | `debug`, `info`, `warn`, `error` |

`.env` is git-ignored. Never commit it.

**About the key in Talk mode:** the Live API is a browser WebSocket, so the app hands the renderer a connection URL that contains your key, only while a conversation is opening. The window loads only local content and has no navigation, but if you would rather never have the key in the renderer, do not use Talk mode.

## Always-on listening: what to know

- Utterances over 10 s are dropped unsent; live speech over 14 words, or that sounds like conversation ("I'm going to show you…"), is ignored without any AI call.
- In always-on mode Eya only acts on commands; she never chats back at speech that wasn't one.
- By default Interrupt is on: in Talk mode the microphone stays open while Eya speaks, and Gemini stops her the moment it hears you talk over her. This relies on your microphone's own echo cancellation not picking up her voice from your speakers; if she keeps interrupting herself, turn Interrupt off, which goes back to muting the microphone while she talks (and for a moment after).
- The wake word is heard two ways at once: an on-device acoustic model (see above) and the existing check for the name "Eya" in whatever Whisper transcribes (however it spells it: "Aya", "I-A", "ee-ya" ...). Either can open Talk mode. A command-shaped phrase near the mic (TV, a call) could still trigger an action.

### The wake-word model, measured

Tuned and tested against synthetic speech (two Windows voices, three speaking rates) since this is a solo project without a speech lab: 60 recordings of "hey Eya" and its common mishearings, 182 short unrelated sentences, and about an hour of narration read from open-source READMEs as negatives.

- Offline, one clip at a time: caught about 8 in 10 attempts; 3 false alarms in 182 sentences (all on the phrase "hi Eya"), 0 in the hour of narration.
- Streamed live through the running app the way a real microphone would (one continuous, long-lived listener, exactly as it runs in production): caught roughly half of the attempts in spot checks, and still 0 false alarms in over 5 minutes of continuous narration. The lower number in continuous use looks like carried-over decoder state between phrases rather than a flaw in a specific clip; it has not been tuned further.
- This is why it is additive rather than a replacement: whatever it misses, the existing transcription-based check usually catches a moment later.
- Never tested against a real human voice or accent, so your own results may differ in either direction.

## Test / typecheck

```
npm test
npm run typecheck
```

## Development notes

In `npm run dev` only, the renderer exposes `window.__eyaDebug` (start/stop Talk, feed a recorded clip through the microphone path, transcribe a clip) so the whole voice path can be driven end to end over the Chrome DevTools Protocol (`--remote-debugging-port`). It is not present in production builds.

## Architecture

```
src/
  shared/      Cross-boundary types + IPC contract, wake-name matching
  main/        Electron main process
    agent/       AgentEngine (loop), IntentRouter, ResponseComposer, prompts, speechText
    tools/       Typed tool registry + implementations (files, documents, open, apps)
    security/    pathPolicy (what the assistant may touch)
    live/        liveBridge: config + tool execution for Talk mode
    wake/        sentencePiece (tokenizer), keywordSpotter (the model), loadWakeWordDetector
    providers/
      ai/        GeminiAIProvider (model fallback, retries, daily-limit aware), OllamaAIProvider, ChainedAIProvider
      tts/       GeminiTTS (streaming), TtsStreamService, RendererTTSBridge (serialized queue)
    windowsApi/  Process launch/verify, App Paths lookup (no shell)
    permissions/ memory/ context/ config/ ipc/ shortcuts/ windows/
  renderer/    React orb
    liveListener.ts / vad.ts / wav.ts   always-on mic -> utterances, plus a raw tap for the wake word
    wakeWord.ts                          batches raw mic audio for the wake-word model in main
    localStt.ts / sttWorker.ts / sttText.ts / sttBackend.ts   on-device Whisper (worker), CPU/GPU choice, hallucination filter
    liveSession.ts / liveProtocol.ts / liveConversation.ts   Gemini Live WebSocket, protocol, conversation controller (barge-in aware)
    tts.ts + pcmPlayer.ts + pcm.ts      cloud voice, saved phrases, gapless playback
    ttsWorker.ts / ttsQueue.ts          offline Kokoro voice (loaded only if the cloud fails)
    phraseStore.ts                      on-disk cache of spoken phrases
models/kws/    The downloaded wake-word model (not fetched by npm install; see Setup)
tests/         Vitest unit tests
```

## Roadmap

1. A trained (not synthetic-voice-tuned) wake word, once real usage data exists.
2. Confirmation prompts, then file operations (copy/move/rename) behind them.
3. Packaging the app for distribution (there is no build/installer step yet).
