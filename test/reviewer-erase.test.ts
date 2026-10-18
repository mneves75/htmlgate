// Independent review of Erase (commit 819412e), in-process only (no wrangler): the real Worker through
// test/reviewer-beta10-harness.ts. Probes who may erase, what an erase leaves in D1 and R2, races with a publish,
// the trash ledger, headers, language, and the privacy notice against the code.
// Tests named "[finding]" began as `test.fails` for defects this review found; they now pass with the fixes.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { writeZip } from "../packages/cli/src/zip";
import { AUTHOR, PAGE, startInstance, stopAccess, VIEWER, type Instance } from "./reviewer-beta10-harness";

afterAll(stopAccess);

const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function publish(i: Instance, versions = 1, title = "Report on someone"): Promise<string> {
  const r = await i.api("POST", "/api/shares", { html: PAGE, title });
  expect(r.status).toBe(201);
  for (let n = 2; n <= versions; n++) {
    expect((await i.api("PUT", `/api/shares/${r.json.slug}`, { html: PAGE + n })).status).toBe(200);
  }
  return r.json.slug;
}

const count = (i: Instance, sql: string, ...v: string[]) => i.fake.one<{ n: number }>(sql, ...v).n;
/** Everything the Instance still holds for a slug: D1 rows and R2 objects under its prefix. */
function residue(i: Instance, slug: string) {
  const keys = [...i.fake.objects.keys()].filter((k) => k.startsWith(`bodies/${slug}/`));
  return {
    share: count(i, "SELECT COUNT(*) AS n FROM shares WHERE slug = ?", slug),
    versions: count(i, "SELECT COUNT(*) AS n FROM versions WHERE slug = ?", slug),
    legacy: count(i, "SELECT COUNT(*) AS n FROM versions_d1_legacy WHERE slug = ?", slug),
    trash: count(i, "SELECT COUNT(*) AS n FROM trash WHERE body_key LIKE ?", `bodies/${slug}/%`),
    objects: keys.length,
  };
}
const CLEAN = { share: 0, versions: 0, legacy: 0, trash: 0, objects: 0 };

const erase = (i: Instance, share: string, init: { as?: string | null; headers?: Record<string, string>; confirm?: boolean; body?: string } = {}) =>
  i.call("/erase", {
    method: "POST", ...(init.as === null ? {} : { as: init.as ?? AUTHOR }),
    headers: init.headers ?? { ...FORM, origin: i.HOST },
    body: init.body ?? new URLSearchParams(init.confirm === false ? { share } : { share, confirm: "1" }).toString(),
  });

const SECURITY = ["cache-control", "x-content-type-options", "referrer-policy", "strict-transport-security"] as const;
function expectHeaders(r: Response, html: boolean, label: string) {
  expect(r.headers.get("cache-control"), label).toBe("no-store");
  expect(r.headers.get("x-content-type-options"), label).toBe("nosniff");
  expect(r.headers.get("referrer-policy"), label).toBe("same-origin");
  expect(r.headers.get("strict-transport-security"), label).toMatch(/max-age=\d+/);
  if (html) {
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp, label).toContain("default-src 'none'");
    expect(csp, label).toContain("form-action 'self'");
    expect(csp, label).toContain("frame-ancestors 'none'");
    expect(csp, label).not.toContain("unsafe-inline");
  }
}

