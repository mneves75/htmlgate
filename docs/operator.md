# Running an Instance

This guide is for the Operator: the person who sets up an Instance in a Cloudflare account they control. In 0.1, the Operator is also the only Author.

## What setup changes on your account

`pnpm run setup` reads `instance.json` and creates or updates four things, all named after your Instance:

| Resource | Name | Notes |
|---|---|---|
| D1 database | `<name>-db` | Holds Shares, Versions' metadata and tokens. Migrations are applied on every run. |
| R2 bucket | `<name>-bodies` | Holds each Version's body, one private object per Version: a page's HTML or a site's zip. It needs the account's R2 subscription. |
| Worker | `<name>` | Reachable at `domain` if you set one, and only there: its workers.dev hostname is off. Without a `domain`, reachable at `https://<name>.<subdomain>.workers.dev`. Preview URLs are off. Workers Logs keep only the Worker's unexpected errors: per-request invocation logs and traces are off (see [privacy.md](privacy.md)). It holds one secret, `TICKET_KEY`, and runs an hourly Cron Trigger that purges expired Shares. |
| Access application | `htmlgate: <name>` | Gates the Worker on every hostname it answers at, and its Version URLs. Leaves `/api/*`, `/p/*` and `/f/*` to the Worker, so a Public Share's link preview and its image (`/p/<slug>/card.jpg`) load without a session. |
| Access policy | `htmlgate: <name> allowlist` | Allows the emails in `instance.json`, one by one. |
| Access application (robots) | `htmlgate: <name> robots` | Opens `/robots.txt` to everyone with a `bypass` policy. A crawler reads a robots policy before anything else, and X refuses to build a link card for a site whose `robots.txt` it cannot fetch. Setup creates it, and refuses to repoint an application of that name at another host. |

It never changes other Workers, other Access applications, your login methods or your Zero Trust settings. It refuses a `domain` that another Worker or a DNS record already uses (see below). It refuses to continue if a Worker with your Instance's name already exists and is not an Instance.

Before any remote write, an existing Worker's ownership must be unambiguous: the same-name Access application must point only to that Worker, and every traffic-serving version must bind `DB` to this Instance's database UUID and `BODIES` to its bucket. Matching a database name alone is insufficient. Setup reads every Worker and Access application page and refuses missing, malformed or conflicting evidence. Existing Instances without a marker remain valid through their Access association and bindings. If no Access application exists, only an interrupted closed bootstrap with the matching `HTMLGATE_INSTANCE` marker and no gate settings can resume; a marker never overrides a mismatched Access destination.

## instance.json

```json
{ "name": "htmlgate", "authorEmail": "you@example.com", "allowlist": ["colleague@example.com"], "domain": "html.example.com", "language": "en", "expiryDays": 30 }
```

- `name` is 1 to 53 lowercase letters, digits or `-`. It sets the hostname.
- `authorEmail` is you. You are always on the Allowlist, and only you see the token page.
- `allowlist` names everyone else who may open Gated Shares. Each person can open every Gated Share whose link they have, so add only people you trust with all of them. An empty list admits only you. There is no "everyone at a domain" rule.
- `domain` is optional: a hostname in a zone on the same Cloudflare account. Setup attaches it to the Worker as a Custom Domain, which creates its DNS record and certificate. The Access application gates the Worker itself, so it covers this hostname too. Before it writes anything, setup refuses the domain unless an active zone on the account covers it, no other Worker serves it, and every DNS record with that exact name is this Worker's own. Wrangler runs without prompts here and would otherwise replace such a record or move the domain without asking. A wildcard record such as `*.example.com` does not block it: the Custom Domain takes over that one hostname, including from a Worker Route that reached it only through the wildcard. Setup cannot see Worker Routes. Taking `domain` out later does not detach it: remove the Custom Domain under the Worker's Settings, Domains & Routes in the dashboard.
- `language` is optional: `"en"` (the default) or `"pt-BR"`. It sets the language of the Instance's own pages (home, tokens, the Share viewer, not-found) for everyone who opens them. The API, the CLI, Cloudflare's sign-in page and the JSON errors an Instance answers with when it is misconfigured or fails stay in English. Any other value makes the Instance refuse everything, like any other malformed setting. Run setup again to change it.

- `expiryDays` is optional: how many days a Share lives after its latest publish, unless a Publisher sets a date. 30 when left out; 0 means Shares never expire on their own. A whole number up to 3650. Changing it applies to each Share from its next publish.

