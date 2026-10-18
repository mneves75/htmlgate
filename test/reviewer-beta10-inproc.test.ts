// Independent review of beta.10, through the real Worker in-process (see reviewer-beta10-harness.ts): no wrangler.
// Requirements: a zip publishes and serves; a Gated site's files load without the Access cookie but only for the
// Allowlist, never with a tampered, expired or foreign ticket, never after a delete or expiry; every Share has an expiry
// (30 days by default, a set date or never stays); an expired Share is missing everywhere and the hourly cleanup purges
// its bodies; Shares published before the migration never start expiring.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { importTicketKey, openTicket, sealTicket } from "../src/ticket";
import { writeZip } from "../packages/cli/src/zip";
import { AUD, AUTHOR, PAGE, startInstance, stopAccess, TICKET_KEY, VIEWER, type Instance } from "./reviewer-beta10-harness";

const enc = new TextEncoder();
const DAY = 86_400_000;
const work = mkdtempSync(join(tmpdir(), "reviewer-beta10-inproc-"));
afterAll(async () => {
  rmSync(work, { recursive: true, force: true });
  await stopAccess();
});

const INDEX_HTML = '<!doctype html><title>site</title><link rel="stylesheet" href="css/site.css"><p id="x">site</p>';
const FILES = {
  "index.html": INDEX_HTML,
  "css/site.css": "p{color:#000}\n".repeat(200),
  "data/info.json": '{"ok":true}',
  "empty.txt": "",
  "img/vec.svg": '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
  "notes/readme.html": "<p>nested</p>",
  "bin/blob.dat": "\u0001\u0002binary",
};
const siteZip = () => writeZip(Object.entries(FILES).map(([path, data]) => ({ path, data: enc.encode(data) })));

async function publishSite(i: Instance, query = "title=Site", zip: Uint8Array = siteZip()) {
  return i.api("POST", `/api/shares?${query}`, zip, i.zipHeaders);
}
const ticketFrom = (html: string) => /src="\/f\/([A-Za-z0-9_-]+)\//.exec(html)?.[1];
const seal = async (i: Instance, t: { slug: string; n: number; email: string; exp: number }, aud = AUD, key = TICKET_KEY) =>
  sealTicket((await importTicketKey(key))!, aud, t);
const NAV = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

describe("Share route cutover without a dev Worker", () => {
  test("the former collection path is not found with a valid token", async () => {
    const i = await startInstance();
    const r = await i.api("GET", "/api/drops");
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("not_found");
  });

  test("the former gated paths are not-found even for the signed-in Author of a live Share", async () => {
    const i = await startInstance();
    const published = await i.api("POST", "/api/shares", { html: PAGE, title: "Live Share" });
    expect(published.status).toBe(201);
    const slug = published.json.slug as string;
    expect((await i.call(new URL(published.json.url as string).pathname, { as: AUTHOR })).status).toBe(200);
    const missing = await i.call("/unknown-share-path", { as: AUTHOR });
    const shape = async (r: Response) => ({ status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() });
    const control = await shape(missing);
    expect(control.status).toBe(404);
    for (const suffix of ["", "/raw"]) {
      expect(await shape(await i.call(`/d/${slug}${suffix}`, { as: AUTHOR }))).toEqual(control);
    }
  });
});

