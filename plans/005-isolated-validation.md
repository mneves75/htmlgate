# Plan 005: Validate the exact candidate on isolated macOS

What the review changed: Linux alone does not exercise the Darwin O_NOFOLLOW_ANY
mutation. Use one macOS job, sequential gates and no automatic cancellation.

Priority P1; effort S; risk MEDIUM; depends on plans 001-003.
The local host sustained loads above 600; repeated unchanged checks timed out.
Do not raise timeouts, combine partial runs or terminate unrelated workloads.

## Choice and alternatives

Chosen: a repository GitHub Actions workflow on macos-15, with exact Node 26.10.0,
pnpm 12.9.1, the frozen lockfile, Chrome and Python PTY support. Use existing Actions
availability; no billing, spending limit, repository visibility or credentials change.
Alternative 1: wait for the local machine. It avoids CI, but repeated overload has
already prevented an honest full result. Alternative 2: Linux-only CI is cheaper
and often sufficient, but cannot certify the macOS-specific protection here.
Five years later, retain reproducible validation separate from deployment and
never treat runner failure as a caught mutation or a completed release.

## Implementation and acceptance

1. Add a push-triggered workflow only for the integration branch; manual dispatch
   remains available once the workflow reaches main. Pin official actions by full
   commit SHA, contents:read, checkout without persisted credentials, no deploy secrets.
2. Install pnpm within workspace scratch, frozen dependencies and Chrome. Verify
   Node/pnpm versions and Python's pty module; record the source commit and tools.
3. Preflight all mutation anchors without planting anything. Run the full check,
   then full mutate, source restoration check, final CLI build and local benchmark,
   in that order. Each command must exit zero; bench exit 2 is inconclusive.
4. Keep one job with a bounded runner lifetime and cancel-in-progress:false.
   Never interrupt mutate. A runner limit or infrastructure failure blocks acceptance.
5. Upload only explicit synthetic gate logs for seven days, including failures.
   Do not upload private configuration, home directories, tokens or browser state.
6. Review the workflow, push the candidate and inspect the exact-head run. No
   merge, tag or deploy until every required gate and independent acceptance passes.

The hosted job validates source; deployments still run only through the existing
project setup and site deployment commands. No new deployment platform is introduced.
