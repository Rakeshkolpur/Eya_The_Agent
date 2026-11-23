# Contributing to Eya

Thank you for wanting to help. Eya is a personal project made public, so the process is simple and the bar is "it works, it is tested, it is safe".

## Be kind

Be respectful and constructive. No harassment, no personal attacks, no spam. Maintainers may remove comments and close issues that break this.

## Before you start

- Windows 10/11, Node.js 20+, npm. `npm install`, then `npm run typecheck` and `npm test` should both pass before you change anything.
- Open an issue first for anything bigger than a small fix, so we can agree on the approach.

## Never put private data in the repository

- **No real API keys, tokens or passwords** — not in code, tests, docs, screenshots or logs. Use obviously fake values (`test-key-not-real`).
- **No real phone numbers, e-mail addresses, names of real people, chat contents or screenshots of chats.** Use made-up ones (`+91 98765 43210`, "Priya").
- No personal paths (`C:\Users\<your name>`). Use `C:\Users\Test`.
- Do not commit `.env`, anything from Eya's data folder, or the extension's `eya-pairing.json`.

## Making a change

1. Fork, branch from `main`.
2. Keep the change small and focused. Match the existing style (TypeScript strict, no `any`, comments that say *why*).
3. **Add tests.** Every behaviour change needs a unit test; a rule that protects the user (a confirmation, a limit, a refusal) needs a test that fails when the rule is removed. Run `npm run typecheck && npm test`.
4. Tests that need a real browser or app are opt-in (`tests/live/`) and must never touch real accounts or the user's own open documents.
5. Open a pull request that says what changed, why, and **how you verified it** — and what you could not verify.

## Safety rules for changes to what Eya does

- Anything that sends, publishes, buys, deletes or installs must ask first and be verifiable afterwards. A model's own "confirm" is never enough.
- Passwords, card numbers and CAPTCHAs stay the user's. Chat apps stay off until the user switches them on.
- Do not add a way around a limit, a permission or a gate "for convenience".

## License

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), the same as the project.
