# htmlgate CLI

Metadata keys are literal strings, including `__proto__`, `constructor` and `toString`. Repeated keys use the last supplied value.

Publish an HTML page, or a whole static site, to your own [htmlgate](../../README.md) Instance and get its URL.

It has no runtime dependencies and needs Node 26.

## Install with Homebrew

Homebrew is the install path on macOS. Do not install both the Homebrew and npm versions.
The htmlgate repository is its own tap. The formula builds from a deterministic CLI-root source archive committed under
`Formula/sources/`, named by its SHA-256. Homebrew verifies the top-level `sha256` before
compilation; the tap-local download needs no GitHub credentials. Formula `revision 1`
distinguishes the rebuilt `0.1.0_1` installation from the older `0.1.0`.

```sh
brew tap mneves75/htmlgate https://github.com/mneves75/htmlgate.git
brew install mneves75/htmlgate/htmlgate
brew upgrade mneves75/htmlgate/htmlgate
```

From the repository root, `pnpm run cli:install` installs or upgrades the CLI, refreshes only this tap,
fetches its tags, requires a clean tap at `origin/main`, and checks the formula, source archive
and approved CLI inputs against this checkout and the readable release tag before installing. It fails if the tap has edits or local commits, cannot
fast-forward, or lacks the release tag. It then checks the linked `0.1.0_1` receipt, compares the installed JavaScript, package and
documentation bytes with a build from the verified archive, runs version/help checks, and checks the first
`htmlgate` on PATH, which must be exactly `<brew --prefix>/bin/htmlgate`, even if another binary
reports the same version. Remove a shadowing npm binary with `npm uninstall -g @htmlgate/cli`;
otherwise adjust PATH so Homebrew's bin comes first. Homebrew provides Node 26; the installed
launcher uses Homebrew's Node.

Release order: finalize the version and CLI inputs, run `pnpm run cli:formula`, commit the
source archive and formula with the release source, run gates, tag, publish, deploy, then run
`pnpm run cli:install` on the owner's machine and report its receipt and artifact checks.
Regenerate after any CLI source or documentation change; the release suite rejects stale bytes.
The stable tag and a staging alias identify the same source commit; no beta package rebuild is needed.
An existing tag pointing to different source is a release failure, never an installer bypass.

## Install without Homebrew

For machines without Homebrew, npm is the alternative. It will be published as `@htmlgate/cli`.
Until then, from the htmlgate repository:

```sh
pnpm run build:cli && npm install -g ./packages/cli
```

## Sign in

Create a token on your Instance's `/tokens` page, then:

```sh
htmlgate login https://html.example.com          # asks for the token without echoing it
htmlgate login https://html.example.com --token-stdin < token.txt
htmlgate status                                  # which Instance and token; exits 0 if the Instance accepts it, 2 if not signed in or refused, 8 if unreachable
htmlgate logout [https://html.example.com]
```

`login` checks the token against the Instance before it saves anything, and a refused token changes nothing.

Tokens are kept in one file per user, never in a project:
- The file is `$XDG_CONFIG_HOME/htmlgate/credentials`, or `~/.config/htmlgate/credentials`. It is mode 0600 inside a 0700 directory.
- It holds one token per Instance origin, so one person can sign in to several Instances.
- `logout` removes one Instance's token from this computer. It does not revoke it; `htmlgate tokens revoke <id>` does.

This keeps secrets out of working trees, where `git add -f`, a Docker `COPY .` or a zip export would take them along. The file is still readable by anything running as you. The strongest storage would be the system keychain, which the CLI does not use yet.

### Which Instance and token a command uses

**Instance**, the first that is set:
1. `$HTMLGATE_URL`.
2. `api_url` in the project's `./.htmlgate/config`, a one-line file you write and may commit: `api_url = "https://html.example.com"`. If the file exists without a usable `api_url`, the command stops with exit 7 rather than fall through to step 3.
3. The only Instance you are signed in to. With several, name one with either of the above.

**Token:**
- `$HTMLGATE_TOKEN`, only together with `$HTMLGATE_URL` (`login` too uses it only to sign in to that same Instance). A token from the environment never goes to an Instance that a project file names, because a cloned repository could name any host.
- Otherwise, the token stored for exactly that Instance origin. A stored token never goes to any other origin.

`login` takes its URL from its argument or `$HTMLGATE_URL`, never from a project's config, so a cloned repository cannot collect your token through it.

In CI, set `HTMLGATE_URL` and `HTMLGATE_TOKEN` and skip `login`.

## Commands

