# Changelog

All notable changes to htmlgate. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.4] - 2026-10-19

### Fixed

- The invalid-budget-override control no longer depends on the host: CI falls back to 150 ms, so the
  control clears `CI` in its child and pins the 50 ms budget it asserts.
- The shebang comparison is byte-exact on the body after the first line, instead of a UTF-8 round trip.
- A control now refuses a launcher whose shebang points at another interpreter, which is the rejection
  side of the Homebrew rewrite.
- `Formula/sources/` keeps only the archive the formula references; the superseded ones are gone.
- The installer examples in both READMEs describe the version pattern instead of a fixed old version.

## [0.1.3] - 2026-10-19

### Fixed

- The installer's new symlink refusal rejected a correct keg: Homebrew links `bin/htmlgate` onto PATH with a
  relative symlink by design. The keg's launcher is now the file that is checked, and the PATH link must
  resolve back to this keg.
- The mutation control for stale installed bytes pointed at the comparison it replaced; it plants the
  current one, so a removed artifact check is caught again.

0.1.1 and 0.1.2 stay tagged as checkpoints; their installer refused a correct install.

## [0.1.2] - 2026-10-19

### Fixed

- `pnpm run cli:install` refused a correct Homebrew install: the formula's compiler rewrites the
  installed `dist/bin.js` shebang to the Homebrew node it depends on, and the artifact check compared
  it byte for byte against a plain build. The check now accepts exactly that one rewritten line and
  nothing after it, and still refuses a symlinked `libexec` or `bin/htmlgate`.
- The page-budget override test now pins an invalid `HTMLGATE_BENCH_BUDGET_MS`, so a value that is not
  a positive number cannot silently disable the budget again.
- The CI step is named for the budget it enforces (50 ms locally, 150 ms on the runner), so a release
  record cannot read a 150 ms run as a 50 ms result.

## [0.1.1] - 2026-10-18

### Added

- Every page shows the release it runs: the Instance's pages carry it in a footer (the viewer's bar,
  so it never covers the Share) and every landing page carries the same number, privacy notices and
  404 included. `test/version.test.ts` keeps them equal to `package.json`.
- The landing's FAQ answers what its page counts record, in both languages.
- The landing counts each page a browser opens, server-side in Workers Analytics Engine: the page,
  its status, the country and the referring site's hostname. No cookie, no script, no IP address or
  browser details, so it needs no cookie banner; both privacy notices say what is counted and that
  Cloudflare keeps it 3 months. README shows the `cf` query for views per page. Instances are unchanged.

### Fixed

- `pnpm run cli:install` reads one formula's receipt instead of every installed formula (which
  overflowed the buffer) and checks the licence and README where Homebrew puts them, in the keg
  root, instead of a libexec layout Homebrew never produces.
- CI measures page loads against the 3-core runner's allowance (150 ms) rather than the 18-core dev
  machine's 50 ms, which no commit could meet on `macos-15`.
- Two tests no longer depend on host load: the write-limit burst finishes inside its own minute, and
  a cut endless body is an assertion rather than a runtime error.

## [0.1.0] - 2026-10-18

Initial public release. htmlgate is a self-deployed, private-by-default HTML host that each
Operator runs in their own Cloudflare account: an agent publishes a Share (one HTML page or a
static site from a zip or a folder) and gets a stable URL that opens only for people on the
Operator's Allowlist after they sign in, unless that one Share is made public.

### Added

- The Instance Worker, the `htmlgate` CLI, the landing site, setup and release tooling, and the
  full test suite (typecheck, integration tests through `wrangler dev`, browser tests, the
  mutation gate and the page budget).
- Gated and Public Shares with per-Share expiry, version history (20 Versions), tags, sites
  from zips or folders, tickets for Gated site files, and erasure by the Author.
- Operator documentation in `docs/operator.md` and `docs/privacy.md`, security reporting in
  `SECURITY.md`, and the visual system in `DESIGN.md`.
- An Instance with a Custom Domain answers only there, its workers.dev hostname off, because the
  Access application gates the Worker itself. Instances keep no per-request logs by default:
  Workers Logs keep only the Worker's unexpected errors, and the landing keeps its own (3 days).
- Localized Open Graph and large-image social cards for both landing languages, using the
  public brand poster, with crawler regression tests for the HTML and JPEG responses.
- Regression tests and mutation controls for release-readiness protections.
- Deterministic, checksum-verified CLI source archives for single-commit releases, with
  Homebrew rebuild-receipt and installed-artifact verification.

### Fixed

- Update the browser regression driver to 0.39.1 for upstream Chrome stderr, daemon and
  command-replay fixes, preserving browser assertions and timeouts.
- Setup and landing deployment refuse unversioned copies inside another Git checkout while accepting clean clones, registered worktrees and symlink aliases.
- Expiry guidance distinguishes immediate 404 responses from bounded hourly physical cleanup,
  with retries and no guaranteed deletion deadline. Operator guidance covers compromised devices,
  separate credential/session revocations, and contained restores that reapply revocations and erasures.
  Privacy notices disclose authentication data processing by an external sign-in provider when chosen.
- ZIP publishing and updates preserve literal metadata keys such as `__proto__` and reject
  unknown top-level query fields.
- Setup verifies the existing Worker's Access association and every traffic-serving version's
  storage bindings before changing it. A marked, closed first deployment can resume safely.
- Setup completes ordered R2 bucket discovery before creating resources and refuses reused
  buckets with public domains or an unknown privacy state.
- Mutation validation rejects skipped and pending controls, including runs that also contain
  a failed assertion. Installer controls run separately from conditional Git release checks.
- Public clones carry the historical mutation baseline needed by their tests.
- Smoke checks require a genuine HTTPS Access hostname and bound request and body reads.
- The CLI source archive is byte-identical under any packaging umask, so a restrictive umask no
  longer makes `cli:install` refuse a correct release as stale.
