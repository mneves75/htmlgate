# 012: Install and update the CLI with Homebrew

What the fifth review changed: release validation fetches full history and tags
(`fetch-depth: 0`, `fetch-tags: true`); in CI, an unreadable or missing tag set fails instead
of skipping the release-agreement assertions. A table test covers every CI/tag decision, and
a workflow test keeps both checkout settings together.
The fourth review pins the source to the release tag's immutable commit, automates
the formula pin after tagging, and rejects every shadowing CLI on PATH, including the same version.
Earlier reviews reject dirty, ahead or diverged taps and mismatched formula
metadata before install; support stable release tags; detect shadowing CLI binaries on PATH;
build with checksum-pinned resources and guard the formula's repository layout. The tests pin
the command order and reject unexpected commands. Local acceptance is separate from real
Homebrew installation, which this correction prohibits.

Status: implemented on `feat/brew`, based on `b171b8a`. No version bump or release actions.

## Why

The Operator needs one repository command to install or upgrade the CLI and prove the installed
version. The repository is private until 0.1; tapping and refreshing need Git access to it.
The CLI has no runtime dependencies and needs Node 26.

## Decisions

- This repository is its own tap: `Formula/htmlgate.rb`, addressed as `mneves75/htmlgate/htmlgate`.
- A local Git URL derived from the formula's real path builds from the tap's own clone at the
  release tag and pins that tag's commit with `revision`. Homebrew's source download has no access to the owner's Git credentials.
  The explicit formula
  version matches `packages/cli/package.json`; `X.Y.Z-beta.N` maps to `vX.Y.Z-betaN` and
  `X.Y.Z` maps to `vX.Y.Z`; all other formats are rejected. Release order: version bump and
  release commit, gates, tag, `pnpm run cli:formula` and commit the formula, push main and the
  tag, deploy, then `pnpm run cli:install` on the owner's machine and report the version it
  printed. A release commit cannot contain its own hash, so the formula pin belongs in a
  follow-up commit after tagging. Before the package's tag exists, the formula may stay one
  release behind; once it exists, tests require the package release and its commit. Unavailable
  Git or tags produce explicit skipped tests only outside CI. Release validation needs the
  tags: its checkout uses `fetch-depth: 0` and `fetch-tags: true`, and CI fails when the tag
  set or formula tag cannot be read. A readable tag set without the package's next release
  tag still allows the formula to remain one release behind before tagging.
  `cli:formula` resolves `refs/tags/<tag>^{commit}` through an injected runner (a same-named
  branch cannot substitute for the tag), requires exactly
  one tag, revision and version field, and changes only those fields. It fails with "tag first,
  then pin" when the tag is absent; an already pinned formula is unchanged.
  The formula must stay in the tap's `Formula/` directory; install rejects a source without
  `packages/cli/package.json` before building.
- Build only `packages/cli`, using TypeScript and Node-type Homebrew resources pinned to the
  root devDependencies, plus undici-types pinned to pnpm-lock.yaml, all with SHA-256 checksums.
  Stage all three into node_modules before invoking the compiler with Homebrew's Node,
  without npm or npx. A real Homebrew build showed that Node's fetch types need undici-types
  even with `skipLibCheck` enabled.
  Install its dist, package.json, LICENSE and README into libexec. The launcher uses Homebrew's Node.
  The CLI package's homepage metadata names this repository, as does the formula.
- `pnpm run cli:install` uses one injected runner. It checks Homebrew, taps only if needed,
  refreshes only this tap with `git fetch --tags --prune origin`, requires a clean working tree,
  and compares HEAD with origin/main. Only an ancestor is fast-forwarded with
  `git merge --ff-only origin/main`; ahead or diverged taps require inspection, never reset or
  stash. Verify HEAD after a fast-forward, require the package-derived release tag in that
  clone, and read its Formula/htmlgate.rb to match the expected tag, version and revision before
  installing or upgrading.
  Homebrew's automatic global update is disabled for these commands.
- Check `htmlgate --version` through Homebrew's prefix, print installed and expected versions,
  and fail if they differ. Then resolve `which -a htmlgate`: require a first result equal to
  exactly `<brew --prefix>/bin/htmlgate`, whatever version another binary reports. Fail on a
  missing CLI or any shadowing path, naming PATH adjustment and the npm removal command
  without removing anything.
  A failed command, including a tap refresh, stops the operation.
