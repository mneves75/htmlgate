# Plan 001: Require actual assertions and verified cleanup

Priority P1; effort M; risk MED; category security/tests; planned at `8953943`.

The security mutator currently catches every Vitest subprocess error and prints
CAUGHT (`scripts/mutate.mjs:118-127`). A workerd startup failure, timeout or signal
can therefore falsely certify a planted security violation. Benchmark requests
accept remote HTTP (`scripts/bench.ts:145`), and fixture cleanup can be skipped or
silently fail (`scripts/bench.ts:148-156`, `scripts/smoke.mjs:104`).

## Scope and conventions

Modify `scripts/mutate.mjs`, add `scripts/mutation-reporter.mjs`, modify
`scripts/bench.ts`, `scripts/smoke.mjs`, the deadline controls in
`test/reviewer-cli-fork.test.ts`, and add focused behavior tests. Update AGENTS,
README, operator docs and CHANGELOG for affected tooling behavior. No dependencies,
timeout increases, weakened budgets, tokens in output or external infrastructure.
Scripts use ESM and Node 26. Parsed data is unknown and narrowed, except actual
HTTP JSON response fixtures. Test setup follows `test/harness-failure.test.ts`.

## Steps

1. Docs first: document CAUGHT/MISSED/BROKEN outcomes, source restoration,
   HTTPS/loopback validation, and verified own-fixture cleanup.
2. Red controls: execute the original mutator with isolated process/fs controls;
   demonstrate that runner timeout/startup/signal is incorrectly caught. Add
   benchmark/smoke controls proving unsafe destination rejection before a request,
   cleanup after failed visibility and failure on unsuccessful DELETE.
3. Use a tiny reporter with pinned public `onTestRunEnd`, TestModule/TestSuite/
   TestCase APIs. Record test names, assertion error names, module/suite/unhandled
   errors and interruption. Read a fresh unique report per invocation. CAUGHT
   requires exit 1 and actual assertion failures, no infrastructure errors;
   MISSED is a completed green run; missing/malformed reports, signals, timeouts,
   setup/compile/hook/runtime failures are BROKEN and fail the gate. Print the
   failed full test names and reasons for independent comparison with the violation.
   Do not infer proof from exit status alone or count a skipped control as coverage.
4. Put each source replacement inside `try/finally`; restore after every outcome.
   Stop on a broken environment and rebuild CLI from restored source in outer
   finally. Never impose an execution timeout on a complete mutation run.
5. Give only the two CLI deadline controls a 45 s child cutoff, before their
   existing 55 s test deadline. Keep assertions requiring completion within 40 s
   and exit 8, so removing the 30 s application deadline produces an assertion
   failure instead of a framework timeout. Leave unrelated subprocess limits alone.
6. Validate benchmark origin before token use; accept HTTPS and exact loopback
   HTTP only, reject credentials and unsafe schemes. Register sample slugs as soon
   as create succeeds. Cover subsequent work with cleanup and verify DELETE status.
   Smoke cleanup failure also fails its result, with no token disclosure.
7. Add planted controls for each new security boundary; verify unique anchors.
8. Vitest 4.1.11 reports test results before global teardown. Require a unique
   completion marker written by our global setup only after both owned resources
   close. Missing teardown completion is BROKEN even when an assertion failed.
   The Vitest run command calls close directly, so its onProcessTimeout hook does
   not prove completion here. Add real late-teardown controls (an interrupted
   disposable child and a thrown cleanup error) and close the cert server when
   Instance startup fails.
   Reject any runner stderr without interpreting its formatting: this also blocks
   errors Vitest logs while closing projects or pools after the test report.

## Verification and stopping

Run focused deterministic tests first (no global Worker required), then `pnpm
typecheck` (exit 0). Check actual Vitest reporter fixture cases, including a real
assertion, timeout, hook error and unhandled error in a disposable test directory.
After a clean full `pnpm run check`, run full `pnpm run mutate` uninterrupted,
verify every intended failure, restored source, CLI rebuild and `git diff --check`.
An infrastructure failure stops release work; it is not permission to weaken a gate.
Do not overlap mutations with edits, tests or deploys.
