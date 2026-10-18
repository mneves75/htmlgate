// Reviewer tests, from the requirements: identity comes only from a verified Access JWT; a Gated Share is never
// served on /p/ or to anyone off the Allowlist; a refused request looks exactly like a missing one.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { AUD, AUTHOR, settings, startInstance, VIEWER, type Instance } from "./global-setup";
import { accessJwt, asPerson, page } from "./helpers";
import { b64, claims, full, get, jwtHeader, MISSING, newCaller, publicJwk, signed, teamUrl, type Res } from "./reviewer-helpers";

const SECRET_MARK = "SECRET-BODY-MARK-7f3a";
let slug: string;
let call: Awaited<ReturnType<typeof newCaller>>["call"];

beforeAll(async () => {
  call = (await newCaller("reviewer-identity")).call;
  slug = (await call("POST", "/api/shares", { html: page(SECRET_MARK), title: "Secret title mark" })).json.slug;
});

const leaks = (r: Res) => r.body.includes(SECRET_MARK) || r.body.includes("Secret title mark");

// The routes that serve or reveal gated content to people.
const gatedRoutes = () => [`/s/${slug}`, `/s/${slug}/raw`, `/s/${slug}?v=1`, `/s/${slug}/raw?v=1`, "/", "/tokens"];

