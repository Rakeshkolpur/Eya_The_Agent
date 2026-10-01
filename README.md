# Eya

Windows-first AI desktop agent. Local-first where it can be, Gemini where it helps. Electron + TypeScript strict.

## What it does

- **Hears you on your own PC.** Always-on listening: voice-activity detection cuts real utterances out of the mic, and an on-device Whisper model (`whisper-tiny.en`, ~43 MB, downloaded once from Hugging Face and cached) turns them into text. Simple commands ("open Notepad") are then handled locally with **no cloud call at all**. Until the model has loaded, or if it fails, speech goes to Gemini instead. On first use it also times your graphics chip against your processor (a few seconds, once) and keeps whichever transcribes faster; an Intel UHG-class chip typically wins by about 2x.
- **A real wake word.** Saying "hey Eya" is recognized as *sound*, not by waiting for a whole sentence to be transcribed: a small always-on keyword-spotting model (~41 MB, downloaded once) listens continuously and opens Talk mode the moment it hears the name. If it misses (it catches roughly half of attempts by itself), the existing text-based check still catches most of the rest a moment later, once the utterance is transcribed — the two run side by side and either can start the conversation.
- **One voice button.** Listening and speaking are switched on and off together, and Eya goes silent immediately when you turn it off.
- **Talk mode (Gemini Live).** The **Talk** button, or just saying "Hey Eya", opens a real-time spoken conversation: Gemini's own voice, low latency, tools available mid-conversation. It ends when you press the button again, say so, or after a quiet spell. Only "Hey Eya" (or the name however it is misheard) starts it; a command such as "Hey Eya, open Notepad" is still handled as a plain command.
- **Interrupt her.** The **Interrupt** pill (on by default) lets you talk over Eya mid-sentence in Talk mode and have her stop and listen, the way a phone call works. Turn it off if your microphone picks up her own voice from the speakers and she ends up interrupting herself.
- **A natural voice, your choice of 13.** Outside Talk mode Gemini's speech models stream audio in about a second. Replies heard before are saved and play instantly. Pick from 8 female and 5 male voices in the panel's dropdown, grouped by gender — the five male voices are curated personas (warm/friendly, deep/calm, professional, young/energetic, natural/conversational), each confirmed live on both the streaming voice API and the Live conversation API before being added. If the cloud voice is unavailable it falls back to the offline Kokoro voice, then the Windows voice.
- **Multi-step tasks.** "Find my latest PDF in Downloads, read it and tell me the hearing date" chains tools: the model picks a tool, gets the result, and repeats until it has an answer (typed/agent path: max 16 steps / 90 s — a website task can genuinely need more back-and-forth than a file search ever did, since the number of steps depends on what the live page actually shows at each one, not a fixed count). If a step takes more than a couple of seconds Eya says "Working on it." (in Talk mode a Live tool call is also given up on after 40 s, and Eya says it took too long).
- **Instant simple commands.** "Hey Eya, could you please open Notepad?" is matched locally.
- **Can actually change things now, carefully.** Eya can create folders, copy, move, rename and delete files and folders — chained together, e.g. "find my latest PDF, create a folder called Cases on my Desktop, and put it there." Nothing that deletes or overwrites something ever happens on the first ask: the tool returns the question instead of acting, Eya asks it out loud, and only your next clear yes makes her do it. "It", "that file" and "the folder" resolve to whatever was most recently found or touched, across separate requests, not just within one sentence.
- **A real Recycle Bin, not a lookalike.** Eya can list what's actually in it, search it by name or by when something was deleted, restore one item or everything that's safe to restore, permanently delete a single item, or empty the whole bin — always against the real Windows Recycle Bin, never a separate list of her own. Restoring refuses if the original location is outside your user folder or something already occupies that name; emptying the bin always asks first, stating exactly how many items and how much space it would clear.
- **Searches your whole PC, not just Downloads.** "Play Con City", "open my petition PDF" — unless you name a folder, Eya searches your entire user folder plus every connected drive, never just Downloads/Desktop/Documents. Windows' own file index answers most of these instantly; a real, slightly slower search of every drive runs alongside it regardless, so a file the index doesn't know about (a second drive, say) is never silently missed. Beyond name and type: "find PDFs from yesterday", "find images larger than 5 MB", "find Word files modified this week". If several files match what you're about to act on, Eya lists the actual names — and where each one is, if they're in different places — and asks which one rather than guessing; once she's listed them, "the second one" or "the cause list one" correctly picks from that exact list, even in a later, separate request.
- **"Play" a file, wherever it is.** There's no separate play tool: "play Con City" finds the video, then opens it in your default player, the same way opening any file does. A file Eya finds outside your own user folder (another drive, a folder like `C:\Movies`) can be opened, played or read exactly like one inside it.
- **Closes the document, not the app.** "Close report.docx", "close that PDF", "close it" (right after opening something) close just that document's window — the application stays open if you have other documents in it. "Close Word" still closes the whole app; Eya tells the two apart from how you ask.
- **A few Windows settings, directly.** "What's my volume?", "set the brightness to 40 percent", "mute", "open the display settings page" — verified against the actual system state after each change, not just assumed. Deliberately not included: turning Wi-Fi or Bluetooth on/off (see Safety).
- **Lock, restart and shut down — for real, not a Settings page.** "Lock my screen" actually locks Windows right now, the same as Win+L, with no confirmation needed. "Restart" and "shut down" actually do it, always asking first since they affect every open application, not just Eya — and never force-close anything, so an app with unsaved work gets to ask you itself, the same polite rule closing an app already follows.
- **Opens the real application, not a search.** "Open WhatsApp" looks the app up the way Windows' own Start Menu search would — ordinary installed programs and Microsoft Store/UWP apps alike — and launches the real thing if it's there, not a guess or a browser tab. Only if nothing is genuinely installed does it fall back to a well-known official web app (WhatsApp, Telegram, Discord, Spotify) opened in whichever browser already looks actively in use, rather than launching a different one; if there's neither an installed app nor a known web version, Eya says so plainly instead of searching the web for it.
- **Navigates an actual website, instead of guessing a URL or searching for it.** "Open the High Court of Telangana website and go to Cause List" opens the real site (searching the web only to confirm its URL, once), then looks at what's genuinely on the page and clicks the real "Cause List" link — never "go to Cause List" turned into a Google search, and never an invented address. Works the same way for any website — a store's orders page, an inbox's Sent folder, a code host's repositories — since it looks at the actual page each time rather than assuming how one is laid out. If what you asked for isn't visible, Eya says what actually is there instead of guessing, and a multi-step conversation ("Cause List is open — which kind?" / "Advocate Code Wise" / "21295") keeps using that same page.

