// Plain http on a real hostname serves nothing: the API and changes are refused, a page visit goes to https.
// Loopback stays http for `wrangler dev`. Every answer carries Strict-Transport-Security.
import { request } from "node:http";
import { beforeAll, describe, expect, test } from "vitest";
import { AUTHOR } from "./global-setup";
import { api, asPerson, base, mintToken, page } from "./helpers";

const HSTS = "max-age=31536000";
const HOST = "html.example.com";
// wrangler dev's proxy rewrites a Location on the request's own host to its own http origin. A request on another
// port keeps the Worker's https Location intact, and also proves the redirect drops a plain http port.
const PORTED = `${HOST}:8080`;
const local = new URL(base);

type Hit = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** One request to the local Worker with a chosen Host header, which fetch() cannot set. Redirects are not followed. */
function hit(path: string, opts: { host?: string; method?: string; headers?: Record<string, string> } = {}): Promise<Hit> {
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.host ? { host: opts.host } : {}), ...opts.headers };
    const req = request({ host: local.hostname, port: local.port, path, method: opts.method ?? "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

let token: string;
let slug: string;
beforeAll(async () => {
  token = await mintToken("transport");
  const call = api(token);
  const created = await call("POST", "/api/shares", { html: page("transport"), title: "transport" });
  expect(created.status).toBe(201);
  slug = created.json.slug;
  expect((await call("POST", `/api/shares/${slug}/visibility`, { public: true })).status).toBe(200);
});

describe("plain http on a real hostname", () => {
  test.each([
    ["GET", "/api"], ["HEAD", "/api/shares"], ["GET", "/api/shares"], ["GET", "/api/onboard"], ["POST", "/api/shares"], ["DELETE", "/api/tokens/0123456789ab"],
    ["POST", "/tokens"], ["POST", "/tokens/0123456789ab/revoke"], ["PUT", "/p/AAAAAAAAAAAA"],
  ])("%s %s is refused with https_required, even with a valid token", async (method, path) => {
    const r = await hit(path, { host: HOST, method, headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(403);
    // A HEAD answer has no body.
    if (method !== "HEAD") expect(JSON.parse(r.body).error.code).toBe("https_required");
    expect(r.headers.location).toBeUndefined();
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  test.each([
    ["GET", "/"], ["GET", "/tokens"], ["GET", "/s/AAAAAAAAAAAA"], ["HEAD", "/s/AAAAAAAAAAAA/raw"],
    ["GET", "/p/AAAAAAAAAAAA?v=2"], ["GET", "/robots.txt"], ["GET", "/no/such/page"],
  ])("%s %s is sent to the same address on https, with nothing of the page", async (method, path) => {
    const r = await hit(path, { host: PORTED, method });
    expect(r.status).toBe(301);
    expect(r.headers.location).toBe(`https://${HOST}${path}`);
    expect(r.body).toBe("");
  });

  test("a Public Share's page and body are never served in clear", async () => {
    for (const path of [`/p/${slug}`, `/p/${slug}/raw`]) {
      const r = await hit(path, { host: HOST });
      expect(r.status, path).toBe(301);
      expect(r.body, path).not.toContain("transport");
    }
  });

  test("a path that looks like another host stays a path on this host", async () => {
    for (const path of ["//evil.example/x", "/%2F%2Fevil.example", "/\\evil.example"]) {
      const r = await hit(path, { host: PORTED });
      expect(r.status, path).toBe(301);
      const to = new URL(r.headers.location as string);
      expect([to.protocol, to.host], path).toEqual(["https:", HOST]);
    }
  });
});

describe("loopback stays http, for wrangler dev", () => {
  test.each(["127.0.0.1", "localhost", "[::1]"])("Host %s is served as before", async (host) => {
    const r = await hit("/api/onboard", { host: `${host}:${local.port}` });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).name).toBe("htmlgate");
  });

  test("a real hostname that starts like loopback is not loopback", async () => {
    for (const host of ["127.0.0.1.example.com", "localhost.example.com"]) {
      expect((await hit("/api/onboard", { host })).status, host).toBe(403);
    }
  });
});

describe("every answer carries Strict-Transport-Security", () => {
  test("JSON, error, page, body, redirect, empty and refusal answers", async () => {
    const bearer = { authorization: `Bearer ${token}` };
    const author = await asPerson(AUTHOR, { headers: { origin: base } });
    const doomed = (await api(token)("POST", "/api/shares", { html: page("x"), title: "x" })).json.slug;
    const answers: [string, number, string | null][] = [];
    const add = (label: string, r: Response) => answers.push([label, r.status, r.headers.get("strict-transport-security")]);
    add("onboard", await fetch(`${base}/api/onboard`));
    add("api without a token", await fetch(`${base}/api/shares`));
    add("api unknown path", await fetch(`${base}/api/nothing`, { headers: bearer }));
    add("robots", await fetch(`${base}/robots.txt`));
    add("not found page", await fetch(`${base}/p/AAAAAAAAAAAA`));
    add("viewer page", await fetch(`${base}/p/${slug}`));
    add("raw body", await fetch(`${base}/p/${slug}/raw`));
    add("home", await fetch(`${base}/`, author));
    add("revoke", await fetch(`${base}/tokens/0123456789ab/revoke`, { ...author, method: "POST", redirect: "manual" }));
    add("delete", await fetch(`${base}/api/shares/${doomed}`, { method: "DELETE", headers: bearer }));
    for (const [label, path] of [["cleartext page", "/p/AAAAAAAAAAAA"], ["cleartext api", "/api/shares"]] as const) {
      const r = await hit(path, { host: HOST });
      answers.push([label, r.status, (r.headers["strict-transport-security"] as string | undefined) ?? null]);
    }
    expect(answers).toEqual([
      ["onboard", 200, HSTS], ["api without a token", 401, HSTS], ["api unknown path", 404, HSTS], ["robots", 200, HSTS],
      ["not found page", 404, HSTS], ["viewer page", 200, HSTS], ["raw body", 200, HSTS], ["home", 200, HSTS],
      ["revoke", 303, HSTS], ["delete", 204, HSTS], ["cleartext page", 301, HSTS], ["cleartext api", 403, HSTS],
    ]);
  });
});