describe("who may erase", () => {
  test("someone signed in but off the Allowlist, a wrong audience and a garbage assertion erase nothing", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    const before = residue(i, slug);
    const stranger = await erase(i, slug, { as: "stranger@evil.example" });
    expect(stranger.status).toBe(404);
    const wrongAud = await i.call("/erase", { method: "POST", as: AUTHOR, asAud: "someone-elses-app", headers: { ...FORM, origin: i.HOST }, body: `share=${slug}&confirm=1` });
    expect(wrongAud.status).toBe(404);
    const junk = await i.call("/erase", { method: "POST", headers: { ...FORM, origin: i.HOST, "cf-access-jwt-assertion": "a.b.c" }, body: `share=${slug}&confirm=1` });
    expect(junk.status).toBe(404);
    // A forged Author email in a cookie or header is never identity.
    const forged = await i.call("/erase", { method: "POST", headers: { ...FORM, origin: i.HOST, cookie: `CF_Authorization=${AUTHOR}`, "cf-access-authenticated-user-email": AUTHOR }, body: `share=${slug}&confirm=1` });
    expect(forged.status).toBe(404);
    expect(residue(i, slug)).toEqual(before);
    // Off-Allowlist and anonymous answers are the same page as a Viewer's.
    expect(await stranger.text()).toBe(await (await erase(i, slug, { as: VIEWER })).text());
  });

  test("a Share's own script (opaque origin: Origin null, Sec-Fetch-Site cross-site) and navigations cannot erase", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    const before = residue(i, slug);
    for (const headers of [
      { ...FORM, origin: "null", "sec-fetch-site": "cross-site" },
      { ...FORM, origin: "null" },
      { ...FORM, "sec-fetch-site": "none" },
      { ...FORM, "sec-fetch-site": "same-site", origin: i.HOST },
      { ...FORM, origin: i.HOST.replace("https", "http") },
      { ...FORM, origin: i.HOST + ".evil.example" },
      { "content-type": "text/plain", origin: "https://evil.example" },
    ]) {
      const r = await erase(i, slug, { headers });
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(residue(i, slug)).toEqual(before);
    }
  });

  test("only POST on the exact path reaches the erase; other shapes are the not-found page", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    const before = residue(i, slug);
    const init = { as: AUTHOR, headers: { ...FORM, origin: i.HOST }, body: `share=${slug}&confirm=1` };
    for (const [method, path] of [["GET", `/erase?share=${slug}&confirm=1`], ["PUT", "/erase"], ["DELETE", "/erase"], ["POST", "/erase/"], ["POST", "//erase"], ["POST", "/Erase"], ["POST", "/erase/x"]] as const) {
      const r = await i.call(path, { method, ...(method === "GET" ? { as: AUTHOR } : init) });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(residue(i, slug)).toEqual(before);
    }
  });

  test("a stranger's Share id from another Author is a 404 with the same page as a Share that never existed", async () => {
    const i = await startInstance();
    i.fake.sqlite.exec(`INSERT INTO shares (slug, author, title, tags, public, latest_version, created_at, updated_at, changed_by, changed_at)
      VALUES ('FOREIGN00001', 'someone@else.example', 'secret title', '{}', 0, 1, 1, 1, 'x', 1)`);
    const foreign = await erase(i, "FOREIGN00001", { confirm: false });
    const none = await erase(i, "NEVEREXISTED", { confirm: false });
    expect(foreign.status).toBe(404);
    const [a, b] = [await foreign.text(), await none.text()];
    expect(a).not.toContain("secret title");
    expect(a.replace(/FOREIGN00001/g, "X")).toBe(b.replace(/NEVEREXISTED/g, "X"));
  });
});

