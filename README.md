# htmlgate

Agent-first HTML hosting that you run in your own Cloudflare account. A Publisher, usually an agent, publishes a Share (one HTML page, or a static site from a zip or a folder) and gets a URL. People open it after signing in, unless you make that one Share public. Every Share expires, 30 days after its latest publish unless you say otherwise.

## How it works

- **Metadata in D1, bodies in R2.** Each Version is one private R2 object under a key used once: a page's HTML, or a site's zip as published. Every read goes through the Worker, so the gate and the sandbox apply. Bodies that leave the 20-Version window, and the bodies of expired Shares, are deleted from R2.
- **A Share can be a site.** Publish a zip or a folder with an `index.html` at its top, and the Share opens there; its pages load their CSS, scripts, images and data by relative links. The zip is checked whole before anything is stored (paths, links, sizes, checksums), and each file is read from it with one ranged R2 read.
- **Every Share expires.** 30 days after its latest publish by default (`expiryDays` in `instance.json`; 0 means never). A Publisher can set a date, or never, and that date then stays. From its expiry a Share answers as missing everywhere, and the hourly cleanup deletes its bodies for good.
- **One Instance per person.** You deploy your own copy, an Instance, into your own Cloudflare account. Nobody else holds your credentials. The words used here are defined in [GLOSSARY.md](GLOSSARY.md).
- **Every Share starts gated.** Only people you name on the Allowlist can open it, after signing in through Cloudflare Access. You make one Share public with an explicit call, and you can gate it again. Gating it again takes effect on the next request.
- **The Worker is the gate.** Access runs the sign-in page. The Worker still verifies the signed Access token on every request and checks your Allowlist itself, so a removed person loses access on their next request. A missing setting refuses everything.
- **Share HTML is isolated.** It is served under a `Content-Security-Policy: sandbox` header with no `allow-same-origin`, so a Share's scripts run in an opaque origin, even when the Share is opened directly. They cannot read the Viewer's cookies or act as the Viewer. They can still send what the Share itself contains to another site, so the isolation protects the Viewer, not the Share's own content.
- **A Gated site's files come by ticket.** A Share's own requests never carry the Access cookie, because the sandbox gives it an opaque origin; so a site's CSS or images could not load through Access. When the Worker has verified a signed-in person, it frames the site under a ticket: an hour-long, sealed permission to read that one Version's files, naming the person without showing who it is. Every file request checks the seal, the hour, that the person is still on the Allowlist and that the Share is still live.
- **The Author can erase a Share for good.** From the Share's page (Erase), or by its link on the home, even a Share already deleted: every Version, its record and its bodies go at once. It is for a request to erase someone's data. Tokens cannot erase; deleting with the API or the CLI only hides a Share until it expires.
- **A refused Share looks missing.** A Gated Share, a deleted Share, an expired Share and a slug that never existed answer the same way.
- **HTTPS only.** Over plain http an Instance answers no API request and no change (`403 https_required`, so a token sent in clear fails loudly instead of working), and sends a page visit to its https address. Every answer carries `Strict-Transport-Security`. Plain http stays open only on `localhost`, `127.0.0.1` and `[::1]`, for `wrangler dev`.

