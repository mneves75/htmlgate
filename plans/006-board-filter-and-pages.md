# Plan 006: The Author's Drops board can show Public Drops only and page past 50

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and report; do
> not improvise. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat bd5a7d4..HEAD -- src/pages.ts src/index.ts src/store.ts test/home.test.ts`
> If any in-scope file changed, compare the excerpts below with the live code; a mismatch is a STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (a new query parameter on a gated page; the Viewer's home must still read nothing)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `bd5a7d4`, 2026-10-09
- **Owner decision needed first**: yes. Build it only after the owner says the board needs it.

## Why this matters

The Author's home lists the 50 most recently updated Drops and says how many exist and how many are
public. The question an Author most often has after a token leak is "which Drops are public?"
(README, "What a token can do"). Today the answer past 50 Drops is the CLI (`htmlgate list
--public`). A "Public only" link and pages of 50 answer it on the page, with no script.

## Current state

- `src/store.ts` `recentDrops(author, limit)`: one SELECT with the rows and two counts as
  subqueries, bound to `?1` = author, `deleted_at IS NULL`, `ORDER BY d.updated_at DESC, d.slug LIMIT ?2`.
- `src/index.ts` handlePeople: `if (path === "/" && req.method === "GET") return html(200, homePage(visitor, isAuthor ? await store.recentDrops(cfg.author, HOME_DROPS) : null));`
  The ternary is the only guard that keeps Drops off a Viewer's home; `scripts/mutate.mjs` plants its removal.
- `src/pages.ts` `homePage(v, list)`: renders the board; past 50 it prints `t.truncated(...)` and names `htmlgate list`.
- Routes are matched exactly, and the API's list parses `?page=` and `?public=` (`src/api.ts` `list`). Reuse its validation style: a value the page does not know means not-found, as everywhere else in `handlePeople`.
- Every page string exists in `en` and `ptBR` in `src/pages.ts`; `ptBR` is typed `typeof en`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm run typecheck` | exit 0 |
| Focused tests | `pnpm exec vitest run test/home.test.ts test/language.test.ts` | all pass |
| Mutation anchors | `pnpm run mutate --check` | every anchor unique |
| Mutations for this area | `pnpm run mutate --only home` | every one CAUGHT |
| Bench | `pnpm run bench` | every page under 50 ms p95 (exit 2 on a busy host is no verdict) |

## Scope

In scope: `src/store.ts` (`recentDrops` gains `publicOnly` and `offset`), `src/index.ts` (the `/` route
reads `?public=1` and `?page=N`), `src/pages.ts` (filter links and previous/next links, both languages),
`test/home.test.ts`, `test/language.test.ts`, `scripts/mutate.mjs`, `DESIGN.md` if the board's
anatomy changes, `CHANGELOG.md`.

Out of scope: any action that changes a Drop from the page (make public, gate, delete). That needs
forms, the CSRF rule in `sameOrigin`, and a threat-model change; it is a separate owner decision.

## Steps

1. Tests first in `test/home.test.ts`: `/?public=1` lists only Public Drops with the same counts line;
   `/?page=2` lists rows 51 to 100; an unknown parameter value (`?page=0`, `?page=x`, `?public=yes`)
   answers the not-found page; a Viewer's `/?public=1` lists nothing. Run them; they fail.
2. Extend `recentDrops` with `publicOnly: boolean` and `offset: number`, keeping one statement and
   the existing counts. Verify: focused tests pass.
3. Route: parse the two parameters exactly (`/^[1-9][0-9]{0,4}$/` for page, `1` for public), keep the
   `isAuthor ? ... : null` guard unchanged. Verify: `pnpm run mutate --check`.
4. Page: a "Public only" / "All Drops" link pair above the board, and "Newer" / "Older" links under
   it, in both string tables. Verify: typecheck; axe in the browser tests stays at zero.
5. Add a mutation: the `/` route ignores `?public=1` (plant it; the new test must go red).

## STOP conditions

- Any change would let a Viewer's request reach `recentDrops`.
- The bench shows the home over 50 ms p95 on a quiet host.
- The owner has not asked for this feature.

## Done when

`pnpm run typecheck` exits 0; the focused tests pass; `pnpm run mutate --only home` reports every
mutation CAUGHT; CHANGELOG has an entry.
