# Plan 010: The htmlgate CLI stands on its own; R2 stays, explained

Priority P2; effort S; risk LOW (text, comments, a token prefix); category direction; planned at
`58fde07`, 2026-10-09.

## The CLI

The owner asked that the CLI make no reference to, and no use of, the repository it started from,
and live on its own in this repository. Nothing uses it today (no dependency, script, remote or
network call); only text refers to it.

- Keep `packages/cli/LICENSE` exactly as it is. The MIT licence requires its copyright and permission
  notice in every copy or substantial portion, and the CLI still contains ported code. Removing it
  would breach the licence; it is the one place the original author is named.
- Remove every other reference: the "fork of" sentences in `README.md`, `packages/cli/README.md` and
  `packages/cli/package.json`; the "Ported from …" provenance headers and "upstream" comments in
  `packages/cli/src/*.ts`; the "grew from the MIT htmlbin CLI's contract" comment in `src/api.ts`; the
  fork mentions in the landing's FAQ (`site/public/index.html`, `site/public/en/index.html`).
  `AGENTS.md` "Reference code" becomes: the CLI is ours, there is no upstream to follow, and its
  LICENSE notice stays because the licence requires it.
- Tokens become `hg_` plus 40 letters and digits (was `hb_`, htmlbin's prefix), in the Worker
  (`src/ids.ts`, `src/api.ts`), the CLI (`config.ts`, `bin.ts` redaction), `scripts/token.mjs`,
  `smoke.mjs`, `bench.ts`, `mutate.mjs`, the tests, `SKILL.md` and docs. No compatibility: every
  existing token stops working, so the owner creates new ones on staging and production after deploy.
- What "no use" means here: the CLI depends on, syncs with and calls nothing from that repository.
  It remains a licensed derivative: code that began there stays, under its MIT notice. Rewriting it
  from scratch would be the only way to drop the notice, and nothing asks for that.
- A test reads the CLI's sources, README, package.json and built `--help` and fails on any mention of
  htmlbin outside `LICENSE`.
- Unchanged, on purpose: the README's one-line credit that htmlgate was inspired by htmlbin (an
  idea, no code), the test that proves the CLI ignores `.htmlbin` files and `HTMLBIN_*` variables,
  and history (CHANGELOG entries, `docs/research`, `docs/handoffs`) as records of what happened.

## R2

Answer to "is the R2 subscription necessary; can we work without it": it is necessary today, and
htmlgate keeps it.

- Facts (Cloudflare docs, read 2026-10-09): R2 needs a subscription added through the dashboard's
  checkout, with 10 GB-month, 1 M Class A and 10 M Class B operations free each month. Zero Trust's
  Free plan also requires payment details ("you will not be charged"), so dropping R2 would not let an
  Operator start without them. D1 allows 500 MB per database on Workers Free and 10 GB on Paid, with
  rows of at most 2,000,000 bytes and 50 queries per invocation on Free.
- Alternative A, bodies back in D1 (no R2): one product less and faster bodies (one round trip
  instead of two, about 160 ms from Brazil), and no reservation ledger. But storage falls from 10 GB
  free to 500 MB on Workers Free, a 2 MiB page or a 10 MiB zip must be split across rows, sites lose
  ranged reads, and D1 Time Travel keeps "deleted" bodies restorable for up to 30 days.
- Alternative B, R2 optional with D1 as a fallback chosen at setup: both limits and both code paths
  forever, a doubled test and mutation matrix, for one dashboard step.
- Chosen: keep R2. This implementation requires it; D1 only would be possible with a redesign of
  storage. Setup recognises the "R2 not enabled" answer (Cloudflare error 10042) and prints where to
  enable it. README and `docs/operator.md` explain why R2 is required and what it costs: storage is
  capped by the Instance, but every body and site file read is an R2 operation, free up to the monthly
  allowance and billed beyond it; the storage cap does not cap operations.

## Tests

`hg_` everywhere the tests and mutations name a token; a test that `hb_` tokens are refused; the
setup message test in `test/operator.test.ts`; `test/viewer.test.ts` keeps asserting pages never say
"htmlbin".
