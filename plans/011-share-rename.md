# 011: "Drop" becomes "Share"

Status: done (owner's decisions, 2026-10-10). Release: 0.1.0-beta.13.

## Why

Cloudflare ships a product named Drop, and htmlgate runs on Cloudflare and names its products
throughout its docs. Before 0.1 there are no real users and the repository is private, so the
term, the API path and the link shape can change once, with no compatibility layer.

## Decisions

| Surface | Before | After |
|---|---|---|
| Term (English) | Drop, Gated Drop, Public Drop | Share, Gated Share, Public Share |
| Term (pt-BR pages) | Drop (loanword) | Share (loanword): "Seus Shares", "Share público" |
| API | `/api/drops…` | `/api/shares…` |
| JSON fields | `slug`, `metadata`, `public`, `expires_at` | unchanged |
| Gated page | `/d/<slug>`, `/d/<slug>/raw` | `/s/<slug>`, `/s/<slug>/raw` |
| Public page, site files | `/p/…`, `/f/<ticket>/…` | unchanged |
| Database | table `drops`, indexes `drops_by_author`, `drops_by_expiry` | `shares`, `shares_by_author`, `shares_by_expiry`, by migration 0005 |
| Code and CLI identifiers | `Drop…` | `Share…` |
| Erase form | field `drop`; notes `bad-drop`, `no-drop` | `share`; `bad-share`, `no-share` |
| R2 keys | `bodies/<slug>/<id>` | unchanged |

- No aliases, redirects or dual names: `/api/drops` and `/d/<slug>` answer like any unknown path.
- Migration 0005 only renames; it keeps every row. Migrations 0001 to 0004 stay as written, and
  tests that seed data before 0004 keep inserting into `drops`. This is the owner's exception to
  "no data migrations": the alternative was resetting his own Shares.
- History stays as written: released CHANGELOG sections, plans 001 to 010, docs/research and
  docs/handoffs keep "Drop".
- English verbs stay: "drop the file", "the Operator dropped that table", SQL `DROP`. The verb
  "share" stays allowed in prose.
- GLOSSARY: **Share**, with "Drop (its name before 0.1)" under Avoid.

## Rejected

- Keep the table name and `/d/`: no window and old links survive, but the SQL and every gated
  link would carry the old word for good.
- Rename only what people read: the public API would contradict the glossary on the day the
  repository opens.
- Keep "Drop": generic, but confusing beside "Cloudflare Drop".

## Cutover

`pnpm run setup` applies migrations, updates Access, then deploys: for about a minute the running
Worker queries a table that was renamed. Staging first, as the rehearsal. Production outside
minutes 15 to 20 (the hourly cleanup runs at :17). Recovery from a failed setup is to run setup
again: the migration is recorded once and the deploy completes.

## Acceptance

1. No "Drop" as our term in what ships: `src/`, `packages/cli/src`, `site/public`, `scripts/`,
   README, GLOSSARY (outside Avoid), `docs/operator.md`, `docs/privacy.md`, DESIGN.md, the skill.
   A test guards it.
2. `/api/shares…` serves what `/api/drops…` served; `/api/drops` and `/d/<slug>` are not found,
   even signed in.
3. A database at migration 0004 with Drops, Versions, an expiry and a deleted row holds the same
   rows after 0005, and a fresh database works.
4. The CLI talks to the new API; pt-BR pages say Share.
5. `pnpm run check`, `pnpm run mutate` (every anchor, one uninterrupted run) and `pnpm run bench`
   pass on one commit.
