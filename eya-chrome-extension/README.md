# Eya Browser Bridge

A small Manifest V3 extension that lets the **Eya desktop app on the same PC** see and use
the browser you are already signed in to (Microsoft Edge or Google Chrome) — your real tabs,
your real sessions — instead of a separate window with nothing signed in.

It is plain JavaScript on purpose: there is no build step. The browser loads this folder as-is.

## Install (one time, about 30 seconds)

A browser only lets *you* add an unpacked extension, so this part can't be automated.
Saying **"connect my browser"** to Eya opens the extensions page and this folder for you.

1. Open `edge://extensions` (Edge) or `chrome://extensions` (Chrome).
2. Turn on **Developer mode**, and **leave it on**. With it off, the browser switches an
   unpacked extension off the next time it restarts.
3. Click **Load unpacked** and choose this folder (`eya-chrome-extension`).
4. Say "connect my browser" to Eya once. After that it reconnects by itself whenever both are running.

The toolbar icon shows **ON** when Eya is connected. The extension's options page shows status.

## What it can do

For the page Eya is working in: look at it (headings, links, buttons, fields, readable text, tables),
click something by its visible text, type into a field, press Enter in a search box, go back,
follow a link that opens a new tab, notice a download and report where it landed, open a site
(reusing a tab you already have for it), list your tabs and switch to one. Every action ends with a
fresh look at the page so Eya works from what is really there, not from what she expected.

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
  Eya keeps only a hash of it.
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
- One browser at a time is connected to Eya.
- Incognito / InPrivate windows are not visible unless you allow the extension there yourself.

## Files

`manifest.json` · `service-worker.js` (requests → actions) · `bridge.js` (the local connection) ·
`tabs.js` (tab choice, reuse, downloads) · `actions.js` (act → settle → follow → look again) ·
`injected.js` (the part that runs inside a page) · `options/` (status page).

The extension ID is fixed by the public `key` in `manifest.json` so Eya can insist that a connection
really comes from this extension. The matching private key was discarded, so nobody can publish a
look-alike under the same ID.
