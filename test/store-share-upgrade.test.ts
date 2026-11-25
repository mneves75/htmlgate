import { expect, test } from "vitest";
import type { SQLOutputValue } from "node:sqlite";
import { fakeEnv } from "./fake-env";

test("migration 0005 preserves every Share, Version, legacy body, trash row, and token from 0004 and replaces the table and index names", () => {
  let shares: Record<string, SQLOutputValue>[] = [];
  let versions: Record<string, SQLOutputValue>[] = [];
  let legacy: Record<string, SQLOutputValue>[] = [];
  let trash: Record<string, SQLOutputValue>[] = [];
  let tokens: Record<string, SQLOutputValue>[] = [];
  let columnsBefore: Record<string, SQLOutputValue>[] = [];
  const env = fakeEnv({
    before: "0005_shares.sql",
    seed: (db) => {
      columnsBefore = db.prepare("PRAGMA table_info(drops)").all();
      db.prepare(`INSERT INTO tokens (id, author, name, digest, created_at, last_used_at, revoked_at)
        VALUES ('tok000000001', 'author@example.com', 'laptop', 'digest-value', 90, 150, NULL)`).run();
      const insert = db.prepare(`INSERT INTO drops (slug, author, title, description, tags, public, latest_version,
        created_at, updated_at, changed_by, changed_at, deleted_at, expires_at, expiry_set)
        VALUES (?, 'author@example.com', ?, 'kept description', '{"project":"kept"}', ?, 2, 100, 200, 'tok', 200, ?, ?, ?)`);
      insert.run("Upgrade00001", "Expires", 1, null, 300, 1);
      insert.run("Upgrade00002", "Soft deleted", 0, 250, null, 0);
      const version = db.prepare(`INSERT INTO versions (slug, n, body_key, size, created_at, token_id, kind, files)
        VALUES (?, ?, ?, ?, ?, 'tok', ?, ?)`);
      for (const slug of ["Upgrade00001", "Upgrade00002"]) {
        version.run(slug, 1, `bodies/${slug}/first`, 42, 100, "page", null);
        version.run(slug, 2, `bodies/${slug}/second`, 84, 200, "site", '{"index.html":[0,42,42,0]}');
      }
      db.prepare(`INSERT INTO versions_d1_legacy (slug, n, body, size, created_at, token_id)
        VALUES ('Upgrade00001', 1, '<p>legacy</p>', 13, 100, 'tok')`).run();
      db.prepare(`INSERT INTO trash (body_key, size, due_at)
        VALUES ('bodies/Upgrade00002/old', 55, 500)`).run();
      shares = db.prepare("SELECT * FROM drops ORDER BY slug").all();
      versions = db.prepare("SELECT * FROM versions ORDER BY slug, n").all();
      legacy = db.prepare("SELECT * FROM versions_d1_legacy ORDER BY slug, n").all();
      trash = db.prepare("SELECT * FROM trash ORDER BY body_key").all();
      tokens = db.prepare("SELECT * FROM tokens ORDER BY id").all();
      expect(shares).toHaveLength(2);
      expect(versions).toHaveLength(4);
      expect(legacy).toHaveLength(1);
      expect(trash).toHaveLength(1);
      expect(tokens).toHaveLength(1);
    },
  });
  try {
    expect(env.sqlite.prepare("PRAGMA table_info(shares)").all()).toEqual(columnsBefore);
    expect(env.sqlite.prepare("SELECT * FROM shares ORDER BY slug").all()).toEqual(shares);
    expect(env.sqlite.prepare("SELECT * FROM versions ORDER BY slug, n").all()).toEqual(versions);
    expect(env.sqlite.prepare("SELECT * FROM versions_d1_legacy ORDER BY slug, n").all()).toEqual(legacy);
    expect(env.sqlite.prepare("SELECT body_key, size, due_at FROM trash ORDER BY body_key").all()).toEqual(trash);
    expect(env.sqlite.prepare("SELECT nonce FROM trash ORDER BY body_key").all()).toEqual([{ nonce: "" }]);
    expect(env.sqlite.prepare("SELECT * FROM tokens ORDER BY id").all()).toEqual(tokens);
    expect(env.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'shares_%' ORDER BY name").all())
      .toEqual([{ name: "shares_by_author" }, { name: "shares_by_expiry" }]);
    expect(env.sqlite.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name LIKE 'drops%'").all()).toEqual([]);
    expect(env.sqlite.prepare("PRAGMA index_info(shares_by_author)").all().map((column) => column.name))
      .toEqual(["author", "deleted_at", "updated_at"]);
    expect(env.sqlite.prepare("PRAGMA index_xinfo(shares_by_author)").all().find((column) => column.name === "updated_at")?.desc).toBe(1);
    expect(env.sqlite.prepare("PRAGMA index_info(shares_by_expiry)").all().map((column) => column.name))
      .toEqual(["expires_at", "slug"]);
    expect(env.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'shares_by_expiry'").get()?.sql)
      .toMatch(/WHERE expires_at IS NOT NULL$/);
    expect(env.sqlite.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(env.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const plan = (sql: string, ...v: (string | number)[]) =>
      (env.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...v) as { detail: string }[]).map((r) => r.detail).join(" | ");
    expect(plan("SELECT * FROM shares WHERE author = ? AND deleted_at IS NULL ORDER BY updated_at DESC", "author@example.com")).toContain("shares_by_author");
    expect(plan("SELECT slug FROM shares WHERE expires_at <= ? ORDER BY expires_at, slug", 500)).toContain("shares_by_expiry");
  } finally {
    env.sqlite.close();
  }
});

test("a fresh database applies every migration, matches upgraded schema and indexes, and accepts the renamed Share table", () => {
  const upgraded = fakeEnv({ before: "0005_shares.sql" });
  const env = fakeEnv();
  const schemaOf = (db: typeof env.sqlite) =>
    db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  try {
    expect(env.sqlite.prepare("PRAGMA table_info(shares)").all())
      .toEqual(upgraded.sqlite.prepare("PRAGMA table_info(shares)").all());
    expect(schemaOf(env.sqlite)).toEqual(schemaOf(upgraded.sqlite));
    env.sqlite.prepare(`INSERT INTO shares (slug, author, title, latest_version, created_at, updated_at, changed_by, changed_at)
      VALUES ('FreshShare01', 'author@example.com', 'Fresh', 1, 100, 100, 'tok', 100)`).run();
    expect(env.sqlite.prepare("SELECT slug, expires_at, expiry_set FROM shares").all())
      .toEqual([{ slug: "FreshShare01", expires_at: null, expiry_set: 0 }]);
  } finally {
    upgraded.sqlite.close();
    env.sqlite.close();
  }
});
