# Results

Same harness as BASELINE.md (`scripts/perf/roundtrips.ts` for counters; `scripts/perf/edge.mjs` for live timings).

## D1 round trips on the critical path (counter, local, valid locally)

Baseline `97823b7` vs candidate `974b3e6` (W1–W3), same seeded database, 20 ms simulated per call. Budget = the
ceiling in `budgets.json`, enforced by `test/roundtrips.test.ts`.

| route | before | after | budget | status | est. saving from Brazil (waves × 176 ms) |
|---|---|---|---|---|---|
| GET / (Author home) | 2 | 1 | 1 | pass | ≈ 176 ms |
| GET /metrics | 2 | 1 | 1 | pass | ≈ 176 ms |
| GET /tokens | 1 | 1 | 1 | pass | — |
| GET /s/<slug>, /p/<slug> (pages and bodies) | 1 | 1 | 1 | pass | — |
| GET /api/shares (list) | 4 | 2 | 2 | pass | ≈ 350 ms |
| GET /api/shares/<slug> | 3 | 2 | 2 | pass | ≈ 176 ms |
| GET /api/shares/<slug>/versions | 4 | 2 | 2 | pass | ≈ 350 ms |
| POST /api/shares (publish) | 5 | 4 | 4 | pass | ≈ 176 ms |
| PUT /api/shares/<slug> (Version) | 6 | 5 | 5 | pass | ≈ 176 ms |
| PATCH /api/shares/<slug> | 5 | 4 | 4 | pass | ≈ 176 ms |
| POST /api/shares/<slug>/visibility | 5 | 4 | 4 | pass | ≈ 176 ms |

The saving column is an estimate (counter × the route-level estimate in BASELINE.md), not a measurement. The live
measurement of an authenticated route needs a token or the owner's sign-in and a deployed candidate (both pending).

Statements and indexes on every success path are the same as before (`docs/perf/raw/d1-roundtrips.md`, plans
unchanged): rows read and written per request are unchanged, except a versions request for a missing Share, which
now also runs the (indexed) versions read.

## Live edge (L2)

| group | metric | before | after | budget | status |
|---|---|---|---|---|---|
| Landing, cached assets (GIG) | warm TTFB p50 | 43–45 ms | unchanged (no landing change) | ≤ 50 ms | pass |
| Landing, HTML pages (GIG) | warm TTFB p50 | 45–60 ms | unchanged | ≤ 50 ms | **fail on `/`, `/privacidade/`, `/en/`**: floor is a 33 ms RTT plus edge time; no change in this pass reaches it (W4 rejected) |
| Instance `/api/onboard`, `/p/<missing>` | warm TTFB p50 | 43 / 219 ms | pending deploy | ≤ baseline + noise | deferred: deploy blocked (no `.instance/production.json` on this machine) |
| Instance authenticated routes | TTFB | not measurable from here | — | counter ceilings | counter: pass; live: blocked (token or sign-in) |

## Field (L4)

Deferred: no RUM (both CSPs block the beacon) and no CrUX data for this origin.

## Cost

No usage data was readable with this session's token (OWNER-QUERIES.md). No saving is claimed: W1–W3 cut waiting,
not work. Expected effect on the bill: none measurable.
