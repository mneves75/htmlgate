# Plan 009: A Drop can be a site, published as a zip

Priority P1; effort L; risk HIGH (a new kind of URL that opens Gated content without the Access
cookie; a zip parser on untrusted input); category feature; planned at `58fde07`, 2026-10-09.

## Why

Cloudflare Drop takes a folder or zip of a static site. htmlgate takes one HTML document of at most
2 MiB, so a page that needs its own CSS, scripts, images or JSON must be inlined by hand. The owner
asked for zip upload.

## The constraint that decides the design (measured)

A Drop runs in an opaque origin (`Content-Security-Policy: sandbox` without `allow-same-origin`,
issue #12). Measured in Chromium on 2026-10-09 with a local server: from such a document, top-level
or in the viewer's iframe, every request back to the same host is `Sec-Fetch-Site: cross-site`; the
`SameSite=Lax` cookie (what setup gives the Access cookie) is never sent; a `SameSite=None` cookie is
sent for style, image and script but not for `fetch()`. So a Gated site cannot load its own files
through Access: every asset request would be bounced to the sign-in page.

## Decision

A site's files are served from URLs that carry their own short-lived permission:

- **Ticket** (GLOSSARY): a sealed, short-lived permission to read one Version of one Drop's files,
  issued to a person on the Allowlist after the Worker verified their Access token. Avoid: signed URL,
  capability, session.
- `/f/<ticket>/<path>`: Gated site files. The ticket is AES-GCM sealed with the Instance's
  `TICKET_KEY` secret: slug, Version, the viewer's email and an expiry one hour ahead. The email is
  sealed, so a Drop's scripts reading their own URL learn nothing about who is viewing. Every request
  re-checks, in one D1 query plus the config: the seal, the hour, the email still on the Allowlist,
  the Drop live (not deleted, not expired) and the Version still kept. A removed person or a deleted
  Drop is refused on the next request, as today. Access leaves `/f/*` to the Worker, like `/api/*` and `/p/*`.
- `/p/<slug>/<n>/<path>`: a Public site's files, no ticket (public paths already bypass Access).
- `/d/<slug>` and `/p/<slug>` viewers frame a site's `index.html` from those paths; `…/raw` answers
  303 to them. A path ending in `/` serves that directory's `index.html`. Root-relative links
  (`/style.css`) do not work: a site must use relative links (documented, as on any subpath host).
- A top-level navigation with an authentic but expired ticket answers 303 to `/d/<slug>`, which signs
  the person in again; anything else wrong answers the same 404 as a missing Drop.
- Every site file answer carries the sandbox CSP (all of them, so an SVG or HTML file opened alone is
  sandboxed too), `Referrer-Policy: no-referrer` (a ticket never leaves in a Referer),
  `Cross-Origin-Resource-Policy: cross-origin` and `Access-Control-Allow-Origin: *` (the opaque-origin
  document loading it is cross-origin by definition; the URL itself is the permission), `nosniff`,
  `no-store`, and a type from a fixed extension table (text types as UTF-8, unknown as
  `application/octet-stream`).

Ticket contract: a fresh random 96-bit nonce per ticket; at most 1,024 characters of canonical
base64url, refused before decryption otherwise; the opened payload's slug, Version, email and expiry
are checked for shape; the AES-GCM additional data binds the purpose and the Instance's Access
audience; `pnpm run setup --rotate-ticket-key` replaces the key, which ends every ticket at once.
Every `/f/` answer, errors and redirects included, carries `no-referrer` and `no-store`.

What this costs, stated in the README's threat model: a ticket is a bearer permission. Anyone holding
its URL can read that one Version's files for up to an hour, while the person it was issued to stays
on the Allowlist; signing out of Access does not end it. A Drop's own scripts can read the URL, as they
can already read and send the Drop's content, and the Drop's markup can set its own referrer policy.
Ticket URLs appear in the Operator's Workers logs and in the Viewer's browser history.

## Storage

The zip is stored unchanged as the Version's one R2 body, so the reservation, claim and trash ledger
stay exactly as they are (one key per Version). Migration 0004 adds `versions.kind`
(`'page' | 'site'`, default `'page'`) and `versions.files` (JSON object, path to
`[dataOffset, compressedSize, size, method]`, null for a page). Serving a file is one D1 query
(`json_each(v.files)` keyed by the exact path) and one ranged R2 read, inflated with the runtime's
native `DecompressionStream("deflate-raw")` when deflated, cut at its declared size.

## Paths in URLs

One pipeline for a request's path: split the raw path on `/`, percent-decode each segment (a
malformed escape is a 404), apply the same path rules as the zip (so `%2F`, `%5C`, control characters
and dot segments are refused), normalize to NFC, and look the result up exactly. A path that ends in
`/` serves that folder's `index.html`. Names with `%`, `?` or `#` work when the link encodes them.

