// Independent review of beta.10, for the real Worker under wrangler dev (workerd, local D1 and R2). WRITTEN, NOT RUN by
// the reviewer: the shared host forbids wrangler dev while another release gate runs. Run it after the gate with
// `pnpm exec vitest run test/reviewer-beta10-worker.test.ts`.
// What only workerd can prove: native DecompressionStream("deflate-raw") on zips other tools made, R2 ranged reads of
// real entries (including a large one and an empty one), the hourly cleanup through /__scheduled, and that expiry holds
// on D1's own SQL clock.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { importTicketKey, sealTicket } from "../src/ticket";
import { AUD, VIEWER, TICKET_KEY } from "./global-setup";
import { api, base, localObjects, localSql, mintToken, page } from "./helpers";

const work = mkdtempSync(join(tmpdir(), "reviewer-beta10-worker-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let token: string;
beforeAll(async () => { token = await mintToken("reviewer-beta10"); });

const tree = join(work, "site");
const big = Buffer.from(Uint8Array.from({ length: 3 * 1024 * 1024 }, (_, i) => (i * 2654435761) >>> 24)); // 3 MiB, incompressible
const FILES: Record<string, Buffer> = {
  "index.html": Buffer.from('<!doctype html><title>t</title><link rel="stylesheet" href="css/a.css">'),
  "css/a.css": Buffer.from("body{margin:0}\n".repeat(400)),
  "media/big.bin": big,
  "data/ção.json": Buffer.from('{"ok":1}'),
  "empty.txt": Buffer.alloc(0),
};
beforeAll(() => {
  for (const [p, data] of Object.entries(FILES)) {
    mkdirSync(join(tree, p, ".."), { recursive: true });
    writeFileSync(join(tree, p), data);
  }
});

async function publish(zip: Uint8Array, query = "title=T") {
  const res = await fetch(`${base}/api/shares?${query}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/zip" }, body: zip });
  return { status: res.status, json: (await res.json()) as any };
}
async function ticket(slug: string, n = 1, exp = Date.now() + 3600_000) {
  return sealTicket((await importTicketKey(TICKET_KEY))!, AUD, { slug, n, email: VIEWER, exp });
}

describe("zips other tools made, through workerd", () => {
  const makers: [string, (out: string) => void][] = [
    ["Info-ZIP", (out) => void execFileSync("zip", ["-r", "-q", out, "."], { cwd: tree })],
    ["ditto (Finder)", (out) => void execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", tree, out])],
    ["bsdtar, the folder", (out) => void execFileSync("bsdtar", ["-a", "-cf", out, "-C", join(tree, ".."), "site"])],
  ];
  test.each(makers)("%s: every file is served, byte for byte, with a ticket and with no cookie", async (name, make) => {
    const out = join(work, name.replace(/\W+/g, "-") + ".zip");
    make(out);
    const r = await publish(new Uint8Array(readFileSync(out)));
    expect([name, r.status]).toEqual([name, 201]);
    const t = await ticket(r.json.slug);
    for (const [p, data] of Object.entries(FILES)) {
      const res = await fetch(`${base}/f/${t}/${p.split("/").map(encodeURIComponent).join("/")}`);
      expect([name, p, res.status]).toEqual([name, p, 200]);
      expect(Buffer.from(await res.arrayBuffer()).equals(data), `${name} ${p}`).toBe(true);
    }
  });
});

describe("expiry on D1's own clock, and the hourly cleanup through /__scheduled", () => {
  test("a Share whose date passes is missing at once, and the cleanup empties its bodies", async () => {
    const call = api(token);
    const created = await call("POST", "/api/shares", { html: page("soon gone"), title: "gone" });
    expect(created.status).toBe(201);
    const slug = created.json.slug as string;
    const keep = await call("POST", "/api/shares", { html: page("kept"), title: "kept", expires_at: null });
    const before = localObjects();
    await localSql(`UPDATE shares SET expires_at = ${Date.now() - 1000} WHERE slug = '${slug}'`);
    expect((await call("GET", `/api/shares/${slug}`)).status).toBe(404);
    expect((await call("PUT", `/api/shares/${slug}`, { html: page("again") })).status).toBe(404);
    expect((await call("GET", `/api/shares/${keep.json.slug}`)).status).toBe(200);
    const run = await fetch(`${base}/__scheduled?cron=${encodeURIComponent("17 * * * *")}`);
    expect(run.status).toBe(200);
    expect(localObjects()).toBe(before - 1);
    expect(await localSql(`SELECT COUNT(*) AS n FROM versions WHERE slug = '${slug}'`)).toEqual([{ n: 0 }]);
    expect(await localSql(`SELECT COUNT(*) AS n FROM versions WHERE slug = '${keep.json.slug}'`)).toEqual([{ n: 1 }]);
  });

  test("Shares published before migration 0004 never start expiring: expiry_set is 1 for every row that had no date", async () => {
    // The shared Instance's migrations have run, so this proves the migration's rule on D1's own SQL: a Share whose
    // expiry_set = 1 and expires_at IS NULL is never selected by the cleanup, whatever its age.
    const call = api(token);
    const old = await call("POST", "/api/shares", { html: page("old"), title: "old", expires_at: null });
    await localSql(`UPDATE shares SET created_at = 1000, updated_at = 1000 WHERE slug = '${old.json.slug}'`);
    await fetch(`${base}/__scheduled?cron=${encodeURIComponent("17 * * * *")}`);
    expect((await call("GET", `/api/shares/${old.json.slug}`)).status).toBe(200);
    expect((await call("PUT", `/api/shares/${old.json.slug}`, { html: page("old 2") })).json.expires_at).toBeNull();
  });
});
