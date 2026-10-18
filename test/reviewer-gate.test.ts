// Reviewer tests, from the requirements: publishing never changes the gate; soft delete hides a Share everywhere;
// Share HTML is always under the sandbox CSP with no-store.
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { AUTHOR, VIEWER } from "./global-setup";
import { accessJwt, base, page } from "./helpers";
import { full, get, jwtHeader, MISSING, newCaller, type Res } from "./reviewer-helpers";

const SANDBOX = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'";
let call: Awaited<ReturnType<typeof newCaller>>["call"];
let viewer: RequestInit;

beforeAll(async () => {
  call = (await newCaller("reviewer-gate")).call;
  viewer = jwtHeader(await accessJwt(VIEWER));
});
// Each test gets its own token, so the 60-changes-a-minute limit never decides a result.
beforeEach(async () => {
  call = (await newCaller("reviewer-gate")).call;
});

const tagOf = () => "rv-" + Math.random().toString(36).slice(2, 9);
async function share(over: Record<string, unknown> = {}) {
  const r = await call("POST", "/api/shares", { html: page("one"), title: "T", ...over });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json as { slug: string };
}
const makePublic = async (slug: string) => expect((await call("POST", `/api/shares/${slug}/visibility`, { public: true })).status).toBe(200);
const state = async (slug: string) => {
  const r = await call("GET", `/api/shares/${slug}`);
  return { public: r.json.public, latest: r.json.latest_version, title: r.json.title, p: (await get(`/p/${slug}`)).status };
};

describe("publishing never changes the gate", () => {
  const GATE_FIELDS: [string, unknown][] = [
    ["public true", { public: true }], ["public false", { public: false }], ["public null", { public: null }],
    ["public string", { public: "true" }], ["public zero", { public: 0 }], ["public object", { public: { value: true } }],
    ["passcode", { passcode: "abcd1234" }],
  ];

  test.each(["gated", "public"])("on a %s Share, POST, PUT and PATCH that carry a gate field are refused and change nothing", async (kind) => {
    const tag = tagOf();
    const d = await share({ metadata: { t: tag } });
    if (kind === "public") await makePublic(d.slug);
    const before = await state(d.slug);
    expect(before.public).toBe(kind === "public");
    for (const [label, extra] of GATE_FIELDS) {
      const post = await call("POST", "/api/shares", { html: page("n"), title: "n", metadata: { t: tag }, ...(extra as object) });
      expect(post.status, `POST ${label}`).toBe(400);
      const put = await call("PUT", `/api/shares/${d.slug}`, { html: page("sneak"), title: "sneak", ...(extra as object) });
      expect(put.status, `PUT ${label}`).toBe(400);
      const patch = await call("PATCH", `/api/shares/${d.slug}`, { title: "sneak", ...(extra as object) });
      expect(patch.status, `PATCH ${label}`).toBe(400);
    }
    expect(await state(d.slug)).toEqual(before); // no new Version, no new title, same gate
    expect((await call("GET", `/api/shares?metadata.t=${tag}`)).json.pagination.total).toBe(1); // no Share was created
  });

  test("a valid PUT or PATCH keeps the gate exactly as it was; a new Share is always gated", async () => {
    const tag = tagOf();
    const gated = await share({ metadata: { t: tag } });
    const open = await share({ metadata: { t: tag + "x" } });
    await makePublic(open.slug);
    for (const d of [gated, open]) {
      expect((await call("PUT", `/api/shares/${d.slug}`, { html: page("two"), title: "two" })).status).toBe(200);
      expect((await call("PATCH", `/api/shares/${d.slug}`, { description: "d", metadata: { t: "z" } })).status).toBe(200);
      expect((await call("PUT", `/api/shares/${d.slug}`, { html: page("three"), metadata: {} })).status).toBe(200);
    }
    expect((await get(`/p/${gated.slug}`)).status).toBe(404);
    expect((await get(`/p/${gated.slug}/raw`)).status).toBe(404);
    expect((await get(`/p/${open.slug}/raw`)).body).toBe(page("three"));
    // A new Share with the same Tags as a public one is still gated.
    const sibling = await call("POST", "/api/shares", { html: page("s"), title: "s", metadata: { t: "z" } });
    expect(sibling.json.public).toBe(false);
    expect((await get(`/p/${sibling.json.slug}`)).status).toBe(404);
  });

  test("the visibility call accepts exactly {public: boolean} and nothing else", async () => {
    const d = await share();
    const before = await state(d.slug);
    const bad: unknown[] = [{}, { public: "true" }, { public: 1 }, { public: null }, { public: true, title: "x" }, { public: true, public2: 1 }, [], "true", null, 5];
    for (const b of bad) {
      const r = await call("POST", `/api/shares/${d.slug}/visibility`, b);
      expect(r.status, JSON.stringify(b)).toBe(400);
    }
    const raw = await fetch(`${base}/api/shares/${d.slug}/visibility`, { method: "POST", headers: { authorization: `Bearer ${(await newCaller("rv-vis")).token}`, "content-type": "application/json" }, body: "{public:true" });
    expect(raw.status).toBe(400);
    expect(await state(d.slug)).toEqual(before);
    // Wrong verbs on the visibility route do nothing.
    for (const m of ["GET", "PUT", "PATCH", "DELETE"]) {
      const r = await call(m, `/api/shares/${d.slug}/visibility`, m === "GET" || m === "DELETE" ? undefined : { public: true });
      expect(r.status, m).toBe(404);
    }
    expect(await state(d.slug)).toEqual(before);
  });
});

