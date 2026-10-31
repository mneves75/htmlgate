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
| 5 | PLAN.md, budgets.json, reviewer round 1 | in_progress | |
| 6 | Owner approval of the A/B lane and work items | pending | |
| W1 | API: `touchToken` off the critical path (ctx.waitUntil) | pending approval | d1-roundtrips: every API call has 2 auth waves |
| W2 | Author home and /metrics: the two reads in one wave | pending approval | d1-roundtrips: 2 waves |
| W3 | API list: COUNT and page in one wave | pending approval | d1-roundtrips: list 4 waves |
| W4 | Landing: narrow `run_worker_first` | pending measurement | candidate only; may be rejected |
| G1 | Guardrails (cpu_ms, head_sampling_rate, budget alert) | blocked (owner data) | need max CPU and log volume |
