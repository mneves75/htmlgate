# htmlgate 0.1.23 Security Audit & Hardening Progress

Release target: `0.1.23` (from baseline `0.1.22`, commit `070c9fa`).

## Completed Phases

- [x] Sync `origin/main` and complete full-repository reconnaissance across Worker, landing site, standalone CLI, D1 migrations, operator scripts, formal models, Homebrew formula, and CI workflows.
- [x] Multi-agent security audit swarm (8 specialized tracks covering auth/HTTP, D1/R2 store lifecycle, ZIP parser/DoS, client sandbox/CSP, standalone CLI, Cloudflare ops/setup, supply-chain/CI, and architecture/performance) with coverage validation and bounded local validation.
- [x] 2026+ frontend review and modernization (`color-mix(in oklab, ...)`, `@view-transition`, progressive `::details-content` FAQ animation, accessible `<pre role="region">`, updated EN/pt-BR privacy notices using `tíquete`, strict zero-JS / system-font / WCAG 2.2 AA compliance).
- [x] Implemented all confirmed security fixes and bug fixes:
  - `migrations/0008_trash_nonce.sql` + `Store.emptyTrash()` `(body_key, due_at, nonce)` CAS + `Store.dueNow()` conflict advance/nonce refresh.
  - `VERSION_FLOOR` (20 KiB) enforced on `trash` rows across quota, cleanup, and `scripts/storage-status.sql`.
  - Bounded `Store.expire()` metadata scrubbing (`title`, `description`, `tags`, `expires_at`) with legacy versionless tombstone guard.
  - Author-scoped `Store.versions()` / `Store.version()` and atomic single-query CTE `Store.recentShares()` with PK-indexed view counts.
  - Hardened `src/zip.ts` (skipped macOS entries verified, directory payload caps, host-agnostic POSIX `S_IFMT` symlink/special-file rejection, polyglot prepend/split-disk/LFH-CD/bit-3 data descriptor/extra-header checks, Unicode control/formatting path filtering).
  - Hardened HTTP/API/Access (`COOP`, `CORP`, `Permissions-Policy`, `X-Frame-Options: DENY` on non-raw HTML/JSON, null-prototype `TYPES`, 24h live-Share ticket navigation redirect guard, early `/p` & `/robots.txt` 404, 8 KiB JWT cap, `TEAM_URL` validation, linear `checkJsonShape` bounding depth & `,`/`:`/bracket delimiters, `[\p{Cc}\p{Cf}]` title/description filtering, IPv4-mapped IPv6 unwrapping).
  - Hardened standalone CLI (`O_NOFOLLOW` + parent symlink refusal on `.htmlgate/config`, strict same-origin normalized Share URLs, terminal/JSON control/Bidi sanitization, 500-page ceiling, fixed multi-page `-n` offset pagination, 64 KiB chunked reads, TTY raw-mode cleanup).
  - Hardened operator scripts & gates (`scripts/setup.mjs` `.instance` symlink guard, atomic `0600` config write, fail-closed `verifyAccessApp()`, `DEPLOYED` clean-tree paths, bounded DNS pagination; `scripts/cli-install.mjs` stdin tar without TOCTOU + `refs/tags/` diff; `scripts/site-deploy.mjs`, `scripts/token.mjs`, `scripts/bench.ts`, `scripts/perf/edge.mjs`, `scripts/lint.mjs`, `scripts/mutate.mjs` expanded to 262 anchors).
  - Upgraded `formal/store-lifecycle.model.ts` (2 concurrent `emptyTrash` workers, 791,308 reachable states, 8 historical bug replays) and AST-based `formal/verify.ts`.
- [x] Pruned redundant historical/mocked tests (preserving all 262 mutation anchors) and parallelized CLI timeout checks.
- [x] Completed two-axis code review (Standards + Spec) and cross-model adversarial interrogation (Codex), fixing all 15 concrete findings surfaced across the three reviews.
- [x] Updated release documentation (`CHANGELOG.md`, `AGENTS.md`, `DESIGN.md`, `README.md`, `docs/privacy.md`, `docs/operator.md`, `skills/htmlgate/SKILL.md`, `wrangler.jsonc`), synced version `0.1.23`, rebuilt Homebrew archive/formula (`0.1.23_1`), and passed `pnpm audit --audit-level high`.

## Remaining Release Gates

- [x] Full `pnpm run check` (71/71 test files, 1,340 passed, 2 pre-tag skips, 0 failed; `lint` 0 violations; `verify:model` 791,308 states & 8/8 bug replays; `typecheck` pass) on `0.1.23`.
- [x] Local page benchmark (`pnpm run bench`): all 10 Instance pages and both landing locales under 50 ms p95 (max 41.6 ms gated site viewer, 15.8–16.2 ms landing).
- [x] Resolved all findings from Codex independent verification (exact ZIP `localFlags === flags`, `verifyAccessApp` trimmed string `aud` + re-read, `test/store-expiry.test.ts` live `barrierHit` assertion, `normalizeShareUrl` rejecting scheme-relative `https:sample`, full tombstone field disclosure in privacy notices, and strengthened `test/cli.test.ts` + `test/zip.test.ts` closing the 2 defense-in-depth mutation misses).
- [ ] Run final cross-model `mneves-verify`, full uninterrupted 262-mutation gate (`pnpm run mutate`), and `mneves-security` production deploy gate on the final candidate commit.
- [ ] Merge to `main`, create & push annotated tag `v0.1.23`, pass required `release-validation.yml` CI on `main`.
- [ ] Deploy production Instance (`app.htmlgate.com`), then deploy production landing (`htmlgate.com`), run live `smoke` + `bench --live` + `bench --site` + header/Access checks + `pnpm run cli:install`.
- [ ] Verify zero active staging resources (0 crons, 0 ingress, 0 writes), clean up branch/scratch, run `devtrim purge`.
