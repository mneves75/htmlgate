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

export interface Expiry {
  at: number | null;
  set: boolean;
}

export type Body = { body: string; kind: "page"; files: null } | { body: Uint8Array; kind: "site"; files: string };

const SHARE_COLUMNS = `d.slug, d.author, d.title, d.description, d.tags, d.public, d.latest_version,
  d.created_at, d.updated_at, d.changed_by, t.name AS changed_by_name, d.changed_at, d.expires_at`;

const RESERVATION_TTL_MS = 60 * 60 * 1000;
const CLOCK = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
export const VERSION_FLOOR = 20 * 1024;
const COST = `MAX(size + LENGTH(CAST(COALESCE(files, '') AS BLOB)), ${VERSION_FLOOR})`;
const costOf = (size: number, files: string | null) => Math.max(size + new TextEncoder().encode(files ?? "").length, VERSION_FLOOR);
const ROOM = `(SELECT COALESCE(SUM(${COST}), 0) FROM versions) + (SELECT COALESCE(SUM(size), 0) FROM trash) + ? <= ?`;
const WROTE = "EXISTS (SELECT 1 FROM versions WHERE body_key = ?)";
const RESERVED = `EXISTS (SELECT 1 FROM trash WHERE body_key = ? AND due_at > ${CLOCK})`;
const FIELDS = "title = COALESCE(?, title), description = CASE WHEN ? = 1 THEN ? ELSE description END, tags = COALESCE(?, tags)";
const EXPIRY = "expires_at = CASE WHEN ? = 1 THEN ? WHEN expiry_set = 0 THEN ? ELSE expires_at END, expiry_set = MAX(expiry_set, ?)";
const expiryArgs = (e: Expiry) => [e.set ? 1 : 0, e.at, e.at, e.set ? 1 : 0];
type ShareFields = { title?: string; description?: string | null; tags?: string; expiresAt?: number | null };
const live = (a = "") => `${a}deleted_at IS NULL AND (${a}expires_at IS NULL OR ${a}expires_at > ${CLOCK})`;
// Bounds a cleanup run, and keeps one ledger statement within D1's 100 bound parameters.
export const CLEANUP_BATCH = 50;

export type Written = "written" | "full" | "gone";

export class Store {
  constructor(private db: D1Database, private bodies: R2Bucket) {}

  private async putBody(slug: string, b: Body, cost: number, limit: number): Promise<string | null> {
    const key = `bodies/${slug}/${randomHex(16)}`;
    const reserved = await this.db.prepare(`INSERT INTO trash (body_key, size, due_at) SELECT ?, ?, ${CLOCK} + ? WHERE ${ROOM}`)
      .bind(key, cost, RESERVATION_TTL_MS, cost, limit).run();
    if (!reserved.meta.changes) return null;
    try {
      await this.bodies.put(key, b.body, { httpMetadata: { contentType: b.kind === "site" ? "application/zip" : "text/html; charset=utf-8" } });
    } catch (e) {
      await this.dueNow(key, cost);
      throw e;
    }
    return key;
  }

  private async dueNow(key: string, size: number): Promise<void> {
    await this.db.prepare(`INSERT INTO trash (body_key, size, due_at) VALUES (?, ?, ${CLOCK}) ON CONFLICT (body_key) DO UPDATE SET due_at = excluded.due_at`)
      .bind(key, size).run();
  }

  private async commit(key: string, cost: number, statements: D1PreparedStatement[]): Promise<boolean> {
    const claim = this.db.prepare(`DELETE FROM trash WHERE body_key = ? AND ${WROTE}`).bind(key, key);
    const inserted = (await this.db.batch([...statements, claim]))[0]?.meta.changes ?? 0;
    if (inserted === 0) await this.dueNow(key, cost);
    return inserted > 0;
  }

  async emptyTrash(): Promise<number> {
    const rows = (await this.db.prepare(`SELECT body_key, due_at FROM trash WHERE due_at <= ${CLOCK} ORDER BY due_at LIMIT ?`).bind(CLEANUP_BATCH)
      .all<{ body_key: string; due_at: number }>()).results;
    if (rows.length === 0) return 0;
    await this.bodies.delete(rows.map((r) => r.body_key));
    await this.db.prepare(`DELETE FROM trash WHERE (body_key, due_at) IN (VALUES ${rows.map(() => "(?, ?)").join(", ")})`)
      .bind(...rows.flatMap((r) => [r.body_key, r.due_at])).run();
    return rows.length;
  }

