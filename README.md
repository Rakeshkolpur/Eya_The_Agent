# Eya

**Eya is a Windows desktop AI assistant that listens, talks and actually does things on your PC** — opens and edits your files, works in Word / Excel / PowerPoint, drives your browser, messages people in WhatsApp Web for you, and fixes ordinary PC problems — while asking before anything that cannot be undone.

Electron + TypeScript (strict). Local-first where it can be (speech recognition, wake word, memory, an optional local model through Ollama), a cloud model (Google Gemini, or an OpenAI-compatible one) where it helps. **You bring your own API keys; nothing is hard-coded or sent to the author.**

> **Status: a personal project, made public.** It works on the author's PC and has 5,000+ automated tests, but parts of it have only been tested against mock pages and not against the real services (see [What is and is not verified](#what-is-and-is-not-verified)). Expect rough edges. Windows 10 / 11 only for now.

## What it can do

- **Voice.** An always-on wake word ("hey Eya") that runs on your PC, on-device speech recognition (Whisper tiny.en), a real-time spoken conversation with Gemini Live, and a natural voice. You can interrupt her mid-sentence.
- **Your files.** Searches the whole PC, reads documents and PDFs, creates / copies / moves / renames / deletes (and restores from the Recycle Bin) — always asking before anything destructive, and checking afterwards that it really happened.
- **Your browser.** Her own built-in browser (Eya Browser), or your own signed-in Chrome / Edge through a small extension (`eya-chrome-extension/`) that talks only to Eya on `127.0.0.1`. She fills forms, clicks, reads pages, downloads files, books and orders — and stops before the last click that spends money or sends something.
- **Chats (WhatsApp Web), off until you switch them on.** Finds a chat by name or number, sends a message or a file once and verifies it, and can keep a "live chat" going for you. A privacy switch ("Communication Access") decides which chat apps Eya may touch at all.
- **Microsoft Office.** Types live into your open Word document, formats, numbers, indexes, fixes broken tables, recreates a photographed page; reads and writes Excel and PowerPoint; writes in Notepad.
- **Fixes problems on your PC.** Installs / uninstalls programs (winget), environment variables and PATH, "make my PC fast", stops background and start-up apps, microphone checks — every change shown first, written down, and undoable where Windows allows it.
- **Writing on LinkedIn (draft → you say yes → publish).** Drafts a post with a picture, fills the page, and publishes only after your yes, within daily limits. See [Safety](#safety-by-design).
- **Plugins.** A manifest-based plugin layer over the same tool registry (WhatsApp and LinkedIn ship built in); every permission is a separate click of yours.
- **Memory and routines.** A local SQLite database of what you told her to remember and routines you taught her; nothing leaves the PC.

The long, dated history of how each part was built, measured and fixed is in [`docs/DEVELOPMENT_LOG.md`](docs/DEVELOPMENT_LOG.md).

## Safety by design

Eya acts for you, so the rules are enforced **in code**, not only in the prompt:

- **Destructive or outward-facing actions ask first** (delete, send, buy, publish, restart, install), and what was asked is what is done: a model's "confirm" alone is not a yes — the *user's own words* are checked.
- **Passwords, card numbers and CAPTCHAs are always yours.** Eya never types a password or a card number and never solves a CAPTCHA. A one-time code is typed only if you said it aloud.
- **Chat apps are off until you switch them on**, and the switch is yours alone — no tool, page or model can flip it.
- **Publishing in your name** (LinkedIn) is held, at the click, to a permission you grant, daily limits, "no promise of a result / no client matter" checks, and your yes to that exact text.
- **Nothing is claimed that was not verified.** After a send, a delete or a download she looks for the result and reports what she saw.
- **Local-first privacy.** Speech recognition, the wake word, memory and the optional local model run on your PC. What goes to a cloud model is what you ask it about.

Read [`SECURITY.md`](SECURITY.md) for how to report a vulnerability, and the disclaimers below.

## Requirements

- Windows 10 or 11 (64-bit). Much of Eya drives Windows itself (PowerShell, UI Automation, Word / Excel / PowerPoint COM).
- Node.js 20 or newer and npm.
- Optional: Google Chrome and/or Microsoft Edge (for the browser extension), Microsoft Office (for the Office tools), [Ollama](https://ollama.com) (for a local model).
- An API key for the cloud model you want to use (see below). Eya's built-in "local commands" work without one.

## Quick start

```powershell
git clone https://github.com/Rakeshkolpur/Eya_The_Agent.git
cd Eya_The_Agent
npm install
copy .env.example .env      # then put your own key(s) in .env
npm run fetch-models        # downloads the speech-recognition model (checked against scripts/models.lock.json)
npm run dev                 # starts Eya in development mode
```

Useful scripts: `npm run typecheck`, `npm test`, `npm run build`, `npm run start` (run the production build), `npm run dist` (build the Windows installer — unsigned).

### Configuration (`.env`)

| Variable | What it is |
| --- | --- |
| `EYA_GEMINI_API_KEY` | Your Google Gemini key ([get one](https://aistudio.google.com/apikey)). You can also add keys in Eya's Settings (stored encrypted with Windows DPAPI). |
| `EYA_GEMINI_MODEL`, `EYA_GEMINI_TRANSCRIBE_MODEL`, `EYA_TTS_MODELS` | Optional model choices. |
| `EYA_OLLAMA_URL`, `EYA_OLLAMA_MODEL` | Optional local AI through Ollama (nothing leaves the PC). |
| `EYA_LOG_LEVEL` | `debug`, `info`, `warn`, `error`. |

**Never commit `.env`** (it is git-ignored). The OpenAI-compatible backup AI and the Gemini key pool are set in the app's Settings, not in files in this repository.

### The browser extension

For your own signed-in Chrome or Edge, load `eya-chrome-extension/` once with "Load unpacked" (Developer mode). It pairs itself with Eya through a key file Eya writes into that folder (git-ignored) and only talks to `127.0.0.1`.

## Project layout

```
src/main/        the app: agent loop, tools, browser, chats, Office, PC fixer, memory, plugins, social
src/renderer/    the windows: bubble, quick assistant, full app
src/shared/      types shared by both sides
eya-chrome-extension/   the browser bridge (Manifest V3)
scripts/         model download (with checksums), icon, packaging helpers
tests/           5,000+ unit tests and opt-in live tests (tests/live)
docs/            the development log
```

Run the live tests (real Chrome / Electron, mock pages) only on purpose: they are opt-in (`EYA_LIVE_BROWSER=1 npx vitest run tests/live/<file>`) and never touch your real accounts.

## What is and is not verified

Everything is covered by unit tests, and most features were also run for real: the real Electron app, real Chrome with the extension against mock pages, real Word / Excel / PowerPoint (in a private hidden instance), a real local model. **Not verified against the real services:** a signed-in WhatsApp Web, a signed-in LinkedIn, real voice conversations with every model, anything that needs a paid API allowance the author did not have. Those parts are written against what the pages looked like in the author's own sessions and may need small fixes on your side — issues and pull requests are welcome.

## Disclaimers — please read

- **Unofficial.** Eya is not affiliated with, endorsed by or sponsored by WhatsApp / Meta, LinkedIn / Microsoft, Google, OpenAI, Microsoft or any other company named in this project. Names are used only to say what Eya works with.
- **Terms of service.** Automating a website or an app (WhatsApp Web, LinkedIn, Fiverr and others) can be against that service's terms and can get your account limited or banned. Eya keeps human-paced, rate-limited and consent-based, but **you use it at your own risk** and are responsible for following the terms of the services you use and the law and professional rules that apply to you.
- **AI makes mistakes.** Check what it writes before it goes out in your name. Eya asks first, but you are the one who says yes.
- **Your data.** What you ask a cloud model about is sent to that provider under their terms. Use the local model (Ollama) if that matters. Eya has no server of its own and collects nothing.
- **No warranty.** See the license.

## Contributing

Issues and pull requests are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). Please **never** paste real keys, phone numbers, chat contents or other private data into an issue, a test or a commit.

## License

[Apache License 2.0](LICENSE). Third-party software and models are listed in [`NOTICE`](NOTICE).
