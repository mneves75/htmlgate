# Plan 015: Package and verify a single-commit 0.1 release

## Owner decision and boundary

Planned against `526d657`, 2026-10-18. The owner requested one squashed release and changelog entry for 0.1, then explicitly authorized replacing the published history and tag. Use the repository's SemVer spelling `0.1.0` and `v0.1.0`. This authorization persists; do not ask again for the same ref replacement. Required source, mutation, CI, security and deployment gates remain binding. A changed remote ref or a refused lease stops publication.

The literal one-commit outcome supersedes the previous formula-follow-up convention. The current formula stores its release commit hash inside the same repository, so it cannot pin the hash of the commit containing that formula. Removing the pin without an equivalent integrity check is not an acceptable solution.

What the second adversarial planning review changed: use one immutable `0.1.0` source candidate for staging and production. The unused beta tag is a staging alias of that same commit, not a different package version. Deployment scripts do not derive targets from package versions; no requirement justifies rebuilding a second source archive solely to promote environments. The repository's publication-before-deployment order means stable source becomes installable before staging succeeds; retain that boundary explicitly.

## Chosen architecture

Generate a small deterministic source archive of the CLI's build and installed documentation inputs before committing. Commit that deliberate release artifact under `Formula/sources/`, named with its SHA-256. The formula fetches the tap-local archive through a `file://` URL and uses Homebrew's standard top-level `sha256` verification. Preserve every checksum-pinned TypeScript, native compiler and Node-type resource. All source, archive and formula changes can now be in one root commit because the archive excludes the formula itself.

The CLI configuration is standalone: `packages/cli/tsconfig.json` includes `src` and does not extend the root configuration. Archive the CLI's `src/`, `package.json`, `tsconfig.json`, `LICENSE` and `README.md` as multiple root entries, and build at the extracted root. Homebrew enters a sole top-level directory automatically, so an archive containing only `packages/cli/...` would change the build directory unexpectedly. Exclude dependencies, compiled output and private/unapproved files. Reject symlinks, unsupported input types, unsafe paths and an unaccounted-for added source input rather than silently omitting it.

Prefer an existing standard archive tool with deterministic ordering and normalized timestamps, ownership and modes in a small task-owned staging directory. Do not mutate source timestamps or introduce a custom archive parser, a new dependency, a hashing framework or an external distribution service. Compression is optional; this source set is only about 68 KB. Generation must be reproducible across two runs and after input timestamp changes. CI must detect stale committed bytes. Archive consistency checks belong in the release suite, not a global setup that would make unrelated behavioral mutations fail for the wrong reason.

