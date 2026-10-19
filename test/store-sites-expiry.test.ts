// Store-level behavior of expiry (plan 008) and sites (plan 009), on real SQLite with every migration. No Worker.
import { describe, expect, test } from "vitest";
import { writeZip } from "../packages/cli/src/zip";
import { KEEP_VERSIONS, Store, type Expiry } from "../src/store";
import { readSite } from "../src/zip";
import { fakeEnv } from "./fake-env";

const AUTHOR = "author@example.com";
const DAY = 24 * 60 * 60 * 1000;
const LIMIT = 64 * 1024 * 1024;
const html = "<!doctype html><title>t</title><p>hi</p>";
let counter = 0;
const slug = () => `S${String(++counter).padStart(11, "0")}`;

function setup() {
  const env = fakeEnv();
  return { ...env, store: new Store(env.db, env.bucket) };
}

const page = (s: string, now: number, expiry: Expiry = { at: now + 30 * DAY, set: false }) => ({
  slug: s, author: AUTHOR, title: "t", description: null, tags: "{}", body: html, size: html.length,
  kind: "page" as const, files: null, tokenId: "tok", now, limit: LIMIT, expiry,
});
const version = (s: string, now: number, expiry: Expiry = { at: now + 30 * DAY, set: false }) => ({
  author: AUTHOR, slug: s, body: html, size: html.length, kind: "page" as const, files: null, tokenId: "tok", now, limit: LIMIT, expiry,
});

