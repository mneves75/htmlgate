// Sites end to end (plan 009): publishing a zip, a Public site's files, a Gated site's files under tickets, and every
// way a ticket must fail. Runs against the real Worker under wrangler dev; the requests for files carry no Access token.
import { request } from "node:http";
import { beforeAll, describe, expect, test } from "vitest";
import { writeZip } from "../packages/cli/src/zip";
import { importTicketKey, sealTicket, TICKET_TTL_MS } from "../src/ticket";
import { AUD, AUTHOR, TICKET_KEY, VIEWER } from "./global-setup";
import { api, asPerson, base, mintToken, page } from "./helpers";

const enc = new TextEncoder();
const SITE = {
  "index.html": '<!doctype html><title>s</title><link rel="stylesheet" href="css/style.css"><p>site</p>',
  "css/style.css": "p { color: rgb(1, 2, 3); }",
  "docs/index.html": "<!doctype html><title>docs</title>",
  "img/dot.svg": '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
  "a b.txt": "spaced",
  "empty.txt": "",
};
const zipOf = (files: Record<string, string>) => writeZip(Object.entries(files).map(([path, text]) => ({ path, data: enc.encode(text) })));

let token: string;
let call: ReturnType<typeof api>;
beforeAll(async () => {
  token = await mintToken("sites");
  call = api(token);
});

