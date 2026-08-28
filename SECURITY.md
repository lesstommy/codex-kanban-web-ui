# Security Policy

## Supported versions

Codex Kanban Web UI is currently an alpha project. Security fixes are applied to the latest commit on `main`.

## Deployment boundary

Harness can browse local directories, read files from a task workspace, and ask Codex to modify that workspace. Treat the Harness process as a privileged local development tool.

- Keep the default `127.0.0.1` bind address.
- Prefer SSH, VPN, or a zero-trust network for remote access.
- Do not expose Harness directly to the public internet.
- Use a unique administrator password, session secret, and service token.
- Only select workspaces whose contents the Harness operator may read and modify.

## Reporting a vulnerability

Do not include credentials, private prompts, local paths, exploit details, or repository contents in a public issue.

Use [GitHub private vulnerability reporting](https://github.com/lesstommy/codex-kanban-web-ui/security/advisories/new) for security reports. The maintainer must enable this feature before the repository is made public.

If the private reporting form is unavailable, open a public issue containing only a request for private contact. Do not include any vulnerability details until a private channel has been established.