// =====================================================================================================================
describe("expiry: every Share gets a date", () => {
  let i: Instance;
  beforeAll(async () => { i = await startInstance(); });

  test("a Share published with no date expires 30 days after publishing, and the API says so", async () => {
    const before = Date.now();
    const r = await i.api("POST", "/api/shares", { html: PAGE, title: "p" });
    expect(r.status).toBe(201);
    expect(r.json.expires_at).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(r.json.expires_at).toBeLessThanOrEqual(Date.now() + 30 * DAY);
    expect((await i.api("GET", `/api/shares/${r.json.slug}`)).json.expires_at).toBe(r.json.expires_at);
  });
  test("a zip with no date gets the same 30 days", async () => {
    const r = await publishSite(i);
    expect(r.status).toBe(201);
    expect(Math.abs(r.json.expires_at - (Date.now() + 30 * DAY))).toBeLessThan(60_000);
  });
  test("a set date is kept; `null` and `never` mean never", async () => {
    const at = Date.now() + 5 * DAY;
    const a = await i.api("POST", "/api/shares", { html: PAGE, title: "set", expires_at: at });
    expect(a.json.expires_at).toBe(at);
    const b = await i.api("POST", "/api/shares", { html: PAGE, title: "never", expires_at: null });
    expect(b.json.expires_at).toBeNull();
    const c = await publishSite(i, "title=Z&expires_at=never");
    expect(c.status).toBe(201);
    expect(c.json.expires_at).toBeNull();
    const d = await publishSite(i, `title=Z&expires_at=${at}`);
    expect(d.json.expires_at).toBe(at);
  });
  test.each([
    ["in the past", () => Date.now() - 1000],
    ["under a minute ahead", () => Date.now() + 30_000],
    ["beyond 3650 days", () => Date.now() + 3651 * DAY],
    ["a string", () => "2030-01-01"],
    ["a float", () => Date.now() + 1.5 * DAY + 0.5],
    ["a negative number", () => -5],
    ["a boolean", () => false],
  ])("expires_at %s is refused with 400 invalid_expiry", async (_label, value) => {
    const r = await i.api("POST", "/api/shares", { html: PAGE, title: "bad", expires_at: value() });
    expect([r.status, r.json?.error?.code]).toEqual([400, "invalid_expiry"]);
  });
  test("a zip publish refuses a bad expires_at in its query string", async () => {
    for (const q of ["expires_at=abc", "expires_at=", "expires_at=1", "expires_at=-1", "expires_at=1e12", "expires_at=0x10"]) {
      const r = await publishSite(i, `title=Z&${q}`);
      expect([q, r.status]).toEqual([q, 400]);
    }
  });
  test("a new Version of a default-dated Share moves the date forward; of a Share with a set date it does not", async () => {
    const a = (await i.api("POST", "/api/shares", { html: PAGE, title: "slide" })).json;
    i.fake.sqlite.prepare("UPDATE shares SET expires_at = ? WHERE slug = ?").run(Date.now() + 2 * DAY, a.slug);
    const a2 = (await i.api("PUT", `/api/shares/${a.slug}`, { html: PAGE + "2" })).json;
    expect(Math.abs(a2.expires_at - (Date.now() + 30 * DAY))).toBeLessThan(60_000);

    const at = Date.now() + 9 * DAY;
    const b = (await i.api("POST", "/api/shares", { html: PAGE, title: "set", expires_at: at })).json;
    const b2 = (await i.api("PUT", `/api/shares/${b.slug}`, { html: PAGE + "2" })).json;
    expect(b2.expires_at).toBe(at);
    const never = (await i.api("POST", "/api/shares", { html: PAGE, title: "n", expires_at: null })).json;
    expect((await i.api("PUT", `/api/shares/${never.slug}`, { html: PAGE + "2" })).json.expires_at).toBeNull();
    // A zip Version obeys the same rule.
    expect((await i.api("PUT", `/api/shares/${b.slug}?title=B`, siteZip(), i.zipHeaders)).json.expires_at).toBe(at);
  });
  test("PATCH sets, clears and leaves the date alone", async () => {
    const a = (await i.api("POST", "/api/shares", { html: PAGE, title: "patch" })).json;
    const at = Date.now() + 3 * DAY;
    expect((await i.api("PATCH", `/api/shares/${a.slug}`, { expires_at: at })).json.expires_at).toBe(at);
    expect((await i.api("PATCH", `/api/shares/${a.slug}`, { title: "renamed" })).json.expires_at).toBe(at);
    expect((await i.api("PUT", `/api/shares/${a.slug}`, { html: PAGE + "x" })).json.expires_at).toBe(at); // set once, it stays
    expect((await i.api("PATCH", `/api/shares/${a.slug}`, { expires_at: null })).json.expires_at).toBeNull();
    expect((await i.api("PUT", `/api/shares/${a.slug}`, { html: PAGE + "y" })).json.expires_at).toBeNull();
    expect((await i.api("PATCH", `/api/shares/${a.slug}`, { expires_at: 12 })).status).toBe(400);
  });
  test("onboard documents the default", async () => {
    const r = await i.api("GET", "/api/onboard");
    expect(JSON.stringify(r.json)).toContain("expires_at");
    expect(r.json.expiry.default_days).toBe(30);
  });
});

describe("expiry: the Instance default", () => {
  test("EXPIRY_DAYS=7 gives 7 days; 0 gives never", async () => {
    const seven = await startInstance({ EXPIRY_DAYS: "7" });
    const r = (await seven.api("POST", "/api/shares", { html: PAGE, title: "p" })).json;
    expect(Math.abs(r.expires_at - (Date.now() + 7 * DAY))).toBeLessThan(60_000);
    const zero = await startInstance({ EXPIRY_DAYS: "0" });
    expect((await zero.api("POST", "/api/shares", { html: PAGE, title: "p" })).json.expires_at).toBeNull();
    expect((await zero.api("PUT", `/api/shares/${r.slug}`, { html: PAGE })).status).toBe(404); // separate database
  });
  test("a malformed EXPIRY_DAYS makes the Instance answer 503 everywhere, not guess", async () => {
    const bad = await startInstance({ EXPIRY_DAYS: "soon" });
    expect((await bad.call("/api/onboard")).status).toBe(503);
    expect((await bad.call("/", { as: AUTHOR })).status).toBe(503);
  });
});