describe("soft delete hides a Share everywhere", () => {
  test("viewer, raw, versions, public paths, list, and every write all answer as if it never existed", async () => {
    const tag = tagOf();
    const d = await share({ html: page("v1 body"), metadata: { t: tag } });
    await call("PUT", `/api/shares/${d.slug}`, { html: page("v2 body"), title: "T" });
    await call("PUT", `/api/shares/${d.slug}`, { html: page("v3 body"), title: "T" });
    await makePublic(d.slug);
    const open = await get(`/p/${d.slug}/raw`);
    expect(open.status).toBe(200); // control: it was public and live
    expect((await get(`/s/${d.slug}`, viewer)).status).toBe(200);

    expect((await call("DELETE", `/api/shares/${d.slug}`)).status).toBe(204);

    for (const suffix of ["", "/raw", "?v=1", "?v=3", "/raw?v=1", "/raw?v=2", "/raw?v=3"]) {
      for (const prefix of ["s", "p"]) {
        const init = prefix === "s" ? viewer : {};
        const gone = full(await get(`/${prefix}/${d.slug}${suffix}`, init), d.slug);
        const never = full(await get(`/${prefix}/${MISSING}${suffix}`, init), MISSING);
        expect(gone, `${prefix} ${suffix}`).toEqual(never);
        expect(gone.status).toBe(404);
        expect(gone.body).not.toMatch(/v[123] body/);
      }
    }
    const notFound = { status: 404, json: { error: { code: "not_found" } } };
    const writes: [string, string, unknown?][] = [
      ["GET", `/api/shares/${d.slug}`], ["GET", `/api/shares/${d.slug}/versions`], ["GET", `/api/shares/${d.slug}/versions/1`],
      ["GET", `/api/shares/${d.slug}/versions/3`],
      ["PUT", `/api/shares/${d.slug}`, { html: page("x"), title: "x" }], ["PATCH", `/api/shares/${d.slug}`, { title: "x" }],
      ["POST", `/api/shares/${d.slug}/visibility`, { public: true }], ["POST", `/api/shares/${d.slug}/visibility`, { public: false }],
      ["DELETE", `/api/shares/${d.slug}`],
    ];
    for (const [m, p, b] of writes) {
      const r = await call(m, p, b);
      expect({ status: r.status, json: r.json }, `${m} ${p}`).toMatchObject(notFound);
    }
    for (const q of [`metadata.t=${tag}`, `metadata.t=${tag}&public=true`, "public=true&pageSize=200", "pageSize=200&sortBy=created_at"]) {
      const l = await call("GET", `/api/shares?${q}`);
      expect(l.status).toBe(200);
      expect(l.json.data.map((x: any) => x.slug), q).not.toContain(d.slug);
    }
    // Nothing above brought it back.
    expect((await get(`/p/${d.slug}/raw`)).status).toBe(404);
    expect((await get(`/s/${d.slug}/raw`, viewer)).status).toBe(404);
  });

  test("deleting one Share does not hide its neighbours", async () => {
    const a = await share();
    const b = await share();
    await call("DELETE", `/api/shares/${a.slug}`);
    expect((await get(`/s/${b.slug}/raw`, viewer)).status).toBe(200);
    expect((await call("GET", `/api/shares/${b.slug}`)).status).toBe(200);
  });
});

