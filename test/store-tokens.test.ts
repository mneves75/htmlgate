// A token's use: found and recorded at most once a minute, never for a revoked token. Its round trips are
// counted in test/roundtrips.test.ts.
import { describe, expect, test } from "vitest";
import { Store } from "../src/store";
import { fakeEnv } from "./fake-env";

function setup() {
  const fake = fakeEnv();
  const store = new Store(fake.db, fake.bucket);
  const lastUsed = (id: string) => fake.one<{ last_used_at: number | null }>("SELECT last_used_at FROM tokens WHERE id = ?", id).last_used_at;
  return { fake, store, lastUsed };
}

describe("useToken", () => {
  test("returns the live token and records its first use", async () => {
    const { store, lastUsed } = setup();
    await store.createToken("aaaaaaaaaaaa", "a@example.com", "laptop", "d1", 1_000);
    expect(await store.useToken("d1", 5_000_000)).toEqual({ id: "aaaaaaaaaaaa", author: "a@example.com", name: "laptop" });
    expect(lastUsed("aaaaaaaaaaaa")).toBe(5_000_000);
  });

  test("records use at most once a minute", async () => {
    const { store, lastUsed } = setup();
    await store.createToken("aaaaaaaaaaaa", "a@example.com", "laptop", "d1", 1_000);
    await store.useToken("d1", 5_000_000);
    await store.useToken("d1", 5_059_999);
    expect(lastUsed("aaaaaaaaaaaa")).toBe(5_000_000);
    await store.useToken("d1", 5_060_001);
    expect(lastUsed("aaaaaaaaaaaa")).toBe(5_060_001);
  });

  test("a revoked or unknown token is not found and nothing is recorded", async () => {
    const { store, lastUsed } = setup();
    await store.createToken("aaaaaaaaaaaa", "a@example.com", "laptop", "d1", 1_000);
    await store.createToken("bbbbbbbbbbbb", "a@example.com", "phone", "d2", 1_000);
    expect(await store.revokeToken("a@example.com", "aaaaaaaaaaaa", 2_000)).toBe(true);
    expect(await store.useToken("d1", 5_000_000)).toBeNull();
    expect(lastUsed("aaaaaaaaaaaa")).toBeNull();
    expect(await store.useToken("nope", 5_000_000)).toBeNull();
    expect(lastUsed("bbbbbbbbbbbb")).toBeNull();
  });

  test("when the database refuses the write, an unknown or revoked token is still no token and a live one fails", async () => {
    const { fake, store } = setup();
    await store.createToken("aaaaaaaaaaaa", "a@example.com", "laptop", "d1", 1_000);
    await store.createToken("bbbbbbbbbbbb", "a@example.com", "old", "d2", 1_000);
    await store.revokeToken("a@example.com", "bbbbbbbbbbbb", 2_000);
    const raw = fake.db as unknown as { prepare: (sql: string) => { sql: string }; batch: (s: { sql: string }[]) => Promise<unknown> };
    const readOnly = {
      prepare: (sql: string) => raw.prepare(sql),
      batch: (ss: { sql: string }[]) => (ss.some((s) => s.sql.startsWith("UPDATE")) ? Promise.reject(new Error("read-only")) : raw.batch(ss)),
    } as unknown as D1Database;
    const s = new Store(readOnly, fake.bucket);
    expect(await s.useToken("nope", 5_000_000)).toBeNull();
    expect(await s.useToken("d2", 5_000_000)).toBeNull();
    await expect(s.useToken("d1", 5_000_000)).rejects.toThrow("read-only");
  });
});