describe("what an erase leaves behind", () => {
  test("a Share with 22 Versions: pruned bodies still ledgered in trash and R2 go too, with no stray ledger rows", async () => {
    const i = await startInstance();
    const slug = await publish(i, 20);
    // R2 is down while Versions 21 and 22 prune 1 and 2: their bodies wait in trash, still in R2.
    i.fake.hooks.failBucketDelete = true;
    for (const n of [21, 22]) expect((await i.api("PUT", `/api/shares/${slug}`, { html: PAGE + n })).status).toBe(200);
    i.fake.hooks.failBucketDelete = false;
    expect(residue(i, slug)).toMatchObject({ versions: 20, trash: 2, objects: 22 });
    const other = await publish(i);
    i.fake.sqlite.prepare("INSERT INTO trash (body_key, size, due_at) VALUES ('unrelated-key', 1, 1)").run();
    expect((await erase(i, slug)).status).toBe(303);
    expect(residue(i, slug)).toEqual(CLEAN);
    expect(residue(i, other)).toMatchObject({ share: 1, versions: 1, objects: 1 });
    // Another Share's ledger rows are untouched.
    expect(count(i, "SELECT COUNT(*) AS n FROM trash WHERE body_key = 'unrelated-key'")).toBe(1);
  });

  test("an expired Share, purged or not, and one whose purge left ledger rows after an R2 failure, can be erased", async () => {
    const i = await startInstance();
    // Expired, not yet purged: answers as missing, but the Author can still erase it by link.
    const a = await publish(i, 2);
    i.fake.sqlite.prepare("UPDATE shares SET expires_at = 1 WHERE slug = ?").run(a);
    expect((await i.call(`/s/${a}`, { as: AUTHOR })).status).toBe(404);
    expect((await erase(i, a)).status).toBe(303);
    expect(residue(i, a)).toEqual(CLEAN);

    // Purged by the hourly cleanup: only the record, marked deleted, remains.
    const b = await publish(i);
    i.fake.sqlite.prepare("UPDATE shares SET expires_at = 1 WHERE slug = ?").run(b);
    await i.cron();
    expect(residue(i, b)).toMatchObject({ share: 1, versions: 0, objects: 0 });
    expect((await erase(i, b)).status).toBe(303);
    expect(residue(i, b)).toEqual(CLEAN);

    // Purged while R2 was down: ledger rows and objects remain with no Version pointing at them.
    const c = await publish(i, 2);
    i.fake.sqlite.prepare("UPDATE shares SET expires_at = 1 WHERE slug = ?").run(c);
    i.fake.hooks.failBucketDelete = true;
    await i.cron().catch(() => undefined);
    i.fake.hooks.failBucketDelete = false;
    expect(residue(i, c)).toMatchObject({ versions: 0, trash: 2, objects: 2 });
    expect((await erase(i, c)).status).toBe(303);
    expect(residue(i, c)).toEqual(CLEAN);
  });

  test("a second erase of the same Share (double submit) changes nothing more and says no such Share", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    expect((await erase(i, slug)).status).toBe(303);
    const again = await erase(i, slug);
    expect(again.status).toBe(404);
    expect(await again.text()).toContain("No Share with that link or slug");
    expect(residue(i, slug)).toEqual(CLEAN);
  });

  test("R2 listing in several pages: every page of the Share's prefix is deleted, and no other Share's", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    const other = await publish(i);
    for (let n = 0; n < 5; n++) await i.fake.bucket.put(`bodies/${slug}/orphan${n}`, "late");
    const bucket = i.fake.bucket as unknown as { list: (o?: { prefix?: string; cursor?: string }) => Promise<unknown> };
    let pages = 0;
    bucket.list = async (o = {}) => {
      pages++;
      const all = [...i.fake.objects.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort().filter((k) => (o.cursor === undefined ? true : k > o.cursor));
      const page = all.slice(0, 2);
      // As R2 lists them: each object with its key and size.
      return { objects: page.map((key) => ({ key, size: i.fake.objects.get(key)!.length })), truncated: all.length > 2, cursor: page.at(-1) };
    };
    expect((await erase(i, slug)).status).toBe(303);
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(residue(i, slug)).toEqual(CLEAN);
    expect(residue(i, other)).toMatchObject({ share: 1, objects: 1 });
  });

  test("a site Share: the tickets already issued and its public files stop working at once", async () => {
    const i = await startInstance();
    const zip = writeZip([{ path: "index.html", data: new TextEncoder().encode(PAGE) }]);
    const r = await i.api("POST", "/api/shares?title=Site", zip, i.zipHeaders);
    expect(r.status).toBe(201);
    const slug = r.json.slug as string;
    expect((await i.api("POST", `/api/shares/${slug}/visibility`, { public: true })).status).toBe(200);
    const page = await (await i.call(`/s/${slug}`, { as: AUTHOR })).text();
    const ticket = /src="(\/f\/[A-Za-z0-9_-]+\/)"/.exec(page)?.[1];
    expect(ticket).toBeTruthy();
    expect((await i.call(`${ticket}index.html`)).status).toBe(200);
    expect((await i.call(`/p/${slug}/1/index.html`)).status).toBe(200);
    expect((await erase(i, slug)).status).toBe(303);
    expect((await i.call(`${ticket}index.html`)).status).toBe(404);
    expect((await i.call(`/p/${slug}/1/index.html`)).status).toBe(404);
    expect((await i.call(`/p/${slug}`)).status).toBe(404);
    expect((await i.call(`/p/${slug}/raw`)).status).toBe(404);
    expect(residue(i, slug)).toEqual(CLEAN);
  });

  test("the API cannot write to, restore or re-create an erased slug, and leaves nothing in R2", async () => {
    const i = await startInstance();
    const slug = await publish(i, 2);
    expect((await erase(i, slug)).status).toBe(303);
    const put = await i.api("PUT", `/api/shares/${slug}`, { html: PAGE + "after" });
    expect(put.status).toBe(404);
    expect((await i.api("PATCH", `/api/shares/${slug}`, { title: "x" })).status).toBe(404);
    expect((await i.api("DELETE", `/api/shares/${slug}`)).status).toBe(404);
    expect((await i.api("POST", `/api/shares/${slug}/visibility`, { public: true })).status).toBe(404);
    expect(residue(i, slug)).toEqual(CLEAN);
    const list = await i.api("GET", "/api/shares");
    expect(JSON.stringify(list.json)).not.toContain(slug);
  });

  test("the storage cap counts nothing of an erased Share afterwards", async () => {
    const i = await startInstance();
    const slug = await publish(i, 3);
    expect((await erase(i, slug)).status).toBe(303);
    const total = count(i, "SELECT COALESCE(SUM(size),0) AS n FROM versions") + count(i, "SELECT COALESCE(SUM(size),0) AS n FROM trash");
    expect(total).toBe(0);
  });

  test("[finding] an unledgered upload under the prefix is ledgered by an erase that meets an R2 outage, and the hourly cleanup deletes it", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    await i.fake.bucket.put(`bodies/${slug}/orphan`, "never ledgered");
    i.fake.hooks.failBucketDelete = true;
    expect((await erase(i, slug)).status).toBe(303);
    i.fake.hooks.failBucketDelete = false;
    await i.cron();
    // Requirement: erasing leaves no object under the Share's prefix; docs/privacy.md says the sweep also covers it.
    expect(residue(i, slug)).toEqual(CLEAN);
  });
});

