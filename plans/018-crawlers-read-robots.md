# Plan 018: read a Public Share's link on X as well as WhatsApp

## Scope and observable outcome

Bug fix, planned against `ae3b6c3` on 2026-10-20. The owner reported that a Public Share's link shows a card on WhatsApp
but **not on X**. After this plan, `GET /robots.txt` answers **200 to a crawler** with a policy that lets it read `/p/`,
and that policy is created and owned by `pnpm run setup` like the gate application.

## Reproduced evidence (2026-10-20, production)

- `GET /robots.txt` with `User-Agent: Twitterbot/1.0` answers **302** to the Cloudflare Access login: the Instance's
  robots policy sits behind the gate, so no crawler can read it at all.
- The same UA on `/p/re2xrlBUn0kD` and on its card image answers **200** with the right metadata and JPEG bytes, so the
  page, the tags and the image were never the problem.
- X's published behaviour: its crawler (`Twitterbot`) respects `robots.txt` and refuses to build a card for a site whose
  robots.txt it cannot fetch. WhatsApp's unfurler ignores `robots.txt`, which is exactly the difference the owner saw.
- A public override on the gate application only matches `<segment>/*` paths: `/og.jpg`, `/og.jpg*`, `/og/*`,
  `/robots.txt` and even a `bypass` behaviour for `/robots.txt` were persisted on the application (`cf zero-trust access
  applications get` shows them) and the edge still answered 302, while `/p/*` passed on the same application and zone.
- A **separate** self-hosted application for `staging.htmlgate.com/robots.txt` with a `bypass` policy answered **200**
  on the first try, while every other path stayed gated. This account already uses that shape elsewhere.

## Decision

1. **`robots.txt` is public**, through a second Access application: `htmlgate: <name> robots`, destination
   `<host>/robots.txt`, one `bypass` policy for everyone. It is created, updated and ownership-checked by
   `pnpm run setup`, which refuses to repoint an application of that name at another host.
2. **The policy opens one prefix**: `Allow: /p/` with `Disallow: /`. A Public Share is meant to be shared, and the pages
   carry `noindex`, so being crawlable is not being listed. Gated pages, `/tokens`, `/metrics`, `/api/` and ticket URLs
   stay out.
3. `pnpm run smoke` checks that a crawler gets 200 and that the policy names `/p/`, so a missing bypass application is
   caught on the deployed Instance rather than by a support ticket.

## Tests that would fail without the change

`test/api.test.ts` asserts the served policy; `test/operator.test.ts` asserts the second application's shape (one path,
everyone, bypass, no `destinations`); the smoke suite runs the same check against a live Instance, through the scaffold
in `test/reviewer-release-tools.test.ts`.

## Alternatives

- **Rejected: one application per public path.** The gate application's `<segment>/*` overrides already cover `/p/`,
  `/api/` and `/f/`; `robots.txt` is the only path that needs its own application because it cannot be expressed as a
  segment prefix.
- **Rejected: leaving robots.txt gated.** A robots policy no crawler can fetch is the defect; it also means the
  Instance can never state what may be crawled.
- **Rejected: opening the whole Instance to crawlers** to avoid the second application. It would expose the gated pages'
  existence and make the policy invisible.

## Current status

Implemented with the setup step, the policy, the tests and the docs. X caches a card per URL, so the owner must test with
a URL it has not fetched before (a query string such as `?v=2` changes the cache key) after the deploy.
