# Security audit, 2026-11-27

Baseline: `main` at `d3d5880` (v0.1.24). Remediation branch: `security/audit-remediation-3`. Released in 0.1.25.

The method was the same as on 2026-11-25. Planted violations measured the hunters' recall, and oracles ran against real jose, workerd and Chromium. P-15 was confirmed by a fresh refuting verifier and by a second model family (Codex gpt-6.2-sol). P-16 and P-17 came from leads that no fresh verifier was funded for; each was confirmed by a test that failed before its fix and a mutation anchor that was caught, and Codex gpt-6.2-sol reviewed the fixes. Only local harnesses ran against a local `wrangler dev` with dummy principals. The live Cloudflare checks were read-only. See [COVERAGE.md](COVERAGE.md).

| ID | Title | Status | Severity | CWE | Fix |
|---|---|---|---|---|---|
| P-15 | A token-creation request already authorized could commit after revoke-all's token sweep | Fixed | Medium (likelihood low, impact high) | CWE-613, CWE-367 | `cd3ed86`, `b38ab12`, `5b2a48f` |
| P-16 | The Allowlist check folded sign-in emails with Unicode-wide `trim()`/`toLowerCase()` | Fixed | Low (author's estimate, not independently scored) | CWE-178, CWE-289 | `834271a`, `2515131` |
| P-17 | revoke-all's ticket key rotation did not end tickets accepted by an older version left in the deployment | Fixed | Low (author's estimate, not independently scored) | CWE-613 | `dc36650`, `2515131` |

- **P-15:**
  - **What was wrong:** revoke-all ended Access sessions, then revoked tokens. A `POST /tokens` whose sign-in predated revoke-all, if it was still in flight, could insert a new token after the sweep.
  - **Fix:** revoke-all records its time, on D1's clock, before revoking tokens. `Store.createToken` inserts only when no revocation is at or after the JWT `iat`, in the same statement. Otherwise the request gets `403` and the page asks for a fresh sign-in.
  - **Residual:** this relies on Access issuing `iat` at sign-in; a sign-in without one never creates a token. A clock skew between Access and D1 widens or narrows the window by the size of the skew; a skew in the other direction fails closed.
- **P-16:**
  - **What was wrong:** Access may admit a different mailbox whose Unicode fold matches an Allowlisted address, for example one with U+212A KELVIN SIGN or a non-breaking space around it. The Worker then treated that sign-in as the Allowlisted person.
  - **Fix:** the Worker trims only spaces and tabs from the claim. The Worker, config and setup lowercase only `A`–`Z`.
- **P-17:**
  - **What was wrong:** a version left in the active deployment, even at 0%, still serves requests through version overrides with the old `TICKET_KEY`.
  - **Fix:** revoke-all now fails unless one new version serves 100%.
  - **Fix, 2026-11-28:** the active deployment after the new key must also be one a secret change created (`workers/triggered_by: secret`), so an ordinary rollout or rollback of an older, previously inactive version during revoke-all fails the check. It was the Low residual of the second-family review.
  - **Residual (Low):** the annotation is not tied to this upload, so a competing secret change by another account member could pass; and a deployment made after the check's last read is not seen. A version from before revoke-all keeps the old key, so rolling back to one at any later time accepts tickets issued before it again, until they expire within the hour. Avoid deploying during revoke-all, and run it again after such a rollback. Cloudflare also propagates a deployment location by location, so for a short window after revoke-all reports success a location still on the old version accepts an unexpired old ticket.

**Documentation only:**
- D1 restore replay (`9aa2b16`, `2515131`).
- The `mfa: false` lifecycle (`c49238b`).
- The credentials a Workers Logs error record may carry (`df28c8d`).

**Hardening note:** `POST /erase` under a sign-in issued before revoke-all is not fenced by the revocation time. It mints no credential.

# Security audit, 2026-11-25

Baseline: `main` at `e70b6ff` (v0.1.23). Remediation branch: `security/audit-remediation-2`.

This was a source-first audit of the Worker (`src/`), the CLI (`packages/cli/src/`), the landing (`site/`), the operator scripts (`scripts/`), migrations, the formal model, the Homebrew formula and CI. Hunters ran only local harnesses against a local `wrangler dev` with dummy principals; no deployed Instance, Cloudflare account or third-party system was probed. Passing scans and tests do not make the project secure, and this run does not claim complete coverage: see [COVERAGE.md](COVERAGE.md).

