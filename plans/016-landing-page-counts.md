# 016: Page counts on the landing, with no cookie banner

What the review changed: the notices say each visit is recorded with its time (Analytics Engine keeps
one row per view and sums at query time), not that visits are "counted"; the counting limits are
stated; 2025–2026 rule changes are checked.

Status: implemented on `feat/page-metrics`, based on `526d657`. Built without an interview, as the
owner asked; the open decisions are the assumptions below.

## Assumptions

1. "Each page" means the landing's pages at htmlgate.com (`/`, `/en/`, both privacy notices, the 404
   page). Instances are left alone: their privacy promise ([docs/privacy.md](../docs/privacy.md)) is
   "no analytics, no tracking scripts and no cookies of its own", and that promise is the product.
2. A cookie banner is needed only for cookies or other storage on the visitor's device. The counts use
   none, so the landing shows no banner and its privacy notice says why.
3. The counts are for the maintainer only. The pages do not show visitor numbers.

## Decision

The landing's Worker writes one Workers Analytics Engine data point for each page a browser
navigates to (`site/src/worker.ts`, `countView`): the page (a missing page only as `404`, never the
address asked for), the status, Cloudflare's country and the referring site's hostname. Only GET on
the canonical host, HTML answers, `Sec-Fetch-Dest: document` and no `Sec-Purpose` (prefetch or
prerender) count. Nothing on the device is read or written, and no IP address, User-Agent, query
string or identifier is stored. A failing write is logged and never reaches the visitor. Cloudflare
keeps the counts 3 months. They are read with `cf analytics_engine sql query` (README).

What the counts miss or add: pages are cached in the browser for 5 minutes (`max-age=300`), so a
revisit within that time is not counted; prefetches from browsers that mark them only with `X-Moz` or
`Purpose` are counted. Crawlers rarely send `Sec-Fetch-Dest`, so most are left out. The counts are
trends, not exact visits.

## Alternatives

- Cloudflare Web Analytics: a beacon script. The landing promises no scripts, its CSP is
  `default-src 'none'` and its tests reject `<script>`. The beacon is cookieless too, but it would
  have meant loosening the CSP for data the Worker already has.
- Per-Share view counts on Instances: a D1 write on every view, a schema change, API, CLI and pages in
  two languages, and a different privacy promise for every Operator. A product decision, not this
  task; it stays a proposal.
- Challenging the premise: read the landing's existing Workers Logs. They hold IP addresses, last 3
  days and give no per-page totals, so they answer "is it up" but not "what do people read".

## Five years on

Counting on the server, from requests the browser already sends, stays outside cookie and device
storage rules (ePrivacy art. 5(3), as the EDPB reads it in Guidelines 2/2023), meets the CNIL's
conditions for audience measurement without consent (first party, anonymous, aggregated), and holds
no personal data under the LGPD. The direction of travel agrees: the EU's Digital Omnibus proposal
(November 2025, not adopted as of this plan) moves device-access consent into the GDPR as Article
88a and exempts aggregated audience measurement by a service for its own use (88a(3)(c)), which the
EDPB and EDPS back in Joint Opinion 2/2026. The landing does not rely on that exemption: it reads and
stores nothing on the device. The regret to avoid is a client-side analytics script and a consent
banner, which would undo the landing's "no scripts" promise for less accurate data. If the site ever
needs sessions or funnels, that is a new decision with its own notice, not a widening of this one.

## Research

- [Workers Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/):
  Workers Free includes 100,000 data points and 10,000 read queries a day. [Limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/):
  one index of at most 96 bytes, 20 blobs, data kept 3 months.
- [EDPB Guidelines 2/2023 on the technical scope of art. 5(3) of the ePrivacy Directive](https://www.edpb.europa.eu/documents/guideline/guidelines-22023-on-technical-scope-of-art-53-of-eprivacy-directive_en), final version 2.0 of 7 October 2024.
- [CNIL, cookies and other trackers](https://www.cnil.fr/en/cookies-and-other-tracking-devices):
  audience measurement is exempt from consent when it is first party, limited to that purpose and anonymous.
- [Taylor Wessing, the Digital Omnibus proposal: cookies](https://www.taylorwessing.com/de/global-data-hub/2026/the-digital-omnibus-proposal/gdh---the-digital-omnibus---cookies):
  Article 88a and its audience-measurement exemption, a proposal still in the legislative process.
- [Fetch Metadata request headers](https://www.w3.org/TR/fetch-metadata/): `Sec-Fetch-Dest`; prefetch
  and prerender mark themselves with `Sec-Purpose`.
