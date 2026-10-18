import { expect, test } from "vitest";
import type { SQLOutputValue } from "node:sqlite";
import { fakeEnv } from "./fake-env";

test("migration 0005 preserves every Share and Version from 0004 and replaces the table and index names", () => {
  let shares: Record<string, SQLOutputValue>[] = [];
  let versions: Record<string, SQLOutputValue>[] = [];
  const env = fakeEnv({
    before: "0005_shares.sql",
    seed: (db) => {
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
      shares = db.prepare("SELECT * FROM drops ORDER BY slug").all();
      versions = db.prepare("SELECT * FROM versions ORDER BY slug, n").all();
      expect(shares).toHaveLength(2);
      expect(versions).toHaveLength(4);
    },
  });
  try {
    expect(env.sqlite.prepare("SELECT * FROM shares ORDER BY slug").all()).toEqual(shares);
    expect(env.sqlite.prepare("SELECT * FROM versions ORDER BY slug, n").all()).toEqual(versions);
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
  } finally {
    env.sqlite.close();
  }
});

test("a fresh database applies every migration and accepts the renamed Share table", () => {
  const env = fakeEnv();
  try {
    env.sqlite.prepare(`INSERT INTO shares (slug, author, title, latest_version, created_at, updated_at, changed_by, changed_at)
      VALUES ('FreshShare01', 'author@example.com', 'Fresh', 1, 100, 100, 'tok', 100)`).run();
    expect(env.sqlite.prepare("SELECT slug, expires_at, expiry_set FROM shares").all())
      .toEqual([{ slug: "FreshShare01", expires_at: null, expiry_set: 0 }]);
  } finally {
    env.sqlite.close();
  }
});
