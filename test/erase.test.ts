// Erasing a Share for good: the one hard delete, for a request to erase someone's data. Only the Author, signed in,
// from this Instance's own page; every Version, the Share's record and its bodies in R2 go, and the hourly cleanup
// finishes the bodies if R2 fails at the time. Runs the real Worker in-process (test/reviewer-beta10-harness.ts).
import { afterAll, describe, expect, test } from "vitest";
import { writeZip } from "../packages/cli/src/zip";
import { AUTHOR, PAGE, startInstance, stopAccess, VIEWER, type Instance } from "./reviewer-beta10-harness";

afterAll(stopAccess);

const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function publish(i: Instance, versions = 1): Promise<string> {
  const r = await i.api("POST", "/api/shares", { html: PAGE, title: "Report on someone" });
  expect(r.status).toBe(201);
  for (let n = 2; n <= versions; n++) {
    expect((await i.api("PUT", `/api/shares/${r.json.slug}`, { html: PAGE + n, title: "Report on someone" })).status).toBe(200);
  }
  return r.json.slug;
}

/** What the Instance holds for a Share: its row, its Versions, its ledgered bodies and its bodies in R2. */
function held(i: Instance, slug: string, keys: string[]) {
  return {
    share: i.fake.one<{ n: number }>("SELECT COUNT(*) AS n FROM shares WHERE slug = ?", slug).n,
    versions: i.fake.one<{ n: number }>("SELECT COUNT(*) AS n FROM versions WHERE slug = ?", slug).n,
    trash: keys.filter((k) => i.fake.one<{ n: number }>("SELECT COUNT(*) AS n FROM trash WHERE body_key = ?", k).n > 0).length,
    objects: keys.filter((k) => i.fake.objects.has(k)).length,
  };
}
const keysOf = (i: Instance, slug: string) => i.fake.rows<{ body_key: string }>("SELECT body_key FROM versions WHERE slug = ?", slug).map((r) => r.body_key);

/** An erase as the Share page's question sends it (confirmed); `confirm: false` is the home's first step. */
const erase = (i: Instance, share: string, init: { as?: string; headers?: Record<string, string>; confirm?: boolean } = {}) =>
  i.call("/erase", { method: "POST", as: init.as ?? AUTHOR, headers: init.headers ?? { ...FORM, origin: i.HOST },
    body: new URLSearchParams(init.confirm === false ? { share } : { share, confirm: "1" }).toString() });