### Tools

| Tool | What it does |
| --- | --- |
| `open_application` / `close_application` | A short list (Notepad, Calculator, File Explorer, Edge, Chrome, Firefox) launches directly; any other name is looked up the way Windows' Start Menu search would, then falls back to a known web app (WhatsApp, Telegram, Discord, Spotify) if nothing is installed. |
| `close_file` | Closes the specific window a document/image/PDF is open in, by matching its title — not the whole application. |
| `find_file` | Searches your whole user folder plus every connected drive by name, type, size or date (exact day, a range, or "yesterday"/"this week"/etc), unless a specific folder is given. Windows' file index first, a real drive-by-drive search alongside it. |
| `read_file` | Read plain-text files, anywhere on the PC. |
| `analyze_document` | Read a PDF, image or text file and answer a question about it (sent to Gemini), anywhere on the PC. |
| `web_search` | Google-grounded answer with sources. |
| `open_file` / `open_folder` / `open_url` | Open (or play) things the way Windows would, anywhere on the PC. `open_url` can target a specific browser. |
| `create_folder` | Create a folder under a special folder or a full path. Idempotent: doing it again just confirms it's there. |
| `copy_file` / `move_file` / `rename_file` | Only ever overwrite an existing file after the user has explicitly agreed to it (see Safety). |
| `delete_file` / `delete_folder` | Always asks which kind first — see Safety. `delete_folder` also reports how many files it would remove. |
| `get_recycle_bin_items` / `get_recycle_bin_count` | Lists what's really in the Windows Recycle Bin right now, or just its count and total size (via `SHQueryRecycleBin`). |
| `find_recycle_bin_item` | Searches the Recycle Bin by name and/or when it was deleted. |
| `restore_recycle_bin_item` / `restore_all_recycle_bin_items` | Moves an item (or everything it safely can) back to where it was deleted from. Asks which one if a name matches more than one item; refuses anything whose original location is outside your user folder or already occupied by something else. |
| `permanently_delete_recycle_bin_item` | Removes one item from the Recycle Bin for good — no further undo. |
| `empty_recycle_bin` | Empties the whole Recycle Bin. Always asks first, stating the real item count and size. |
| `clipboard_read` / `clipboard_write` / `clipboard_clear` | Plain-text clipboard access. |
| `open_windows_settings` / `open_settings_page` | Opens the Settings app, optionally straight to a specific page (Wi-Fi, Bluetooth, Display, Sound, ...). |
| `get_volume` / `set_volume` / `mute_volume` / `unmute_volume` | Exact system volume, read and set, verified after the change. |
| `get_brightness` / `set_brightness` | Exact screen brightness, read and set, verified after the change. Reports plainly if your display has no software brightness control (common on external monitors). |
| `lock_screen` | Actually locks the Windows workstation. No confirmation needed. |
| `restart_computer` / `shutdown_computer` | Actually restarts or shuts down the PC. Always asks first — see Safety. |
| `open_website` | Opens a website (by its exact URL) in Eya's own dedicated browser window, becoming the current page for the three tools below. |
| `inspect_page` | Reads what's actually on the current page right now — headings, visible links, buttons, form fields. |
| `click_on_page` | Clicks a link, button or menu item on the current page by its visible text. Never a web search, never an invented URL — see Safety. |
| `fill_on_page` | Fills a visible form field on the current page by its label or placeholder. |

