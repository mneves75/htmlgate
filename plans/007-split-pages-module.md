# Plan 007: The Instance's stylesheet and strings live in their own files

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and report; do
> not improvise. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat bd5a7d4..HEAD -- src/pages.ts wrangler.jsonc scripts/mutate.mjs`
> If any in-scope file changed, compare the excerpts below with the live code; a mismatch is a STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (the CSP style hash must keep matching the bytes served)
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `bd5a7d4`, 2026-10-09

## Why this matters

`src/pages.ts` holds three things that change for different reasons: the stylesheet (a 17 KB
template string `CSS`), two string tables (`en`, `ptBR`), and the page templates. A designer
editing CSS works without CSS tooling, and every edit to one concern touches the file the
security mutations anchor into (`DROP_SANDBOX`, the not-found `{ sandbox: true }` call). Splitting
them keeps each change small and keeps the mutation anchors in a file that rarely changes.

## Current state

- `src/pages.ts`: `const CSS = \`...\`` (the whole stylesheet); `styleHash()` hashes `CSS` once per
  isolate with `crypto.subtle.digest("SHA-256", ...)`; `layout()` inlines `<style>${CSS}</style>` and
  emits `style-src 'sha256-...'`. `const en = {...}`, `const ptBR: typeof en = {...}`,
  `const STRINGS: Record<Language, typeof en>`.
- `scripts/mutate.mjs` anchors in `src/pages.ts`: the `DROP_SANDBOX` literal, the not-found
  `` </main>`, { sandbox: true }); `` ending, and two home-board escaping lines.
- `test/viewer.test.ts` "every page's stylesheet is exactly the one its CSP allows" recomputes the
  hash from each response's `<style>` bytes: it is the guard for this plan.
- Wrangler bundles `src/index.ts` with esbuild. Importing a `.css` file as text needs a `rules`
  entry in `wrangler.jsonc` (`{ "type": "Text", "globs": ["**/*.css"] }`); check Wrangler's docs
  for the pinned version (4.143.1) before relying on it.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm run typecheck` | exit 0 |
| Page tests | `pnpm exec vitest run test/viewer.test.ts test/browser.test.ts test/home.test.ts test/language.test.ts` | all pass |
| Anchors | `pnpm run mutate --check` | every anchor unique |
| Bench | `pnpm run bench` | under 50 ms p95 |

## Scope

In scope: create `src/pages.css` and `src/strings.ts`; trim `src/pages.ts`; `wrangler.jsonc`
(Text rule); a type declaration for `*.css` imports; `scripts/mutate.mjs` if an anchor moves.
Out of scope: any visual or copy change; the landing's `site/public/style.css`.

## Steps

1. Move `en`, `ptBR`, `STRINGS` and `TokenError` to `src/strings.ts` unchanged; import them in
   `src/pages.ts`. Verify: typecheck and page tests pass.
2. Move the stylesheet to `src/pages.css` byte for byte (no reformatting), import it as text, keep
   `styleHash()` hashing the imported string. Verify: the CSP-hash test passes; `curl` a page from
   `pnpm run dev` and confirm the `<style>` content equals the file.
3. Run `pnpm run mutate --check`; every anchor must still be found once.

## STOP conditions

- Wrangler cannot import the `.css` file as text at the pinned version: keep the CSS in TypeScript
  (step 1 alone still helps) and report.
- The CSP-hash test fails after step 2.

## Done when

Typecheck exits 0; the page tests pass; the anchors are unique; the served `<style>` equals
`src/pages.css`.