The file is git-ignored. Keep it out of commits: it holds email addresses.

## The order setup follows

On the first run:

0. It requires Git's top-level directory to be this project's directory, comparing canonical paths, then stops if `src`, `site`, `migrations`, `packages/cli/src` or `scripts` hold uncommitted changes: a deploy ships the working tree, so commit or restore them first. Use a Git clone or registered worktree; a downloaded copy inside another checkout is refused. Symlink aliases of the checkout work. The landing's `site:deploy` uses the same guard.
1. It checks that Wrangler and `cf` act on one and the same account, and stops before writing anything if not. Wrangler deploys the Worker and `cf` sets up its Access application, so on two accounts the Worker would have no gate of its own. With several accounts on Wrangler's login, set `CLOUDFLARE_ACCOUNT_ID`. A `cf` login must reach only that one account; use a profile or token scoped to it (`cf auth create`, `cf auth activate`).
2. If you set `domain`, it checks that the domain is free or already this Instance's, and stops before writing anything if not.
3. It checks existing Instance ownership and discovers the database and R2 bucket before creating any resource. Bucket discovery follows ascending names until an empty page; malformed or non-advancing names, or a listing still returning buckets after 1,000 pages, stop setup before writes. A reused bucket must explicitly have its managed public domain disabled and a custom-domain list with every entry disabled. Unknown or public state stops setup before any resource creation; setup does not change bucket policies. After safety discovery, it creates any missing database and bucket, then applies migrations.
4. It deploys the Worker with workers.dev off, no custom domain and only its Instance marker. Without gate settings it still refuses every gated request.
5. It creates the Worker's `TICKET_KEY` secret: 32 random bytes, handed to Wrangler on stdin, never printed or written to disk. Later runs keep it.
6. It creates the Access application for that Worker.
7. It deploys again, reachable now, with the settings: the Access team URL, the application's audience tag, your email, the Allowlist and `expiryDays`. With a `domain`, the Worker answers there and its workers.dev hostname stays off; without one, workers.dev is turned on.
8. On that hostname, it checks that `/` sends a signed-out visitor to this Instance's own Access application, that `/api/shares` asks for a token, and that `/f/` reaches the Worker rather than Access.

If the account has no R2 subscription, setup stops at the bucket and says where to add it.

On later runs it updates the policy and deploys in place. A run that applies a new migration is the exception: setup migrates the database first and deploys last, so for about a minute the Instance can answer with errors. If setup stops in between, run it again: a migration is applied once, and the deploy then completes.

Access can take a few seconds to apply. If the last check fails, run setup again. Meanwhile the Worker refuses every gated request on its own: it trusts only a signed Access token whose audience matches.

## Several Instances from one checkout

Setup writes the Worker's config to `.instance/<name>.wrangler.jsonc`, one file per Instance. Give the Instance its own instance file and pass it everywhere:

```sh
pnpm run setup --config .instance/production.json
pnpm run token list --config .instance/production.json
```

The token command refuses an Instance whose config does not exist yet: run setup for it first.

## Day to day

