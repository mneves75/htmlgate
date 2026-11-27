# htmlgate 0.1.25 security audit progress

Release target: `0.1.25` (baseline `0.1.24`, `main` at `d3d5880`). Branch `security/audit-remediation-3`.

## Done

- [x] Seeded-recall audit swarm over every layer, with oracles against real jose, workerd and Chromium, fresh refuting verifiers, and a Codex gpt-6.2-sol cross-check.
- [x] P-15: token creation is bound to the sign-in time and refused after revoke-all (`migrations/0009_revocations.sql`).
- [x] P-16: ASCII-only email fold in the Worker, config and setup.
- [x] P-17: revoke-all requires one new version serving 100% after `TICKET_KEY` changes; its retries repeat the run's own target (`--config`, and `--local --persist-to` for a local run).
- [x] Setup refuses a configured email with a non-ASCII capital (its 0.1.24 rows would be orphaned).
- [x] A sign-in without `iat` never creates a token, even before any revoke-all.
- [x] Docs: D1 restore replay, the `mfa: false` lifecycle, the Workers Logs credentials, the audit record, and the AGENTS.md security rules.
- [x] Version synced to 0.1.25 and the Homebrew formula rebuilt.
- [x] Local gates: full `pnpm run check`, lint, typecheck, `verify:model`, `mutate --check` and `--only` for the new anchors.

## Release

- [x] Full `pnpm run mutate` on `665282e`: all 283 planted violations caught.
- [x] `mneves-security` deploy gate on `665282e`: WAIVED (SEC-02 until 2026-11-30), independent acceptance PASS.
- [x] Deployed `665282e` to app.htmlgate.com with `pnpm run setup` (Worker version `7e55a509`, migration 0009 applied, rollback `44ceafb2`); live smoke 16/16.
- [ ] Bench: local and `--live` gave no verdict at host load 238 and 124; the CI release-validation bench decides.
- [ ] Push, tag `v0.1.25`, merge to `main`, release-validation CI, landing `--live`, `cli:install`.
- [ ] Follow-up: setup fails under `cf` 0.15.0 (`zero-trust organization get` and `r2 buckets domains managed get` were renamed); this deploy ran with the `.nvmrc` Node and its `cf` 1.0.0-beta.28.
