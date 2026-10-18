# Which Cloudflare storage fits Drop bodies and their metadata?

Research for ticket #6, feeding the decision ticket #14 ("Where do Drop bodies and metadata live?"). This note reports options and facts. It does not decide.

- Researched: 2026-10-05, from Cloudflare's own documentation (developers.cloudflare.com, read as Markdown) and the reference server `the reference` at commit `ac00be7`. Re-verified against the same pages on 2026-10-17: the cited limits, quotas and prices are unchanged.
- Every number below comes from a page read on that date. Each source carries its "last updated" date in the Sources list at the end, and cells cite sources by tag, for example `[K1]`.
- Statements marked **(inference)** or **(estimate)** are mine, not Cloudflare's. The basis is given next to them.
- The reference server has no licence, so this note describes its code and cites `the reference/src/<file>:<line>`. It does not copy it.

## 1. Answer

1. **Bodies can live in** R2, KV, D1 or a SQLite Durable Object. Workers static assets cannot hold them: files are uploaded at deploy time only `[A1][A3][A4]`.
2. **Metadata can live in** D1 or a SQLite Durable Object, the only two with SQL for "list by owner, filter by tag, count views". KV and R2 can only list keys by prefix `[K3][R3]`.
3. **Constraint 1, row size.** A D1 row or a Durable Object row holds at most 2,000,000 bytes (D1) or 2 MB (Durable Object) `[D1L][O1]`. The reference's own cap is 2 MiB = 2,097,152 bytes (`the reference/src/drops.ts:15`), which does not fit. Bodies "up to a few megabytes" in D1 or a Durable Object must be split across rows.
4. **Constraint 2, who is free.** Only R2 has a comfortable free body allowance (10 GB-month), but it needs an "R2 subscription" bought through a dashboard checkout `[R4][R6]`, and Cloudflare's billing pages treat R2 as a card-backed, usage-billed product `[B1][B2]`. KV (1 GB, **1,000 writes a day**) and D1 (500 MB) work on a Workers Free account with no payment method `[K1][D1L][D1P]`.
5. **Constraint 3, read-after-write.** R2, D1 (without read replicas) and a Durable Object let a Publisher read a Drop back at once, from anywhere `[R3][D1R][O3]`. KV does not promise it: other locations can show old or missing data for "up to 60 seconds or more" `[K3]`. The reference stays safe on KV only because each version gets a new key and the D1 pointer moves after the KV write (`the reference/src/drops.ts:288-290`).
6. **Upload size is not capped by the Workers request body limit** (100 MB on a Free account `[W1]`). What will bite first on Workers Free is the 10 ms CPU limit per request `[W1]`, and 100,000 Worker requests a day `[W1]`.
7. **View counts and rate limits:** a counter in KV is not workable (1,000 writes a day, one write per second per key) `[K1]`. D1 or a Durable Object costs one written row per increment `[D1P][O2]`. Analytics Engine can count but cannot be read back by a Worker without an API token `[X6]`. The Workers rate limiting binding only offers 10 s or 60 s windows, per location, and "permissive" accuracy `[X1]`.

## 2. Comparison table

Free plan means Workers Free, with no payment method on file (except where the R2 row says otherwise). Daily quotas reset at 00:00 UTC `[K2][D1P][O2]`. "Cell" citations point to the Sources list.

