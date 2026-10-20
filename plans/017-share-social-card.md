# Plan 017: a Share link that shows a card when it is shared

## Scope and observable outcome

Bug fix, planned against `e0b7503` on 2026-10-19. The owner shared `https://app.htmlgate.com/s/re2xrlBUn0kD`
on X and WhatsApp and got no thumbnail. A **Public Share's viewer page** must serve a large-image card
(`og:` and `twitter:` metadata, absolute HTTPS image) whose image the crawler can fetch without signing in.
A **Gated Share** keeps its access policy and gains no card: no `og:` metadata, no image, no description.

## Reproduced evidence (2026-10-19, production)

- `GET /s/re2xrlBUn0kD` with `User-Agent: Twitterbot/1.0` answers **302** to
  `…cloudflareaccess.com/cdn-cgi/access/login/…`. Same with `WhatsApp/2.23`. The crawler never reaches the
  Worker, so no metadata can matter on that path.
- `GET /p/re2xrlBUn0kD` with `WhatsApp/2.23` answers **200**: Cloudflare Access marks `/p/*`, `/f/*` and
  `/api/*` public (`scripts/setup.mjs:19`, `accessApp` overrides), and the Share is `public = 1` in D1.
- The viewer page emits **no** `og:` or `twitter:` element (`target="_blank"` grep over `src/pages.ts`).
  The landing already has them (`site/public/index.html:13-25`), which is why only Landing links previewed.
- `shareObject` already returns the `/p/<slug>` URL for a public Share (`src/api.ts:146-147`), so the CLI
  hands out the previewable link; pasting `/s/…` from the address bar is what breaks.

## Decision

1. **Metadata on the public viewer page.** `layout()` takes an optional card: `og:type`, `og:site_name`,
   `og:title`, `og:description`, `og:url` (the absolute `/p/<slug>`), `og:image` (+ type, width, height,
   alt), `twitter:card=summary_large_image`, `twitter:title/description/image`. Titles and descriptions are
   escaped; the URL is built from the request's origin, not from `Host` guesses. The existing
   `<meta name="robots" content="noindex, nofollow">` stays: a card is not an invitation to index a page in
   search.
2. **Nothing on the gated page.** `/s/<slug>` emits no card at all. Access already blocks crawlers, and a
   Share that is Gated by design must not leak a title, description or image into any cache.
3. **An image the crawler can fetch.** Serve the existing branded poster (1600×900 JPEG, 35 KB,
   `site/public/media/htmlgate-15s.jpg`) from the Instance at `/og.jpg`: bundled with the Worker (Wrangler
   `Data` rule so the file stays a file), `content-type: image/jpeg`, `cache-control: public, max-age=
   31536000, immutable`, no auth. `/og.jpg` joins `PUBLIC_PATHS` so Cloudflare Access lets the crawler through;
   without that override the card would point at a 302.
4. **The link to share.** `htmlgate public <slug>` and the publish path already return `/p/<slug>`. Document
   that a Gated Share's link never previews, and that making it public is the switch that turns the card on.

## Tests that would fail without the change

- `test/social.test.ts` through the real Worker: `GET /p/<slug>` with `Twitterbot` UA returns one
  `twitter:card` = `summary_large_image`, one absolute HTTPS `og:image` equal to `<origin>/og.jpg`, an
  `og:title` equal to the Share's title (escaped), an `og:url` equal to the canonical public URL, and an alt
  text; `GET /s/<slug>` returns none of them; `/og.jpg` answers 200 with `image/jpeg`, real JPEG bytes over
  1 KB, and the immutable cache header; a request for `/og.jpg` never requires Access configuration —
  asserted against `accessApp().destinations[0].overrides`, which must contain the path, so setup cannot
  quietly drop the bypass.
- The gated case is the security half: if someone emitted the card on both paths, this test fails.

## Gates and release

`pnpm run check`, `pnpm run mutate --check` (an anchor for the gated page's "no card" branch), `pnpm run
bench` (`/og.jpg` is not a page), axe unchanged. Version 0.1.11, changelog, README + operator docs, tag
`v0.1.11-beta1` for staging and `v0.1.11` for production, security gate record for the exact commit, then
live checks: `Twitterbot` GET of the public page, the image, and the gated page.

## Alternatives and maintenance

- **Rejected: a per-Share rendered card** (title/slug drawn into an image). The best-looking result, but it
  needs a raster renderer in the Worker (satori + resvg WASM, or Cloudflare Image Resizing): a new runtime
  dependency, a cold-start cost on every unfurl, and a second failure mode for a feature whose value is a
  thumbnail. Plan 014 rejected the same trade for the landing. Revisit if Operators ask for branded cards.
- **Rejected: pointing `og:image` at `htmlgate.com/media/…`.** Zero new bytes in the Instance, but it makes
  a self-hosted Instance's cards depend on the author's domain, and leaks a request to it on every unfurl.
- **Rejected: rendering the card image at `/p/<slug>/raw`.** That is the publisher's own document; injecting
  anything into it breaks their page and their own metadata.
- Five years out, a static poster plus correct metadata stays inspectable, cacheable and dependency-free; the
  per-Share renderer is a product decision with a cost, not a fix for a missing thumbnail.

## Review notes absorbed

- The image route keeps every `BASE` header (`src/http.ts`) and replaces only the cache policy; `AGENTS.md`,
  `PRODUCT.md` and this plan's own text now name that single exception to "every Instance response is `no-store`".
- The `Data` glob names `**/media/*.jpg` rather than every JPEG, and a test asserts the generated deploy config keeps
  the rule, so dev and deploy cannot drift.
- Tests now cover the description's escaping, the `public` conjunct on the public path, and the image's hardening
  headers. The description appears in the card but not on the page; `docs/operator.md` says so, since re-gating does
  not clear a crawler's cache.

## Current status

Implemented on `fix/share-social-card`, together with the metadata, the image route, the Access bypass, the
docs and the regression tests. X caches a card per URL: an already-posted link may keep showing no image
until its cache expires, which is a crawler cache fact, not a defect to fix in this repository.
