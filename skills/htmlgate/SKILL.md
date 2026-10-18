---
name: htmlgate
description: Publish an HTML page, or a static site from a folder or a zip, as a Share on the user's own htmlgate Instance and return its URL. Use when the user asks to publish, share or host an HTML page, site, report or explainer on their htmlgate, to change when a Share expires, or to make a Share public or gated again.
---

# Publishing to htmlgate

htmlgate is the user's own private HTML host on their Cloudflare account. You publish a Share, one HTML page or a static site, and get back a URL. Only people the user named on the Allowlist can open it, after signing in, until the user asks you to make it public. Every Share expires: by default 30 days after its latest publish.

## Before you publish

- You need the `htmlgate` CLI (`htmlgate --version`). It is not on npm yet; the user installs it from the htmlgate repository with `pnpm run build:cli && npm install -g ./packages/cli`. You also need the Instance URL and a token (`hg_` followed by 40 letters and digits). The user creates the token on their Instance's `/tokens` page or with `pnpm run token create <name>`.
- Check whether the CLI is already signed in before you ask for anything: `htmlgate status` exits 0 when it is and the Instance accepts the token, 2 when it is not, and 8 when the Instance cannot be reached. It says which Instance it uses. It never prints the token.
- A token can change, delete and make public every Share on the Instance. Never print it, log it, pass it as a command argument or put it in a Share. Never ask for it in chat: ask the user to run `htmlgate login <instance-url>` and paste it there.

## Publish

Inside the project directory:

```sh
htmlgate publish page.html --title "Short title" --description "One line"
htmlgate publish page.html --title "PR 42" --upsert --metadata pr=42   # same URL on every run
htmlgate publish page.html --slug <slug>   # a new Version of that Share; adding --metadata replaces all its tags
htmlgate publish ./dist --title "Report"   # a site: a folder with an index.html at its top
htmlgate publish site.zip --title "Report" # a site from a zip
htmlgate publish page.html --expires 7d    # or 12h, 2026-12-31, 2026-12-31T18:00:00Z, never
```

The CLI prints the URL. A new Share is gated: its URL is `https://<instance-host>/s/<slug>`. Add `--output json` for a parseable answer; the CLI picks JSON on its own when it detects a coding agent.

## Other commands

```sh
htmlgate public <slug>                   # anyone with the link
htmlgate gate <slug>                     # gated again, from the next request
htmlgate list --public                   # which Shares are public (--metadata k=v filters)
htmlgate versions <slug>                 # the kept Versions and which token wrote each
htmlgate update <slug> --file page.html  # a new Version (a page, a .zip or a folder); without --file, --title, --description and --metadata change fields only. --metadata always replaces every tag
htmlgate update <slug> --expires never   # change when it expires; a date you set stays through later publishes
htmlgate url <slug>
htmlgate delete <slug>
htmlgate tokens list                     # the Author's tokens (never their secrets)
htmlgate tokens revoke <id>              # it stops on its next request
```

A token can never create a token. Only the user can, signed in on `/tokens`.

Exit codes: 0 done, 2 not signed in or token refused, 3 forbidden, 4 not found, 5 rate or storage limit, 6 too large, 7 bad arguments, an invalid expiry, a site the Instance refuses, a file reached through a symlink, a broken `.htmlgate/config` or a damaged, symlinked or locked credentials file, 8 network or server error, a redirect, plain http beyond loopback, or an answer that is not the API's (wrong shape, or over 16 MiB), 130 cancelled.

## Rules

- **Make a Share public only when the user asks you to, for that Share.** Publishing a new Version never changes whether a Share is public. A Public Share's URL is `https://<instance-host>/p/<slug>`.
- A page is at most 2 MiB; inline its CSS and data. When a page would need separate files (CSS, scripts, images, JSON), publish a site instead: a folder or zip with `index.html` at its top, at most 10 MiB zipped, 1,000 files, 5 MiB a file. Use relative links (`css/style.css`, never `/css/style.css`). A site cannot frame its own pages. Names starting with `.` in a folder are left out, so never rely on a dotfile. Links to other sites work, and opening them in a new tab works.
- A Share's scripts can still send what the Share contains to another site. Never put in a Share anything the user would not want its viewers, or the sites its scripts call, to see.
- A Share runs sandboxed: scripts run, but forms, `alert()` dialogs, downloads, cookies and storage are blocked. Build Shares that need none of them.
- A Share keeps its latest 20 Versions. Older ones are removed for good.
- A Share expires on its own, 30 days after its latest publish unless a date was set, and is then gone for good. When the user wants a Share kept, ask whether to set `--expires never` or a date; do not set it on your own.
- Deleting a Share (`htmlgate delete <slug>`) takes it offline at once. Its data stays in the Instance's storage until it expires, and 0.1 has no command to restore it.
