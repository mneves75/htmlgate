# beta.10: sites from a zip, expiry, an htmlgate CLI of our own

What the review changed: a sandboxed Drop never sends the Access cookie (measured in Chromium), so a
Gated site's files are served under sealed one-hour tickets instead of the gated paths; a publish's
later statements are gated on its first, so expiry between them cannot split it; expiry cleanup selects
only Drops that still have Versions and fits Workers Free's 50 queries; the zip reader checks CRC-32,
accepts data descriptors and UTF-8 names without the flag, and is tested on zips from three other
tools; one path pipeline serves what the zip rules accepted; R2 stays, with its cost stated honestly.

Planned at `58fde07`, 2026-10-09, on `feat/zip-expiry`, after beta9 (`feat/security-audit` and
`feat/redesign`). The owner authorized implementation, review, verification, docs, version, commit,
push, merge to main, a beta tag with a staging deploy, then a tag and production deploy.

| Order | Plan | Status | Dependency |
|---|---|---|---|
| 8 | [Every Drop expires, 30 days after its latest publish by default](008-drop-expiry.md) | Implemented; focused end-to-end and Worker-free mutations pass; full gate pending | beta9 on main |
| 9 | [A Drop can be a site, published as a zip](009-site-drops.md) | Implemented; a Gated site passes in a real browser; full gate pending | 8 (shares migration 0004) |
| 10 | [The htmlgate CLI stands on its own; R2 stays, explained](010-own-cli-and-r2.md) | Implemented; full gate pending | none |

## Decision and alternatives

Chosen: one zip object per Version in R2 with its file index in D1; Gated site files under sealed,
short-lived tickets re-checked against the Allowlist and the Drop on every request; Public site files
under `/p/<slug>/<n>/`; expiry as a column checked on every read plus an hourly cleanup; R2 kept as the
only body store.

Alternative 1, conservative: sites only when Public. No new kind of URL, but a Gated site cannot load
its own files, so "every Drop starts gated" would no longer hold for sites.

Alternative 2, challenging the premise: turn a zip into one self-contained HTML document at publish.
The security model stays untouched, but `fetch()` of data files, module graphs, fonts referenced from
CSS and anything computed at runtime break; the inliner becomes a bundler nobody wanted to maintain.