describe("identity comes only from a verified Access token", () => {
  test("control: an allowlisted person is served", async () => {
    const r = await get(`/s/${slug}/raw`, await asPerson(VIEWER));
    expect(r.status).toBe(200);
    expect(r.body).toContain(SECRET_MARK);
  });

  test("forged identity channels are never read", async () => {
    const good = await accessJwt(VIEWER);
    const channels: [string, Record<string, string>][] = [
      ["Cf-Access-Authenticated-User-Email", { "cf-access-authenticated-user-email": VIEWER }],
      ["author email header", { "cf-access-authenticated-user-email": AUTHOR }],
      ["X-Forwarded-Email", { "x-forwarded-email": AUTHOR, "x-forwarded-user": AUTHOR, "x-auth-request-email": AUTHOR }],
      ["a valid JWT in the CF_Authorization cookie", { cookie: `CF_Authorization=${good}` }],
      ["a valid JWT as a Bearer credential", { authorization: `Bearer ${good}` }],
      ["a valid JWT in another header", { "x-access-jwt": good, "cf-access-token": good }],
      ["service token headers", { "cf-access-client-id": "abc.access", "cf-access-client-secret": "x".repeat(64) }],
    ];
    const control = full(await get("/s/AAAAAAAAAAAA"));
    for (const [label, headers] of channels) {
      for (const p of gatedRoutes()) {
        const r = await get(p, { headers });
        expect(full(r), `${label} on ${p}`).toEqual(full(await get(p)));
        expect(leaks(r), `${label} on ${p}`).toBe(false);
      }
    }
    expect(control.status).toBe(404);
  });

  test("a valid JWT in the query string or path is not identity", async () => {
    const good = await accessJwt(VIEWER);
    for (const p of [`/s/${slug}?cf-access-jwt-assertion=${good}`, `/s/${slug}/raw?CF_Authorization=${good}`]) {
      const r = await get(p);
      expect(r.status, p).toBe(404);
      expect(leaks(r)).toBe(false);
    }
  });

  test("tokens that are signed wrongly or claim the wrong things are refused with the missing answer", async () => {
    const now = Math.floor(Date.now() / 1000);
    const valid = await signed(claims(VIEWER));
    const [h, p, s] = valid.split(".") as [string, string, string];
    const outsiderValid = await signed(claims("outsider@example.com"));
    const [oh, op, os] = outsiderValid.split(".") as [string, string, string];
    const { privateKey: stranger } = await generateKeyPair("RS256");
    const hs = async (secret: Uint8Array) =>
      new SignJWT(claims(VIEWER) as never).setProtectedHeader({ alg: "HS256", kid: "test-key" }).sign(secret);

    const bad: [string, string][] = [
      ["alg none, unsigned", `${b64({ alg: "none", typ: "JWT" })}.${b64(claims(VIEWER))}.`],
      ["alg none with kid", `${b64({ alg: "none", kid: "test-key" })}.${b64(claims(VIEWER))}.${s}`],
      ["HS256 keyed with the public modulus", await hs(new TextEncoder().encode(publicJwk.n))],
      ["HS256 keyed with the public JWK text", await hs(new TextEncoder().encode(JSON.stringify(publicJwk)))],
      ["RS256 from a stranger with the real kid", await new SignJWT(claims(VIEWER) as never).setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(stranger)],
      ["payload swapped to an allowlisted email, signature kept", `${oh}.${b64(claims(VIEWER))}.${os}`],
      ["header and signature of a good token on an outsider payload", `${h}.${op}.${s}`],
      ["signature truncated", `${h}.${p}.${s.slice(0, -8)}`],
      ["signature flipped", `${h}.${p}.${s.slice(0, -4)}AAAA`],
      ["two tokens joined", `${valid}, ${valid}`],
      ["token with a prefix", `Bearer ${valid}`],
      ["empty", ""],
      ["no exp claim", await signed(Object.fromEntries(Object.entries(claims(VIEWER)).filter(([k]) => k !== "exp")))],
      ["expired", await signed(claims(VIEWER, { exp: now - 1 }))],
      ["not valid yet", await signed(claims(VIEWER, { nbf: now + 600 }))],
      ["no email claim", await signed(Object.fromEntries(Object.entries(claims(VIEWER)).filter(([k]) => k !== "email")))],
      ["email is a list", await signed(claims([VIEWER]))],
      ["email is a number", await signed(claims(7))],
      ["email lists two people", await signed(claims(`${VIEWER},${AUTHOR}`))],
      ["email is a longer address containing an allowlisted one", await signed(claims(`x${VIEWER}`))],
      ["email has a suffix", await signed(claims(`${VIEWER}.evil`))],
      ["email is a prefix of an allowlisted address", await signed(claims("viewer@example.co"))],
      ["audience is a different application", await signed(claims(VIEWER, { aud: ["another-app"] }))],
      ["audience list without ours", await signed(claims(VIEWER, { aud: ["a", "b"] }))],
      ["audience missing", await signed(Object.fromEntries(Object.entries(claims(VIEWER)).filter(([k]) => k !== "aud")))],
      ["issuer has a trailing path", await signed(claims(VIEWER, { iss: teamUrl + "/x" }))],
      ["issuer is another team", await signed(claims(VIEWER, { iss: "https://other.cloudflareaccess.com" }))],
      ["issuer missing", await signed(Object.fromEntries(Object.entries(claims(VIEWER)).filter(([k]) => k !== "iss")))],
    ];
    const missingControl = new Map<string, ReturnType<typeof full>>();
    for (const route of gatedRoutes()) missingControl.set(route, full(await get(route.replace(slug, MISSING)), MISSING));
    for (const [label, jwt] of bad) {
      for (const route of gatedRoutes()) {
        const r = await get(route, jwtHeader(jwt));
        expect(leaks(r), `${label} on ${route}`).toBe(false);
        expect(r.status, `${label} on ${route}`).toBe(404);
        expect(full(r, slug), `${label} on ${route}`).toEqual(missingControl.get(route));
      }
    }
  });

  test("controls: an array audience that includes ours and a mixed-case email are accepted", async () => {
    const ok1 = await signed(claims(VIEWER, { aud: ["other", AUD] }));
    const ok2 = await signed(claims(VIEWER.toUpperCase()));
    for (const jwt of [ok1, ok2]) expect((await get(`/s/${slug}`, jwtHeader(jwt))).status).toBe(200);
  });

  test("identity is resolved on every request: interleaved good and bad tokens never bleed into each other", async () => {
    const good = await accessJwt(VIEWER);
    const bad = await accessJwt("outsider@example.com");
    const plan = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? bad : i % 3 === 1 ? good : "")); // "" means anonymous
    const results = await Promise.all(plan.map((jwt) => get(`/s/${slug}/raw`, jwt ? jwtHeader(jwt) : {})));
    results.forEach((r, i) => expect(r.status, `request ${i}`).toBe(plan[i] === good ? 200 : 404));
    // And again one by one right after a good request on the same connection pool.
    expect((await get(`/s/${slug}/raw`, jwtHeader(good))).status).toBe(200);
    expect((await get(`/s/${slug}/raw`)).status).toBe(404);
    expect((await get(`/s/${slug}/raw`, jwtHeader(bad))).status).toBe(404);
  });

  test("the Author's identity is not the Viewer's: a Viewer cannot reach Author-only routes with any of those channels", async () => {
    const viewerJwt = await accessJwt(VIEWER);
    for (const p of ["/tokens"]) {
      expect((await get(p, jwtHeader(viewerJwt))).status).toBe(404);
      expect((await get(p, { headers: { ...jwtHeader(viewerJwt).headers as Record<string, string>, "cf-access-authenticated-user-email": AUTHOR } })).status).toBe(404);
    }
    expect((await get("/tokens", jwtHeader(await accessJwt(AUTHOR)))).status).toBe(200);
  });
});

