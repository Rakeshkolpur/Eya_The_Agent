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
- **Can actually change things now, carefully.** Eya can create folders, copy, move, rename and delete files and folders — chained together, e.g. "find my latest PDF, create a folder called Cases on my Desktop, and put it there." Nothing that deletes or overwrites something ever happens on the first ask: the tool returns the question instead of acting, Eya asks it out loud, and only your next clear yes makes her do it. "It", "that file" and "the folder" resolve to whatever was most recently found or touched, across separate requests, not just within one sentence.
- **Smart file search.** Beyond name and type: "find PDFs from yesterday", "find images larger than 5 MB", "find Word files modified this week". If several files match what you're about to act on, Eya lists the actual names and asks which one rather than guessing — and once she's listed them, "the second one" or "the cause list one" correctly picks from that exact list, even in a later, separate request.
- **Closes the document, not the app.** "Close report.docx", "close that PDF", "close it" (right after opening something) close just that document's window — the application stays open if you have other documents in it. "Close Word" still closes the whole app; Eya tells the two apart from how you ask.
- **A few Windows settings, directly.** "What's my volume?", "set the brightness to 40 percent", "mute", "open the display settings page" — verified against the actual system state after each change, not just assumed. Deliberately not included: turning Wi-Fi or Bluetooth on/off (see Safety).

### Tools

| Tool | What it does |
| --- | --- |
| `open_application` / `close_application` | Notepad, Calculator, File Explorer, Edge, Chrome, Firefox. Checks the app is installed first and offers an alternative if not. |
| `close_file` | Closes the specific window a document/image/PDF is open in, by matching its title — not the whole application. |
| `find_file` | Search Downloads/Desktop/Documents (or another folder) by name, type, size or date (exact day, a range, or "yesterday"/"this week"/etc). |
| `read_file` | Read plain-text files. |
| `analyze_document` | Read a PDF, image or text file and answer a question about it (sent to Gemini). |
| `web_search` | Google-grounded answer with sources. |
| `open_file` / `open_folder` / `open_url` | Open things the way Windows would. `open_url` can target a specific browser. |
| `create_folder` | Create a folder under a special folder or a full path. Idempotent: doing it again just confirms it's there. |
| `copy_file` / `move_file` / `rename_file` | Only ever overwrite an existing file after the user has explicitly agreed to it (see Safety). |
| `delete_file` / `delete_folder` | Always ask first — see Safety. `delete_folder` also reports how many files it would remove. |
| `clipboard_read` / `clipboard_write` / `clipboard_clear` | Plain-text clipboard access. |
| `open_windows_settings` / `open_settings_page` | Opens the Settings app, optionally straight to a specific page (Wi-Fi, Bluetooth, Display, Sound, ...). |
| `get_volume` / `set_volume` / `mute_volume` / `unmute_volume` | Exact system volume, read and set, verified after the change. |
| `get_brightness` / `set_brightness` | Exact screen brightness, read and set, verified after the change. Reports plainly if your display has no software brightness control (common on external monitors). |

### Safety

