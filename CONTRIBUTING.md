# Contributing to Handoff

Use Node.js 22 or newer. The `.nvmrc` pins the CI baseline. Run `npm ci`, then `npm run build`. Load `dist/` as an unpacked Chrome extension as described in the README.

Before submitting a change, run:

```bash
npm run typecheck
npm test
npm run test:chatgpt-auth
npm run audit:public
npm run build
```

Keep changes focused. Describe the user-visible behavior, relevant implementation decisions, and checks you ran. Update the documentation when behavior changes. Use synthetic examples and reserved example domains in tests and screenshots.

## Manual browser checks

Use a separate development installation and disposable local fixtures. The scripts under `scripts/` that use Playwriter are opt-in integration checks, not part of `npm test`; some make real model requests and change extension storage.

Set `state.handoffExtensionURL` in your Playwriter session to the installed development extension's side-panel URL. Read the script before running it. Do not use a personal browser profile for automated regression fixtures.

For the REPL helper checks:

1. Start `node scripts/repl-e2e-server.mjs` in a separate terminal.
2. Enable the `HANDOFF_REPL_E2E=1` environment variable and run `npm run build:dev` (use your shell's environment-variable syntax).
3. Load the development extension, set the Playwriter session URL, and run `scripts/repl-e2e.mjs`.
4. Follow `scripts/repl-e2e-resume.mjs` for the reload checks.

The compaction check additionally needs a connected model account. It may incur provider usage charges. It is not executed in CI.

## Publication hygiene

Never commit credentials, browser profiles, real chat exports, HTTP captures, personal research, private training data, or release signing keys. Generated builds and local agent/editor state are ignored. `npm run audit:public` inspects tracked and unignored files, reports locations without printing detected values, and catches common credential/path mistakes. It is a guardrail, not an anonymizer or a complete security review.

Review your Git author name and email before committing: commit metadata is public when you publish the repository. Use your preferred public identity or your hosting provider's privacy address. No author identity or remote URL is prescribed by this project.

## Licensing

Contributions are provided under the repository's MIT license. Preserve third-party license notices and identify any new dependency or copied material in your change description.