| Path | Who | What |
|---|---|---|
| `/s/<slug>` and `/s/<slug>/raw` | people on the Allowlist, signed in | any Share |
| `/f/<ticket>/<path>` | whoever holds the ticket, for up to an hour | a Gated site's files |
| `/p/<slug>` and `/p/<slug>/raw` | anyone | Public Shares only |
| `/p/<slug>/<version>/<path>` | anyone | a Public site's files |
| `/api/*` | Publishers, with a token | the Publisher API |
| `/` and `/tokens` | signed in; the Shares list and tokens for the Author only | home (the Author's Shares), token management |

## Requirements

- A Cloudflare account. Workers Free should be enough for pages, but it is **untested**: 0.1 has only run on Workers Paid. Publishing a large site needs Workers Paid: the Worker reads and checksums every file of the zip, which takes more than Free's 10 ms of CPU.
- An R2 subscription on that account, for Share bodies. It is added once in the dashboard (Storage & databases, R2, then the checkout) and includes 10 GB-month of storage and millions of operations free each month; beyond that R2 bills storage and operations. The storage cap below limits what is stored, not how often it is read. htmlgate needs R2: it holds bodies D1 cannot (a row is at most 2 MB, a database 500 MB on Workers Free) and serves a site's files with ranged reads. Dropping it would not spare you payment details, because Zero Trust asks for them too.
- A Zero Trust organization on that account, for sign-in. Cloudflare asks for payment details even on its Free plan.
- Node 26, pnpm, and Cloudflare's [`cf`](https://github.com/cloudflare/cf) CLI. Log in to both `cf` and Wrangler, on the same account; setup checks it.

## Set up an Instance

```sh
pnpm install
cp instance.example.json instance.json   # your name, your email, the people you allow, "en" or "pt-BR"
pnpm run setup                           # safe to run again; it also updates
pnpm run token create laptop             # prints a token once
```

[docs/operator.md](docs/operator.md) explains each step, what it changes on your account, and how to change the Allowlist, update or remove an Instance. [docs/privacy.md](docs/privacy.md) lists what an Instance stores about people, where, and for how long, for the privacy notice you owe them.

## Install with Homebrew

Homebrew is the install path on macOS. Do not install both the Homebrew and npm versions.
This repository is its own tap. The formula builds from a deterministic CLI-root source archive committed under
`Formula/sources/`, named by its SHA-256. Homebrew verifies the top-level `sha256` before
compilation; the tap-local download needs no GitHub credentials. Formula `revision 1`
distinguishes the rebuilt `<version>_1` installation from any older installation of the same version.

```sh
brew tap mneves75/htmlgate https://github.com/mneves75/htmlgate.git
brew install mneves75/htmlgate/htmlgate
brew upgrade mneves75/htmlgate/htmlgate
```

From this checkout, `pnpm run cli:install` installs or upgrades the CLI, refreshes only this tap,
fetches its tags, requires a clean tap at `origin/main`, and checks the formula, source archive
and approved CLI inputs against this checkout and the readable release tag before installing. It stops if the tap has edits or local commits, cannot
fast-forward, or lacks the release tag. It then checks the linked `<version>_1` receipt, compares the installed JavaScript, package and
documentation bytes with a build from the verified archive, runs version/help checks, and checks the first
`htmlgate` on PATH, which must be exactly `<brew --prefix>/bin/htmlgate`, even if another binary
reports the same version. Remove a shadowing npm binary with `npm uninstall -g @htmlgate/cli`;
otherwise adjust PATH so Homebrew's bin comes first. Homebrew provides Node 26.

Release order: finalize the version and CLI inputs, run `pnpm run cli:formula`, commit the
source archive and formula with the release source, run gates, tag, publish, deploy, then run
`pnpm run cli:install` on the owner's machine and report its receipt and artifact checks.
Regenerate after any CLI source or documentation change; the release suite rejects stale bytes.
The stable tag and a staging alias identify the same source commit; no beta package rebuild is needed.
An existing tag pointing to different source is a release failure, never an installer bypass.

## Publish

Publish with the `htmlgate` CLI, [packages/cli](packages/cli). For machines without Homebrew,
the alternative is npm. It is not on npm yet, so install it from this repository:

```sh
pnpm run build:cli && npm install -g ./packages/cli
```

Create a token on your Instance's token page, then sign the CLI in. It checks the token before it saves it, in your user's config, never in a project:

```sh
htmlgate login https://html.example.com               # your domain, or <name>.<subdomain>.workers.dev without one; paste the token when asked
htmlgate publish page.html --title "My page"
htmlgate publish ./dist --title "My site"             # a folder with an index.html; dotfiles stay behind
htmlgate publish site.zip --expires 7d                 # a zip; the Share expires in 7 days (or a date, or never)
htmlgate publish page.html --upsert --metadata pr=42   # one stable URL per pull request
htmlgate public <slug>                                 # anyone with the link; `htmlgate gate <slug>` undoes it
```

With several Instances, put `api_url = "https://..."` in a project's `.htmlgate/config` to choose one there. In CI, set `HTMLGATE_URL` and `HTMLGATE_TOKEN` instead of signing in. [packages/cli/README.md](packages/cli/README.md) lists every command, flag and exit code. The full list of API requests is at `GET /api/onboard` on your Instance. Agents can use the Publisher skill in [skills/htmlgate/SKILL.md](skills/htmlgate/SKILL.md).

## Limits

- A page is at most 2 MiB. A site's zip is at most 10 MiB, with at most 1,000 files of up to 5 MiB each and 25 MiB in all once unzipped; paths are at most 512 bytes. The CLI refuses anything larger before it sends it.
- A site's links must be relative (`css/style.css`, not `/css/style.css`): its files live under their Version's path. A site cannot frame its own pages: they are refused under `frame-ancestors 'self'`, since the frame's parent is the sandbox's opaque origin.
- A Share keeps its latest 20 Versions. Publishing the 21st removes the oldest for good.
- A Share expires `expiryDays` (default 30) after its latest publish, unless a Publisher set a date; a date is from a minute to 3650 days ahead, or never.
- The whole Instance holds at most 5 GB of bodies in R2, half of R2's free allowance. `STORAGE_LIMIT_BYTES` changes it. Deleted Shares count until they expire or the Author erases them.
- A token may make 60 changes a minute. Cloudflare's rate limiter is approximate, and 0.1 promises no availability under attack.

## What a token can do

A token can create, change, delete and make public every Share on the Instance, and read them all. It can list and revoke tokens, but it can never create one. If a token leaks:

1. Revoke it from the token page, or with `htmlgate tokens revoke <id>` from any other Publisher.
2. List public Shares with `htmlgate list --public`.
3. Look at `changed_by` on each Share to see what the leaked token touched.

Revoking does not undo what the token did, and nothing can recall a copy someone already fetched.

## Threat model

PUT and PATCH preserve fields omitted from the request against the row at commit time, including changes made during an upload. Explicit `description: null` clears the description and `metadata: {}` clears metadata. Concurrent writes to the same supplied field follow commit order.

What htmlgate defends against, and what it does not. Security reviews and tests are scoped to this list.

- **Defended:** anyone on the internet; a Viewer on the Allowlist (reads only what the Allowlist and the Public switch allow); a token holder (everything a token can do, above, and no more: never a token, never past the storage cap or the size limits); the HTML of a Share, and every file of a site (sandboxed, so it cannot act as the Viewer); a zip built to attack the Worker (paths out of the site, links, overlapping entries, sizes that lie); and files a cloned repository plants for the CLI to publish, such as `page.html`, a directory that is a link to a secret, or a link inside a folder published as a site.
- **Accepted:** a ticket is a bearer permission. Anyone holding its URL can read that one Version's files for up to an hour, while the person it was issued to stays on the Allowlist; signing out of Access does not end it. A Share's own scripts can read their URL, as they can already read and send the Share's content, and a Share's markup can set its own referrer policy. Ticket URLs appear in the Viewer's browser history, and can appear in the Operator's Workers logs: in an unexpected error's record, and in every request's if they turn invocation logs on. `pnpm run setup --rotate-ticket-key` ends every ticket at once.
- **Not defended:** someone who can write to your working tree, or to a directory above it, while `htmlgate publish` runs. They can already change what you publish. On macOS and Linux the CLI's link check still holds against them; on other systems it is a best-effort check just before the open.
- **Not defended:** the Operator's own Cloudflare account. Whoever controls it controls the Instance.
- **Not defended:** an attacker on the network path during a browser's first visit to a plain `http://` link, before the browser has seen `Strict-Transport-Security`. Only HSTS preloading, the domain owner's choice, closes that first visit.
- **Known gap:** an upload that finishes after its hour-long reservation expires can temporarily exceed the storage cap until cleanup. If its Worker stops before re-ledgering it, that body can remain untracked (see [docs/operator.md](docs/operator.md#storage)).

## The landing page

### Views per Share

An Instance counts how often each of its Shares is opened, on the server, from the request the browser already sends:
no cookie, no script, no visitor identity. The count is one row per Share and UTC day (`share_views`). A count says
how often, never by whom, so the Instance keeps no analytics of people. The Author sees it on the home's board (the
last 30 days on each row) and on `/metrics`, which lists every Share with its 30-day and all-time counts and a button
to open it. Erasing a Share erases its counts in the same transaction.

`site/` is the public page at htmlgate.com: plain HTML and one stylesheet behind a small Worker that sets the headers and redirects. It is not part of an Instance, and an Operator never deploys it.

The Worker also counts each page a browser opens, in the Workers Analytics Engine dataset `htmlgate_site_page_views`: the page (`blob1`, a missing one as `404`), the status (`blob2`), the country (`blob3`) and the referring site's hostname (`blob4`). It sets no cookie, runs no script and stores no IP address or browser details, so the landing needs no cookie banner; the privacy notice says so. Each view is one row with its time; Cloudflare keeps them 3 months.

Read them by hand:

```sh
cf analytics_engine sql query --body "SELECT blob1 AS page, SUM(_sample_interval) AS views FROM htmlgate_site_page_views WHERE timestamp > NOW() - INTERVAL '30' DAY GROUP BY page ORDER BY views DESC"
```

```sh
pnpm run site:dev                 # serve it locally
pnpm run site:deploy --preview    # its own Worker on workers.dev, never a domain
pnpm run site:deploy --live       # htmlgate.com and www, always together
```

## Develop

Type checking and CLI builds use the official native TypeScript compiler, pinned to `7.0.2`.
The mutation-runner and terminology tests use the isolated `typescript-classic@6.0.3`
dependency for the legacy JavaScript compiler API.

```sh
pnpm run check      # typecheck, then every test end to end through `wrangler dev`, including the htmlgate CLI
pnpm run mutate     # requires an assertion to catch each violation; runner failures are BROKEN
pnpm run bench      # every page's load time in headless Chrome, the landing's included; fails at 50 ms p95
HTMLGATE_TOKEN=hg_... pnpm run bench --live https://<instance-host>   # the same for a deployed Instance's public pages
HTMLGATE_TOKEN=hg_... pnpm run smoke https://<instance-host>   # live checks on a deployed Instance
```

Every gate runs locally. GitHub Actions has not completed a run of the release workflow yet, so a local run is the release evidence.

## Licence

MIT, in [LICENSE](LICENSE). [packages/cli/LICENSE](packages/cli/LICENSE) also keeps the MIT notice of code the CLI started from, as that licence requires.

## Inspiration

Inspired by [htmlbin](https://github.com/utsengar/htmlbin) by Utkarsh Sengar. The htmlbin server has no licence file, so no code was taken from it.
