# Reviewer findings and dispositions

## Round 1: PLAN.md before execution

Reviewer: GPT-6.1 Sol through `codex-auto exec -m gpt-6.1-sol -c model_reasoning_effort=high -s read-only`, from a
fresh worktree of `3c94a41` (tracked files only). Verdict: **PLAN NEEDS CHANGES**. Each finding was treated as a
hypothesis and checked.

| # | Sev | Finding | Status | Evidence and action |
|---|---|---|---|---|
| 1 | P1 | W1 as planned (`touchToken` in `ctx.waitUntil`) lets `GET /api/tokens` show a stale `last_used_at` and turns a failed update into a success | confirmed, fixed by redesign | W1 became one `db.batch([SELECT, conditional UPDATE])`: synchronous, one transaction, so the timestamp is written before the answer and a failure still fails the request. `test/store-tokens.test.ts` pins first use, the once-a-minute bound and revoked/unknown tokens; `test/api.test.ts` still asserts `last_used_at` right after a request. Commit `eded613`. |
| 2 | P1 | W3's existing versions join has no author filter, so dropping `mustShare` would expose a foreign Share's Versions | confirmed (for the shortcut), avoided | `mustShare` (author-filtered) now runs alongside the read with `Promise.all`; any rejection is still the 404. `test/api-versions-owner.test.ts` covers foreign, deleted, expired and missing Shares with an owned positive control. Planted control (mustShare removed) fails it. Commit `974b3e6`. |
| 3 | P1 | The counter counted connected intervals, so an independent call spanning a dependent chain hid it; any status under 500 passed | confirmed, fixed | `waves()` is now the longest dependency chain (DP over "started after the other ended"); the reviewer's example `[0,20]→[20,40]→[40,60]` + `[0,55]` is 3 in `test/roundtrips.test.ts`. Every route asserts its exact status. Background calls that finish before the answer are still counted as critical: that can only make a ceiling stricter, never hide a wave; documented in `scripts/perf/roundtrips.ts`. |
| 4 | P1 | `edge.mjs` could not pin arms to Versions, so an "A/B" of two identical bases is A/A; baseline provenance unattested | confirmed, fixed in the tool; provenance open | `--base 'url|worker=version-id'` sends `Cloudflare-Workers-Version-Overrides` on every request; identical or half-pinned arms are refused (`test/perf-edge.test.ts`). The deployed version id stays unrecorded until a login with Workers read on the Instance can run `wrangler deployments list` (owner, OWNER-QUERIES.md). |
| 5 | P2 | W4 (`run_worker_first` narrowed) changes www redirects for assets and 404 page counts | confirmed | **W4 rejected.** Today `www.htmlgate.com/style.css` 301s and an unknown path counts as `404`; neither survives asset-first routing without new machinery. Expected gain is small: cached landing assets already answer ~11 ms above the 33 ms RTT floor (BASELINE.md, GIG). |
| 6 | P2 | The fake D1 returned no rows from a SELECT inside a batch | confirmed, fixed | `test/fake-env.ts` returns `results` for row-returning statements, as D1 does. Exercised by `useToken` and `listShares`, both batches with SELECTs. |
| 7 | P2 | One batch does not make COUNT and page agree across an expiry instant: each statement reads its own clock | confirmed, claim corrected | The guarantee in PLAN.md was overstated and is withdrawn. Before W3 the two statements ran a round trip (~176 ms) apart; now they run in one transaction microseconds apart, so the window shrinks but is not zero. A single windowed statement would lose the total on a page past the end (`test/store-list.test.ts` asserts that case keeps its total). |
| 8 | P2 | "170 ms" was arithmetic on floor-index medians and an uncontrolled route comparison | confirmed, corrected | Interpolated medians: ≈176 ms all colos, ≈180 ms GIG only (`scripts/perf/summarize.mjs`). Labelled a route-level estimate everywhere; per-wave savings are written as counter × estimate. Landing A/A noise restated per colo (GIG warm p50 differs 0.1–6.9 ms between arms). |
| 9 | P2 | Max observed CPU × 2 is not a bound for valid worst-case work (2 MiB pages, ZIPs, full cleanup) | confirmed | `limits.cpu_ms` stays out (the owner's 2026-10-12 decision stands) until worst-case workloads are measured. |

The reviewer also noted: no monetary saving is established (W1–W3 keep the same database work: the same statements
and indexes on every success path; a versions request for a missing Share now also runs the versions read, a few
rows), and W2 has no authorization or data-loss regression. Both agree with RESULTS.md.

## Round 2: final diff

Same reviewer and setup, fresh worktree of `b9a707e`, brief in the same form. Verdict: **DIFF NEEDS CHANGES**.
It checked every round-1 disposition against the code (all implemented) and found three failure-path gaps.

| # | Sev | Finding | Status | Evidence and action |
|---|---|---|---|---|
| 1 | P2 | Versions: if the versions read fails before the Share check answers, `Promise.all` turns a 404 for a foreign or missing Share into a 500 | confirmed, fixed | The read starts first but its outcome is held; `mustShare` decides, then a read failure counts. Still one wave. Test: injected read failure with a 20 ms slower Share lookup → foreign Share 404, own Share 500 (`test/api-versions-owner.test.ts`). Control: `Promise.all` restored → the test fails with 500. |
| 2 | P2 | `useToken`: a database that refuses the UPDATE fails the whole batch, so an unknown or revoked token became a 500 instead of 401 | confirmed, fixed | On batch failure the same bound lookup runs alone: no token → null (401), a live token → the original error (500), as before W1. One statement literal, so the mutation anchor stays unique. Test: read-only fake (`test/store-tokens.test.ts`). Control: fallback removed → the test fails with `read-only`. |
| 3 | P2 | The route guard skipped routes with no ceiling (Viewer home, raw bodies, not-found) | confirmed, fixed | Every measured route must have a numeric ceiling; four ceilings added at their baseline values (a tightening of coverage, no budget relaxed); the Viewer home must make zero D1 calls, critical or background. Control: the home's view-count read without its Author check → the guard fails. |

Also corrected from this round: PLAN.md called the route comparison a "measured cost" (now "estimated"), PLAN.md
still carried the rejected `cpu_ms` = max × 2 proposal (removed), BASELINE.md described warm requests as
interleaved one by one (they run in alternating blocks of five), and `docs/perf/raw/d1-roundtrips.md` now holds
candidate counts: the baseline counts, from the same instrument run against `97823b7`, are in
`docs/perf/raw/baseline/`. Served-version provenance stays open until a Wrangler login can read the Instance's
deployments.