  async body(key: string): Promise<string | null> {
    const obj = await this.bodies.get(key);
    return obj ? obj.text() : null;
  }

  async bodyStream(key: string): Promise<ReadableStream<Uint8Array> | null> {
    return (await this.bodies.get(key))?.body ?? null;
  }

  async expire(now: number): Promise<number> {
    const due = "SELECT slug FROM shares WHERE expires_at <= ? AND slug IN (SELECT slug FROM versions) ORDER BY expires_at, slug LIMIT ?";
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO trash (body_key, size, due_at) SELECT body_key, size, ? FROM versions WHERE slug IN (${due})`).bind(now, now, CLEANUP_BATCH),
      this.db.prepare(`UPDATE shares SET deleted_at = COALESCE(deleted_at, expires_at) WHERE slug IN (${due})`).bind(now, CLEANUP_BATCH),
      this.db.prepare(`DELETE FROM share_views WHERE slug IN (${due})`).bind(now, CLEANUP_BATCH),
      this.db.prepare(`DELETE FROM versions WHERE slug IN (${due})`).bind(now, CLEANUP_BATCH),
    ]);
    return results[1]?.meta.changes ?? 0;
  }

  async useToken(digest: string, now: number): Promise<TokenRow | null> {
    const find = this.db.prepare("SELECT id, author, name FROM tokens WHERE digest = ? AND revoked_at IS NULL").bind(digest);
    try {
      const [found] = await this.db.batch<TokenRow>([
        find,
        this.db
          .prepare("UPDATE tokens SET last_used_at = ? WHERE digest = ? AND (last_used_at IS NULL OR last_used_at < ?) AND revoked_at IS NULL")
          .bind(now, digest, now - 60_000),
      ]);
      return found?.results[0] ?? null;
    } catch (e) {
      if ((await find.first<TokenRow>()) === null) return null;
      throw e;
    }
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

  async revokeToken(author: string, id: string, now: number): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND author = ? AND revoked_at IS NULL")
      .bind(now, id, author)
      .run();
    return r.meta.changes > 0;
  }

  async countView(slug: string, day: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO share_views (slug, day, views) SELECT ?1, ?2, 1
        WHERE EXISTS (SELECT 1 FROM shares WHERE slug = ?1 AND ${live()})
        ON CONFLICT (slug, day) DO UPDATE SET views = views + 1`)
      .bind(slug, day)
      .run();
  }

  async viewsBySlug(sinceDay: string): Promise<Map<string, { total: number; recent: number }>> {
    const r = await this.db
      .prepare("SELECT slug, SUM(views) AS total, SUM(CASE WHEN day >= ? THEN views ELSE 0 END) AS recent FROM share_views GROUP BY slug")
      .bind(sinceDay)
      .all<{ slug: string; total: number; recent: number }>();
    return new Map(r.results.map((row) => [row.slug, { total: row.total, recent: row.recent }]));
  }

  async share(author: string, slug: string): Promise<ShareRow | null> {
    return this.db
      .prepare(`SELECT ${SHARE_COLUMNS} FROM shares d LEFT JOIN tokens t ON t.id = d.changed_by
        WHERE d.slug = ? AND d.author = ? AND ${live("d.")}`)
      .bind(slug, author)
      .first<ShareRow>();
  }

  async createShare(input: Body & {
    slug: string; author: string; title: string; description: string | null; tags: string;
    size: number; tokenId: string; now: number; limit: number; expiry: Expiry;
  }): Promise<Written> {
    const { slug, author, title, description, tags, size, tokenId, now, limit, expiry } = input;
    const cost = costOf(size, input.files);
    const key = await this.putBody(slug, input, cost, limit);
    if (key === null) return "full";
    const written = await this.commit(key, cost, [
      this.db.prepare(`INSERT INTO versions (slug, n, body_key, size, created_at, token_id, kind, files) SELECT ?, 1, ?, ?, ?, ?, ?, ? WHERE ${RESERVED}`)
        .bind(slug, key, size, now, tokenId, input.kind, input.files, key),
      this.db.prepare(`INSERT INTO shares (slug, author, title, description, tags, public, latest_version,
          created_at, updated_at, changed_by, changed_at, expires_at, expiry_set) SELECT ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ? WHERE ${WROTE}`)
        .bind(slug, author, title, description, tags, now, now, tokenId, now, expiry.at, expiry.set ? 1 : 0, key),
    ]);
    return written ? "written" : "gone";
  }

  async addVersion(input: Body & {
    author: string; slug: string; title?: string; description?: string | null; tags?: string;
    size: number; tokenId: string; now: number; limit: number; expiry: Expiry;
  }): Promise<Written> {
    const { author, slug, title, description, tags, size, tokenId, now, limit, expiry } = input;
    const pruned = `slug = ? AND n <= (SELECT latest_version FROM shares WHERE slug = ?) - ${KEEP_VERSIONS}`;
    const cost = costOf(size, input.files);
    const key = await this.putBody(slug, input, cost, limit);
    if (key === null) return "full";
    const written = await this.commit(key, cost, [
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

  async deleteShare(author: string, slug: string, tokenId: string, now: number): Promise<boolean> {
    const r = await this.db
      .prepare(`UPDATE shares SET deleted_at = ?, changed_by = ?, changed_at = ?
        WHERE slug = ? AND author = ? AND ${live()}`)
      .bind(now, tokenId, now, slug, author)
      .run();
    return r.meta.changes > 0;
  }

  private async hasLegacyD1BodiesTable(): Promise<boolean> {
    const row = await this.db.prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'versions_d1_legacy'").first();
    return row !== null;
  }

  async eraseShare(author: string, slug: string): Promise<boolean> {
    const own = "SELECT slug FROM shares WHERE slug = ? AND author = ?";
    const legacy = await this.hasLegacyD1BodiesTable();
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

  async eraseTarget(author: string, slug: string): Promise<{ title: string; keys: string[] } | null> {
    const rows = (await this.db
      .prepare("SELECT d.title, v.body_key FROM shares d LEFT JOIN versions v ON v.slug = d.slug WHERE d.slug = ? AND d.author = ?")
      .bind(slug, author)
      .all<{ title: string; body_key: string | null }>()).results;
    if (rows.length === 0) return null;
    return { title: rows[0]!.title, keys: rows.flatMap((r) => (r.body_key === null ? [] : [r.body_key])) };
  }

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
    const [count, rows] = await this.db.batch<{ n: number } & ShareRow>([
      this.db.prepare(`SELECT COUNT(*) AS n FROM shares d WHERE ${w}`).bind(...args),
      this.db
        .prepare(`SELECT ${SHARE_COLUMNS} FROM shares d LEFT JOIN tokens t ON t.id = d.changed_by
          WHERE ${w} ORDER BY d.${q.sort} DESC, d.slug LIMIT ? OFFSET ?`)
        .bind(...args, q.pageSize, (q.page - 1) * q.pageSize),
    ]);
    return { total: count?.results[0]?.n ?? 0, rows: (rows?.results ?? []) as ShareRow[] };
  }

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

  async versions(slug: string) {
    const r = await this.db
      .prepare(`SELECT v.n, v.kind, v.size, v.created_at, v.token_id, t.name AS token_name FROM versions v
        JOIN shares d ON d.slug = v.slug AND ${live("d.")}
        LEFT JOIN tokens t ON t.id = v.token_id WHERE v.slug = ? ORDER BY v.n DESC`)
      .bind(slug)
      .all<{ n: number; kind: Kind; size: number; created_at: number; token_id: string; token_name: string | null }>();
    return r.results;
  }

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

  async viewableVersion(author: string, slug: string, publicOnly: boolean, n: number | null) {
    return this.db
      .prepare(`SELECT v.n, v.kind, v.body_key FROM shares d JOIN versions v ON v.slug = d.slug AND v.n = COALESCE(?, d.latest_version)
        WHERE d.slug = ? AND d.author = ? AND ${live("d.")} ${publicOnly ? "AND d.public = 1" : ""}`)
      .bind(n, slug, author)
      .first<{ n: number; kind: Kind; body_key: string }>();
  }

  async viewableWithVersions(author: string, slug: string, publicOnly: boolean) {
    const r = await this.db
      .prepare(`SELECT d.slug, d.title, d.description, d.public, d.latest_version, d.updated_at, d.expires_at, v.n, v.kind
        FROM shares d
        JOIN versions v ON v.slug = d.slug
        WHERE d.slug = ? AND d.author = ? AND ${live("d.")} ${publicOnly ? "AND d.public = 1" : ""} ORDER BY v.n DESC`)
      .bind(slug, author)
      .all<{ slug: string; title: string; description: string | null; public: number; latest_version: number; updated_at: number; expires_at: number | null; n: number; kind: Kind }>();
    const first = r.results[0];
    return first ? { share: first, kept: r.results.map((x) => x.n), kinds: new Map(r.results.map((x) => [x.n, x.kind])) } : null;
  }

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
