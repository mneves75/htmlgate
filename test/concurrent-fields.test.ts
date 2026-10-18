// Actual API requests and SQLite transactions with an explicit interleaving; no timing race.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, test } from "vitest";
import { handleApi } from "../src/api";
import type { Config, Env } from "../src/config";
import { sha256Hex } from "../src/ids";
import { Store } from "../src/store";

type Statement = {
  sql: string; values: SQLInputValue[];
  bind: (...args: SQLInputValue[]) => Statement;
  first: () => Promise<Record<string, unknown> | null>;
  all: () => Promise<{ results: Record<string, unknown>[] }>;
  run: () => Promise<{ meta: { changes: number } }>;
};

test.each(["PATCH", "PUT"])("a delayed %s preserves concurrent omitted fields", async (method) => {
  const sqlite = new DatabaseSync(":memory:");
  for (const m of readdirSync(join(process.cwd(), "migrations")).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(join(process.cwd(), "migrations", m), "utf8"));
  let arrived!: () => void, release!: () => void;
  const held = new Promise<void>((r) => { arrived = r; });
  const resume = new Promise<void>((r) => { release = r; });
  let delay = false;
  const prepare = (sql: string, values: SQLInputValue[] = []): Statement => ({
    sql, values, bind: (...args: SQLInputValue[]) => prepare(sql, args),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    run: async () => {
      if (delay && method === "PATCH" && sql.startsWith("UPDATE shares SET")) { delay = false; arrived(); await resume; }
      return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } };
    },
  });
  const db = {
    prepare, batch: async (statements: Statement[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec("COMMIT"); return results;
      } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
    },
  };
  const bodies = new Map<string, string>();
  const bucket = {
    put: async (key: string, html: string) => {
      if (delay && method === "PUT") { delay = false; arrived(); await resume; }
      bodies.set(key, html);
    },
    get: async (key: string) => bodies.has(key) ? { text: async () => bodies.get(key)! } : null,
    delete: async (keys: string[]) => { for (const key of keys) bodies.delete(key); },
  };
  const env: Env = { DB: db as unknown as D1Database, BODIES: bucket as unknown as R2Bucket, WRITE_LIMIT: { limit: async () => ({ success: true }) } as RateLimit };
  const cfg: Config = { author: "author@example.com", aud: "test", teamUrl: "https://team.example", allowlist: new Set(), storageLimit: 1024, language: "en", ticketKey: "k".repeat(43), expiryDays: 30 };
  const store = new Store(env.DB, env.BODIES);
  const token = "hg_" + "Q".repeat(40);
  const slug = "Concurrent01";
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext;
  const request = (verb: string, body: unknown) => {
    const url = new URL(`https://instance.example/api/shares/${slug}`);
    return handleApi(new Request(url.href, { method: verb, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env, ctx, cfg, url);
  };
  try {
    await store.createToken("abcdefabcdef", cfg.author, "test", await sha256Hex(token), Date.now());
    expect(await store.createShare({ slug, author: cfg.author, title: "original", description: "original", tags: '{"old":"1"}', body: "original", kind: "page", files: null, size: 8, tokenId: "abcdefabcdef", now: Date.now(), limit: 1024, expiry: { at: null, set: false } })).toBe("written");
    delay = true;
    const first = request(method, method === "PATCH" ? { title: "first" } : { html: "second body" });
    await held;
    expect((await request("PATCH", { ...(method === "PUT" ? { title: "concurrent" } : {}), description: null, metadata: { concurrent: "yes" } })).status).toBe(200);
    release();
    expect((await first).status).toBe(200);
    const row = await store.share(cfg.author, slug);
    expect(row?.description).toBeNull();
    expect(row?.tags).toBe('{"concurrent":"yes"}');
    expect(row?.title).toBe(method === "PATCH" ? "first" : "concurrent");
    expect(row?.latest_version).toBe(method === "PUT" ? 2 : 1);
    expect((await request("PATCH", { title: "last", description: "set", metadata: { current: "yes" } })).status).toBe(200);
    const last = await store.share(cfg.author, slug);
    expect(last?.title).toBe("last"); expect(last?.description).toBe("set"); expect(last?.tags).toBe('{"current":"yes"}');
    expect((await request("PATCH", { description: null, metadata: {} })).status).toBe(200);
    const cleared = await store.share(cfg.author, slug);
    expect(cleared?.description).toBeNull(); expect(cleared?.tags).toBe("{}");
    await Promise.all(tasks);
  } finally { release(); sqlite.close(); }
});