| Task | How |
|---|---|
| Add or remove a person | Edit `allowlist`, run `pnpm run setup`. A removed person loses access on their next request. |
| Change the pages' language | Set `language` to `"en"` or `"pt-BR"`, run `pnpm run setup`. |
| See what is published | Your home page at `/` lists your 50 most recently updated Shares, with each one's state, latest Version and last Publisher; `htmlgate list` lists them all. |
| Create a token | The token page at `/tokens`, or `pnpm run token create <name>`. It is shown once. |
| List or revoke tokens | The token page, `pnpm run token list` / `revoke <id>`, or any Publisher with `htmlgate tokens list` / `revoke <id>`. |
| Update to a new version | Read the CHANGELOG entry, then `git pull`, `pnpm install`, `pnpm run build:cli` (or `pnpm run cli:install` for a Homebrew install), `pnpm run setup`. Migrations keep your Shares. The CLI and the Instance change together: an older CLI may get not-found answers from a newer Instance. After every production deploy, run `pnpm run cli:install` on the owner's machine and report the version it printed. |
| See how often your Shares are opened | `/metrics` on the Instance (Author only) lists your 500 most recently updated Shares with their views over the last 30 days and all time, and a button to open each; the home's board shows the 30-day count on each row. The Instance counts page navigations server-side, one row per Share and UTC day, with no cookie and no visitor identity, so a count says how often, never by whom. The landing's own page counts are a separate thing, in Workers Analytics Engine (`cf analytics_engine sql query`, README). |
| See what a leaked token did | `htmlgate list --public`, and `changed_by` on each Share. |
| Share a link that shows a preview | A **Public** Share's link (`/p/<slug>`, what `htmlgate public` and `htmlgate publish` print) unfurls as a large card: the Share's title, its description and the Instance's poster at `/p/<slug>/card.jpg`. A **Gated** Share's link (`/s/<slug>`) never previews, because it sits behind the gate; making the Share public is the switch. `/robots.txt` allows crawlers to read `/p/` and nothing else, which is what makes a card possible on X; the pages carry `noindex`, so readable is not listed. The description the Publisher wrote goes to the card; the page itself shows the title and the HTML, not the description. X caches a card per URL, so an already-posted link can keep its old (image-less) card until that cache expires; re-gating a Share does not clear that cache either. To make a crawler fetch it again, change a query parameter **other than `v`** (`?x=2`, not `?v=2`): `v` selects a Version, and an unknown Version answers not-found. |
| Change how long Shares live | Edit `expiryDays`, run `pnpm run setup`. A Share picks up the new default at its next publish. |
| End every open ticket | `pnpm run setup --rotate-ticket-key`. Viewers reload a Gated site's page to get a new one. |

## Remove an Instance

Delete, in this order:

1. The Worker, so nothing answers at its hostname.
2. The Access application.
3. The bucket and the database, which deletes every Share.

If you set `domain`, check under Workers & Pages, Domains that the Custom Domain went with the Worker.

Deleting the application first would leave the Worker without its gate for a moment. It would still refuse gated requests on its own, but there is no reason to have that moment.

```sh
pnpm exec wrangler delete --name <name>
cf zero-trust access applications list          # find "htmlgate: <name>", note its id
cf zero-trust access applications delete <id> --force
pnpm exec wrangler r2 bucket delete <name>-bodies   # it must be empty first
pnpm exec wrangler d1 delete <name>-db
```

`cf ... delete` without `--force` prints "Aborted." and still exits 0. Check that the resource is gone.

## HTTPS and the sign-in cookie

- The Instance never serves an API request or a change over plain http: it answers `403 https_required`, and sends a page visit to the same address on https. Every answer carries `Strict-Transport-Security: max-age=31536000`, without `includeSubDomains`, because your domain may have other hosts that are not https.
- On a Custom Domain, also turn on **Always Use HTTPS** for the zone (SSL/TLS, Edge Certificates). Cloudflare then redirects plain http before the Worker runs, so `/api/*` over http gets a 301 instead of the Worker's 403. Either way, nothing is served in clear. HSTS for the whole zone, and preloading, are your call: they bind every host on the domain.
- Setup sets the Access application's cookie to `SameSite=Lax` and `HttpOnly`. Another site cannot make a signed-in browser send it with a form or a background request, and no script can read it. Following a link to a Share from email or chat still works, because Lax cookies go with top-level navigation. After an update that changes these settings, sign in once on the Instance and open `/tokens` and a Gated Share to confirm.

## Costs and abuse

0.1 limits only changes: 60 a minute per token. Everything else is a Worker request, and a Public Share's body, or one file of a site, also costs one D1 query and one R2 read. Anyone with a public link can make those requests. A limit inside the Worker would not stop the Worker requests from being billed, so put the guard at Cloudflare:

- Add a usage-based billing notification for the account (Notifications), so a surge shows up before the invoice does.
- On a Custom Domain, add a rate limiting rule for `/p/*`, `/f/*` and `/api/*` (Security, WAF, Rate limiting rules). It runs before the Worker, and an Instance with a `domain` answers nowhere else, so no request goes around it. An Instance without a `domain` answers only on workers.dev, which has no WAF. On the Free plan the rule matches the path only, counts 10 s windows and blocks for 10 s. Every file of a site is a request on `/p/` or `/f/`, so set the threshold above what one viewer requests in 10 s: a page with all its files, then the next page. htmlgate.com uses 100 per 10 s per IP on all three. `pnpm run smoke` and `pnpm run bench --live` space their requests 600 ms apart, a page with its frame counting as two (`HTMLGATE_LIVE_GAP_MS` changes it), so they stay under 20 per 10 s.

