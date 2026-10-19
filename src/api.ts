// The Publisher API, which the htmlgate CLI (packages/cli) speaks. A Version is published as JSON ({html}, a page)
// or as a zip (a site, plan 009); every Share carries an expiry (plan 008).
import type { Config, Env } from "./config";
import { fail, HttpError, json, noContent, readCapped, readCappedBytes, stream } from "./http";
import { POSITIVE, SLUG, TOKEN, TOKEN_ID, newSlug, sha256Hex } from "./ids";
import { KEEP_VERSIONS, Store, type Body, type ShareRow, type Expiry, type TokenRow } from "./store";
import { encodeIndex, readSite, SITE_LIMITS, SiteError, type SiteEntry } from "./zip";

// The htmlgate CLI refuses a larger file before sending it (packages/cli/src/files.ts).
export const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 500;
const MAX_TAGS = 10;
const TAG_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_TAG_VALUE = 256;
// JSON escaping can make a body up to six times longer (\u0001 for one byte), plus the other fields.
const MAX_REQUEST_BYTES = 6 * MAX_HTML_BYTES + 64 * 1024;
// A request that carries only fields (PATCH, visibility) has no HTML to make room for.
const MAX_FIELDS_BYTES = 64 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
// A date a Publisher sets is at least a minute and at most ten years ahead.
const MIN_EXPIRY_MS = 60 * 1000;
const MAX_EXPIRY_MS = 3650 * DAY_MS;

type Fields = { html?: string; title?: string; description?: string | null; metadata?: Record<string, string>; expires_at?: number | null };

export async function handleApi(req: Request, env: Env, ctx: ExecutionContext, cfg: Config, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").slice(2); // after "/api"
  const method = req.method;

  if (parts.length === 1 && parts[0] === "onboard" && method === "GET") return onboard(url, cfg);

  const store = new Store(env.DB, env.BODIES);
  const token = await authenticate(req, store);
  if (!token) return fail(401, "unauthorized", "Send a valid token as 'Authorization: Bearer hg_...'.");
  if (token.author !== cfg.author) return fail(401, "unauthorized", "This token belongs to no Author on this Instance.");

  if (method !== "GET") {
    // Fails closed: without its limit, a leaked token could write without bound.
    if (!env.WRITE_LIMIT) return fail(503, "server_misconfigured", "This Instance is missing its write limit. The Operator must run setup.");
    const { success } = await env.WRITE_LIMIT.limit({ key: token.id });
    if (!success) return fail(429, "rate_limited", "Too many changes from this token. Wait a minute.", { "retry-after": "60" });
  }

  try {
    return await route(req, store, cfg, token, url, parts);
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.code, e.message);
    throw e;
  } finally {
    // Due bodies (pruned, deleted, or a refused write's upload) are deleted from R2 after the answer, and retried
    // on later writes.
    if (method !== "GET") ctx.waitUntil(store.emptyTrash().catch((e) => console.error("trash", e)));
  }
}