- Files: only inside your user folder. Secrets are blocked everywhere (`.env`, `.ssh`, `AppData`, `*.pem`, `credentials.json`, ...), including this project's own `.env`.
- Programs and scripts (`.exe`, `.ps1`, `.lnk`, ...) are never opened.
- Closing apps is polite: Eya asks the window to close and reports honestly if it stays open (for example "save changes?"). She never force-kills anything except Calculator, which ignores polite requests and has nothing to lose. Explorer windows are closed individually, never by ending `explorer.exe`, so your desktop and taskbar are untouched.
- Text inside files, web pages and the clipboard is treated as information, never instructions.
- **Delete or overwrite always asks first, out loud, and nothing else can skip that.** The tool itself refuses to act on the first call — it hands back a plain question instead of a result. Eya can only proceed once she calls the same tool again with an explicit "the user agreed" flag, which the model is instructed to set only after you've clearly said yes in that same conversation. This lives in the tool's own logic, not in a prompt the model could just ignore.
- `delete_folder` will not touch Desktop, Downloads, Documents, or any other of your main folders, whatever else is asked of it — only something inside them.
- Every create/copy/move/rename/delete is verified after the fact by actually checking the filesystem, not just trusting that the call didn't throw.
- A bare file or folder name (not a full path) can never contain `/`, `\`, or `..`, so a name argument can't be used to sneak outside the folder it was given for.
- Eya still cannot send, install, or purchase anything.
- `analyze_document` uploads the file to Gemini to read it; that is inherent to the feature.
- **No Wi-Fi/Bluetooth toggle tools, on purpose.** Turning off the machine's own Wi-Fi adapter risks cutting off the PC Eya runs on, and turning off Bluetooth risks dropping a wireless mouse or keyboard; both also typically need administrator rights, which Eya doesn't run with. Their Settings *pages* still open on request — flipping the switch is left to you.
- `close_file` matches a document to a window by its title (e.g. "report.docx - Word"), not full Windows UI Automation — it can't yet tell which of two identically-named documents in different folders is which, and it correctly refuses rather than guessing when more than one open window matches.
- No general system-command tool exists or is planned — every capability here is a specific, typed function, never an arbitrary shell command the model could construct.

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
    tools/       Typed tool registry + implementations (files, file ops, close_file, clipboard, system/volume/brightness, documents, open, apps), verify.ts (post-action verification), dateQuery.ts (when/date-range resolver)
    security/    pathPolicy (what the assistant may touch, including bare-name and write-target checks)
    live/        liveBridge: config + tool execution for Talk mode
    wake/        sentencePiece (tokenizer), keywordSpotter (the model), loadWakeWordDetector
    permissions/ PermissionManager: risk levels (safe/confirm/high_risk/blocked) per action
    providers/
      ai/        GeminiAIProvider (model fallback, retries, daily-limit aware), OllamaAIProvider, ChainedAIProvider
      tts/       GeminiTTS (streaming), TtsStreamService, RendererTTSBridge (serialized queue)
    windowsApi/  Process launch/verify, App Paths lookup (no shell)
    memory/ context/ config/ ipc/ shortcuts/ windows/
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

## A note on latency for the Windows-control tools

`close_file`, the volume tools and the brightness tools each shell out to PowerShell, and the volume ones compile a small C# COM-interop helper on every single call (PowerShell can't call a non-`IDispatch` COM interface like Windows' own volume API directly) — measured live at roughly 0.6-3.2 seconds per call, noticeably slower than the in-process file tools. This is a real, known cost, not a bug; a future pass could keep one PowerShell process warm instead of starting a fresh one each time, but that adds real complexity for what is a background system tweak, not the main flow, so it hasn't been done.

## How "ask before deleting" actually works

There's no separate pause-and-wait mechanism bolted onto the agent loop — it rides the same tool-call loop everything else already uses. A destructive or overwriting tool, called without `confirm: true`, does nothing and returns a normal (if unsuccessful) tool result whose `data` is a small structured question (`{ status: 'permission_required', action, target, reason }`). The model is told, in that tool's own description and in the system prompt, to relay that question and only call the same tool again with `confirm: true` once the user has clearly said yes in that conversation. This means it works identically for typed commands, voice commands, and Talk mode, with no extra plumbing in any of them — verified live: asking to delete a file gets a spoken question and the file is untouched; saying "yes, delete it" (a separate request, with no file path in it at all) correctly re-targets the same file and deletes it, because the file's path is carried forward through `ConversationContext` the same way "copy it to Desktop" resolves "it".

## Roadmap

Two large continuation phases have been requested and scoped down to what could be built and genuinely verified, rather than attempted whole. Delivered: file operations + confirm-before-destroy + reference resolution (phase 2), then smart file search (date/size/type filters, multi-match disambiguation, a numbered "search session" so "the second one" resolves), `close_file` (by window title, not full UI Automation), and a handful of Windows system controls (Settings pages, exact volume, exact brightness) (phase 3).

Deliberately not attempted, because each is a substantial subsystem needing its own real testing (and in two cases, a considered no rather than a "later"):

1. **Semantic website navigation** ("open X and go to Y" correctly opening the site first, then finding Y on the page, instead of turning the whole sentence into a search query) — this needs actual browser automation to exist first (see 2 below); there is currently none, so there is nothing yet to fix.
2. Browser automation itself (Playwright-based, semantic selectors first) and a live "search a real site, click through it, download a file" workflow.
3. Windows UI Automation proper (HWND/focus-event tracking, `WindowPattern.Close`), for richer window/document association than the current title-matching `close_file` gives.
4. A Gemini Computer Use (screenshot-driven) fallback for when neither of the above can find what it needs.
5. **Wi-Fi/Bluetooth on/off — a deliberate no, not a "later".** Toggling the Wi-Fi adapter risks cutting off the machine Eya runs on; toggling Bluetooth risks dropping a wireless mouse/keyboard; both typically need administrator rights besides. Their Settings pages still open on request.
6. A "trusted mode" setting that skips confirmation for destructive actions (off by default; not started).
7. A task queue with cancellation ("stop", "never mind") and long-running/async tool handling.
8. An audit log of every action taken; detecting a file the user opened manually, outside Eya, and associating it automatically.
9. A trained (not synthetic-voice-tuned) wake word, once real usage data exists.
10. Packaging the app for distribution (there is no build/installer step yet).