async function publishZip(zip: Uint8Array, query = "title=Site", method = "POST", slug = "") {
  const res = await fetch(`${base}/api/shares${slug ? "/" + slug : ""}?${query}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/zip" }, body: zip,
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function ticketFor(slug: string, n: number, email = AUTHOR, exp = Date.now() + TICKET_TTL_MS) {
  return sealTicket((await importTicketKey(TICKET_KEY))!, AUD, { slug, n, email, exp });
}

/** A GET with exactly these headers: fetch() replaces Sec-Fetch-Mode with its own "cors", as a browser would not. */
function rawGet(url: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    request(url, { headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode!, headers: res.headers });
    }).on("error", reject).end();
  });
}

function expectSiteHeaders(r: Response) {
  expect(r.headers.get("content-security-policy")).toMatch(/^sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'$/);
  expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(r.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  expect(r.headers.get("access-control-allow-origin")).toBe("*");
}

describe("publishing a site", () => {
  test("ZIP POST and PUT preserve literal metadata keys in responses, reads and filters, just like JSON pages", async () => {
    const metadata = JSON.parse('{"__proto__":"zip-literal","constructor":"literal-constructor","release":"readiness"}');
    const jsonMetadata = JSON.parse('{"__proto__":"json-literal","constructor":"literal-constructor","release":"readiness"}');
    const jsonPage = await call("POST", "/api/shares", { title: "JSON control", html: page("control"), metadata: jsonMetadata });
    expect(jsonPage.status).toBe(201);
    expect(jsonPage.json.metadata).toEqual(jsonMetadata);
    const query = "title=Literal&metadata.__proto__=zip-literal&metadata.constructor=literal-constructor&metadata.release=readiness";
    const created = await publishZip(zipOf(SITE), query);
    expect(created.status).toBe(201);
    expect(created.json.metadata).toEqual(metadata);
    const slug = created.json.slug;
    expect((await call("GET", `/api/shares/${slug}`)).json.metadata).toEqual(metadata);
    const firstList = await call("GET", "/api/shares?metadata.__proto__=zip-literal&metadata.constructor=literal-constructor&metadata.release=readiness");
    expect(firstList.status).toBe(200);
    expect(firstList.json.data.map((s: any) => s.slug)).toEqual([slug]);
    expect(firstList.json.data[0].metadata).toEqual(metadata);
    const updated = await publishZip(zipOf(SITE), query.replace("zip-literal", "updated-literal"), "PUT", slug);
    expect(updated.status).toBe(200);
    const expected = JSON.parse('{"__proto__":"updated-literal","constructor":"literal-constructor","release":"readiness"}');
    expect(updated.json.metadata).toEqual(expected);
    expect((await call("GET", `/api/shares/${slug}`)).json.metadata).toEqual(expected);
    const filtered = await call("GET", "/api/shares?metadata.__proto__=updated-literal&metadata.constructor=literal-constructor&metadata.release=readiness");
    expect(filtered.status).toBe(200);
    expect(filtered.json.data.map((s: any) => s.slug)).toEqual([slug]);
    expect(filtered.json.data[0].metadata).toEqual(expected);
  });

  test.each(["POST", "PUT"])("ZIP %s rejects an unknown top-level __proto__ field without writing", async (method) => {
    const existing = await publishZip(zipOf(SITE));
    expect(existing.status).toBe(201);
    const before = (await call("GET", "/api/shares?pageSize=1")).json.pagination.total;
    const result = await publishZip(zipOf(SITE), "title=Refused&__proto__=forbidden", method, method === "PUT" ? existing.json.slug : "");
    expect(result.status).toBe(400);
    expect(result.json.error).toMatchObject({ code: "invalid_arg", message: "Unknown field '__proto__'." });
    expect((await call("GET", "/api/shares?pageSize=1")).json.pagination.total).toBe(before);
    expect((await call("GET", `/api/shares/${existing.json.slug}`)).json).toMatchObject({ title: "Site", latest_version: 1 });
  });

  test("a zip becomes a site Version whose files and zip the API returns", async () => {
    const zip = zipOf(SITE);
    const r = await publishZip(zip, "title=My%20site&metadata.pr=7");
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ title: "My site", metadata: { pr: "7" }, public: false });
    const slug = r.json.slug;
    expect((await call("GET", `/api/shares/${slug}/versions`)).json.data[0]).toMatchObject({ n: 1, kind: "site", size: zip.length });
    const v = await call("GET", `/api/shares/${slug}/versions/1`);
    expect(v.json.kind).toBe("site");
    expect(v.json.html).toBeUndefined();
    expect(v.json.files.map((f: any) => f.path).sort()).toEqual(Object.keys(SITE).sort());
    const back = await fetch(`${base}/api/shares/${slug}/versions/1/zip`, { headers: { authorization: `Bearer ${token}` } });
    expect(back.headers.get("content-type")).toBe("application/zip");
    expect(back.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(back.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(zip);
    // A page's Version has no zip.
    const pageShare = await call("POST", "/api/shares", { html: page("p"), title: "p" });
    expect((await fetch(`${base}/api/shares/${pageShare.json.slug}/versions/1/zip`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
  });

  test("a bad zip is refused with what is wrong, and nothing is kept", async () => {
    const before = (await call("GET", "/api/shares?pageSize=1")).json.pagination.total;
    const traversal = await publishZip(zipOf({ "index.html": "x", "../evil.html": "x" }));
    expect(traversal.status).toBe(400);
    expect(traversal.json.error.code).toBe("site_invalid");
    expect(traversal.json.error.message).toContain("evil.html");
    expect((await publishZip(zipOf({ "page.html": "x" }))).json.error.code).toBe("site_invalid");
    expect((await publishZip(enc.encode("not a zip"))).json.error.code).toBe("site_invalid");
    const big = await publishZip(new Uint8Array(10 * 1024 * 1024 + 1));
    expect(big.status).toBe(413);
    expect(big.json.error.code).toBe("site_too_large");
    expect((await publishZip(zipOf(SITE), "title=x&html=y")).json.error.code).toBe("invalid_arg");
    expect((await call("GET", "/api/shares?pageSize=1")).json.pagination.total).toBe(before);
  });
});

describe("a Public site", () => {
  test("serves its files under its Version, with the sandbox on every one, until it is gated again", async () => {
    const slug = (await publishZip(zipOf(SITE))).json.slug;
    expect((await fetch(`${base}/p/${slug}/1/`)).status).toBe(404);
    await call("POST", `/api/shares/${slug}/visibility`, { public: true });

    const index = await fetch(`${base}/p/${slug}/1/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expectSiteHeaders(index);
    expect(await index.text()).toBe(SITE["index.html"]);

    const css = await fetch(`${base}/p/${slug}/1/css/style.css`);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe(SITE["css/style.css"]);
    const svg = await fetch(`${base}/p/${slug}/1/img/dot.svg`);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expectSiteHeaders(svg);
    expect(await (await fetch(`${base}/p/${slug}/1/docs/`)).text()).toBe(SITE["docs/index.html"]);
    expect(await (await fetch(`${base}/p/${slug}/1/a%20b.txt`)).text()).toBe("spaced");
    expect(await (await fetch(`${base}/p/${slug}/1/empty.txt`)).text()).toBe("");

    for (const path of ["CSS/style.css", "missing.css", "css%2Fstyle.css", "css/..%2Fstyle.css", "%ZZ"]) {
      expect((await fetch(`${base}/p/${slug}/1/${path}`)).status).toBe(404);
    }
    expect((await fetch(`${base}/p/${slug}/2/`)).status).toBe(404);
    expect((await fetch(`${base}/p/${slug}/1/css/style.css`, { method: "POST" })).status).toBe(404);

    const raw = await fetch(`${base}/p/${slug}/raw`, { redirect: "manual" });
    expect(raw.status).toBe(303);
    expect(raw.headers.get("location")).toBe(`/p/${slug}/1/`);
    expect(await (await fetch(`${base}/p/${slug}`)).text()).toContain(`src="/p/${slug}/1/"`);

    await call("POST", `/api/shares/${slug}/visibility`, { public: false });
    expect((await fetch(`${base}/p/${slug}/1/css/style.css`)).status).toBe(404);
  });
});

