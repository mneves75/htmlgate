# Contributing to htmlgate

Thanks for your interest. htmlgate is a self-deployed tool: each Operator runs their own Instance in their own Cloudflare account, so contributions land in the shared code (the Worker, the CLI, the landing, setup and the tests) rather than in any one deployment.

## Before you start

- Read [GLOSSARY.md](GLOSSARY.md) for the vocabulary. The words are fixed; do not introduce "Drop", "owner", "whitelist" and so on.
- Read [AGENTS.md](AGENTS.md) for the build, test and security rules the code relies on.
- Node 26 and pnpm (see `packageManager` in `package.json`).

## Develop

```sh
pnpm install
pnpm run typecheck
pnpm run test
```

The full gate is `pnpm run check` (typecheck then tests). Changes to the gate, headers, tokens or limits also need `pnpm run mutate`; changes to a page, route or store read also need `pnpm run bench`.

## Pull requests

- Keep changes focused. One concern per PR.
- Run `pnpm run check` before opening a PR and make sure it passes.
- Do not commit `instance.json`, `.instance/`, `.scratch/`, `docs/handoffs/` or `packages/cli/dist/` (see `.gitignore`).
- Never include real tokens, sign-in cookies, email addresses, Cloudflare account ids or Zero Trust team domains.
- Describe what changed and why; link the issue it closes.

## Reporting bugs

Use the bug report template. Include the version or commit you tested, steps to reproduce, and what you expected.

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities privately through GitHub's vulnerability reporting, not as a public issue.
