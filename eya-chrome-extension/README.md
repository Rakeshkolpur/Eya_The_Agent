# Eya Browser Bridge

A small Manifest V3 extension that lets the **Eya desktop app on the same PC** see and use
the browser you are already signed in to (Microsoft Edge or Google Chrome) — your real tabs,
your real sessions — instead of a separate window with nothing signed in.

It is plain JavaScript on purpose: there is no build step. The browser loads this folder as-is.

## Install (one time, about 30 seconds)

A browser only lets *you* add an unpacked extension, so this part can't be automated.
Saying **"connect my browser"** to Eya opens the extensions page and this folder for you — but only the very first
time, when Eya has never seen the extension (and once per run of Eya). If it is already added and just not answering,
Eya opens nothing and tells you what to check; ask her to "show me the extension folder" if you ever need it again.

1. Open `edge://extensions` (Edge) or `chrome://extensions` (Chrome).
2. Turn on **Developer mode**, and **leave it on**. With it off, the browser switches an
   unpacked extension off the next time it restarts.
3. Click **Load unpacked** and choose this folder (`eya-chrome-extension`).
4. Say "connect my browser" to Eya once. After that it reconnects by itself whenever both are running.

Use Chrome *and* Edge? Add the extension to both, then say "connect my browser" once: one pairing window pairs
each browser separately, and both stay connected at the same time.

**After updating Eya, reload the extension** (the circular arrow on its card). Each connection starts with a
version check (protocol 2, extension 0.5.0); an extension that is too old to work at all is refused with a plain message on the
options page asking you to reload it. A 0.4.0 extension still works, but chat steps are several seconds slower until it is
reloaded (see "Quick mode" below).

The toolbar icon shows **ON** when Eya is connected. The extension's options page shows status.

Works the same in **Chrome** and **Edge** (tested in both, version 154). There is no way to install it into Chrome
silently — Chrome 137 and later ignore the `--load-extension` command-line switch, and a program can't add an
extension to your everyday profile for you — so the "Load unpacked" click above is the one manual step. If you later
want it to behave like a normal extension (no Developer-mode requirement, one-click install), it can be published to the
Chrome Web Store as an unlisted extension; that needs a developer account and is your call, not something Eya can do for you.

## What it can do

For the page Eya is working in: look at it (headings, links, buttons, fields, readable text, tables — including
links held by menus that are closed until hovered or opened), search the whole page for some words, read its text,
click something by its visible text, type into a field, press Enter in a search box, scroll,
go back, forward, reload, follow a link that opens a new tab, notice a download and report where it
landed, open a site (reusing a tab you already have for it, else a new tab in this same browser), list
your tabs and windows, switch to one, close a tab Eya opened (one you opened is refused unless Eya says you agreed).
Every action ends with a fresh look at the page so Eya works from what is really there, not from what she expected.

**Screenshots:** when you ask Eya for one, the extension takes a picture of the tab in front (what is visible in the window)
and hands it to Eya, who saves it on your Desktop. It uses the browser's own capture call under the access it already has — no new
permission — touches nothing in the page, and cannot capture browser pages (`chrome://`, `edge://`) or private windows. Needs
extension 0.3.0: reload the extension once after updating Eya.

