# Security audit, 2026-11-25

Baseline: `main` at `e70b6ff` (v0.1.23). Remediation branch: `security/audit-remediation-2`.

This was a source-first audit of the Worker (`src/`), the CLI (`packages/cli/src/`), the landing (`site/`), the operator scripts (`scripts/`), migrations, the formal model, the Homebrew formula and CI. Hunters ran only local harnesses against a local `wrangler dev` with dummy principals; no deployed Instance, Cloudflare account or third-party system was probed. Passing scans and tests do not make the project secure, and this run does not claim complete coverage: see [COVERAGE.md](COVERAGE.md).

## Findings

| ID | Title | Status | Severity | CWE | Fix |
|---|---|---|---|---|---|
| H2-1 | Revoking a token did not stop a write whose body was still uploading | Fixed | Low | CWE-613, CWE-367 | `e76024d`, `3c2519c`, `ddcf5e4` |
| H4-1 | `htmlgate list` kept every page in memory with no total cap | Fixed | Low | CWE-770 | `9e6df7a`, `531d7cd` |
| H1-1 | People routes depend on the zone's URL normalization staying on | Needs validation (Operator) | — | CWE-863 | — |
| H5-1 | The Access application does not pin identity providers | Needs validation (Operator) | — | CWE-287 | — |
| H3-1 | Public site files may be highly compressed, so serving one costs inflate CPU | Needs validation | — | CWE-409 | — |
| H4-2 | A project's `.htmlgate/config` can suggest a login origin | Needs validation (product) | — | CWE-451 | — |

### H2-1 — Revocation now stops writes in flight

- **Where:** `src/api.ts` (token check before the body is read); `src/store.ts` `createShare`, `addVersion`, `updateFields`, `setPublic`, `deleteShare`, and `revokeToken` when a token asks (`DELETE /api/tokens/:id`).
- **Preconditions:** someone holds a valid `hg_` token, and that token is revoked (from `/tokens` or by `pnpm run token revoke-all`) while one of their write requests is still running: for most routes, while its body is still uploading.
- **Impact:** that one write still landed after revocation, so emergency containment could be one write short.
- **Root cause:** the token was checked once, at the start of the request; the database statements that commit the write did not re-check it.
- **Fix:** each token-authorized write requires, in the same statement that decides whether it lands, that its token is still unrevoked (`LIVE_TOKEN`). When nothing changed because the token was revoked, the API answers `401`. A token that revokes another token is re-checked the same way. A revoked token also gets `401` for a missing Share, not `404`, so its answers do not reveal which Shares exist. The extra read happens only on that failure path, so the per-route D1 round-trip ceilings are unchanged.
- **Tests and controls:** `test/revoke-in-flight.test.ts` (each write route, plus Store-level checks that include delete; five tests fail on the baseline). The formal model gains `CONTAINMENT_NO_POST_REVOKE_WRITE`, a code conformance check and a bug replay. `scripts/mutate.mjs` gains nine mutations: one per predicate, the `401` mapping, the token-revoke predicate and the two missing-Share answers. An empty PATCH is refused with `400` before the Share is looked up, so it also answers the same for an existing and a missing Share.
- **Residual:** read routes (`GET`) that started before the revocation still answer; they were authorized when they began and change nothing. The `/tokens` page and Author erase run under a verified Access session per request, not a token, so this predicate does not apply to them.

### H4-1 — The CLI caps a listing's memory

- **Where:** `packages/cli/src/bin.ts` `listShares`.
- **Preconditions:** a user runs `htmlgate list` against a hostile or compromised Instance.
- **Impact:** the CLI process could be driven out of memory, because each answer was capped but the 500 pages it may follow were not.
- **Fix:** rows are reduced to the printed fields as they arrive, and the listing stops with `bad_response` (exit 8) once those rows pass 64 Mi characters. The terminal table pads each column to at most 200 characters, so one long title cannot pad every row to its length.
- **Tests and controls:** a stand-in server in `test/cli-safety.test.ts` sends pages that are each under the per-answer cap. A second test drives the terminal table through a pseudo-terminal. Both fail without their fix (the table case printed about 20 MB for 301 rows) and pass with it. There are two new mutation anchors.

### Needs validation

These depend on deployment facts outside the repository. None of them was probed on a live system.

- **H1-1:** keep the zone's **Rules → Settings → Normalize incoming URLs** on (Cloudflare's default) for the Instance hostname. Cloudflare documents that normalization runs before Access and Workers. The Worker cannot see the raw path, so it cannot enforce this itself. Every people route still requires a verified Access JWT for an allowlisted email.
- **H5-1:** if the Zero Trust organization has more than one identity provider, check that each one verifies email addresses. Pinning the Access application to a chosen provider would be a possible setup option.
- **H3-1:** measure the Worker's CPU time on a staging Instance before deciding on a compression-ratio cap for site uploads.
- **H4-2:** this is a hint only; the CLI never sends a token to an origin from a project config. Changing it is a product decision.

## Hardening notes (not vulnerabilities)

Each of these was reviewed and judged not to cross a trust boundary today. They are listed so that a future change does not quietly turn one into a finding.

- Allowlist email comparison lowercases ASCII only.
- Access JWTs have no upper bound on `iat` beyond `exp`.
- Site files are served without re-checking CRC on every read; they were verified at upload.
- `useToken` sends its `last_used_at` update in the same batch as the lookup, so an unknown token still costs a D1 write batch (one that changes no row).
- `WRITE_LIMIT` is enforced per Cloudflare location, not globally.
- Minimal tombstones of expired Shares stay until the Author erases them; the storage report counts them.
- CI installs pnpm and a Chrome build without hash pinning, and the repository has no CODEOWNERS or dependency-update configuration.

## Scans

See [COVERAGE.md](COVERAGE.md#scans). Scan results before and after are the same: the only secret-like strings are dummy test fixtures and one git-ignored local file that was never committed.
