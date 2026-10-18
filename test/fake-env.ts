// A D1 and an R2 bucket for Store tests that need no Worker: real SQLite (node:sqlite) with every migration,
// and an in-memory bucket. A batch is one transaction, as on D1; `between` runs after each statement of a
// batch, so a test can change the database's state mid-transaction (a clock passing an expiry, say).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export interface FakeStatement {
  sql: string;
  values: SQLInputValue[];
  bind: (...values: SQLInputValue[]) => FakeStatement;
  run: () => Promise<{ meta: { changes: number } }>;
  all: <T = unknown>() => Promise<{ results: T[] }>;
  first: <T = unknown>() => Promise<T | null>;
}

/** `seed`, when given, runs just before the migration named `before`, as data an older Instance already holds. */
export function fakeEnv(opts: { before?: string; seed?: (sqlite: DatabaseSync) => void } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (f === opts.before) opts.seed?.(sqlite);
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }

  const hooks: { between?: (index: number, sql: string) => void; failBucketDelete?: boolean } = {};
  const prepare = (sql: string, values: SQLInputValue[] = []): FakeStatement => ({
    sql, values,
    bind: (...bound) => prepare(sql, bound),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
  });
  const db = {
    prepare,
    batch: async (statements: FakeStatement[]) => {
      sqlite.exec("BEGIN");
      const results = [];
      try {
        for (const [i, s] of statements.entries()) {
          results.push(await s.run());
          hooks.between?.(i, s.sql);
        }
        sqlite.exec("COMMIT");
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
      return results;
    },
  };

  const objects = new Map<string, Uint8Array>();
  const bucket = {
    put: async (key: string, value: string | Uint8Array) => {
      objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value));
    },
    get: async (key: string, opts?: { range?: { offset: number; length: number } }) => {
      const all = objects.get(key);
      if (!all) return null;
      const bytes = opts?.range ? all.slice(opts.range.offset, opts.range.offset + opts.range.length) : all;
      return { body: new Blob([bytes]).stream(), text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer };
    },
    list: async (opts: { prefix?: string; cursor?: string } = {}) => ({
      objects: [...objects.entries()].filter(([k]) => k.startsWith(opts.prefix ?? "")).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => ({ key, size: v.length })),
      truncated: false,
    }),
    delete: async (keys: string | string[]) => {
      if (hooks.failBucketDelete) throw new Error("bucket unavailable");
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  };

  const one = <T>(sql: string, ...values: SQLInputValue[]) => sqlite.prepare(sql).get(...values) as T;
  const rows = <T>(sql: string, ...values: SQLInputValue[]) => sqlite.prepare(sql).all(...values) as T[];
  return { db: db as unknown as D1Database, bucket: bucket as unknown as R2Bucket, sqlite, objects, hooks, one, rows };
}
