// The storage cap counts what a Publisher makes the Instance hold, not only the bodies in R2: a site's file index is
// stored in D1 beside its Version, and every Version counts at least VERSION_FLOOR, which covers the most metadata a
// Share can carry. So neither a site of empty files with long names nor a stream of empty pages grows the database
// past the cap.
import { afterAll, describe, expect, test } from "vitest";
import { VERSION_FLOOR } from "../src/store";
import { writeZip } from "../packages/cli/src/zip";
import { startInstance, stopAccess, type Instance } from "./reviewer-beta10-harness";

afterAll(stopAccess);

const enc = new TextEncoder();

/** A site of one page and 200 empty files whose long names make its index nearly as large as the zip. */
function bigIndexSite(): Uint8Array {
  const files = [{ path: "index.html", data: enc.encode("<p>x</p>") }];
  for (let k = 0; k < 200; k++) files.push({ path: String(k).padStart(4, "0") + "n".repeat(400), data: new Uint8Array(0) });
  return writeZip(files);
}

const indexBytes = (i: Instance, slug: string) =>
  (i.fake.sqlite.prepare("SELECT LENGTH(CAST(files AS BLOB)) AS n FROM versions WHERE slug = ?").get(slug) as { n: number }).n;

describe("what the storage cap counts", () => {
  test("a site's file index counts with its zip", async () => {
    const zip = bigIndexSite();
    const roomy = await startInstance();
    const first = await roomy.api("POST", "/api/shares?title=idx", zip, roomy.zipHeaders);
    expect(first.status).toBe(201);
    const index = indexBytes(roomy, first.json.slug);
    expect(index).toBeGreaterThan(VERSION_FLOOR);

    // Room for the zip alone is not enough: the index is stored too.
    const zipOnly = await startInstance({ STORAGE_LIMIT_BYTES: String(zip.length + index - 1) });
    const refused = await zipOnly.api("POST", "/api/shares?title=idx", zip, zipOnly.zipHeaders);
    expect(refused.status).toBe(507);
    expect(refused.json.error.code).toBe("quota_exceeded");

    const exact = await startInstance({ STORAGE_LIMIT_BYTES: String(zip.length + index) });
    expect((await exact.api("POST", "/api/shares?title=idx", zip, exact.zipHeaders)).status).toBe(201);
    expect((await exact.api("POST", "/api/shares?title=idx2", zip, exact.zipHeaders)).status).toBe(507);

    // A stored site keeps counting its index: room for a second zip and index, but not the first one's index too.
    const twoMinusOne = await startInstance({ STORAGE_LIMIT_BYTES: String(2 * (zip.length + index) - 1) });
    expect((await twoMinusOne.api("POST", "/api/shares?title=idx", zip, twoMinusOne.zipHeaders)).status).toBe(201);
    expect((await twoMinusOne.api("POST", "/api/shares?title=idx2", zip, twoMinusOne.zipHeaders)).status).toBe(507);
  });

  test("an empty page counts as VERSION_FLOOR, so empty Shares cannot pile up past the cap", async () => {
    const one = await startInstance({ STORAGE_LIMIT_BYTES: String(VERSION_FLOOR) });
    expect((await one.api("POST", "/api/shares", { html: "", title: "empty" })).status).toBe(201);
    const second = await one.api("POST", "/api/shares", { html: "", title: "empty again" });
    expect(second.status).toBe(507);
    expect(one.fake.sqlite.prepare("SELECT COUNT(*) AS n FROM shares").get()).toEqual({ n: 1 });

    const none = await startInstance({ STORAGE_LIMIT_BYTES: String(VERSION_FLOOR - 1) });
    expect((await none.api("POST", "/api/shares", { html: "", title: "empty" })).status).toBe(507);
  });

  test("a new Version of an empty page counts VERSION_FLOOR too", async () => {
    const i = await startInstance({ STORAGE_LIMIT_BYTES: String(2 * VERSION_FLOOR) });
    const s = await i.api("POST", "/api/shares", { html: "", title: "empty" });
    expect((await i.api("PUT", `/api/shares/${s.json.slug}`, { html: "" })).status).toBe(200);
    expect((await i.api("PUT", `/api/shares/${s.json.slug}`, { html: "" })).status).toBe(507);
  });

  test("a body above the floor counts its own size, as before", async () => {
    const html = "x".repeat(VERSION_FLOOR + 1000);
    // Room for the body and one more empty page, less one byte: the body fits, the empty page then does not.
    const i = await startInstance({ STORAGE_LIMIT_BYTES: String(VERSION_FLOOR + 1000 + VERSION_FLOOR - 1) });
    expect((await i.api("POST", "/api/shares", { html, title: "big" })).status).toBe(201);
    expect((await i.api("POST", "/api/shares", { html: "", title: "empty" })).status).toBe(507);
    // With one byte more, it does.
    const roomy = await startInstance({ STORAGE_LIMIT_BYTES: String(VERSION_FLOOR + 1000 + VERSION_FLOOR) });
    expect((await roomy.api("POST", "/api/shares", { html, title: "big" })).status).toBe(201);
    expect((await roomy.api("POST", "/api/shares", { html: "", title: "empty" })).status).toBe(201);
  });

  test("VERSION_FLOOR covers the most metadata a Share can hold", async () => {
    const i = await startInstance();
    // The widest the API accepts: three UTF-8 bytes per character, and metadata values that JSON escapes to six.
    const metadata: Record<string, string> = {};
    for (let k = 0; k < 10; k++) metadata[String(k).padStart(64, "k")] = "\u0001".repeat(256);
    const r = await i.api("POST", "/api/shares", { html: "", title: "￿".repeat(200), description: "￿".repeat(500), metadata });
    expect(r.status).toBe(201);
    const row = i.fake.sqlite.prepare(`SELECT LENGTH(CAST(slug AS BLOB)) + LENGTH(CAST(author AS BLOB)) + LENGTH(CAST(title AS BLOB))
      + LENGTH(CAST(description AS BLOB)) + LENGTH(CAST(tags AS BLOB)) AS n FROM shares WHERE slug = ?`).get(r.json.slug) as { n: number };
    expect(row.n).toBeGreaterThan(15_000);
    expect(row.n).toBeLessThanOrEqual(VERSION_FLOOR);
  });
});