describe("a Gated Share is never served on /p/", () => {
  test("no credential of any kind opens a Gated Share on /p/, and the answer equals a missing slug's", async () => {
    const author = await accessJwt(AUTHOR);
    const viewer = await accessJwt(VIEWER);
    const { token } = await newCaller("reviewer-p");
    const creds: [string, RequestInit][] = [
      ["anonymous", {}],
      ["Author JWT", jwtHeader(author)],
      ["Viewer JWT", jwtHeader(viewer)],
      ["API token", { headers: { authorization: `Bearer ${token}` } }],
      ["cookie", { headers: { cookie: `CF_Authorization=${author}` } }],
    ];
    for (const suffix of ["", "/raw", "?v=1", "/raw?v=1"]) {
      for (const [label, init] of creds) {
        const a = await get(`/p/${slug}${suffix}`, init);
        const m = await get(`/p/${MISSING}${suffix}`, init);
        expect(leaks(a), `${label} ${suffix}`).toBe(false);
        expect(a.status, `${label} ${suffix}`).toBe(404);
        expect(full(a, slug), `${label} ${suffix}`).toEqual(full(m, MISSING));
      }
    }
  });

  test("other methods on /p/ never serve it either", async () => {
    for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
      const r = await get(`/p/${slug}/raw`, { method, body: ["POST", "PUT", "PATCH"].includes(method) ? "x" : undefined });
      expect(r.status, method).toBe(404);
      expect(leaks(r)).toBe(false);
    }
  });
});

describe("refused looks exactly like missing", () => {
  test("off the Allowlist, deleted, and never existed are indistinguishable on every route, headers included", async () => {
    const deleted = (await call("POST", "/api/shares", { html: page(SECRET_MARK), title: "Secret title mark" })).json.slug as string;
    await call("DELETE", `/api/shares/${deleted}`);
    const outsider = await accessJwt("outsider@example.com");
    const viewer = await accessJwt(VIEWER);
    for (const suffix of ["", "/raw", "?v=1", "/raw?v=1", "?v=999", "/raw?v=0", "?v=abc"]) {
      const path = (s: string) => `/s/${s}${suffix}`;
      const missing = full(await get(path(MISSING), jwtHeader(viewer)), MISSING);
      // Allowlisted person: a deleted Share and a Share that never existed answer the same.
      expect(full(await get(path(deleted), jwtHeader(viewer)), deleted), `deleted ${suffix}`).toEqual(missing);
      // Off the Allowlist: a live Gated Share answers like a missing one.
      const off = full(await get(path(slug), jwtHeader(outsider)), slug);
      expect(off, `outsider ${suffix}`).toEqual(full(await get(path(MISSING), jwtHeader(outsider)), MISSING));
      expect(off, `outsider vs allowlisted-missing ${suffix}`).toEqual(missing);
    }
  });

  test("author-only and nonexistent routes answer alike for everyone who cannot use them", async () => {
    const viewer = jwtHeader(await accessJwt(VIEWER));
    const a = full(await get("/tokens", viewer));
    const b = full(await get("/no-such-route", viewer));
    const c = full(await get("/tokens/abcdefabcdef/revoke", viewer));
    expect(a).toEqual(b);
    expect(c).toEqual(b);
  });
});

describe("settings that fail closed", () => {
  const instances: Instance[] = [];
  afterAll(() => Promise.all(instances.map((i) => i.stop())));

  test("an empty ALLOWLIST admits the Author only, never everyone", async () => {
    const inst = await startInstance(settings(teamUrl, { ALLOWLIST: "" }));
    instances.push(inst);
    const mint = await fetch(`${inst.base}/tokens`, await asPerson(AUTHOR, {
      method: "POST", headers: { origin: inst.base, "content-type": "application/x-www-form-urlencoded" }, body: "name=empty-allowlist",
    }));
    const token = /<code id="new-token">(hg_[A-Za-z0-9]+)<\/code>/.exec(await mint.text())![1]!;
    const made = await fetch(`${inst.base}/api/shares`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ html: page(SECRET_MARK), title: "t" }),
    });
    const s = ((await made.json()) as { slug: string }).slug;
    const open = async (email: string) => (await fetch(`${inst.base}/s/${s}/raw`, await asPerson(email))).status;
    expect(await open(AUTHOR)).toBe(200);
    expect(await open(VIEWER)).toBe(404);
    expect(await open("outsider@example.com")).toBe(404);
    expect(await open("")).toBe(404);
  });

  test.each([
    ["ACCESS_AUD", "no audience"],
    ["ACCESS_TEAM_URL", "no team URL"],
    ["AUTHOR_EMAIL", "no Author"],
  ])("a missing %s (%s) refuses every route, including with a validly signed token", async (key) => {
    const vars = settings(teamUrl);
    delete vars[key];
    const inst = await startInstance(vars);
    instances.push(inst);
    const jwt = await accessJwt(AUTHOR);
    for (const p of ["/", "/tokens", "/s/AAAAAAAAAAAA", "/s/AAAAAAAAAAAA/raw", "/p/AAAAAAAAAAAA", "/api/shares", "/api/onboard"]) {
      const r = await fetch(inst.base + p, { headers: { "cf-access-jwt-assertion": jwt, authorization: "Bearer hg_" + "a".repeat(40) } });
      expect(r.status, p).toBe(503);
    }
  });

  test("a team URL with a path is a malformed setting, not a prefix match", async () => {
    const inst = await startInstance(settings(teamUrl + "/nested"));
    instances.push(inst);
    expect((await fetch(inst.base + "/", await asPerson(AUTHOR))).status).toBe(503);
  });
});
