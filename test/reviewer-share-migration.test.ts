// Independent review of migration 0005 (plan 011): an Instance at migration 0004 keeps every row, index definition and
// legacy table, and the renamed Store works on it. Worker-free: real SQLite (node:sqlite) from test/fake-env.ts.
import { describe, expect, test } from "vitest";
import { fakeEnv } from "./fake-env";
import { Store } from "../src/store";

const AUTHOR = "author@example.com";
const NOW = Date.now();

type Snap = { drops: unknown[]; versions: unknown[]; legacy: unknown[]; trash: unknown[]; tokens: unknown[]; tableInfo: unknown[]; indexSql: Record<string, string>; schema: unknown[] };

function upgraded() {
  const snap = {} as Snap;
  const env = fakeEnv({
    before: "0005_shares.sql",
    seed: (db) => {
      db.exec(`INSERT INTO tokens (id, author, name, digest, created_at) VALUES ('tok', '${AUTHOR}', 'laptop', 'digest', 1)`);
      const share = db.prepare(`INSERT INTO drops (slug, author, title, description, tags, public, latest_version, created_at, updated_at,
        changed_by, changed_at, deleted_at, expires_at, expiry_set) VALUES (?, ?, ?, ?, ?, ?, ?, 100, 200, 'tok', 200, ?, ?, ?)`);
      share.run("Live00000001", AUTHOR, "Live", "desc", '{"k":"v"}', 1, 1, null, NOW + 86_400_000, 1);
      share.run("Expired00001", AUTHOR, "Expired", null, "{}", 0, 1, null, NOW - 1000, 0);
      share.run("Deleted00001", AUTHOR, "Deleted", null, "{}", 0, 1, 250, null, 0);
      share.run("Forever00001", AUTHOR, "Forever", null, "{}", 0, 1, null, null, 1);
      share.run("Other0000001", "someone@else.com", "Foreign", null, "{}", 1, 1, null, null, 0);
      const version = db.prepare("INSERT INTO versions (slug, n, body_key, size, created_at, token_id, kind, files) VALUES (?, 1, ?, 10, 100, 'tok', 'page', NULL)");
      for (const slug of ["Live00000001", "Expired00001", "Deleted00001", "Forever00001", "Other0000001"]) version.run(slug, `bodies/${slug}/a`);
      db.exec("INSERT INTO versions_d1_legacy (slug, n, body, size, created_at, token_id) VALUES ('Expired00001', 1, '<p>old</p>', 10, 100, 'tok')");
      db.exec("INSERT INTO trash (body_key, size, due_at) VALUES ('bodies/Gone00000001/x', 5, 7)");
      snap.drops = db.prepare("SELECT * FROM drops ORDER BY slug").all();
      snap.versions = db.prepare("SELECT * FROM versions ORDER BY slug, n").all();
      snap.legacy = db.prepare("SELECT * FROM versions_d1_legacy ORDER BY slug, n").all();
      snap.trash = db.prepare("SELECT * FROM trash").all();
      snap.tokens = db.prepare("SELECT * FROM tokens").all();
      snap.tableInfo = db.prepare("PRAGMA table_info(drops)").all();
      snap.indexSql = Object.fromEntries((db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as { name: string; sql: string }[]).map((r) => [r.name, r.sql]));
      snap.schema = db.prepare("SELECT type, name FROM sqlite_master ORDER BY type, name").all();
    },
  });
  return { env, snap };
}

