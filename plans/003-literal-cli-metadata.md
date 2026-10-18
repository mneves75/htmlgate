# Plan 003: Preserve every valid CLI metadata key

Priority P2; effort S; risk LOW; category correctness; planned at `8953943`.

`packages/cli/src/files.ts:93-98` uses a normal object with indexed assignment.
The valid `__proto__` key invokes an inherited setter and is lost. The API accepts
this key, so CLI publication and upsert do not honor their metadata input contract.

Scope: the parser, a CLI behavior regression, CLI README and CHANGELOG. Match
existing duplicate-key last-value behavior, validation and licence/provenance.
This is data loss, not a demonstrated prototype-pollution vulnerability.

1. Docs first: accepted keys are literal, including names inherited by objects.
2. Red-first CLI control: publish/upsert with `--metadata __proto__=literal` to a
   local stand-in and assert its JSON payload contains the own string property.
   Include normal, constructor/toString and duplicate-key controls.
3. Build the metadata dictionary with no inherited setter (null-prototype map or
   Object.fromEntries). Prefer the smallest change; no new helper abstraction.
4. `pnpm typecheck`, CLI build and focused behavior tests must pass; then the full
   check/mutation gates in plan 004. Do not print real credentials or modify config.
