# What htmlgate can take from the reference

Research for issue #2. It feeds the decision ticket #11 ("What does 0.1 keep, drop or add compared with the reference?"). This note reports. It does not decide.

Sources, read at the current tip of `main` on GitHub (both clones are shallow, one commit each):

- `the reference/` is utsengar/the reference, the server: commit `ac00be7d5a3c767d9d626b9d2037810fe1f46440` (2026-08-23).
- `the reference-cli/` is utsengar/the reference-cli, the CLI: commit `8b4d6316f13a73f9f43726525d9627c6e87df22f` (2026-08-23, version 0.6.0).

Citations look like `repo/path:line`. Sizes are `wc -l` of whole files, so comments and embedded prose count. Nothing from either repo was run, installed or called over the network. The only network reads were GitHub repo metadata (licence field, file listing, latest commit) and two Cloudflare documentation pages.

Terms: Drop, Instance, Host, Operator, Publisher and Viewer are as in `GLOSSARY.md` in this repo. "the reference" means the reference service.

## 1. Answer

1. **The CLI can publish to an Instance with almost no server surface.** Its cloud backend sends only: `POST /api/auth/start`, `GET /api/auth/poll`, and `POST`/`GET`/`PUT`/`PATCH`/`DELETE` on `/api/drops` and `/api/drops/:slug`. Section 4 is a full spec.
2. **`api_url` in `./.the reference/config` works for every command except `login`.** `the reference-cli/src/bin.ts` passes `cfg.api_url` to the cloud backend (`the reference-cli/src/bin.ts:158-159`), but `login` builds the backend with no options (`the reference-cli/src/bin.ts:463`), so it always talks to the reference.dev. A Publisher on an Instance has to get a token another way (env var or file), or we fork the MIT CLI.
3. **The CLI sends only `Authorization: Bearer`, `User-Agent` and `Content-Type`** (`the reference-cli/src/cloud/api.ts:121-129`). It cannot send Cloudflare Access service-token headers, and its source configures no redirect following (not run). The Publisher API must accept a bearer token on its own, so a sign-in gate for Viewers cannot sit in front of `/api/*`.
4. **the reference's "gate" is a per-Drop passcode and it protects less than it appears to.** The unsandboxed `/p/:slug/raw` is a separate route, its HTML is cached publicly when no passcode is set, and the social-card PNG renders the title even for locked Drops. A sign-in gate has to cover all of these (section 3).
5. **The server is a Hono Worker, D1 for metadata, KV for HTML bodies.** About 9,400 lines under `the reference/src/`, and only roughly 2,900 of them (API, auth core, viewer, routing) are the product. The rest is CSS, marketing, OG images and agent-discoverability text.
6. **Public multi-tenant-only parts**: GitHub-bound accounts, per-user quotas and rate limits, the landing page, OG cards, crawler files, Sentry, the view counter and the "content authored by @user" line. On one Instance they have no job, or a smaller one (section 2).
7. **The CLI's `cloudflare` backend is not a small Instance.** It makes one Pages deployment per slug. It has no versions, metadata, list titles or passcode. Every Publisher needs an account-level Cloudflare API token. `publish` never checks that Access is on, so a skipped setup step leaves the page public. `gh-pages` needs GitHub Enterprise for private pages (section 2.3).
8. **Licence.** The server repo has no LICENSE file, no `license` field in `the reference/package.json`, and GitHub reports none. Its README, agent card and OpenAPI document say "MIT". The CLI repo has an MIT LICENSE, `"license": "MIT"` in `the reference-cli/package.json`, and GitHub reports MIT (section 5).
9. **The reference docs disagree with its code in several places** (slug length, rate-limit scope, an abuse-report check that has no route). Treat its prose as a hint and read the code (section 6).

## 2. The ticket's "Cover" list

### 2.1 Server features: what each does and how much code