**Chat apps and Communication Access (extension 0.4.0):** whether Eya may look at or act in WhatsApp, Telegram, Instagram and similar
chat sites is the user's choice, made with the **Chats** switch in Eya's panel. It starts **OFF**. A browser lets an extension read
every site or none, so the extension cannot be given *less* access; instead it **declines to use** what it has: while the switch is off,
a chat tab is never read, clicked in, typed into or photographed, and its title (which can be a contact's name) and any query in its
address are never reported. Eya tells the extension which sites are off (`set_policy`, kept only in the browser's memory-only session
storage, and re-sent whenever the switch changes); until she does, every chat site is treated as off. The list in `policy.js` is
checked against Eya's by a test so the two cannot drift apart. Eya's own side enforces the same rule, so an older extension that does
not know `set_policy` is still never used on a chat page while the switch is off.

**Attaching a file to a chat app (extension 0.4.0):** a page's own "choose a file" window is native and no script can drive it, but chat apps keep
(usually hidden) file inputs, and putting a file on one is exactly what the chooser would have done. When you have asked Eya to send a file in a chat
app you have allowed, she hands the file to the extension in parts of 3 MB, it is rebuilt inside the page and put on the app's file input, and the app
shows its own preview. **Nothing is sent by this** — the app waits for Send, which Eya only clicks after you said yes to that exact file and chat.
It only ever does this for a chat app (never an ordinary website), only with Communication Access on for it, and only a file Eya has already checked
(not a secret, not a program, not a folder).

**What it tells Eya about the browser itself:** when it connects it says which browser and version it is, its
extension version, what it can do, and which windows and tabs are open (address and title only; private windows
are left out). While connected it reports tabs opening, closing, being switched to and navigating, windows gaining
focus, and downloads starting — each marked as done by Eya or by you, so Eya notices when you changed something
between her steps. It reports no page contents, cookies, form values or history.

## What it will never do

- Read cookies, saved passwords, local storage or tokens. It has no permission to (`cookies`,
  `webRequest`, `history`, `debugger`… are all absent). Links and addresses Eya sees have their
  query strings stripped of anything that looks like a credential.
- Type into a password, card number or one-time-code field, or report what is in one.
- Touch a CAPTCHA, "verify you are human" check or verification-code prompt. It notices them,
  stops, and Eya asks you to do that part yourself.
- Navigate away a tab you were using. Eya reuses tabs *she* opened; a tab you already had open on a
  site is only brought to the front.
- Talk to anything but Eya on this PC.

## How the connection is protected

- It only ever dials `ws://127.0.0.1:47821/eya-bridge` (this machine).
- The Eya side accepts only a handshake whose `Origin` is this extension's own, which a web page
  cannot forge, and — after the one-time pairing you start from Eya — only a connection that
  presents the secret it was given then. That secret lives in this extension's own storage;
  Eya keeps only a hash of it, separately for Chrome and for Edge, so one browser's secret is
  useless to the other.
- There is no unauthenticated way to send it a command.
- "Forget pairing" on the options page (or Eya's side) invalidates it.

## Permissions, and why

| Permission | Why |
| --- | --- |
| `tabs` | Which tabs exist, their titles and addresses, switching between them. |
| `scripting` | Looking at a page and clicking / typing in it, on demand, in the tab Eya is working in. |
| `downloads` | Noticing a file a click downloaded and where the browser saved it. |
| `storage` | The pairing secret, and which tab Eya is working in. |
| `alarms` | A 30-second wake-up so the connection recovers after the browser puts the extension to sleep. |
| host access `<all_urls>` | Eya has to be able to work on whatever site you ask about; nothing is injected until she acts. |

There are no content scripts: nothing runs on any page until Eya asks for something.

## Known limits (stated, not hidden)

- Eya's clicks are script-made, which browsers don't count as a real user gesture. Ordinary links and
  buttons work; a page that insists on a real click to open a script popup (`window.open`), a file
  picker, fullscreen or the clipboard will not respond. Real clicks would need the `debugger`
  permission, which this extension deliberately does not ask for.
- Controls inside another site's iframe (a payment widget, an embedded sign-in) can't be seen into.
  Same-site frames and shadow DOM can.
- Browser-internal pages (`edge://…`, the extensions store) can't be read by any extension.
- Eya's clicks do not defeat a site's security: there is nothing here that hides automation, solves a
  CAPTCHA, or copies a session out of your browser — a page that needs *you* waits for you.
- Incognito / InPrivate windows are not visible unless you allow the extension there yourself.

## Files

`manifest.json` · `service-worker.js` (requests → actions) · `bridge.js` (the local connection and handshake) ·
`events.js` (live tab, window and download events) ·
`tabs.js` (tab choice, reuse, downloads, who-did-it tagging) · `actions.js` (act → settle → follow → look again) ·
`injected.js` (the part that runs inside a page) · `options/` (status page).

The extension ID is fixed by the public `key` in `manifest.json` so Eya can insist that a connection
really comes from this extension. The matching private key was discarded, so nobody can publish a
look-alike under the same ID.

**Quick mode (extension 0.5.0, capability `quick_actions`):** after every click and fill the extension used to wait up to 2.2 s to see whether
a download had started, then for the page to go completely quiet (up to 2.5 s). Typing in a box and scrolling can't start a download, so
they no longer wait for one on any site; and when Eya says `quick` (she does, for chat apps only) a click, fill, tab switch or file hand-over
settles after a short calm (80 ms minimum, 150 ms quiet, 500 ms ceiling) because a chat page never goes fully quiet. An Eya that doesn't send
`quick` behaves exactly as before. Opening a site whose tab is already open (focusing it) no longer waits for a download either.

**Quiet reconnecting (extension 0.5.1) — why the "Errors" button on the extensions page used to fill up.** The browser writes a line to the
extension's Errors list every time a connection fails (`WebSocket connection to 'ws://127.0.0.1:47821/eya-bridge' failed:
net::ERR_CONNECTION_REFUSED`), and the extension tried to connect whenever the browser woke it (any tab switch) and every 30 seconds — so while
Eya was not running (closed, restarting, the PC just started) the list grew all day. It now **looks first**: a plain, no-cookies request to
the same loopback address (it can neither read nor send anything), which the browser does not record as an error when nobody answers; only when Eya
answers does it open the connection. Measured in a real Chrome (`tests/live/extensionerrors.live.test.ts`): 5 errors in 25 seconds with Eya off and 4
across two restarts before; **0 in both** after, and 0 while she works. Reconnecting is as quick as before (the look is repeated on the same
1.5 s to 15 s back-off). Reload the extension once to get it, and press **Clear all** on the Errors page to remove the old lines.

**Pairing by itself (extension 0.6.0).** When the extension has no pairing secret of its own (just loaded, reinstalled, or one Eya no longer knows) it reads `eya-pairing.json` from its own folder — a key Eya writes there when she starts — and sends it in its handshake as `bootstrap`; Eya answers with a secret for this browser, which the extension stores. An extension that already has a secret sends that and never reads the file. If the file is not there (an older Eya, a read-only folder) it simply says hello without it and waits for the pairing window, as before — and a missing file adds nothing to the Errors list (measured). The file is not a web-accessible resource, so no page can fetch it.

**Adverts (extension 0.7.0, capability `ads`).** One new request, `ads` (`mode` once / watch / stop), runs a small routine in the page (`injected.js`, command `ads`): it presses the page's own YouTube Skip button when it is visible, closes an overlay advert's close button and a survey's dismiss button, and, with `watch`, repeats every half second until stopped or the page goes. With `keepPlaying` it starts the video again if the page leaves it paused right after an advert, and with `play` it presses the player's own Play button if the browser left the video waiting. It answers with what it saw (an advert showing, whether it has no Skip button, how many it skipped or closed, whether the video is playing). It never hides, speeds up or blocks an advert, and it does not run in a chat app's tab while Communication Access is off (like every other request). An extension older than 0.7.0 answers "Unknown request: ads" and Eya tells you to reload it once.
