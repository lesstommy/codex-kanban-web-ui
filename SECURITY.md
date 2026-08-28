# Security Policy

## Supported versions

Tweet-Native AI Harness is currently an alpha project. Security fixes are applied to the latest commit on `main`.

## Deployment boundary

Harness can browse local directories, read files from a task workspace, and ask Codex to modify that workspace. Treat the Harness process as a privileged local development tool.

- Keep the default `127.0.0.1` bind address.
- Prefer SSH, VPN, or a zero-trust network for remote access.
- Do not expose Harness directly to the public internet.
- Use a unique administrator password, session secret, and service token.
- Only select workspaces whose contents the Harness operator may read and modify.

## Reporting a vulnerability

Do not include credentials, private prompts, local paths, or repository contents in a public issue. Use GitHub private vulnerability reporting when it is available for this repository. Otherwise, contact the maintainer through their GitHub profile before sharing sensitive details.
