// All storage. D1 holds metadata and the key of each body; R2 holds the bodies (issue #14, revised).
// Every D1 change is one batch, which D1 runs as one transaction. D1 and R2 cannot commit together, so:
// a body is uploaded under a key used once, before the batch that points at it; a body that leaves the
// window is queued in `trash` by that same batch and deleted from R2 afterwards, with retries.
// A Version is a page (one HTML body) or a site (one zip, its file index in `versions.files`, plan 009).
// A Share past its `expires_at` is missing to every read and write, and `expire` purges it (plan 008).
import { randomHex } from "./ids";
import { decodeEntry, entryStream, listIndex, type SiteEntry } from "./zip";

export const KEEP_VERSIONS = 20;

export interface TokenRow {
  id: string;
  author: string;
  name: string;
}

export interface ShareRow {
  slug: string;
  author: string;
  title: string;
  description: string | null;
  tags: string;
  public: number;
  latest_version: number;
  created_at: number;
  updated_at: number;
  changed_by: string;
  changed_by_name: string | null;
  changed_at: number;
  expires_at: number | null;
}

export type Kind = "page" | "site";

/**
 * When a write leaves the Share to expire. `set`: a Publisher chose `at` (null: never), and it stays until a Publisher
 * changes it. Not set: `at` is the Instance's default from now, applied to a Share whose date came from the default.
 */
export interface Expiry {
  at: number | null;
  set: boolean;
}

/** A Version's body as a write receives it: one HTML page, or a site's zip with its file index (JSON). */
export type Body = { body: string; kind: "page"; files: null } | { body: Uint8Array; kind: "site"; files: string };

const SHARE_COLUMNS = `d.slug, d.author, d.title, d.description, d.tags, d.public, d.latest_version,
  d.created_at, d.updated_at, d.changed_by, t.name AS changed_by_name, d.changed_at, d.expires_at`;

// The trash ledger holds every body in R2 that no Version points at: pruned and deleted ones, and uploads not yet
// claimed by their write. due_at is when a body may be deleted. A write first reserves room for its body in the
// ledger (refused when the cap would be passed), due an hour later, and only then uploads it. It claims the body
// (removes the row) in the same transaction as the Version, and only while the reservation has not expired, so
// cleanup never deletes a claimed body. A failed upload or a refused write makes the body due at once.
// Uploads outliving their reservation can exceed the cap until cleanup, or remain untracked if the Worker stops.
const CLAIM_MS = 60 * 60 * 1000;
// One execution-time clock for expiry and cleanup, including a batch delayed after its statements were prepared.
const CLOCK = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
// Room for `?` more bytes under a cap of `?`: every Version's body and every ledgered body count.
const ROOM = "(SELECT COALESCE(SUM(size), 0) FROM versions) + (SELECT COALESCE(SUM(size), 0) FROM trash) + ? <= ?";
// The batch's first statement wrote the Version holding body key `?`.
const WROTE = "EXISTS (SELECT 1 FROM versions WHERE body_key = ?)";
// The reservation for body key `?` has not expired when the database executes the write.
const RESERVED = `EXISTS (SELECT 1 FROM trash WHERE body_key = ? AND due_at > ${CLOCK})`;
// Omission is preserved against the row at commit time; null explicitly clears description.
const FIELDS = "title = COALESCE(?, title), description = CASE WHEN ? = 1 THEN ? ELSE description END, tags = COALESCE(?, tags)";
// Binds (set, at, at, set): a set date replaces any date; a default date replaces only a default one.
const EXPIRY = "expires_at = CASE WHEN ? = 1 THEN ? WHEN expiry_set = 0 THEN ? ELSE expires_at END, expiry_set = MAX(expiry_set, ?)";
const expiryArgs = (e: Expiry) => [e.set ? 1 : 0, e.at, e.at, e.set ? 1 : 0];
type ShareFields = { title?: string; description?: string | null; tags?: string; expiresAt?: number | null };
// A Share that is neither deleted nor expired when the statement executes. `a` is the table's alias with its dot.
const live = (a = "") => `${a}deleted_at IS NULL AND (${a}expires_at IS NULL OR ${a}expires_at > ${CLOCK})`;
// Bounds a cleanup run, and keeps one ledger statement within D1's 100 bound parameters.
export const CLEANUP_BATCH = 50;

