import { describe, expect, test } from "vitest";
import { checkRevokeAllModel, checkStoreModel } from "../formal/store-lifecycle.model";
import { HISTORICAL_REVOKE_BUGS, HISTORICAL_STORE_BUGS, runFormalVerification } from "../formal/verify";
import { fakeEnv } from "./fake-env";
import { Store } from "../src/store";

describe("formal state-machine verification (Store lifecycle & revokeAll)", () => {
  test("current src/store.ts and scripts/token.mjs conform to the model and pass exhaustive BFS with 0 violations", () => {
    const out = runFormalVerification(process.cwd(), { replayBugs: true });
    expect(out.deviations).toEqual([]);
    expect(out.ok).toBe(true);
    expect(out.results.every((r) => r.ok)).toBe(true);
    expect(out.results[0]!.statesExplored).toBeGreaterThan(500);
    expect(out.results[1]!.statesExplored).toBeGreaterThan(5);
  });

  test.each(HISTORICAL_STORE_BUGS)("replays historical Store bug $bug ($source) and catches $expectedInvariant", ({ bug, expectedInvariant }) => {
    const res = checkStoreModel(bug);
    expect(res.ok).toBe(false);
    expect(res.violation?.invariant).toBe(expectedInvariant);
    expect(res.violation?.trace.length).toBeGreaterThan(1);
  });

  test.each(HISTORICAL_REVOKE_BUGS)("replays historical revokeAll bug $bug ($source) and catches $expectedInvariant", ({ bug, expectedInvariant }) => {
    const res = checkRevokeAllModel(bug);
    expect(res.ok).toBe(false);
    expect(res.violation?.invariant).toBe(expectedInvariant);
    expect(res.violation?.trace.length).toBeGreaterThan(2);
  });

  test("real SQLite confirms Store.expire() purges share_views for the expired batch without losing the next batch's views", async () => {
    const env = fakeEnv();
    const store = new Store(env.db, env.bucket);
    const now = Date.now();
    await store.createToken("tok123456789", "a@b.c", "ci", "d", now);
    for (const slug of ["Expire000001", "Expire000002"]) {
      expect(await store.createShare({
        slug, author: "a@b.c", title: slug, description: null, tags: "{}",
        body: "<p>x</p>", kind: "page", files: null, size: 8, tokenId: "tok123456789",
        now, limit: 10_000_000, expiry: { at: now + 60_000, set: true },
      })).toBe("written");
      await store.countView(slug, "2026-11-21");
    }
    env.sqlite.prepare("UPDATE shares SET expires_at = ? WHERE slug = 'Expire000001'").run(now - 10);
    expect(await store.expire(now)).toBe(1);
    expect(env.rows("SELECT slug FROM share_views ORDER BY slug")).toEqual([{ slug: "Expire000002" }]);
  });

  test("real SQLite: dueNow() in the same millisecond as emptyTrash()'s snapshot keeps the re-ledgered row for retry", async () => {
    const env = fakeEnv();
    const origPrepare = env.db.prepare.bind(env.db);
    const FIXED_NOW = 1_800_000_000_000;
    const pinnedDb = {
      ...env.db,
      prepare: (sql: string) => origPrepare(sql.replaceAll("CAST(unixepoch('subsec') * 1000 AS INTEGER)", String(FIXED_NOW))),
    } as unknown as D1Database;

    const origDelete = env.bucket.delete.bind(env.bucket);
    let ranDueNow = false;
    const racingBucket = {
      ...env.bucket,
      delete: async (keys: string | string[]) => {
        await origDelete(keys);
        if (!ranDueNow) {
          ranDueNow = true;
          await env.bucket.put("bodies/S1/k1", "<p>late upload</p>");
          await (store as unknown as { dueNow: (key: string, size: number) => Promise<void> }).dueNow("bodies/S1/k1", 100);
        }
      },
    } as unknown as R2Bucket;

    const store = new Store(pinnedDb, racingBucket);
    env.sqlite.prepare("INSERT INTO trash (body_key, size, due_at) VALUES (?, ?, ?)").run("bodies/S1/k1", 100, FIXED_NOW);

    await store.emptyTrash();
    expect(env.objects.has("bodies/S1/k1")).toBe(true);
    expect(env.rows("SELECT body_key FROM trash WHERE body_key = 'bodies/S1/k1'")).toEqual([{ body_key: "bodies/S1/k1" }]);
  });
});