async function route(req: Request, store: Store, cfg: Config, token: TokenRow, url: URL, parts: string[]): Promise<Response> {
  const method = req.method;
  const [a, b, c, d] = parts;
  if (a === "shares") {
    if (b === undefined) {
      if (method === "GET") return await list(store, cfg, url);
      if (method === "POST") return await create(req, store, cfg, token, url);
    } else if (SLUG.test(b) && parts.length === 5 && c === "versions" && d !== undefined && POSITIVE.test(d) && parts[4] === "zip" && method === "GET") {
      return await zipOf(store, cfg, b, Number(d));
    } else if (SLUG.test(b) && parts.length <= 4) {
      // Paths are matched exactly: the longest is shares/:slug/versions/:n(/zip), and nothing may follow it.
      if (c === undefined) {
        if (method === "GET") return shareJson(await mustShare(store, cfg, b), url);
        if (method === "PUT") return await replace(req, store, cfg, token, b, url);
        if (method === "PATCH") return await patch(req, store, cfg, token, b, url);
        if (method === "DELETE") return await remove(store, cfg, token, b);
      } else if (c === "versions" && d === undefined && method === "GET") {
        await mustShare(store, cfg, b);
        const rows = await store.versions(b);
        return json(200, { data: rows.map((v) => ({ n: v.n, kind: v.kind, size: v.size, created_at: v.created_at, token: { id: v.token_id, name: v.token_name } })) });
      } else if (c === "versions" && d !== undefined && POSITIVE.test(d) && method === "GET") {
        await mustShare(store, cfg, b);
        const v = await store.version(b, Number(d));
        if (!v) return fail(404, "version_not_found", "That Version does not exist or is no longer kept.");
        const common = { n: v.n, kind: v.kind, size: v.size, created_at: v.created_at, token_id: v.token_id };
        return json(200, v.kind === "site" ? { ...common, files: v.files } : { ...common, html: v.body });
      } else if (c === "visibility" && d === undefined && method === "POST") {
        return await visibility(req, store, cfg, token, b, url);
      }
    } else if (parts.length === 2) {
      return fail(404, "not_found", "No such Share.");
    }
  } else if (a === "tokens") {
    if (b === undefined && method === "GET") {
      return json(200, { data: await store.listTokens(cfg.author) });
    }
    if (b !== undefined && TOKEN_ID.test(b) && c === undefined && method === "DELETE") {
      return (await store.revokeToken(cfg.author, b, Date.now())) ? noContent() : fail(404, "not_found", "No live token has that id.");
    }
  } else if (a === "metrics") {
    // The page counts live in Workers Analytics Engine, which a Worker writes and cannot read: `metrics:sync` reads
    // them with the Operator's own Cloudflare login and replaces this snapshot. Writing it needs the Author's token.
    if (b === undefined && method === "PUT") return await putMetrics(req, store);
  }
  return fail(404, "not_found", "No such request. See /api/onboard.");
}

async function authenticate(req: Request, store: Store): Promise<TokenRow | null> {
  const m = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m || !TOKEN.test(m[1]!)) return null;
  const row = await store.tokenByDigest(await sha256Hex(m[1]!));
  if (row) await store.touchToken(row.id, Date.now());
  return row;
}

function onboard(url: URL, cfg: Config): Response {
  return json(200, {
    name: "htmlgate",
    api_url: url.origin,
    token_format: "hg_ followed by 40 letters and digits",
    auth: "Authorization: Bearer <token>. Tokens come from the Author's /tokens page or the Operator's `pnpm run token create`.",
    limits: {
      html_bytes: MAX_HTML_BYTES, title: MAX_TITLE, description: MAX_DESCRIPTION, tags: MAX_TAGS, versions_kept: KEEP_VERSIONS,
      site_zip_bytes: SITE_LIMITS.zipBytes, site_files: SITE_LIMITS.files, site_file_bytes: SITE_LIMITS.fileBytes,
      site_total_bytes: SITE_LIMITS.totalBytes, site_path_bytes: SITE_LIMITS.pathBytes,
    },
    expiry: {
      default_days: cfg.expiryDays,
      rule: "A Share expires default_days after its latest publish (never when 0), unless a Publisher sets expires_at: "
        + "milliseconds since the epoch, 1 minute to 3650 days ahead, or null for never. A set date stays until changed. "
        + "An expired Share answers 404 everywhere immediately. Its bodies are deleted in bounded hourly cleanup batches, "
        + "with retries on later runs; backlog or failures can delay physical deletion beyond an hour. There is no guaranteed deletion deadline.",
    },
    requests: [
      "POST /api/shares {html, title, description?, metadata?, expires_at?} -> 201 Share (starts gated)",
      "POST /api/shares?title=&description=&metadata.<key>=&expires_at=<ms>|never with Content-Type: application/zip -> 201 Share (a site)",
      "GET /api/shares?page&pageSize&sortBy=updated_at|created_at&public=true|false&metadata.<key>=<value>",
      "GET /api/shares/:slug",
      "PUT /api/shares/:slug {html, title?, description?, metadata?, expires_at?} -> new Version",
      "PUT /api/shares/:slug?title=&... with Content-Type: application/zip -> new Version (a site)",
      "PATCH /api/shares/:slug {title?, description?, metadata?, expires_at?}",
      "DELETE /api/shares/:slug -> 204 (soft delete)",
      "POST /api/shares/:slug/visibility {public: true|false}",
      "GET /api/shares/:slug/versions",
      "GET /api/shares/:slug/versions/:n -> includes html (a page) or files (a site)",
      "GET /api/shares/:slug/versions/:n/zip -> a site's zip",
      "GET /api/tokens",
      "DELETE /api/tokens/:id -> 204",
    ],
    errors: '{"error": {"code": string, "message": string}}',
  });
}

