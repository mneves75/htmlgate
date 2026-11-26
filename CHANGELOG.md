# Changelog

All notable changes to htmlgate. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.24] - 2026-11-25

### Security

- **Revocation stops writes in flight (H2-1, `src/store.ts`, `src/api.ts`):** every token-authorized Store write re-checks in its liveness-deciding statement that its token is unrevoked, so a write whose body was still uploading when the token was revoked no longer lands; the API answers `401`. The same applies when a token revokes another token, and every other write answer except success re-checks the token: `401` if it is now revoked, `503` if the check fails, so a revoked token's status codes do not tell it which Shares exist. Covered by `test/revoke-in-flight.test.ts`, a new `CONTAINMENT_NO_POST_REVOKE_WRITE` model invariant with its replay (9 historical bug replays), and nine mutation anchors.
- **CLI listing memory cap (H4-1, `packages/cli/src/bin.ts`, `packages/cli/src/api.ts`):** `htmlgate list` stops with `bad_response` (exit 8) once the rows it holds pass 64 Mi characters, and Share `metadata` is validated as a flat string map, so a hostile Instance can no longer exhaust memory or trigger serialization errors with many large pages or deeply nested metadata. The terminal table pads each column to at most 200 characters, so one long title no longer pads every row to its length.

## [0.1.23] - 2026-11-25

### Security

- **Store lifecycle CAS & quota accounting (`migrations/0008_trash_nonce.sql`, `src/store.ts`, `scripts/storage-status.sql`):**
  - Added per-write random `trash.nonce` (`lower(hex(randomblob(8)))`) and updated `Store.emptyTrash()` to compare `(body_key, due_at, nonce)` via a bijective two-binding tuple across all 50 batch rows (100 D1 parameters, 45 total D1+R2 ops per cron run) while `Store.dueNow()` advances `due_at` on already-due conflicts and writes a fresh `nonce`. Closes two-worker same-millisecond, backward-clock-skew, and rolling mixed-version delete races; formally verified across 791,308 reachable states and 8 historical bug replays (`pnpm run verify:model`).
  - Enforced `VERSION_FLOOR` (20 KiB) on `trash` rows across `ROOM`, `dueNow()`, `expire()`, `addVersion()`, `eraseShare()`, `eraseBodies()`, and `scripts/storage-status.sql`.
  - `Store.expire()` now scrubs `title`, `description`, `tags`, and `expires_at` on expired Shares while marking legacy versionless expired rows deleted (`deleted_at = COALESCE(deleted_at, expires_at)`) in bounded batches.
  - Scoped `Store.versions()` and `Store.version()` by `author` at the SQL layer.
- **ZIP archive verification (`src/zip.ts`):**
  - Verifies non-directory macOS metadata entries (`__MACOSX/*`, `.DS_Store`) against size limits and deflate/CRC checks, and blocks directory entries carrying payloads (`csize > 0` beyond a verified 2-byte empty deflate stream).
  - Enforces POSIX `S_IFMT` symlink and special-file rejection regardless of `madeBy` host OS (including macOS `madeBy=19`).
  - Rejects polyglot bytes before entry 0, non-zero `diskStart`, LFH/CD encryption/bit-3/CRC/size mismatches, unvalidated bit-3 data descriptors, malformed extra headers, ZIP64 (`0x0001`) and Info-ZIP Unicode Path (`0x7075`) extra fields, and Unicode control/formatting characters in paths.
- **Browser isolation, HTTP & API hardening (`src/http.ts`, `src/index.ts`, `src/api.ts`, `src/access.ts`, `src/config.ts`, `site/src/worker.ts`):**
  - Added `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin` (preserving `cross-origin` on site files, `/p/<slug>/card.jpg`, and landing `/media/*`), `Permissions-Policy`, and `X-Frame-Options: DENY` on non-raw HTML and JSON responses; added `referrerpolicy="no-referrer"` on the Share viewer iframe and CSS `unicode-bidi: isolate` on user-controlled text.
  - Hardened `serveTicketFile()` expired-ticket navigation redirects to require a 24h grace window, valid site path, and live Share before issuing `303`.
  - Short-circuited unmatched `/p`, `/p/*`, and non-GET/HEAD `/robots.txt` before Access JWT verification; capped Access JWT length at 8 KiB, rejected non-`"app"` JWT `type`, and tightened `ACCESS_TEAM_URL` validation.
  - Added linear pre-parse `checkJsonShape()` bounding nesting depth (`<= 8`) and structural delimiters (`{`, `}`, `[`, `]`, `,`, `:`; `<= 1000`); blocked Unicode `Cc`/`Cf` control and Bidi characters in Share titles and descriptions (allowing `\t`/`\n`/`\r` in descriptions).
  - Replaced `TYPES` MIME map with a null-prototype dictionary (`Object.create(null)`).
  - Restricted landing `referer` analytics extraction to `http:`/`https:` URLs.