| Area | What it does | Where | Size |
|---|---|---|---|
| API contract | JSON over `/api`. snake_case fields. One error envelope `{error:{code,message,details?}}` with 25 stable codes. Mutations return the full Drop. 429 carries `Retry-After`. List is paginated. HEAD on reads. No CORS by design. | `the reference/src/drops.ts` (all routes), `the reference/src/errors.ts:12-53`, `the reference/src/slug.ts`, `the reference/src/db.ts`, `the reference/src/types.ts`; conventions at `the reference/CLAUDE.md:225-285` | `the reference/src/drops.ts` 918, `the reference/src/errors.ts` 53, `the reference/src/slug.ts` 16, `the reference/src/db.ts` 247, `the reference/src/types.ts` 72 = 1,306 |
| Device-code sign-in | The agent posts to `/api/auth/start` and gets a short code, a verification URL and a poll token. A human opens the URL and signs in with GitHub (`read:user`). The callback finds or creates a user by GitHub id, mints a token, and the agent's poll returns it once. Codes live 10 minutes. | `the reference/src/auth.ts:16-130`, `the reference/src/github-oauth.ts:48-276`, `the reference/src/views/verify.ts`, token helpers `the reference/src/crypto.ts:19-57` | `the reference/src/auth.ts` 154, `the reference/src/github-oauth.ts` 344, `the reference/src/views/verify.ts` 196 = 694 |
| Token model | Token is `hb_` plus 40 base62 characters. Stored as `sha256(pepper::token)`. Many tokens per user. `GET /api/tokens` lists them, `DELETE /api/tokens/:id` revokes one by a 12-hex id. | `the reference/src/crypto.ts:32-57`, `the reference/src/auth.ts:133-154`, `the reference/src/drops.ts:83-113`, `the reference/schema.sql:24-34` | about 120 |
| Versioning | `PUT` with new HTML makes version n+1. Slug and URL stay. Each version has a size and an optional `context` of up to 64 KB. Versions can be listed, read and deleted (not the last one). Cap 200. HTML for each version is a separate KV key `html:<slug>:v<n>`. | `the reference/src/drops.ts:314-443`, `552-648`; `the reference/schema.sql:61-76`; viewer `?v=N` at `the reference/src/index.ts:604-616` | about 255 |
| Metadata tags | Flat string-to-string map on a Drop: at most 10 keys, key regex, 64-char keys, 256-char values. Set on create, replaced whole on `PUT`/`PATCH`, filtered by `GET /api/drops?metadata.k=v` (AND). Never shown to Viewers. The "lookup then mutate" recipe is the stable-URL-per-PR trick. The server has no upsert endpoint on purpose. | `the reference/src/drops.ts:23-30,133-157,763-842`; filter `the reference/src/db.ts:135-148`; `the reference/migrations/0002-drop-metadata.sql`; rationale `the reference/CLAUDE.md:371-433` | about 145 plus 14 SQL |
| Passcode gate | Optional per-Drop passcode (at least 4 chars). Stored as PBKDF2-SHA-256, 100k iterations. A correct entry sets an HMAC-signed cookie, valid 24 hours and scoped to the slug path. The README itself calls it "a share gate, not encryption" (`the reference/README.md:267-270`). The HTML sits unencrypted in KV. | `the reference/src/crypto.ts:59-135`; `the reference/src/index.ts:651-698` (unlock and lock); `the reference/src/views/viewer.ts:298-371` (gate page); `the reference/src/drops.ts:678-725` | about 250 |
| Viewer page | `/p/:slug` renders a thin chrome bar (title, description, date, version picker, "context" toggle, raw link, a "content authored by @login's agent" note) above an `<iframe>` of `/p/:slug/raw`. Stale-version banner. Per-Drop Open Graph tags. | `the reference/src/views/viewer.ts:13-296`; `the reference/src/index.ts:588-649` | `the reference/src/views/viewer.ts` 393, route about 60 |
| Safety stylesheet | The server appends about 250 bytes of CSS to every served Drop's `<head>`, and a viewport meta if missing. It clamps horizontal overflow (`overflow-x:clip`, fluid media, scrolling `<pre>`). No opt-out. | `the reference/src/safety-net.ts:26-66`, applied at `the reference/src/index.ts:731` | 66 |
| Patterns catalog | Four markdown "design briefs" for agents (`pr-explainer`, `summary-roundup`, `plan-spec-explainer`, `session-explainer`, the last with an HTML skeleton), served as static files plus an index. The Worker adds no logic: agents read them before writing HTML. The skeleton is served as `text/plain` on purpose, so Cloudflare's HTML rewriting does not inject an analytics beacon into it (`the reference/src/patterns.ts:931-952`). | `the reference/src/index.ts:476-499`, `the reference/src/patterns.ts` (inline mirror), `the reference/patterns/` (source) | `the reference/src/patterns.ts` 956 (about 75 are code), `the reference/patterns/` 783 |
| Discoverability | `/api/onboard` (JSON by default, markdown on request), `/openapi.json`, `/.well-known/agent-card.json`, `/.well-known/agent-skills/index.json` (RFC draft, sha256 digest of the skill), the skill itself, `/.well-known/api-catalog` (RFC 9727), `/llms.txt`, `/robots.txt`, `/sitemap.xml`, `/.well-known/security.txt`, and a `Link:` header on `/`. | `the reference/src/index.ts:398-567`; `the reference/src/discoverability.ts`; `the reference/src/onboard.ts`; `the reference/src/skill.ts` | `the reference/src/discoverability.ts` 915, `the reference/src/onboard.ts` 737, `the reference/src/skill.ts` 622, routes about 170. Almost all of it is static text. |
| Agent skill text | A 587-line reference skill: protocol, quality floor (mobile at 360 px, semantic HTML, dark mode), chart advice, "brand sensing" from the working directory, and a "what the reference won't do" list. Kept in two copies that must be edited together. | `the reference/skills/the reference/SKILL.md`; `the reference/src/skill.ts:13-581` | 587 plus the mirror |
| Everything else | Landing page (319), shared CSS (1,496), chrome (147), OG images as SVG (139) and PNG via satori and resvg-wasm (450), fonts, Sentry loader and CSP, 404 page, Workers AI landing-to-markdown | `the reference/src/views/*`, `the reference/src/styles.ts`, `the reference/src/index.ts:215-393,163-193,752-821` | about 3,000 |
| Operator tools | `the reference/scripts/setup.mjs` (provision), `the reference/scripts/stats.mjs` and a local web dashboard (read-only SQL through `wrangler d1 execute`), `the reference/scripts/agent-e2e.sh` (bash end-to-end suite, 128 assertions), and a deploy workflow | `the reference/scripts/*`, `the reference/.github/workflows/deploy.yml` | about 2,000 |

Totals: `the reference/src/*.ts` and `the reference/src/views/*.ts` are 9,362 lines without the base64 font file (`the reference/src/fonts-data.ts`).

What the e2e script covers (`the reference/scripts/agent-e2e.sh:36-531`): discoverability, pattern catalog, onboarding, device-code auth, drop CRUD, metadata, passcode lifecycle, ownership with a second user, cleanup. It has no check for the iframe `sandbox`, security headers or cache headers.

### 2.2 Parts that exist only because the reference is a public multi-tenant service

These lose their purpose on one Instance, or need a smaller form. "Gone" means the reason for the code disappears. "Smaller" means a reduced version is still useful.

