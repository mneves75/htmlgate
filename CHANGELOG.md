# Changelog

All notable changes to htmlgate. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.10] - 2026-10-19

### Fixed

- On a phone the report kept both counts, but left the all-time figure unlabelled under the 30-day one. It now shows
  its own "Total" label, the way the token list reveals its labels on narrow screens, and the breakpoint is a container
  query like the board's.
- The browser assertion that guards the report measured the whole cell, whose screen-reader label holds "30 days" — so
  it passed on a cell with no number at all. It now measures the number element itself and requires a visible digit, and
  a Share with no opening yet is measured too.
- `pnpm run cli:formula` prunes the source archives the formula no longer references, so `Formula/sources/` holds the
  one archive the tap installs from.

0.1.9 was tagged but never deployed.

## [0.1.9] - 2026-10-19

### Fixed

- `/metrics` rendered its counts in a column that looked empty: the numbers were there but the "no opening yet" text
  sat inside the screen-reader-only label, and the Share's slug used the board's dark flap cells, which tile the whole
  column on the light ground and leave the glyphs unreadable. The row is now a plain table row: the title with its
  slug in muted mono, and both counts always visible as numbers, a zero in a quieter tone. The all-time column drops
  on phones.
- A browser test now measures the report in a real browser (no flap cells, the count inside the card, a digit in the
  cell), so a layout that looks empty cannot pass again; the metrics test asserts the number sits outside the label.

## [0.1.8] - 2026-10-19

### Changed

- `/metrics` is in the page budget: the bench measures it with the 50 Shares it already seeds, so the report's
  render cost is gated like every other page.
- A test and a mutation control now cover the count's live guard: a view that arrives after an erasure, or for a
  Share whose date has passed, stores nothing.
- The README's routes table lists `/metrics` with the other Author-only pages.

0.1.7 was tagged but never deployed (its checks were the same tree plus these).

## [0.1.7] - 2026-10-19

### Fixed

- The hourly cleanup left an expired Share's counts behind: the delete of `share_views` ran after the delete of
  its Versions, and `due` selects Shares that still have Versions, so the batch just purged matched nothing and
  the next batch lost its rows instead. The counts now go first, in the same batch, and a test asserts that a
  purged Share keeps none and a live one keeps its own.
- A view written between a page read and an Author's erasure no longer creates a row nothing would delete: the
  insert only lands while the Share is live.
- `/metrics` lists your 500 most recently updated Shares, which is what the docs now say, and the hourly
  cleanup's query budget comment counts the fourth statement (32 of Workers Free's 50).

0.1.6 was tagged but never deployed.

## [0.1.6] - 2026-10-19

### Changed

- The metrics report is about this Instance's Shares, not the landing's pages: the home's board carries each
  Share's views over the last 30 days, and `/metrics` lists your 500 most recently updated Shares with their
  30-day and all-time counts and a button that opens each. The landing-page snapshot from 0.1.5, its sync command and its API are gone.
- Views are counted on the server, from the request a browser already sends, as one row per Share and UTC day
  (`share_views`): no cookie, no script, no visitor, address or identifier. Raw bytes, a prefetch and a page
  that does not exist are not views. Erasing a Share drops its count in the same transaction; the hourly
  cleanup erases them with an expired Share's bodies. `docs/privacy.md` lists the new table, and the landing's
  FAQ now says what an Instance counts and what it does not.

## [0.1.5] - 2026-10-19

### Added

- `/metrics` on the Instance, for the Author only: the counted pages of a site as a table, one row per
  page with its views, when it was last opened, and a button that opens that page; a "Métricas" button
  in the top bar and on the home. `pnpm run metrics:sync` reads the counts from Workers Analytics Engine
  with the Operator's `cf` login and stores the snapshot through the API — a Worker writes Analytics
  Engine and cannot read it, so no Cloudflare credential reaches the Worker.

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