Rejected as well: a separate content origin with its own Access login (every Drop would share that
origin, so one Drop's scripts could read another's files); `SameSite=None` on the Access cookie (sent
for images and scripts but never for `fetch()`, and it undoes the security audit's change); tickets
stored in D1 (easier revocation, but a write per page view and a cleanup job); R2 optional with D1 as a
fallback (two storage paths and a doubled test matrix for one dashboard step).

Five-year perspective: keep the opaque-origin sandbox, one immutable object per Version, the
reservation ledger, fail-closed settings and one body store. The regret to avoid is a custom zip
parser and a second permission mechanism without written contracts: both have them here (plan 009),
with tests on other tools' zips and a mutation for every refusal that guards safety.

## Second plan (Sol) and where it differs

Sol (gpt-6.1-sol) planned independently. It agrees on immutable Versions, request-time expiry, an hourly
bounded cleanup, keeping the MIT notice, and refusing traversal and symlinks. It differs on: R2 optional
with D1 by default (rejected, above); gated assets on `/d/` paths with the Access cookie (fails: the
cookie is never sent from a sandboxed Drop); expiry that never moves on republish (we move a default
date forward so a pull request's preview keeps its URL; a set date stays); 4 MiB and 24 files (too
small for a built site; we follow Cloudflare's own 1,000 files and 5 MiB per file); multipart upload (a
raw zip body is simpler); a zip library (we need each entry's offset for ranged reads). Taken from Sol:
no credentialed `Access-Control-Allow-Origin: null`, explicit tests for modules, fonts, `fetch()` and
nested frames, a harness that cannot hide an asset-authentication failure, and measuring zip CPU before
claiming Workers Free.

## Research and advisor evidence

- Chromium, 2026-10-09, local server: from a `sandbox` CSP document (top-level and in an iframe),
  same-host subresource requests are `Sec-Fetch-Site: cross-site`; a `SameSite=Lax` cookie is never
  sent; a `SameSite=None` cookie is sent for style, image and script but not for `fetch()`.
- [Temporary accounts](https://developers.cloudflare.com/workers/platform/claim-deployments/) (Cloudflare
  Drop's mechanism): static assets up to 1,000 files and 5 MiB each; R2 and Access are not offered.
- [R2 get started](https://developers.cloudflare.com/r2/get-started/): a subscription added through
  checkout. [R2 pricing](https://developers.cloudflare.com/r2/pricing/): 10 GB-month, 1 M Class A and 10 M
  Class B operations free per month. [Zero Trust setup](https://developers.cloudflare.com/cloudflare-one/setup/):
  the Free plan still asks for payment details.
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/): 500 MB per database on Free, 10 GB
  on Paid, rows up to 2,000,000 bytes, 50 queries per invocation on Free.
  [Workers limits](https://developers.cloudflare.com/workers/platform/limits/): 10 ms CPU and 5 Cron
  Triggers on Free. [Web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/):
  `DecompressionStream` supports `deflate-raw`.
- [PKWARE APPNOTE](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT): data descriptors and
  ZIP64; [Referrer Policy](https://www.w3.org/TR/referrer-policy/): a document can override the policy.
- Independent read-only `gpt-6-astra` review: keep the sandbox, one object per Version, the ledger and
  one store; fix the split-publish race, cleanup progress and query budget, the ticket contract, the
  zip reader's integrity checks and the path pipeline. All applied above.

# beta.8 review and delivery

What the review changed: preserve omitted fields at SQL execution time, distinguish
assertion failures from broken mutation runs, validate benchmark destinations,
track and verify fixture cleanup, preserve literal CLI metadata keys, reject
incomplete navigation measurements, and validate on an isolated macOS runner.

Planned at `8953943322f5f37f63b33e3bde13db99b4178364`, 2026-10-08.
The owner authorized implementation, branch push, one combined release merge/tag,
staging and production deployment, and cleanup of obsolete release branches/worktrees.
Keep unrelated changes, existing data and the private repository.

| Order | Plan | Status | Dependency |
|---|---|---|---|
| 1 | [Reliable mutations and deployment tools](001-reliable-release-tools.md) | Implemented; focused controls pass | none |
| 2 | [Preserve concurrent metadata changes](002-preserve-concurrent-fields.md) | Implemented; focused controls pass | none |
| 3 | [Preserve CLI metadata keys](003-literal-cli-metadata.md) | Implemented; focused controls pass | none |
| 4 | [Isolated macOS validation](005-isolated-validation.md) | In progress | 1, 2, 3 |
| 5 | [Validate and deploy the combined release](004-combined-release.md) | Pending full acceptance | 1, 2, 3, 4 |

These are selected confirmed defects, not a new product roadmap. The accepted
long-upload storage boundary and local 50 ms budget remain unchanged.

## Decision and alternatives

Chosen: small fixes in the existing Worker, scripts and tests. Preserve presence
into SQL rather than writing an old snapshot; use the pinned public Vitest reporter
API, explicit fixture ownership and validated destinations. This repairs actual
failure paths without changing response shapes or adding dependencies.

Alternative 1: optimistic revision checks and a maintained mutation framework.
They can work, but introduce a client conflict protocol and more integration cost
than these defects require. The strongest rejected alternative is a full mutation
framework: it offers reporting, but its timeout-as-detection policy still needs
judgment when this host is overloaded.

Alternative 2, challenging the release premise: retain beta.7 until a separate
clean runner validates the candidate. Sustained local loads above 600 now justify
this alternative for acceptance: add a bounded repository workflow on the existing
GitHub Actions service. Its macOS runner exercises the Darwin filesystem control
that Linux alone cannot cover. Do not alter billing, visibility or deployment secrets.

Five-year perspective: retain the small SQL operations, public pinned APIs,
behavior controls and explicit cleanup ownership. Do not preserve the catch-all
success heuristic, parse terminal formatting, retry away failures or build a new
storage state machine for an already accepted boundary.

## Research and advisor evidence

- [Vitest reporter API](https://vitest.dev/advanced/reporters): use structured test
  results; the installed 4.1.11 types/source were checked because online docs now
  include version 5 features. JSON alone omits the unhandled-error surface in 4.1.11.
- [Stryker mutant states](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/):
  distinguishes runtime/compile failures from killed mutants. It counts timeouts
  as detected; our stricter rejection of timeouts is a project judgment because
  environmental timeouts are already reproduced here.
- [Martin Fowler on nondeterministic tests](https://martinfowler.com/articles/nonDeterminism.html):
  isolation, asynchronous waits and resource leaks affect trustworthy regression
  feedback. We retain all required integration gates rather than quarantine them.
- Independent read-only `gpt-6-astra` review confirmed the four defects above,
  endorsed presence-aware SQL and a small fail-closed reporter, and rejected
  unchanged retries as release evidence on an overloaded machine. A second pass
  chose isolated macOS validation over waiting indefinitely or certifying Linux alone.
- [GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
  lists macOS runners for private repositories; existing quota and availability
  remain execution prerequisites, not assumed results.

## Considered and rejected

- Raising test timeouts or combining partial full checks: hides an unresolved gate.
- Long-upload lease state-machine redesign: outside the accepted release scope.
- Generic refactors, dependency upgrades and repo visibility change: no confirmed
  benefit sufficient for this release. The bounded CI gate addresses a reproduced blocker.
- Editing every docs file irrespective of relevance: update affected docs; CLAUDE
  already delegates to AGENTS and needs no duplicate policy.

## Redesign review (improve, branch scope, deep), 2026-10-09

Planned at `bd5a7d4` on `feat/redesign`. Scope: the redesign's diff against `c0a8587`
(`src/pages.ts`, `src/index.ts`, `src/store.ts` `recentDrops`, `src/config.ts`, `scripts/setup.mjs`,
`site/public`, their tests). Fixed in the same branch, not planned: the pt-BR string table typed by the
English one; one escaping convention for string functions; no empty navigation landmark on a Viewer's
header; axe on the empty home; wider pt-BR test coverage; pt-BR terms in GLOSSARY.md.

| Order | Plan | Status | Dependency |
|---|---|---|---|
| 6 | [Drops board: Public only, and pages past 50](006-board-filter-and-pages.md) | Waiting for the owner | none |
| 7 | [Stylesheet and strings in their own files](007-split-pages-module.md) | TODO | none |
| 11 | ["Drop" becomes "Share"](011-share-rename.md) | Done | none |
| 12 | [Install and update the CLI with Homebrew](012-homebrew-cli.md) | Implemented; Homebrew execution deferred | 11 |
| 13 | [Portable, fail-closed public release validation](013-release-readiness.md) | Partial; R2 discovery correction and acceptance pending | 12 |
| 14 | [Restore the landing's social preview image](014-social-preview.md) | Diagnosed; implementation pending | 13 for combined release |
| 15 | [Package and verify a single-commit 0.1 release](015-single-commit-release.md) | Adversarial design reviewed; implementation pending | 13, 14 for final release |

Considered and rejected: caching the Instance stylesheet as a separate file (every Instance response
is `no-store` by rule, and Cloudflare compresses the inline CSS anyway); a template engine with
automatic escaping (an abstraction nobody asked for in security-pinned code; tests and mutations
cover escaping); per-visitor language from `Accept-Language` (the owner chose a per-Instance setting);
a committed screenshot script (agent-browser tests already render every page; revisit if visual
reviews become routine).

## 0.1.1: page counts on the landing

| Order | Plan | Status | Dependency |
|---|---|---|---|
| 16 | [Page counts on the landing, with no cookie banner](016-landing-page-counts.md) | Implemented | 0.1.0 |