function viewerUrl(url: URL, slug: string, isPublic: boolean) {
  return `${url.origin}/${isPublic ? "p" : "s"}/${slug}`;
}

function shareJson(d: ShareRow, url: URL, status = 200): Response {
  return json(status, shareObject(d, url));
}

function shareObject(d: ShareRow, url: URL) {
  return {
    slug: d.slug,
    title: d.title,
    description: d.description,
    url: viewerUrl(url, d.slug, d.public === 1),
    public: d.public === 1,
    latest_version: d.latest_version,
    metadata: JSON.parse(d.tags),
    expires_at: d.expires_at,
    created_at: d.created_at,
    updated_at: d.updated_at,
    changed_by: { id: d.changed_by, name: d.changed_by_name },
    changed_at: d.changed_at,
  };
}

async function mustShare(store: Store, cfg: Config, slug: string): Promise<ShareRow> {
  const d = await store.share(cfg.author, slug);
  if (!d) throw new HttpError(404, "not_found", "No such Share.");
  return d;
}

async function readBody(req: Request, fieldsOnly = false): Promise<Record<string, unknown>> {
  const raw = await readCapped(req, fieldsOnly ? MAX_FIELDS_BYTES : MAX_REQUEST_BYTES);
  if (raw === null) {
    throw fieldsOnly
      ? new HttpError(413, "body_too_large", `This request is at most ${MAX_FIELDS_BYTES} bytes.`)
      : new HttpError(413, "html_too_large", `A Share is at most ${MAX_HTML_BYTES} bytes.`);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_json", "The body is not valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "invalid_json", "The body must be a JSON object.");
  return body as Record<string, unknown>;
}

/**
 * A publish's body and fields: JSON with html (a page), or a zip with its fields in the query string (a site).
 * The zip is checked whole (src/zip.ts) before anything is stored.
 */
async function readPublish(req: Request, url: URL): Promise<{ f: Fields; body: (Body & { size: number }) | undefined }> {
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/zip") {
    const f = parseFields(await readBody(req), ["html", "title", "description", "metadata", "expires_at"]);
    return { f, body: f.html === undefined ? undefined : { body: f.html, kind: "page", files: null, size: f.size! } };
  }
  const zip = await readCappedBytes(req, SITE_LIMITS.zipBytes);
  if (zip === null) throw new HttpError(413, "site_too_large", `A site's zip is at most ${SITE_LIMITS.zipBytes} bytes.`);
  const f = parseFields(queryFields(url), ["title", "description", "metadata", "expires_at"]);
  let entries: SiteEntry[];
  try {
    entries = await readSite(zip);
  } catch (e) {
    if (e instanceof SiteError) throw new HttpError(e.code === "site_too_large" ? 413 : 400, e.code, e.message);
    throw e;
  }
  return { f, body: { body: zip, kind: "site", files: encodeIndex(entries), size: zip.length } };
}

/** A zip publish's fields from its query string, in the shape a JSON body would give them. */
function queryFields(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  const metadata: Record<string, string> = Object.create(null);
  for (const [k, v] of url.searchParams) {
    if (k === "html") throw new HttpError(400, "invalid_arg", "A zip publish carries its files in the zip, not html.");
    if (k.startsWith("metadata.")) metadata[k.slice("metadata.".length)] = v;
    else if (k === "expires_at") out.expires_at = v === "never" ? null : /^[0-9]{1,16}$/.test(v) ? Number(v) : v;
    else if (Object.hasOwn(out, k)) throw new HttpError(400, "invalid_arg", `'${k}' is given twice.`);
    else out[k] = v;
  }
  if (Object.keys(metadata).length) out.metadata = metadata;
  return out;
}

