# Plan 004: Validate and deploy one combined beta.8

Priority P1; effort M; risk HIGH; category delivery; depends on plans 001-003 and 005.
Planned at `8953943`; current host load 885 makes mandatory validation unreliable.

## Frozen acceptance and authorization

The owner authorized the single combined hardening/landing release, working-branch
push, main merge, version tags, staging, production at app.htmlgate.com, landing at
htmlgate.com and www redirect, and obsolete task branch/worktree/scratch cleanup.
Keep GitHub private; do not reset/delete data or unrelated files/processes. Private
config stays in git-ignored `.instance/`, with account/team values never in docs.

Use Node 26, pnpm 12.9.1 and pinned Wrangler. The sole integration worktree is
`.scratch/wt/landing` on `feat/landing-site`, already containing hardening `ae75607`.
Do not make a second beta.8. Version is already `0.1.0-beta.8` in root/CLI packages.

## Execute in order

1. Fix plans 001-003, update relevant docs and changelog; review each actual diff.
2. Commit and push the reviewed candidate to trigger plan 005's isolated macOS
   workflow. Run `pnpm run check`: typecheck and every integration/browser/axe test passes
   in one unchanged run. Partial successes cannot be combined. Then full
   `pnpm run mutate`, no --only, no timeout/kill, no concurrent edits/gates/deploys.
3. Verify unique anchors, every intended failure, restored source, final CLI build,
   `git diff --check`, and `pnpm run bench`: every local page p95 <50 ms. A busy-host
   over-budget run exits 2 and provides no verdict. Never relax these budgets.
4. Run code-review Standards/Spec and fresh distinct-model `mneves-verify`, map
   every finding to fixed/disproved/blocked. Freeze the accepted commit.
5. Confirm the pushed candidate is the exact commit accepted by the workflow and
   independent verifier, fast-forward main once and tag `v0.1.0-beta8` there.
   Both deployments use that version tag and source: production is an environment,
   not a claim that the beta is stable 0.1. Do not create a second beta.8 release.
6. `pnpm run setup --config .instance/staging.json`; create a temporary named token
   with `scripts/token.mjs` using existing host Cloudflare login. Keep token in
   protected process/file state, never arguments/logs. Run `pnpm run smoke <url>`
   and `pnpm run bench --live <url>` with HTMLGATE_TOKEN. Verify/revoke temporary
   token, and account for all own fixtures. Repeat production via
   `.instance/production.json` at app.htmlgate.com. No manual deployment bypass.
7. `pnpm run site:deploy --preview`, verify workers.dev preview noindex/headers;
   then `--live`, verify htmlgate.com, www, /app and /app/ redirects. Use own browser
   session for desktop/mobile, both languages/themes, axe; measure `pnpm run bench
   --site https://htmlgate.com`. Report cloud RTT separately from the local budget.
8. Independent browser/API readback of the deployed source and fixtures, then
   remove only our fixtures/tokens. Only PASS permits a shipped claim.
9. After main contains both branches, remove obsolete release branch/worktree and
   unused task scratch. Preserve untracked handoffs and private config by moving
   needed files inside this repository before removing a worktree. Do not touch
   the unrelated detached worktree outside this repository. Restore root main and
   verify remote refs, tags and clean status.

## Stop conditions

Missing authentication, ambiguous version policy that changes a stable release,
mandatory gate failure, unrelated concurrent writes, or cleanup involving private
data prevents the dependent action. Finish safe independent work, record the exact
evidence and request only the action necessary to remove that blocker. Production
authority is already granted for the named targets; do not ask again.
