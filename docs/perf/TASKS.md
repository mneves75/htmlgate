# Performance and cost pass: tasks

Branch `perf/cost-latency-pass` from `97823b7`. Pre-existing state recorded at start: `main` was one commit
ahead of `origin/main` (`97823b7 chore(security): pin Node 26.12.1`), not this task's; left untouched.

| # | Task | Status | Evidence |
|---|---|---|---|
| 0 | Preflight: git state, deploy paths, inventory | done | PLAN.md §Inventory |
| 1 | L2 edge harness (`scripts/perf/edge.mjs`) and A/A baseline from Brazil | done | raw/baseline-aa-*.{json,md} |
| 2 | D1/R2 round-trip counter per route (`scripts/perf/d1-roundtrips.perf.ts`) | done | raw/d1-roundtrips.{json,md} |
| 3 | Fonts audit | done (N/A) | PLAN.md §Fonts: no web font anywhere, CSP has no `font-src` |
| 4 | Cost and analytics raw material | blocked (owner) | OWNER-QUERIES.md: token lacks Analytics/D1/Billing |
| 5 | PLAN.md, budgets.json, reviewer round 1 | done | REVIEW.md round 1 (PLAN NEEDS CHANGES, 9 findings dispositioned) |
| 6 | Live A/B on Versions | blocked (owner) | no `.instance/production.json` on this Mac or omarchy; Wrangler login lacks D1/Access |
| W1 | API: token found and recorded in one batch | done | `eded613`; RESULTS.md |
| W2 | Author home and /metrics: the reads in one wave | done | `7dce9e2`; RESULTS.md |
| W3 | API list and versions in one wave; route guard | done | `974b3e6`; RESULTS.md |
| W4 | Landing: narrow `run_worker_first` | rejected | REVIEW.md finding 5; PLAN.md W4 |
| G1 | Guardrails (cpu_ms, head_sampling_rate, budget alert) | blocked (owner data) | need max CPU and log volume |
| 7 | Full gates (check, mutate, bench), final review, verify, security gate | in_progress | |
| 8 | Release 0.1.17: merge, deploy, tag | deploy blocked on 6 | |
