// Reviewer tests, from the requirements: tokens cannot mint tokens; revocation holds on the very next request.
import { beforeAll, describe, expect, test } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { AUTHOR, VIEWER } from "./global-setup";
import { accessJwt, api, asPerson, base, mintToken, page } from "./helpers";
import { claims, get, jwtHeader, newCaller } from "./reviewer-helpers";

let admin: ReturnType<typeof api>;
beforeAll(async () => {
  admin = (await newCaller("reviewer-admin")).call;
});

const count = async () => (await admin("GET", "/api/tokens")).json.data.length as number;
const form = (origin: string | null = base) => ({
  "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}),
});

describe("tokens cannot mint tokens", () => {
  test("no API request creates a token, and no response carries a new secret", async () => {
    const { token, call } = await newCaller("reviewer-minter");
    const before = await count();
    const id = (await admin("GET", "/api/tokens")).json.data[0].id as string;
    const attempts: [string, string, unknown?][] = [
      ["POST", "/api/tokens", { name: "x" }],
      ["PUT", "/api/tokens", { name: "x" }],
      ["PATCH", "/api/tokens", { name: "x" }],
      ["POST", "/api/tokens/", { name: "x" }],
      ["POST", `/api/tokens/${id}`, { name: "x" }],
      ["PUT", `/api/tokens/${id}`, { name: "x" }],
      ["POST", `/api/tokens/${id}/revoke`, {}],
      ["POST", `/api/tokens/${id}/rotate`, {}],
      ["POST", "/api/tokens/new", { name: "x" }],
      ["POST", "/api/token", { name: "x" }],
      ["POST", "/api/auth/start", {}],
      ["POST", "/api/auth/poll", {}],
      ["GET", "/api/auth/poll?token=x"],
    ];
    for (const [m, p, body] of attempts) {
      const r = await call(m, p, body);
      expect(r.status, `${m} ${p}`).toBeGreaterThanOrEqual(400);
      expect(r.text, `${m} ${p}`).not.toMatch(/hg_[A-Za-z0-9]{40}/);
    }
    expect(token).toMatch(/^hg_/);
    expect(await count()).toBe(before);
  });

  test("the token page mints only for the Author's signed-in session on the Instance's own origin", async () => {
    const { token } = await newCaller("reviewer-page");
    const before = await count();
    const { privateKey: stranger } = await generateKeyPair("RS256");
    const forgedAuthor = await new SignJWT(claims(AUTHOR) as never).setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(stranger);
    const attempts: [string, RequestInit][] = [
      ["bearer token only, right origin", { headers: { ...form(), authorization: `Bearer ${token}` } }],
      ["no credentials, right origin", { headers: form() }],
      ["forged Author token, right origin", { headers: { ...form(), ...(jwtHeader(forgedAuthor).headers as Record<string, string>) } }],
      ["cookie only, right origin", { headers: { ...form(), cookie: `CF_Authorization=${await accessJwt(AUTHOR)}` } }],
      ["spoofed email header, right origin", { headers: { ...form(), "cf-access-authenticated-user-email": AUTHOR } }],
      ["allowlisted non-Author, right origin", await asPerson(VIEWER, { headers: form() })],
      ["outsider, right origin", await asPerson("outsider@example.com", { headers: form() })],
    ];
    for (const [label, init] of attempts) {
      const r = await get("/tokens", { method: "POST", body: "name=sneaky", ...init });
      expect(r.status, label).toBe(404);
      expect(r.body, label).not.toMatch(/hg_[A-Za-z0-9]{40}/);
    }
    // Author-only routes also refuse the Viewer for revoke.
    const id = (await admin("GET", "/api/tokens")).json.data[0].id as string;
    const rv = await get(`/tokens/${id}/revoke`, { method: "POST", ...(await asPerson(VIEWER, { headers: { origin: base } })) });
    expect(rv.status).toBe(404);
    expect(await count()).toBe(before);
    // Control: the Author on the Instance's own origin does mint.
    expect(await mintToken("reviewer-control")).toMatch(/^hg_/);
    expect(await count()).toBe(before + 1);
  });

  test("GET and other verbs on the token routes never create or reveal a token", async () => {
    for (const [m, p] of [["GET", "/tokens/new"], ["PUT", "/tokens"], ["DELETE", "/tokens"], ["GET", "/tokens/abcdefabcdef/revoke"], ["POST", "/tokens/"]] as [string, string][]) {
      const r = await get(p, await asPerson(AUTHOR, { method: m, headers: { origin: base, ...form() }, body: m === "GET" ? undefined : "name=x" }));
      expect(r.status, `${m} ${p}`).toBe(404);
    }
  });

  test("a token's name is escaped on the token page", async () => {
    const t = await mintToken(`<img src=x onerror=alert(1)>"&`);
    expect(t).toMatch(/^hg_/);
    const r = await get("/tokens", await asPerson(AUTHOR));
    expect(r.body).not.toContain("<img src=x");
    expect(r.body).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;&amp;");
    // Control: the page's policy blocks scripts anyway.
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});

describe("revocation holds on the next request", () => {
  test("a revoked token is refused on every route at once, and what it did stays", async () => {
    const victim = await newCaller("reviewer-victim");
    const v = victim.call;
    const made = await v("POST", "/api/shares", { html: page("made by victim"), title: "Victim's" });
    const slug = made.json.slug as string;
    const id = (await admin("GET", "/api/tokens")).json.data.find((t: any) => t.name === "reviewer-victim").id as string;
    const uses: [string, string, unknown?][] = [
      ["GET", "/api/shares"],
      ["GET", `/api/shares/${slug}`],
      ["POST", "/api/shares", { html: page("x"), title: "x" }],
      ["PUT", `/api/shares/${slug}`, { html: page("y"), title: "y" }],
      ["PATCH", `/api/shares/${slug}`, { title: "z" }],
      ["POST", `/api/shares/${slug}/visibility`, { public: true }],
      ["GET", `/api/shares/${slug}/versions`],
      ["GET", `/api/shares/${slug}/versions/1`],
      ["GET", "/api/tokens"],
      ["DELETE", `/api/tokens/${id}`],
      ["DELETE", `/api/shares/${slug}`],
    ];
    expect((await v("GET", "/api/shares")).status).toBe(200);

    const rv = await get(`/tokens/${id}/revoke`, await asPerson(AUTHOR, { method: "POST", headers: { origin: base } }));
    expect(rv.status).toBe(303);

    for (const [m, p, b] of uses) {
      const r = await v(m, p, b);
      expect(r.status, `${m} ${p}`).toBe(401);
      expect(r.json.error.code).toBe("unauthorized");
    }
    // A burst right after revocation: not one request slips through.
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? v("GET", "/api/shares") : v("POST", "/api/shares", { html: page("late"), title: "late" }))));
    expect(burst.map((r) => r.status)).toEqual(Array(20).fill(401));

    // The Share it published is untouched: revoking does not undo, and the Share was not changed by the refused calls.
    const seen = await admin("GET", `/api/shares/${slug}`);
    expect(seen.status).toBe(200);
    expect(seen.json).toMatchObject({ title: "Victim's", public: false, latest_version: 1 });
    const row = (await admin("GET", "/api/tokens")).json.data.find((t: any) => t.id === id);
    expect(typeof row.revoked_at).toBe("number");
  });

  test("revoking by API takes effect on the next request, and a second revoke says there is nothing live", async () => {
    const victim = await newCaller("reviewer-victim-2");
    const id = (await admin("GET", "/api/tokens")).json.data.find((t: any) => t.name === "reviewer-victim-2").id as string;
    expect((await victim.call("GET", "/api/shares")).status).toBe(200);
    expect((await admin("DELETE", `/api/tokens/${id}`)).status).toBe(204);
    expect((await victim.call("GET", "/api/shares")).status).toBe(401);
    expect((await admin("DELETE", `/api/tokens/${id}`)).status).toBe(404);
    // The revoked token cannot revoke anyone else, and the revoker is unaffected.
    expect((await victim.call("DELETE", `/api/tokens/${id}`)).status).toBe(401);
    expect((await admin("GET", "/api/shares")).status).toBe(200);
  });

  test("a token that revokes itself is refused on its very next request", async () => {
    const t = await newCaller("reviewer-suicide");
    const id = (await admin("GET", "/api/tokens")).json.data.find((x: any) => x.name === "reviewer-suicide").id as string;
    expect((await t.call("DELETE", `/api/tokens/${id}`)).status).toBe(204);
    expect((await t.call("GET", "/api/tokens")).status).toBe(401);
  });

  test("a page revoke needs the Instance's own origin and the Author", async () => {
    const t = await newCaller("reviewer-page-revoke");
    const id = (await admin("GET", "/api/tokens")).json.data.find((x: any) => x.name === "reviewer-page-revoke").id as string;
    for (const [label, init] of [
      ["no origin", await asPerson(AUTHOR, { method: "POST" })],
      ["foreign origin", await asPerson(AUTHOR, { method: "POST", headers: { origin: "https://evil.example" } })],
    ] as [string, RequestInit][]) {
      expect((await get(`/tokens/${id}/revoke`, init)).status, label).toBe(403);
      expect((await t.call("GET", "/api/shares")).status, label).toBe(200);
    }
    expect((await get(`/tokens/${id}/revoke`, await asPerson(VIEWER, { method: "POST", headers: { origin: base } }))).status).toBe(404);
    expect((await t.call("GET", "/api/shares")).status).toBe(200);
  });
});