- **GitHub identity bound to accounts, one account per GitHub id.** The stated reason is anti-abuse: cycling tokens must not reset quotas (`the reference/src/github-oauth.ts:3-11`). On an Instance there is no free signup to abuse. Gone as an anti-abuse measure. The "human approves the agent" step is still the useful part, but who counts as an approved human is the Operator's allowlist, not "any GitHub account".
- **Per-user quotas**: 500 Drops per user, 500 writes per day, 60 writes per minute (`the reference/src/drops.ts:19-21,186-212,253-266`). Smaller. A single Instance still wants a guard against a runaway agent, but per-tenant fairness is gone.
- **Rate limiting of unauthenticated endpoints**: 10 per minute per IP on `/api/auth/start`, 60 per minute per poll token, 20 per minute per IP on the OAuth callback (`the reference/src/auth.ts:18,76`, `the reference/src/github-oauth.ts:194`). Smaller. Still needed anywhere an unauthenticated Publisher endpoint is exposed. A D1 counter is best-effort and single-region (`the reference/src/db.ts:206-245`, `the reference/README.md:273-275`).
- **Ownership by user** (`drop.user_id !== user.id` returns 403 on every route, `the reference/src/drops.ts:334`, `456`, `543`, `559`, `585`, `613`, `661`, `689`). Needs a decision. On an Instance, "who owns a Drop" may be a token, a person or the Instance.
- **Landing page, OG cards (SVG and PNG), `robots.txt`, `sitemap.xml`, `llms.txt`, `agent-card.json`, `security.txt`, the logos strip, the curated example Drops and a hard-coded showcase slug** (`the reference/src/views/landing.ts:24`). Marketing and crawl surface. Gone. The agent-facing parts (`/api/onboard`, OpenAPI, a skill file) still help Publishers on an Instance, but they are Publisher docs, not SEO.
- **View counter** (`the reference/src/index.ts:620`, `the reference/src/db.ts:167-175`). A D1 write on every view. Vanity metric on a public service. Optional.
- **"Content authored by @login's agent" with a link to github.com** (`the reference/src/views/viewer.ts:232-238`). Exists because a stranger's HTML is hosted under the reference's name (the comment says so). Gone or replaced.
- **Sentry, Cloudflare Web Analytics allowances in the CSP, a third-party font fetch for PNG cards** (`the reference/src/index.ts:81-93`, `the reference/src/views/og-png.ts:62-71`). Operator choices, not product.
- **Hard-coded identity of the original deployment.** `the reference/wrangler.toml` names one Cloudflare account, one KV namespace, one D1 database, one GitHub OAuth client id and the `the reference.dev` custom domains (`the reference/wrangler.toml:5,15-18,32,38-45`). `the reference/scripts/setup.mjs` tries to patch `REPLACE_WITH_D1_ID` and `REPLACE_WITH_KV_ID` placeholders (`the reference/scripts/setup.mjs:59-60`) that do not exist in the committed file, so on a fresh clone it prints "skip" and leaves the original ids in place. The deploy workflow only targets that account. A second deployer has to edit the file by hand. This is a gap the Instance's own setup path (a later ticket) has to close.
- **No Turnstile, no email, no dashboard by explicit rule** (`the reference/CLAUDE.md:56-63`). That rule is about keeping a public product simple. An Instance Operator may want the opposite (an allowlist editor, token revocation page). See "Operator tools" in the map's fog.

### 2.3 The CLI's `cloudflare` and `gh-pages` backends

Sizes: `the reference-cli/src/cf/` 521 lines plus `the reference-cli/src/backends/cloudflare.ts` 154; `the reference-cli/src/gh/` 447 plus `the reference-cli/src/backends/gh-pages.ts` 134. The CLI source is 4,220 lines in total, with 2,018 more in `the reference-cli/test/`.

**`cloudflare` (Cloudflare Pages Direct Upload plus Access).**

- *What it provisions.* `setup` creates a Pages project (default production branch `main`), lists the account's Access identity providers, and, only if given `--idp`, `--email-domain` or `--email`, creates a self-hosted Access application for `*.<project>.pages.dev` with 24-hour sessions and one "allow" policy (`the reference-cli/src/cf/setup.ts:24-96`, `the reference-cli/src/cf/access.ts:30-64`, `the reference-cli/src/cf/api.ts:166-173`).
- *What `publish` does.* It requires `--slug`, sanitises it into a hostname label, makes sure the project exists, uploads `/index.html` as the only asset, and creates a deployment with the slug as the "branch". The URL is `https://<slug>.<project subdomain>` (`the reference-cli/src/backends/cloudflare.ts:59-98`, `the reference-cli/src/cf/upload.ts:36-85`, `the reference-cli/src/cf/api.ts:109-152`). Cap 25 MB (`the reference-cli/src/backends/cloudflare.ts:18`). `list` and `delete` go through deployment aliases.
- *Where it falls short of an Instance:*
  1. No versions, no metadata, no `--upsert` (rejected at `the reference-cli/src/backends/metadata-guard.ts:9-33`), no titles in `list` (`the reference-cli/src/backends/cloudflare.ts:100-121`), no passcode, no viewer page. Each URL is the raw Drop.
  2. **`publish` never checks that Access covers the URL.** Its own note says "Access gates it if configured" (`the reference-cli/src/backends/cloudflare.ts:96`). If an Operator skips `setup` flags, the Drop is public. Cloudflare's docs say Pages URLs are public unless a policy is on (see Section 6).
  3. Every Publisher needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` with "Pages: edit, Access: edit" (`the reference-cli/src/backends/cloudflare.ts:32-33,39`). That is an account-level credential, not a scoped Publisher token. There is no per-Publisher revoke short of rotating that token.
  4. **`everyone` fallback.** If no include rules are given, `provisionAccessApp` adds an "everyone" allow rule (`the reference-cli/src/cf/access.ts:53-55`). `the reference-cli/src/cf/setup.ts:53-58` only calls it when include flags exist, and the function is not exported from `the reference-cli/src/index.ts:5-19`, so it is unreachable from the CLI today. It is the pattern the map's standing constraint forbids, and it would be one refactor away from reachable.
  5. The only include rule offered for `--idp` is `login_method` (`the reference-cli/src/cf/access.ts:44-46`). Cloudflare's policy page describes that selector as "checks the identity provider used at the time of login". My reading is that an `--idp`-only policy admits anyone who can sign in through that identity provider, which for GitHub is every GitHub user. That is an inference from the docs (Section 6), not something I tested.
  6. The Access hostname is `*.<project>.pages.dev` (`the reference-cli/src/cf/access.ts:34`). A wildcard hostname may not cover the bare `<project>.pages.dev`, and whether that hostname serves a Drop depends on Pages' production-branch handling. I did not check either (Section 6, item 3).
  7. The upload hashes assets with SHA-256, and a code comment admits Cloudflare's documented scheme is BLAKE3 and that SHA-256 "is accepted in practice" (`the reference-cli/src/cf/upload.ts:10-16`). I could not confirm that.
  8. The Pages deployment limit, the deletion of aliased deployments, and Pages' preview-versus-production behaviour for these deployments were not checked.

**`gh-pages` (GitHub Git Data API).**

- *What it provisions.* `setup` creates the `gh-pages` branch with an empty commit if missing, warns about existing `pr-*` directories, and checks whether the repo is public or the org plan lacks private Pages (`the reference-cli/src/gh/setup.ts:21-76`). Making Pages private is a manual step with no API (`the reference-cli/src/gh/setup.ts:68-73`).
- *What `publish` does.* One atomic commit per call, writing `<slug>/index.html` (`the reference-cli/src/backends/gh-pages.ts:73-87`, `the reference-cli/src/gh/tree.ts:1-15`). URL is `https://<owner>.github.io/<repo>/<slug>/`. Cap 25 MB.
- *Where it falls short:* the same missing features as above, plus: `list` only recognises slugs matching `^pr-\d+$` and fakes `updated_at` as "now" (`the reference-cli/src/backends/gh-pages.ts:89-99`). Each publish makes a Git commit and a Pages rebuild of about 60 seconds. Private Pages needs GitHub Enterprise Cloud or a paid plan, and on a public repo the page is public whatever the setting says (`the reference-cli/src/gh/setup.ts:54-63`). The token is `GITHUB_TOKEN` or `gh auth token` with write access to the repo (`the reference-cli/src/gh/auth.ts:1-40`).