describe("races with a publish", () => {
  const patchPut = (i: Instance, slug: string, around: (orig: () => Promise<void>) => Promise<void>) => {
    const bucket = i.fake.bucket as unknown as { put: (k: string, v: string | Uint8Array, o?: unknown) => Promise<void> };
    const orig = bucket.put.bind(bucket);
    let fired = false;
    bucket.put = async (k, v, o) => {
      if (fired || !k.startsWith(`bodies/${slug}/`)) return orig(k, v, o);
      fired = true;
      await around(() => orig(k, v, o));
    };
  };

  test("erase lands after the upload and before its Version commits: nothing is recreated and cleanup leaves no object or ledger row", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    patchPut(i, slug, async (put) => {
      await put();
      expect((await erase(i, slug)).status).toBe(303);
    });
    const put = await i.api("PUT", `/api/shares/${slug}`, { html: PAGE + "racing" });
    expect(put.status).toBe(404);
    expect(residue(i, slug)).toMatchObject({ share: 0, versions: 0, objects: 0 });
    await i.cron();
    expect(residue(i, slug)).toEqual(CLEAN);
    expect(count(i, "SELECT COUNT(*) AS n FROM trash")).toBe(0);
  });

  test("erase lands between the reservation and the upload: the late body does not outlive the cleanup", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    patchPut(i, slug, async (put) => {
      expect((await erase(i, slug)).status).toBe(303);
      await put();
    });
    const put = await i.api("PUT", `/api/shares/${slug}`, { html: PAGE + "racing" });
    expect(put.status).toBe(404);
    // The failed write ledgers its late body as due and the request's own cleanup (or the next hourly run) deletes it.
    expect(residue(i, slug)).toMatchObject({ share: 0, versions: 0 });
    await i.cron();
    expect(residue(i, slug)).toEqual(CLEAN);
  });

  test("erase with R2 down, then two cleanup runs: the ledger rows are consumed once and nothing is left", async () => {
    const i = await startInstance();
    const slug = await publish(i, 3);
    i.fake.hooks.failBucketDelete = true;
    expect((await erase(i, slug)).status).toBe(303);
    expect(residue(i, slug)).toMatchObject({ versions: 0, share: 0, trash: 3, objects: 3 });
    i.fake.hooks.failBucketDelete = false;
    await i.cron();
    await i.cron();
    expect(residue(i, slug)).toEqual(CLEAN);
  });
});

