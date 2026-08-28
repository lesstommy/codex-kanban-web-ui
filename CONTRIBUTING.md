# Contributing

## Development setup

1. Install a supported Node.js version, MongoDB, and Codex CLI.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and adjust local paths or credentials.
4. Run `npm start`.

## Verification

Before opening a pull request, run:

```bash
npm run lint
npm run build
npm run test
```

The integration suite uses a real local `codex app-server`; the Codex E2E path does not use a test double. Tests that start Codex therefore require a working Codex installation, a signed-in account, network access, and may consume account usage.

GitHub-hosted CI runs `npm run test:ci`, which skips only the real Codex E2E case. Run `npm test` locally before a release or use the manual `Codex E2E` workflow on a trusted, signed-in macOS self-hosted runner.

## Pull requests

- Keep changes scoped to one behavior or workflow.
- Preserve the `Thread -> Posts -> Runs` model and the independent Kanban `boardStage` unless the change explicitly revises the architecture.
- Add focused tests for behavior changes.
- Do not commit `.env`, `.local`, MongoDB data, session logs, task workspaces, generated task artifacts, or credentials.
