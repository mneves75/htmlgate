# Plan 014: Restore the landing's social preview image

## Scope and observable outcome

Bug fix, planned against `526d657` on 2026-10-18. The owner's X screenshot confirms the landing's domain and pt-BR Open Graph title/description with a missing-image placeholder. Cover the pt-BR and English landing pages, `/` and `/en/`, through the existing real landing HTTP seam in `test/site.test.ts`. A crawler must receive a large-image card declaration and an absolute HTTPS image URL in the initial HTML; that image must return real JPEG bytes without authentication. Keep the existing language-specific titles, descriptions and canonical URLs. A Gated Share must retain its access policy; this plan does not expose Share content to crawlers. Instance URLs have their own robots/noindex policy.

## Reproduced evidence

Requests using `Twitterbot` to both deployed landing pages returned HTML with a title but no `og:image`, `twitter:image` or `twitter:card=summary_large_image`. The deterministic check of those two fetched responses exited 1 for both missing image declarations and missing large-image card type. Source HTML has the same omission.

The checkout already contains `site/public/media/htmlgate-15s.jpg`: a 1600 by 900, 35,541-byte branded JPEG. It was visually inspected and has a centered htmlgate wordmark and domain. The deployed URL currently returns 404, so adding metadata locally alone cannot finish the fix; the complete landing artifact must be deployed and the public image fetched afterward.

Primary reference: [Open Graph protocol](https://ogp.me/), checked 2026-10-18, defines `og:image` and image type, dimensions and alt text. The former X Cards documentation URL redirects to the general developer overview; do not present that redirect as a verified current card specification or claim that X has rendered a card merely because metadata exists.

## Smallest implementation

1. Add one regression slice to `test/site.test.ts`, exercising the real Worker with a crawler User-Agent. For both languages, read metadata from the served initial HTML and require a unique `twitter:card` of `summary_large_image`, unique absolute HTTPS `og:image` and `twitter:image` URLs, descriptive localized alt text, and the existing localized title/description. Check the canonical origin and preserve its localized path. Record the missing-image assertion failing before editing either HTML page.
2. Add the image metadata to `site/public/index.html` and `site/public/en/index.html`, reusing the existing branded JPEG. Declare JPEG type and its actual 1600 by 900 dimensions; describe the visible brand/domain in each language. Prefer explicit Twitter metadata over an undocumented fallback assumption. Preserve the existing design, scripts policy and response headers.
3. Through HTTP, fetch the image path obtained from the page with the crawler User-Agent. Validate its absolute production URL separately, then fetch its pathname from the local Worker using `arrayBuffer()`. The existing text response helper decodes UTF-8 and cannot verify JPEG bytes. Require GET and HEAD success, JPEG content type, real JPEG bytes for GET, no redirect/sign-in requirement and a body below the project's 5 MB budget; this budget is not a verified current X restriction. Exercise the current robots policy too. A source-file string assertion alone cannot prove fetchability. Use existing helpers; no new package, image renderer or metadata framework.
4. Run focused RED/GREEN, then affected site/typecheck gates, rendered desktop/phone verification and the page benchmark sequentially. Existing axe checks remain binding. Record commands and outputs. Review actual diff and image visibility independently.
5. Integrate with Plan 013's source corrections and final release gates. Consolidate the changelog and package metadata into final `0.1.0`. Plan 015 owns the approved single-commit packaging convention, recovery and leased ref replacement. Do not publish before the complete candidate and required gates are ready.

## Acceptance and release boundary

- Both landing languages serve valid image/card metadata before JavaScript execution.
- The referenced local and deployed image is publicly retrievable by a crawler and matches its declared format/dimensions. Staging metadata intentionally names the production origin: test the staging asset on the staging origin, then the exact advertised absolute image URL after production deployment. Private Shares remain gated.
- Relevant tests, typecheck, accessibility and benchmark pass; full candidate check, uninterrupted mutation gate, CI and independent acceptance remain required for the combined release.
- The exact commit/target security gate runs before staging and production. Deploy only with the repository's landing procedure and only after its Instance version/privacy prerequisite is met. Check the live pages and image afterward, including Twitterbot requests and www redirects.
- Do not post on X or claim that its cached cards refreshed without observing that result. Preserve the distinction between correct public HTML/image responses and X's own rendering/cache.

## Alternatives and maintenance

Chosen: reuse the existing small raster brand poster. A new dedicated illustration adds an asset and design work without addressing the missing metadata; a dynamic per-request image renderer adds runtime cost and failure modes to a static landing. Five years later, static metadata and a public raster image remain easy to inspect. Keep image declarations synchronized when the poster changes, and use a changed image URL when new artwork needs a fresh crawler cache key.

## Current status

Fresh read-only adversarial planning review endorsed the static-poster approach and required binary-safe image checks, separate staging/production URL proof, an explicit project size budget and an unresolved status for the then-unspecified reported URL. Those changes are incorporated above; the subsequent owner screenshot confirms the landing scope. No code or runtime acceptance was performed by that planning reviewer.

Implemented locally. Both crawler regressions first failed on missing `og:image`, then passed with localized metadata and binary-safe JPEG GET/HEAD checks. The existing non-browser site controls passed (36 tests), as did typecheck and diff checks. Only the two HTML files and their HTTP regression suite changed. Browser/axe, complete release gates, independent acceptance and deployed-image proof are separate release conditions recorded in delivery evidence. The owner authorized deployment after the required gates.