// =====================================================================================================================
describe("an expired Share is missing everywhere", () => {
  let i: Instance;
  let page: { slug: string }, site: { slug: string };
  let ticket: string;
  beforeAll(async () => {
    i = await startInstance();
    page = (await i.api("POST", "/api/shares", { html: PAGE, title: "page" })).json;
    site = (await publishSite(i)).json;
    for (const s of [page.slug, site.slug]) await i.api("POST", `/api/shares/${s}/visibility`, { public: true });
    ticket = await seal(i, { slug: site.slug, n: 1, email: VIEWER, exp: Date.now() + 3600_000 });
  });

  test("before the date, every path serves (the control)", async () => {
    expect((await i.call(`/p/${page.slug}`)).status).toBe(200);
    expect((await i.call(`/p/${page.slug}/raw`)).status).toBe(200);
    expect((await i.call(`/p/${site.slug}/1/`)).status).toBe(200);
    expect((await i.call(`/f/${ticket}/`)).status).toBe(200);
    expect((await i.call(`/s/${page.slug}`, { as: VIEWER })).status).toBe(200);
    expect((await i.call("/", { as: AUTHOR })).status).toBe(200);
    expect((await i.api("GET", `/api/shares/${site.slug}/versions/1/zip`)).status).toBe(200);
  });

  test("at the date, it is a 404 on every reader and a refusal on every writer", async () => {
    i.fake.sqlite.prepare("UPDATE shares SET expires_at = ? WHERE slug IN (?, ?)").run(Date.now() - 1, page.slug, site.slug);
    const home = await (await i.call("/", { as: AUTHOR })).text();
    expect(home).not.toContain(page.slug);
    expect(home).not.toContain(site.slug);
    const reads = [
      `/p/${page.slug}`, `/p/${page.slug}/raw`, `/p/${site.slug}`, `/p/${site.slug}/raw`, `/p/${site.slug}/1/`, `/p/${site.slug}/1/css/site.css`, `/f/${ticket}/`, `/f/${ticket}/css/site.css`,
    ];
    for (const path of reads) expect([path, (await i.call(path)).status]).toEqual([path, 404]);
    for (const path of [`/s/${page.slug}`, `/s/${page.slug}/raw`, `/s/${site.slug}`, `/s/${site.slug}/raw`, `/s/${site.slug}?v=1`]) {
      expect([path, (await i.call(path, { as: AUTHOR })).status]).toEqual([path, 404]);
    }
    for (const slug of [page.slug, site.slug]) {
      const apiReads = [`/api/shares/${slug}`, `/api/shares/${slug}/versions`, `/api/shares/${slug}/versions/1`, `/api/shares/${slug}/versions/1/zip`];
      for (const p of apiReads) expect([p, (await i.api("GET", p)).status]).toEqual([p, 404]);
      expect((await i.api("PUT", `/api/shares/${slug}`, { html: PAGE })).status).toBe(404);
      expect((await i.api("PUT", `/api/shares/${slug}?title=x`, siteZip(), i.zipHeaders)).status).toBe(404);
      expect((await i.api("PATCH", `/api/shares/${slug}`, { title: "x" })).status).toBe(404);
      expect((await i.api("POST", `/api/shares/${slug}/visibility`, { public: false })).status).toBe(404);
      expect((await i.api("DELETE", `/api/shares/${slug}`)).status).toBe(404);
    }
    const list = await i.api("GET", "/api/shares?pageSize=100");
    expect(list.json.data.map((d: { slug: string }) => d.slug)).not.toContain(page.slug);
    expect(list.json.pagination.total).toBe(0);
  });

  test("a failed write on an expired Share leaves nothing behind in R2 or the ledger", async () => {
    const before = i.fake.objects.size;
    await i.api("PUT", `/api/shares/${site.slug}?title=x`, siteZip(), i.zipHeaders);
    await i.settle();
    expect(i.fake.objects.size).toBe(before);
  });
});

