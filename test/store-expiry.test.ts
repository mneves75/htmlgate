// Real SQLite transactions with controlled D1/R2 scheduling: force expiry between statement
// preparation and execution, while cleanup has deleted the body but still holds its ledger row.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, test } from "vitest";
import { Store } from "../src/store";

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
  const prepare = (sql: string, values: SQLInputValue[] = []): Statement => ({
    sql, values,
    bind: (...bound) => prepare(sql, bound),
    run: async () => {
      // Cleanup's ledger delete waits, so the claim commits while cleanup still holds its row.
      if (cleanup && sql.startsWith("DELETE FROM trash WHERE (body_key, due_at)")) await released;
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
        expect(await store.createShare({ ...input, slug: "Expiry000002", body: "other", limit: 8 })).toBe("written");
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
    tags: "{}", body: "original", kind: "page" as const, files: null, size: 8, tokenId: "abcdefabcdef", now: Date.now(), limit: 1024,
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
    }
    await store.emptyTrash();
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM trash").get()!.n).toBe(0);
    expect(objects.size).toBe(versions.length);
  } finally {
    releaseCleanup();
    sqlite.close();
  }
});