/** What became of a write: written; refused for want of room; or not written (the Share is gone, or the upload took over an hour). */
export type Written = "written" | "full" | "gone";

export class Store {
  constructor(private db: D1Database, private bodies: R2Bucket) {}

  // Bodies

  /** Reserves room for a body under a fresh key, then uploads it. Null, with nothing uploaded, when there is no room. */
  private async putBody(slug: string, b: Body, size: number, limit: number): Promise<string | null> {
    const key = `bodies/${slug}/${randomHex(16)}`;
    const reserved = await this.db.prepare(`INSERT INTO trash (body_key, size, due_at) SELECT ?, ?, ${CLOCK} + ? WHERE ${ROOM}`)
      .bind(key, size, CLAIM_MS, size, limit).run();
    if (!reserved.meta.changes) return null;
    try {
      await this.bodies.put(key, b.body, { httpMetadata: { contentType: b.kind === "site" ? "application/zip" : "text/html; charset=utf-8" } });
    } catch (e) {
      await this.dueNow(key, size);
      throw e;
    }
    return key;
  }

  /** Makes a ledgered body due for deletion now, ledgering it again if cleanup already removed its row. */
  private async dueNow(key: string, size: number): Promise<void> {
    await this.db.prepare(`INSERT INTO trash (body_key, size, due_at) VALUES (?, ?, ${CLOCK}) ON CONFLICT (body_key) DO UPDATE SET due_at = excluded.due_at`)
      .bind(key, size).run();
  }

  /**
   * Runs a batch whose first statement inserts the Version that points at a just-uploaded body (only while its
   * reservation holds), and claims that body from the ledger in the same transaction. Returns false when the insert
   * matched nothing; the upload is then due for deletion at once. A failed batch leaves it due when it expires.
   */
  private async commit(key: string, size: number, statements: D1PreparedStatement[]): Promise<boolean> {
    const claim = this.db.prepare(`DELETE FROM trash WHERE body_key = ? AND ${WROTE}`).bind(key, key);
    const inserted = (await this.db.batch([...statements, claim]))[0]?.meta.changes ?? 0;
    if (inserted === 0) await this.dueNow(key, size);
    return inserted > 0;
  }

  /**
   * Deletes up to 50 due bodies from R2, then their ledger rows, in two D1 queries. Safe to run any time and to run
   * twice. Returns how many it deleted, so a caller can tell whether more are due.
   */
  async emptyTrash(): Promise<number> {
    const rows = (await this.db.prepare(`SELECT body_key, due_at FROM trash WHERE due_at <= ${CLOCK} ORDER BY due_at LIMIT ?`).bind(CLEANUP_BATCH)
      .all<{ body_key: string; due_at: number }>()).results;
    if (rows.length === 0) return 0;
    await this.bodies.delete(rows.map((r) => r.body_key));
    // Only rows still as they were read: an upload re-ledgered meanwhile (dueNow) keeps its row and is retried.
    await this.db.prepare(`DELETE FROM trash WHERE (body_key, due_at) IN (VALUES ${rows.map(() => "(?, ?)").join(", ")})`)
      .bind(...rows.flatMap((r) => [r.body_key, r.due_at])).run();
    return rows.length;
  }

  async body(key: string): Promise<string | null> {
    const obj = await this.bodies.get(key);
    return obj ? obj.text() : null;
  }

  /** A whole stored body, for the API's zip download. */
  async bodyStream(key: string): Promise<ReadableStream<Uint8Array> | null> {
    return (await this.bodies.get(key))?.body ?? null;
  }