| | **Workers KV** | **R2** | **D1** | **Durable Objects, SQLite** | **Workers static assets** |
|---|---|---|---|---|---|
| **Maximum value, object or row size** | Value 25 MiB. Key 512 bytes. Key metadata 1,024 bytes `[K1]` | Object 5 TiB. Single-request upload 5 GiB. Object metadata 8,192 bytes. Same-key writes 1 per second, 429 above that `[R1]` | Row, string or BLOB 2,000,000 bytes. SQL statement 100,000 bytes. 100 columns. 100 bound parameters `[D1L]` | Row, string or BLOB 2 MB. Key plus value together 2 MB. SQL statement 100 KB `[O1]` | 25 MiB per file. 20,000 files per Worker version on Free `[W1]` |
| **Total storage, free plan** | 1 GB per account and per namespace `[K1]` | 10 GB-month, Standard class only `[R2P]` | 500 MB per database. 5 GB per account. 10 databases `[D1L]` | 5 GB per account `[O1]`. Per object: the limits table says 10 GB, the FAQ on the same page says 1 GB on Free (the page contradicts itself, see section 6) `[O1]` | No separate charge for storing assets `[A2]` |
| **Free-plan reads and writes, and what happens at the limit** | 100,000 reads, 1,000 writes (different keys), 1,000 deletes and 1,000 list requests a day. Same-key writes 1 per second. Over the limit: "further operations of that type will fail with an error" `[K1][K2]` | Monthly, not daily: 10M Class B (reads) and 1M Class A (writes, lists) a month. Over that: billed, rounded up to the next million `[R2P]`. The docs do not describe a hard stop (section 6) | 5M rows read and 100,000 rows written a day. Over the limit: queries "return errors" until the reset. Over the storage limit: no inserts until data is deleted `[D1P]` | 5M rows read and 100,000 rows written a day, plus 100,000 requests and 13,000 GB-s duration a day. Over any one: "further operations of that type will fail with an error" `[O2]` | Asset requests are "free and unlimited". Worker requests are 100,000 a day, then Error 1027. With `run_worker_first`, matching requests get a 429 `[A2][W1]` |
| **Paid pricing beyond the free allowance** | Reads $0.50 per million after 10M a month. Writes, deletes, lists $5.00 per million after 1M. Storage $0.50 per GB-month after 1 GB. No egress charge `[K2]` | Storage $0.015 per GB-month. Class A $4.50 per million. Class B $0.36 per million. Egress free, including reads through a Worker binding `[R2P]` | Rows read $0.001 per million after 25 billion a month. Rows written $1.00 per million after 50M. Storage $0.75 per GB-month after 5 GB. No egress charge `[D1P]` | Requests $0.15 per million after 1M a month. Duration $12.50 per million GB-s after 400,000. Rows read and written priced like D1. Storage $0.20 per GB-month after 5 GB `[O2]` | Assets stay free. Worker requests $0.30 per million after 10M a month `[W2]` |
| **Consistency, and does a read elsewhere see a write at once?** | Eventually consistent. The writing location "usually" sees it at once, "not guaranteed". Other locations: "up to 60 seconds or more". A missing key that was read before is cached too `[K3][K5]` | Strongly consistent. A written, updated or deleted object is seen "immediately, globally", including through a Worker binding `[R3]` | One primary location. Without read replication every query goes to the primary `[D1R]`, so (inference) a write is visible to the next read from anywhere. With replication, replicas lag and the Sessions API is needed for sequential consistency `[D1R]` | "Transactional and strongly consistent". Storage is private to one object, and all access goes through that object `[O3][O7]` | Not applicable. Files are fixed per deployment `[A1]` |
| **Created by `wrangler deploy` with no earlier step? Payment or opt-in?** | Yes: a binding with no id is created on deploy `[W3]`. No payment or opt-in. Included in Workers Free `[W2]` | Yes, R2 is on the automatic-provisioning list `[W3]`, but the account first needs an R2 subscription through a dashboard checkout. Without it the API answers error 10042 NotEntitled `[R4][R6]`. Billing pages describe a payment method and card pre-authorisation for usage-billed products, R2 named `[B1][B2]` | Yes: the database is created on deploy `[W3]`. The schema is not: migrations are a separate `wrangler d1 migrations apply` step `[D1M]`. No payment or opt-in `[D1P]` | Yes, with a class declared in the `exports` field. A class that appears only in code is ignored `[O5]`. SQLite classes work on Free. The schema is created by application code `[O1][O2]` | Yes, part of the same deploy `[A1]`. No payment or opt-in |
| **Backup or export** | `wrangler kv bulk get`, key listing, REST API `[K6]`. No snapshot or restore found in the pages read | S3-compatible API with rclone or AWS CLI `[R7]`. Bucket locks block deletion and overwrite `[R9]`. No object versioning: the S3 versioning calls are listed unsupported `[R7]`. 11-nines durability is not a backup `[R8]` | Time Travel, always on, no extra cost: 7 days on Free, 30 on Paid `[D1T]`. `wrangler d1 export` to a `.sql` file. A running export blocks other requests `[D1E]` | Point-in-time recovery to any point in the last 30 days, through bookmarks `[O3][O4]`. No whole-database export found (section 6) | The deployed files are the copy. Nothing to export (inference) |
| **Local development** | Simulated locally by default `[W4]` | Simulated locally by default `[W4]` | Full local support with the same D1 version `[D1D]` | Always runs locally `[W4]` | Served from local disk `[W4]` |

## 3. Findings by topic

### 3.1 Size limits, quotas and pricing

**KV: the daily write limit against a realistic publishing rate.**
- Free plan: 1,000 writes and 1,000 deletes a day, account-wide `[K1][K2]`. A reference-style publish is one KV write (`the reference/src/drops.ts:288` for a new Drop, `:420` for a new version).
- The reference also writes KV when a Viewer or crawler asks for a social-card image: one write per new Drop-version (`the reference/src/index.ts:349-370`), and one for the landing page (`:304-316`). Those draw on the same 1,000 writes.
- So 1,000 is the ceiling only if nothing else writes. If every new version also gets one card render, it is about 500 publishes a day **(estimate: 2 writes per publish)**.
- Deleting a Drop costs one KV delete per version (`the reference/src/drops.ts:664-666`, up to 200 versions), against 1,000 deletes a day.
- For one person or a small group publishing tens or low hundreds of versions a day this fits. A Publisher that loops, or an agent that republishes on every edit, can hit it. At the limit, writes fail with an error until 00:00 UTC `[K2]`.
- A bulk request counts as one operation against the 1,000-operations-per-invocation cap `[K1]`, but each key in it still counts as a write for the daily quota `[K2]`.

**R2.**
- The free tier is monthly: 10 GB-month, 1M Class A and 10M Class B operations. A publish is one `PutObject` (Class A) and a view is one `GetObject` (Class B) `[R2P]`.
- 1M Class A a month is about 33,000 a day on average. Over the allowance, usage is billed, not refused `[R2P]`. Egress is free for a Worker binding read `[R2P]`.
- The 5 GiB single-request cap and 1 per second per same key `[R1]` are not in the way for a Drop.