/** The expiry a publish leaves: the date it sets, or the Instance's default from now. */
function expiryOf(f: Fields, cfg: Config, now: number): Expiry {
  if (f.expires_at !== undefined) return { at: f.expires_at, set: true };
  return { at: cfg.expiryDays > 0 ? now + cfg.expiryDays * DAY_MS : null, set: false };
}

/** Checks the fields a request may carry. `allowed` names them; anything else is refused. */
function parseFields(body: Record<string, unknown>, allowed: (keyof Fields)[]): Fields & { size?: number } {
  for (const key of Object.keys(body)) {
    if (key === "public") throw new HttpError(400, "invalid_arg", "Publishing never changes the gate. Use POST /api/shares/:slug/visibility.");
    if (key === "passcode") throw new HttpError(400, "invalid_arg", "htmlgate has no passcodes. Shares are gated; use POST /api/shares/:slug/visibility to make one public.");
    if (key === "html" && !allowed.includes("html")) throw new HttpError(400, "metadata_only_on_patch", "PATCH changes title, description and metadata only. Use PUT for new HTML.");
    if (!(allowed as string[]).includes(key)) throw new HttpError(400, "invalid_arg", `Unknown field '${key}'.`);
  }
  const out: Fields & { size?: number } = {};
  if (body.html !== undefined) {
    if (typeof body.html !== "string") throw new HttpError(400, "invalid_arg", "html must be a string.");
    const size = new TextEncoder().encode(body.html).length;
    if (size > MAX_HTML_BYTES) throw new HttpError(413, "html_too_large", `A Share is at most ${MAX_HTML_BYTES} bytes; this one is ${size}.`);
    out.html = body.html;
    out.size = size;
  }
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || body.title.trim() === "") throw new HttpError(400, "title_required", "title must be a non-empty string.");
    if (body.title.length > MAX_TITLE) throw new HttpError(400, "title_too_long", `title is at most ${MAX_TITLE} characters.`);
    out.title = body.title;
  }
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== "string") throw new HttpError(400, "invalid_arg", "description must be a string.");
    if (body.description.length > MAX_DESCRIPTION) throw new HttpError(400, "description_too_long", `description is at most ${MAX_DESCRIPTION} characters.`);
    out.description = body.description;
  } else if (body.description === null) {
    out.description = null;
  }
  if (body.metadata !== undefined) {
    const m = body.metadata;
    if (typeof m !== "object" || m === null || Array.isArray(m)) throw new HttpError(400, "invalid_arg", "metadata must be an object of strings.");
    const entries = Object.entries(m);
    if (entries.length > MAX_TAGS) throw new HttpError(400, "invalid_arg", `metadata has at most ${MAX_TAGS} keys.`);
    for (const [k, v] of entries) {
      if (!TAG_KEY.test(k)) throw new HttpError(400, "invalid_arg", `metadata key '${k}' must be 1 to 64 letters, digits, '_', '.' or '-'.`);
      if (typeof v !== "string" || v.length > MAX_TAG_VALUE) throw new HttpError(400, "invalid_arg", `metadata value for '${k}' must be a string of at most ${MAX_TAG_VALUE} characters.`);
    }
    out.metadata = m as Record<string, string>;
  }
  if (body.expires_at !== undefined) {
    const at = body.expires_at;
    const now = Date.now();
    if (at !== null && (typeof at !== "number" || !Number.isSafeInteger(at) || at < now + MIN_EXPIRY_MS || at > now + MAX_EXPIRY_MS)) {
      throw new HttpError(400, "invalid_expiry", "expires_at is milliseconds since the epoch, from 1 minute to 3650 days ahead, or null for never.");
    }
    out.expires_at = at;
  }
  return out;
}

const noRoom = () =>
  new HttpError(507, "quota_exceeded", "This Instance has no room left for Shares. Deleted Shares count until they expire: tell the Operator.");

