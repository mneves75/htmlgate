# Plan 008: Every Drop expires, 30 days after its latest publish by default

Priority P1; effort M; risk MED (a new condition on every read; a scheduled job that deletes bodies);
category feature; planned at `58fde07`, 2026-10-09.

## Why

A Drop lives until someone deletes it, and deleted Drops keep their bodies and count toward the
storage cap until an Operator purges them, which 0.1 cannot do. Cloudflare Drop's deployments
disappear unless claimed; the owner wants each htmlgate Drop to carry an expiry date, 30 days by
default, so stale pages stop being reachable and their storage comes back.

## Behavior (docs first: README, GLOSSARY, docs/operator.md, packages/cli/README.md, SKILL.md)

- **Expiry** (GLOSSARY): the time after which a Drop answers as missing everywhere, and after which
  its bodies are deleted for good. Avoid: TTL, retention, lifetime.
- Instance default: `expiryDays` in `instance.json`, an integer 0 to 3650, default 30; 0 means Drops
  never expire unless a Publisher sets a date. Setup passes it as the `EXPIRY_DAYS` var; a malformed
  value makes `readConfig` return null (fail closed, as for every other setting).
- A Drop created without a date expires `expiryDays` after its creation. Each new Version of a Drop
  whose date came from the default moves it to `expiryDays` after that publish, so a Drop someone keeps
  updating (one URL per pull request) stays alive. A Publisher-set date stays until a Publisher changes it.
- A Publisher sets a date on create (`POST`), on a new Version (`PUT`) or alone (`PATCH`) with
  `expires_at`: milliseconds since the epoch, at least one minute and at most 3650 days ahead, or
  `null` for never. Zip publishes carry it in the query string (`expires_at=<ms>` or `never`).
- Every API Drop object gains `expires_at` (ms or null). `/api/onboard` documents the field and the default.
- From `expires_at` on, the Drop behaves exactly like a deleted one on every path: `/d`, `/p`, raw,
  site files, tickets, every `/api/drops` read and write, the Author's home. A refused Drop looks missing.
- An hourly Cron Trigger (`17 * * * *`) deletes the Versions of up to 50 expired Drops per run,
  queues their bodies in `trash` in the same transaction, marks the Drops deleted
  (`deleted_at = COALESCE(deleted_at, expires_at)`), then empties due trash. Expiry also reaches Drops
  that were deleted before they expired, so their storage comes back too. Bodies are gone for good.
- The viewer page shows "Expires <date>" (en and pt-BR) when the Drop has a date.
- CLI: `--expires <30d|12h|2026-12-31|never>` on `publish` and `update` (a bare date is 00:00 UTC);
  at a terminal `publish` prints the date and `list` shows it in a column; JSON output carries
  `expires_at`. Piped text output keeps its columns, because scripts read them.

## Schema (migration 0004, no data migration)

`ALTER TABLE drops ADD COLUMN expires_at INTEGER;` and
`ALTER TABLE drops ADD COLUMN expiry_set INTEGER NOT NULL DEFAULT 0;` plus an index on `expires_at`.
Existing Drops get `NULL` (never) with `expiry_set = 1`, as if a Publisher had chosen never, so neither
the update nor their next publish starts a clock on anything already published.

## Implementation

1. `src/config.ts`: `expiryDays` from `EXPIRY_DAYS` (default 30, 0..3650 integer).
2. `src/store.ts`: one `LIVE` SQL fragment for "not deleted and not expired" at execution time
   (`CLOCK`), used by every Drop read and every single-statement write that today checks
   `deleted_at IS NULL`, and by Version reads, which join their live Drop. In a multi-statement batch
   only the first statement (the Version INSERT) checks `LIVE`; the statements after it are gated on
   that INSERT having happened (`WROTE`), because SQLite fixes the clock per statement, not per
   transaction: an expiry falling between two statements must not leave a Version without its Drop row.
   `createDrop`/`addVersion`/`updateFields` take `expiry: { at: number | null } | undefined` and the
   default; the sliding rule is one `CASE WHEN expiry_set = 0` in SQL so it holds at commit time.
   `expire(now)` is one batch of three statements that bind the same `now` and select the same set: up
   to 50 expired Drops that still have Versions, ordered by `expires_at, slug`. It queues their bodies,
   marks them deleted, and deletes their Versions last, so membership cannot change before the end and
   a finished Drop (no Versions left) is never selected again, which guarantees progress.
   `emptyTrash` deletes up to 50 ledger rows with one statement (`(body_key, due_at) IN (VALUES …)`,
   keeping the "still as read" condition) instead of one statement per row. The cron run purges up to
   3 batches of 50 Drops and deletes up to 10 rounds of 50 bodies: at most 3 × 3 + 2 × 10 = 29 D1
   queries, under Workers Free's 50 per invocation. What is left waits for the next hour; every write
   also empties up to 50 due bodies.
3. `src/api.ts`: parse `expires_at` (JSON and query); return it; onboard docs.
4. `src/index.ts`: `scheduled()` handler calling `expire` (up to 3 batches) then `emptyTrash` (up to 10 rounds).
5. `wrangler.jsonc` and `scripts/setup.mjs`: `triggers.crons`; `EXPIRY_DAYS` var from `instance.json`.
6. `src/pages.ts`: the viewer's expiry line in `en` and `ptBR`.
7. CLI: `--expires` parsing (`files.ts` or a small `expires.ts`), request fields, printed dates.

## Tests (red first)

- Store, no Worker (`node:sqlite` with the real migrations, as `test/store-expiry.test.ts` does):
  default date on create; sliding on a new Version; a set date survives a new Version; never; an
  expired Drop is invisible to every read and refuses `addVersion`/`updateFields`/`setPublic`;
  expiry falling between the statements of a publish leaves no Version without its Drop row;
  `expire` queues exactly the expired Versions' bodies, deletes those Versions, marks the Drops, and
  leaves live ones untouched; 51+ expired Drops with tied dates finish over repeated runs; a
  deleted-then-expired Drop is purged too; a failed bucket delete keeps the ledger rows.
- End to end (`test/expiry.test.ts`): API fields and validation; `/d`, `/p`, raw and API answer 404
  after an expiry set in the past through the local D1; the scheduled handler run through
  `wrangler dev --test-scheduled` empties the bucket for that Drop.
- CLI: `--expires` forms and refusals; printed date.
- `test/language.test.ts`: the pt-BR expiry line.
- Mutations: drop the expiry clause from the viewer read, from the API read, and from `addVersion`;
  make `expire` skip queuing bodies; check `LIVE` again in the second statement of a publish. Each must
  be caught.

## Not in scope

Expiry notices (htmlgate sends no mail), restoring expired Drops, per-Version expiry.