// =====================================================================================================================
describe("the hourly cleanup", () => {
  test("purges an expired Share's bodies for good and leaves live ones alone", async () => {
    const i = await startInstance();
    const dead = (await publishSite(i)).json.slug as string;
    const deadPage = (await i.api("POST", "/api/shares", { html: PAGE, title: "p" })).json.slug as string;
    const live = (await publishSite(i)).json.slug as string;
    const keep = (await i.api("POST", "/api/shares", { html: PAGE, title: "never", expires_at: null })).json.slug as string;
    // v2 of the dead page, so a Share with several Versions is covered.
    await i.api("PUT", `/api/shares/${deadPage}`, { html: PAGE + "2" });
    const keysOf = (slug: string) => i.fake.rows<{ body_key: string }>("SELECT body_key FROM versions WHERE slug = ?", slug).map((r) => r.body_key);
    const deadKeys = [...keysOf(dead), ...keysOf(deadPage)];
    const liveKeys = [...keysOf(live), ...keysOf(keep)];
    expect(deadKeys.length).toBe(3);
    i.fake.sqlite.prepare("UPDATE shares SET expires_at = ? WHERE slug IN (?, ?)").run(Date.now() - 5000, dead, deadPage);

    await i.cron();

    for (const k of deadKeys) expect(i.fake.objects.has(k), k).toBe(false);
    for (const k of liveKeys) expect(i.fake.objects.has(k), k).toBe(true);
    expect(i.fake.rows("SELECT 1 FROM versions WHERE slug IN (?, ?)", dead, deadPage)).toEqual([]);
    expect(i.fake.rows("SELECT 1 FROM trash")).toEqual([]);
    expect(i.fake.one<{ n: number }>("SELECT COUNT(*) AS n FROM shares WHERE deleted_at IS NOT NULL AND slug IN (?, ?)", dead, deadPage).n).toBe(2);
    expect((await i.api("GET", `/api/shares/${live}`)).status).toBe(200);
    expect((await i.api("GET", `/api/shares/${keep}`)).json.expires_at).toBeNull();
    // Running it again changes nothing and does not fail.
    await i.cron();
    expect(i.fake.objects.size).toBe(liveKeys.length);
  });

  test("a Share deleted before it expired is purged when it expires; one deleted and never-expiring is not", async () => {
    const i = await startInstance();
    const a = (await i.api("POST", "/api/shares", { html: PAGE, title: "a" })).json.slug as string;
    const b = (await i.api("POST", "/api/shares", { html: PAGE, title: "b", expires_at: null })).json.slug as string;
    await i.api("DELETE", `/api/shares/${a}`);
    await i.api("DELETE", `/api/shares/${b}`);
    i.fake.sqlite.prepare("UPDATE shares SET expires_at = ? WHERE slug = ?").run(Date.now() - 5000, a);
    await i.cron();
    expect(i.fake.rows("SELECT 1 FROM versions WHERE slug = ?", a)).toEqual([]);
    expect(i.fake.rows("SELECT 1 FROM versions WHERE slug = ?", b).length).toBe(1);
  });

  test("a backlog (400 expired Shares, 600 queued bodies) is worked down without passing 50 operations in one run", async () => {
    const i = await startInstance();
    const many = 400;
    for (let n = 0; n < many; n++) await i.api("POST", "/api/shares", { html: PAGE + n, title: `d${n}` });
    i.fake.sqlite.prepare("UPDATE shares SET expires_at = ?").run(Date.now() - 1000);
    for (let n = 0; n < 600; n++) {
      const key = `bodies/orphan/${n}`;
      await i.fake.bucket.put(key, "x");
      i.fake.sqlite.prepare("INSERT INTO trash (body_key, size, due_at) VALUES (?, 1, ?)").run(key, Date.now() - 1000);
    }
    const run = await i.cron();
    expect(run.d1 + run.r2).toBeLessThanOrEqual(50);
    // Several hourly runs finish the job: nothing is stranded.
    for (let hour = 0; hour < 40 && (i.fake.objects.size > 0 || i.fake.rows("SELECT 1 FROM versions").length > 0); hour++) {
      const r = await i.cron();
      expect(r.d1 + r.r2).toBeLessThanOrEqual(50);
    }
    expect(i.fake.rows("SELECT 1 FROM versions")).toEqual([]);
    expect(i.fake.rows("SELECT 1 FROM trash")).toEqual([]);
    expect(i.fake.objects.size).toBe(0);
  });

  test("a bucket that fails to delete keeps its ledger rows, and the next run retries", async () => {
    const i = await startInstance();
    const slug = (await i.api("POST", "/api/shares", { html: PAGE, title: "p" })).json.slug as string;
    const key = i.fake.one<{ body_key: string }>("SELECT body_key FROM versions WHERE slug = ?", slug).body_key;
    i.fake.sqlite.prepare("UPDATE shares SET expires_at = ? WHERE slug = ?").run(Date.now() - 1000, slug);
    i.fake.hooks.failBucketDelete = true;
    await i.cron().catch(() => undefined);
    expect(i.fake.objects.has(key)).toBe(true);
    expect(i.fake.rows("SELECT 1 FROM trash WHERE body_key = ?", key).length).toBe(1);
    i.fake.hooks.failBucketDelete = false;
    await i.cron();
    expect(i.fake.objects.has(key)).toBe(false);
  });
});

// =====================================================================================================================
describe("Shares published before the migration never start expiring on their own", () => {
  test("old Shares have no date after the migration, a new Version does not give them one, and the cleanup leaves them", async () => {
    const OLD = "oldShare0001";
    const i = await startInstance({}, {
      before: "0004_expiry_and_sites.sql",
      seed: (db) => {
        db.exec(`INSERT INTO drops (slug, author, title, description, tags, public, latest_version, created_at, updated_at, changed_by, changed_at)
          VALUES ('${OLD}', '${AUTHOR}', 'old', NULL, '{}', 1, 1, 1000, 1000, 'tok', 1000)`);
        db.exec(`INSERT INTO versions (slug, n, body_key, size, created_at, token_id) VALUES ('${OLD}', 1, 'bodies/${OLD}/legacy', 40, 1000, 'tok')`);
      },
    });
    await i.fake.bucket.put(`bodies/${OLD}/legacy`, PAGE);
    expect((await i.api("GET", `/api/shares/${OLD}`)).json.expires_at).toBeNull();
    expect((await i.call(`/p/${OLD}`)).status).toBe(200);
    expect((await i.call(`/p/${OLD}/raw`)).status).toBe(200);
    // Publishing again, as a pull request preview would, must not start a clock.
    const again = await i.api("PUT", `/api/shares/${OLD}`, { html: PAGE + "v2" });
    expect(again.json.expires_at).toBeNull();
    const patched = await i.api("PATCH", `/api/shares/${OLD}`, { title: "still old" });
    expect(patched.json.expires_at).toBeNull();
    // And a site Version on an old Share.
    expect((await i.api("PUT", `/api/shares/${OLD}?title=x`, siteZip(), i.zipHeaders)).json.expires_at).toBeNull();
    // A Publisher may still give it a date explicitly.
    const at = Date.now() + DAY;
    expect((await i.api("PATCH", `/api/shares/${OLD}`, { expires_at: at })).json.expires_at).toBe(at);
    await i.api("PATCH", `/api/shares/${OLD}`, { expires_at: null });
    await i.cron();
    expect((await i.api("GET", `/api/shares/${OLD}`)).status).toBe(200);
    expect(i.fake.rows("SELECT 1 FROM versions WHERE slug = ?", OLD).length).toBeGreaterThan(0);
  });
});

