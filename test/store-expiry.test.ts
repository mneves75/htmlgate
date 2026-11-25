// Real SQLite transactions with controlled D1/R2 scheduling: force expiry between statement
// preparation and execution, while cleanup has deleted the body but still holds its ledger row.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, test } from "vitest";
import { Store, VERSION_FLOOR } from "../src/store";

type Statement = {
  sql: string; values: SQLInputValue[];
  bind: (...values: SQLInputValue[]) => Statement;
  run: () => Promise<{ meta: { changes: number } }>;
  all: () => Promise<{ results: unknown[] }>;
};

test.each(["create", "update", "late upload"])("an expired %s cannot claim its body", async (operation) => {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of readdirSync(join(process.cwd(), "migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(process.cwd(), "migrations", migration), "utf8"));
  }
  const objects = new Map<string, string>();
  let bodyDeleted!: () => void;
  const deleted = new Promise<void>((r) => { bodyDeleted = r; });
  let releaseCleanup!: () => void;
  const released = new Promise<void>((r) => { releaseCleanup = r; });
  let cleanup: Promise<unknown> | undefined;
  let delayCommit = false;
  let lateStarted = false;
  let lateOvershoot = false;
  let barrierHit = false;
  const prepare = (sql: string, values: SQLInputValue[] = []): Statement => ({
    sql, values,
    bind: (...bound) => prepare(sql, bound),
    run: async () => {
      // Cleanup's ledger delete waits, so the claim commits while cleanup still holds its row.
      if (cleanup && sql.startsWith("DELETE FROM trash WHERE (body_key, ")) {
        barrierHit = true;
        await released;
      }
      return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
  });
  const db = {
    prepare,
    batch: async (statements: Statement[]) => {
      if (delayCommit && statements[0]!.sql.startsWith("INSERT INTO versions")) {
        delayCommit = false;
        // The old claim has already bound its clock; expire just after that timestamp.
        sqlite.prepare("UPDATE trash SET due_at = ?").run(Date.now() + 5);
        await new Promise((r) => setTimeout(r, 25));
        cleanup = store.emptyTrash();
        await deleted;
      } else if (cleanup) {
        await released;
      }
      sqlite.exec("BEGIN");
      const results = [];
      try {
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
      if (cleanup && statements[0]!.sql.startsWith("INSERT INTO versions")) {
        releaseCleanup();
        await cleanup;
      }
      return results;
    },
  };
  const bucket = {
    put: async (key: string, html: string) => {
      if (operation === "late upload" && !lateStarted) {
        lateStarted = true;
        sqlite.exec("UPDATE trash SET due_at = 1");
        await store.emptyTrash();
        expect(await store.createShare({ ...input, slug: "Expiry000002", body: "other", limit: VERSION_FLOOR })).toBe("written");
      }
      objects.set(key, html);
      if (operation === "late upload" && objects.size === 2) lateOvershoot = true;
    },
    delete: async (keys: string[]) => {
      for (const key of keys) objects.delete(key);
      bodyDeleted();
    },
    get: async (key: string) => objects.has(key) ? { text: async () => objects.get(key)! } : null,
  };
  const store = new Store(db as unknown as D1Database, bucket as unknown as R2Bucket);
  const input = {
    slug: "Expiry000001", author: "author@example.com", title: "expiry", description: null,
    tags: "{}", body: "original", kind: "page" as const, files: null, size: 8, tokenId: "abcdefabcdef", now: Date.now(), limit: 64 * VERSION_FLOOR,
    expiry: { at: null, set: false },
  };
  try {
    if (operation === "update") expect(await store.createShare(input)).toBe("written");
    delayCommit = operation !== "late upload";
    const result = operation === "update" ? await store.addVersion({ ...input, body: "changed" }) : await store.createShare(input);
    expect(result).toBe("gone");
    const versions = sqlite.prepare("SELECT body_key FROM versions").all();
    expect(versions).toHaveLength(operation === "create" ? 0 : 1);
    if (versions.length) expect(await store.body(String(versions[0]!.body_key))).toBe(operation === "update" ? "original" : "other");
    if (operation === "late upload") {
      // Documented lease-overrun limit: the late object exceeds the cap until the refused write's cleanup.
      expect(lateOvershoot).toBe(true);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM trash").get()!.n).toBe(1);
    } else {
      expect(barrierHit).toBe(true);
    }
    await store.emptyTrash();
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM trash").get()!.n).toBe(0);
    expect(objects.size).toBe(versions.length);
    if (operation === "create") {
      // A legacy versionless Share with an expired expires_at must be marked deleted, never resurrected, when expire() clears expires_at.
      const past = Date.now() - 10_000;
      sqlite.prepare("INSERT INTO shares (slug, author, title, description, tags, public, latest_version, created_at, updated_at, changed_by, changed_at, expires_at, expiry_set) VALUES ('Legacy000001', 'author@example.com', 'legacy', 'desc', '{\"a\":\"1\"}', 0, 1, ?, ?, 'abcdefabcdef', ?, ?, 1)")
        .run(past, past, past, past);
      expect(await store.expire(Date.now())).toBeGreaterThanOrEqual(1);
      const legacy = sqlite.prepare("SELECT deleted_at, expires_at, title, description, tags FROM shares WHERE slug = 'Legacy000001'").get() as { deleted_at: number | null; expires_at: number | null; title: string; description: string | null; tags: string };
      expect(legacy).toEqual({ deleted_at: past, expires_at: null, title: "", description: null, tags: "{}" });
      expect((await store.recentShares("author@example.com", 10)).shares.map((s) => s.slug)).not.toContain("Legacy000001");
    }
  } finally {
    releaseCleanup();
    sqlite.close();
  }
});