- After every production deploy, run the command on the owner's machine and report its version.

## Rejected

- A public tap with release tarballs: impossible while private; switch to a release tarball
  with sha256 when the repository opens at 0.1. This is the strongest long-term alternative.
- `npm link` or global npm install: challenges the need for a tap, but does not provide the
  requested Homebrew install and upgrade path.
- A separate private tap repository: one more repository to keep in step with every release.

## Acceptance

1. Worker-free tests cover all six corrections, the literal beta/stable tag pairs and invalid
   formats, release metadata, resource URLs/checksums/staging, the source-layout guard,
   ordered commands, dirty/ahead/diverged taps, formula mismatches, PATH resolution,
   absent Homebrew, first install, upgrade, command failures and missing tags.
2. Five mutation entries protect availability, tap refresh, release tag, revision and version checks, with unique anchors.
3. Typecheck, the mutation anchor check, the requested Worker-free suites, and Ruby syntax pass.
4. Real Homebrew execution, full mutation execution and release actions are deferred by the task.

## Review and maintenance

Official [tap documentation](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap) supports an
explicit clone URL for a custom tap. The [brew manual](https://docs.brew.sh/Manpage) documents
`HOMEBREW_NO_AUTO_UPDATE`; use it so install and upgrade do not refresh unrelated taps.
The [Formula Cookbook's Git download options](https://docs.brew.sh/Formula-Cookbook#url-download-strategies)
document supplying both `tag` and `revision` on the source URL.
The weakest dependency is access to the private Git repository, which fake-runner tests cannot
prove. In five years, keep the command small and retain the version check; replace the private
local Git source with a checksum-pinned release tarball when public. Stable tags are already
covered, so the 0.1 release needs no new tag conversion rule.

## Original verification before the correction

- Tests ran red before implementation: 15 failures for the missing formula and installer.
- `pnpm run typecheck`: exit 0.
- `pnpm run mutate --check`: 185 unique anchors, up from 182.
- The four requested Worker-free suites: 4 files and 25 tests passed.
- `ruby -c Formula/htmlgate.rb`: Syntax OK.
- Each new mutation was planted separately and caught by an assertion in its named test;
  the installer source was restored after each control. This does not replace the full gate.
- A fresh read-only `gpt-6-astra` review independently reran the passing local gates and checked
  Standards and Spec: PASS, no confirmed findings. The red-first chronology and planted controls
  are recorded builder evidence; the reviewer did not reproduce those historical steps.

## Correction verification

- Before changing the installer, the Worker-free CLI suite reported 8 failures and 10 passes:
  the new refresh and missing-tag expectations failed, and the formula metadata assertion
  exposed an existing trailing-period mismatch. The assertion now matches the formula's
  unchanged description without the package description's final period.
- `pnpm run typecheck`: exit 0.
- `pnpm run mutate --check`: verified 186 unique anchors without changing source. At that
  revision the refresh anchor covered fetch and merge; the new control removed the
  release-tag verification.
- The four requested Worker-free suites: 4 files and 28 tests passed, exit 0.
- `ruby -c Formula/htmlgate.rb`: Syntax OK, exit 0.
- Real Homebrew execution, the full mutation gate, and release actions were not run for this
  correction. No new independent review is claimed.

## Second correction verification

- New tests ran red against the prior installer and formula: 44 failures and 9 passes.
- `pnpm run typecheck`: exit 0.
- `pnpm run mutate --check`: 186 unique anchors verified, exit 0. The four Homebrew controls
  remain; the refresh anchor now removes fetch alone, and ordered expectations also require
  the conditional fast-forward. The 182 base entries are unchanged.
- The four requested Worker-free suites: 4 files and 63 tests passed, exit 0, using a temporary
  Vitest config with no global setup. The CLI suite contributes 53 tests.
- Each of the four Homebrew controls was planted separately with the Worker-free config and
  classified CAUGHT by the existing mutation reporter: version mismatch (1 assertion failure),
  omitted refresh (33), absent Homebrew (1), omitted release tag (22). Each run restored source;
  these focused controls do not replace the full mutation gate.
- `ruby -c Formula/htmlgate.rb`: Syntax OK, exit 0.
- Real Homebrew installation and resource compilation, Wrangler, full gates, commits,
  pushes and release actions were deferred by the second correction task. The owner's
  subsequent real build confirmed that undici-types is needed.
- A fresh read-only `gpt-6-astra` verifier reran all four permitted gates and `git diff --check`:
  PASS, with no confirmed Standards or Spec findings. The planted controls above are builder
  evidence; the verifier checked their definitions and anchors, not their historical execution.
  `cccc 1.8.0` parsed the focused installer without errors (installCli cognitive 31, cyclomatic
  33; no configured threshold). Builder model provenance is only reported as Codex based on
  GPT-6, so a distinct-model claim cannot be established from the available metadata.

## Fourth correction verification

- Before implementation, the focused suites reported 37 failures and 43 passes: missing source
  pin and pinning script, absent revision validation, and the fifth mutation control. After the
  revision fixes, five PATH tests remained red. The isolated same-version shadow test then
  failed with "expected +0 to be 1" before removing the allowance; missing-PATH messages also
  failed their expected assertion.
- `pnpm run typecheck`: exit 0.
- `pnpm run mutate --check`: verified 187 unique mutation anchors without changing source,
  exit 0. The 182 base controls and four existing Homebrew controls remain unchanged.
- The four requested Worker-free suites: 4 files and 85 tests passed, exit 0. Both tag-dependent
  metadata checks executed on this checkout; unavailable Git or tags explicitly skip them.
- Each of the five Homebrew controls was planted separately and caught by an AssertionError in
  its named CLI suite, exit 1. The new revision control failed the "revision mismatch names
  both commits before install or upgrade" assertion. Source was restored after every run;
  these focused controls do not replace the full mutation gate.
- `ruby -c Formula/htmlgate.rb`: Syntax OK, exit 0.
- `node scripts/cli-formula.mjs`: "Formula is already pinned to v0.1.0-beta13
  (b171b8a8ffa6bef48575c24b6d5ae02f1c60aad2); unchanged." Formula bytes and modification time
  were unchanged. `git status --short Formula` retains only the intended `Formula/htmlgate.rb`
  revision edit from this correction.
- Real Homebrew execution, Wrangler, full gates, commits, pushes, tags and deploys were not run,
  as required by this correction's scope.
- A fresh read-only review found that unqualified Git names could resolve a same-named branch
  without the tag. An injected-runner regression failed first ("expected +0 to be 1"); pinning
  now resolves `refs/tags/<tag>^{commit}` explicitly.
- The fresh verifier's full correction recheck found no unresolved functional findings:
  typecheck, 187 anchors, the four suites (85 tests), Ruby syntax and diff checks passed.
  Both JavaScript scripts parsed without errors under `cccc 1.8.0`. The verifier was configured
  as `gpt-6-astra`, reasoning `xhigh`, with fresh context; exact builder-model identity is
  unavailable, so model-distinctness remains unverified. Red-first chronology, planted controls
  and filesystem idempotence remain builder evidence, separate from the independent checks.

## Fifth correction verification

- The new decision-table and workflow tests ran red first: 9 failures and 83 passes, exit 1.
- `pnpm run typecheck`: exit 0.
- `pnpm run mutate --check`: "Verified 187 unique mutation anchors without changing source.",
  exit 0.
- The three requested Worker-free suites, using a temporary config without global setup:
  "Test Files 3 passed (3)" and "Tests 92 passed (92)", exit 0 both with CI unset and with
  `CI=1`. Both real tag-dependent assertions executed in this checkout.
- With `GIT_DIR` pointing to an absent repository inside this checkout, the CLI suite reports
  "Tests 82 passed | 2 skipped (84)" outside CI, exit 0. With `CI=1`, it reports
  "Tests 2 failed | 82 passed (84)", exit 1, and both failures say "Release validation needs
  the tags: checkout must use fetch-depth: 0 and fetch-tags: true".
- No commits, pushes, Homebrew execution, Wrangler, full gates or release actions were run.
- A fresh read-only verifier independently reran the requested checks and unreadable-tag
  controls: all correction criteria passed, with no requirement gaps. `git diff --check`
  also passed. The temporary Worker-free config was removed after verification.
