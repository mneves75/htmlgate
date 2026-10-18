// The people side: the gate, the viewer, raw HTML isolation and the token page. Decisions: #12, #13, #16.
import { beforeAll, describe, expect, test } from "vitest";
import { generateKeyPair } from "jose";
import { AUTHOR, VIEWER } from "./global-setup";
import { accessJwt, api, asPerson, base, mintToken, page } from "./helpers";

const SANDBOX = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'";
let call: ReturnType<typeof api>;

beforeAll(async () => {
  call = api(await mintToken("viewer-tests"));
});

async function newShare(html = page("hello"), title = "Hello") {
  return (await call("POST", "/api/shares", { html, title })).json as { slug: string; url: string };
}

async function get(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, { redirect: "manual", ...init });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

const as = async (email: string, path: string, init: RequestInit = {}) => get(path, await asPerson(email, init));

/** The parts of a response a person could compare to tell two refusals apart. */
const shape = (r: { status: number; headers: Headers; body: string }) => ({
  status: r.status,
  body: r.body,
  type: r.headers.get("content-type"),
  csp: r.headers.get("content-security-policy"),
  cache: r.headers.get("cache-control"),
});

describe("the gate verifies the Access token itself", () => {
  test("the former gated path is the not-found page even for a signed-in Author's live Share", async () => {
    const share = await newShare();
    expect((await as(AUTHOR, new URL(share.url).pathname)).status).toBe(200);
    for (const suffix of ["", "/raw"]) {
      expect(shape(await as(AUTHOR, `/d/${share.slug}${suffix}`)))
        .toEqual(shape(await as(AUTHOR, "/unknown-share-path")));
    }
  });

  test("an allowlisted person opens a Gated Share; emails compare without case", async () => {
    const d = await newShare();
    const r = await as(VIEWER, `/s/${d.slug}`);
    expect(r.status).toBe(200);
    expect(r.body).toContain("Hello");
  });

  test("no token, a forged signature, a wrong audience, a wrong issuer, an expired token, or an email off the Allowlist all get the same not-found page", async () => {
    const d = await newShare();
    const control = shape(await get("/s/AAAAAAAAAAAA"));
    expect(control.status).toBe(404);
    const { privateKey: stranger } = await generateKeyPair("RS256");
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      undefined,
      await accessJwt(VIEWER, { key: stranger }),
      await accessJwt(VIEWER, { aud: "another-app" }),
      await accessJwt(VIEWER, { iss: "https://someone-else.cloudflareaccess.com" }),
      await accessJwt(VIEWER, { exp: now - 60 }),
      await accessJwt("outsider@example.com"),
      "not.a.jwt",
    ];
    for (const jwt of bad) {
      const headers: Record<string, string> = jwt ? { "cf-access-jwt-assertion": jwt } : {};
      for (const p of [`/s/${d.slug}`, `/s/${d.slug}/raw`, "/", "/tokens"]) {
        expect(shape(await get(p, { headers })), `${p} with ${jwt?.slice(0, 12)}`).toEqual(control);
      }
    }
  });

  test("a cookie is never identity", async () => {
    const d = await newShare();
    const jwt = await accessJwt(VIEWER);
    const r = await get(`/s/${d.slug}`, { headers: { cookie: `CF_Authorization=${jwt}` } });
    expect(r.status).toBe(404);
  });
});

