# Security

## Report a vulnerability

Use GitHub's private vulnerability reporting on this repository: Security, then "Report a vulnerability". Please do not open a public issue for a vulnerability.

Say what you found, how to reproduce it and which version or commit you tested. Never include a real token, a sign-in cookie or anyone's Share.

## What is in scope

- The Instance Worker (`src/`), the CLI (`packages/cli`), the landing (`site/`) and the setup scripts (`scripts/`).
- The rules this project relies on are in [AGENTS.md](AGENTS.md) under "Security rules the code relies on".

Each Operator runs their own Instance in their own Cloudflare account. A problem with one Instance's configuration belongs to its Operator; a problem in what setup configures belongs here.

## Supported versions

Only the latest release is supported.