## Findings

| ID | Title | Status | Severity | CWE | Fix |
|---|---|---|---|---|---|
| H2-1 | Revoking a token did not stop a write whose body was still uploading | Fixed | Low | CWE-613, CWE-367 | `e76024d`, `3c2519c`, `ddcf5e4`, `dc3ada7`, `cd6a57e`, `36b3be3`, `51738d2`, `16f6c76`, `f9127d9` |
| H4-1 | `htmlgate list` kept every page in memory with no total cap | Fixed | Low | CWE-770 | `9e6df7a`, `531d7cd`, `e836545` |
| H1-1 | People routes depend on the zone's URL normalization staying on | Holds on the live zone (checked 2026-11-26) | — | CWE-863 | — |
| H5-1 | The Access application does not pin identity providers | Holds on the live organization (checked 2026-11-26) | — | CWE-287 | — |
| H3-1 | Public site files may be highly compressed, so serving one costs inflate CPU | Rejected: the cost is bounded by the file size limit | — | CWE-409 | — |
| H4-2 | A project's `.htmlgate/config` can suggest a login origin | Accepted (product decision) | — | CWE-451 | — |

### H2-1 — Revocation now stops writes in flight

- **Where:** `src/api.ts` (token check before the body is read); `src/store.ts` `createShare`, `addVersion`, `updateFields`, `setPublic`, `deleteShare`, and `revokeToken` when a token asks (`DELETE /api/tokens/:id`).
- **Preconditions:** someone holds a valid `hg_` token, and that token is revoked (from `/tokens` or by `pnpm run token revoke-all`) while one of their write requests is still running: for most routes, while its body is still uploading.
- **Impact:** that one write still landed after revocation, so emergency containment could be one write short.
- **Root cause:** the token was checked once, at the start of the request; the database statements that commit the write did not re-check it.
- **Fix:** each token-authorized write requires, in the same statement that decides whether it lands, that its token is still unrevoked (`LIVE_TOKEN`). When nothing changed because the token was revoked, the API answers `401`. A token that revokes another token is re-checked the same way. Every other write answer except success or `401` (a missing Share, a bad body, a full Instance, a storage error, the rate limit or a failing rate-limit check, a malformed path) re-checks the token once the answer is built. It answers `401` if the token is now revoked and `503` if the check itself fails, so a revoked token's status code does not reveal which Shares exist or what else went wrong. When that check fails, a live token's failed write also answers `503` instead of its usual error. A write that committed while its token was live stands; if the token is revoked before the answer and the answer then fails, the client can see `401` or `503` for a change that landed. The response time can still differ: a missing Share takes fewer D1 round trips than an existing one. The extra read happens only on failure paths, so the per-route D1 round-trip ceilings are unchanged.
- **Tests and controls:** `test/revoke-in-flight.test.ts` covers the Share write routes over HTTP. With the token revoked while the body uploads, it covers publish and each body-carrying existing-Share write (PUT, PATCH, visibility), plus a missing Share on PATCH and visibility. With the token revoked right after it authenticates, it covers PUT, PATCH, visibility and DELETE for an existing and a missing Share (including empty PUT/PATCH bodies and a storage error on PUT), plus PUT on an existing Share when the Instance is full. It also covers a failed token re-check (`503` for both), and a rate-limited write, a missing write limit, a failing rate-limit check and a malformed path (`401` for a revoked token). Token revocation by a revoked token is checked at Store level. The formal model gains `CONTAINMENT_NO_POST_REVOKE_WRITE`, a code conformance check and a bug replay. `scripts/mutate.mjs` gains nine mutations: one per write predicate, the token-revoke predicate, the `401` answer, the `503` answer when the check fails, and the live empty-PATCH order. For a live token, an empty PATCH is refused with `400` before the Share is looked up, so it answers the same for an existing and a missing Share (covered by a live-token test and its mutation anchor).
- **Residual:** read routes (`GET`) that started before the revocation still answer; they were authorized when they began and change no Share or token state (authenticating the request may update the token's `last_used_at` timestamp before the route runs). The `/tokens` page and Author erase run under a verified Access session per request, not a token, so this predicate does not apply to them.

### H4-1 — The CLI caps a listing's memory

- **Where:** `packages/cli/src/bin.ts` `listShares`; `packages/cli/src/api.ts` `asShare`.
- **Preconditions:** a user runs `htmlgate list` against a hostile or compromised Instance.
- **Impact:** the CLI process could be driven out of memory, because each answer was capped but the 500 pages it may follow were not.
- **Fix:** rows are reduced to the printed fields as they arrive, and the listing stops with `bad_response` (exit 8) once those rows pass 64 Mi characters. Share `metadata` is validated as a flat map of strings before retention so deeply nested objects are rejected with `bad_response` (exit 8) instead of throwing during serialization. The terminal table pads each column to at most 200 characters, so one long title cannot pad every row to its length.
- **Tests and controls:** a stand-in server in `test/cli-safety.test.ts` sends pages that are each under the per-answer cap, and another sends deeply nested Share metadata; both exit 8 (`bad_response`). A third test drives the terminal table through a pseudo-terminal. All fail without their fix (the table case printed about 20 MB for 301 rows) and pass with it. There are three new mutation anchors.

### Deployment checks and decisions

The first two depend on deployment facts outside the repository. On 2026-11-26 the Operator's live zone and Zero Trust organization were read (read-only); nothing was probed.

- **H1-1:** the zone's **Rules → Settings → Normalize incoming URLs** is on (incoming URLs, Cloudflare normalization). Keep it on for the Instance hostname. Cloudflare documents that normalization runs before Access and Workers. The Worker cannot see the raw path, so it cannot enforce this itself. Every gated people route (`/`, `/tokens`, `/metrics`, `/erase`, `/s/*`) still requires a verified Access JWT for an allowlisted email; Public Shares at `/p/*` and ticketed site files at `/f/*` remain outside Access as designed.
- **H5-1:** the Access application accepts every provider the organization enables. Each one proves the user owns the email address: a one-time PIN sent to the address, Cloudflare sign-in limited to the account's members, and Google. Pin the application to a chosen provider before adding one that does not verify email, such as a generic OIDC or SAML provider.
- **H3-1:** serving a compressed site file costs inflate CPU bounded by both the file's unzipped size (`SITE_LIMITS.fileBytes`, 5 MiB) and the compressed archive's size (`SITE_LIMITS.zipBytes`, 10 MiB), whatever the compression ratio. Measured with the same `DecompressionStream("deflate-raw")` API in Node 26 (not workerd), a 5 MiB file took a median of 3.4 ms of CPU at a 1,026:1 ratio, 3.6 ms at 411:1 and 4.0 ms stored incompressible. A ratio cap would not lower that cost, so none is added.
- **H4-2:** kept as it is. The CLI sends a token only to the origin it was saved for (or to the origin paired with `HTMLGATE_URL` when `HTMLGATE_TOKEN` is set in the environment). When a project's config names an origin for which the user has no saved credential, the CLI stops with "Not signed in to <origin> (from .htmlgate/config)", which names both the origin and where it came from, and signing in there takes the user's own `htmlgate login`.

## Hardening notes (not vulnerabilities)

Each of these was reviewed and judged not to cross a trust boundary today. They are listed so that a future change does not quietly turn one into a finding.

- Allowlist email comparison trims and lowercases with JavaScript `toLowerCase()` without Unicode normalization (NFC/NFKC) or locale-specific case folding. (Superseded by P-16 on 2026-11-27: the fold is now ASCII-only.)
- Access JWTs have no upper bound on `iat` beyond `exp`.
- Site files are served without re-checking CRC on every read; they were verified at upload.
- `useToken` sends its `last_used_at` update in the same batch as the lookup, so an unknown token still costs a D1 write batch (one that changes no row).
- `WRITE_LIMIT` is enforced per Cloudflare location, not globally.
- Minimal tombstones of expired Shares stay until the Author erases them; the storage report counts them.
- CI installs pnpm and a Chrome build without hash pinning, and the repository has no CODEOWNERS or dependency-update configuration.

## Scans

See [COVERAGE.md](COVERAGE.md#scans). Scan results before and after are the same: the only secret-like strings are dummy test fixtures and one git-ignored local file that was never committed.