describe("raw Share HTML is isolated", () => {
  test("the raw route serves the exact HTML with the sandbox and no-store headers", async () => {
    const html = page("<script>document.title='x'</script>raw");
    const d = await newShare(html);
    const r = await as(VIEWER, `/s/${d.slug}/raw`);
    expect(r.status).toBe(200);
    expect(r.body).toBe(html);
    expect(r.headers.get("content-security-policy")).toBe(SANDBOX);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("a kept Version opens by number, with the same headers; an unknown number is not found", async () => {
    const d = await newShare(page("one"));
    await call("PUT", `/api/shares/${d.slug}`, { html: page("two") });
    const v1 = await as(VIEWER, `/s/${d.slug}/raw?v=1`);
    expect(v1.body).toBe(page("one"));
    expect(v1.headers.get("content-security-policy")).toBe(SANDBOX);
    expect((await as(VIEWER, `/s/${d.slug}/raw`)).body).toBe(page("two"));
    expect((await as(VIEWER, `/s/${d.slug}/raw?v=9`)).status).toBe(404);
    expect((await as(VIEWER, `/s/${d.slug}/raw?v=abc`)).status).toBe(404);
  });

  test("the viewer frames the raw route in a sandboxed iframe, runs no script of its own, and escapes the title", async () => {
    const d = await newShare(page("x"), `<img src=x onerror=alert(1)> & "q"`);
    await call("PUT", `/api/shares/${d.slug}`, { html: page("y") });
    const r = await as(VIEWER, `/s/${d.slug}`);
    expect(r.body).toContain(`<iframe class="share" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" src="/s/${d.slug}/raw?v=2"`);
    expect(r.body).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;");
    expect(r.body).not.toContain("<img src=x");
    expect(r.body).toContain(`href="/s/${d.slug}?v=1"`);
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("script-src");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const old = await as(VIEWER, `/s/${d.slug}?v=1`);
    expect(old.body).toContain(`src="/s/${d.slug}/raw?v=1"`);
  });
});

describe("public Shares", () => {
  test("a Public Share opens on /p/ without sign-in, and the next request after gating it again is refused", async () => {
    const d = await newShare(page("shared"));
    await call("POST", `/api/shares/${d.slug}/visibility`, { public: true });
    const v = await get(`/p/${d.slug}`);
    expect(v.status).toBe(200);
    expect(v.body).toContain(`src="/p/${d.slug}/raw?v=1"`);
    const raw = await get(`/p/${d.slug}/raw`);
    expect(raw.body).toBe(page("shared"));
    expect(raw.headers.get("content-security-policy")).toBe(SANDBOX);
    expect(raw.headers.get("cache-control")).toBe("no-store");
    await call("POST", `/api/shares/${d.slug}/visibility`, { public: false });
    expect((await get(`/p/${d.slug}`)).status).toBe(404);
    expect((await get(`/p/${d.slug}/raw`)).status).toBe(404);
  });

  test("on /p/, a Gated Share, a deleted Share and a slug that never existed give identical answers", async () => {
    const gated = await newShare();
    const deleted = await newShare();
    await call("POST", `/api/shares/${deleted.slug}/visibility`, { public: true });
    await call("DELETE", `/api/shares/${deleted.slug}`);
    const missing = "ZZZZZZZZZZZZ";
    for (const suffix of ["", "/raw"]) {
      const a = await get(`/p/${gated.slug}${suffix}`);
      const b = await get(`/p/${deleted.slug}${suffix}`);
      const c = await get(`/p/${missing}${suffix}`);
      // The sign-in link names the slug that was asked for, so compare with it swapped out.
      const norm = (r: typeof a, slug: string) => ({ ...shape(r), body: r.body.replaceAll(slug, "SLUG") });
      expect(norm(a, gated.slug)).toEqual(norm(c, missing));
      expect(norm(b, deleted.slug)).toEqual(norm(c, missing));
      expect(a.status).toBe(404);
    }
    // Control: a Public Share does answer differently.
    const open = await newShare();
    await call("POST", `/api/shares/${open.slug}/visibility`, { public: true });
    expect((await get(`/p/${open.slug}`)).status).toBe(200);
  });

  test("the not-found page on /p/ offers sign-in at the gated address", async () => {
    const r = await get("/p/ZZZZZZZZZZZZ");
    expect(r.body).toContain(`href="/s/ZZZZZZZZZZZZ"`);
  });

  test("paths are matched exactly: case, doubled or encoded slashes and extra segments are not found", async () => {
    const d = await newShare();
    await call("POST", `/api/shares/${d.slug}/visibility`, { public: true });
    const control = await get(`/p/${d.slug}`);
    expect(control.status).toBe(200);
    for (const p of [`/P/${d.slug}`, `//p/${d.slug}`, `/p/${d.slug}/`, `/p/${d.slug}/raw/x`, `/p/..%2Fd/${d.slug}`, `/p/${d.slug}%2Fraw`, `/p/${d.slug.toLowerCase()}x`]) {
      expect((await get(p)).status, p).toBe(404);
    }
  });
});

describe("the redesigned pages", () => {
  test("the viewer shows whether the Share is gated or public", async () => {
    const d = await newShare();
    expect((await as(VIEWER, `/s/${d.slug}`)).body).toMatch(/<span class="state state-gated">Gated<\/span>/);
    await call("POST", `/api/shares/${d.slug}/visibility`, { public: true });
    expect((await get(`/p/${d.slug}`)).body).toMatch(/<span class="state state-public">Public<\/span>/);
    expect((await as(VIEWER, `/s/${d.slug}`)).body).toMatch(/<span class="state state-public">Public<\/span>/);
  });

  test("the Author's home shows the htmlgate CLI's sign-in line for this Instance; a Viewer's does not", async () => {
    const a = await as(AUTHOR, "/");
    expect(a.body).toContain(`htmlgate login ${base}`);
    expect(a.body).not.toContain("htmlbin");
    const v = await as(VIEWER, "/");
    expect(v.body).not.toContain("htmlgate login");
  });

  test("every page for people starts with a skip link to its main content", async () => {
    const d = await newShare();
    for (const r of [await as(AUTHOR, "/"), await as(AUTHOR, "/tokens"), await get("/p/ZZZZZZZZZZZZ")]) {
      expect(r.body).toContain('<a class="skip" href="#main">Skip to content</a>');
      expect(r.body).toContain('<main id="main"');
    }
    expect((await as(VIEWER, `/s/${d.slug}`)).body).toContain('<a class="skip" href="#share">Skip to the Share</a>');
  });

  test("updated times are machine-readable", async () => {
    const d = await newShare();
    expect((await as(VIEWER, `/s/${d.slug}`)).body).toMatch(/<time datetime="\d{4}-\d{2}-\d{2}T[^"]+Z">/);
  });

  test("an older Version says so and links to the latest; the latest does not", async () => {
    const d = await newShare();
    await call("PUT", `/api/shares/${d.slug}`, { html: page("two") });
    await call("PUT", `/api/shares/${d.slug}`, { html: page("three") });
    const old = await as(VIEWER, `/s/${d.slug}?v=1`);
    expect(old.body).toContain('<p class="older" role="status">');
    expect(old.body).toContain("You are viewing v1. The latest is v3.");
    expect(old.body).toMatch(new RegExp(`<a href="/s/${d.slug}">Show the latest</a>`));
    expect((await as(VIEWER, `/s/${d.slug}`)).body).not.toContain('class="older"');
    await call("POST", `/api/shares/${d.slug}/visibility`, { public: true });
    // On a public link the notice points at the public latest, never into the gate.
    expect((await get(`/p/${d.slug}?v=2`)).body).toMatch(new RegExp(`<a href="/p/${d.slug}">Show the latest</a>`));
  });

  test("a Public Share's page tells an anonymous visitor nothing about the Instance's people or tokens", async () => {
    const d = await newShare(page("open"), "Open to all");
    await call("POST", `/api/shares/${d.slug}/visibility`, { public: true });
    const r = await get(`/p/${d.slug}`);
    expect(r.status).toBe(200);
    for (const text of [AUTHOR, VIEWER, 'href="/tokens"', 'href="/"', "viewer-tests"]) expect(r.body, text).not.toContain(text);
    // Control: the gated view of the same Share links home.
    expect((await as(VIEWER, `/s/${d.slug}`)).body).toContain('href="/"');
  });

  test("every page's stylesheet is exactly the one its CSP allows", async () => {
    const d = await newShare();
    const pages = [await as(AUTHOR, "/"), await as(VIEWER, "/"), await as(AUTHOR, "/tokens"), await as(VIEWER, `/s/${d.slug}`), await get("/p/ZZZZZZZZZZZZ")];
    for (const r of pages) {
      const css = /<style>([\s\S]*?)<\/style>/.exec(r.body)![1]!;
      const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(css))).toString("base64");
      expect(r.headers.get("content-security-policy")).toContain(`style-src 'sha256-${digest}'`);
      expect(r.body.match(/<style>/g)).toHaveLength(1);
      expect(r.body).not.toMatch(/\sstyle="/);
    }
  });
});

describe("pages for people", () => {
  test("home names the signed-in person and shows Tokens only to the Author", async () => {
    const v = await as(VIEWER, "/");
    expect(v.status).toBe(200);
    expect(v.body).toContain(VIEWER);
    expect(v.body).not.toContain('href="/tokens"');
    const a = await as(AUTHOR, "/");
    expect(a.body).toContain('href="/tokens"');
  });

  test("only the Author reaches the token page", async () => {
    expect((await as(VIEWER, "/tokens")).status).toBe(404);
    expect((await as(AUTHOR, "/tokens")).status).toBe(200);
  });

  test("creating a token from anywhere but the Instance's own page is refused", async () => {
    const form = { "content-type": "application/x-www-form-urlencoded" };
    const tries: [string, Record<string, string>][] = [
      ["no Origin", form],
      ["Origin null", { ...form, origin: "null" }],
      ["foreign Origin", { ...form, origin: "https://evil.example" }],
      ["cross-site fetch", { ...form, origin: base, "sec-fetch-site": "cross-site" }],
    ];
    for (const [label, headers] of tries) {
      const r = await as(AUTHOR, "/tokens", { method: "POST", headers, body: "name=sneaky" });
      expect(r.status, label).toBe(403);
      expect(r.body, label).not.toMatch(/hg_[A-Za-z0-9]{40}/);
    }
    // Control: the same request from the Instance's own page succeeds.
    const ok = await as(AUTHOR, "/tokens", { method: "POST", headers: { ...form, origin: base, "sec-fetch-site": "same-origin" }, body: "name=fine" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatch(/<code id="new-token">hg_[A-Za-z0-9]{40}<\/code>/);
    // The token alone is refused without $HTMLGATE_URL, so the hint names both.
    expect(ok.body).toContain("$HTMLGATE_URL");
  });

  test("the token form reads at most 4 KiB: a larger or endless form is refused at once and makes no token", async () => {
    // connection: close keeps the socket these refusals cut out of fetch's pool, where the next request would hit EPIPE.
    const headers = { "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin", connection: "close" };
    const before = (await call("GET", "/api/tokens")).json.data.length;
    // The Worker answers 413 after 4 KiB; on a busy host it can close the connection while the rest of the
    // body is still being sent. Only that cut may stand in for the 413, and no token may come of it either way.
    let big: { status: number; body: string } | undefined;
    try {
      big = await as(AUTHOR, "/tokens", { method: "POST", headers, body: "name=" + "a".repeat(8 * 1024) });
    } catch (e) {
      expect(String((e as { cause?: { code?: unknown } }).cause?.code)).toMatch(/^(EPIPE|ECONNRESET)$/);
    }
    if (big) {
      expect(big.status).toBe(413);
      expect(big.body).not.toMatch(/hg_[A-Za-z0-9]{40}/);
    }
    let answered = false;
    let sent = 0;
    const chunk = new TextEncoder().encode("a".repeat(64 * 1024));
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (answered || sent >= 64 * 1024 * 1024) return c.close();
        sent += chunk.length;
        c.enqueue(chunk);
      },
    });
    const started = Date.now();
    // The same cut can end this request, while it is sent or while its answer is read. Then the refusal is the
    // cut itself: it must still come at once, and the token count below must not have moved.
    try {
      const r = await fetch(`${base}/tokens`, await asPerson(AUTHOR, { method: "POST", headers, body, duplex: "half" } as RequestInit));
      answered = true;
      // As with the API: the Worker answers 413; Wrangler's dev proxy sometimes reports that early answer as a 500.
      const text = await r.text();
      if (r.status === 500) expect(text).toMatch(/^Error: Network connection lost\./);
      else expect(r.status).toBe(413);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      expect(String((e as { cause?: { code?: unknown } }).cause?.code)).toMatch(/^(EPIPE|ECONNRESET|UND_ERR_SOCKET)$/);
    } finally {
      answered = true;
    }
    expect(Date.now() - started).toBeLessThan(15_000);
    expect((await call("GET", "/api/tokens")).json.data.length).toBe(before);
  });

  test("a token name with control or bidi characters is refused; any other 1 to 64 characters work", async () => {
    const headers = { "content-type": "application/x-www-form-urlencoded", origin: base, "sec-fetch-site": "same-origin" };
    for (const bad of ["pub\u001b]52;c;UFdORUQ=\u0007", "a\nb", "x\u202Eexe.txt", "zero\u200Bwidth"]) {
      const r = await as(AUTHOR, "/tokens", { method: "POST", headers, body: new URLSearchParams({ name: bad }).toString() });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body).not.toMatch(/hg_[A-Za-z0-9]{40}/);
    }
    const ok = await as(AUTHOR, "/tokens", { method: "POST", headers, body: new URLSearchParams({ name: "Relatório 2 (CI)" }).toString() });
    expect(ok.status).toBe(200);
  });

  test("revoking from the page stops the token on its next request", async () => {
    const t = await mintToken("page-revoke");
    const list = (await call("GET", "/api/tokens")).json.data;
    const id = list.find((x: any) => x.name === "page-revoke").id;
    const r = await as(AUTHOR, `/tokens/${id}/revoke`, { method: "POST", headers: { origin: base } });
    expect(r.status).toBe(303);
    expect((await api(t)("GET", "/api/shares")).status).toBe(401);
    const refused = await as(AUTHOR, `/tokens/${id}/revoke`, { method: "POST", headers: { origin: "null" } });
    expect(refused.status).toBe(403);
  });

  test("the not-found page is sandboxed and not stored, like raw Share HTML", async () => {
    const r = await get("/p/ZZZZZZZZZZZZ");
    const csp = r.headers.get("content-security-policy")!;
    expect(csp.split(";").map((s) => s.trim())).toContain("sandbox");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("the redirect after revoking carries the same headers as every response", async () => {
    await mintToken("redirect-headers");
    const id = (await call("GET", "/api/tokens")).json.data.find((x: any) => x.name === "redirect-headers").id;
    const r = await as(AUTHOR, `/tokens/${id}/revoke`, { method: "POST", headers: { origin: base } });
    expect(r.status).toBe(303);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("same-origin");
  });

  test("signed in, not-found offers a way home; for one visitor a deleted and a missing Share look the same", async () => {
    const author = await as(AUTHOR, "/s/ZZZZZZZZZZZZ");
    expect(author.status).toBe(404);
    expect(author.body).toContain('<a class="button" href="/">Back to your Shares');
    const viewer = await as(VIEWER, "/s/ZZZZZZZZZZZZ");
    expect(viewer.body).toContain('<a class="button" href="/">Go to the home page');
    // Behind the gate the page never tells anyone apart but the Author: no identity gets a Viewer's page too.
    expect(shape(await get("/s/ZZZZZZZZZZZZ"))).toEqual(shape(viewer));
    const d = await newShare();
    await call("DELETE", `/api/shares/${d.slug}`);
    expect(shape(await as(VIEWER, `/s/${d.slug}`))).toEqual(shape(viewer));
  });

  test("not-found pages are identical for any refused path, so they reveal nothing", async () => {
    const a = await get("/s/AAAAAAAAAAAA");
    const b = await get("/nothing-here");
    expect(shape(a)).toEqual(shape(b));
  });
});
