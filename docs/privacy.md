# What an Instance keeps about people

An Instance runs in the Operator's own Cloudflare account, so the Operator decides what happens to this data and owes the people involved (the Author, the Viewers on the Allowlist, and anyone who opens a Public Share) a privacy notice. This page lists what htmlgate stores and where, so that notice can be accurate. It is engineering documentation, not legal advice.

htmlgate sends nothing to anyone but Cloudflare. It has no analytics, no tracking scripts and no cookies of its own.

## In the Instance's database (D1)

| Table | What it holds | Kept until |
|---|---|---|
| `tokens` | The Author's email, and each token's name, its SHA-256 digest (never the token), and when it was created, last used (updated at most once a minute) and revoked. | Forever, revoked or not. |
| `shares` | The Author's email, and each Share's title, description, tags, public flag, times created, updated and deleted, and the id of the token that last changed it. | Until the Author erases the Share. Deleting a Share marks it deleted and hides it everywhere; the row stays, and so does an expired Share's, marked deleted. |
| `versions` | Each kept Version's size, time, the id of the token that published it, its body's key in R2, and for a site the path and size of each file. | Until the Version leaves the 20-Version window, or the hourly cleanup processes its expired Share. A soft-deleted Share keeps its rows until that cleanup or Author erasure. |
| `trash` | Bodies waiting to be deleted from R2, with their size. | Until the body is deleted. |
| `versions_d1_legacy` | Bodies from before bodies moved to R2; empty on a fresh Instance. | Until the Operator drops the table ([operator.md](operator.md#storage)). |

The database lives where it was created. Setup lets Cloudflare choose, or you create it near your people first ([operator.md](operator.md#speed)).

## In the Instance's bucket (R2)

The whole body of every kept Version, one private object each: a page's HTML or a site's zip as published. Nothing in the bucket is public; every read goes through the Worker. A body is queued for deletion when its Version leaves the 20-Version window; deletion is attempted after the write, with retries. An expired Share answers 404 immediately, while physical cleanup runs hourly in bounded batches: up to 150 expired Shares processed and 500 due bodies deleted per run, with retries on later runs. Backlog or failures can delay deletion beyond an hour; there is no guaranteed physical-deletion deadline. **Soft-deleting a Share only hides it**; its bodies stay until expiry cleanup or Author erasure, and a Share with no expiry keeps them until erasure.

## In the Worker's settings

The Author's email and every email on the Allowlist, as plain Worker variables, readable by anyone with access to the Cloudflare account.

## At Cloudflare, outside htmlgate's code

- **Access sign-in.** Cloudflare Access runs the sign-in page and logs each sign-in (who, when, from where) under Zero Trust, Logs. Its sign-in cookies are listed in [Cloudflare's authorization cookie docs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/); they carry the signed-in person's email. If you add an identity provider such as Google or GitHub, that provider sees each sign-in too.
- **Workers Logs.** Setup turns on Workers observability with per-request invocation logs and traces off, so Cloudflare keeps only what the Worker logs itself, which is only unexpected errors; an error's record can include details of the request that caused it. Cloudflare keeps these 3 days on Workers Free and 7 days on Workers Paid ([Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)). [Cloudflare's Tail handler docs](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/) describe redacting, by heuristic, header values whose names look sensitive (`cookie`, or names containing `auth`, `key`, `secret`, `token` or `jwt`) and ID-like parts of URLs; the Workers Logs page does not say whether the same applies there, so do not rely on it for anything you would not want stored. To record every request as well (its URL, method, status and request metadata, which can include the IP address and country each request came from, a Viewer's included), set `observability.logs.invocation_logs` to `true` in `workerConfig()` in `scripts/setup.mjs` and run setup.
- **Cloudflare's own network logs**, under its privacy policy and your plan.

## On a Publisher's machine

The `htmlgate` CLI keeps tokens in `~/.config/htmlgate/credentials` (mode 0600), one per Instance. Every request carries a User-Agent with the CLI's version, the Node version, the operating system and architecture, and the name of the coding agent running it when one is detected.

## What people can ask for

- **A copy:** a Publisher can read every Share and every kept Version with the API (`GET /api/shares`, `GET /api/shares/:slug/versions/:n`).
- **Removal from the Allowlist:** edit `allowlist` and run setup; the person loses access on their next request.
- **Erasure:** the Author erases a Share for good from its page (Erase), or by its link from the home, whether or not it was deleted before. From the home, the Instance first shows which Share the link names and asks again. One transaction deletes every Version, the Share's row and any of its bodies in `versions_d1_legacy`, and queues its bodies; the Worker then deletes them from R2, together with any object under the Share's prefix (an upload that outlived its reservation), while the answer goes out; if R2 fails, the hourly cleanup retries. Deleting with the API or the CLI is a soft delete and erases nothing. What can remain afterwards: D1 Time Travel can restore earlier database states for 7 days on Workers Free and 30 on Paid; Workers Logs keep request URLs, which hold a Share's slug but not its content, for 3 and 7 days; token names and the Allowlist are changed on the token page and with setup.
- **Ticket URLs.** A Gated site's files are fetched under a ticket in the URL, so ticket URLs reach the Viewer's browser history, and can reach the Workers Logs: in an unexpected error's record, and in every request's if you turn invocation logs on. A ticket seals the Viewer's email (AES-GCM): it is not readable from the URL.
