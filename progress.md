# htmlgate hardening

## Acceptance

1. A Publisher learns that all retained and later Versions are Public before changing visibility. An Author can follow a Public link from the signed-in view. English and pt-BR describe the audience and queued physical erasure accurately. CLI machine output stays compatible.
2. New setup refuses an unrelated storage name collision before remote writes. Interrupted setup resumes only with verified resource identity. Existing Instances keep working when ownership is established.
3. Revocation distinguishes unknown IDs from genuine results. Emergency revocation verifies the Instance and its Access application before writes.
4. Operators can inspect storage and cleanup status without reading Share contents. The guide covers safe teardown, republishing from originals, cron quiescence, and D1/R2 and revocation reconciliation during recovery.
5. CI and local development use one Node pin. CLI package, formula, source archive, changelog, and release tag identify the same version. Published refs and cleanup are checked after merge.
6. New test code follows the `cccc` cognitive complexity threshold. Test pruning preserves every assertion with unique behavioral evidence. A fresh reviewer on a different model checks the outcome against these criteria.

## Progress

- Started from verified `origin/main` at `1b13090` on `hardening/operator-and-sharing`.
- Installed frozen dependencies offline under the `.nvmrc` toolchain.
- CI now reads the Node version from `.nvmrc`. Updated README publication, concurrency, and erasure guidance.
- Setup now verifies bootstrap storage identity. Revocation checks provider targets and reports what was confirmed. Mocked Operator flows and local D1 revocation passed.
- The Operator guide records safe recovery and teardown. The storage report passed against empty and populated local D1.
- The Public link, bilingual erasure wording, and CLI audience checks passed focused tests. Added Gated Site navigation to the local benchmark.
- Chromium passed the focused sharing, erasure and accessibility checks. The interactive CLI warning passed in a pseudo-terminal.
- Independent review identified bucket jurisdiction, provider acknowledgement, bulk count and remote D1 query issues. The code and runbook were corrected. All 260 focused Operator, revocation and version checks passed after the correction.
- Bumped the candidate to `0.1.19` and regenerated the CLI release archive. Full candidate gates precede landing.
- Full integration passed on `8209a59` with 1,390 tests and two tag-dependent skips. The benchmark preflight uses an isolated macOS runner while the local host is busy.
- Candidate `c6b54ae` caught all 250 mutations and passed the 12-page CI benchmark. The Gated Site p95 was 89.9 ms against the runner's 150 ms budget. The local 50 ms benchmark remained inconclusive under heavy load.
- Independent verification found that Wrangler parses a leading SQL comment as flags with the two-token spelling. The documented `--command=...` form returned the correct read-only aggregates on empty and populated synthetic D1.
- A fresh Astra verifier reran all 30 frozen behavior checks after the correction and passed six additional checks. It independently validated the archive and the immutable candidate run.

## Verification boundaries

Local checks use disposable synthetic data. Cloudflare accounts, backups, and live Shares are separate evidence for deployment and recovery. Test results and unresolved checks are recorded in `tests.json`.

## Production release preparation

- Production still serves `0.1.18` on the Instance and landing. Cloudflare reports no pending production migrations. The public `v0.1.19` tag identifies the build that passed tagged CI.
- Cloudflare inventory found no staging Instance or staging D1 or R2 resource. The separate landing preview has workers.dev and preview URLs disabled.
- Both staging setup controls failed against the previous code because setup installed the hourly cron. The `0.1.20` candidate accepts a staging setting and sends an empty schedule on the closed bootstrap, serving deploy and later updates. Existing Instances keep the default hourly cleanup.
- The CLI release archive was rebuilt for `0.1.20`. Independent verification reproduced the archive bytes and exercised the setup command against a synthetic provider.
- The source review caught a staging-only wording mismatch. The API, both erasure messages and the privacy inventory now distinguish an immediate access change from a scheduled physical cleanup.
- The first `0.1.20` revision passed 1,391 integration tests with two pre-tag skips. Three browser commands failed before their flow assertions. See `tests.json` for the revision and run boundaries.
- A focused rerun with installed Chrome passed all 87 cases across six suites, including all 11 browser cases and the three flows that timed out in the full run.
- Live staging, production security acceptance, backup and restore evidence, and the application rollback rehearsal are pending. Release and staging shutdown depend on that live evidence.