describe("migration 0005 on an Instance at 0004", () => {
  test("every row of every table is identical, and the legacy table and ledger are untouched", () => {
    const { env, snap } = upgraded();
    expect(env.sqlite.prepare("SELECT * FROM shares ORDER BY slug").all()).toEqual(snap.drops);
    expect(env.sqlite.prepare("SELECT * FROM versions ORDER BY slug, n").all()).toEqual(snap.versions);
    expect(env.sqlite.prepare("SELECT * FROM versions_d1_legacy ORDER BY slug, n").all()).toEqual(snap.legacy);
    expect(env.sqlite.prepare("SELECT * FROM trash").all()).toEqual(snap.trash);
    expect(env.sqlite.prepare("SELECT * FROM tokens").all()).toEqual(snap.tokens);
    expect(snap.drops).toHaveLength(5);
  });

  test("columns, types, defaults and the primary key are those of the old table", () => {
    const { env, snap } = upgraded();
    expect(env.sqlite.prepare("PRAGMA table_info(shares)").all()).toEqual(snap.tableInfo);
  });

  test("the two renamed indexes keep the old definitions, byte for byte but for their names", () => {
    const { env, snap } = upgraded();
    const now = Object.fromEntries((env.sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as { name: string; sql: string }[]).map((r) => [r.name, r.sql]));
    expect(Object.keys(now).sort()).toEqual(Object.keys(snap.indexSql).map((n) => n.replace(/^drops_/, "shares_")).sort());
    for (const [name, sql] of Object.entries(snap.indexSql)) {
      expect(now[name.replace(/^drops_/, "shares_")], name).toBe(sql.replaceAll("drops", "shares"));
    }
  });

  test("the schema differs from 0004 only by the renames: nothing is left under the old name, nothing else is added or lost", () => {
    const { env, snap } = upgraded();
    // Migrations after 0005 add their own tables (share_views): this review compares what 0005 changed, so both sides
    // leave those out. A new migration adds its name here, deliberately.
    const LATER = new Set(["share_views"]);
    const names = (env.sqlite.prepare("SELECT type, name FROM sqlite_master ORDER BY type, name").all() as { type: string; name: string }[])
      .filter((r) => !r.name.startsWith("sqlite_autoindex") && !LATER.has(r.name));
    const before = (snap.schema as { type: string; name: string }[]).filter((r) => !r.name.startsWith("sqlite_autoindex") && !LATER.has(r.name)).map((r) => ({ type: r.type, name: r.name.replace(/^drops/, "shares") }));
    expect(names).toEqual(before.sort((a, b) => (a.type + a.name < b.type + b.name ? -1 : 1)));
    const sqls = (env.sqlite.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all() as { sql: string }[]).map((r) => r.sql).join("\n");
    expect(sqls).not.toMatch(/drops/i);
    expect(env.sqlite.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(env.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("the queries that matter use the renamed indexes", () => {
    const { env } = upgraded();
    const plan = (sql: string, ...v: (string | number)[]) => (env.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...v) as { detail: string }[]).map((r) => r.detail).join(" | ");
    expect(plan("SELECT * FROM shares WHERE author = ? AND deleted_at IS NULL ORDER BY updated_at DESC", AUTHOR)).toContain("shares_by_author");
    expect(plan("SELECT slug FROM shares WHERE expires_at <= ? ORDER BY expires_at, slug", NOW)).toContain("shares_by_expiry");
  });

  test("the renamed Store reads, lists, expires and erases the upgraded data, legacy table included", async () => {
    const { env } = upgraded();
    const store = new Store(env.db, env.bucket);
    const live = await store.share(AUTHOR, "Live00000001");
    expect(live).toMatchObject({ slug: "Live00000001", title: "Live", public: 1, changed_by_name: "laptop" });
    expect(await store.share(AUTHOR, "Deleted00001")).toBeNull();
    expect(await store.share(AUTHOR, "Other0000001")).toBeNull();
    // Shares published before expiry existed (expiry_set = 1, no date) never start expiring.
    const list = await store.listShares(AUTHOR, { tags: [], sort: "updated_at", page: 1, pageSize: 50 });
    expect(list.rows.map((r) => r.slug).sort()).toEqual(["Forever00001", "Live00000001"]);
    expect(await store.expire(NOW)).toBe(1);
    expect(env.sqlite.prepare("SELECT deleted_at FROM shares WHERE slug = 'Expired00001'").get()).toEqual({ deleted_at: NOW - 1000 });
    expect(env.sqlite.prepare("SELECT COUNT(*) AS n FROM versions WHERE slug = 'Expired00001'").get()).toEqual({ n: 0 });
    // The expired Share's body was queued for deletion, next to the row that was already in the ledger.
    expect(env.sqlite.prepare("SELECT body_key FROM trash ORDER BY body_key").all()).toEqual([{ body_key: "bodies/Expired00001/a" }, { body_key: "bodies/Gone00000001/x" }]);
    // Erasing a Share removes its legacy body too; another Share's legacy rows would stay.
    expect(await store.eraseShare(AUTHOR, "Expired00001")).toBe(true);
    expect(env.sqlite.prepare("SELECT COUNT(*) AS n FROM versions_d1_legacy").get()).toEqual({ n: 0 });
    expect(env.sqlite.prepare("SELECT COUNT(*) AS n FROM shares WHERE slug = 'Expired00001'").get()).toEqual({ n: 0 });
    // A soft-deleted Share can still be erased (the only hard delete) and a foreign one cannot.
    expect(await store.eraseShare(AUTHOR, "Deleted00001")).toBe(true);
    expect(await store.eraseShare(AUTHOR, "Other0000001")).toBe(false);
  });

  test("a fresh database has the same final schema as an upgraded one", () => {
    const { env } = upgraded();
    const fresh = fakeEnv();
    const dump = (e: { sqlite: { prepare: (s: string) => { all: () => unknown[] } } }) =>
      (e.sqlite.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex%' ORDER BY type, name").all() as { type: string; name: string; sql: string }[]);
    const a = dump(env as never);
    const b = dump(fresh as never);
    expect(a.map((r) => r.name)).toEqual(b.map((r) => r.name));
    // The upgraded table's CREATE statement was rewritten by RENAME; the column list is what must match.
    const cols = (e: typeof env) => e.sqlite.prepare("PRAGMA table_info(shares)").all();
    expect(cols(env)).toEqual(cols(fresh));
    for (const r of a.filter((x) => x.type === "index")) expect(r.sql).toBe(b.find((x) => x.name === r.name)!.sql);
  });
});
