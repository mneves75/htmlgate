# Plan 013: Make public release validation portable and fail closed

What the review changed: release metadata must not make a behavioral mutation control skip; deployment ownership must be established independently of a matching database name; historical test data must ship with the tests. Preserve the existing Compiler 7 upgrade and landing videos.

Integrator update: `main` advanced to `526d657` with only the formula pin for public `v0.1.0` at `b1c31d8`. The isolated implementation branch was fast-forwarded to that commit while preserving its uncommitted fixes. The owner subsequently authorized one consolidated `0.1.0` release commit/changelog, replacement of the published refs, and deployment. Both package versions are now `0.1.0`; Plan 015 resolves the formula self-hash conflict with a checksum-verified CLI source archive and one immutable staging/production candidate.

## Status

- Priority: P1; effort: M; risk: medium
- Planned at: `b1c31d8`, 2026-10-17
- Depends on: 012
- State: source corrections implemented and accepted; packaging follows Plan 015 and release evidence records acceptance
- Category: correctness, security, tests and release tooling

The executor reads this plan and the repository instructions, reproduces each defect before its smallest fix, and reports an honest blocker instead of weakening validation. Work on `fix/release-readiness` in the task-owned isolated worktree; preserve all other changes. No provider writes, publication, branch rewrite or unrelated cleanup is part of implementation.

## Original diagnosis and preserved invariants

`src/api.ts` accepts ZIP metadata from query parameters with `const metadata: Record<string, string> = {};`. Assigning the valid key `__proto__` loses its string value. The top-level query dictionary has the same inherited-setter issue for unknown fields. CLI metadata keys are literal strings; existing JSON-page behavior is the positive control.

`scripts/setup.mjs` only refuses an existing same-name Worker inside `if (freshDb && ...)`. A database name cannot establish ownership. Operator setup must refuse unrelated Workers before migrations, secret changes, Access updates or deployments; legitimate existing Instances and unambiguous interrupted bootstraps must remain usable.

The shared setup/landing clean-tree guard must first establish that Git's canonical top-level directory equals the project root. Otherwise an unversioned copy inside an ignored directory of another checkout can appear clean. Real clones, registered worktrees and symlink aliases remain usable. The regression fixture snapshots current tracked candidate changes before its fixture-only commit, so it exercises uncommitted fixes and planted mutations. The added root-guard mutation brings the unchanged 221 controls to 222.

`test/reviewer-share-gate-and-docs.test.ts` reads mutation data through `git show 4c06449:scripts/mutate.mjs`. Public clones do not contain that discarded commit. Preserve its exact 182-entry baseline, order and approved deltas as committed data, rather than replacing it with the current table or a skip.

`test/cli-brew.test.ts` mixes tag-dependent checks with installer mutation controls. A pre-tag run legitimately skips release metadata checks, but an incomplete behavioral control cannot certify a mutation. The reporter currently permits skipped states. Keep strict BROKEN classification for skipped/pending controls and isolate conditional Git checks from the suite used for installer mutations. The complete check and CI must still run all release metadata checks and fail when CI cannot read required tags.

The landing and Instance are different Workers; preserve their existing language, visual design and privacy contracts. Bodies remain private R2 objects. The smoke command must distinguish a real Access host from a URL containing that text and must terminate on an unresponsive endpoint.

## Implementation sequence

1. Restore portability with the exact historical JSON fixture; remove the Git-history dependency and preserve every renamed-base, explicit-delta and extra-control assertion. Prove the test does not require the old object from a fresh archive/clone. Retain the video mutation and its CSP delta.
2. Use null-prototype query dictionaries. Through the real Worker, demonstrate ZIP POST and PUT preserving `__proto__`, `constructor` and ordinary tags in response, retrieval and filtered listing; reject top-level unknown fields. Observe RED before the fix, then GREEN.
3. Separate conditional tag checks and their policy tests into `test/cli-release-tags.test.ts`; keep all installer behavior in its non-skipping mutation suite. First reproduce mixed skipped-plus-failed and all-skipped reports; restore strict reporter behavior and verify actual Vitest reports. Never lower the mutation classifier's assurance to accommodate missing Git state.
4. Preflight existing deployment ownership before remote writes. Validate the same-name Access application's Worker destination and every traffic-serving version's expected DB UUID and BODIES bucket. Add an explicit Instance marker to new closed bootstrap deployments; use it for safe interrupted-bootstrap recognition ONLY when the Access application is absent, and use validated Access association for existing pre-marker Instances. An existing foreign/mismatched Access application must always be refused, even when a marker matches. Reject duplicate application/Worker matches and incomplete listings. Never substitute the newest created version for the version serving traffic. Fail closed on absent, ambiguous or malformed evidence. Avoid a new dependency or source-code fingerprint framework.
5. Reject reuse of a bucket with an enabled managed or custom public domain, or malformed privacy evidence; do not automatically change another bucket's policy. Validate before migrations or deployment.
6. Parse smoke redirect URLs and require an HTTPS Cloudflare Access team hostname. Bound request/body lifetime. Exercise the actual command through the existing transport fixture seam, including real positive controls, spoofed redirects and a hanging response.
7. Add mutation controls for newly protected security/correctness behavior. Preserve the immutable historical baseline and list new controls explicitly. Update operator/release docs made inaccurate; do not rewrite unrelated documentation. The browser-driver exception below is the only dependency change.