- **CLI & operator tooling (`packages/cli/src/*`, `scripts/*`):**
  - Refused symlinked `.htmlgate` parent directories and target config files (`O_NOFOLLOW`) in CLI project config loading.
  - Enforced strict same-origin Share URL validation and normalization (`normalizeShareUrl`), terminal control/Bidi sanitization on all text and JSON outputs, and a 500-page ceiling plus non-negative `total_pages` check on `htmlgate list`.
  - Hardened `scripts/setup.mjs` with `.instance` symlink checks, atomic `0600` config writes (`0700` directory), expanded clean-tree `DEPLOYED` guards (`package.json`, `pnpm-lock.yaml`, `tsconfig.json`), strict flag parsing, `org.auth_domain` host validation, bounded DNS pagination, and fail-closed `verifyAccessApp()` (re-reading partial Access API responses).
  - Hardened `scripts/cli-install.mjs` (stdin tar bytes without TOCTOU re-read, `refs/tags/` qualification, non-symlink metafile checks), `scripts/site-deploy.mjs` (strict HTTPS Access host check and Worker destination check), `scripts/token.mjs` (strict flag parsing), `scripts/bench.ts` (stripped tokens from browser env, 10-minute expiry on `--live` fixtures, `--site` origin validation), and `scripts/perf/edge.mjs` (`--url` operands, `--base` and `--gap` validation).

### Fixed

- Combined Author home and `/metrics` Share listing with 30-day/all-time view counts into a single atomic CTE query (`Store.recentShares`), preventing concurrent-update zeroed view counts and replacing full `share_views` scans with primary-key lookups while staying within 1 D1 wave.
- Fixed `POST /erase` re-renders dropping 30-day view counts, aligned the 30-day window to 30 inclusive UTC days (`-29`), unwrapped IPv4-mapped IPv6 addresses in `VIEW_LIMIT` `network()`, and fixed duplicate `expires_at` query parameter detection on ZIP publishes.
- Fixed `htmlgate list -n <N>` multi-page offset drift (keeping `pageSize` constant across pages), bounded CLI file reads to 64 KiB chunks, closed leaked file descriptors on Linux `readlink` errors, stripped trailing slashes on `publish` paths, skipped `__MACOSX` when zipping folders, forwarded `--title ""` on `update`, mapped `https_required` to exit code `8`, capped interactive stdin reads, and restored raw TTY mode on `SIGINT`/`SIGHUP`.
- Fixed `scripts/mutate.mjs` replacement `$` handling and expanded the mutation suite to 262 anchors; extended `scripts/lint.mjs` to catch `Response.json`/`redirect`/`error`, trailing fetch spreads, `@ts-nocheck`, and `ctx["access"]`.

### Changed

- Modernized the landing and Instance stylesheets with `color-mix(in oklab, ...)`, `@view-transition`, progressive `::details-content` FAQ animation, accessible `<pre role="region">` code blocks, and updated EN/pt-BR privacy notices (using `tíquete` per `GLOSSARY.md`).
- Updated `formal/verify.ts` to extract `src/store.ts` and `scripts/token.mjs` symbols via TypeScript AST rather than string slicing, and removed the expired `pnpm-workspace.yaml` release-age exclusion.
- Pruned redundant historical/mocked tests while preserving all 262 mutation anchors and parallelized stalled-server CLI timeout checks.

## [0.1.22] - 2026-11-22

### Fixed

- `pnpm run setup` now calls `cf zero-trust organization get` and `cf r2 buckets domains managed get <bucket>` to match Cloudflare's `cf` v1 CLI subcommand names.

0.1.21 was tagged before deployment caught the `cf` CLI subcommand rename on the owner's machine.

## [0.1.21] - 2026-11-22

### Fixed

- `Store.dueNow()` advances `due_at` by 1 ms on a same-millisecond conflict with an existing `trash` row, preventing `Store.emptyTrash()` from dropping a freshly re-ledgered upload row and leaving an untracked R2 object behind (found by the new formal model checker and reproduced on real SQLite).
- `scripts/site-deploy.mjs` paginates Cloudflare Access applications via `listApplications()` instead of reading only the first page.
- `scripts/smoke.mjs` disables automatic redirects on authenticated archive downloads and card probes, and validates numeric environment overrides (`HTMLGATE_LIVE_GAP_MS`); `scripts/bench.ts` validates finite numeric arguments/environment overrides (`--runs`, `HTMLGATE_BENCH_BUDGET_MS`, `HTMLGATE_LIVE_GAP_MS`) and disables redirects on local token setup.
- All Instance `Response` construction in `src/` routes through `src/http.ts` (`bytes()`, `copyResponse()`), enforcing the baseline security headers structurally.