## When something breaks

**What you can see.** An Instance logs errors only, to Workers Logs (the Worker, Observability), kept 3 days on Workers Free and 7 on Paid. Nothing in 0.1 sends an alert: look there, or add a notification of your own. The lines to search for:

- `unhandled`: a request failed with a 500.
- `scheduled expire` or `scheduled trash`: a step of the hourly cleanup failed. The other step still ran, and the next hour retries. Until it works again, expired Shares stay hidden but their bodies stay in the bucket and count toward the storage cap.
- `access`: the team's certs endpoint did not answer, or not with keys, so no sign-in could be verified. While it lasts, every gated page answers not-found, the Author's included. The line holds an error code and message, never the token. A token that fails its own checks is not logged, whoever sent it.
- `trash` or `erase cleanup`: deleting bodies from the bucket failed after a change or an erase. The answer already went out; the hourly cleanup retries.
- `missing body`: a Version's row points at a body the bucket does not have. The reader got a 404.
- `view count`: counting a view of a Share's page failed. The reader got the page anyway; the next view tries again.

**Uptime.** Point an external monitor at these, which need no sign-in:

- `https://<your Instance>/api/onboard` expecting 200. It answers 503 when the Instance has lost its settings. It reads no database.
- `https://<your Instance>/p/aaaaaaaaaaaa` expecting 404. It runs one database query, so a database outage shows as a 500.

**Stop a caller.**

For a lost or compromised device, act from a trusted device as the Operator of the affected Instance. Secure the affected email/identity-provider and Cloudflare accounts if compromised. Keep incident records privately outside Git: affected token ids, revocations, erased Share slugs, times and recovery decisions, never token values or ticket URLs. 0.1 has no durable security audit ledger or automatic incident revocation. Commands below select an Instance with `--config`; for the default `instance.json`, revoke a token with `pnpm run token revoke <id>`.

- A token: list ids with `pnpm run token list --config .instance/production.json`, then run `pnpm run token revoke <id> --config .instance/production.json` for each affected token. Substitute your Instance's config file, or omit `--config` for `instance.json`. You can also revoke on `/tokens` or with `htmlgate tokens revoke <id>`. Revocation stops the token on its next request. Every token has the Author's full power over Shares and tokens, so use the trusted Author's `/tokens` page or the Operator's token command when the Publisher's token is compromised; neither needs that token.
- A person: remove them from `allowlist` in the affected Instance's file and run `pnpm run setup --config .instance/production.json` (substitute that file). They are out from the next request after the deploy, open tickets included. The Author is always allowed; removing an Allowlist entry cannot contain a compromised Author identity.
- Access sessions: in Cloudflare Zero Trust, use **Team & Resources > Users > Action > Revoke** for the affected user, or **Access controls > Applications > Configure > Revoke existing tokens** for the Instance's application, as described in Cloudflare's [session-management docs](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/). An active identity can sign in again; secure or disable it as appropriate. Access logout or revocation alone does not revoke htmlgate tickets.
- Ticket URLs: an existing ticket can read its Version for up to one hour while its person remains allowed and the Share and Version remain available. To invalidate all existing tickets, the Operator can replace `TICKET_KEY` in the Worker's dashboard secrets or with the [Wrangler secret command](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-put) below. It deploys the secret change immediately; use the generated config for the intended Instance. Generate the replacement directly into secret stdin, never print it to the terminal or save it to a file. Viewers reload the Gated Share's page for a new ticket.
- Someone hammering a public link: make the Share gated (`htmlgate gate <slug>`) or delete it (`htmlgate delete <slug>`); both hold from the next request. To block the caller, add a WAF custom rule on the zone (Security, WAF, Custom rules) that blocks their IP address or network. An Instance without a `domain` has no WAF.

```sh
node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("base64url"))' |
  pnpm exec wrangler secret put TICKET_KEY --config .instance/<name>.wrangler.jsonc
```

Per-token revocation, Allowlist changes, Access session revocation and ticket-key rotation are separate actions. None atomically revokes all credentials and sessions, and key rotation does not revoke Publisher tokens. Verify containment from the trusted device without logging credentials; review and revoke any other affected credentials. Token creation requires the Author's signed-in identity or the Operator's token command.

**Backups and restore.** A restore rehearsal has not been performed on an Instance. Read Cloudflare's [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) page before relying on it.