**D1.**
- Row, string or BLOB: 2,000,000 bytes `[D1L]`. Multi-megabyte HTML in one row is not possible. Up to 2,000,000 bytes it is possible but not sensible: row size does not change how rows are counted `[D1P]`, but every read of the row moves the whole body through a database that "processes queries one at a time" `[D1L]`.
- Splitting a body into chunks of at most about 1.9 MB, one row each, works inside the limit. The 100,000-byte statement limit may force chunks under 100 KB if bound values count towards it. The docs do not say (section 6).
- Free limits: 500 MB per database, 5 GB per account, 5M rows read and 100,000 rows written a day `[D1L][D1P]`. Indexes add a written row per indexed write `[D1P]`.
- Free plan: 50 queries per Worker invocation `[D1L]`.

**Durable Objects with SQLite.**
- Available on the Free plan, SQLite backend only `[O1][O2]`.
- Row, string or BLOB 2 MB, and key plus value 2 MB `[O1]`. The same chunking applies as for D1.
- Storage per account is 5 GB on Free `[O1]`. Per object, the limits page says 10 GB with a footnote capping Free at 5 GB total, and the same page's FAQ says "1 GB on the Free plan" `[O1]`. For planning, use 1 GB per object as the conservative reading.
- **Could one object hold an entire small Instance (metadata and bodies)?** Yes in count terms: one object, one SQLite database, unlimited rows `[O1]`. In bytes it depends on body size, see the capacity table below. In traffic terms every request for every Drop passes through that one object, which is "inherently single-threaded" with a soft limit of about 1,000 requests a second `[O1]`, and each call is a billed Durable Object request against the 100,000 a day free allowance `[O2]`.
- A single always-active object uses about 11,000 of the 13,000 free GB-s a day **(estimate: 86,400 s x 128 MB, the billed memory size `[O2]`)**, so duration is tight but not binding.
- Deploy complexity is covered in 3.3.

**Workers static assets.**
- **Confirmed: deploy-time only.** "During deployment, Wrangler automatically uploads the files from this directory" and Cloudflare deploys the Worker and the assets "in a single operation" as one unit `[A1]`. The assets binding offers only `fetch` for reading `[A3]`. The only other documented way to attach assets is the Workers API: submit a manifest, upload files, then upload a script version `[A4]`, which is a new Worker version.
- (Inference) A running Worker could in principle publish a new Worker version through that API for each Drop. It would need an API token with Workers write access stored inside the Instance, would create one deployment per publish, and is not described as a use case anywhere. It is not a storage layer.
- Limits if used for fixed files such as a landing page: 25 MiB per file and 20,000 files on Free `[W1]`.

**The Workers request body limit.**
- "Request body size limits depend on your Cloudflare account plan, not your Workers plan": Free 100 MB, Pro 100 MB, Business 200 MB, Enterprise up to 5 GB. Over the limit: `413` `[W1]`.
- R2's limits page says the same: a Worker's inbound request is capped by the Workers request limits, and the 5 GiB R2 upload cap does not apply to subrequests `[R1]`.
- So a few-megabyte Drop is far below the request cap on every plan. The limits that decide the largest Drop are the store's (KV 25 MiB, D1 and Durable Object row 2 MB, R2 effectively unlimited) and, on Free, CPU time.
- **CPU (inference, not measured):** Workers Free allows 10 ms of CPU per request `[W1]`. Parsing a multi-megabyte JSON body and hashing it is plausibly a large share of that. Streaming a raw HTML body straight into storage avoids the parse. The reference reads the whole JSON body at once (`the reference/src/drops.ts:214`).

**Storage capacity on the free plan, worst case next to typical.**
The table shows how many versions fit, using decimal sizes and ignoring row overhead and indexes. "Version" means one stored body.

