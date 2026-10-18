// Independent review of the reserve-before-upload storage ledger, request-body caps and the token-name rule.
// Written from the requirements: R2 never holds more than the cap, the ledger drains, a refused write keeps nothing.
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { AUTHOR, settings, startInstance, type Instance } from "./global-setup";
import { api, asPerson, base as mainBase, mintToken, page } from "./helpers";

const run = promisify(execFile);
const wrangler = join(process.cwd(), "node_modules/.bin/wrangler");
let small: Instance;
let call: ReturnType<typeof api>;

function objects(state: string): number {
  const r2 = join(state, "v3", "r2");
  if (!existsSync(r2)) return 0;
  let n = 0;
  for (const bucket of readdirSync(r2)) {
    const blobs = join(r2, bucket, "blobs");
    if (existsSync(blobs)) n += readdirSync(blobs).length;
  }
  return n;
}

async function sql(state: string, command: string): Promise<{ n: number }[]> {
  const { stdout } = await run(wrangler, ["d1", "execute", "htmlgate-dev", "--local", "--persist-to", state, "--json", "--command", command],
    { env: { ...process.env, CI: "1" } });
  const parsed: unknown = JSON.parse(stdout);
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
  if (typeof first !== "object" || first === null || !("results" in first) || !Array.isArray(first.results)) {
    throw new Error("Wrangler returned no SQL results");
  }
  return (first.results as unknown[]).map((row) => {
    if (typeof row !== "object" || row === null || !("n" in row) || typeof row.n !== "number") {
      throw new Error("Wrangler returned a malformed SQL count");
    }
    return { n: row.n };
  });
}
const until = async (f: () => Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await f()) return true; await new Promise((r) => setTimeout(r, 150)); }
  return false;
};

beforeAll(async () => {
  small = await startInstance(settings(inject("teamUrl"), { STORAGE_LIMIT_BYTES: String(2_500_000) }));
  call = api(await mintToken("rev", small.base), small.base);
});
afterAll(() => small?.stop());

describe("the ledger counts toward the cap", () => {
  test("local D1 provides the millisecond execution clock used for reservations", async () => {
    const before = Date.now();
    const rows = await sql(small.state, "SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS n");
    expect(rows[0]!.n).toBeGreaterThanOrEqual(before);
    expect(rows[0]!.n).toBeLessThanOrEqual(Date.now());
  });
  test("an unexpired reservation (an upload in flight) blocks a publish that would pass the cap, and uploads nothing", async () => {
    await sql(small.state, `INSERT INTO trash (body_key, size, due_at) VALUES ('bodies/ghost/reserved', 2000000, ${Date.now() + 3_600_000})`);
    const before = objects(small.state);
    const r = await call("POST", "/api/shares", { html: page("x".repeat(1_000_000)), title: "t" });
    expect(r.status).toBe(507);
    expect(objects(small.state)).toBe(before);
    // A small publish that fits beside the reservation still works.
    expect((await call("POST", "/api/shares", { html: page("tiny"), title: "t" })).status).toBe(201);
    await sql(small.state, "DELETE FROM trash WHERE body_key = 'bodies/ghost/reserved'");
  });

  test("a due ledger row counts until cleanup deletes it; the refusal itself triggers the cleanup, then the same publish fits", async () => {
    await sql(small.state, `INSERT INTO trash (body_key, size, due_at) VALUES ('bodies/ghost/due', 2000000, 1)`);
    const big = page("y".repeat(1_000_000));
    const first = await call("POST", "/api/shares", { html: big, title: "t" });
    expect(first.status).toBe(507);
    expect(await until(async () => (await sql(small.state, "SELECT COUNT(*) AS n FROM trash WHERE body_key = 'bodies/ghost/due'"))[0]!.n === 0)).toBe(true);
    expect((await call("POST", "/api/shares", { html: big, title: "t" })).status).toBe(201);
  });
});

