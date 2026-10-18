// Share bodies live in R2 (issue #14, revised): one object per Version under a key that is never reused,
// pruned objects really go, concurrent publishes never overwrite each other, and soft delete keeps bodies.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { settings, startInstance, type Instance } from "./global-setup";
import { api, mintToken, page } from "./helpers";

let inst: Instance;
let call: ReturnType<typeof api>;

/** Objects in the local R2 bucket, read from Miniflare's own store: the bucket itself, not the API. */
function objectCount(state = inst.state): number {
  const r2 = join(state, "v3", "r2");
  if (!existsSync(r2)) return 0;
  let n = 0;
  for (const bucket of readdirSync(r2)) {
    const blobs = join(r2, bucket, "blobs");
    if (existsSync(blobs)) n += readdirSync(blobs).length;
  }
  return n;
}

/** Polls until the bucket reaches a count; R2 deletes run after the response. */
async function untilObjects(count: number, ms = 10_000, state = inst.state) {
  const end = Date.now() + ms;
  while (objectCount(state) !== count && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
}

beforeAll(async () => {
  inst = await startInstance(settings(inject("teamUrl")));
  call = api(await mintToken("storage", inst.base), inst.base);
});
afterAll(() => inst?.stop());

describe("bodies in R2", () => {
  test("each Version is one object; past 20 Versions the pruned objects are deleted from the bucket", async () => {
    const start = objectCount();
    const { json: d } = await call("POST", "/api/shares", { html: page("v1"), title: "t" });
    for (let i = 2; i <= 25; i++) expect((await call("PUT", `/api/shares/${d.slug}`, { html: page("v" + i) })).status).toBe(200);
    await untilObjects(start + 20);
    expect(objectCount()).toBe(start + 20);
    expect((await call("GET", `/api/shares/${d.slug}/versions/6`)).json.html).toBe(page("v6"));
    expect((await call("GET", `/api/shares/${d.slug}/versions/5`)).status).toBe(404);
  });

  test("concurrent publishes to one Share each become their own Version; none overwrites another", async () => {
    const { json: d } = await call("POST", "/api/shares", { html: page("base"), title: "t" });
    const bodies = Array.from({ length: 6 }, (_, i) => page("parallel " + i));
    const results = await Promise.all(bodies.map((html) => call("PUT", `/api/shares/${d.slug}`, { html })));
    expect(results.map((r) => r.status)).toEqual(bodies.map(() => 200));
    const kept = (await call("GET", `/api/shares/${d.slug}/versions`)).json.data.map((v: any) => v.n);
    expect(kept.sort((a: number, b: number) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const read = await Promise.all(kept.filter((n: number) => n > 1).map(async (n: number) => (await call("GET", `/api/shares/${d.slug}/versions/${n}`)).json.html));
    expect(read.sort()).toEqual([...bodies].sort());
  });

  test("a soft-deleted Share keeps its bodies in the bucket", async () => {
    const { json: d } = await call("POST", "/api/shares", { html: page("keep"), title: "t" });
    const before = objectCount();
    expect((await call("DELETE", `/api/shares/${d.slug}`)).status).toBe(204);
    await new Promise((r) => setTimeout(r, 500));
    expect(objectCount()).toBe(before);
  });

  test("a publish refused for want of room leaves no object in the bucket: its upload is ledgered, then deleted", async () => {
    const small = await startInstance(settings(inject("teamUrl"), { STORAGE_LIMIT_BYTES: String(2_500_000) }));
    try {
      const c = api(await mintToken("full", small.base), small.base);
      const big = page("z".repeat(1_000_000));
      expect((await c("POST", "/api/shares", { html: big, title: "a" })).status).toBe(201);
      expect((await c("POST", "/api/shares", { html: big, title: "b" })).status).toBe(201);
      const stored = objectCount(small.state);
      for (let i = 0; i < 3; i++) {
        expect((await c("POST", "/api/shares", { html: big, title: "refused" })).status).toBe(507);
        // Room is reserved before the upload, so a refused publish never puts a body in the bucket at all.
        expect(objectCount(small.state)).toBe(stored);
      }
    } finally {
      await small.stop();
    }
  });
});
