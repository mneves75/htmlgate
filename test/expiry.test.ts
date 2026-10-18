// Expiry end to end (plan 008): the default date, a set date, and an expired Share missing on every path until the
// hourly cleanup deletes its bodies. Runs against the real Worker under wrangler dev.
import { beforeAll, describe, expect, test } from "vitest";
import { AUTHOR } from "./global-setup";
import { api, asPerson, base, localObjects, localSql, mintToken, page } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
let call: ReturnType<typeof api>;
beforeAll(async () => {
  call = api(await mintToken("expiry"));
});

const near = (a: number, b: number) => Math.abs(a - b) < 60_000;

describe("the expiry date", () => {
  test("a new Share expires 30 days on by default, and each publish moves a default date forward", async () => {
    const r = await call("POST", "/api/shares", { html: page("a"), title: "default" });
    expect(r.status).toBe(201);
    expect(near(r.json.expires_at, Date.now() + 30 * DAY)).toBe(true);
    await localSql(`UPDATE shares SET expires_at = ${Date.now() + DAY} WHERE slug = '${r.json.slug}'`);
    const put = await call("PUT", `/api/shares/${r.json.slug}`, { html: page("b") });
    expect(near(put.json.expires_at, Date.now() + 30 * DAY)).toBe(true);
  });

  test("a date a Publisher sets stays through later publishes; null is never", async () => {
    const at = Date.now() + 7 * DAY;
    const r = await call("POST", "/api/shares", { html: page("a"), title: "set", expires_at: at });
    expect(r.json.expires_at).toBe(at);
    expect((await call("PUT", `/api/shares/${r.json.slug}`, { html: page("b") })).json.expires_at).toBe(at);
    expect((await call("PATCH", `/api/shares/${r.json.slug}`, { expires_at: null })).json.expires_at).toBeNull();
    expect((await call("PUT", `/api/shares/${r.json.slug}`, { html: page("c") })).json.expires_at).toBeNull();
    expect((await call("GET", `/api/shares/${r.json.slug}`)).json.expires_at).toBeNull();
  });

  test.each([
    ["in the past", () => Date.now() - 1000],
    ["under a minute ahead", () => Date.now() + 10_000],
    ["over ten years ahead", () => Date.now() + 3651 * DAY],
    ["a string", () => "2026-12-31"],
    ["a fraction", () => Date.now() + DAY + 0.5],
  ])("a date %s is refused with invalid_expiry", async (_, at) => {
    const r = await call("POST", "/api/shares", { html: page("x"), title: "bad", expires_at: at() });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("invalid_expiry");
  });

  test("the viewer shows the date", async () => {
    const at = Date.UTC(2031, 0, 2, 3, 4);
    const r = await call("POST", "/api/shares", { html: page("a"), title: "shown", expires_at: at });
    const html = await (await fetch(`${base}/s/${r.json.slug}`, await asPerson(AUTHOR))).text();
    expect(html).toContain(`<time datetime="${new Date(at).toISOString()}">`);
  });
});

describe("an expired Share", () => {
  test("is missing on every path at once, and the hourly cleanup deletes its bodies", async () => {
    const r = await call("POST", "/api/shares", { html: page("a"), title: "expiring" });
    const slug = r.json.slug as string;
    await call("PUT", `/api/shares/${slug}`, { html: page("b") });
    await call("POST", `/api/shares/${slug}/visibility`, { public: true });
    const before = localObjects();
    await localSql(`UPDATE shares SET expires_at = ${Date.now() - 1000} WHERE slug = '${slug}'`);

    for (const path of [`/s/${slug}`, `/s/${slug}/raw`]) expect((await fetch(base + path, await asPerson(AUTHOR))).status).toBe(404);
    for (const path of [`/p/${slug}`, `/p/${slug}/raw`]) expect((await fetch(base + path)).status).toBe(404);
    expect((await call("GET", `/api/shares/${slug}`)).status).toBe(404);
    expect((await call("GET", `/api/shares/${slug}/versions`)).status).toBe(404);
    expect((await call("GET", `/api/shares/${slug}/versions/1`)).status).toBe(404);
    expect((await call("PUT", `/api/shares/${slug}`, { html: page("c") })).status).toBe(404);
    expect((await call("PATCH", `/api/shares/${slug}`, { title: "no" })).status).toBe(404);
    expect((await call("POST", `/api/shares/${slug}/visibility`, { public: false })).status).toBe(404);
    const listed = await call("GET", "/api/shares?pageSize=200");
    expect(listed.json.data.map((d: any) => d.slug)).not.toContain(slug);

    const cron = await fetch(`${base}/__scheduled?cron=${encodeURIComponent("17 * * * *")}`);
    expect(cron.status).toBe(200);
    // One wrangler call: each takes seconds on a busy host.
    const [after] = await localSql(`SELECT
      (SELECT COUNT(*) FROM versions WHERE slug = '${slug}') AS versions,
      (SELECT deleted_at IS NOT NULL FROM shares WHERE slug = '${slug}') AS deleted,
      (SELECT COUNT(*) FROM trash WHERE body_key LIKE 'bodies/${slug}/%') AS queued`);
    expect(after).toEqual({ versions: 0, deleted: 1, queued: 0 });
    // The cleanup also deletes other due bodies (other tests' pruned Versions), so at least these two are gone.
    expect(localObjects()).toBeLessThanOrEqual(before - 2);
  }, 120_000);
});