Both backends are single-file hosting with a gate bolted on at the Host. Neither has the Publisher token flow, per-Drop versions or tags that the cloud backend has. They show that one HTML file per URL behind Access is feasible. They do not show an Instance.

### 2.4 Can the MIT CLI publish to another server?

Yes for everything except sign-in. Detail and exact requests are in section 4.

- The only setting is `api_url`, a string key in `./.the reference/config`, a TOML file read from the current directory only (`the reference-cli/src/config.ts:25-35,37-66`). There is no flag, no environment variable and no home-directory config for it (`grep` of `the reference-cli/src/` for `api_url`, `apiUrl`, `the reference_`: only `the reference_BACKEND`, `the reference_TOKEN`, `the reference_DEBUG`).
- `publish`, `list`, `update`, `delete` and `url` pass it through `makeBackend` (`the reference-cli/src/bin.ts:156-175`).
- `login` ignores it (`the reference-cli/src/bin.ts:457-469`, line 463).
- The patterns catalog base is also hard-coded to the reference.dev (`the reference-cli/src/patterns/paths.ts:32`), but `the reference patterns init|add|update --catalog <url>` overrides it.

### 2.5 Licence

See section 5.

## 3. Feature table: every user-visible or agent-visible feature of the server

"Public-only?" means it only makes sense for a public multi-tenant service. "Behind a gate" says what an Instance would have to change for the feature to work when Viewers must sign in. "Publisher" rows are the ones an agent or the CLI calls with a bearer token.