describe("Share HTML is always sandboxed and never cached", () => {
  const MARK = "SANDBOX-MARK-91c2";
  const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src *"><script>/*${MARK}*/ top.location='https://evil.example'</script>\r\n<p>é — ${MARK}</p>\0`;
  let slugs: { gated: string; pub: string };

  beforeAll(async () => {
    const gated = await share({ html, title: "adversarial" });
    const pub = await share({ html, title: "adversarial public" });
    await makePublic(pub.slug);
    slugs = { gated: gated.slug, pub: pub.slug };
  });

  const REQUEST_HEADERS: Record<string, string>[] = [
    {}, { accept: "application/json" }, { accept: "text/plain" }, { accept: "*/*;q=0" }, { range: "bytes=0-5" },
    { "accept-encoding": "identity" }, { "accept-encoding": "gzip, br" }, { "if-none-match": "*" },
    { "if-modified-since": "Wed, 21 Oct 2099 07:28:00 GMT" }, { origin: "https://evil.example" },
    { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site" },
    { "sec-fetch-dest": "document" }, { "x-forwarded-proto": "http" }, { "x-requested-with": "XMLHttpRequest" },
    { "user-agent": "curl/8" }, { "cache-control": "max-age=0" }, { pragma: "no-cache" },
  ];
  const QUERIES = ["", "?v=1", "?v=1&x=y", "?x=1", "?v=1&v=2", "?V=1", "?v=1#frag", "?download=1&response-content-type=text/plain", "?v=%31"];

  function assertSandboxed(r: Res, label: string) {
    expect(r.headers.get("content-security-policy"), label).toBe(SANDBOX);
    expect(r.headers.get("cache-control"), label).toBe("no-store");
    expect(r.headers.get("x-content-type-options"), label).toBe("nosniff");
    expect(r.headers.get("content-type"), label).toBe("text/html; charset=utf-8");
    expect(r.headers.get("cross-origin-resource-policy"), label).toBe("same-origin");
    for (const h of ["access-control-allow-origin", "set-cookie", "etag", "last-modified", "content-disposition", "x-frame-options", "refresh"]) {
      expect(r.headers.get(h), `${label} ${h}`).toBeNull();
    }
  }

  test("every raw answer that carries Share HTML has the sandbox CSP and no-store, whatever the request looks like", async () => {
    let served = 0;
    for (const [prefix, slug, init] of [["s", slugs.gated, viewer], ["p", slugs.pub, {}], ["s", slugs.pub, viewer]] as const) {
      for (const q of QUERIES) {
        for (const h of REQUEST_HEADERS) {
          const headers = { ...(init.headers as Record<string, string> | undefined), ...h };
          const r = await get(`/${prefix}/${slug}/raw${q}`, { headers });
          const label = `${prefix}${q} ${JSON.stringify(h)}`;
          if (r.status === 200 || r.status === 206 || r.body.includes(MARK)) {
            assertSandboxed(r, label);
            if (r.status === 200) expect(r.body, label).toBe(html);
            served++;
          } else {
            expect(r.status, label).toBe(404);
            expect(r.body.includes(MARK), label).toBe(false);
          }
        }
      }
    }
    expect(served).toBeGreaterThan(100); // the sweep really exercised the served path
  });

  test("the page that frames it, and every other Instance page, is no-store with a locked-down policy", async () => {
    for (const [p, init] of [[`/s/${slugs.gated}`, viewer], [`/p/${slugs.pub}`, {}], ["/", viewer], ["/tokens", jwtHeader(await accessJwt(AUTHOR))], ["/p/ZZZZZZZZZZZZ", {}], ["/nothing", {}]] as [string, RequestInit][]) {
      const r = await get(p, init);
      expect(r.headers.get("cache-control"), p).toBe("no-store");
      expect(r.headers.get("x-content-type-options"), p).toBe("nosniff");
      expect(r.headers.get("content-security-policy"), p).toContain("default-src 'none'");
      expect(r.headers.get("content-security-policy"), p).toContain("frame-ancestors 'none'");
      expect(r.body.includes(MARK), p).toBe(false); // Share content never appears in an Instance page
      expect(r.headers.get("access-control-allow-origin"), p).toBeNull();
    }
  });

  test("the API's copy of a body is JSON that cannot render as a page", async () => {
    const r = await call("GET", `/api/shares/${slugs.gated}/versions/1`);
    expect(r.status).toBe(200);
    expect(r.json.html).toBe(html);
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  test("other verbs never reach the raw HTML or change the Share", async () => {
    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      for (const p of [`/s/${slugs.gated}/raw`, `/s/${slugs.gated}`, `/p/${slugs.pub}/raw`, `/p/${slugs.pub}`]) {
        const r = await get(p, { method, headers: { ...(viewer.headers as Record<string, string>), origin: base }, body: ["POST", "PUT", "PATCH"].includes(method) ? "x" : undefined });
        expect(r.status, `${method} ${p}`).toBe(404);
        expect(r.body.includes(MARK), `${method} ${p}`).toBe(false);
        expect(r.headers.get("access-control-allow-origin")).toBeNull();
      }
    }
    expect((await get(`/s/${slugs.gated}/raw`, viewer)).status).toBe(200);
  });
});

describe("no response of the Instance is cacheable", () => {
  test("success, redirect, refusal and error answers all carry no-store and nosniff", async () => {
    const d = await share();
    const t = await newCaller("reviewer-nostore");
    const author = jwtHeader(await accessJwt(AUTHOR)).headers as Record<string, string>;
    const id = (await t.call("GET", "/api/tokens")).json.data[0].id as string;
    const authed = { authorization: `Bearer ${t.token}`, "content-type": "application/json" };
    const reqs: [string, string, RequestInit][] = [
      ["robots", "/robots.txt", {}],
      ["onboard", "/api/onboard", {}],
      ["401", "/api/shares", {}],
      ["404 api", "/api/nothing", { headers: authed }],
      ["400 invalid json", "/api/shares", { method: "POST", headers: authed, body: "{" }],
      ["413", "/api/shares", { method: "POST", headers: authed, body: JSON.stringify({ html: "x".repeat(2 * 1024 * 1024 + 1), title: "t" }) }],
      ["200 list", "/api/shares", { headers: authed }],
      ["204 delete", `/api/shares/${(await share()).slug}`, { method: "DELETE", headers: authed }],
      ["viewer 200", `/s/${d.slug}`, { headers: author }],
      ["viewer 404", `/s/${MISSING}`, {}],
      ["tokens 200", "/tokens", { headers: author }],
      ["tokens 403", "/tokens", { method: "POST", headers: { ...author, "content-type": "application/x-www-form-urlencoded" }, body: "name=x" }],
      ["tokens 400", "/tokens", { method: "POST", headers: { ...author, origin: base, "content-type": "application/x-www-form-urlencoded" }, body: "name=" }],
      ["revoke 303", `/tokens/${id}/revoke`, { method: "POST", headers: { ...author, origin: base } }],
      ["home", "/", { headers: author }],
    ];
    for (const [label, p, init] of reqs) {
      const r = await fetch(base + p, { redirect: "manual", ...init });
      await r.arrayBuffer();
      expect(r.headers.get("cache-control"), label).toBe("no-store");
      expect(r.headers.get("etag"), label).toBeNull();
      expect(r.headers.get("last-modified"), label).toBeNull();
      expect(r.headers.get("set-cookie"), label).toBeNull();
      if (label !== "revoke 303") expect(r.headers.get("x-content-type-options"), label).toBe("nosniff");
    }
  });
});