- Obtain the Operator's approval before a restore: it overwrites D1 in place and cancels in-flight queries. Keep access contained throughout recovery, including Public Share, API and ticket paths, with only a trusted recovery path open. Access logout alone does not contain these paths.
- The database has D1 Time Travel: any minute of the last 7 days on Workers Free, 30 on Paid. Before restoring, preserve the current recovery bookmark from `pnpm exec wrangler d1 time-travel info <name>-db --config .instance/<name>.wrangler.jsonc` in the private incident record. Select and approve the recovery point, then `pnpm exec wrangler d1 time-travel restore <name>-db --timestamp=<time> --config .instance/<name>.wrangler.jsonc` goes back. Keep the previous bookmark returned by the restore too.
- The bucket has no backup. 0.1 sets up no versioning, replication or copy for it, so a body deleted from R2 is gone.
- A restore therefore brings back rows, not bodies. A Share whose bodies the cleanup already deleted comes back as rows that answer 404 with `missing body` in the logs. Bodies published after the restore point lose their rows, stay in the bucket and are counted by nothing: 0.1 has no bucket sweep.
- A restore also undoes what the database recorded since: revoked tokens can work again and erased Shares' rows can return. Before restoring, prepare a private list of prior token revocations and erasures from the incident records; the restored database is not a complete record of them. Before reopening, list tokens and reapply revocations with the same `pnpm run token ... --config` workflows above, and have the Author erase any returned Shares through the Instance's own pages. Verify that a previously revoked credential is denied and that erased content is absent from D1 and R2. Keep access contained if records or verification are incomplete.

## Sites and tickets

- A site is published as a zip or a folder with an `index.html` at its top. The Worker checks the whole zip before storing it: no path out of the site, no links, no overlapping entries, every file inflating to exactly its declared size and CRC-32, and the limits in the README. Publishing a large site needs Workers Paid: that check takes more than Workers Free's 10 ms of CPU.
- A Public site's files answer at `/p/<slug>/<version>/<path>`. A Gated site's files answer at `/f/<ticket>/<path>`, because a Share runs in an opaque origin and its own requests never carry the Access cookie. The Worker issues a ticket only after verifying a person's Access token, seals it with `TICKET_KEY` (AES-GCM, bound to this Instance's Access audience), and makes it last an hour. Each file request checks the seal, the hour, that the person is still on the Allowlist, and that the Share is still live and the Version still kept.
- A ticket is a bearer permission: whoever has its URL can read that Version's files for up to an hour, while its person stays on the Allowlist. Signing out of Access or revoking Access sessions does not end it; rotating the key does (see **Stop a caller** above). Ticket URLs appear in the Viewer's browser history, and can appear in the Workers logs: in an unexpected error's record, and in every request's if you turn invocation logs on.
- Every site file is served with the same sandbox CSP as a page, `Referrer-Policy: no-referrer`, `nosniff`, `no-store`, a content type from a fixed table, and `Cross-Origin-Resource-Policy: cross-origin` with `Access-Control-Allow-Origin: *`: the opaque-origin page loading them is cross-origin by definition, and the URL itself is the permission.
- Measured in Chromium: a site's stylesheets, images, module scripts and `fetch()` of its own files load; a frame of the site's own page does not (`frame-ancestors 'self'` does not match the opaque origin that frames it). Links must be relative.

## Why R2

htmlgate requires R2, and keeps it. The question was whether an Instance could run without the R2 subscription:

- It would not spare an Operator the payment details: Zero Trust's Free plan asks for them too.
- Bodies in D1 would mean one product less and faster bodies (one round trip instead of two), but storage would fall from R2's 10 GB free to 500 MB per database on Workers Free (10 GB on Paid), a row holds at most 2,000,000 bytes so pages and zips would be split across rows, a site's files would lose ranged reads, and D1 Time Travel would keep deleted bodies restorable for up to 30 days.
- R2 as an option, with D1 as a fallback, would mean two storage paths and twice the tests for one dashboard step.

## Not yet in 0.1

- Restoring a deleted or expired Share. Deleting a Share hides it everywhere but keeps its rows and bodies until its expiry; then the hourly cleanup deletes its bodies for good and keeps its row, marked deleted. To remove a Share at once, record included, the Author erases it. See [privacy.md](privacy.md).
- A Deploy to Cloudflare button. It cannot create the Access application.
- Proof that Workers Free is enough.