| Feature | What it does | Public-only? | Behind a sign-in gate |
|---|---|---|---|
| `GET /` landing (`the reference/src/index.ts:142-157`) | Marketing page, `Link:` header, 5 min edge cache. Embeds one real Drop through `/raw` in an iframe (`the reference/src/views/landing.ts:24`). | Yes | Replace with a small sign-in or status page, or drop it. The embedded showcase Drop would need a public Drop. |
| `GET /index.md` and `Accept: text/markdown` on `/` (`the reference/src/index.ts:161-205`) | Landing converted to markdown with Workers AI, cached in KV. | Yes | Drop. Needs a Workers AI binding for no Instance benefit. |
| `/style.css`, `/fonts/:name`, `/favicon.*`, `/sentry.js` (`the reference/src/index.ts:215-282`) | Static assets, long cache. | No | Unchanged for the gated pages. Must stay reachable by the sign-in page. |
| `GET /og.svg`, `/og.png` (`the reference/src/index.ts:295-323`) | Landing share card. | Yes | Drop. |
| `GET /p/:slug/og.svg`, `/og.png` (`the reference/src/index.ts:328-381`) | Per-Drop share card, no auth. The SVG hides the title when locked (`the reference/src/views/og-image.ts:58-78`), but **the PNG that the `og:image` tag points to always renders the title** and only adds a lock badge (`the reference/src/views/og-png.ts:209,266,289`). | Mostly | Unfurl bots cannot sign in. Either gate these as well, or serve a title-free card for gated Drops. |
| `GET /robots.txt`, `/sitemap.xml`, `/llms.txt` (`the reference/src/index.ts:398-421`) | Crawler files that invite every AI crawler in. | Yes | Drop, or `Disallow: /`. |
| `GET /.well-known/agent-card.json`, `/openapi.json`, `/.well-known/api-catalog` (`the reference/src/index.ts:422-429,505-533`) | Capability and API descriptions. Both the card and the OpenAPI doc declare `license: MIT` (`the reference/src/discoverability.ts:388,404`). | Partly | Keep OpenAPI and `/api/onboard` (Publisher docs). Drop the card and catalog. These pages describe the API, not Drops, so they can stay unauthenticated or be gated like any other page. Remove the licence claim unless true for our code. |
| `GET /.well-known/agent-skills/index.json` and `SKILL.md` (`the reference/src/index.ts:453-469`) | Skill discovery index with a sha256 digest. | No | Keep if we ship a Publisher skill. It needs the Instance's own URL, not a hard-coded host (the text is full of `the reference.dev`). |
| `GET /.well-known/patterns/index.json` and files (`the reference/src/index.ts:476-499`) | Pattern catalog. | No | Keep as is. These pages hold no Drops. The CLI can already be pointed at another catalog (`--catalog`). |
| `GET /.well-known/security.txt` (`the reference/src/index.ts:432-449`) | Vulnerability contact, hard-coded to the original project, with an expiry date. | Yes | Operator-supplied or dropped. |
| `GET /api/onboard` (`the reference/src/index.ts:545-567`) | JSON protocol descriptor, markdown on request. Described as a data document on purpose, so agents do not treat it as injected instructions. | No | Keep. It is the contract. Serve the Instance URL. |
| `POST /api/auth/start` (`the reference/src/auth.ts:16-63`) | Starts device-code sign-in. | No | Keep the shape. Rate limit stays (unauthenticated). Must not sit behind the Viewer gate. |
| `GET /api/auth/poll` (`the reference/src/auth.ts:69-130`) | Returns the token once. | No | Same as above. |
| `GET /verify`, `/auth/github/start`, `/auth/github/callback` (`the reference/src/index.ts:580-585`, `the reference/src/github-oauth.ts`) | Human approves the agent through GitHub. Dev mock when the client id is `dev-mock` (`the reference/src/github-oauth.ts:95-102,208-212`). | Partly | Replace with the Instance's sign-in (Cloudflare Access and/or GitHub per the map). Approval must check the Operator's allowlist, not just "a human signed in". The dev-mock path should not exist in an Instance, or be impossible to enable by accident. |
| `GET /api/me` (`the reference/src/drops.ts:49-78`) | Caller identity, token info, Drop count. | No | Keep. The CLI does not call it. |
| `GET /api/tokens`, `DELETE /api/tokens/:id` (`the reference/src/drops.ts:83-113`) | List and revoke own tokens. | No | Keep, and think about whether an Operator needs to revoke any token, not just one's own. |
| `POST /api/drops` (`the reference/src/drops.ts:183-308`) | Create Drop, version 1. Writes KV first, then D1 in a batch, so a failed batch leaves an orphan KV key. | No | Keep. Add the Drop's gate state (gated by default, per the map). |
| `GET /api/drops` (`the reference/src/drops.ts:118-178`) | Own Drops, paginated, sortable, metadata-filtered. | No | Keep. The CLI's `list` and `--upsert` depend on it. |
| `GET/PUT/PATCH/DELETE /api/drops/:slug` (`the reference/src/drops.ts:314-676`) | Read, new version, metadata-only edit, delete all. Delete removes KV keys one by one in a loop. | No | Keep. A hard delete conflicts with the workspace's soft-delete convention for application records. That is a decision for a later ticket. |
| `GET /api/drops/:slug/versions`, `/v/:n`, `DELETE /v/:n` (`the reference/src/drops.ts:552-648`) | Version list, read, delete. | No | Keep if versioning is kept. The CLI does not call them. |
| `POST /api/drops/:slug/passcode` (`the reference/src/drops.ts:682-725`) | Set, change or remove a passcode. | Mostly | Replace with a "make public" and "make gated" switch (map decision). Passcode semantics ("soft gate") do not fit the sign-in model. |
| `GET /p/:slug` viewer (`the reference/src/index.ts:588-649`) | Viewer chrome plus iframe. Edge-cacheable for unlocked Drops (`Cache-Control: public, max-age=60, s-maxage=900`, line 631). Bumps a view counter on each hit. | Partly | **Must be `private, no-store` for gated Drops and must check identity on every request.** It also puts the version's `context` text in the page body for whoever can open the Drop (`the reference/src/views/viewer.ts:239-244`). That is acceptable for signed-in Viewers, but the schema comment suggests "humans must request it explicitly" (`the reference/schema.sql:61-64`). |
| `?v=N` on viewer and raw (`the reference/src/index.ts:604-616,718-724`) | Pin a version. | No | Unchanged. |
| `POST /p/:slug/unlock`, `/lock` (`the reference/src/index.ts:651-698`) | Passcode form and re-lock. The unlock endpoint has no rate limit. | Yes | Gone. |
| `GET /p/:slug/raw` (`the reference/src/index.ts:700-749`) | The Drop's HTML with the safety CSS. Checks the passcode cookie, otherwise redirects to the gate. Sets `CSP: frame-ancestors 'self'; base-uri 'none'; form-action 'self' https:`. No `sandbox` directive, no `script-src`, no `connect-src`. Public cache `s-maxage=300` when unlocked. Opened directly (the viewer's "raw" link is `target="_blank"`, `the reference/src/views/viewer.ts:228`) it runs in the service's own origin. | No | **The most important gate item.** It needs the same identity check as the viewer. It needs `private, no-store`. And its HTML must not run with the Instance's origin and a Viewer session cookie. Options are a `Content-Security-Policy: sandbox` response header, a separate origin for Drop bodies, or no top-level raw route. |
| Viewer `<iframe sandbox="allow-scripts allow-forms allow-modals allow-downloads">` (`the reference/src/views/viewer.ts:245-249`) | Confirmed. There is no `allow-same-origin`, so inside the viewer a Drop's scripts run in an opaque origin without the Instance's cookies or storage. No popups, no top navigation. | No | Keep as is. It protects only the in-viewer case. See `raw` above. |
| Safety stylesheet (`the reference/src/safety-net.ts:26-66`) | Layout clamp injected into every Drop. | No | Optional and cheap. It changes Drop bytes, so it is a product choice. |
| Global security headers (`the reference/src/index.ts:61-118`) | HSTS, nosniff, referrer policy, permissions policy, a CSP on HTML pages and `default-src 'none'` on JSON. | No | Keep. The map's rule is that a header counts only when a test sees it on the served response. The reference's e2e does not check headers. |
| `TOKEN_PEPPER` check (`the reference/src/index.ts:128-139`) | Returns 503 `server_misconfigured` if the secret is missing or under 32 characters. | No | Keep the idea. Fail closed on missing secrets. |
| 404 page, `Cache-Control` and `Vary` choices | Custom page. | No | A 404 for a Drop the Viewer may not see must look the same as 404 for a Drop that does not exist, or the gate leaks which slugs exist. The reference returns 404 only for unknown slugs and the passcode page for known locked ones (title shown, `the reference/src/views/viewer.ts:327`). |
| Limits (`the reference/src/drops.ts:15-21,27-33`) | 2 MB HTML, 200-char title, 500-char description, 64 KB context, 200 versions per Drop, 500 Drops per user, page size 200, 10 metadata keys. Slugs are 9 random base62 chars (about 53 bits) (`the reference/src/slug.ts:6`). | Partly | Size and slug limits are worth keeping. Per-user counts need a new meaning. The slug is also the only secret on a public Drop. Behind a gate it is only an address. |
| Rate limits (`the reference/src/auth.ts:18,76`, `the reference/src/drops.ts:186-212,320`, `the reference/src/github-oauth.ts:194`) | See 2.2. Write limit key is the user, not the token. The daily cap counts only `POST`, not `PUT` or `PATCH` (`PATCH` has no write limit at all). | Partly | Smaller form. |
| `the reference/scripts/setup.mjs`, `the reference/scripts/stats.mjs`, `the reference/scripts/dashboard/` | Provision D1 and KV, text stats, local read-only web dashboard (`the reference/CLAUDE.md:726-748` says it must never be deployed). | No | Material for the "Operator tools" and setup tickets. Not product. |
| `.github/workflows/deploy.yml` | Preview version per PR, production on merge. GitHub Actions billing is blocked for this account (map Notes), so not usable as is. | No | Not applicable. |