describe("a confirmation precedes every erase a person can start", () => {
  test("the Share page's control is a closed <details> whose only form is the second click; the home's first step never carries confirm", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    const page = await (await i.call(`/s/${slug}`, { as: AUTHOR })).text();
    const block = /<details class="confirm">[\s\S]*?<\/details>/.exec(page)?.[0] ?? "";
    expect(block).toContain('action="/erase"');
    expect(block).not.toMatch(/<details[^>]*\sopen/);
    expect(page.match(/action="\/erase"/g)).toHaveLength(1);
    expect(page).toContain("<strong>Report on someone</strong>");

    const home = await (await i.call("/", { as: AUTHOR })).text();
    const form = /<form method="post" action="\/erase"[\s\S]*?<\/form>/.exec(home)?.[0] ?? "";
    expect(form).toContain('name="share"');
    expect(form).not.toContain('name="confirm"');

    // The first step on the home, by link, by slug or with confirm set to anything but 1, erases nothing.
    for (const body of [`share=${slug}`, `share=${slug}&confirm=0`, `share=${slug}&confirm=`, `share=${slug}&confirm=true`, `share=${slug}&confirm=11`]) {
      const r = await erase(i, slug, { body });
      expect(r.status, body).toBe(200);
      expect(await r.text()).toContain("Erase this Share?");
      expect(residue(i, slug)).toMatchObject({ share: 1, versions: 1, objects: 1 });
    }
    // A repeated field: the first wins, so a decoy cannot slip a second Share in.
    const other = await publish(i);
    const r = await erase(i, slug, { body: `share=${slug}&share=${other}&confirm=1` });
    expect(r.status).toBe(303);
    expect(residue(i, other)).toMatchObject({ share: 1 });
  });

  test("the control and its form never reach a public path, a Viewer, or a signed-out visitor, even on a Public Share", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    expect((await i.api("POST", `/api/shares/${slug}/visibility`, { public: true })).status).toBe(200);
    for (const [path, as] of [[`/p/${slug}`, undefined], [`/p/${slug}`, AUTHOR], [`/s/${slug}`, VIEWER], ["/", VIEWER]] as const) {
      const body = await (await i.call(path, as ? { as } : {})).text();
      expect(body, `${path} as ${as}`).not.toMatch(/\/erase|class="confirm"/);
    }
    expect(await (await i.call(`/s/${slug}`, { as: AUTHOR })).text()).toContain('action="/erase"');
  });

  test("legacy bodies of every Version of the Share go in the same erase, and only that Share's", async () => {
    const i = await startInstance();
    const slug = await publish(i, 2);
    const other = await publish(i);
    const ins = i.fake.sqlite.prepare("INSERT INTO versions_d1_legacy (slug, n, body, size, created_at, token_id) VALUES (?, ?, 'old', 3, 1, 'x')");
    ins.run(slug, 1); ins.run(slug, 2); ins.run(other, 1);
    expect((await erase(i, slug)).status).toBe(303);
    expect(residue(i, slug)).toEqual(CLEAN);
    expect(residue(i, other)).toMatchObject({ legacy: 1, share: 1 });
  });

  test("a crafted ?erased= note appears only to the Author, only for a well-formed slug, and escapes everything", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    const forged = await (await i.call(`/?erased=${slug}`, { as: AUTHOR })).text();
    // [finding, fixed] a link cannot make the home say a live Share was erased.
    expect(forged).not.toContain("Erased <code>");
    expect(residue(i, slug)).toMatchObject({ share: 1 });
    for (const bad of ["<script>alert(1)</script>", `${slug}x`, "short", "%3Cimg%20src%3Dx%3E"]) {
      const body = await (await i.call(`/?erased=${bad}`, { as: AUTHOR })).text();
      expect(body, bad).not.toContain("Erased <code>");
      expect(body, bad).not.toMatch(/<script>alert/);
    }
    expect(await (await i.call(`/?erased=${slug}`, { as: VIEWER })).text()).not.toContain("Erased <code>");
  });

  test("a Share title is escaped in the Share page's question and the home's confirmation", async () => {
    const i = await startInstance();
    const slug = await publish(i, 1, `<img src=x onerror=alert(1)> & "quote"`);
    const page = await (await i.call(`/s/${slug}`, { as: AUTHOR })).text();
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
    const ask = await (await erase(i, slug, { confirm: false })).text();
    expect(ask).not.toContain("<img src=x");
    expect(ask).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("odd link shapes: only a 12-character slug, bare or in a /s/ or /p/ link, names a Share; a long hostile string is refused fast", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    const names = [slug, ` ${slug}\n`, `/s/${slug}`, `/p/${slug}/raw`, `https://x.example/s/${slug}/`, `http://h:8787/p/${slug}?v=1#a`, `https://x/s/${slug}/raw?v=2`];
    for (const n of names) expect((await erase(i, n, { confirm: false })).status, n).toBe(200);
    const nope = [`${slug}${slug}`, `/f/${slug}/`, `/s/${slug}/extra`, `/tokens/${slug}`, `d/${slug}`, `https://x/s/${slug} and more`, `javascript:/s/${slug}`, "a".repeat(3000), `https://${"a".repeat(3000)}/s/${slug}x`];
    const t0 = performance.now();
    for (const n of nope) expect((await erase(i, n, { confirm: false })).status, n.slice(0, 40)).toBe(400);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(residue(i, slug)).toMatchObject({ share: 1 });
  });
});

