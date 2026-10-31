// The API's Share list (Store.listShares) against an independent SQL oracle on a varied database: the same total,
// rows, order and tie-breaking for every filter, sort and page, including a page past the end. The list's total and
// page are read in one batch (docs/perf/PLAN.md W3); this pins that the batch changed nothing they return.
import { describe, expect, test } from "vitest";
import { Store } from "../src/store";
import { fakeEnv } from "./fake-env";

const AUTHOR = "a@example.com";
const NOW = Date.now();

function seeded() {
  const fake = fakeEnv();
  const insert = fake.sqlite.prepare(`INSERT INTO shares (slug, author, title, description, tags, public, latest_version, created_at, updated_at,
    changed_by, changed_at, deleted_at, expires_at, expiry_set) VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?, 'tok', ?, ?, ?, 0)`);
  for (let i = 0; i < 37; i++) {
    const slug = `s${String(i).padStart(11, "0")}`;
    const author = i % 9 === 0 ? "other@example.com" : AUTHOR;
    const tags = JSON.stringify(i % 3 === 0 ? { run: "r1", pr: String(i % 2) } : { run: "r2" });
    // Ties on updated_at (every fourth pair) exercise the slug tie-break.
    const updated = NOW - Math.floor(i / 2) * 1000;
    const deleted = i % 7 === 0 ? NOW - 1 : null;
    const expires = i % 5 === 0 ? NOW - 10 : i % 5 === 1 ? NOW + 86_400_000 : null;
    insert.run(slug, author, `t${i}`, tags, i % 2, NOW - i * 500, updated, NOW, deleted, expires);
  }
  return fake;
}

type Query = { tags: [string, string][]; public?: boolean; sort: "updated_at" | "created_at"; page: number; pageSize: number };

function oracle(fake: ReturnType<typeof fakeEnv>, q: Query) {
  const all = fake.rows<{ slug: string; author: string; tags: string; public: number; updated_at: number; created_at: number; deleted_at: number | null; expires_at: number | null }>("SELECT * FROM shares");
  const live = all.filter((d) => d.author === AUTHOR && d.deleted_at === null && (d.expires_at === null || d.expires_at > Date.now()))
    .filter((d) => q.tags.every(([k, v]) => (JSON.parse(d.tags) as Record<string, string>)[k] === v))
    .filter((d) => q.public === undefined || d.public === (q.public ? 1 : 0))
    .sort((a, b) => b[q.sort] - a[q.sort] || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return { total: live.length, slugs: live.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map((d) => d.slug) };
}

describe("listShares", () => {
  const queries: Query[] = [];
  for (const sort of ["updated_at", "created_at"] as const)
    for (const tags of [[], [["run", "r1"]], [["run", "r1"], ["pr", "0"]], [["run", "nope"]]] as [string, string][][])
      for (const pub of [undefined, true, false])
        for (const [page, pageSize] of [[1, 50], [1, 3], [2, 3], [4, 5], [99, 10]] as const) queries.push({ tags, public: pub, sort, page, pageSize });

  test(`matches the oracle on ${queries.length} queries, empty and out-of-range pages included`, async () => {
    const fake = seeded();
    const store = new Store(fake.db, fake.bucket);
    let empty = 0;
    for (const q of queries) {
      const got = await store.listShares(AUTHOR, q);
      const want = oracle(fake, q);
      expect({ total: got.total, slugs: got.rows.map((r) => r.slug) }, JSON.stringify(q)).toEqual(want);
      if (want.slugs.length === 0 && want.total > 0) empty++;
    }
    // The page past the end still reports the total: the case a single windowed query would lose.
    expect(empty).toBeGreaterThan(0);
  });

  test("returns the row fields the API answers with", async () => {
    const fake = seeded();
    const [first] = (await new Store(fake.db, fake.bucket).listShares(AUTHOR, { tags: [], sort: "updated_at", page: 1, pageSize: 1 })).rows;
    expect(Object.keys(first!).sort()).toEqual(["changed_at", "changed_by", "changed_by_name", "created_at", "description", "expires_at", "latest_version", "public", "slug", "tags", "title", "updated_at", "author"].sort());
  });
});
