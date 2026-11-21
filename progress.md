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
- Installed frozen dependencies offline under the `.nvmrc` toolchain. Three implementation tracks are in progress.
- CI now reads the Node version from `.nvmrc`. Updated README publication, concurrency, and erasure guidance.

## Verification boundaries

Local checks use disposable synthetic data. Cloudflare accounts, backups, and live Shares are separate evidence for deployment and recovery. Test results and unresolved checks are recorded in `tests.json`.