describe("headers on every response the erase makes", () => {
  test("403, 413, 400, 404, the home's confirmation, the 303, the Share page with the control, and the not-found paths", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    const responses: [string, Response, boolean][] = [
      ["refused", await erase(i, slug, { headers: { ...FORM, "sec-fetch-site": "cross-site" } }), true],
      ["too large", await erase(i, slug, { body: `share=${slug}&pad=${"x".repeat(5000)}` }), true],
      ["bad share", await erase(i, "nope"), true],
      ["no share", await erase(i, "AAAAAAAAAAAA"), true],
      ["confirm", await erase(i, slug, { confirm: false }), true],
      ["viewer", await erase(i, slug, { as: VIEWER }), true],
      ["anonymous", await erase(i, slug, { as: null }), true],
      ["GET", await i.call("/erase", { as: AUTHOR }), true],
      ["share page", await i.call(`/s/${slug}`, { as: AUTHOR }), true],
      ["home note", await i.call(`/?erased=${slug}`, { as: AUTHOR }), true],
      ["303", await erase(i, slug), false],
    ];
    for (const [label, r, html] of responses) expectHeaders(r, html, label);
    expect(responses.map(([, r]) => r.status)).toEqual([403, 413, 400, 404, 200, 404, 404, 404, 200, 200, 303]);
    // Both the 403 and the 413 are the Author's home, never a bare error.
    expect(SECURITY).toHaveLength(4);
  });
});