describe("the Author erases a Share for good", () => {
  test("from the Share's page: every Version, the record and the bodies go, and its links answer like a Share that never existed", async () => {
    const i = await startInstance();
    const slug = await publish(i, 2);
    const keys = keysOf(i, slug);
    expect(held(i, slug, keys)).toEqual({ share: 1, versions: 2, trash: 0, objects: 2 });

    const page = await (await i.call(`/s/${slug}`, { as: AUTHOR })).text();
    expect(page).toContain('<form method="post" action="/erase">');
    expect(page).toContain(`<input type="hidden" name="share" value="${slug}"><input type="hidden" name="confirm" value="1">`);

    const r = await erase(i, slug);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`/?erased=${slug}`);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(held(i, slug, keys)).toEqual({ share: 0, versions: 0, trash: 0, objects: 0 });

    const gone = await i.call(`/s/${slug}`, { as: AUTHOR });
    const never = await i.call("/s/AAAAAAAAAAAA", { as: AUTHOR });
    expect(gone.status).toBe(404);
    expect(await gone.text()).toBe(await never.text());
    const api = await i.api("GET", `/api/shares/${slug}`);
    expect(api.status).toBe(404);
    expect(api.json.error.code).toBe("not_found");

    const home = await i.call(`/?erased=${slug}`, { as: AUTHOR });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain(`Erased <code>${slug}</code> for good`);
  });

  test("a Share already deleted, from the home's form, by its link", async () => {
    const i = await startInstance();
    const home = await (await i.call("/", { as: AUTHOR })).text();
    expect(home).toContain('<form method="post" action="/erase"');
    expect(home).toContain('name="share"');
    // A Share's link from either path, its raw link, or the slug alone.
    const forms = [(s: string) => `${i.HOST}/s/${s}`, (s: string) => `${i.HOST}/p/${s}/raw?v=1`, (s: string) => ` ${s} `];
    for (const form of forms) {
      const slug = await publish(i);
      const keys = keysOf(i, slug);
      expect((await i.api("DELETE", `/api/shares/${slug}`)).status).toBe(204);
      // A soft delete keeps the record and the bodies.
      expect(held(i, slug, keys)).toEqual({ share: 1, versions: 1, trash: 0, objects: 1 });
      const r = await erase(i, form(slug));
      expect(r.status, form(slug)).toBe(303);
      expect(held(i, slug, keys)).toEqual({ share: 0, versions: 0, trash: 0, objects: 0 });
    }
  });

  test("from the home, the Author first sees which Share a link names, and nothing is erased until they confirm", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    const keys = keysOf(i, slug);
    const ask = await erase(i, `${i.HOST}/s/${slug}`, { confirm: false });
    expect(ask.status).toBe(200);
    const body = await ask.text();
    expect(body).toContain("Erase this Share?");
    expect(body).toContain("<strong>Report on someone</strong>");
    expect(body).toContain(`<input type="hidden" name="share" value="${slug}"><input type="hidden" name="confirm" value="1">`);
    expect(held(i, slug, keys)).toEqual({ share: 1, versions: 1, trash: 0, objects: 1 });
    expect((await erase(i, slug)).status).toBe(303);
    expect(held(i, slug, keys)).toEqual({ share: 0, versions: 0, trash: 0, objects: 0 });
  });

  test("the erased Share's bodies go at once even behind a backlog of other due bodies", async () => {
    const i = await startInstance();
    const slug = await publish(i, 2);
    const keys = keysOf(i, slug);
    // 600 older due bodies, more than a whole cleanup run takes.
    const insert = i.fake.sqlite.prepare("INSERT INTO trash (body_key, size, due_at) VALUES (?, 1, 1)");
    for (let n = 0; n < 600; n++) insert.run(`backlog-${n}`);
    expect((await erase(i, slug)).status).toBe(303);
    expect(held(i, slug, keys)).toEqual({ share: 0, versions: 0, trash: 0, objects: 0 });
  });

  test("an upload never ledgered under the Share's prefix goes too, and nothing under another Share's", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    const other = await publish(i);
    const keys = keysOf(i, slug);
    await i.fake.bucket.put(`bodies/${slug}/orphan`, "late upload");
    expect((await erase(i, slug)).status).toBe(303);
    expect(held(i, slug, [...keys, `bodies/${slug}/orphan`])).toEqual({ share: 0, versions: 0, trash: 0, objects: 0 });
    expect(held(i, other, keysOf(i, other))).toEqual({ share: 1, versions: 1, trash: 0, objects: 1 });
  });

  test("the bodies of an Instance older than 0.1.0-beta.2 go too, and erasing works once the Operator dropped that table", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    i.fake.sqlite.prepare("INSERT INTO versions_d1_legacy (slug, n, body, size, created_at, token_id) VALUES (?, 1, 'old body', 8, 1, 'x')").run(slug);
    i.fake.sqlite.prepare("INSERT INTO versions_d1_legacy (slug, n, body, size, created_at, token_id) VALUES ('KEEPKEEPKEEP', 1, 'other', 5, 1, 'x')").run();
    expect((await erase(i, slug)).status).toBe(303);
    expect(i.fake.one<{ n: number }>("SELECT COUNT(*) AS n FROM versions_d1_legacy WHERE slug = ?", slug).n).toBe(0);
    expect(i.fake.one<{ n: number }>("SELECT COUNT(*) AS n FROM versions_d1_legacy").n).toBe(1);
    i.fake.sqlite.exec("DROP TABLE versions_d1_legacy");
    const next = await publish(i);
    expect((await erase(i, next)).status).toBe(303);
    expect(held(i, next, [])).toMatchObject({ share: 0, versions: 0 });
  });

  test("a site Share's zip goes too", async () => {
    const i = await startInstance();
    const zip = writeZip([{ path: "index.html", data: new TextEncoder().encode(PAGE) }]);
    const r = await i.api("POST", "/api/shares?title=Site", zip, i.zipHeaders);
    expect(r.status).toBe(201);
    const keys = keysOf(i, r.json.slug);
    expect(held(i, r.json.slug, keys).objects).toBe(1);
    expect((await erase(i, r.json.slug)).status).toBe(303);
    expect(held(i, r.json.slug, keys)).toEqual({ share: 0, versions: 0, trash: 0, objects: 0 });
  });

  test("with R2 down, the record still goes at once and the hourly cleanup deletes the bodies", async () => {
    const i = await startInstance();
    const slug = await publish(i, 2);
    const keys = keysOf(i, slug);
    i.fake.hooks.failBucketDelete = true;
    expect((await erase(i, slug)).status).toBe(303);
    expect(held(i, slug, keys)).toEqual({ share: 0, versions: 0, trash: 2, objects: 2 });
    i.fake.hooks.failBucketDelete = false;
    await i.cron();
    expect(held(i, slug, keys)).toEqual({ share: 0, versions: 0, trash: 0, objects: 0 });
  });

  test("in pt-BR the control and the home's form speak Portuguese", async () => {
    const i = await startInstance({ LANGUAGE: "pt-BR" });
    const slug = await publish(i);
    expect(await (await i.call(`/s/${slug}`, { as: AUTHOR })).text()).toContain("Eliminar de vez");
    expect(await (await i.call("/", { as: AUTHOR })).text()).toContain("Eliminar um Share de vez");
    expect((await erase(i, slug)).status).toBe(303);
    expect(await (await i.call(`/?erased=${slug}`, { as: AUTHOR })).text()).toContain(`<code>${slug}</code> eliminado de vez`);
  });
});