### Added

- Repository invariant linter (`scripts/lint.mjs`, `pnpm run lint`, 9 AST rules plus version sync) and release version synchronizer (`scripts/sync-version.mjs`, `pnpm run version:sync`) wired into `pnpm run check` and CI, backed by negative tests (`test/lint.test.ts`).
- Exhaustive BFS formal model checker (`formal/store-lifecycle.model.ts`, `formal/verify.ts`, `pnpm run verify:model`) and project-local verification skill (`.claude/skills/store-lifecycle-verification/SKILL.md`), verifying 104,068 reachable `Store` lifecycle states and `revokeAll` containment with 7 historical/discovered bug replays wired into `pnpm run check` and CI.
- `init.sh` helper script for reproducible local check/lint/model-verification runs.

### Changed

- Encoded HTML escaping as a branded `SafeHtml` type in `src/pages.ts`, named key invariants (`MAX_UNBIASED_BYTE`, `fromCanonicalBase64url`, `RESERVATION_TTL_MS`, `hasLegacyD1BodiesTable()`), and removed redundant comments across `src/`, `site/src/`, `scripts/`, and `packages/cli/src/`.
- Pruned historical pre-0.1.0 rename fixtures and duplicate mocked/source-regex tests after folding unique DB and asset-server assertions into surviving suites while preserving all 250 mutation anchors and every security, privacy, accessibility, license, and performance check.

## [0.1.20] - 2026-11-21

### Fixed

- Setup keeps scheduled cleanup off for Instances marked as staging, including during their initial deployment. The API and erasure confirmation explain when scheduled cleanup applies.

## [0.1.19] - 2026-11-21

### Security

- First setup proves the identity of pre-created storage and records newly created resource identities for safe retries. Setup refuses ambiguous resources before migrations or deployment.
- Emergency revocation verifies the account, Access application, active Worker and storage bindings before provider writes. Single-token revocation distinguishes a revoked token, an already revoked token and an unknown ID.

### Changed

- The CLI explains that making a Share public opens its retained Versions and subsequent Versions while it stays public. The signed-in Author view links to the Public address of the Version shown.
- English and pt-BR explain the scope of the Allowlist and the difference between immediate access removal and asynchronous physical erasure.
- The Operator guide covers safe recovery, cron quiescence, inventory reconciliation, and both Access applications at teardown. Added a read-only storage and cleanup report.
- CI uses the Node pin in `.nvmrc`. The local benchmark includes the Gated Site viewer and its stylesheet.

- Agent instructions: `docs/agents/issue-tracker.md` no longer blames a commitless parent repository (the
  parent directory is no longer a Git repository); research worktrees are still made by hand under
  `.scratch/wt/`. A new `.claude/settings.json` refuses force-adding ignored files and removing the CLI's
  `LICENSE`, asks before a live site deploy, a production `setup` and edits to `docs/perf/budgets.json`, and
  adds a Stop gate on `pnpm run check`.

## [0.1.18] - 2026-10-31

### Security

- A Share's page now counts as viewed at most once a minute per network address (a new `VIEW_LIMIT` rate limit,
  keyed on the address and the Share; an IPv6 address by its /64, the block one subscriber holds). Before, any client could inflate a Public Share's count, and cost a database
  write, with every repeated request. The address keys Cloudflare's rate limiter and is never written; an Instance
  without the limit counts nothing. Run `pnpm run setup` to add the binding.
- The storage cap counts what a Version makes the Instance hold: its body plus, for a site, its file index in the
  database, and never less than 20 KiB, which covers a Share's largest title, description and metadata. Before, a
  site of empty files with long names, or a run of empty pages, grew the database outside the cap. On an Instance
  near its cap, small Shares now use more of it.
- `pnpm run token revoke-all` ends every way in at once. It checks that Wrangler and `cf` use the same account,
  then revokes every Access sign-in to the Instance (so a stolen session cannot make a token meanwhile), every token,
  and replaces `TICKET_KEY`, in that order. Each step is safe to repeat (docs/operator.md, "Stop a caller").
- htmlgate.com publishes `/.well-known/security.txt`, pointing at private vulnerability reporting. The landing's
  privacy notice now says how an Instance counts views.
- Local development: undici under miniflare goes to 7.30.1 (eight advisories), by a pnpm override until Wrangler
  carries it past the release-age rule.

### Added

- `mfa` in `instance.json` (off by default): signing in to the Instance also asks for a second factor the Zero
  Trust organization allows, once a day. Enrol an authenticator first (docs/operator.md, `instance.json`).

## [0.1.17] - 2026-10-31

### Changed

