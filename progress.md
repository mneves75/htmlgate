# htmlgate 0.1.25 security audit progress

Release target: `0.1.25` (baseline `0.1.24`, `main` at `d3d5880`). Branch `security/audit-remediation-3`.

## Done

- [x] Seeded-recall audit swarm over every layer, with oracles against real jose, workerd and Chromium, fresh refuting verifiers, and a Codex gpt-6.2-sol cross-check.
- [x] P-15: token creation is bound to the sign-in time and refused after revoke-all (`migrations/0009_revocations.sql`).
- [x] P-16: ASCII-only email fold in the Worker, config and setup.
- [x] P-17: revoke-all requires one new version serving 100% after `TICKET_KEY` changes, and its retries name `--config`.
- [x] Docs: D1 restore replay, the `mfa: false` lifecycle, the Workers Logs credentials, the audit record, and the AGENTS.md security rules.
- [x] Version synced to 0.1.25 and the Homebrew formula rebuilt.
- [x] Local gates: full `pnpm run check`, lint, typecheck, `verify:model`, `mutate --check` and `--only` for the new anchors.

## Release

- [ ] Full `pnpm run mutate` (CI release-validation on the tagged commit).
- [ ] `mneves-security` deploy gate on the exact commit.
- [ ] Merge to `main`, tag `v0.1.25`, deploy with `pnpm run setup`, smoke, landing, `cli:install`.