## 4. Wire compatibility with the MIT CLI

Written from `the reference-cli` 0.6.0 so that a server can be built from this section alone. Base URL is `api_url` with any trailing `/` removed, default `https://the reference.dev` (`the reference-cli/src/backends/cloud.ts:27`, `the reference-cli/src/cloud/api.ts:118`).

### 4.1 Common to every request

- Headers sent: `user-agent: @the reference/cli/0.1.0 (node <ver>; <platform> <arch>[; agent <name>])`, `authorization: Bearer <token>` (not on the two login calls), `content-type: application/json` only when there is a body (`the reference-cli/src/cloud/api.ts:121-129`, `the reference-cli/src/cloud/auth.ts:163-171`, `the reference-cli/src/useragent.ts:22-25`). The version in the User-Agent is a stale hard-coded `0.1.0` while the package is 0.6.0 (`the reference-cli/src/useragent.ts:13`, `the reference-cli/package.json:3`). No `Accept` header, no custom headers, no cookie handling.
- The server repo's own notes (`the reference/CLAUDE.md:808-813`) say Cloudflare rejects `/api/*` requests with no `User-Agent`. The CLI always sends one.
- No retry, no backoff and no `Retry-After` handling (`grep -i retry` in `the reference-cli/src/` finds nothing outside patterns). A 429 becomes exit code 5 and the CLI stops. No redirect handling is configured in the source I read (`grep -i redirect` finds only a help string), so, going by the source alone, a 302 to a sign-in page is not followed. I did not run undici to confirm its default.
- **Token format.** At use time the CLI requires `^hb_[A-Za-z0-9_-]{16,}$` (`the reference-cli/src/cloud/auth.ts:18,52-58`). Anything else fails locally with `invalid_token`, exit 2. Token sources, in order: `./.the reference/token`, `$the reference_TOKEN`, `~/.config/the reference/token` (`the reference-cli/src/cloud/auth.ts:26-39`). The reference server accepts only `hb_[A-Za-z0-9]+` (`the reference/src/auth.ts:135`), which is narrower, so server tokens must use letters and digits only to satisfy both.
- **Local limits applied before sending.** HTML file at most 2 MiB (`the reference-cli/src/backends/cloud.ts:18`, `the reference-cli/src/load.ts:53-59`), at most 10 metadata keys (`the reference-cli/src/cloud/metadata.ts:9,40-49`). An Instance cannot allow bigger Drops through this CLI without a CLI change.
- **Response handling.** Body is read as text. Non-empty body that is not JSON gives `network_error` (exit 8). A 204 on `DELETE` is expected, but any empty 2xx body also works (`the reference-cli/src/cloud/api.ts:134-160`).

### 4.2 Error shape

For any status 400 or above the CLI reads `{ "error": { "code": string, "message": string, "details"?: object } }`. The `code` becomes the CLI error code and decides the exit code. `message` is shown. `details` is merged with `status` and printed. A missing code becomes `network_error` (`the reference-cli/src/cloud/api.ts:162-168`). Exit codes (`the reference-cli/src/errors.ts:75-123`):

| Exit | Codes |
|---|---|
| 2 | `unauthorized`, `invalid_token`, `auth_required`, `token_required` |
| 3 | `forbidden` |
| 4 | `not_found`, `version_not_found` |
| 5 | `rate_limited`, `quota_exceeded`, `daily_quota_exceeded`, `version_limit_reached` |
| 6 | `html_too_large`, `context_too_large`, `title_too_long`, `description_too_long` |
| 7 | `invalid_arg`, `invalid_slug`, `invalid_json`, `html_required`, `title_required`, `passcode_required`, `passcode_too_short`, `metadata_only_on_patch` |
| 8 | `network_error`, `server_misconfigured` |
| 1 | any other string |

The reference server's full list is at `the reference/src/errors.ts:12-37` and is the same 25 names as the CLI's `WorkerErrorCode` (`the reference-cli/src/errors.ts:9-34`). The two files are kept in sync by hand (`the reference/CLAUDE.md:18-25`).

### 4.3 Device-code login (`the reference login`)

1. `POST {base}/api/auth/start`, body `{"label":"@the reference/cli"}`, no `Authorization` (`the reference-cli/src/cloud/auth.ts:108-114`, `the reference-cli/src/backends/cloud.ts:177`). Expected 2xx JSON:
   `{ "code": string, "verification_url": string, "poll_token": string, "expires_in": number (seconds), "poll_interval": number (seconds) }`. Server reference: `the reference/src/auth.ts:56-62`.
2. The CLI prints `verification_url` and `code` to stderr. It tries to open the URL in a browser only if the scheme is `https:` (`the reference-cli/src/cloud/auth.ts:198-219`).
3. Loop until `Date.now()` passes `expires_in` seconds: sleep `max(1, poll_interval)` seconds, then `GET {base}/api/auth/poll?token=<poll_token>` with no `Authorization` (`the reference-cli/src/cloud/auth.ts:128-139`). Expected JSON `{ "status": "pending"|"verified"|"expired"|"claimed"|"not_found", "api_token"?: string, "user_id"?: string }`.
   - `pending`: keep polling.
   - `verified` with `api_token`: write the token plus a newline to `./.the reference/token` (directory `0700`, file `0600`) and stop (`the reference-cli/src/cloud/auth.ts:71-91,140-145`).
   - Any other status, or `verified` without a token: fail with `auth_required`, exit 2.
   - Timeout: `auth_required`, exit 2.
4. The reference server returns HTTP 404 with an error envelope for an unknown poll token rather than a `not_found` status (`the reference/src/auth.ts:101-102`), although its docs and the CLI's type list `not_found` as a status (`the reference/src/onboard.ts` poll description, `the reference-cli/src/cloud/auth.ts:134`). The CLI handles either, because a 404 goes through the error path with code `not_found`.
5. A network failure during login is not wrapped. The `undici` error escapes `jsonRequest`, and the CLI prints a raw message with exit 1 (`the reference-cli/src/cloud/auth.ts:163`, no `try`; compare `the reference-cli/src/cloud/api.ts:120-132`).

### 4.4 Drop operations

All with `Authorization: Bearer <token>`. `:slug` is URL-encoded by the CLI.

