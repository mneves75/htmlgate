import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkRevokeAllModel, checkStoreModel } from "../formal/store-lifecycle.model";
import { detectCodeDeviationsFromSource, HISTORICAL_REVOKE_BUGS, HISTORICAL_STORE_BUGS, runFormalVerification } from "../formal/verify";
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

  test("real SQLite: two concurrent emptyTrash() workers racing dueNow() in the same millisecond keep the re-ledgered row for retry", async () => {
    const env = fakeEnv();
    const origPrepare = env.db.prepare.bind(env.db);
    const FIXED_NOW = 1_800_000_000_000;
    const pinnedDb = {
      ...env.db,
      prepare: (sql: string) => origPrepare(sql.replaceAll("CAST(unixepoch('subsec') * 1000 AS INTEGER)", String(FIXED_NOW))),
    } as unknown as D1Database;

    const origDelete = env.bucket.delete.bind(env.bucket);
    let deleteCount = 0;
    let releaseWorker2!: () => void;
    const worker2Gate = new Promise<void>((r) => { releaseWorker2 = r; });
    const racingBucket = {
      ...env.bucket,
      delete: async (keys: string | string[]) => {
        const n = ++deleteCount;
        await origDelete(keys);
        if (n === 2) await worker2Gate;
      },
    } as unknown as R2Bucket;

    const store = new Store(pinnedDb, racingBucket);
    env.sqlite.prepare("INSERT INTO trash (body_key, size, due_at, nonce) VALUES (?, ?, ?, ?)").run("bodies/S1/k1", 100, FIXED_NOW, "n0");

    // Both workers snapshot ("bodies/S1/k1", "n0") at the same millisecond.
    const w1 = store.emptyTrash();
    const w2 = store.emptyTrash();
    await w1;
    // Worker 1 deleted both R2 and the trash row. Now a late upload completes and dueNow() re-ledgers k1 in the same ms.
    await env.bucket.put("bodies/S1/k1", "<p>late upload</p>");
    await (store as unknown as { dueNow: (key: string, size: number) => Promise<void> }).dueNow("bodies/S1/k1", 100);
    // Worker 2 finishes its stale DELETE FROM trash using its old nonce "n0": must NOT delete the fresher row!
    releaseWorker2();
    await w2;

    expect(env.objects.has("bodies/S1/k1")).toBe(true);
    expect(env.rows("SELECT body_key FROM trash WHERE body_key = 'bodies/S1/k1'")).toEqual([{ body_key: "bodies/S1/k1" }]);
  });

  test("code-to-model conformance rejects src/store.ts when dueNow() drops the fresh nonce update", () => {
    const storeSrc = readFileSync(join(process.cwd(), "src/store.ts"), "utf8");
    const tokenSrc = readFileSync(join(process.cwd(), "scripts/token.mjs"), "utf8");
    const brokenStore = storeSrc.replace("nonce = excluded.nonce", "due_at = excluded.due_at");
    expect(brokenStore).not.toBe(storeSrc);
    const findings = detectCodeDeviationsFromSource(brokenStore, tokenSrc);
    expect(findings.map((f) => f.detectedVariant)).toContain("due-now-two-empty-trash-race");
  });

  test("code-to-model conformance rejects src/store.ts when a token-authorized write skips the live-token re-check", () => {
    const storeSrc = readFileSync(join(process.cwd(), "src/store.ts"), "utf8");
    const tokenSrc = readFileSync(join(process.cwd(), "scripts/token.mjs"), "utf8");
    expect(detectCodeDeviationsFromSource(storeSrc, tokenSrc)).toEqual([]);
    const brokenStore = storeSrc.replace(/(async setPublic[\s\S]*?) AND \$\{LIVE_TOKEN\}/, "$1");
    expect(brokenStore).not.toBe(storeSrc);
    const findings = detectCodeDeviationsFromSource(brokenStore, tokenSrc);
    expect(findings).toEqual([expect.objectContaining({ symbol: "Store.setPublic", detectedVariant: "write-commit-skips-token-check" })]);
  });
});
