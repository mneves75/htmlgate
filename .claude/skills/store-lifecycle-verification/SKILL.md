---
name: store-lifecycle-verification
description: Formally verifies htmlgate's concurrent Store lifecycle (D1 batches, R2 bodies, trash reservations, expiry, erasure, view counting) and revokeAll containment protocol using exhaustive BFS state-space exploration. Use whenever editing src/store.ts, scripts/token.mjs (revokeAll), or D1/R2 cleanup logic.
---

# Store Lifecycle & Revocation Formal Verification

This skill verifies the concurrency, batch-ordering, and retry invariants of htmlgate's storage engine (`src/store.ts`) and emergency revocation protocol (`scripts/token.mjs`) using a deterministic TypeScript explicit-state BFS model checker (`formal/store-lifecycle.model.ts` + `formal/verify.ts`).

## Why this tool

Node 26 and TypeScript are already pinned in `.nvmrc` and `package.json`, with zero external network downloads needed in local development or CI (`macos-15`). An explicit-state BFS model checker explores every reachable interleaving up to explicit bounds in under one second, checks code-to-model conformance directly against `src/store.ts` and `scripts/token.mjs`, and outputs shortest-path counterexamples in the repo's exact symbol names.

## Coverage record

- **Sync commit:** `e76024d`
- **Covered files and symbols:**
  - `src/store.ts`: `Store.putBody`, `Store.dueNow`, `Store.commit`, `Store.createShare`, `Store.addVersion`, `Store.updateFields`, `Store.setPublic`, `Store.deleteShare`, `Store.revokeToken`, `Store.emptyTrash`, `Store.expire`, `Store.countView`, `Store.eraseShare`, `Store.eraseBodies`, `Store.createToken`, `RESERVED`, `WROTE`, `LIVE_TOKEN`, `NOT_REVOKED_SINCE`, `live`.
  - `scripts/token.mjs`: `revokeAll`, `revokeTokenStatements`.

Check whether covered files changed since the sync commit before trusting a pass:

```sh
git diff --stat 37682bf -- src/store.ts scripts/token.mjs
```

Advance the sync commit above only after confirming that `formal/store-lifecycle.model.ts` and `formal/verify.ts` still accurately reflect every atomic boundary in `src/store.ts` and `scripts/token.mjs`.

## Properties verified (and the harm if broken)

1. **`NO_DANGLING_VERSION_BODY`** — Every row in `versions` has its `body_key` present in R2. *Harm:* a Viewer opens a live Share and gets a 404 (`missing body`).
2. **`NO_ORPHAN_VIEWS_AFTER_PURGE_OR_ERASE`** — Neither `Store.expire()` nor `Store.eraseShare()` nor a concurrent `Store.countView()` leaves a `share_views` row for a purged or erased Share. *Harm:* views leak past erasure/expiry and accumulate rows nothing ever deletes (replays commit `b46fab1`).
3. **`EXPIRE_BATCH_ISOLATION`** — `Store.expire()` deletes `share_views` only for the Shares whose Versions it purges in that batch. *Harm:* swapping `DELETE FROM versions` before `DELETE FROM share_views` causes `due` to drop the next batch's views instead (replays commit `b46fab1`).
4. **`SHARE_VERSION_CONSISTENCY`** — Every `versions` row belongs to a Share whose `latest_version` covers it, and every non-purged Share's `latest_version` exists in `versions`. *Harm:* re-checking `live()` on statement 2 of `addVersion()` leaves an orphan Version after a mid-batch expiry (replays plan 008 / mutation #187).
5. **`UNEXPIRED_STORAGE_CAP`** — Stored Versions plus unexpired reservations never exceed `storageLimit`. *Harm:* concurrent publishes bypass the Instance storage cap.
6. **`NO_LOST_RELEDGERED_TRASH`** — `Store.emptyTrash()` deletes only `trash` rows whose `(body_key, due_at)` still matches what it read before R2 deletion, and `Store.dueNow()` advances `due_at` by 1 ms on a same-millisecond conflict (`excluded.due_at = trash.due_at`). *Harm:* a freshly re-ledgered upload (`dueNow`) loses its `trash` row and leaks an untracked object in R2 (discovered by this model checker on `37e374b` and fixed in `Store.dueNow`).
7. **`CONTAINMENT_NO_POST_REVOKE_CREDENTIAL`** — Once `revokeAll` completes, an attacker starting with a compromised Access session, API token, and ticket holds zero live credentials. *Harm:* revoking tokens before Access sessions lets the stolen session mint a fresh token mid-run (replays commit `17a60d6`, F-03). A `POST /tokens` that passed `person()` before revoke-all and commits after its token step mints a live token unless `Store.createToken` inserts only `WHERE ${NOT_REVOKED_SINCE}` and `revokeTokenStatements` records the revocation time before its `UPDATE tokens` (replays `mint-skips-revocation-marker` and `revoke-all-marker-after-tokens`, audit P-15).
8. **`CONTAINMENT_NO_POST_REVOKE_WRITE`** — No write authenticated by a token commits after every token that could authorize it is revoked. `api.ts` checks the token before reading the body, so each token-authorized Store write (`createShare`, `addVersion`, `updateFields`, `setPublic`, `deleteShare`, and `revokeToken` when a token asks) re-checks `${LIVE_TOKEN}` in its liveness-deciding statement. *Harm:* a write still uploading when `revokeAll` or the Author revokes its token lands anyway.

## Bounds and scope honesty

- **Bounds (`DEFAULT_BOUNDS` in `formal/store-lifecycle.model.ts`):** 2 Shares (`S1`, `S2`), 2 symmetric concurrent writers, `maxClock = 2`, `reservationTtl = 1`, `storageLimit = 2`, `keepVersions = 1`, `cleanupBatch = 1`, `maxUploads = 2`.
- **Assumptions:** D1 `batch()` executes statements atomically in order without interleaving another D1 transaction, while execution-time `CLOCK` may advance between statements inside `addVersion()`. R2 operations (`put`, `delete`, `list`) are non-atomic with D1. `createShare` always receives a fresh unique slug (`newSlug()` in `src/ids.ts`, 62^12 space) and never collides with an existing or previously erased Share's slug.
- **Out of scope:** An upload that outlives its 1-hour reservation while the Worker crashes before `dueNow` (documented known gap in `README.md` and `docs/operator.md`), cryptographic primitives (`AES-GCM`, `RS256`), and multi-account Cloudflare provider misconfiguration.

## How to run

```sh
pnpm run verify:model
```

This runs both:
1. Code-to-model conformance against `src/store.ts` and `scripts/token.mjs`, plus exhaustive BFS verification of all reachable states.
2. `--replay-bugs`, proving all 11 historical and discovered bugs still fail with concrete counterexamples.

## Reading results and handling failures

- On **PASS**, the command prints the reachable state count and transition count for each model and confirms all 11 bug replays were caught.
- On **FAIL**, read the numbered counterexample trace directly; each step names the exact `Store.*` or `revokeAll` action and database/R2 state transition.
- **Real bug vs modeling error:** Open the cited symbol in `src/store.ts` or `scripts/token.mjs` and check whether the step sequence in the counterexample can happen on real D1 + R2. If yes, fix the code — never weaken an invariant to make the check pass. If a deliberate design change altered an atomic step boundary, update the model and conformance check together, verify the negative controls still fail, and advance the sync commit above.
