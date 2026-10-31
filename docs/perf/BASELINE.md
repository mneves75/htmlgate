# Baseline (2026-10-31, before any change)

Source: `97823b7` (production versions as served on that date; the deployed version id was not readable with
this session's token). Harness: `scripts/perf/edge.mjs` (curl 8.7.1, HTTP/2), `scripts/perf/d1-roundtrips.perf.ts`
(vitest 4.1.12, Node 26.12.1). Vantage point: macOS 27.2 on a residential connection in Brazil; Cloudflare answered
from GIG (most), MAO, BEL and BSB, recorded per request. TCP connect RTT to the edge: p50 32.7 ms, p95 57.3 ms; TLS
p50 44.4 ms. Raw data: `docs/perf/raw/`.

## L2 edge, landing (htmlgate.com), A/A

Each URL twice (arm 0 and arm 1): new-connection requests interleaved one by one, warm ones in alternating blocks of
five on one connection; 30 new-connection and 30 warm-connection samples
per arm, 250 ms apart, 1,056 requests. Every warm response was `cf-cache-status: HIT`.

| path | new conn p50 / p95 (arm 0, arm 1) ms | warm p50 / p95 (arm 0, arm 1) ms |
|---|---|---|
| / | 161 / 313, 166 / 256 | 62 / 90, 64 / 87 |
| /en/ | 154 / 278, 152 / 202 | 51 / 73, 58 / 74 |
| /privacidade/ | 137 / 358, 148 / 575 | 61 / 129, 60 / 91 |
| /en/privacy/ | 153 / 524, 164 / 411 | 47 / 75, 46 / 75 |
| /perf-harness-not-found (404 page) | 139 / 240, 142 / 189 | 68 / 86, 44 / 60 |
| /style.css | 132 / 215, 128 / 206 | 47 / 75, 51 / 80 |
| /media/htmlgate-15s.jpg | 136 / 228, 134 / 216 | 45 / 61, 45 / 61 |
| /favicon.svg | 127 / 210, 127 / 208 | 46 / 145, 43 / 63 |

A/A noise: warm p50 differs between identical arms by 0.4–6.8 ms on seven URLs and 23.7 ms on one (the 404 page);
new-connection p50 by up to 11.6 ms. p95 at n = 30 moves by up to 200 ms between identical arms and is not used as
a pass/fail signal. Warm p50 by colo: GIG 47.5 ms (n 430), MAO 76.1 ms (n 50). Warm HTML p50 54.5 ms vs assets
45.3 ms (all through the Worker, since `run_worker_first: true`).

Physical floor for a cache hit: one RTT to the edge (≈ 33 ms p50 from here) plus edge time. A cached landing asset
lands about 13–15 ms above it.

## L2 edge, Instance (app.htmlgate.com), A/A

Only routes that need neither a sign-in nor a token, 600 ms apart, 396 requests. All `no-store` (no cache status).

| path | what it does | new conn p50 (arm 0, 1) ms | warm p50 / p95 (arm 0, 1) ms |
|---|---|---|---|
| /api/onboard | Worker only, no D1 | 135, 134 | 41 / 56, 48 / 74 |
| /p/zzzzzzzzzzzz | Worker + one D1 read (missing Share) | 538, 540 | 232 / 489, 213 / 388 |
| /f/zzzz | Worker only (malformed ticket, no D1) | 166, 163 | 43 / 75, 41 / 63 |

**Estimated cost of one D1 round trip from Brazil: ≈ 176 ms at warm p50** (219.2 − 42.9 ms, interpolated medians,
both arms pooled; ≈ 180 ms on GIG alone, `node scripts/perf/summarize.mjs <run> --colo GIG`). It is a route-level
estimate: two routes measured in the same session, one with a single D1 read and one with none, not an isolated
D1 intervention. The D1 route's spread is wide (warm p25–p75 171–406 ms against 37–61 ms on the Worker-only routes).
Corrected after reviewer finding 8; the first draft said 170 ms from floor-index medians.

## Round trips per route (counter)

From `docs/perf/raw/d1-roundtrips.md` (20 ms simulated per call; waves = sequential D1 calls on the critical path):

| route | D1 waves | est. D1 time from Brazil (× 176 ms) |
|---|---|---|
| GET / (Author home) | 2 | ≈ 350 ms |
| GET /metrics | 2 | ≈ 350 ms |
| GET /tokens, /s/<slug>, /p/<slug>, raw bodies | 1 (+1 R2 for bodies) | ≈ 176 ms |
| GET /api/shares/<slug> | 3 | ≈ 530 ms |
| GET /api/shares (list), …/versions | 4 | ≈ 700 ms |
| POST /api/shares (publish) | 5 (+1 R2) | ≈ 880 ms |
| PUT /api/shares/<slug> (Version) | 6 (+1 R2) | ≈ 1,060 ms |
| PATCH, visibility | 5 | ≈ 880 ms |

The "est." column multiplies a counter by a live median: an estimate, not a measurement.

## L3 lab, L4 field

- L3: the repository's own `pnpm run bench` (headless Chrome, p95 page load, 50 ms local budget) is the lab
  harness for page loads; not rerun in this baseline (the host was carrying the L2 run).
- L4: no field data. Web Analytics (RUM) would need its beacon, which both CSPs block; CrUX was not queried (a
  low-traffic origin rarely qualifies). Field budgets are **deferred**.

## Fonts

None: system font stacks only; no font request on any page. Workstream D does not apply.