describe("nobody else erases, and nothing else is erased", () => {
  test("a Viewer, someone signed out and a request from another site erase nothing", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    const keys = keysOf(i, slug);
    const intact = { share: 1, versions: 1, trash: 0, objects: 1 };

    // A Viewer gets the same not-found as for any path they cannot use; nobody signed in, the same as anywhere.
    const viewer = await erase(i, slug, { as: VIEWER });
    expect(viewer.status).toBe(404);
    expect(await viewer.text()).toBe(await (await i.call("/nothing-here", { as: VIEWER })).text());
    const anon = await i.call("/erase", { method: "POST", headers: { ...FORM, origin: i.HOST }, body: `share=${slug}` });
    expect(anon.status).toBe(404);
    expect(held(i, slug, keys)).toEqual(intact);

    for (const headers of [
      { ...FORM, "sec-fetch-site": "cross-site", origin: i.HOST },
      { ...FORM, "sec-fetch-site": "same-site" },
      { ...FORM, origin: "https://evil.example" },
      { ...FORM },
    ]) {
      const r = await erase(i, slug, { headers });
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(await r.text()).toContain("did not come from this Instance");
      expect(held(i, slug, keys)).toEqual(intact);
    }

    expect((await i.call("/erase", { as: AUTHOR })).status).toBe(404);
    // A Publisher's token is never a sign-in: with it alone, /erase is the same not-found.
    const token = await i.call("/erase", { method: "POST", headers: { ...FORM, origin: i.HOST, authorization: `Bearer ${i.token}` }, body: `share=${slug}&confirm=1` });
    expect(token.status).toBe(404);
    expect(held(i, slug, keys)).toEqual(intact);
  });

  test("only the Author's own pages show the control", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    expect((await i.api("POST", `/api/shares/${slug}/visibility`, { public: true })).status).toBe(200);
    expect(await (await i.call(`/s/${slug}`, { as: VIEWER })).text()).not.toContain('action="/erase"');
    expect(await (await i.call(`/p/${slug}`)).text()).not.toContain('action="/erase"');
    expect(await (await i.call(`/p/${slug}`, { as: AUTHOR })).text()).not.toContain('action="/erase"');
    expect(await (await i.call("/", { as: VIEWER })).text()).not.toContain('action="/erase"');
  });

  test("an unknown, malformed or oversized request erases nothing and says why", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    const keys = keysOf(i, slug);
    const intact = { share: 1, versions: 1, trash: 0, objects: 1 };
    for (const [share, status, says] of [
      ["", 400, "12-character slug"],
      ["not a slug", 400, "12-character slug"],
      [`${slug}x`, 400, "12-character slug"],
      [`${i.HOST}/tokens`, 400, "12-character slug"],
      ["AAAAAAAAAAAA", 404, "No Share with that link or slug"],
    ] as const) {
      const r = await erase(i, share);
      expect(r.status, share).toBe(status);
      expect(await r.text(), share).toContain(says);
      expect(held(i, slug, keys)).toEqual(intact);
    }
    const big = await i.call("/erase", { method: "POST", as: AUTHOR, headers: { ...FORM, origin: i.HOST }, body: `share=${slug}&pad=${"x".repeat(5000)}` });
    expect(big.status).toBe(413);
    expect(held(i, slug, keys)).toEqual(intact);
  });

  test("another Author's Share on the same database is never erased", async () => {
    const i = await startInstance();
    const mine = await publish(i);
    i.fake.sqlite.exec(`INSERT INTO shares (slug, author, title, tags, public, latest_version, created_at, updated_at, changed_by, changed_at)
      VALUES ('FOREIGN00001', 'someone@else.example', 'theirs', '{}', 0, 1, 1, 1, 'x', 1)`);
    i.fake.sqlite.exec(`INSERT INTO versions (slug, n, body_key, size, created_at, token_id) VALUES ('FOREIGN00001', 1, 'foreign-key', 4, 1, 'x')`);
    await i.fake.bucket.put("foreign-key", "body");
    const r = await erase(i, "FOREIGN00001");
    expect(r.status).toBe(404);
    expect(held(i, "FOREIGN00001", ["foreign-key"])).toEqual({ share: 1, versions: 1, trash: 0, objects: 1 });
    // And erasing one Share leaves the others alone.
    const other = await publish(i);
    expect((await erase(i, mine)).status).toBe(303);
    expect(held(i, other, keysOf(i, other))).toEqual({ share: 1, versions: 1, trash: 0, objects: 1 });
    expect(held(i, "FOREIGN00001", ["foreign-key"])).toEqual({ share: 1, versions: 1, trash: 0, objects: 1 });
    // Each layer holds on its own: the lookup and the erase both refuse another Author's Share.
    expect(await i.store.eraseTarget(AUTHOR, "FOREIGN00001")).toBeNull();
    expect(await i.store.eraseShare(AUTHOR, "FOREIGN00001")).toBe(false);
    expect(held(i, "FOREIGN00001", ["foreign-key"])).toEqual({ share: 1, versions: 1, trash: 0, objects: 1 });
  });
});