```sh
htmlgate publish <page.html | site.zip | folder> [--title <t>] [--description <d>] [--metadata k=v]... [--upsert | --slug <slug>] [--expires <when>]
htmlgate update <slug> [--file <f>] [--title <t>] [--description <d>] [--metadata k=v]... [--clear-metadata] [--expires <when>]
htmlgate list [--metadata k=v]... [--public | --gated] [-n <count>]
htmlgate status
htmlgate url <slug>
htmlgate delete <slug>
htmlgate public <slug>
htmlgate gate <slug>
htmlgate versions <slug>
htmlgate tokens list
htmlgate tokens revoke <id>
```

- **publish:** creates a Share, which starts gated. The title defaults to the file or folder name.
  - An `.html` file is a page. A `.zip`, or a folder, is a site that opens at its `index.html`. A folder is zipped in memory; names that start with `.` (`.env`, `.git`, `.DS_Store`) are left out, and a symbolic link anywhere inside it refuses the whole publish. A site's links must be relative.
  - `--expires` sets when the Share expires: `never`, `30d`, `12h`, a date (`2026-12-31`, at 00:00 UTC) or a date and time with its zone (`2026-12-31T18:00:00Z`). Without it the Instance's default applies, 30 days after each publish unless set. A date you set stays through later publishes until you change it.
  - `--slug` publishes a new Version of that Share instead, keeping its title unless you pass `--title`. With `--metadata` it also replaces every tag of that Share.
  - `--upsert` looks the Share up by its `--metadata` first. If none matches, it creates one with those tags. If one matches, it adds a Version and keeps that Share's tags, and its title unless you pass `--title`. If more than one matches, it refuses rather than guess. The lookup and the write are two requests, so two publishers racing can still create two Shares.
- **update:** `--file` makes a new Version, from a page, a `.zip` or a folder. Without it, only the fields change. `--metadata` replaces every tag, and `--clear-metadata` removes them all (on its own when `--file` is a site). `--expires` changes the expiry date.
- **list:** reads every page. `--metadata` filters are ANDed together. At a terminal it shows each Share's expiry date; in JSON, `expires_at`.
- **versions:** each kept Version, page or site.
- **public / gate:** make a Share public, or gate it again from the next request.
- **tokens:** list the Author's tokens, which never includes their secrets, or revoke one. A token can never create a token.

Repeat `--metadata` for each pair. A pair splits at its first `=`.

## Output

Text by default. JSON with `--output json`, or on its own when a coding agent's environment variable is set (Claude Code, Codex, Cursor and others; `FORCE_AGENT_MODE=1` forces it). Results go to stdout. Errors go to stderr as `{"error": {"code", "message", "hint"?, "details"?}}` in JSON mode.

| Exit | Meaning |
|---|---|
| 0 | Done |
| 1 | Unexpected error |
| 2 | Not signed in, or the token was refused |
| 3 | Forbidden |
| 4 | No such Share, Version, token or file |
| 5 | Rate limit or storage limit |
| 6 | Too large: a page over 2 MiB, a site over its limits (10 MiB zipped, 1,000 files, 5 MiB a file, 25 MiB in all), or a title or description too long |
| 7 | Invalid arguments, an invalid expiry, a site the Instance refuses (no `index.html`, a path out of the site, a link), a broken `.htmlgate/config`, a file reached through a symlink, or a credentials file that is damaged, a symlink or locked |
| 8 | Network error, a redirect, a plain-http Instance, a server error, or an answer that is not the API's (wrong shape, or over 16 MiB) |
| 130 | Cancelled at the token prompt (Ctrl-C); nothing was saved |

## Safety

- The Instance must use https. The only exception is loopback (`localhost`, `127.0.0.1`, `[::1]`), for development.
- The CLI never follows a redirect: a redirected request fails with exit 8. Each request, its answer included, times out after 30 seconds, also with exit 8.
- The token never appears in output, and the CLI never takes it as a command-line argument.
- Text a server sends is printed without control or bidi characters, and a newline or tab inside a field or an error message cannot start a new row, column or line.
- `publish` opens only a real file named by its real path: a path with a symbolic link anywhere on it, the file or any directory, is refused (macOS's own `/tmp`, `/var` and `/etc` excepted). A repository therefore cannot plant `page.html` or `output/` pointing at a secret, whatever spelling of the path you use. On macOS (`O_NOFOLLOW_ANY`) and Linux (the opened file's own path is checked) the check is part of the open, so renaming or swapping directories during the publish cannot slip a link in; on other systems each directory is checked just before the open, which a concurrent writer could race. It reads at most 2 MiB for a page and 10 MiB for a zip. A folder is walked the same way: every file in it is opened by its real path with the same check.
- The CLI refuses to write the credentials file through a symlink; a symlinked `~/.config` is fine. It writes the file atomically under a lock, with mode 0600 from the start, so two logins at once cannot lose each other's entry.

## Licence

MIT. See [LICENSE](LICENSE).