| CLI command | Request | Body fields | Fields the CLI reads from a 2xx response |
|---|---|---|---|
| `publish <file>` | `POST /api/drops` | `html` (file contents), `title` (`--title` or filename without extension, `"untitled"` if empty), `description?`, `metadata?` (object). The CLI type allows `passcode` and `context`, but no command sets them. | `url`, `slug` |
| `publish <file> --slug S` | `PUT /api/drops/S` | `html`, `title`, `description?`, `metadata?` | `url`, `slug` |
| `publish <file> --upsert --metadata k=v...` | 1. `GET /api/drops?pageSize=1&metadata.k=v...` 2. match: `PUT /api/drops/<data[0].slug>` with `html`, `title`, `description?`, `metadata`. No match: `POST /api/drops` as above. | as above | step 1: `data[]` (uses `data.length`, `data[0].slug`). Then `url`, `slug`. The CLI reports `matched: true` when step 2 was a PUT. |
| `update S --file F` | `PUT /api/drops/S` | `html`, `title?`, `description?`, `metadata?` (`{}` when `--clear-metadata`) | `url`, `slug` |
| `update S` without `--file` | `PATCH /api/drops/S` | any of `title`, `description`, `metadata` | `url`, `slug` |
| `list` | `GET /api/drops?page=N&pageSize=100&sortBy=updated_at[&metadata.k=v...]`, repeated from page 1 while `page < pagination.total_pages` | none | `data[]` with `slug`, `url`, `updated_at` (anything `new Date()` accepts: a number in milliseconds is what the reference sends), optional `title`, optional `metadata`. And `pagination.total_pages`. |
| `delete S` | `DELETE /api/drops/S` | none | nothing. A 204 is expected. |
| `url S` | `GET /api/drops/S` | none | `url` |

Source: `the reference-cli/src/backends/cloud.ts:45-174`, `the reference-cli/src/cloud/api.ts:42-110`.

Metadata filter keys are sent as the literal query-parameter name `metadata.<key>` (`the reference-cli/src/cloud/api.ts:69-71`).

The reference server's Drop object is `{slug, title, description, url, raw_url, locked, latest_version, view_count, metadata, created_at, updated_at}` (`the reference/src/drops.ts:746-761`). The CLI only requires `slug`, `url`, and for lists `updated_at`. Its TypeScript type also lists the other fields, but nothing in the CLI reads them. The `url` should be the address a Viewer opens, since that is what the CLI prints.

What the CLI never calls: `/api/me`, `/api/tokens`, `/api/drops/:slug/versions`, `/api/drops/:slug/v/:n`, `/api/drops/:slug/passcode`, `/api/onboard`. An Instance does not need them to be CLI-compatible. The reference skill and docs do tell agents to use some of them.

### 4.5 Pointing the CLI at an Instance

1. In the Publisher's project directory, create `./.the reference/config` (TOML):
   `api_url = "https://<instance-host>"`. The default backend is already `cloud` (`the reference-cli/src/config.ts:99`).
2. `the reference login` will **not** use it (`the reference-cli/src/bin.ts:463`). Mint a token from the Instance by another route and store it in `./.the reference/token`, `$the reference_TOKEN` or `~/.config/the reference/token`, in `hb_` plus 16 or more letters, digits, `_` or `-`.
3. Then `publish`, `list`, `update`, `delete` and `url` go to the Instance.
4. For `login` to work, the options are: fork the MIT CLI and pass `cfg.api_url` at `the reference-cli/src/bin.ts:463` (a one-line change in a repo we may copy under its licence), or have the Instance's own client do the device-code exchange.
5. `the reference patterns init|add|update` read the catalog from the reference.dev unless `--catalog https://<instance-host>/.well-known/patterns` is passed (`the reference-cli/src/patterns/paths.ts:32`).

An Instance behind Cloudflare Access cannot be reached by this CLI unless the API paths bypass Access, because the CLI cannot present service-token headers (4.1). Whether that is acceptable is a design decision for the sign-in tickets.

## 5. Licence

Facts only. This is not legal advice.

| | `the reference` (server) | `the reference-cli` |
|---|---|---|
| LICENSE file | None. `git ls-files` lists no licence-like file. GitHub's contents API shows none. | `LICENSE`: MIT, "Copyright (c) 2026 Utkarsh Sengar" (`the reference-cli/LICENSE:1-3`) |
| `package.json` | No `license` field. `"private": true` (`the reference/package.json:4`). Not published to npm as far as the file says. | `"license": "MIT"` (`the reference-cli/package.json:43`). `files` includes `LICENSE` (`:15-19`). |
| README | "## License / MIT." (`the reference/README.md:297-299`) | "MIT. See [LICENSE](./LICENSE)." (`the reference-cli/README.md:171-173`) |
| Other statements | The agent card says `license: "MIT"` (`the reference/src/discoverability.ts:388`). The OpenAPI info says `license: { name: "MIT" }` (`the reference/src/discoverability.ts:404`). `llms.txt` says "Open source" (`the reference/src/discoverability.ts:156`). `the reference/DESIGN.md:746-751` states the repo has no LICENSE and no `license` field, and calls adding one or dropping the claim "a decision, not a copy edit". | none beyond the above |
| GitHub's licence detection | `null` | `MIT` (SPDX `MIT`) |
| Third-party material inside | Geist and Geist Mono fonts under the SIL Open Font Licence 1.1, as noted in `the reference/src/fonts.ts:14`. Woff2 files in `the reference/assets/fonts/`, base64 copy in `the reference/src/fonts-data.ts`. | n/a |

What the MIT text in the CLI says (`the reference-cli/LICENSE:5-21`): anyone may use, copy, modify, merge, publish, distribute, sublicense and sell copies, free of charge. The copyright notice and permission notice must be included in all copies or substantial portions. The software comes with no warranty. It does not grant any rights to the name "the reference" (the text is silent on trademarks).

What the server repo gives: no licence text and no copyright holder statement exist in the repo. The README, agent card and OpenAPI document say "MIT" with no grant text. Whether that line alone amounts to a licence is a legal question I did not answer. The map's Notes already say to take ideas from it and write our own code, and nothing found here contradicts that. The author's own `the reference/DESIGN.md` treats the point as open.

Practical notes, as facts:

