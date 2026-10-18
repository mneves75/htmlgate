# Plan 002: Preserve omitted fields at SQL execution time

Priority P1; effort M; risk MED; category correctness; planned at `8953943`.

`replace` and `patch` in `src/api.ts:219-245` fill omitted values from `mustDrop`.
`Store.addVersion` and `updateFields` in `src/store.ts:175-210` then overwrite all
fields. Two requests can read the same old row; a description-only PATCH or a PUT
delayed by R2 can later undo a concurrent title/tag change.

## Scope

Modify `src/api.ts`, `src/store.ts`, their callers, regression tests and affected
API documentation. Do not change API response shapes, title/description/tag
validation, explicit null description, empty metadata clearing, author isolation,
version numbering, visibility, quota, leases or transaction boundaries.

## Implementation

1. Docs first: omitted fields are preserved at commit; supplied fields win in
   commit order. Explicit null/empty metadata still clears them.
2. Red-first controlled interleavings using actual SQLite migrations plus the
   deterministic D1/R2 adapter in `test/store-expiry.test.ts`: two disjoint PATCHes;
   PATCH while PUT's R2 body write is paused; explicit clears; supplied field wins.
   Exercise the API's presence mapping, not only the Store in isolation.
3. Carry optional fields unchanged from API to Store. Preserve omission via SQL
   expressions or conditional assignments evaluated against the current row.
   Description must distinguish undefined from null. Keep the same single update
   or transaction; never interpolate user strings into SQL.
4. Update all Store callers/tests in the same change; no compatibility overload.
   Extract a shared deterministic SQLite fixture only if two test files use it.
5. Add a planted regression for omission protection if the mutation table covers
   this behavior; do not change lease-security anchors accidentally.

## Verification

New controls fail on original source and pass after correction. `pnpm typecheck`
must exit 0. Full `pnpm run check`, complete mutate and `pnpm run bench` are required
before release; local page p95 must remain <50 ms. Stop on a changed schema contract
or a missing distinction between omitted and explicitly cleared values. Prefer
small presence-aware SQL over optimistic conflict responses or serialization locks.