describe("expiry", () => {
  test("a default date moves with each publish; a date a Publisher set stays", async () => {
    const { store, one } = setup();
    const a = slug();
    const t0 = Date.now();
    expect(await store.createShare(page(a, t0))).toBe("written");
    expect(one<{ expires_at: number; expiry_set: number }>("SELECT expires_at, expiry_set FROM shares WHERE slug = ?", a)).toEqual({ expires_at: t0 + 30 * DAY, expiry_set: 0 });

    expect(await store.addVersion(version(a, t0 + 1000))).toBe("written");
    expect(one<{ expires_at: number }>("SELECT expires_at FROM shares WHERE slug = ?", a).expires_at).toBe(t0 + 1000 + 30 * DAY);

    await store.updateFields(AUTHOR, a, { expiresAt: t0 + 7 * DAY }, "tok", t0 + 2000);
    expect(await store.addVersion(version(a, t0 + 3000))).toBe("written");
    expect(one<{ expires_at: number; expiry_set: number }>("SELECT expires_at, expiry_set FROM shares WHERE slug = ?", a)).toEqual({ expires_at: t0 + 7 * DAY, expiry_set: 1 });

    expect(await store.addVersion(version(a, t0 + 4000, { at: null, set: true }))).toBe("written");
    expect(one<{ expires_at: number | null }>("SELECT expires_at FROM shares WHERE slug = ?", a).expires_at).toBeNull();
    expect((await store.share(AUTHOR, a))!.expires_at).toBeNull();
  });

  test("a Share published before expiry existed keeps never through its next publish", async () => {
    const now = Date.now();
    const env = fakeEnv({
      before: "0004_expiry_and_sites.sql",
      seed: (db) => {
        db.prepare(`INSERT INTO drops (slug, author, title, tags, public, latest_version, created_at, updated_at, changed_by, changed_at)
          VALUES ('OldShare0001', ?, 'old', '{}', 0, 1, ?, ?, 'tok', ?)`).run(AUTHOR, now, now, now);
        db.prepare("INSERT INTO versions (slug, n, body_key, size, created_at, token_id) VALUES ('OldShare0001', 1, 'bodies/OldShare0001/a', 1, ?, 'tok')").run(now);
      },
    });
    const store = new Store(env.db, env.bucket);
    expect(await store.addVersion(version("OldShare0001", now + 1))).toBe("written");
    expect(env.one<{ expires_at: number | null; expiry_set: number }>("SELECT expires_at, expiry_set FROM shares WHERE slug = 'OldShare0001'"))
      .toEqual({ expires_at: null, expiry_set: 1 });
  });

  test("an Instance whose default is never leaves a default Share without a date", async () => {
    const { store } = setup();
    const a = slug();
    await store.createShare(page(a, Date.now(), { at: null, set: false }));
    expect((await store.share(AUTHOR, a))!.expires_at).toBeNull();
  });

  test("an expired Share is missing to every read and refuses every change", async () => {
    const { store, sqlite } = setup();
    const a = slug();
    const now = Date.now();
    await store.createShare(page(a, now));
    sqlite.prepare("UPDATE shares SET expires_at = ? WHERE slug = ?").run(now - 1, a);
    expect(await store.share(AUTHOR, a)).toBeNull();
    expect((await store.listShares(AUTHOR, { tags: [], sort: "updated_at", page: 1, pageSize: 50 })).total).toBe(0);
    expect(await store.recentShares(AUTHOR, 50)).toEqual({ total: 0, publicTotal: 0, shares: [] });
    expect(await store.viewableVersion(AUTHOR, a, false, null)).toBeNull();
    expect(await store.versions(a)).toEqual([]);
    expect(await store.version(a, 1)).toBeNull();
    expect(await store.addVersion(version(a, now))).toBe("gone");
    await store.updateFields(AUTHOR, a, { title: "changed" }, "tok", now);
    await store.setPublic(AUTHOR, a, true, "tok", now);
    expect(await store.deleteShare(AUTHOR, a, "tok", now)).toBe(false);
    expect(sqlite.prepare("SELECT title, public, latest_version, deleted_at FROM shares WHERE slug = ?").get(a)).toEqual({ title: "t", public: 0, latest_version: 1, deleted_at: null });
  });

  test("an expiry passing between the statements of a publish cannot split it", async () => {
    const { store, sqlite, hooks, one } = setup();
    const a = slug();
    const now = Date.now();
    await store.createShare(page(a, now));
    // The Version INSERT was admitted while the Share was live; then the clock passes its expiry.
    hooks.between = (i, sql) => {
      if (i === 0 && sql.startsWith("INSERT INTO versions")) sqlite.prepare("UPDATE shares SET expires_at = 1 WHERE slug = ?").run(a);
    };
    expect(await store.addVersion(version(a, now + 1, { at: now + 1000, set: true }))).toBe("written");
    hooks.between = undefined;
    const d = one<{ latest_version: number }>("SELECT latest_version FROM shares WHERE slug = ?", a);
    const v = one<{ n: number }>("SELECT MAX(n) AS n FROM versions WHERE slug = ?", a);
    expect(d.latest_version).toBe(v.n);
  });

  test("cleanup purges expired Shares 50 at a time until none is left, and only those", async () => {
    const { store, sqlite, objects, one } = setup();
    // Everything happened in the past, so the bodies cleanup queues are due at once.
    const now = Date.now() - 60_000;
    const expired: string[] = [];
    for (let i = 0; i < 53; i++) {
      const s = slug();
      expired.push(s);
      await store.createShare(page(s, now));
      await store.addVersion(version(s, now + 1));
    }
    const deletedFirst = expired[0]!;
    await store.deleteShare(AUTHOR, deletedFirst, "tok", now + 2);
    // Tied dates: every expired Share expires at the same moment.
    sqlite.prepare(`UPDATE shares SET expires_at = ? WHERE slug IN (${expired.map(() => "?").join(",")})`).run(now + 10, ...expired);
    const live = slug();
    await store.createShare(page(live, now));
    const liveBody = one<{ body_key: string }>("SELECT body_key FROM versions WHERE slug = ?", live).body_key;
    // Every Share carries counts; the purge must take the expired ones' and leave the live Share's.
    for (const s of [...expired, live]) {
      sqlite.prepare("INSERT INTO share_views (slug, day, views) VALUES (?, '2026-01-01', 3)").run(s);
    }
    const expiredBodies = 53 * 2;
    expect(objects.size).toBe(expiredBodies + 1);

    expect(await store.expire(now + 20)).toBe(50);
    expect(await store.expire(now + 20)).toBe(3);
    expect(await store.expire(now + 20)).toBe(0);
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM trash WHERE due_at > ?", now + 20).n).toBe(0);

    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM versions WHERE slug != ?", live).n).toBe(0);
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM trash").n).toBe(expiredBodies);
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM shares WHERE deleted_at IS NULL AND slug != ?", live).n).toBe(0);
    expect(one<{ deleted_at: number }>("SELECT deleted_at FROM shares WHERE slug = ?", deletedFirst).deleted_at).toBe(now + 2);
    expect(one<{ deleted_at: number }>("SELECT deleted_at FROM shares WHERE slug = ?", expired[1]!).deleted_at).toBe(now + 10);

    for (let i = 0; i < 3; i++) await store.emptyTrash();
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM trash").n).toBe(0);
    expect([...objects.keys()]).toEqual([liveBody]);
    expect(await store.share(AUTHOR, live)).not.toBeNull();
    // The purged Shares keep no counts: `due` selects Shares that still have Versions, so the delete has to run before
    // the Versions go.
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM share_views WHERE slug != ?", live).n).toBe(0);
    expect(one<{ n: number }>("SELECT views AS n FROM share_views WHERE slug = ?", live).n).toBe(3);
  });

  test("a count lands while the Share is live, and never for one that is gone or expired", async () => {
    const { store, sqlite, one } = setup();
    const now = Date.now();
    const live = slug();
    await store.createShare(page(live, now));
    await store.countView(live, "2026-01-01");
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM share_views WHERE slug = ?", live).n).toBe(1);
    // A view racing an erasure: the page was read, the Author erased the Share, then the count arrives.
    await store.eraseShare(AUTHOR, live);
    await store.countView(live, "2026-01-01");
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM share_views WHERE slug = ?", live).n).toBe(0);
    // And a Share whose date has passed counts nothing, so no row outlives the cleanup that will never see it.
    const old = slug();
    await store.createShare(page(old, now));
    sqlite.prepare("UPDATE shares SET expires_at = ? WHERE slug = ?").run(now - 1000, old);
    await store.countView(old, "2026-01-01");
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM share_views WHERE slug = ?", old).n).toBe(0);
  });

  test("a failed bucket delete keeps the ledger rows for a later try", async () => {
    const { store, sqlite, hooks, one } = setup();
    const a = slug();
    const now = Date.now() - 60_000;
    await store.createShare(page(a, now));
    sqlite.prepare("UPDATE shares SET expires_at = ? WHERE slug = ?").run(now, a);
    await store.expire(now + 1);
    hooks.failBucketDelete = true;
    await expect(store.emptyTrash()).rejects.toThrow();
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM trash").n).toBe(1);
    hooks.failBucketDelete = false;
    await store.emptyTrash();
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM trash").n).toBe(0);
  });
});