- The CLI's four vendored patterns (`the reference-cli/patterns/`) sit inside the MIT repo. Three of the four `.md` files differ from the server's copies (`pr-explainer`, `summary-roundup`, `plan-spec-explainer`; `the reference-cli/patterns/session-explainer.md` and its template are identical). The server's copy is the one without a licence file. I did not diff them line by line, so I cannot say how far they differ.
- The server's Geist fonts and the CLI's code each carry their own terms. Copying nothing from the server avoids both questions.
- Using the CLI unmodified, or modified with the MIT notice kept, is covered by its licence. The `the reference` name, the `@the reference/cli` npm name and the the reference.dev domain are the original author's. The MIT text does not address them.

## 6. Not confirmed

Where I looked is in brackets.

1. **Behaviour was read, not run.** The constraints forbade running either codebase. So the wire section is derived from source, and its unit tests (`the reference-cli/test/cloud.test.ts:37-149`, mocked HTTP) rather than observed traffic. I did not check what the live the reference.dev returns today.
2. **Whether the CLI follows redirects.** The source configures none. I did not read undici's current default.
3. **Cloudflare Access details** (`the reference-cli/src/cf/access.ts`, Cloudflare docs fetched 2026-10-05):
   - The policy page describes "Login Methods" as "checks the identity provider used at the time of login". Its own misconfiguration example says a Login Methods rule on One-time PIN lets in all valid email addresses. That a GitHub-only Login Methods rule admits every GitHub user is my inference from that example, not a stated fact. (https://developers.cloudflare.com/cloudflare-one/policies/access/)
   - The Pages preview-deployments page says the built-in Access toggle covers preview deployments only, not the `*.pages.dev` domain or custom domains, and points to "Known issues" for the rest. I did not follow that link. (https://developers.cloudflare.com/pages/configuration/preview-deployments/)
   - Whether `*.<project>.pages.dev` covers the project's bare `<project>.pages.dev` hostname. Not checked.
4. **Pages direct upload with SHA-256 hashes.** The CLI's own comment says it deviates from the documented BLAKE3 scheme (`the reference-cli/src/cf/upload.ts:10-16`). Not tested, so I cannot say the `cloudflare` backend works end to end.
5. **History.** Both clones are shallow with one commit each, so I cannot say whether the server ever had a LICENSE file. GitHub's current metadata says none. I did not check the npm registry entry for `@the reference/cli`, and the server is not published there.
6. **The abuse-report claim.** `the reference/README.md:64-66` says the e2e script covers "abuse-report", and `the reference/CLAUDE.md:32` lists a `reports` table. I found no report route in `the reference/src/`, no such table in `the reference/schema.sql` or `the reference/migrations/`, and no match in `the reference/scripts/agent-e2e.sh`. Either it was removed or the docs are stale.
7. **Other places where the reference's prose disagrees with its code**, in case anyone reuses the prose:
   - Slug length: the skill says 7 characters (`the reference/skills/the reference/SKILL.md:462`), the code makes 9 and accepts 6 to 12 (`the reference/src/slug.ts:6,15`).
   - Write limit "per token" (`the reference/README.md:218`, `the reference/CLAUDE.md:946`) is per user in code (`the reference/src/drops.ts:186`).
   - The 500-per-day cap counts creations only (`the reference/src/drops.ts:197-212`).
   - `llms.txt` shows errors as `{ "error": "<code>" }` and lists a code `expired_code` that does not exist (`the reference/src/discoverability.ts:150-152`).
   - The CLI README says login leaves the token in `~/.config/the reference/token` (`the reference-cli/README.md:84`), but login writes only `./.the reference/token` (`the reference-cli/src/cloud/auth.ts:71-91`).
8. **Parts I skimmed or did not read in full**, so claims about them are limited to what is cited:
   - Server: `the reference/DESIGN.md` (read the section list and section 13 only), `the reference/src/styles.ts`, `the reference/src/views/landing.ts`, `the reference/src/views/chrome.ts`, `the reference/src/views/og-png.ts` beyond the font and title parts, the long prose inside `the reference/src/onboard.ts` (lines 330-737), `the reference/src/discoverability.ts` and `the reference/src/skill.ts`, the four pattern files in `the reference/patterns/`, the two landing design specs in `the reference/docs/superpowers/specs/` (I read the head of the "recent drops feed" one: it is a tabled plan and no feed route exists in `the reference/src/`), `the reference/scripts/stats.mjs`, `the reference/scripts/dashboard/*` and `the reference/scripts/agent-e2e.sh` beyond headers.
   - CLI: `the reference-cli/src/gh/tree.ts` after line 60, `the reference-cli/src/gh/octokit.ts`, `the reference-cli/src/patterns/*` beyond `paths.ts`, `init.ts` and the head of `catalog.ts` (all under `the reference-cli/src/patterns/`), the examples other than the head of `the reference-cli/examples/cloud-publish-workflow.yml`, and the tests beyond `the reference-cli/test/cloud.test.ts`.
9. **Not verified by anyone**: whether the reference's production deployment matches this repo. The deploy workflow says it does (`the reference/.github/workflows/deploy.yml`), but I did not call the service.

## 7. Notes for other tickets on the map

These are observations for the owner, not decisions.

- **#11 (keep, drop or add).** The CLI's cloud backend contract in section 4 is small enough to adopt whole. If we keep wire compatibility, the Instance needs only the 8 requests, the `hb_` token shape and the error envelope. Versions, tags and passcode are server-side extras the CLI does not need, except that `--upsert` needs metadata filtering on `GET /api/drops`.
- **Sign-in and gate tickets.** The Publisher API and the Viewer gate use different credentials and must not share one Access policy. `/p/:slug/raw` and the share-card routes need the same gate as the viewer. Section 3 lists the cache, sandbox and title-leak points.
- **Setup ticket.** The reference setup is not reusable as is (hard-coded ids, a placeholder patcher that no longer matches, manual GitHub OAuth app creation). The CLI's Access provisioning shows the API calls and also what to avoid (an `everyone` fallback, a `login_method`-only policy).
- **Open-the-repo ticket.** Credit and licence: the CLI is MIT and may be copied with its notice. The map's Notes say not to copy the server. The agent card and OpenAPI document of the reference both state a licence the server repo does not ship.