describe("only a well-formed Bearer token authenticates the API", () => {
  test("malformed or misplaced credentials are all 401", async () => {
    const { token } = await newCaller("reviewer-format");
    const url = (q = "") => `${base}/api/shares${q}`;
    const tries: [string, string, RequestInit][] = [
      ["lowercase scheme", url(), { headers: { authorization: `bearer ${token}` } }],
      ["Basic scheme", url(), { headers: { authorization: `Basic ${btoa(token)}` } }],
      ["token without a scheme", url(), { headers: { authorization: token } }],
      ["two spaces", url(), { headers: { authorization: `Bearer  ${token}` } }],
      ["trailing comma", url(), { headers: { authorization: `Bearer ${token},` } }],
      ["last character changed", url(), { headers: { authorization: `Bearer ${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}` } }],
      ["truncated", url(), { headers: { authorization: `Bearer ${token.slice(0, -1)}` } }],
      ["extended", url(), { headers: { authorization: `Bearer ${token}x` } }],
      ["in the query", url(`?access_token=${token}&token=${token}`), {}],
      ["x-api-key", url(), { headers: { "x-api-key": token } }],
      ["cookie", url(), { headers: { cookie: `token=${token}` } }],
      ["an Access JWT instead", url(), await asPerson(AUTHOR)],
    ];
    for (const [label, u, init] of tries) {
      const r = await fetch(u, init);
      expect(r.status, label).toBe(401);
    }
    expect((await fetch(url(), { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  test("a token opens no viewer or token page", async () => {
    const { token, call } = await newCaller("reviewer-no-viewer");
    const slug = (await call("POST", "/api/shares", { html: page("x"), title: "t" })).json.slug as string;
    for (const p of [`/s/${slug}`, `/s/${slug}/raw`, "/", "/tokens"]) {
      expect((await get(p, { headers: { authorization: `Bearer ${token}` } })).status, p).toBe(404);
    }
  });
});