describe("the ledger drains and matches the bucket", () => {
  test("after a race of PUTs against a DELETE, every ledger row is gone and the bucket holds exactly the kept Versions", async () => {
    const { json: d } = await call("POST", "/api/shares", { html: page("base"), title: "t" });
    const res = await Promise.all([
      call("DELETE", `/api/shares/${d.slug}`),
      ...Array.from({ length: 4 }, (_, i) => call("PUT", `/api/shares/${d.slug}`, { html: page("p" + i) })),
    ]);
    for (const r of res) expect([200, 204, 404, 507], String(r.status)).toContain(r.status);
    expect(await until(async () => (await sql(small.state, "SELECT COUNT(*) AS n FROM trash"))[0]!.n === 0)).toBe(true);
    const kept = (await sql(small.state, "SELECT COUNT(*) AS n FROM versions"))[0]!.n;
    expect(await until(async () => objects(small.state) === kept)).toBe(true);
  });

  test("a failed (507) create leaves no Share, no Version, and no ledger row", async () => {
    const shares = (await sql(small.state, "SELECT COUNT(*) AS n FROM shares"))[0]!.n;
    const versions = (await sql(small.state, "SELECT COUNT(*) AS n FROM versions"))[0]!.n;
    // fill the cap with real Versions, then ask for more
    const big = page("z".repeat(900_000));
    let last = 201;
    for (let i = 0; i < 4 && last === 201; i++) last = (await call("POST", "/api/shares", { html: big, title: "fill" })).status;
    expect(last).toBe(507);
    expect(await until(async () => (await sql(small.state, "SELECT COUNT(*) AS n FROM trash"))[0]!.n === 0)).toBe(true);
    const nowShares = (await sql(small.state, "SELECT COUNT(*) AS n FROM shares"))[0]!.n;
    const nowVersions = (await sql(small.state, "SELECT COUNT(*) AS n FROM versions"))[0]!.n;
    expect(nowVersions - versions).toBe(nowShares - shares);
    expect(await until(async () => objects(small.state) === nowVersions)).toBe(true);
    // Many wrangler d1 calls: slow on a loaded host, so a longer budget than the default 30 s.
  }, 90_000);
});

describe("request bodies", () => {
  test("a maximum-size HTML made only of characters JSON escapes six-fold (about 12 MiB of JSON) is still accepted", async () => {
    const c = api(await mintToken("max"));
    const html = "\u0001".repeat(2 * 1024 * 1024);
    const r = await c("POST", "/api/shares", { html, title: "max" });
    expect(r.status).toBe(201);
    const over = await c("POST", "/api/shares", { html: html + "x", title: "max" });
    expect(over.status).toBe(413);
  });

  test("a declared Content-Length over the cap is refused 413 without the body being read", async () => {
    const token = await mintToken("cl");
    const r = await fetch(`${mainBase}/api/shares`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ html: "a".repeat(13 * 1024 * 1024), title: "t" }),
    });
    expect(r.status).toBe(413);
  });
});

describe("token names", () => {
  const form = (name: string) => asPerson(AUTHOR, {
    method: "POST", headers: { origin: mainBase, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ name }).toString(),
  });
  test("ordinary names with accents, emoji and spaces are accepted", async () => {
    for (const ok of ["Relatório CI", "日本語のトークン", "build 🚀"]) {
      expect((await fetch(`${mainBase}/tokens`, await form(ok))).status, ok).toBe(200);
    }
  });
  test("names that legitimately contain a zero-width joiner or non-joiner (emoji sequences, Persian) are accepted", async () => {
    for (const ok of ["family 👨‍👩‍👧", "می‌خواهم"]) {
      expect((await fetch(`${mainBase}/tokens`, await form(ok))).status, JSON.stringify(ok)).toBe(200);
    }
  });
  test("a urlencoded form with extra and repeated fields uses the first name", async () => {
    const r = await fetch(`${mainBase}/tokens`, await asPerson(AUTHOR, {
      method: "POST", headers: { origin: mainBase, "content-type": "application/x-www-form-urlencoded" }, body: "x=1&name=first&name=second",
    }));
    expect(r.status).toBe(200);
  });
});