describe("pt-BR", () => {
  test("every erase answer is Portuguese, with none of the English strings", async () => {
    const i = await startInstance({ LANGUAGE: "pt-BR" });
    const slug = await publish(i, 1, "Relatório");
    const pages = [
      await (await erase(i, slug, { headers: { ...FORM, "sec-fetch-site": "cross-site" } })).text(),
      await (await erase(i, slug, { body: `share=${slug}&pad=${"x".repeat(5000)}` })).text(),
      await (await erase(i, "nope")).text(),
      await (await erase(i, "AAAAAAAAAAAA")).text(),
      await (await erase(i, slug, { confirm: false })).text(),
      await (await i.call("/", { as: AUTHOR })).text(),
      await (await i.call(`/s/${slug}`, { as: AUTHOR })).text(),
    ];
    const english = ["Erase this Share?", "Erase for good", "Review and erase", "Refused:", "Keep it", "That form is too large", "No Share with that link", "Paste a Share's link", "Erase a Share for good", "For a request to erase", "Share link or slug", "Back to your Shares"];
    for (const p of pages) for (const e of english) expect(p, e).not.toContain(e);
    expect(pages[0]).toContain("Recusado:");
    expect(pages[1]).toContain("Formulário grande demais");
    expect(pages[2]).toContain("Cole o link de um Share");
    expect(pages[3]).toContain("Nenhum Share com esse link");
    expect(pages[4]).toContain("Eliminar este Share?");
    expect(pages[4]).toContain("Manter");
    expect(pages[5]).toContain("Link ou slug do Share");
    expect(pages[6]).toContain("<summary>Eliminar</summary>");
    expect(pages[6]).toContain("Eliminar de vez");
  });

  test("the en and pt-BR strings pair up one to one, with the same placeholders", async () => {
    const src = readFileSync("src/pages.ts", "utf8");
    const block = (name: string) => new RegExp(`const ${name}[^=]*= \\{[\\s\\S]*?\\n\\};`).exec(src)?.[0] ?? "";
    const keys = (b: string) => [...b.matchAll(/^  (erase\w*|keep|erased)\b/gm)].map((m) => m[1]);
    expect(keys(block("en"))).toEqual(keys(block("ptBR")));
    expect(keys(block("en")).length).toBeGreaterThanOrEqual(9);
    const ph = (b: string) => [...b.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
    const eraseLines = (b: string) => b.split("\n").filter((l) => /^  (erase\w*|keep|erased)\b/.test(l)).join("\n");
    expect(ph(eraseLines(block("en")))).toEqual(ph(eraseLines(block("ptBR"))));
  });
});

describe("the privacy notice against the code and docs/privacy.md", () => {
  const pt = readFileSync("site/public/privacidade/index.html", "utf8");
  const en = readFileSync("site/public/en/privacy/index.html", "utf8");
  const text = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

  test("no script, form, cookie or off-site load, and the one contact address is the owner's", () => {
    for (const h of [pt, en]) {
      expect(h).not.toMatch(/<script|<form|<iframe|<img|<video|<audio|<object|<embed|@import|set-cookie/i);
      const loads = [...h.matchAll(/<(?:link|script|img|source)\b[^>]*\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]!);
      for (const u of loads) expect(u, u).not.toMatch(/^(?:https?:)?\/\/(?!htmlgate\.com)/);
      expect([...h.matchAll(/mailto:([^"]+)"/g)].map((m) => m[1])).toEqual(["privacidade@htmlgate.com"]);
    }
    expect(readFileSync("site/public/style.css", "utf8")).not.toMatch(/@import|url\(\s*["']?https?:/);
  });

  test("the numbers agree with the code and docs: 30 days default, 3 and 7 days of logs, Cloudflare only", () => {
    expect(readFileSync("src/config.ts", "utf8")).toMatch(/DEFAULT_EXPIRY_DAYS = 30/);
    expect(text(pt)).toMatch(/30 dias/);
    expect(text(en)).toMatch(/30 days/);
    expect(text(pt)).toMatch(/3 dias \(7 no plano pago/);
    expect(text(en)).toMatch(/3 days \(7 on/);
    expect(readFileSync("docs/privacy.md", "utf8")).toMatch(/3 days on Workers Free and 7 days on Workers Paid/);
    expect(readFileSync("site/wrangler.jsonc", "utf8")).toMatch(/"observability": \{ "enabled": true \}/);
  });

  test("[finding] after Expiry the record keeps tags, the Author's email and the token id, and the notice says so", async () => {
    const i = await startInstance();
    const r = await i.api("POST", "/api/shares", { html: PAGE, title: "T", metadata: { client: "acme" } });
    const slug = r.json.slug as string;
    i.fake.sqlite.prepare("UPDATE shares SET expires_at = 1 WHERE slug = ?").run(slug);
    await i.cron();
    const row = i.fake.one<{ tags: string; author: string; changed_by: string; deleted_at: number | null }>("SELECT tags, author, changed_by, deleted_at FROM shares WHERE slug = ?", slug);
    expect(row.deleted_at).not.toBeNull();
    expect(row.tags).toContain("acme");
    expect(row.author).toBe(AUTHOR);
    expect(row.changed_by).toBeTruthy();
    // The notice must not understate what stays.
    expect(text(pt)).toMatch(/etiquetas/);
    expect(text(pt)).toMatch(/e-mail do autor/);
    expect(text(en)).toMatch(/tags/);
    expect(text(en)).toMatch(/the Author's email/);
  });

  test("[finding] a Public Share opens for anyone holding its URL, and the notice says so", async () => {
    const i = await startInstance();
    const slug = await publish(i);
    expect((await i.api("POST", `/api/shares/${slug}/visibility`, { public: true })).status).toBe(200);
    expect((await i.call(`/p/${slug}`)).status).toBe(200);
    expect((await i.call(`/p/${slug}/raw`)).status).toBe(200);
    // No false absolute: both notices name the public exception.
    expect(text(pt)).not.toContain("aberta só para quem está na lista de acesso dela");
    expect(text(en)).not.toContain("open only to the people on its Allowlist");
    expect(text(pt)).toMatch(/a menos que o autor torne um Share público/);
    expect(text(en)).toMatch(/unless the Author makes a Share public/);
  });

  test("[finding] the notice names the backups (D1 Time Travel, 7 or 30 days) that docs/privacy.md says outlive an erase", () => {
    expect(readFileSync("docs/privacy.md", "utf8")).toMatch(/Time Travel/);
    expect(text(pt)).toMatch(/Time Travel do D1\) ainda permitem restaurar estados anteriores por 7 dias \(30 no plano pago\)/);
    expect(text(en)).toMatch(/D1 Time Travel\) can still restore earlier states for 7 days \(30 on the paid plan\)/);
  });
});