// =====================================================================================================================
describe("publishing a zip", () => {
  let i: Instance;
  beforeAll(async () => { i = await startInstance(); });

  test("a Public site serves every file with the right type and the safety headers", async () => {
    const r = await publishSite(i);
    expect(r.status).toBe(201);
    const slug = r.json.slug as string;
    await i.api("POST", `/api/shares/${slug}/visibility`, { public: true });
    const raw = await i.call(`/p/${slug}/raw`);
    expect([raw.status, raw.headers.get("location")]).toEqual([303, `/p/${slug}/1/`]);
    const types: Record<string, string> = {
      "": "text/html; charset=utf-8", "index.html": "text/html; charset=utf-8", "css/site.css": "text/css; charset=utf-8", "data/info.json": "application/json; charset=utf-8",
      "img/vec.svg": "image/svg+xml; charset=utf-8", "notes/readme.html": "text/html; charset=utf-8", "bin/blob.dat": "application/octet-stream", "empty.txt": "text/plain; charset=utf-8",
    };
    for (const [path, type] of Object.entries(types)) {
      const res = await i.call(`/p/${slug}/1/${path}`);
      expect([path, res.status]).toEqual([path, 200]);
      expect(res.headers.get("content-type")).toBe(type);
      expect(res.headers.get("content-security-policy"), path).toMatch(/^sandbox [^;]*; frame-ancestors 'self'$/);
      expect(res.headers.get("content-security-policy")).not.toContain("allow-same-origin");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      const want = FILES[(path || "index.html") as keyof typeof FILES];
      expect(await res.text(), path).toBe(want);
    }
    expect(await (await i.call(`/p/${slug}/1/notes/`)).status).toBe(404); // no notes/index.html
    // The viewer page frames the files, not the raw page.
    const viewer = await (await i.call(`/p/${slug}`)).text();
    expect(viewer).toContain(`src="/p/${slug}/1/"`);
  });

  test("paths that try to leave the site, or do not exist, are 404", async () => {
    const slug = (await publishSite(i)).json.slug as string;
    await i.api("POST", `/api/shares/${slug}/visibility`, { public: true });
    for (const p of ["../x", "%2e%2e/index.html", "css/..%2findex.html", "css%2fsite.css", "css%5csite.css", "%00", "missing.html", "css", "index.html/", "//index.html"]) {
      const res = await i.call(`/p/${slug}/1/${p}`);
      expect([p, res.status]).toEqual([p, 404]);
    }
    // A Version that does not exist, a page-Version of the same Share, other Share's slug with this Version.
    expect((await i.call(`/p/${slug}/2/`)).status).toBe(404);
    expect((await i.call(`/p/${slug}/0/`)).status).toBe(404);
    expect((await i.call(`/p/${"A".repeat(12)}/1/`)).status).toBe(404);
  });

  test("a Gated site's files are not served on the Public path or without a ticket", async () => {
    const slug = (await publishSite(i)).json.slug as string;
    for (const p of [`/p/${slug}/1/`, `/p/${slug}/1/css/site.css`, `/p/${slug}`, `/p/${slug}/raw`]) {
      expect([p, (await i.call(p)).status]).toEqual([p, 404]);
    }
    expect((await i.call(`/s/${slug}`)).status).toBe(404); // no sign-in
  });

  test("a hostile zip is refused with 400 before anything is stored", async () => {
    const objects = i.fake.objects.size;
    const trash = i.fake.rows("SELECT 1 FROM trash").length;
    const bad = writeZip([{ path: "index.html", data: enc.encode("x") }, { path: "../evil.html", data: enc.encode("x") }]);
    const r = await publishSite(i, "title=bad", bad);
    expect([r.status, r.json.error.code]).toEqual([400, "site_invalid"]);
    const notZip = await publishSite(i, "title=bad", enc.encode("<!doctype html><p>not a zip</p>"));
    expect([notZip.status, notZip.json.error.code]).toEqual([400, "site_invalid"]);
    const noIndex = await publishSite(i, "title=bad", writeZip([{ path: "a.html", data: enc.encode("x") }]));
    expect(noIndex.status).toBe(400);
    await i.settle();
    expect(i.fake.objects.size).toBe(objects);
    expect(i.fake.rows("SELECT 1 FROM trash").length).toBe(trash);
  });
  test("a zip over 10 MiB is 413 site_too_large", async () => {
    const r = await publishSite(i, "title=big", new Uint8Array(10 * 1024 * 1024 + 1));
    expect([r.status, r.json.error.code]).toEqual([413, "site_too_large"]);
  });
  test("a zip needs a title; html in the query is refused; a zip body needs the zip content type", async () => {
    expect((await i.api("POST", "/api/shares", siteZip(), i.zipHeaders)).json.error.code).toBe("title_required");
    expect((await publishSite(i, "title=x&html=%3Cp%3E")).status).toBe(400);
    expect((await i.api("POST", "/api/shares?title=x", siteZip(), { "content-type": "application/octet-stream" })).status).toBe(400);
  });
  test("the zip as published can be downloaded byte for byte; a page's cannot", async () => {
    const zip = siteZip();
    const slug = (await publishSite(i, "title=dl", zip)).json.slug as string;
    const res = await i.call(`/api/shares/${slug}/versions/1/zip`, { headers: { authorization: `Bearer ${i.token}` } });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(zip))).toBe(true);
    const page = (await i.api("POST", "/api/shares", { html: PAGE, title: "p" })).json.slug as string;
    expect((await i.api("GET", `/api/shares/${page}/versions/1/zip`)).status).toBe(404);
    const v = await i.api("GET", `/api/shares/${slug}/versions/1`);
    expect(v.json.kind).toBe("site");
    expect(v.json.files.map((f: { path: string }) => f.path).sort()).toEqual(Object.keys(FILES).sort());
    expect(v.json.html).toBeUndefined();
  });
  test("zips made by Info-ZIP and ditto (what a person has) publish and serve their bytes", async () => {
    const tree = join(work, "app");
    mkdirSync(join(tree, "js"), { recursive: true });
    const js = "export const a = 1;\n".repeat(500);
    writeFileSync(join(tree, "index.html"), '<!doctype html><title>a</title><script type="module" src="js/app.js"></script>');
    writeFileSync(join(tree, "js", "app.js"), js);
    for (const [name, args, cwd] of [
      ["infozip.zip", ["-r", "-q", join(work, "infozip.zip"), "app"], work],
      ["ditto.zip", [], work],
    ] as const) {
      if (name === "infozip.zip") execFileSync("zip", [...args], { cwd });
      else execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", tree, join(work, name)]);
      const r = await publishSite(i, "title=tool", new Uint8Array(readFileSync(join(work, name))));
      expect([name, r.status]).toEqual([name, 201]);
      const slug = r.json.slug as string;
      await i.api("POST", `/api/shares/${slug}/visibility`, { public: true });
      expect(await (await i.call(`/p/${slug}/1/js/app.js`)).text()).toBe(js);
      expect((await i.call(`/p/${slug}/1/__MACOSX/._index.html`)).status).toBe(404);
    }
  });
  test("a site keeps at most 20 Versions, and a pruned Version's files are gone", async () => {
    const slug = (await publishSite(i, "title=prune")).json.slug as string;
    await i.api("POST", `/api/shares/${slug}/visibility`, { public: true });
    for (let n = 0; n < 21; n++) await i.api("PUT", `/api/shares/${slug}?title=v`, siteZip(), i.zipHeaders);
    expect((await i.call(`/p/${slug}/1/`)).status).toBe(404);
    expect((await i.call(`/p/${slug}/3/`)).status).toBe(200);
    expect((await i.call(`/p/${slug}/22/`)).status).toBe(200);
  });
});