describe("sites", () => {
  async function site(store: Store, s: string, now: number) {
    const zip = writeZip([
      { path: "index.html", data: new TextEncoder().encode(html) },
      { path: "css/style.css", data: new TextEncoder().encode("p{color:red}") },
    ]);
    const entries = await readSite(zip);
    const files = JSON.stringify(Object.fromEntries(entries.map((e) => [e.path, [e.offset, e.csize, e.size, e.method]])));
    return { zip, files, input: { ...page(s, now), body: zip, size: zip.length, kind: "site" as const, files } };
  }

  test("a site's file is found by its exact path in its own Version, and nowhere else", async () => {
    const { store } = setup();
    const a = slug();
    const now = Date.now();
    const { input } = await site(store, a, now);
    expect(await store.createShare(input)).toBe("written");
    expect(await store.viewableVersion(AUTHOR, a, false, null)).toMatchObject({ n: 1, kind: "site" });

    const css = await store.siteFile(AUTHOR, a, false, 1, "css/style.css");
    expect(css).not.toBeNull();
    const obj = await store.siteBytes(css!);
    expect(await new Response(obj).text()).toBe("p{color:red}");

    expect(await store.siteFile(AUTHOR, a, false, 1, "CSS/style.css")).toBeNull();
    expect(await store.siteFile(AUTHOR, a, false, 1, "missing.css")).toBeNull();
    expect(await store.siteFile(AUTHOR, a, false, 2, "css/style.css")).toBeNull();
    expect(await store.siteFile(AUTHOR, a, true, 1, "css/style.css")).toBeNull();
    await store.setPublic(AUTHOR, a, true, "tok", now);
    expect(await store.siteFile(AUTHOR, a, true, 1, "css/style.css")).not.toBeNull();
  });

  test("a site Version that leaves the window queues its one zip for deletion", async () => {
    const { store, one } = setup();
    const a = slug();
    const now = Date.now();
    const { input } = await site(store, a, now);
    await store.createShare(input);
    const first = one<{ body_key: string }>("SELECT body_key FROM versions WHERE slug = ? AND n = 1", a).body_key;
    for (let i = 0; i < KEEP_VERSIONS; i++) await store.addVersion(version(a, now + i + 1));
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM trash WHERE body_key = ?", first).n).toBe(1);
    expect(await store.siteFile(AUTHOR, a, false, 1, "css/style.css")).toBeNull();
  });
});