Primary reference: [Homebrew Formula Cookbook](https://docs.brew.sh/Formula-Cookbook), checked 2026-10-18. A fresh read-only adversarial advisor compared this approach with a two-commit release and a custom verified-input manifest. The source archive is chosen because Homebrew already owns its checksum/extraction path. The manifest alternative needs complete input coverage and isolated compilation to prevent extra unchecked files influencing the build; it adds a second integrity implementation. Two commits are simpler under the old convention but contradict the newly authorized outcome.

## Implementation ownership and sequence

Implement serially with the existing R2 correction and thumbnail work; the mutation table and release tests overlap. Preserve the immutable historical fixture and unrelated compiler/landing work.

1. `scripts/cli-formula.mjs`: generate the archive and update the archive URL, top-level checksum, product version and formula revision before committing. Fail clearly on malformed formula fields or unsafe/incomplete source inputs. Do not alter resource checksums. Running again on unchanged inputs must leave bytes and Git status unchanged.
2. `Formula/htmlgate.rb`: switch from the Git-tag/revision download to the content-addressed archive and standard SHA-256. Preserve build resources, licence and CLI installation layout. Use formula-level `revision 1` for the rebuilt `0.1.0`; this is distinct from the removed Git downloader's `revision:` argument.
3. `scripts/cli-install.mjs` and release tests: verify the trusted formula/archive checksum, archive contents against the CLI inputs of the selected release, product version, clean expected tap and PATH precedence. Preserve refusal of missing/unreadable required tags and dirty or unexpected taps. The release lifecycle may test a pre-tag candidate, but an installed/released artifact must match its published tag; do not silently skip a stale tag conflict.
4. Treat same-version replacement explicitly. Homebrew may retain an old `0.1.0` binary while its `--version` still passes. Require the installed `0.1.0_1` receipt and actual installed JavaScript/package/documentation bytes to match a build from the verified archive, plus the real CLI's version and a user-facing operation. An exit code or matching version string alone is insufficient.
5. `test/cli-brew.test.ts`, `test/cli-release-tags.test.ts`, and focused packaging tests: exercise the real generator/installer interfaces with controlled external process boundaries. Keep installer mutation controls free of conditional skips. Put release-state checks in their separate suite. Retain positive controls for supported paths, versions and resource integrity.
6. `scripts/mutate.mjs` and the explicit historical-delta review: replace obsolete Git-revision protection with equivalent archive-integrity protection, documenting the precise semantic change. Add meaningful controls for new independent protections. Keep the original fixture bytes/hash unchanged and preserve all other existing controls; never lower strict skipped/pending/BROKEN classification.
7. Update `AGENTS.md`, root and CLI READMEs, release docs and the final consolidated changelog to describe the implemented packaging/lifecycle. The committed archive is an intentional versioned release artifact, not disposable test output. Do not create a GitHub Release, publish a package or add an external artifact service by implication.

## Regression and acceptance evidence

Observe RED before each minimal implementation slice, then GREEN. Required cases include:

- The same approved input bytes generate an identical archive despite filesystem timestamp changes.
- A changed, omitted or additional source input cannot leave a stale archive accepted.
- Symlink/unsafe inputs refuse before packaging or installation side effects.
- Corrupted archive bytes and a mismatched top-level checksum refuse; compiler-resource checksums remain unchanged.
- A wrong tagged archive, missing required tag, dirty tap or wrong installed receipt refuses.
- A real Homebrew fetch rejects deliberately corrupted archive bytes before compilation, using a task-owned fixture/cache so no existing installation is replaced by the negative control.
- An ordinary positive archive builds and the actual installed artefact matches its inputs; test commands alone cannot establish installation proof.
- Required focused checks, full check, a fresh uninterrupted full mutation run, page benchmark and independent acceptance pass for the final frozen tree. Never combine mutation runs or overlap source changes with a gate.

## Existing taps and cached versions

Current installer safety checks intentionally refuse rewritten history, and Git downloads can keep a cached old tag. Do not weaken ordinary fast-forward or dirty-tap refusal to make this one transition succeed. Inspect the exact existing tap, preserve its checkout, Git state, unresolved work and relevant receipts in a recoverable backup, and rehearse the narrow transition before changing it. An unrelated in-progress rebase is not disposable. Any outside-repository action not already authorized needs its concrete target and recovery plan first. The new archive's content-addressed URL avoids reusing the old Git download cache.

## Publication order and recovery

1. Finish Plans 013/014 and packaging, then freeze the candidate. Keep one consolidated final `0.1.0` changelog entry; provisional prerelease entries are folded into it at final preparation.
2. Finish the stable `0.1.0` source, documentation, archive and formula once, and freeze tree T. Preserve the old public ref objects and original tag object in a verified private backup before making the old local tag unavailable for pre-tag validation. Run full local gates and independent acceptance on T, including one uninterrupted complete mutation run. A conditional local pre-tag skip never proves a released artifact. A quota failure is BLOCKED, not accepted.
3. Create the single root release commit R and verify its tree equals T. After checking local and remote tags, create annotated `v0.1.0` and the next unused `v0.1.0-betaN`, both pointing to R. Preserve `releaseTag()`'s canonical package mapping: the beta tag only names the staging deployment. Rerun focused release/tag/archive assertions with enforcement enabled.
4. Re-read remote `main` and `v0.1.0` immediately before replacement. Publish main, replaced stable tag and new staging alias atomically using explicit `--force-with-lease` expectations for both old refs and an absent beta ref; never plain force. A refused lease or unexpected ref change stops the action. Local backup and restore evidence must already exist.
5. Required CI on exact R with its tags must pass before staging. Run the exact-tree staging security gate, deploy the Instance and landing preview from R, and verify behavior, image responses, smoke and benchmarks. Refresh advisories and production-specific security controls, then promote the same R following the Instance-before-landing sequence. Reuse the full source audit only because the tree is identical; retain target-specific runtime proof. Verify the advertised production image URL and installed CLI artifact. Pushing a ref is not deployment acceptance; leave X rendering/cache unverified unless actually observed.
6. Restore the expected visible main checkout without discarding unrelated work. Remove only task-owned disposable branches/worktrees after their contents are preserved. Keep necessary release, rollback and security evidence.

## Current status

Implemented with a deterministic 81,920-byte CLI-root archive, standard Homebrew SHA-256, unchanged compiler pins, revision `1` receipt checks and installed byte verification. Focused source controls passed; the two old-tag refusals are expected until the backed-up release transition. Typecheck and all 221 anchors validate, including six new integrity controls and the explicit replacement of the old Git-revision guard. A real isolated Homebrew fetch/stage accepted the valid archive and refused corrupted bytes before compilation. Required full gates, tagged enforcement, independent acceptance and deployed proof are separate release conditions; their results belong in the release evidence.