// =====================================================================================================================
describe("a Gated site's files load with a ticket, and only for the right person", () => {
  let i: Instance;
  let slug: string;
  let ticket: string;
  beforeAll(async () => {
    i = await startInstance();
    slug = (await publishSite(i)).json.slug as string;
    const res = await i.call(`/s/${slug}`, { as: VIEWER });
    expect(res.status).toBe(200);
    ticket = ticketFrom(await res.text())!;
  });

  test("the viewer page (signed in) frames /f/<ticket>/ and does not leak the email or slug into the URL", () => {
    expect(ticket).toBeTruthy();
    expect(ticket).not.toContain("viewer");
    expect(ticket).not.toContain(slug);
  });
  test("the ticket was sealed for the signed-in person, this Share and this Version, valid about an hour", async () => {
    const t = (await openTicket((await importTicketKey(TICKET_KEY))!, AUD, ticket))!;
    expect([t.slug, t.n, t.email]).toEqual([slug, 1, VIEWER]);
    expect(t.exp - Date.now()).toBeGreaterThan(55 * 60_000);
    expect(t.exp - Date.now()).toBeLessThanOrEqual(60 * 60_000);
  });
  test("every file loads with no Access header and no cookie, and carries the safety headers (also an error)", async () => {
    for (const [path, want] of Object.entries(FILES)) {
      const res = await i.call(`/f/${ticket}/${path}`);
      expect([path, res.status]).toEqual([path, 200]);
      expect(await res.text(), path).toBe(want);
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-security-policy")).toMatch(/^sandbox /);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    }
    const miss = await i.call(`/f/${ticket}/nope.html`);
    expect(miss.status).toBe(404);
    expect(miss.headers.get("referrer-policy")).toBe("no-referrer");
    expect(miss.headers.get("cache-control")).toBe("no-store");
    const nav = await i.call(`/f/${"A".repeat(60)}/`);
    expect(nav.status).toBe(404);
    expect(nav.headers.get("referrer-policy")).toBe("no-referrer");
  });
  test("the same files are not reachable through /s with no sign-in, and /s/raw sends a signed-in person to a fresh ticket", async () => {
    expect((await i.call(`/s/${slug}/raw`)).status).toBe(404);
    const raw = await i.call(`/s/${slug}/raw`, { as: VIEWER });
    expect(raw.status).toBe(303);
    expect(raw.headers.get("location")).toMatch(/^\/f\/[A-Za-z0-9_-]+\/$/);
    expect(raw.headers.get("referrer-policy")).toBe("same-origin");
  });
  test("nobody off the Allowlist gets a ticket", async () => {
    for (const who of ["stranger@example.com", "viewer@example.org"]) {
      const res = await i.call(`/s/${slug}`, { as: who });
      expect([who, res.status]).toEqual([who, 404]);
      expect(await res.text()).not.toContain("/f/");
    }
    const wrongAud = await i.call(`/s/${slug}`, { as: VIEWER, asAud: "another-app" });
    expect(wrongAud.status).toBe(404);
  });
  test("a ticket sealed for someone off the Allowlist is refused", async () => {
    const t = await seal(i, { slug, n: 1, email: "stranger@example.com", exp: Date.now() + 3600_000 });
    expect((await i.call(`/f/${t}/`)).status).toBe(404);
  });
  test("a ticket loses its power when its person leaves the Allowlist", async () => {
    const without = await startInstance({ ALLOWLIST: "someone.else@example.com" });
    // Same ticket key and audience, separate database: the Allowlist check, not the Share lookup, must refuse it.
    const s = (await publishSite(without)).json.slug as string;
    const t = await seal(without, { slug: s, n: 1, email: VIEWER, exp: Date.now() + 3600_000 });
    expect((await without.call(`/f/${t}/`)).status).toBe(404);
    const allowed = await seal(without, { slug: s, n: 1, email: "someone.else@example.com", exp: Date.now() + 3600_000 });
    expect((await without.call(`/f/${allowed}/`)).status).toBe(200);
    const author = await seal(without, { slug: s, n: 1, email: AUTHOR, exp: Date.now() + 3600_000 });
    expect((await without.call(`/f/${author}/`)).status).toBe(200);
  });
  test("a tampered ticket, in any one character, is refused", async () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (let at = 0; at < ticket.length; at += 3) {
      const c = alphabet[(alphabet.indexOf(ticket[at]!) + 1) % 64]!;
      const res = await i.call(`/f/${ticket.slice(0, at) + c + ticket.slice(at + 1)}/`);
      expect([at, res.status]).toEqual([at, 404]);
    }
  });
  test("a ticket from another Instance (other key, or other Access audience) is refused", async () => {
    const otherKey = "Q".repeat(42) + "A";
    expect((await i.call(`/f/${await seal(i, { slug, n: 1, email: VIEWER, exp: Date.now() + 3600_000 }, AUD, otherKey)}/`)).status).toBe(404);
    expect((await i.call(`/f/${await seal(i, { slug, n: 1, email: VIEWER, exp: Date.now() + 3600_000 }, "other-aud")}/`)).status).toBe(404);
  });
  test("an expired ticket is a 404 for a subresource and a sign-in redirect for a navigation", async () => {
    const old = await seal(i, { slug, n: 1, email: VIEWER, exp: Date.now() - 1000 });
    expect((await i.call(`/f/${old}/css/site.css`)).status).toBe(404);
    expect((await i.call(`/f/${old}/`, { headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } })).status).toBe(404);
    expect((await i.call(`/f/${old}/`, { headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" } })).status).toBe(404);
    const nav = await i.call(`/f/${old}/`, { headers: NAV });
    expect([nav.status, nav.headers.get("location")]).toEqual([303, `/s/${slug}`]);
    expect(nav.headers.get("referrer-policy")).toBe("no-referrer");
    // The redirect does not reveal anything for a ticket that is merely tampered with.
    const forged = await i.call(`/f/${old.slice(0, -2)}AA/`, { headers: NAV });
    expect(forged.status).toBe(404);
  });
  test("a ticket names one Version of one Share: other Versions, other Shares and pages are refused", async () => {
    const other = (await publishSite(i, "title=other")).json.slug as string;
    const page = (await i.api("POST", "/api/shares", { html: PAGE, title: "page" })).json.slug as string;
    expect((await i.call(`/f/${await seal(i, { slug, n: 2, email: VIEWER, exp: Date.now() + 3600_000 })}/`)).status).toBe(404);
    expect((await i.call(`/f/${await seal(i, { slug: page, n: 1, email: VIEWER, exp: Date.now() + 3600_000 })}/`)).status).toBe(404);
    expect((await i.call(`/f/${await seal(i, { slug: "A".repeat(12), n: 1, email: VIEWER, exp: Date.now() + 3600_000 })}/`)).status).toBe(404);
    // The first ticket does not open the other Share's files even by swapping the path.
    expect(await (await i.call(`/f/${ticket}/index.html`)).text()).toBe(INDEX_HTML);
    expect((await i.call(`/f/${await seal(i, { slug: other, n: 1, email: VIEWER, exp: Date.now() + 3600_000 })}/`)).status).toBe(200);
  });
  test("path tricks under a valid ticket are 404", async () => {
    for (const p of ["../index.html", "%2e%2e/index.html", "css%2f..%2findex.html", "css%5csite.css", "%00"]) {
      const res = await i.call(`/f/${ticket}/${p}`);
      expect([p, res.status]).toEqual([p, 404]);
    }
    expect((await i.call(`/f/${ticket}`)).status).toBe(404);
    expect((await i.call(`/f/${ticket}/index.html`, { method: "POST", body: "x" })).status).toBe(404);
    expect((await i.call(`/f/${ticket}/index.html`, { method: "PUT", body: "x" })).status).toBe(404);
  });
  test("dot segments the URL parser resolves before the Worker sees them can only land on a file of the site, or on nothing", async () => {
    const bodies = new Set(Object.values(FILES));
    for (const p of [".", "./index.html", "css/%2e%2e/index.html", "css/./site.css", "%2e/index.html", "css/%2E%2E/css/site.css"]) {
      const res = await i.call(`/f/${ticket}/${p}`);
      const text = await res.text();
      expect([p, res.status === 404 || (res.status === 200 && bodies.has(text))]).toEqual([p, true]);
    }
    // Climbing out of the ticket's prefix reaches other routes, which still ask for the Access sign-in or 404.
    for (const p of [`/f/${ticket}/../../tokens`, `/f/${ticket}/%2e%2e/%2e%2e/`, `/f/${ticket}/..%2f..%2ftokens`]) {
      const res = await i.call(p);
      expect([p, res.status]).toEqual([p, 404]);
    }
  });
  test("a deleted Share's open ticket stops working at once", async () => {
    const s = (await publishSite(i, "title=del")).json.slug as string;
    const t = ticketFrom(await (await i.call(`/s/${s}`, { as: VIEWER })).text())!;
    expect((await i.call(`/f/${t}/`)).status).toBe(200);
    expect((await i.api("DELETE", `/api/shares/${s}`)).status).toBe(204);
    expect((await i.call(`/f/${t}/`)).status).toBe(404);
    expect((await i.call(`/f/${t}/css/site.css`)).status).toBe(404);
  });
  test("an expired Share's open ticket stops working at once, and returns after the Share is re-dated", async () => {
    const s = (await publishSite(i, "title=exp")).json.slug as string;
    const t = ticketFrom(await (await i.call(`/s/${s}`, { as: VIEWER })).text())!;
    i.fake.sqlite.prepare("UPDATE shares SET expires_at = ? WHERE slug = ?").run(Date.now() - 1, s);
    expect((await i.call(`/f/${t}/`)).status).toBe(404);
    await i.cron();
    expect((await i.call(`/f/${t}/`)).status).toBe(404);
  });
  test("a ticket for a pruned Version stops working", async () => {
    const s = (await publishSite(i, "title=prune")).json.slug as string;
    const t = ticketFrom(await (await i.call(`/s/${s}`, { as: VIEWER })).text())!;
    for (let n = 0; n < 20; n++) await i.api("PUT", `/api/shares/${s}?title=v`, siteZip(), i.zipHeaders);
    expect((await i.call(`/f/${t}/`)).status).toBe(404);
  });
  test("the viewer of an older site Version gets a ticket for that Version", async () => {
    const s = (await publishSite(i, "title=v")).json.slug as string;
    await i.api("PUT", `/api/shares/${s}?title=v`, writeZip([{ path: "index.html", data: enc.encode("v2") }]), i.zipHeaders);
    const t1 = ticketFrom(await (await i.call(`/s/${s}?v=1`, { as: VIEWER })).text())!;
    const t2 = ticketFrom(await (await i.call(`/s/${s}`, { as: VIEWER })).text())!;
    expect(await (await i.call(`/f/${t1}/`)).text()).toBe(INDEX_HTML);
    expect(await (await i.call(`/f/${t2}/`)).text()).toBe("v2");
  });
  test("a malformed ticket key in the settings makes the whole Instance answer 503 (fail closed)", async () => {
    const bad = await startInstance({ TICKET_KEY: "short" });
    expect((await bad.call(`/f/${"A".repeat(60)}/`)).status).toBe(503);
    expect((await bad.call("/robots.txt")).status).toBe(200);
  });
});

// =====================================================================================================================
describe("the viewer shows the date", () => {
  test("Expires <date> appears when the Share has one, and not when it never expires (en and pt-BR)", async () => {
    const i = await startInstance();
    const withDate = (await i.api("POST", "/api/shares", { html: PAGE, title: "d", expires_at: Date.UTC(2031, 5, 15, 12) })).json.slug as string;
    const never = (await i.api("POST", "/api/shares", { html: PAGE, title: "n", expires_at: null })).json.slug as string;
    const a = await (await i.call(`/s/${withDate}`, { as: AUTHOR })).text();
    expect(a).toMatch(/Expires/);
    expect(a).toContain("2031");
    expect(await (await i.call(`/s/${never}`, { as: AUTHOR })).text()).not.toMatch(/Expires/);
    const pt = await startInstance({ LANGUAGE: "pt-BR" });
    const s = (await pt.api("POST", "/api/shares", { html: PAGE, title: "d", expires_at: Date.UTC(2031, 5, 15, 12) })).json.slug as string;
    expect(await (await pt.call(`/s/${s}`, { as: AUTHOR })).text()).toMatch(/Expira em/);
  });
});