## Zip rules (`src/zip.ts`, pure, unit tested)

Limits: upload 10 MiB, 1,000 files, 5 MiB per file, 25 MiB in total, path 512 bytes. Refused, with
`400 site_invalid` naming the entry: data between the directory and the end record, encryption, methods other than stored/deflate, ZIP64, multi-disk,
symlink entries, non-UTF-8 non-ASCII names, absolute paths, `.`/`..`/empty segments, backslashes,
control characters, duplicates, overlapping entries, a local header that disagrees with the central
directory, data past the directory, an entry that inflates to anything but its declared size, and no
`index.html`. Skipped: directory entries, `__MACOSX/`, `.DS_Store`. One shared top folder is stripped
when the root has no `index.html`. Upload reads every entry once (native inflate, bounded by its
declared size) and checks its exact size, its CRC-32 and a clean end of the deflate stream, so a stored
zip always serves what it declares. Names are read as UTF-8 whether or not the zip sets its UTF-8 flag
(Info-ZIP and macOS `ditto` do not) and stored in NFC. Data descriptors (flag bit 3) are accepted: only
the method and name of a local header must match the directory. Entries, skipped ones included, are
capped at 2,000. Tests use zips made by Info-ZIP `zip`, macOS `ditto` and Python's `zipfile`, not only
by our own writer.

Reading and checksumming up to 25 MiB takes more than Workers Free's 10 ms of CPU: publishing a large
site needs Workers Paid. Measured on staging before release; the README says so.

## API

- `POST /api/drops` and `PUT /api/drops/:slug` accept `Content-Type: application/zip` with the other
  fields in the query string (`title`, `description`, `metadata.<k>`, `expires_at`). `413
  site_too_large` above 10 MiB. JSON `{html}` publishes are unchanged.
- `GET /api/drops/:slug/versions` gains `kind`; `GET …/versions/:n` returns `files: [{path, size}]`
  for a site instead of `html`, and `GET …/versions/:n/zip` returns the site's zip as published, so a
  Publisher can change a site and publish it again, as it can with a page's `html` (added in review).
- `/api/onboard` lists the limits and both request forms.

## CLI

`htmlgate publish <dir | file.zip | file.html>`: a directory is zipped in memory (deflate, CRC from
`node:zlib`), skipping names that start with `.` (so `.env` and `.git` never leave), refusing any
symbolic link inside it with `unsafe_path` (each file opened with the existing no-link `openReal`), and
refusing a directory without `index.html`. A `.zip` is sent as is after the size check. Same limits
client-side; exit codes 6 (too large) and 7 (invalid). `update --file` takes the same three forms.

## Setup

`PUBLIC_PATHS` gains `/f/*`. Setup creates `TICKET_KEY` (32 random bytes) as a Worker secret once,
piped to `wrangler secret put`, never printed or written to disk; later runs keep it. A missing or
malformed key makes `readConfig` return null (fail closed). The post-deploy check also asks
`/f/<garbage>/` and expects the Worker's 404, not Access.

## Tests (red first)

- `test/zip.test.ts` (no Worker): every rule above, with zips from the CLI's writer and byte-patched copies.
- `test/ticket.test.ts` (no Worker): seal/open, tamper, wrong key, expiry, email not readable in the URL.
- Store (no Worker, `node:sqlite`): file lookup by exact path; pruning a site Version queues its body.
- `test/sites.test.ts` (Worker): publish, Public files and headers, Gated viewer issues a ticket,
  ticket for a removed email / deleted Drop / pruned Version / other Drop is 404, expired ticket 303s
  on navigation, CSP on every file type, no-referrer, traversal in the URL is 404.
- `test/browser.test.ts`: a Gated site in the viewer renders its stylesheet and image, its
  `fetch("data.json")` succeeds, and a module script, a web font and a nested iframe of one of its own
  pages are tried, with the result documented; axe stays at zero. The browser carries no Access token
  on `/f/` requests, so a pass cannot come from a header the harness injected.
- CLI tests: directory, zip, link inside the directory, dotfiles skipped, limits.
- Mutations: each zip refusal that guards safety (traversal, symlink, overlap, size cap), ticket
  expiry, ticket Allowlist check, ticket Version binding, sandbox CSP and no-referrer on site files,
  `/p/` site files serving a Gated Drop.
- `pnpm run bench`: a Public site file joins the measured pages; `smoke.mjs` publishes and reads a site.

## Not in scope

Range requests for media, root-relative links, a page-to-site converter, caching.