### Safety

- **Finding, opening, playing and reading a file reaches your whole PC; changing one stays inside your user folder.** `find_file`, `open_file`, `open_folder`, `read_file` and `analyze_document` can reach anywhere accessible — your own folder, any other connected drive — but `create_folder`, `copy_file`, `move_file`, `rename_file`, `delete_file` and `delete_folder` still only ever touch something inside your own user folder, unchanged. Secrets are blocked everywhere either way (`.env`, `.ssh`, `AppData`, `*.pem`, `credentials.json`, ...), including this project's own `.env`, and so are Windows/program internals (`C:\Windows`, `Program Files`, `$Recycle.Bin`, ...) and another Windows account's own profile — Eya only ever sees what you, this account, could see in File Explorer.
- Programs and scripts (`.exe`, `.ps1`, `.lnk`, ...) are never opened.
- Closing apps is polite: Eya asks the window to close and reports honestly if it stays open (for example "save changes?"). She never force-kills anything except Calculator, which ignores polite requests and has nothing to lose. Explorer windows are closed individually, never by ending `explorer.exe`, so your desktop and taskbar are untouched.
- Text inside files, web pages and the clipboard is treated as information, never instructions.
- **Delete or overwrite always asks first, out loud, and nothing else can skip that.** The tool itself refuses to act on the first call — it hands back a plain question instead of a result. Eya can only proceed once she calls the same tool again with an explicit "the user agreed" flag, which the model is instructed to set only after you've clearly said yes in that same conversation. This lives in the tool's own logic, not in a prompt the model could just ignore.
- **Deleting always offers a real choice, never just permanent.** "Do you want me to delete X normally, so it goes to the Recycle Bin, or permanently delete it?" — a normal delete genuinely uses the Windows Shell's own Recycle Bin mechanism (`Microsoft.VisualBasic.FileIO.FileSystem`, the same one behind Explorer's own Delete), not a lookalike; a permanent delete is the only one that skips it. Verified live, both ways, checking the real Recycle Bin's contents afterward.
- **Recycle Bin tools work against the real Recycle Bin.** Listing, counting (`SHQueryRecycleBin`), restoring and deleting all read and change the actual per-drive `$Recycle.Bin` contents — never a separate list Eya keeps herself. Restoring re-checks the same folder boundary as any other file write (refuses outside your user folder, or if something already occupies that name); permanently deleting an item already in the bin, and emptying the whole bin, skip that particular check since the item is already on its way out regardless — but emptying always asks first, stating the real count and size, and only proceeds on an explicit yes.
- `delete_folder` will not touch Desktop, Downloads, Documents, or any other of your main folders, whatever else is asked of it — only something inside them.
- Every create/copy/move/rename/delete is verified after the fact by actually checking the filesystem, not just trusting that the call didn't throw.
- A bare file or folder name (not a full path) can never contain `/`, `\`, or `..`, so a name argument can't be used to sneak outside the folder it was given for.
- Eya still cannot send, install, or purchase anything.
- `analyze_document` uploads the file to Gemini to read it; that is inherent to the feature.
- **No Wi-Fi/Bluetooth toggle tools, on purpose.** Turning off the machine's own Wi-Fi adapter risks cutting off the PC Eya runs on, and turning off Bluetooth risks dropping a wireless mouse or keyboard; both also typically need administrator rights, which Eya doesn't run with. Their Settings *pages* still open on request — flipping the switch is left to you.
- **Restarting or shutting down always asks first, every time, the same as a delete.** The first call does nothing and hands back a plain question; only a clear yes gets a `confirm: true` retry. Neither one force-closes anything — Windows itself asks any application with unsaved work to close first, exactly like `close_application` already does, so a restart can genuinely pause on a "save changes?" prompt in some other program. Locking the screen needs no confirmation: it's reversible with your own password and has nothing to lose.
- **"Open X" only ever launches something real.** Beyond a short built-in list, an unrecognized app name is checked against Windows' own Start Menu registration (the same source its own search uses) — this deliberately excludes uninstallers and documentation/website shortcuts that Windows also lists there, so "open node" can never be misread as "run the Node.js uninstaller". Only when nothing is genuinely installed does a small table of known official web apps get tried, and only in a browser that already looks in active use (several of its processes already running, not just one leftover background helper) or, failing that, your default browser — never a browser you weren't already using. If neither exists, Eya says so instead of guessing or web-searching.
- `close_file` matches a document to a window by its title (e.g. "report.docx - Word"), not full Windows UI Automation — it can't yet tell which of two identically-named documents in different folders is which, and it correctly refuses rather than guessing when more than one open window matches.
- **Website navigation never turns "go to X" into a search, or a guessed URL.** `click_on_page`/`fill_on_page` only ever act on something actually visible on the page that's currently open, found by inspecting it fresh each time — never by remembering how a site "usually" looks or inventing an address. If nothing matches, Eya is told what IS actually there instead of guessing further. `open_website` runs in a browser window dedicated to Eya herself, not your everyday Chrome/Edge — a separate, persistent profile that keeps you signed in across sessions once you sign in there, but starts logged out of everything the first time, same as a brand new browser profile would. You can see this window and what it's doing; closing Eya closes it too.
- No general system-command tool exists or is planned — every capability here is a specific, typed function, never an arbitrary shell command the model could construct.

## Setup

Prerequisites: Node.js 20+, Windows 10/11, and Edge or Chrome installed (website navigation drives one of these directly via Playwright — it doesn't bundle or download its own browser).

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
    windowsApi/  Process launch/verify, App Paths lookup (no shell), appDiscovery.ts (Get-StartApps + shell:AppsFolder launch)
    browser/     BrowserAutomationService (Playwright, one persistent page), pageSnapshot.ts (what's on a page, index-based element matching)
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

There's no separate pause-and-wait mechanism bolted onto the agent loop — it rides the same tool-call loop everything else already uses. A destructive or overwriting tool, called without `confirm: true` (or, for delete specifically, without `mode`), does nothing and returns a normal (if unsuccessful) tool result whose `data` is a small structured question (`{ status: 'permission_required', action, target, reason, options }`). The model is told, in that tool's own description and in the system prompt, to relay that question and only call the same tool again — with `confirm: true`, or with `mode: 'recycle' | 'permanent'` for a delete — once the user has clearly answered in that conversation. This means it works identically for typed commands, voice commands, and Talk mode, with no extra plumbing in any of them — verified live: asking to delete a file gets a spoken question offering both kinds and the file is untouched; a separate follow-up like "normal delete" or "permanently delete it, delete it completely" correctly re-targets the same file with the right mode (confirmed both by the reply and by checking the real Recycle Bin's contents), with no file path in the follow-up's own words at all.

## Reporting when something is actually done

Once a tool result confirms a plain action (open/close something, create/copy/move/rename/delete a file or folder, change a setting) truly succeeded, with nothing else worth mentioning, Eya's whole reply is just "Done." — not a description of what she did. She only says more when there's something to actually hear: an answer, search results, a caveat (an alternative was used, something was already in the state asked for, it stayed open), or a question of her own. This governs both the fast local path for simple app open/close (`ResponseComposer`) and everything that goes through the Gemini agent loop (a system-prompt rule) — verified live for both: opening Notepad, creating a folder, and completing a chosen delete all replied with exactly "Done."

## How the whole-PC file search works

`find_file`, with no folder named, runs two searches at once rather than stopping at the first one that turns up something:

1. **Windows' own file index** (`Search.CollatorDSO`, the same index behind Explorer's own search box and Start menu search) — instant, but normally only covers what Windows indexes by default, which is your own user profile, not other drives.
2. **A real filesystem walk of every other connected drive** (discovered live every time — never hard-coded to C or D), skipping Windows/program internals (`Windows`, `Program Files`, `Program Files (x86)`, `ProgramData`, `$Recycle.Bin`, `System Volume Information`, ...) and any other Windows account's own profile folder, but reaching ordinary user-created folders anywhere else.

If the index came back with nothing at all for that search, your own user folder gets a real walk too, concurrently — so a stale or disabled index, or a file that simply isn't indexed yet, doesn't produce a false "I couldn't find it". The two (or three) results are merged and de-duplicated before anything is shown. This was verified against a real second drive the index doesn't cover: a file that exists in three places at once (two indexed, one not) came back with all three, not just the indexed two — an actual bug, caught live, from an earlier version that trusted the index alone and stopped there whenever it found anything.

## How opening any installed application works

Beyond the short built-in list, `open_application` looks a name up against `Get-StartApps` — the same catalog Windows' own Start Menu search uses, covering ordinary Win32 programs and Microsoft Store/UWP apps uniformly. A match is launched via `explorer.exe shell:AppsFolder\<AppID>`, the one launch mechanism that works for both kinds (verified live against a classic `.exe`-backed entry and a UWP AppUserModelID-backed one). Since a dynamically-discovered app's eventual process name isn't known in advance, it's verified by snapshotting running processes just before launching and confirming a genuinely new one appears afterward — verified live launching Visual Studio Code (not on the built-in list) this way. Entries Windows itself also lists there but that are never really "the app" — an uninstaller, a documentation or website shortcut — are filtered out by name before matching, so "open node" can't be misread as "run the Node.js uninstaller".

If nothing is genuinely installed, a small table of apps with a real official web client (WhatsApp, Telegram, Discord, Spotify) is tried instead, opened in whichever browser already has several processes running — a rough but effective "is this one actually open, not just a leftover background helper" check — or the default browser otherwise. Verified live: WhatsApp (not installed on this machine) correctly opened `web.whatsapp.com`. What's deliberately not built: genuine browser-tab awareness in the user's own everyday browser — detecting that a WhatsApp Web tab is already open there and focusing it instead of opening another. Real browser automation now exists (below), but it drives Eya's own separate, dedicated browser window, not your regular Chrome/Edge — attaching to an already-running everyday browser isn't something Windows lets another program do safely after the fact, only one launched with that in mind from the start. Opening a URL Windows' own single-instance browser behavior already tends to land as a new tab in an already-running browser rather than a new window, which covers the common case without any of that.

## How website navigation works

The core rule: "go to Cause List" means look at the page that's actually open and click the real thing, never turn it into a web search or invent a URL. `open_website` opens a page in a browser window dedicated to Eya (Playwright driving your installed Edge, falling back to Chrome, with its own separate profile — see Safety); `inspect_page` reads what's genuinely on it (headings, visible links, buttons, form fields); `click_on_page`/`fill_on_page` act on something from that real, freshly-read list by its visible text or label. The model is told explicitly, in both the system prompt and each tool's own description, that `web_search`/`open_url` are for finding a site or showing a one-off page, never for moving around inside a site that's already open.

A real bug surfaced live while building this, worth recording: a link or button's visible text, read straight from the page, often comes padded with the surrounding markup's whitespace (`"\n\t\t\t\tCause List\n\t\t\t"`), and re-querying Playwright for "the element named exactly that text" doesn't reliably match what the browser itself computes as that element's accessible name — on the real High Court of Telangana site, this made a click silently hang for 40 seconds before failing, for a link that was genuinely right there. Fixed by never re-querying by name at all: the matching logic picks an *index* into the same list of elements it just read, and clicks that exact element directly, so the two systems never need to agree on what counts as "the same name". Verified live end-to-end, with that exact fix, against two unrelated real sites: opening the High Court of Telangana's site, clicking "Cause List" then "Entire Causelist" (which genuinely reached a results page, not a guess), and separately opening Wikipedia and clicking "Donate" — proving it's a general mechanism, not something tuned to one page.

**Nothing about any specific website is ever predicted.** Every `open_website`/`click_on_page`/`fill_on_page` result carries a completely fresh read of whatever page it left the browser on — its own headings, links, buttons, fields and any visible popup/dialog — and the system prompt is explicit that this fresh result, not a remembered structure or a convenient example, is the only thing the next decision is based on. A native `alert()`/`confirm()`/`prompt()` popup (which would otherwise block the whole browser, waiting forever) is auto-dismissed and reported in the very next result instead of silently hanging. This was a real course-correction: an earlier version of the system prompt illustrated "ask the user to choose" with the Telangana cause list's own category names as an example, which risked the model treating one site's structure as a pattern to expect elsewhere — removed, with the rule now stated only in the fully generic form (if the live page offers a genuine choice the user's own request doesn't already resolve, list the real options it actually shows and ask; if the request already determines the choice, or there's only one sensible option, just act). The agent's own step budget was raised (8 → 16 tool calls, same 90-second ceiling) since a real multi-page task can need more round trips than a file search ever did.

Deliberately not built, because each needs its own real testing as a separate subsystem: a Gemini Computer Use (screenshot-driven) fallback for when DOM inspection alone can't identify something, Windows UI Automation as an alternative path, and downloading/verifying a file a site produces (e.g. an actual cause-list PDF) — this phase stops at reliably navigating and reading a site, which was the specific, reported failure.

## Lock, restart and shutdown

`lock_screen` calls Windows' own `LockWorkStation` (`user32.dll`, via `rundll32.exe user32.dll,LockWorkStation` — the same mechanism Microsoft documents for this), then confirms it actually worked by checking that `LogonUI.exe`, the real lock-screen process, appears afterward — not just that the request was sent. `restart_computer` and `shutdown_computer` use Windows' own `shutdown.exe` (`/r` or `/s`, deliberately without `/f`, so an application with unsaved work gets asked to close first rather than force-killed) behind the same ask-first `confirm: true` gate every other destructive tool uses, with a short 5-second delay before either fires so Eya's own spoken "Done." has time to actually finish playing first.

**Honestly, not fired live.** Locking the screen wasn't tested live without asking first, since it would interrupt whatever the user is doing without warning. Restarting and shutting down were built and fully unit-tested with fakes, but a live end-to-end fire — even the safe "schedule it an hour out, then immediately cancel it" trick — was refused outright by this environment's own safety classifier as a real-world system transaction, and rightly so; actually rebooting or shutting down the machine autonomously is exactly the kind of action that should need the user's own hands on it, not an agent's.

## A Recycle Bin gotcha: hidden file extensions

Windows Explorer's Shell COM interface (`Shell.Application`, `Namespace(10)`) exposes a recycled item's display name through its `.Name` property — which silently drops the extension whenever Explorer's own "hide extensions for known file types" setting is on, so a file actually named `report.pdf` gets reported back as just `report`. That broke exact-name lookups (asking to restore `report.pdf` wouldn't match a listed `report`) and was only caught live, not by a unit test, since the fakes used in testing never had that Explorer setting to leak. Fixed at the source, by reading the `System.FileName` extended property instead (reliable, unaffected by that display setting), plus a belt-and-braces fallback in the matching logic itself that also tries the name with its extension stripped either way.

## Roadmap

Two large continuation phases have been requested and scoped down to what could be built and genuinely verified, rather than attempted whole. Delivered: file operations + confirm-before-destroy + reference resolution (phase 2), then smart file search (date/size/type filters, multi-match disambiguation, a numbered "search session" so "the second one" resolves), `close_file` (by window title, not full UI Automation), and a handful of Windows system controls (Settings pages, exact volume, exact brightness) (phase 3), a recycle-vs-permanent delete choice with a consistent "Done." completion reply (phase 4), full Recycle Bin management (list, count, search, restore one or all, permanently delete, empty — all against the real Windows Recycle Bin) plus five additional male voice options (phase 5), a whole-PC default search scope for finding, opening, playing and reading files — every connected drive, not just Downloads/Desktop/Documents (phase 6), real lock/restart/shutdown plus Start-Menu-wide application discovery with a known-web-app fallback (phase 7), and real, DOM-aware website navigation (open/inspect/click/fill on a page, never a search or an invented URL in its place) (phase 8).

Deliberately not attempted, because each is a substantial subsystem needing its own real testing (and in two cases, a considered no rather than a "later"):

1. **Genuine browser-tab awareness in the user's own everyday browser** (detecting an already-open WhatsApp-Web-style tab there and focusing it instead of opening another) — real browser automation now exists (see above), but it drives Eya's own dedicated browser window, not your regular Chrome/Edge; attaching to an already-running everyday browser isn't something Windows lets another program do safely after the fact.
2. Downloading a file a website produces (e.g. an actual cause-list PDF) and verifying it, within the new website-navigation tools.
3. Windows UI Automation proper (HWND/focus-event tracking, `WindowPattern.Close`), for richer window/document association than the current title-matching `close_file` gives, and as an alternative path for a page element DOM inspection alone can't identify.
4. A Gemini Computer Use (screenshot-driven) fallback for when neither DOM inspection nor UI Automation can find what it needs.
5. **Wi-Fi/Bluetooth on/off — a deliberate no, not a "later".** Toggling the Wi-Fi adapter risks cutting off the machine Eya runs on; toggling Bluetooth risks dropping a wireless mouse/keyboard; both typically need administrator rights besides. Their Settings pages still open on request.
6. A "trusted mode" setting that skips confirmation for destructive actions (off by default; not started).
7. A task queue with cancellation ("stop", "never mind") and long-running/async tool handling.
8. An audit log of every action taken; detecting a file the user opened manually, outside Eya, and associating it automatically.
9. A trained (not synthetic-voice-tuned) wake word, once real usage data exists.
10. Packaging the app for distribution (there is no build/installer step yet — now also needs to ship Playwright's browser-launch logic, which expects a real Edge/Chrome install on the target machine rather than bundling its own).