## Browser regression gate recovery

The frozen full check failed at `agent-browser open about:blank` with 0.38.1: nine browser test timeouts and eleven suite-blocked cases. Matched Node `execFile` controls timed out with both the old wrapper and native binary, including a reverse-order old-native control after 0.39.1 succeeded. This supports the update without proving the initial stall's exact cause; Chrome stderr saturation remains plausible, not established.

Pin the project development dependency to 0.39.1. It includes [Chrome stderr draining](https://github.com/vercel-labs/agent-browser/pull/2003), [daemon accept/shutdown fixes](https://github.com/vercel-labs/agent-browser/pull/2059) and [prevention of unsafe command replay](https://github.com/vercel-labs/agent-browser/pull/2085). The Node wrapper's missing signal forwarding remains. Do not substitute the global binary or replace the browser harness, increase timeouts or skip assertions. 0.39.0 is insufficient because it retains the known replay defect.

Use the workspace's urgent-fix policy with [pnpm's exact-version exclusion](https://pnpm.io/settings/dependency-resolution#minimumreleaseageexclude), only `agent-browser@0.39.1`. Keep `minimumReleaseAge: 10080` for every other release. This version was published at 2026-10-13T19:56:09.472Z and ordinarily becomes eligible at 2026-10-20T19:56:09.472Z. No global policy change is authorized.

Run all five affected browser files together with their existing global setup and unchanged assertions/timeouts: `browser`, `home`, `language`, `reviewer-landing` and `site`. Then run typecheck, all 222 mutation-anchor checks and the dependency audit. The integrator owns the final full check, uninterrupted mutation gate, benchmark and independent release acceptance. If the focused browser run fails, preserve the exact failure and stop browser investigation without weakening its controls.

The first focused run with the 0.39.1 driver exited 1 (108 passed, 7 failed at `open about:blank`) while the host was shared with several other agents' builds and browsers. On a quieter host the same five files passed 115 of 115, the full check passed, and CI on a clean macOS runner passed every browser suite. Isolated loops of 30 launches found one reproducible driver race: reopening a session name right after `close` fails (19 of 30), because `close` returns before the daemon exits. No test reopens a closed session name, so nothing changed in the browser tests.

The mutation gate then exposed a separate test race: after the token form's 413 cuts an upload, fetch could reuse that closed socket and the next request failed with `EPIPE` (2 of 12 `viewer.test.ts` runs). The cut requests now send `connection: close` (viewer and limits tests), and 20 of 20 runs passed. The CLI source archive now sets each file's mode after writing it, so the process umask no longer changes its bytes; a test builds it under umask 022, 027 and 077.

## Verified provider interfaces

Inspect active deployment IDs with `cf workers deployments list --worker NAME --page 1 --per-page 1`: `deployments[0].versions[]` has `version_id` and `percentage`. Inspect **every** traffic-serving version with the pinned Wrangler `versions view ID --name NAME --json`: `resources.bindings[]` uses D1 `{ name: "DB", type: "d1", id }`, R2 `{ name: "BODIES", type: "r2_bucket", bucket_name }`, and plaintext `{ name, type: "plain_text", text }`. Reject malformed or missing bindings.

R2 privacy reads use `cf r2 buckets domains managed list --bucket-name BUCKET` (`enabled` must be false) and `cf r2 buckets domains custom list --bucket-name BUCKET` (`domains` must be an array; every `enabled` must be false). These shapes were checked against installed provider tooling, without querying real accounts.

## Tests and acceptance

Agreed seams are the Worker HTTP API, real setup/smoke command orchestration with controlled provider/transport adapters, actual Vitest mutation reports, and fresh-clone Git/release behavior. Mock only external provider boundaries, never the ownership decision, field parser or gate classification under test. A helper test alone is insufficient if removing its call from setup would remain green.

- Focused tests for each slice must first fail for the stated behavior, then pass with positive and denied controls.
- `pnpm run typecheck`: exit 0, no diagnostics.
- `pnpm run check`: exit 0; real Worker, CLI, browser and axe checks pass. Conditional tag checks may skip only as the documented pre-tag local policy permits.
- `pnpm run mutate --check`: every unique anchor valid; supplements the full run.
- `pnpm run mutate`: one uninterrupted frozen-candidate run; every planted violation CAUGHT, zero MISSED/BROKEN, source restored. Never combine runs or overlap edits/gates.
- `pnpm run bench`: all required pages under 50 ms at p95; exit 2 is not acceptance.
- Independent adversarial review and fresh acceptance must confirm no weakened controls or unresolved findings. Recheck installed compiler/resource consistency and eventual CI tag enforcement.

## Alternatives and maintenance

The adversarial correction also moves R2 discovery ahead of fresh database creation and validates competing Access destination containers and Worker identities before association checks. First-run refusal must leave no remote writes, including when the R2 subscription is unavailable. Valid unrelated hostname, private, MCP, preview and broader-policy applications remain supported; an exact Worker association takes precedence over broader Worker policies. The focused correction suite passes 96 tests without skips, typecheck passes, and all 213 anchors validate; full mutation and release acceptance are still pending.

The second source review found that R2 discovery read only the first 1,000 buckets. An existing bucket on a later page could be mistaken for an absent bucket, allowing fresh database creation before its privacy checks. The bounded correction now follows ordered pages to an empty terminal page and refuses malformed or non-advancing evidence before writes. RED recorded 21 assertion failures; GREEN passed 117 tests without skips, typecheck passed, and both new mutations were CAUGHT with source restored. All prior 213 tuples and the fixture hash are unchanged; 215 anchors validate. Independent final acceptance remains pending; no actual HTML exposure was established. The [R2 List Buckets API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/list/) provides lexicographic `start_after` discovery, but the installed CLI drops the response's cursor metadata.

The final bounded correction must use `--order name --direction asc` and advance `--start-after` from validated bucket names until an empty page. Do not infer completion from a short nonempty page. Reject malformed, duplicated, nonadvancing or unexhausted evidence before any remote write, with a finite page bound. Command-level regressions must show a later private bucket reused without creation, later public/unknown buckets refused with zero writes even on first setup, and invalid pagination refused. Capture RED before the fix, then GREEN, typecheck and anchor validation; retain all 213 existing anchors and the immutable fixture. Add a meaningful planted control for incomplete bucket discovery and update the explicit additions list.

Chosen for that correction: bounded ordered discovery through the existing helper. Alternatives: an exact bucket GET would require reliable not-found classification that the shared CLI error wrapper does not currently preserve; refusing accounts at the first full page would avoid writes but unnecessarily prevent legitimate reuse. Do not add a provider client or overhaul authentication/error handling for this narrow fix.

The unchanged browser retry passed all 73 tests in the four previously failing files. The local benchmark exited 0 with every page below 50 ms p95 (maximum 46.1 ms). These results do not replace a complete check, a fresh uninterrupted full mutation run, independent acceptance or required release CI on the final candidate. Finish packaging and clear the required gates before publishing the candidate.

Chosen: explicit deployment evidence, literal dictionaries, immutable test data and separate release-state checks. Rejected: trusting a database name, accepting skipped mutation controls, fabricating Git tags, or adopting a broad deployment/validation framework. Five years later, the same trust boundaries and committed fixtures should remain reviewable without a private object store or inferred resource ownership. Changes to provider response shapes must fail closed with a clear Operator error and fixture coverage.

## Release boundary and stop conditions

The full-source security review also found inaccurate deletion timing in the API and privacy notices. The release corrects the English and pt-BR disclosures: expiry denies access immediately; bounded hourly cleanup and retries do not guarantee a physical-deletion deadline. Existing cleanup limits stay unchanged. The Operator runbook now separates Publisher-token, Allowlist, Access-session and ticket-key revocation and requires contained restores to reapply prior revocations and erasures. These documentation changes do not establish a rehearsed restore or add an audit ledger, malware scanner or atomic all-session revocation. Provider and owner controls require their own release evidence.

Owner override, 2026-10-18: after implementation and acceptance, consolidate commits and changelog entries into one final `0.1.0` release with tag `v0.1.0`. A beta staging alias names that same immutable commit; it does not require a different package version. Select the alias after checking current tags. Required validation is not waived when CI capacity or account access is unavailable.

Published `main` and `v0.1.0` already exist. The owner explicitly authorized their replacement after the conflict was surfaced. Prepare and verify the replacement and rollback evidence; publish only with exact leases after the required gates. An unexpected remote change or refused lease stops publication.

The original Homebrew procedure used a formula-only follow-up because a commit cannot contain its own hash. The owner authorized the necessary packaging reconciliation for a literal single commit. Plan 015 specifies the deliberate source archive, Homebrew checksum verification, retained compiler pins, regression controls and recovery boundary. Do not remove integrity protection to satisfy the commit count.

The integrator owns version selection, security gates, beta/staging validation, production promotion, release-format reconciliation, Git delivery and cleanup within current owner authorization. Stop before any protected action whose exact target is not yet approved, unexpected source drift, a required control that cannot be exercised, unknown provider shapes, or inability to retain safe bootstrap/update behavior. Report exact evidence. No security exception or successful command alone proves the deployed outcome.