  /**
   * Purges up to 50 expired Shares that still have Versions, in one transaction: their bodies are queued for deletion,
   * the Shares marked deleted, and their Versions deleted last, so every statement selects the same Shares and a purged
   * Share is never selected again. `now` is bound, not read per statement. Returns how many Shares it purged.
   */
  async expire(now: number): Promise<number> {
    const due = "SELECT slug FROM shares WHERE expires_at <= ? AND slug IN (SELECT slug FROM versions) ORDER BY expires_at, slug LIMIT ?";
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO trash (body_key, size, due_at) SELECT body_key, size, ? FROM versions WHERE slug IN (${due})`).bind(now, now, CLEANUP_BATCH),
      this.db.prepare(`UPDATE shares SET deleted_at = COALESCE(deleted_at, expires_at) WHERE slug IN (${due})`).bind(now, CLEANUP_BATCH),
      this.db.prepare(`DELETE FROM versions WHERE slug IN (${due})`).bind(now, CLEANUP_BATCH),
      this.db.prepare(`DELETE FROM share_views WHERE slug IN (${due})`).bind(now, CLEANUP_BATCH),
    ]);
    return results[1]?.meta.changes ?? 0;
  }

  // Tokens

  async tokenByDigest(digest: string): Promise<TokenRow | null> {
    return this.db
      .prepare("SELECT id, author, name FROM tokens WHERE digest = ? AND revoked_at IS NULL")
      .bind(digest)
      .first<TokenRow>();
  }

  /** Records use at most once a minute, so routine reads write no rows. */
  async touchToken(id: string, now: number): Promise<void> {
    await this.db
      .prepare("UPDATE tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)")
      .bind(now, id, now - 60_000)
      .run();
  }

  async createToken(id: string, author: string, name: string, digest: string, now: number): Promise<void> {
    await this.db
      .prepare("INSERT INTO tokens (id, author, name, digest, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, author, name, digest, now)
      .run();
  }

  async listTokens(author: string) {
    const r = await this.db
      .prepare("SELECT id, name, created_at, last_used_at, revoked_at FROM tokens WHERE author = ? ORDER BY created_at DESC, id")
      .bind(author)
      .all<{ id: string; name: string; created_at: number; last_used_at: number | null; revoked_at: number | null }>();
    return r.results;
  }

  /** Returns false when no live token has that id. */
  async revokeToken(author: string, id: string, now: number): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND author = ? AND revoked_at IS NULL")
      .bind(now, id, author)
      .run();
    return r.meta.changes > 0;
  }

  // Views: one row per Share and UTC day, incremented when a browser opens the Share's page.

  /** Counts one opening of a Share's page. The caller sends it in the background, so a slow write never delays a page. */
  async countView(slug: string, day: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO share_views (slug, day, views) VALUES (?, ?, 1) ON CONFLICT (slug, day) DO UPDATE SET views = views + 1")
      .bind(slug, day)
      .run();
  }

  /** Views per Share: all time, and since `sinceDay` (a UTC day, `YYYY-MM-DD`). Shares with no views are absent. */
  async viewsBySlug(sinceDay: string): Promise<Map<string, { total: number; recent: number }>> {
    const r = await this.db
      .prepare("SELECT slug, SUM(views) AS total, SUM(CASE WHEN day >= ? THEN views ELSE 0 END) AS recent FROM share_views GROUP BY slug")
      .bind(sinceDay)
      .all<{ slug: string; total: number; recent: number }>();
    return new Map(r.results.map((row) => [row.slug, { total: row.total, recent: row.recent }]));
  }

  // Shares

  async share(author: string, slug: string): Promise<ShareRow | null> {
    return this.db
      .prepare(`SELECT ${SHARE_COLUMNS} FROM shares d LEFT JOIN tokens t ON t.id = d.changed_by
        WHERE d.slug = ? AND d.author = ? AND ${live("d.")}`)
      .bind(slug, author)
      .first<ShareRow>();
  }

  /**
   * Creates a Share with its first Version: "full", with nothing uploaded, when the reservation finds no room; "gone",
   * keeping nothing, when the upload outlived its reservation.
   */
  async createShare(input: Body & {
    slug: string; author: string; title: string; description: string | null; tags: string;
    size: number; tokenId: string; now: number; limit: number; expiry: Expiry;
  }): Promise<Written> {
    const { slug, author, title, description, tags, size, tokenId, now, limit, expiry } = input;
    const key = await this.putBody(slug, input, size, limit);
    if (key === null) return "full";
    // The Version row comes first so commit() can tell whether it was written; the Share row follows only then.
    const written = await this.commit(key, size, [
      this.db.prepare(`INSERT INTO versions (slug, n, body_key, size, created_at, token_id, kind, files) SELECT ?, 1, ?, ?, ?, ?, ?, ? WHERE ${RESERVED}`)
        .bind(slug, key, size, now, tokenId, input.kind, input.files, key),
      this.db.prepare(`INSERT INTO shares (slug, author, title, description, tags, public, latest_version,
          created_at, updated_at, changed_by, changed_at, expires_at, expiry_set) SELECT ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ? WHERE ${WROTE}`)
        .bind(slug, author, title, description, tags, now, now, tokenId, now, expiry.at, expiry.set ? 1 : 0, key),
    ]);
    return written ? "written" : "gone";
  }

  /** Adds a Version and drops whatever falls out of the window, in one transaction; keeps nothing unless written. */
  async addVersion(input: Body & {
    author: string; slug: string; title?: string; description?: string | null; tags?: string;
    size: number; tokenId: string; now: number; limit: number; expiry: Expiry;
  }): Promise<Written> {
    const { author, slug, title, description, tags, size, tokenId, now, limit, expiry } = input;
    const pruned = `slug = ? AND n <= (SELECT latest_version FROM shares WHERE slug = ?) - ${KEEP_VERSIONS}`;
    const key = await this.putBody(slug, input, size, limit);
    if (key === null) return "full";
    // The Version number is computed inside the transaction, so concurrent publishes get distinct numbers. Only the
    // INSERT decides whether the Share is live: the clock moves between statements, and an expiry passing after the
    // INSERT must not leave its Version without the Share's update. The rest follows that INSERT (WROTE).
    const written = await this.commit(key, size, [
      this.db.prepare(`INSERT INTO versions (slug, n, body_key, size, created_at, token_id, kind, files)
          SELECT slug, latest_version + 1, ?, ?, ?, ?, ?, ? FROM shares WHERE slug = ? AND author = ? AND ${live()} AND ${RESERVED}`)
        .bind(key, size, now, tokenId, input.kind, input.files, slug, author, key),
      this.db.prepare(`UPDATE shares SET latest_version = latest_version + 1, ${FIELDS}, ${EXPIRY},
          updated_at = ?, changed_by = ?, changed_at = ? WHERE slug = ? AND author = ? AND ${WROTE}`)
        .bind(title ?? null, description !== undefined ? 1 : 0, description ?? null, tags ?? null, ...expiryArgs(expiry), now, tokenId, now, slug, author, key),
      this.db.prepare(`INSERT INTO trash (body_key, size, due_at) SELECT body_key, size, ? FROM versions WHERE ${pruned}`)
        .bind(now, slug, slug),
      this.db.prepare(`DELETE FROM versions WHERE ${pruned}`).bind(slug, slug),
    ]);
    return written ? "written" : "gone";
  }

  async updateFields(author: string, slug: string, fields: ShareFields, tokenId: string, now: number): Promise<void> {
    const { title, description, tags, expiresAt } = fields;
    // Only a date given here changes the expiry; it then stays until a Publisher changes it.
    const set = expiresAt !== undefined ? 1 : 0;
    await this.db
      .prepare(`UPDATE shares SET ${FIELDS}, expires_at = CASE WHEN ? = 1 THEN ? ELSE expires_at END, expiry_set = MAX(expiry_set, ?),
        updated_at = ?, changed_by = ?, changed_at = ? WHERE slug = ? AND author = ? AND ${live()}`)
      .bind(title ?? null, description !== undefined ? 1 : 0, description ?? null, tags ?? null,
        set, expiresAt ?? null, set, now, tokenId, now, slug, author)
      .run();
  }

  async setPublic(author: string, slug: string, value: boolean, tokenId: string, now: number): Promise<void> {
    await this.db
      .prepare(`UPDATE shares SET public = ?, changed_by = ?, changed_at = ?
        WHERE slug = ? AND author = ? AND ${live()}`)
      .bind(value ? 1 : 0, tokenId, now, slug, author)
      .run();
  }

  /** Soft delete. Returns false when there was no live Share. */
  async deleteShare(author: string, slug: string, tokenId: string, now: number): Promise<boolean> {
    const r = await this.db
      .prepare(`UPDATE shares SET deleted_at = ?, changed_by = ?, changed_at = ?
        WHERE slug = ? AND author = ? AND ${live()}`)
      .bind(now, tokenId, now, slug, author)
      .run();
    return r.meta.changes > 0;
  }

  /**
   * Erases a Share for good, deleted or not: the only deletion that is not soft, for a request to erase someone's data. One batch
   * queues every body as due now, deletes the Versions and deletes the Share's row; emptyTrash then deletes the bodies
   * from R2, and the hourly cleanup retries if R2 fails. Returns false when the Author has no such Share.
   */
  async eraseShare(author: string, slug: string): Promise<boolean> {
    const own = "SELECT slug FROM shares WHERE slug = ? AND author = ?";
    // Bodies published before 0.1.0-beta.2 sit in D1, in a table the Operator may have dropped since (operator.md).
    const legacy = await this.db.prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'versions_d1_legacy'").first();
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO trash (body_key, size, due_at) SELECT body_key, size, ${CLOCK} FROM versions WHERE slug IN (${own})
        ON CONFLICT (body_key) DO UPDATE SET due_at = excluded.due_at`).bind(slug, author),
      this.db.prepare(`DELETE FROM versions WHERE slug IN (${own})`).bind(slug, author),
      ...(legacy ? [this.db.prepare(`DELETE FROM versions_d1_legacy WHERE slug IN (${own})`).bind(slug, author)] : []),
      this.db.prepare(`DELETE FROM share_views WHERE slug IN (${own})`).bind(slug, author),
      this.db.prepare("DELETE FROM shares WHERE slug = ? AND author = ?").bind(slug, author),
    ]);
    return results.at(-1)!.meta.changes > 0;
  }

  /** The Author's Share an erase names, deleted or not: its title, and the keys of its bodies. */
  async eraseTarget(author: string, slug: string): Promise<{ title: string; keys: string[] } | null> {
    const rows = (await this.db
      .prepare("SELECT d.title, v.body_key FROM shares d LEFT JOIN versions v ON v.slug = d.slug WHERE d.slug = ? AND d.author = ?")
      .bind(slug, author)
      .all<{ title: string; body_key: string | null }>()).results;
    if (rows.length === 0) return null;
    return { title: rows[0]!.title, keys: rows.flatMap((r) => (r.body_key === null ? [] : [r.body_key])) };
  }

  /**
   * Deletes an erased Share's bodies from R2, then their ledger rows: the keys its Versions held (eraseShare ledgered
   * them), and every object under its prefix, which also catches an upload that outlived its reservation and was never
   * ledgered. Each found object is ledgered as due before any delete, so if R2 fails the hourly cleanup retries it; only
   * a failure to list the prefix leaves such an upload unledgered. A write still in flight for the slug fails (its Share
   * is gone) and ledgers its body as due.
   */
  async eraseBodies(slug: string, keys: string[]): Promise<void> {
    const found = new Map<string, number>(keys.map((k) => [k, 0]));
    let cursor: string | undefined;
    do {
      const page = await this.bodies.list({ prefix: `bodies/${slug}/`, cursor });
      for (const o of page.objects) found.set(o.key, o.size);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const all = [...found];
    // Two bound parameters a row: half a cleanup batch keeps one statement within D1's 100.
    for (let i = 0; i < all.length; i += CLEANUP_BATCH / 2) {
      const chunk = all.slice(i, i + CLEANUP_BATCH / 2);
      await this.db.prepare(`INSERT INTO trash (body_key, size, due_at) VALUES ${chunk.map(() => `(?, ?, ${CLOCK})`).join(", ")}
        ON CONFLICT (body_key) DO NOTHING`).bind(...chunk.flat()).run();
    }
    const names = all.map(([k]) => k);
    // R2 deletes at most 1,000 keys a call.
    for (let i = 0; i < names.length; i += 1000) await this.bodies.delete(names.slice(i, i + 1000));
    for (let i = 0; i < names.length; i += CLEANUP_BATCH) {
      const chunk = names.slice(i, i + CLEANUP_BATCH);
      await this.db.prepare(`DELETE FROM trash WHERE body_key IN (${chunk.map(() => "?").join(", ")})`).bind(...chunk).run();
    }
  }

  async listShares(author: string, q: { tags: [string, string][]; public?: boolean; sort: "updated_at" | "created_at"; page: number; pageSize: number }) {
    const where = ["d.author = ?", live("d.")];
    const args: (string | number)[] = [author];
    for (const [k, v] of q.tags) {
      where.push("json_extract(d.tags, ?) = ?");
      args.push(`$."${k}"`, v);
    }
    if (q.public !== undefined) {
      where.push("d.public = ?");
      args.push(q.public ? 1 : 0);
    }
    const w = where.join(" AND ");
    const total = (await this.db.prepare(`SELECT COUNT(*) AS n FROM shares d WHERE ${w}`).bind(...args).first<{ n: number }>())?.n ?? 0;
    const rows = await this.db
      .prepare(`SELECT ${SHARE_COLUMNS} FROM shares d LEFT JOIN tokens t ON t.id = d.changed_by
        WHERE ${w} ORDER BY d.${q.sort} DESC, d.slug LIMIT ? OFFSET ?`)
      .bind(...args, q.pageSize, (q.page - 1) * q.pageSize)
      .all<ShareRow>();
    return { total, rows: rows.results };
  }

  /**
   * The Author's home: the `limit` most recently updated live Shares, with the counts over all of them, in
   * one round trip (each is ~160 ms from Brazil to a D1 in North America). No rows means no live Shares.
   */
  async recentShares(author: string, limit: number) {
    const rows = await this.db
      .prepare(`SELECT d.slug, d.title, d.public, d.latest_version, d.updated_at, t.name AS changed_by_name,
          (SELECT COUNT(*) FROM shares WHERE author = ?1 AND ${live()}) AS total,
          (SELECT COUNT(*) FROM shares WHERE author = ?1 AND ${live()} AND public = 1) AS public_total
        FROM shares d LEFT JOIN tokens t ON t.id = d.changed_by
        WHERE d.author = ?1 AND ${live("d.")} ORDER BY d.updated_at DESC, d.slug LIMIT ?2`)
      .bind(author, limit)
      .all<{ slug: string; title: string; public: number; latest_version: number; updated_at: number; changed_by_name: string | null; total: number; public_total: number }>();
    const first = rows.results[0];
    return {
      total: first?.total ?? 0,
      publicTotal: first?.public_total ?? 0,
      shares: rows.results.map(({ total: _t, public_total: _p, ...d }) => d),
    };
  }

  // Versions

  // Versions of a live Share only: these reads join the Share, so an expiry or delete holds here too.

  async versions(slug: string) {
    const r = await this.db
      .prepare(`SELECT v.n, v.kind, v.size, v.created_at, v.token_id, t.name AS token_name FROM versions v
        JOIN shares d ON d.slug = v.slug AND ${live("d.")}
        LEFT JOIN tokens t ON t.id = v.token_id WHERE v.slug = ? ORDER BY v.n DESC`)
      .bind(slug)
      .all<{ n: number; kind: Kind; size: number; created_at: number; token_id: string; token_name: string | null }>();
    return r.results;
  }

  /** A kept Version: a page with its body, or a site with its files. Null when it or its page's body is gone. */
  async version(slug: string, n: number) {
    const row = await this.db
      .prepare(`SELECT v.n, v.kind, v.body_key, v.files, v.size, v.created_at, v.token_id FROM versions v
        JOIN shares d ON d.slug = v.slug AND ${live("d.")} WHERE v.slug = ? AND v.n = ?`)
      .bind(slug, n)
      .first<{ n: number; kind: Kind; body_key: string; files: string | null; size: number; created_at: number; token_id: string }>();
    if (!row) return null;
    const meta = { n: row.n, kind: row.kind, body_key: row.body_key, size: row.size, created_at: row.created_at, token_id: row.token_id };
    if (row.kind === "site") return { ...meta, body: null, files: listIndex(row.files ?? "{}") };
    const body = await this.body(row.body_key);
    if (body === null) console.error("missing body", row.body_key);
    return body === null ? null : { ...meta, body, files: null };
  }

  // A Share a Viewer may open is live, of this Author, and public when `publicOnly`. Each read below is one
  // query, so a page costs one round trip to D1, plus R2 for a body.

  /** A viewable Share's Version `n` (its latest when null): its number, kind and body key, or null. */
  async viewableVersion(author: string, slug: string, publicOnly: boolean, n: number | null) {
    return this.db
      .prepare(`SELECT v.n, v.kind, v.body_key FROM shares d JOIN versions v ON v.slug = d.slug AND v.n = COALESCE(?, d.latest_version)
        WHERE d.slug = ? AND d.author = ? AND ${live("d.")} ${publicOnly ? "AND d.public = 1" : ""}`)
      .bind(n, slug, author)
      .first<{ n: number; kind: Kind; body_key: string }>();
  }

  /** A viewable Share with its kept Versions, newest first, or null. */
  async viewableWithVersions(author: string, slug: string, publicOnly: boolean) {
    const r = await this.db
      .prepare(`SELECT d.slug, d.title, d.public, d.latest_version, d.updated_at, d.expires_at, v.n, v.kind FROM shares d
        JOIN versions v ON v.slug = d.slug
        WHERE d.slug = ? AND d.author = ? AND ${live("d.")} ${publicOnly ? "AND d.public = 1" : ""} ORDER BY v.n DESC`)
      .bind(slug, author)
      .all<{ slug: string; title: string; public: number; latest_version: number; updated_at: number; expires_at: number | null; n: number; kind: Kind }>();
    const first = r.results[0];
    return first ? { share: first, kept: r.results.map((x) => x.n), kinds: new Map(r.results.map((x) => [x.n, x.kind])) } : null;
  }

  /** One file of a viewable site Version, found by its exact path, or null. One query. */
  async siteFile(author: string, slug: string, publicOnly: boolean, n: number, path: string): Promise<{ key: string; entry: SiteEntry } | null> {
    const row = await this.db
      .prepare(`SELECT v.body_key, j.value AS entry FROM shares d
        JOIN versions v ON v.slug = d.slug AND v.n = ? AND v.kind = 'site'
        JOIN json_each(v.files) j ON j.key = ?
        WHERE d.slug = ? AND d.author = ? AND ${live("d.")} ${publicOnly ? "AND d.public = 1" : ""}`)
      .bind(n, path, slug, author)
      .first<{ body_key: string; entry: string }>();
    return row ? { key: row.body_key, entry: decodeEntry(path, row.entry) } : null;
  }

  /** A site file's bytes, read from its zip with one ranged read and inflated as served. Null when the zip is gone. */
  async siteBytes(f: { key: string; entry: SiteEntry }): Promise<ReadableStream<Uint8Array> | null> {
    // An empty file has no bytes to read, and R2 has no zero-length range.
    if (f.entry.csize === 0) return new Blob([]).stream();
    const obj = await this.bodies.get(f.key, { range: { offset: f.entry.offset, length: f.entry.csize } });
    if (!obj) {
      console.error("missing body", f.key);
      return null;
    }
    return entryStream(obj.body, f.entry);
  }
}