| Size of one version | D1, 500 MB | KV, 1 GB | Durable Object, 1 GB (conservative) | R2, 10 GB |
|---|---|---|---|---|
| 100 KB (typical agent page) | about 5,000 | about 10,000 | about 10,000 | about 100,000 |
| 500 KB | about 1,000 | about 2,000 | about 2,000 | about 20,000 |
| 2 MB (the reference's cap, worst case) | about 250 | about 500 | about 500 | about 5,000 |

The reference allows up to 500 Drops a user and 200 versions a Drop (`the reference/src/drops.ts:19-20`). At 2 MB each that is far beyond any free store, so htmlgate needs its own version retention rule whichever store it picks.

### 3.2 Consistency: can a Publisher read a Drop back the instant after writing it?

**KV: the documented window.**
- The docs give no number for the writer's own location: changes "are usually immediately visible" there, "however, this is not guaranteed and therefore it is not advised to rely on this behaviour" `[K3]`.
- Elsewhere, "up to 60 seconds or more" `[K3]`. The 60 seconds is the default `cacheTtl`, minimum 30 `[K4]`.
- Locations that "recently read a previous version of a given key" take longer, and a read that found no key is cached too, so a key that did not exist can keep reading as missing `[K3][K5]`.
- **Publish-then-view (new key):** a new Drop is a new key. A Publisher that opens its URL straight away may land in another location. (Inference from the "How KV works" page: a location that has never read the key has nothing cached and goes to the central store, which already holds the write.) The docs do not carve out this case, and they warn about negative caching: if anything in that location (a crawler, a retrying Publisher) asked for the key before the write, it can keep answering "not found" for 60 seconds or more.
- **Update-then-view (same key rewritten):** stale for up to 60 seconds or more in other locations `[K3][K5]`. Any layout that overwrites a key in place, such as a "latest" key, has this problem.
- **Why the reference mostly avoids it:** every version has its own key, `html:<slug>:v<n>`. The body is written first (`the reference/src/drops.ts:288`, `:420`) and the D1 pointer `latest_version` moves second (`:290`, `:422`). A Viewer reads the pointer from D1 and only then asks KV for a key that is known to exist (`the reference/src/index.ts:719-726`). That makes a stale read unlikely, though the KV docs do not guarantee it.
- The reference's own design notes say "KV is globally consistent" (`the reference/docs/superpowers/specs/2026-05-10-recent-drops-feed-design.md:19`). The KV docs say the opposite `[K3]`. Treat the note in the reference as wrong.
- Cloudflare's own suggestion for stronger guarantees on KV: send writes through a Durable Object, and keep reading from KV `[K3]`.

**R2.**
- Strongly consistent. Write then read, metadata update, delete and listing are all seen "immediately, globally" `[R3]`.
- The one exception is when a custom domain with caching serves a public bucket: old objects and cached 404s can persist until the cache expires. "The cache does not affect access via Worker API bindings" `[R3]`. A Worker reading through its binding is not affected.
- Permission changes (API keys) are eventually consistent, up to a minute `[R3]`. Not relevant to a binding.

**D1.**
- Without read replication, "D1 routes all queries (both read and write) to a specific database instance in one location", the primary `[D1R]`. (Inference: so a write is visible to the next read from anywhere. The docs describe it but do not use the words "strongly consistent" for the no-replica case.)
- With read replication, replicas are "asynchronously" updated and "may be arbitrarily out of date" `[D1R]`. The Sessions API restores sequential consistency within a session, using a bookmark that must be passed along, for example in a header `[D1R]`.
- A Publisher's publish and a later browser view are different sessions. Either the bookmark has to travel with the URL or cookie, or the first query of each view must be forced to the primary with `withSession("first-primary")` `[D1R]`, which removes most of the benefit of replicas.
- Read replication is a per-database setting enabled in the dashboard or REST API `[D1R]`. The page does not say what a new database defaults to (section 6). An Instance of this size gains nothing from replicas.

**Durable Object.** Strongly consistent and transactional by design `[O3][O7]`. A read after a write sees it, because there is one instance.

### 3.3 What an Operator must do to enable each

- **Automatic provisioning** (`wrangler deploy` creates the resource): the docs list KV, R2, D1, Flagship, AI Search, Agent Memory, Dispatch Namespaces and Queues. Add the binding with no id, and the resource is created on deploy, named after the Worker. Ids are written back to the config file, except when the deploy came from the dashboard or a Git integration `[W3]`.
- **KV:** nothing. Workers Free includes it `[W2]`.
- **R2:** the account needs an R2 subscription, bought by a checkout flow in the dashboard (Storage and databases > R2 > Overview) `[R4]`. Without it the API returns error 10042, "Account not entitled to this feature. Ensure your account has an R2 subscription" `[R6]`.
  - Do the docs say a payment method is required? Not in one sentence. What they say: R2 is a usage-billed product with a free tier `[B2]`, "A primary payment method is required to purchase Cloudflare products and services" `[B3]`, and for usage-billed products Cloudflare "may preauthorize your credit card", after which a failed payment method means R2 "requests will return errors" and data may be deleted after 30 days `[B1]`.
  - Reading these together, an Operator with no card on file should expect to be blocked at the checkout. That is an inference, not a documented sentence, and it is listed in section 6.
  - R2 being on the automatic-provisioning list `[W3]` does not remove the subscription step (inference). What `wrangler deploy` does on an account that has not subscribed is not documented.
- **D1:** nothing for the database (auto-provisioned). The schema is a second step: `wrangler d1 migrations apply`, or code in the Worker that creates tables on first use. The pages read describe the apply command as its own step and do not say `deploy` runs it `[D1M]`. The reference ships a setup script that creates D1 and KV and applies the schema (`the reference/scripts/setup.mjs:33-52`, `the reference/package.json` scripts `setup` and `db:apply:remote`).
- **Durable Object (SQLite):** the class has to be declared in the Wrangler config `exports` field. "A class that appears only in your code is ignored until you declare it in `exports`; Cloudflare does not provision a namespace implicitly" `[O5]`. No extra step before the first deploy, and no payment `[O2]`. The application creates its tables (for example in the object's constructor).
  - What it does to deploy complexity `[O5]`:
    - `exports` replaces the older `migrations` array. A Worker can use only one of them, and once deployed with `exports` it cannot go back.
    - Deleting, renaming or transferring a class is declared through a state field on the entry. Deleting a class deletes its data, and there is no Trash for deleted namespaces.
    - Durable Object lifecycle changes apply only through `wrangler deploy`. `wrangler versions upload` fails fast if the config has `exports` entries.
    - A class rename is "not perfectly atomic" at the runtime layer, with a documented multi-step rollout.
  - Compared with D1 or KV, this is more config surface and a one-way door, in exchange for no separate database to create.
- **Static assets:** nothing. They ship with the deploy `[A1]`.

### 3.4 Query needs: list by owner, filter by tag, count views

**List by owner and filter by tag.**
- D1 and Durable Object SQLite handle both with an index and `WHERE`. The reference does exactly that in D1: an index on `(user_id, created_at DESC)` (`the reference/schema.sql:58-59`), and tags as a JSON text column filtered with `json_extract` (`the reference/src/db.ts:138-148`, `the reference/schema.sql:52`).
- That tag filter has no index. Rows read counts rows scanned `[D1P]`, so (inference) each filtered list reads about one row per Drop of that owner. At the reference's cap of 500 Drops that is 500 rows, a small part of 5M a day.
- KV can only list keys by prefix, 1,000 list requests a day on Free `[K1]`. Key metadata is limited to 1,024 bytes `[K1]`, so tags would need a hand-built index. R2 can list objects by prefix and the listing is strongly consistent `[R3]`, but each list is a Class A operation `[R2P]`.
- Conclusion: metadata wants D1 or a Durable Object. Neither KV nor R2 should be the system of record for metadata.

**Counting views: cost per increment.**

| Where the count lives | Cost per view | Free-plan fit |
|---|---|---|
| KV | One read and one write. Writes to one key are limited to 1 a second `[K1]`. | 1,000 writes a day for the whole account `[K1]`. Not workable. |
| R2 | One `PutObject` per update (Class A) `[R2P]` | Not a counter store. |
| D1 | One written row for `UPDATE ... SET view_count = view_count + 1`. An index on the counter column would add rows `[D1P]`. | 100,000 rows written a day. The reference bumps on every page view (`the reference/src/index.ts:620`, `the reference/src/db.ts:167-175`). |
| Durable Object | One written row `[O2]`. The object already received the request, so no extra request charge. | 100,000 rows written a day. A count held in memory and flushed in batches would cut writes (design idea, not from the docs). |
| Analytics Engine | `writeDataPoint()` is not awaited. Free: 100,000 data points and 10,000 read queries a day `[X4]`. | See below. |

Analytics Engine, more fully:
- Datasets are created on first write after the binding is declared, with no manual step `[X5]`.
- A Worker can write to it but not read it back with a binding. Reading is an HTTP call to the SQL API with an account API token that has "Account Analytics Read" `[X6]`. The Instance would have to hold that token as a secret, and the Operator would have to create it.
- It is sampled `[X2]`, keeps data for three months `[X3]`, and cannot be used for an `ORDER BY view_count` listing without that token and a query per list.
- The pricing page says: "Currently, you will not be billed" for it, with billing to start "in the coming months" `[X4]` (page last updated 2026-04-23, so this may be stale).
- Local development does not feed production data `[W4]`.

**Rate limiting.**
- The reference's limiter is a D1 table: one read query, and one write query unless the check is refused, (`the reference/src/db.ts:211-245`). A publish makes two checks (`the reference/src/drops.ts:186` and the daily one at `:197`), a version update makes one (`:320`), and the sign-in routes make more (`the reference/src/auth.ts:18`, `:76`; `the reference/src/github-oauth.ts:194`).
- Every authenticated API call also does a `last_used_at` write through `waitUntil` (`the reference/src/auth.ts:152`).
- **The Workers rate limiting binding** `[X1]`:
  - `limit({ key })` with a window of 10 or 60 seconds only.
  - Counters are local to each Cloudflare location and "permissive, eventually consistent, and intentionally designed to not be used as an accurate accounting system".
  - It adds no meaningful latency, needs no resource to create (a number in the Wrangler config), and is not visible in the dashboard.
  - It can replace the reference's per-minute limiter. It cannot express the reference's daily quota (`the reference/src/drops.ts:21`, `:197`), which would need a counter in D1 or a Durable Object.
  - The page does not say whether it is available or billed on the Free plan (section 6).
- Rate limits on D1 cost writes that count against the same 100,000 a day as everything else.

### 3.5 How the reference uses D1 plus KV, and what it costs it

Layout (`the reference/schema.sql:36-73`): D1 holds users, tokens, one `drops` row per Drop (with `latest_version`, `view_count`, JSON tags), one `versions` row per version, device-code verifications and a `rate_limits` table. KV holds bodies at `html:<slug>:v<n>`, plus caches: a Markdown copy of the landing page and rendered social-card PNGs (`the reference/src/index.ts:165-190`, `:304-316`, `:349-370`).

Cost per operation, as the code reads (D1 counts from the code, rows from the D1 rules `[D1P]`):

| Operation | D1 | KV | Where |
|---|---|---|---|
| Publish a new Drop (POST) | About 6 read queries, 3 single writes (token touch, 2 limiter updates) and one 2-statement batch. About 9 rows written once indexes are counted **(estimate)**. | 1 write | `the reference/src/auth.ts:146-152`, `the reference/src/drops.ts:186-306` |
| New version (PUT) | About 4 read queries, 1 limiter write, the token touch, one 2-statement batch | 1 write | `the reference/src/drops.ts:320-441` |
| View a Drop page | 2 read queries (Drop with author, version list) and 1 write (view count) | none | `the reference/src/index.ts:588-620` |
| Load the Drop body (the page frames `/p/<slug>/raw` in an iframe) | 1 read query | 1 read | `the reference/src/index.ts:700-726`, `the reference/src/views/viewer.ts:245-249` |
| Delete a Drop | 1 read, then 1 batch | 1 delete per version | `the reference/src/drops.ts:653-668` |

- **One view is two Worker requests**: the viewer page and the framed raw body. On Workers Free (100,000 requests a day `[W1]`) that is at most about 50,000 views a day before publishes and sign-ins **(estimate)**.
- **Cache headers:** the viewer page is `public, max-age=60, s-maxage=900` and `/raw` is `public, max-age=60, s-maxage=300`, but both are `private, no-store` for a passcode-protected Drop (`the reference/src/index.ts:629-631`, `:736-738`). The reference's own comment admits the view counter is then "a sampled-ish lower bound" because bumps only fire on cache misses (`:622-627`). The reference never calls the Cache API (no `caches.` anywhere in `the reference/src`).
- **For htmlgate this matters:** every Drop starts gated. A gated response must not be shared between Viewers, so (inference) it has to be `private, no-store` too. Every view then runs the Worker and pays the storage reads, and the counter is exact rather than sampled.
- **Consistency it relies on:** D1 primary for the pointer, immutable KV keys for bodies, write order body-then-pointer. There is no cleanup if the D1 batch fails after the KV write, so an orphaned body can remain (`the reference/src/drops.ts:288` then `:290`).
- **Free-plan fit:** the D1 numbers fit comfortably. The KV 1,000-writes-a-day limit is the tightest number in the design (3.1), and it is shared with the card-image cache writes. The reference's own setup creates D1 and KV with Wrangler commands (`the reference/scripts/setup.mjs:33-52`). Auto-provisioning would remove that script.

## 4. Options for htmlgate

The numbers are for a Workers Free Host. "Publishes a day" counts new Drops or new versions. Estimates use the reference's operation counts above, and none were measured.

### Option A: everything in D1 (metadata rows plus body chunks)

- **Operator before the first deploy:** nothing for the database (created on deploy `[W3]`). The schema needs `wrangler d1 migrations apply` or a first-request migration `[D1M]`. No payment.
- **Free ceiling:** storage 500 MB for the whole database, about 5,000 versions at 100 KB, about 250 at 2 MB. Writes: 100,000 rows a day. At about 9 rows a publish plus one row per body chunk that is on the order of 10,000 publishes a day **(estimate)**. In practice the Worker request limit (100,000 a day) and CPU time bind first.
- **Read-after-write:** immediate with no read replicas `[D1R]`. If an Operator turns replication on, it breaks unless every view uses `first-primary` or a bookmark.
- **What can go wrong:**
  - Chunking code. The 2,000,000-byte row cap sits below the reference's 2 MiB limit, and whether bound values count against the 100 KB statement limit is not documented.
  - The 500 MB database is a hard stop: at the limit no inserts, creating or altering tables, or indexes `[D1P]`.
  - One database is single-threaded. A 2 MB body read holds it, and a running export blocks other requests `[D1E]`.
  - Large reads count as rows read per chunk, which is cheap.
  - Backup is good: Time Travel for 7 days on Free `[D1T]`.

### Option B: D1 for metadata, KV for bodies (the reference's layout)

- **Operator before the first deploy:** nothing for either resource (both auto-provisioned `[W3]`), plus the D1 schema step. No payment.
- **Free ceiling:** 1,000 KV writes a day, about 500 publishes if each new version also gets a social card; 1,000 deletes a day; 1 GB of bodies, about 10,000 versions at 100 KB, about 500 at 2 MB; 100,000 KV reads a day, the same size as the 100,000 Worker requests a day. Bodies up to 25 MiB are fine `[K1]`.
- **Read-after-write:** safe when each version is a new immutable key written before the D1 pointer moves, as in the reference. The KV docs do not guarantee it, and they warn that a key already read as missing stays missing in that location for 60 seconds or more `[K3]`. Any in-place overwrite is stale for up to 60 seconds or more.
- **What can go wrong:**
  - Two stores with no cross-store transaction, so orphaned bodies after a failed write.
  - The 1,000-writes-a-day wall, which fails with errors until midnight UTC `[K2]`.
  - Deleting a Drop with many versions eats the delete quota.
  - A future change that overwrites a key breaks the "publish then open" promise.
  - No snapshot or restore for KV found.

### Option C: D1 for metadata, R2 for bodies

- **Operator before the first deploy:** an R2 subscription bought in the dashboard `[R4][R6]`. Billing pages imply a payment method is needed `[B1][B2][B3]`. After that the bucket is created on deploy `[W3]`, plus the D1 schema step. **This is the only layout with a prerequisite the Operator cannot script.**
- **Free ceiling:** 10 GB-month, about 5,000 versions at 2 MB or 100,000 at 100 KB. 1M Class A a month, about 33,000 publishes a day on average. 10M Class B a month, about 333,000 views a day on average. Past the allowance usage is billed, at $0.015 per GB-month and $4.50 per million writes `[R2P]`. Egress is free from a Worker `[R2P]`.
- **Read-after-write:** immediate and global through a Worker binding `[R3]`. The pointer-ordering discipline of Option B is not needed for correctness, though a new key per version is still the way to keep history, because R2 has no object versioning `[R7]`.
- **What can go wrong:**
  - The subscription step blocks Operators with no card, which is the common case this project names.
  - If a payment method later fails, R2 requests return errors and data can be deleted after 30 days `[B1]`.
  - Two stores again, with the same orphan risk.
  - Serving through a public bucket with a custom domain would reintroduce caching staleness, so serve through the Worker `[R3]`.

### Option D: one SQLite Durable Object (metadata and body chunks)

- **Operator before the first deploy:** nothing. No payment `[O2]`. The class is declared in `exports` `[O5]`, and the Worker creates its tables itself.
- **Free ceiling:** storage 5 GB per account, but plan on 1 GB per object (about 10,000 versions at 100 KB, about 500 at 2 MB) until the contradiction in the limits page is settled `[O1]`. Every Viewer and Publisher request is also a Durable Object request, 100,000 a day, as well as a Worker request `[O2][W1]`. Rows written 100,000 a day `[O2]`.
- **Read-after-write:** strongly consistent and transactional `[O3]`. The only option where the pointer and the body change in one transaction, which removes the orphan problem.
- **What can go wrong:**
  - Everything is serialised through one object: one 2 MB body read delays every other request (about 1,000 requests a second soft limit `[O1]`).
  - Row-size chunking, as for D1.
  - The `exports` mechanism is a one-way door with tombstone rules and no Trash for deleted classes `[O5]`.
  - Backup is point-in-time recovery for 30 days `[O3]`, but no whole-database export is documented (section 6).
  - The object lives in one place. (Inference: a Viewer far from it pays latency. Not covered in the pages read.)
  - Least familiar to most contributors.

### Not an option: Workers static assets for Drops

Deploy-time only (3.1). It remains the right place for the product's own fixed files.

## 5. How the options compare on the main requirement

| | A: D1 only | B: D1 + KV | C: D1 + R2 | D: one Durable Object |
|---|---|---|---|---|
| Works on Workers Free with no payment method | Yes | Yes | **No** (R2 subscription) | Yes |
| Publish-then-open guaranteed by the docs | Yes (no replicas) | **No**, unlikely to fail with immutable keys | Yes | Yes |
| Tightest free-plan number | 500 MB total | 1,000 writes a day | 1M writes a month, then billed | 100,000 requests a day, one object |
| Body size handling | Chunks under 2,000,000 bytes | One value, up to 25 MiB | One object | Chunks under 2 MB |
| One transaction for pointer plus body | Yes | No | No | Yes |
| Resources the Operator needs to understand | 1 | 2 | 2 plus a subscription | 1, with `exports` |

## 6. Not confirmed

- **Whether R2 requires a payment method before the first bucket.** Looked in: R2 get started, R2 pricing, R2 error codes, billing policy, usage-based billing, create billing profile `[R4][R2P][R6][B1][B2][B3]`. They say "R2 subscription", "checkout flow", error 10042, usage-based billing, and card pre-authorisation. No page states in one sentence "R2 needs a card on file before you can create a bucket". Also not documented: what `wrangler deploy` does on an account with no R2 subscription when an R2 binding is auto-provisioned.
- **What happens when an R2 free allowance is exceeded and no payment method works.** The pricing page says usage over the free tier is billed `[R2P]`. The only "errors" statement is for a failed payment method `[B1]`.
- **Whether the 100,000-byte D1 and Durable Object SQL statement limit counts bound parameter values.** Looked in: D1 limits, D1 prepared statements, D1 database API, D1 error list, Durable Object limits `[D1L]`. It decides whether body chunks can be about 1.9 MB or must stay under 100 KB.
- **Durable Object storage per object on the Free plan.** The limits table says 10 GB (with a footnote capping Free accounts at 5 GB total), and the FAQ on the same page says 1 GB on Free `[O1]`. Also, the pricing page still says SQLite storage billing "will be enabled in January 2026" `[O2]`. The December 2025 changelog says Free plan accounts "will not be charged" `[O6]`.
- **Durable Object export, and point-in-time recovery length on Free.** No whole-database export in the SQLite API or storage pages `[O3][O4]`. Point-in-time recovery says 30 days. D1 gives 7 days on Free, and the Durable Object pages do not split by plan.
- **D1 read replication default for a new database.** The page describes enabling it per database in the dashboard and a REST setting of `auto` or `disabled`, and does not say which a new database starts with `[D1R]`. The no-replica read-after-write conclusion assumes it is off.
- **Whether `wrangler deploy` applies D1 migrations.** Looked in: D1 migrations, Wrangler configuration `[D1M][W3]`. They describe `migrations apply` as a separate command and do not say deploy runs it.
- **KV propagation in practice.** The docs give "up to 60 seconds or more" and no upper bound or measurement `[K3]`. Whether a never-read key is visible at once from another location is only an inference from the architecture page.
- **KV backup or restore.** Only bulk get, key listing and the REST API found `[K6]`. No snapshot feature found.
- **Free-plan status, pricing and limits behaviour of the Workers rate limiting binding.** The binding page is silent `[X1]`, and the Workers pricing and limits pages do not list it `[W1][W2]`. Analytics Engine is not yet billed but billing is announced as coming `[X4]` (page dated 2026-04-23).
- **Which Cloudflare plan's request-body limit applies to a `workers.dev` Worker with no zone.** The docs tie the limit to the account plan `[W1]` and do not say how a zoneless Worker maps to it.
- **CPU cost on Workers Free (10 ms) of parsing and storing a multi-megabyte Drop.** Not measured. The 10 ms figure is documented `[W1]`, and the share a 2 MB body takes is my inference.
- **Whether the reference's `s-maxage` headers cause any edge caching of Worker responses.** The reference never calls the Cache API. I did not research Cloudflare's "Workers Caching" feature mentioned in `[W2]`. It affects what the reference's real view cost is, not the choice of store.
- **Exact rows written per publish.** The 9-row figure is my count from the reference's schema and the D1 index rule `[D1P]`. Not measured.

## 7. Sources

All read on 2026-10-05 as Markdown from `https://developers.cloudflare.com/<path>/index.md`. "Updated" is the date shown on the page.

| Tag | Page | Updated |
|---|---|---|
| K1 | `/kv/platform/limits/` | 2026-04-21 |
| K2 | `/kv/platform/pricing/` | 2026-04-21 |
| K3 | `/kv/concepts/how-kv-works/` | 2026-04-21 |
| K4 | `/kv/api/read-key-value-pairs/` | 2026-06-22 |
| K5 | `/kv/api/write-key-value-pairs/` | 2026-06-22 |
| K6 | `/workers/wrangler/commands/kv/` | 2026-04-23 |
| R1 | `/r2/platform/limits/` | 2026-06-08 |
| R2P | `/r2/pricing/` | 2026-10-01 |
| R3 | `/r2/reference/consistency/` | 2026-04-30 |
| R4 | `/r2/get-started/` | 2026-04-21 |
| R6 | `/r2/api/error-codes/` | 2026-07-31 |
| R7 | `/r2/api/s3/api/` | 2026-07-31 |
| R8 | `/r2/reference/durability/` | 2026-04-21 |
| R9 | `/r2/buckets/bucket-locks/` | 2026-04-30 |
| D1L | `/d1/platform/limits/` | 2026-04-21 |
| D1P | `/d1/platform/pricing/` | 2026-04-21 |
| D1R | `/d1/best-practices/read-replication/` | 2026-08-10 |
| D1T | `/d1/reference/time-travel/` | 2026-04-21 |
| D1E | `/d1/best-practices/import-export-data/` | 2026-04-21 |
| D1M | `/d1/reference/migrations/` | 2026-06-08 |
| D1D | `/d1/best-practices/local-development/` | 2026-06-25 |
| O1 | `/durable-objects/platform/limits/` | 2026-06-01 |
| O2 | `/durable-objects/platform/pricing/` | 2026-09-30 |
| O3 | `/durable-objects/api/sqlite-storage-api/` | 2026-09-21 |
| O4 | `/durable-objects/best-practices/access-durable-objects-storage/` | 2026-07-03 |
| O5 | `/durable-objects/reference/durable-objects-migrations/` | 2026-09-28 |
| O6 | `/changelog/post/2025-12-12-durable-objects-sqlite-storage-billing/` | 2025-12-12 |
| O7 | `/durable-objects/concepts/what-are-durable-objects/` | 2026-07-15 |
| A1 | `/workers/static-assets/` | 2026-07-03 |
| A2 | `/workers/static-assets/billing-and-limitations/` | 2026-04-23 |
| A3 | `/workers/static-assets/binding/` | 2026-09-04 |
| A4 | `/workers/static-assets/direct-upload/` | 2026-08-10 |
| W1 | `/workers/platform/limits/` | 2026-09-05 |
| W2 | `/workers/platform/pricing/` | 2026-10-02 |
| W3 | `/workers/wrangler/configuration/` (Automatic provisioning) | 2026-10-05 |
| W4 | `/workers/local-development/` | 2026-08-20 |
| X1 | `/workers/runtime-apis/bindings/rate-limit/` | 2026-04-23 |
| X2 | `/analytics/analytics-engine/sampling/` | 2026-04-23 |
| X3 | `/analytics/analytics-engine/limits/` | 2026-04-23 |
| X4 | `/analytics/analytics-engine/pricing/` | 2026-04-23 |
| X5 | `/analytics/analytics-engine/get-started/` | 2026-04-23 |
| X6 | `/analytics/analytics-engine/sql-api/` | 2026-10-02 |
| B1 | `/billing/understand/billing-policy/` | 2026-05-29 |
| B2 | `/billing/understand/usage-based-billing/` | 2026-05-29 |
| B3 | `/billing/get-started/create-billing-profile/` | 2026-05-29 |

Reference server, read from a local clone at commit `ac00be7`: `the reference/schema.sql`, `the reference/src/db.ts`, `the reference/src/drops.ts`, `the reference/src/index.ts`, `the reference/src/auth.ts`, `the reference/src/github-oauth.ts`, `the reference/src/views/viewer.ts`, `the reference/scripts/setup.mjs`, `the reference/package.json`, `the reference/docs/superpowers/specs/2026-05-10-recent-drops-feed-design.md`.
