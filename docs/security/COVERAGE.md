# Audit coverage, 2026-11-25

Profile: standard. Baseline `e70b6ff`. This was one pass, the first recorded under this method. Earlier audits (v0.1.18 through v0.1.23) were treated as leads, not as coverage. "Covered" means a hunter traced the surface in source and, where the result depended on it, ran a local harness. It does not mean the surface is free of defects.

## Surfaces

| Surface | Trust boundary | Attack classes examined | Result |
|---|---|---|---|
| Access identity (`src/access.ts`, `src/index.ts` routing) | Internet → people routes | JWT signature/iss/aud/exp, email normalization, path matching, dot segments, method confusion | Covered; H1-1 holds on the live zone |
| Tickets (`src/ticket.ts`, `/f/<ticket>`) | Gated viewer → site files | Forgery, cross-Share reuse, expiry, CSRF on issuance | Covered; nothing confirmed |
| Bearer tokens and API (`src/api.ts`) | CLI/token holder → Store | Revocation timing (writes and token revocation in flight), existence oracles, rate limiting, JSON shape, size caps, ownership checks | Covered; H2-1 fixed |
| Store lifecycle (`src/store.ts`, migrations) | API → D1/R2 | Batch atomicity, liveness, expiry, trash CAS, quota, erase scope | Covered; formal model re-run |
| ZIP parsing and site serving (`src/zip.ts`) | Author upload → anonymous viewer | Parser differentials, path traversal, symlinks, compression ratio, MIME | Covered; H3-1 rejected (bounded by the file size limit) |
| Response headers and sandbox (`src/http.ts`, `src/pages.ts`) | Share HTML → Instance origin | CSP sandbox, COOP/CORP, framing, caching, escaping | Covered by existing mutation gate; spot-checked |
| CLI (`packages/cli/src`) | Instance answer → user machine | Redirect token leaks, config trust, symlink/FIFO reads, terminal escapes, resource exhaustion | Covered; H4-1 fixed, H4-2 accepted |
| Operator scripts (`scripts/setup.mjs`, `scripts/token.mjs`) | Operator → Cloudflare account | Account/storage ownership, Access app config, revoke-all order | Source, plus a read-only check of the live organization; H5-1 holds |
| Landing (`site/`) | Internet → htmlgate.com | Open redirects, headers | Covered; nothing confirmed |
| Supply chain (`pnpm-lock.yaml`, `Formula/`, `.github/workflows/`) | Dependencies/CI → release | Lockfile, formula checksum pinning, workflow permissions | Covered; hardening notes only |

## Not covered

- Cloudflare zone, Access and Zero Trust settings beyond the two read-only checks recorded in AUDIT_REPORT.md (H1-1 URL normalization on the live zone and H5-1 identity providers on the live organization); other deployment settings are not audited here.
- workerd and Cloudflare edge behavior beyond what `wrangler dev` reproduces locally.
- Cryptographic primitives (`jose`, Web Crypto AES-GCM).
- Third-party dependency source beyond `pnpm audit` advisories.
- Denial-of-service against deployed infrastructure (out of scope by policy).

## Scans

| Tool | Baseline (`e70b6ff`) | After |
|---|---|---|
| gitleaks, working tree | 6 hits: 5 dummy test fixtures, 1 in a git-ignored local Instance file that was never committed | Same 6, at `d78cacd` |
| gitleaks, history | 5 hits, all dummy test fixtures | Same 5 dummy fixtures, at `d78cacd` |
| trufflehog (verified only) | 0 | 0, history through `d78cacd` |
| `pnpm audit` | No known vulnerabilities | No known vulnerabilities, at `d78cacd` (no dependency changed) |
| actionlint | 0 issues | 0 issues (no workflow changed) |
| trivy | Not run: its first run needs a vulnerability database download | Not run |

## Gates on the remediation branch

Each fix was written test first: its new tests failed on the code before the fix and pass after it.

| Check | Result |
|---|---|
| `pnpm run lint` | 0 violations |
| `pnpm run verify:model` | StoreLifecycle 791,308 states and RevokeAllContainment 16 states, 0 invariant violations; all 9 historical bug replays fail on their invariant as expected |
| `pnpm typecheck` | Pass |
| `node scripts/mutate.mjs --check` | 274 unique anchors |
| Mutations added by this work, each run with `--only` | Every planted violation caught by an assertion: 9 for revocation (one per write predicate, the token-revoke predicate, the `401` answer, the `503` answer when the check fails, and the live empty-PATCH order), 3 for the CLI (listing cap, table column padding cap, and flat string Share metadata validation) |
| Independent review (Codex gpt-6.2-sol, high) | Round 1 found three issues, all fixed. Round 2 found none |
| Independent review (`reviewer` agent) | One Low issue (the empty PATCH), fixed with a test |
| Full `pnpm run check`, full `pnpm run mutate`, `pnpm run bench` | Recorded in the pull request for the final commit |
