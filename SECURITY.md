# Security policy

Eya acts on a person's own PC and accounts, so security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Use GitHub's private reporting instead:
**Security tab → "Report a vulnerability"** on this repository (private vulnerability reporting). If that is not available, open an
issue that says only "I have a security report, how can I send it privately?" — with no details — and a maintainer will reply.

Please include what you found, how to reproduce it, and what you think the impact is. You will get an answer within about a week.
This is a volunteer project: there is no bounty, but you will be credited if you want to be.

## What counts

Things we especially want to hear about:

- a way to make Eya **send, publish, buy, delete or install** without the user's own yes (the gates are in code: see `src/main/social/PublishGate.ts`, the browser tools, `src/main/pc/`);
- a way to turn on a **privacy switch** (Communication Access, plugin permissions) without the user's own click;
- a **page or a message** that makes Eya do something the user did not ask (prompt injection through web pages, chats or documents);
- anything that **leaks** a key, a message, a file or a password;
- the **browser extension** or its local bridge (`127.0.0.1`) being reachable or abusable by another program or website;
- running a command the command policy (`src/main/pc/commandPolicy.ts`) should have refused.

## Secrets and this repository

- API keys belong in the git-ignored `.env` or in Eya's Settings (stored with Windows DPAPI). **Never commit a key**; if you ever do, revoke it at the provider first, then remove it.
- Test files use obviously fake keys. If you find a real-looking secret in the repository, please report it privately.
- GitHub secret scanning and push protection should be on for this repository.

## Supported versions

Only the latest commit on `main` is supported.