async function create(req: Request, store: Store, cfg: Config, token: TokenRow, url: URL) {
  const { f, body } = await readPublish(req, url);
  if (body === undefined) throw new HttpError(400, "html_required", "html is required.");
  if (f.title === undefined) throw new HttpError(400, "title_required", "title is required.");
  const slug = newSlug();
  const now = Date.now();
  const created = await store.createShare({
    ...body, slug, author: cfg.author, title: f.title, description: f.description ?? null, tags: JSON.stringify(f.metadata ?? {}),
    tokenId: token.id, now, limit: cfg.storageLimit, expiry: expiryOf(f, cfg, now),
  });
  if (created === "full") throw noRoom();
  // Only an upload that outlived its reservation (an hour) gets here.
  if (created === "gone") throw new HttpError(503, "busy", "The upload took too long. Try again.");
  return shareJson(await mustShare(store, cfg, slug), url, 201);
}

async function replace(req: Request, store: Store, cfg: Config, token: TokenRow, slug: string, url: URL) {
  // Before the body: checking a zip is the costly part, and a Share that is not there needs none of it.
  await mustShare(store, cfg, slug);
  const { f, body } = await readPublish(req, url);
  if (body === undefined) throw new HttpError(400, "html_required", "PUT needs html or a zip. Use PATCH to change only fields.");
  const now = Date.now();
  const added = await store.addVersion({
    ...body, author: cfg.author, slug,
    title: f.title,
    description: f.description,
    tags: f.metadata !== undefined ? JSON.stringify(f.metadata) : undefined,
    tokenId: token.id, now, limit: cfg.storageLimit, expiry: expiryOf(f, cfg, now),
  });
  if (added === "full") throw noRoom();
  // Nothing was written: the Share was deleted meanwhile, or (rarely) the upload outlived its reservation.
  if (added === "gone") throw (await store.share(cfg.author, slug)) ? new HttpError(503, "busy", "The upload took too long. Try again.") : new HttpError(404, "not_found", "No such Share.");
  return shareJson(await mustShare(store, cfg, slug), url);
}

async function patch(req: Request, store: Store, cfg: Config, token: TokenRow, slug: string, url: URL) {
  const f = parseFields(await readBody(req, true), ["title", "description", "metadata", "expires_at"]);
  await mustShare(store, cfg, slug);
  if (Object.keys(f).length === 0) throw new HttpError(400, "invalid_arg", "PATCH needs title, description, metadata or expires_at.");
  await store.updateFields(cfg.author, slug, {
    title: f.title, description: f.description,
    tags: f.metadata !== undefined ? JSON.stringify(f.metadata) : undefined,
    expiresAt: f.expires_at,
  }, token.id, Date.now());
  return shareJson(await mustShare(store, cfg, slug), url);
}

/** A site Version's zip, as published, for a Publisher to change and publish again. */
async function zipOf(store: Store, cfg: Config, slug: string, n: number) {
  await mustShare(store, cfg, slug);
  const v = await store.version(slug, n);
  if (!v || v.kind !== "site") return fail(404, "version_not_found", "That Version does not exist, is no longer kept, or is a page.");
  const body = await store.bodyStream(v.body_key);
  if (!body) console.error("missing body", v.body_key);
  if (!body) return fail(404, "version_not_found", "That Version's zip is gone.");
  return stream(body, "application/zip", {
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-disposition": `attachment; filename="${slug}-v${n}.zip"`,
  });
}

async function remove(store: Store, cfg: Config, token: TokenRow, slug: string) {
  if (!(await store.deleteShare(cfg.author, slug, token.id, Date.now()))) throw new HttpError(404, "not_found", "No such Share.");
  return noContent();
}

async function visibility(req: Request, store: Store, cfg: Config, token: TokenRow, slug: string, url: URL) {
  const body = await readBody(req, true);
  if (Object.keys(body).length !== 1 || typeof body.public !== "boolean") {
    throw new HttpError(400, "invalid_arg", "Send exactly {\"public\": true} or {\"public\": false}.");
  }
  await mustShare(store, cfg, slug);
  await store.setPublic(cfg.author, slug, body.public, token.id, Date.now());
  return shareJson(await mustShare(store, cfg, slug), url);
}