describe("a Gated site", () => {
  let slug: string;
  beforeAll(async () => {
    slug = (await publishZip(zipOf(SITE))).json.slug;
  });

  test("the viewer frames it under a ticket, whose files load with no Access token at all", async () => {
    const html = await (await fetch(`${base}/s/${slug}`, await asPerson(AUTHOR))).text();
    const src = /<iframe[^>]* src="(\/f\/[A-Za-z0-9_-]+\/)"/.exec(html)?.[1];
    expect(src).toBeDefined();
    const index = await fetch(base + src!);
    expect(index.status).toBe(200);
    expectSiteHeaders(index);
    expect(await index.text()).toBe(SITE["index.html"]);
    expect(await (await fetch(`${base}${src}css/style.css`)).text()).toBe(SITE["css/style.css"]);

    const raw = await fetch(`${base}/s/${slug}/raw`, await asPerson(VIEWER, { redirect: "manual" }));
    expect(raw.status).toBe(303);
    expect(raw.headers.get("location")).toMatch(/^\/f\/[A-Za-z0-9_-]+\/$/);
    expect(raw.headers.get("location")).not.toBe(src);
  });

  test("a ticket names no one: the email and the slug are sealed", async () => {
    const t = await ticketFor(slug, 1);
    const text = Buffer.from(t, "base64url").toString("latin1");
    expect(text).not.toContain("author@");
    expect(text).not.toContain(slug);
  });

  test("a ticket fails for someone off the Allowlist, another Version, a tampered seal, or another Instance's key", async () => {
    expect((await fetch(`${base}/f/${await ticketFor(slug, 1)}/`)).status).toBe(200);
    expect((await fetch(`${base}/f/${await ticketFor(slug, 1, "stranger@example.com")}/`)).status).toBe(404);
    expect((await fetch(`${base}/f/${await ticketFor(slug, 2)}/`)).status).toBe(404);
    expect((await fetch(`${base}/f/${await ticketFor("AAAAAAAAAAAA", 1)}/`)).status).toBe(404);
    const t = await ticketFor(slug, 1);
    expect((await fetch(`${base}/f/${t.slice(0, -2)}${t.endsWith("AA") ? "BB" : "AA"}/`)).status).toBe(404);
    const other = await sealTicket((await importTicketKey("A".repeat(43)))!, AUD, { slug, n: 1, email: AUTHOR, exp: Date.now() + 60_000 });
    expect((await fetch(`${base}/f/${other}/`)).status).toBe(404);
    const otherAud = await sealTicket((await importTicketKey(TICKET_KEY))!, "another-instance", { slug, n: 1, email: AUTHOR, exp: Date.now() + 60_000 });
    expect((await fetch(`${base}/f/${otherAud}/`)).status).toBe(404);
  });

  test("an expired ticket sends a navigation back through the gate, and refuses anything else", async () => {
    const t = await ticketFor(slug, 1, AUTHOR, Date.now() - 1);
    const nav = await rawGet(`${base}/f/${t}/`, { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" });
    expect(nav.status).toBe(303);
    expect(nav.headers.location).toBe(`/s/${slug}`);
    expect(nav.headers["referrer-policy"]).toBe("no-referrer");
    const sub = await fetch(`${base}/f/${t}/css/style.css`, { headers: { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "style" } });
    expect(sub.status).toBe(404);
    expect(sub.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("every answer under /f/ carries no-referrer, and only GET is served", async () => {
    for (const path of ["/f/x/", "/f/" + "A".repeat(64) + "/", "/f/"]) {
      const r = await fetch(base + path);
      expect(r.status).toBe(404);
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    }
    const post = await fetch(`${base}/f/${await ticketFor(slug, 1)}/`, { method: "POST" });
    expect(post.status).toBe(404);
  });

  test("a ticket stops working on the next request after the Share is deleted or its Version leaves the window", async () => {
    const own = (await publishZip(zipOf(SITE))).json.slug;
    const t = await ticketFor(own, 1);
    expect((await fetch(`${base}/f/${t}/`)).status).toBe(200);
    for (let i = 0; i < 20; i++) await call("PUT", `/api/shares/${own}`, { html: page(String(i)) });
    expect((await fetch(`${base}/f/${t}/`)).status).toBe(404);
    const t21 = await ticketFor(own, 21);
    expect((await fetch(`${base}/f/${t21}/`)).status).toBe(404);
    const again = (await publishZip(zipOf(SITE))).json.slug;
    const ta = await ticketFor(again, 1);
    await call("DELETE", `/api/shares/${again}`);
    expect((await fetch(`${base}/f/${ta}/`)).status).toBe(404);
  });
});
