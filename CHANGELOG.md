# Changelog

All notable changes to Codex Kanban Web UI are documented in this file.

## [0.1.0-alpha] - 2026-08-28

First public alpha release.

### Added

- Thread-based task cards with Ready, WIP, Review, and Done Kanban stages.
- Backlog and Archive libraries with task editing, deletion, and board visibility controls.
- Real Codex app-server thread and turn execution with resumable replies and thread naming.
- Per-run status, heartbeat, elapsed time, long-running state, and completion duration.
- Automatic Ready-to-WIP scheduling with configurable interval and concurrency.
- Preset workspaces with project-specific role initialization instructions.
- CSV and CLI task intake, stable public task IDs, and idempotent external task keys.
- MongoDB-backed settings, accounts, service tokens, task state, and run history.
- Local file links and inline image rendering inside Codex result replies.
- Local administrator login, CLI bearer authentication, CORS allowlisting, and bounded local file responses.
- Portable Codex CLI discovery, environment diagnostics, foreground and background start scripts.
- GitHub CI for deterministic checks and a manual self-hosted real Codex E2E workflow.

### Known limitations

- The bundled setup and process scripts currently target macOS and Homebrew.
- Codex app-server compatibility is version-sensitive and should be verified after Codex upgrades.
- Cancellation is not yet wired to Codex `turn/interrupt`.
- Public deployment requires additional network controls; the recommended deployment remains localhost behind SSH, VPN, or a zero-trust network.