/** What one sync records: the site the counts belong to, when it was read, and one row per page. */
async function putMetrics(req: Request, store: Store): Promise<Response> {
  const body = await readBody(req, true);
  const { origin, generated_at: generatedAt, pages } = body;
  if (typeof origin !== "string" || origin.length > 200) throw new HttpError(400, "invalid_arg", "origin must be the site's http(s) URL.");
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HttpError(400, "invalid_arg", "origin must be the site's http(s) URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new HttpError(400, "invalid_arg", "origin must be the site's http(s) URL.");
  if (typeof generatedAt !== "number" || !Number.isSafeInteger(generatedAt) || generatedAt <= 0) {
    throw new HttpError(400, "invalid_arg", "generated_at must be the time the counts were read, in milliseconds.");
  }
  if (!Array.isArray(pages) || pages.length > 500) throw new HttpError(400, "invalid_arg", "pages must be an array of at most 500 rows.");
  const rows: { page: string; views: number; last_seen: number }[] = [];
  for (const row of pages) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) throw new HttpError(400, "invalid_arg", "Every page row needs page, views and last_seen.");
    const { page, views, last_seen: lastSeen } = row as Record<string, unknown>;
    // A page is a path on that site, or the counter's own "404" bucket; never a URL, query or control character.
    if (typeof page !== "string" || page.length > 96 || !(page === "404" || /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(page))) {
      throw new HttpError(400, "invalid_arg", "Each page must be a path on the site, or 404.");
    }
    if (typeof views !== "number" || !Number.isSafeInteger(views) || views < 0) throw new HttpError(400, "invalid_arg", "Each row needs a whole, non-negative views count.");
    if (typeof lastSeen !== "number" || !Number.isSafeInteger(lastSeen) || lastSeen < 0) throw new HttpError(400, "invalid_arg", "Each row needs last_seen in milliseconds.");
    rows.push({ page, views, last_seen: lastSeen });
  }
  await store.putMetrics(parsed.origin, generatedAt, JSON.stringify(rows));
  return json(200, { origin: parsed.origin, generated_at: generatedAt, pages: rows.length });
}

async function list(store: Store, cfg: Config, url: URL) {
  const p = url.searchParams;
  const rawPage = p.get("page") ?? "1";
  const rawSize = p.get("pageSize") ?? "50";
  const sort = p.get("sortBy") ?? "updated_at";
  if (!POSITIVE.test(rawPage)) throw new HttpError(400, "invalid_arg", "page must be a whole number from 1.");
  if (!POSITIVE.test(rawSize) || Number(rawSize) > 200) throw new HttpError(400, "invalid_arg", "pageSize must be from 1 to 200.");
  const page = Number(rawPage);
  const pageSize = Number(rawSize);
  if (sort !== "updated_at" && sort !== "created_at") throw new HttpError(400, "invalid_arg", "sortBy must be updated_at or created_at.");
  const tags: [string, string][] = [];
  for (const [k, v] of p) {
    if (!k.startsWith("metadata.")) continue;
    const key = k.slice("metadata.".length);
    if (!TAG_KEY.test(key)) throw new HttpError(400, "invalid_arg", `metadata key '${key}' is not valid.`);
    tags.push([key, v]);
  }
  if (tags.length > MAX_TAGS) throw new HttpError(400, "invalid_arg", `Filter on at most ${MAX_TAGS} keys.`);
  const pub = p.get("public");
  if (pub !== null && pub !== "true" && pub !== "false") throw new HttpError(400, "invalid_arg", "public must be true or false.");
  const { total, rows } = await store.listShares(cfg.author, { tags, public: pub === null ? undefined : pub === "true", sort, page, pageSize });
  const data = rows.map((r) => shareObject(r, url));
  return json(200, { data, pagination: { page, page_size: pageSize, total, total_pages: Math.max(1, Math.ceil(total / pageSize)) } });
}