## Storage

- Each Version's body is one private object in the `<name>-bodies` bucket: a page's HTML, or a site's zip exactly as published, whose file index (path, offset, sizes) is in the Version's row. Nothing in the bucket is public. Every read goes through the Worker, so the gate and the sandbox header always apply.
- **Expiry.** Every hour the Worker purges up to 150 expired Shares: their bodies are queued in `trash` and their Versions deleted in one transaction, and the Share's row is kept, marked deleted. It then deletes up to 500 due bodies from the bucket. A run stays under Workers Free's 50 D1 queries; what is left waits for the next hour, and failed cleanup is retried on later runs. Backlog or failures can delay physical deletion beyond an hour; there is no guaranteed deletion deadline. An expired Share answers as missing from the moment it expires, whether or not the cleanup has run.
- Every body in the bucket that no Version points at is listed in the database's `trash` table: bodies that left the 20-Version window, and uploads not yet claimed by their publish. They are deleted from the bucket after a request, with retries on later writes, and count toward the storage cap until they are gone.
- **The storage cap includes active upload reservations.** A publish reserves room before it uploads, in the same database statement that checks the cap, so concurrent publishes with unexpired reservations cannot pass it together. Reservation creation, claim, and cleanup use the database's execution-time clock; a delayed write cannot claim a body after expiry.
- **The one-hour reservation limit:** an upload that finishes after its reservation expires can temporarily put the bucket over the cap. Its write is refused, the body is re-ledgered, and cleanup retries its deletion. If the Worker stops before re-ledgering, that object can remain untracked and no longer count toward the cap. 0.1 has no bucket sweep for it.
- **The old `versions_d1_legacy` table** holds bodies from before bodies moved to R2; it is empty on a fresh Instance. Nothing reads it. Drop it when you no longer need it:

  ```sh
  pnpm exec wrangler d1 execute <name>-db --remote --command "DROP TABLE versions_d1_legacy"
  ```

## Speed

Live benchmarks (`pnpm run bench --live <instance-url>`) accept HTTPS, or HTTP only at `localhost`, `127.0.0.1` or `[::1]`. URLs with credentials, a path, query or fragment are rejected before using `HTMLGATE_TOKEN`. Authenticated benchmark and smoke requests do not follow redirects. Each tool soft-deletes only the valid slugs returned for its own fixtures; a failed visibility check still triggers cleanup, and an unsuccessful DELETE fails the run. A benchmark's speed verdict is valid only after cleanup succeeds; smoke reports cleanup alongside its other checks. Benchmark navigation data must include finite, ordered timestamps, a completed load event and a valid HTTP status; incomplete or malformed data fails the run before a speed verdict.

Smoke accepts a sign-in redirect only to an HTTPS `<team>.cloudflareaccess.com` hostname, without credentials or a non-default port. Text in a URL path or query cannot establish that it is Access. Each smoke request, including reading its response body, has a 10-second deadline; a stalled endpoint fails its check and cleanup is still attempted.

A page costs one D1 query; a Share's body costs one D1 query and one R2 read. Both are round trips from the Cloudflare location nearest the visitor to where the database and bucket live, so they set how fast a page can be:

- Measured on a deployed Instance (D1 and R2 in eastern North America, no read replicas) from Brazil on 2026-10-08, median time to first byte: about 167 ms for a page with one D1 query, about 327 ms for a Share's body (the R2 read adds about 160 ms). A viewer page loads both. Locally (`pnpm run bench`) the same pages take 10 to 40 ms, which is the Worker's own cost.
- **Placing the Worker next to its database does not help.** With `placement.region` set to `aws:us-east-1` (the Worker ran in IAD), the body got 47 ms faster and every one-query page 45 to 55 ms slower; a viewer visit was the same.
- The Workers Cache API cannot cache bodies: it is not available to a Worker behind Cloudflare Access. D1 read replicas would let a re-gated Share stay public on a lagging replica, so htmlgate does not use them.
- To serve visitors in one region faster, create the Instance's database and bucket near them before the first setup, which then reuses them: `pnpm exec wrangler d1 create <name>-db --location <hint>` (`weur`, `eeur`, `enam`, `wnam`, `apac`, `oc`) and `pnpm exec wrangler r2 bucket create <name>-bodies --location <hint>`. D1 has no South American location.