- Fewer sequential trips to the database, each about 176 ms from Brazil to a D1 in North America (a route-level
  estimate, `docs/perf/BASELINE.md`): every API request finds its token and records its use in one round trip
  instead of two; the Author's home and `/metrics` send their reads together (2 trips to 1); the Share list reads
  its total and page in one batch, and a Share's Versions are read alongside the Share check (4 trips to 2 each,
  with the token change). Publishing, a new Version, edits and visibility changes each make one trip fewer.
  Behaviour is unchanged, failure paths included: a Share that is not the Author's is still a 404 when a read
  fails, and an unknown or revoked token is still a 401 when the database refuses writes.

### Added

- `docs/perf/`: the measurement harness and its results. `scripts/perf/edge.mjs` measures time to first byte from
  where it runs (new and warm connections, A/A or Version-pinned A/B); `scripts/perf/roundtrips.ts` counts the
  database round trips on each route's critical path, and `test/roundtrips.test.ts` holds every route to its
  ceiling in `docs/perf/budgets.json`.

## [0.1.16] - 2026-10-20

### Fixed

- `pnpm run setup` now finds the robots application by the path it answers as well as by its name, and refuses with a
  clear message when another application already owns `<host>/robots.txt` instead of failing on Cloudflare's
  `application_already_exists`. An application made by hand for that path can no longer turn into a 409 or be silently
  repointed.

0.1.15 was tagged but never deployed.

## [0.1.15] - 2026-10-20

### Fixed

- The four tests that do dozens of round trips or multi-megabyte bodies in `test/limits.test.ts` now carry a 60-second
  timeout. On a loaded three-core runner one of them hit Vitest's five-second default during the mutation gate, which
  the gate can only report as BROKEN, and the release could not be certified. A slower machine now reports a failure,
  not a timeout.

0.1.14 was tagged but never deployed: its only open question was this gate run.

## [0.1.14] - 2026-10-20

### Fixed

- A Public Share's link showed its card on WhatsApp but not on X. The Instance's `robots.txt` sat behind Cloudflare
  Access, so no crawler could read it, and X refuses to build a card for a site whose `robots.txt` it cannot fetch
  (WhatsApp's unfurler ignores `robots.txt`, which is exactly the difference). `pnpm run setup` now creates a second
  Access application, `htmlgate: <name> robots`, that opens that one path with a `bypass` policy, and the policy allows
  `Allow: /p/` with `Disallow: /`: a Public Share is readable by crawlers, everything else stays out, and the pages keep
  `noindex`.
- `pnpm run smoke` checks that a crawler gets 200 from `robots.txt` and that the policy names `/p/`, so a missing bypass
  application is caught on the deployed Instance.

X caches a card per URL: a link it has already fetched keeps its old (image-less) card, so test with a URL it has not
seen, such as the same link with `?v=2`.

## [0.1.13] - 2026-10-20

### Fixed

- The card image moved from `/og.jpg` to `/p/<slug>/card.jpg`. The gateway override for a new top-level path was
  persisted on the Access application and still answered 302 to the sign-in page, while the prefix `/p/` passed on the
  same application: the image now lives under the prefix the edge already leaves public, so this feature needs no gate
  change, each Share gets its own cache key, and a Gated Share's image answers not-found like its page. Plan 017
  records the experiment.

0.1.11 and 0.1.12 were tagged but never deployed.

## [0.1.12] - 2026-10-19

### Fixed

- The card image kept the Instance's hardening headers (`nosniff`, HSTS, referrer policy) and is the one response whose
  cache policy is not `no-store`; `AGENTS.md` and `PRODUCT.md` now name that exception instead of contradicting it.
- The image's bundling rule names the media directory rather than every JPEG, and a test asserts the generated deploy
  config keeps it, so development and deployment cannot drift.
- Tests now cover the description's escaping in the card, the public flag as the guard that enables it on the public
  path, and the image's headers. `docs/operator.md` says the description goes to the card and not to the page, and that
  re-gating a Share does not clear a crawler's cache.

0.1.11 was tagged but never deployed.

## [0.1.11] - 2026-10-19

### Added

- A Public Share's link now unfurls with a large card on X, WhatsApp and the other Open Graph consumers: the Share's
  title, its description (or a neutral sentence when it has none) and the Instance's poster image at
  `/p/<slug>/card.jpg`, which a crawler fetches without a session. The image sits under the prefix Cloudflare Access
  already leaves public, so the gate configuration needs no special case; a Gated Share's image answers not-found, like
  its page. `pnpm run smoke` checks both, and `docs/operator.md` says how to share a link that previews.

### Fixed

- A **Gated** Share deliberately gains no card: its page is behind the gate, and no title, description or image may
  reach a crawler's cache. A mutation control and a test hold that line, and the same test shows the card appearing the
  moment the Share is made public.
- The viewer page read the Share without its description, so a description the publisher wrote never reached the
  page; it is selected now and feeds both the card and the page.

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
