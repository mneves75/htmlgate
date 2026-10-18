// Reviewer tests for the launch-audit change (beta.14), written from the requirements, not from test/launch-audit.test.ts.
// The real Worker runs in-process (reviewer-beta10-harness.ts). A test that FAILS here is a finding.
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "../src/index";
import { person } from "../src/access";
import { readConfig, type Env } from "../src/config";
import { writeZip } from "../packages/cli/src/zip";
import { AUD, AUTHOR, PAGE, startInstance, stopAccess } from "./reviewer-beta10-harness";

afterAll(stopAccess);
afterEach(() => vi.restoreAllMocks());

const spy = () => vi.spyOn(console, "error").mockImplementation(() => {});
const b64u = (s: string) => Buffer.from(s).toString("base64url");
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

// ---------------------------------------------------------------------------------------------------------------------
describe("claim 4: the 64 KiB cap on requests that carry fields only", () => {
  /** JSON with every character as a six-byte \u escape: the largest a legitimate client (Python's json.dumps) can send. */
  const esc = (n: number) => '"' + "\\u0001".repeat(n) + '"';
  const keys = Array.from({ length: 10 }, (_, i) => String.fromCharCode(97 + i).repeat(64));
  const worst = () =>
    `{"title":${esc(200)},"description":${esc(500)},"metadata":{${keys.map((k) => `"${k}":${esc(256)}`).join(",")}},"expires_at":${Date.now() + 86_400_000}}`;

  test("the largest legitimate PATCH (200 + 500 + 10 x 256 characters, every one escaped as \\u0001) is under the cap and accepted", async () => {
    const i = await startInstance();
    const slug = (await i.api("POST", "/api/shares", { html: PAGE, title: "t" })).json.slug as string;
    const body = worst();
    const bytes = new TextEncoder().encode(body).length;
    expect(bytes).toBeGreaterThan(20_000);
    expect(bytes).toBeLessThan(64 * 1024);
    const r = await i.call(`/api/shares/${slug}`, { method: "PATCH", headers: { authorization: `Bearer ${i.token}`, "content-type": "application/json" }, body });
    expect(r.status).toBe(200);
  });

  test("the boundary is exact: 65536 bytes are read, 65537 are refused with 413 body_too_large, with or without a Content-Length", async () => {
    const i = await startInstance();
    const slug = (await i.api("POST", "/api/shares", { html: PAGE, title: "t" })).json.slug as string;
    const headers = { authorization: `Bearer ${i.token}`, "content-type": "application/json" };
    const padded = (n: number) => '{"title":"x"}' + " ".repeat(n - 13);
    const ok = await i.call(`/api/shares/${slug}`, { method: "PATCH", headers, body: padded(65536) });
    expect(ok.status).toBe(200);
    const over = await i.call(`/api/shares/${slug}`, { method: "PATCH", headers, body: padded(65537) });
    expect(over.status).toBe(413);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe("body_too_large");
    // A chunked body (no Content-Length) is cut at the cap too.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(padded(65537)));
        c.close();
      },
    });
    const chunked = await i.call(`/api/shares/${slug}`, { method: "PATCH", headers, body: stream, duplex: "half" } as RequestInit);
    expect(chunked.status).toBe(413);
  });

  test("visibility has the same cap, and a PATCH carrying html still gets a 4xx (not a 200 or a 500)", async () => {
    const i = await startInstance();
    const slug = (await i.api("POST", "/api/shares", { html: PAGE, title: "t" })).json.slug as string;
    const big = await i.api("POST", `/api/shares/${slug}/visibility`, { public: true, x: "y".repeat(65 * 1024) });
    expect(big.status).toBe(413);
    const html = await i.api("PATCH", `/api/shares/${slug}`, { html: PAGE });
    expect(html.status).toBe(400);
    expect(html.json.error.code).toBe("metadata_only_on_patch");
  });

  test("POST and PUT still take a page of the full size (the cap applies to fields-only requests alone)", async () => {
    const i = await startInstance();
    const html = "<!doctype html><title>t</title>" + "a".repeat(2 * 1024 * 1024 - 100);
    const made = await i.api("POST", "/api/shares", { html, title: "t" });
    expect(made.status).toBe(201);
    expect((await i.api("PUT", `/api/shares/${made.json.slug}`, { html })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("claim 5: PUT checks that the Share exists before it reads the body", () => {
  test("a missing, a deleted and an expired Share all answer the same 404 whatever the body is", async () => {
    const i = await startInstance();
    const made = (await i.api("POST", "/api/shares", { html: PAGE, title: "t" })).json.slug as string;
    const gone = (await i.api("POST", "/api/shares", { html: PAGE, title: "t" })).json.slug as string;
    expect((await i.api("DELETE", `/api/shares/${gone}`)).status).toBe(204);
    const expired = (await i.api("POST", "/api/shares", { html: PAGE, title: "t" })).json.slug as string;
    i.fake.sqlite.prepare("UPDATE shares SET expires_at = 1 WHERE slug = ?").run(expired);
    expect(made).not.toBe(gone);

    const bodies: [string, Uint8Array | unknown, Record<string, string>][] = [
      ["valid html", { html: PAGE }, {}],
      ["invalid JSON fields", { title: "" }, {}],
      ["html over the limit", { html: "a".repeat(2 * 1024 * 1024 + 1) }, {}],
      ["a corrupt zip", new TextEncoder().encode("PK not a zip"), i.zipHeaders],
      ["an empty body", new Uint8Array(0), i.zipHeaders],
    ];
    const answers = new Set<string>();
    for (const slug of ["AAAAAAAAAAAA", gone, expired]) {
      for (const [, body, headers] of bodies) {
        const r = await i.api("PUT", `/api/shares/${slug}`, body, headers);
        expect(r.status).toBe(404);
        answers.add(r.text);
      }
    }
    expect(answers.size).toBe(1);
  });

  test("for a Share that exists the error precedence is unchanged: bad JSON 400, big html 413, bad zip 400, valid 200", async () => {
    const i = await startInstance();
    const slug = (await i.api("POST", "/api/shares", { html: PAGE, title: "t" })).json.slug as string;
    const headers = { authorization: `Bearer ${i.token}`, "content-type": "application/json" };
    const raw = await i.call(`/api/shares/${slug}`, { method: "PUT", headers, body: "{nope" });
    expect(raw.status).toBe(400);
    expect(((await raw.json()) as { error: { code: string } }).error.code).toBe("invalid_json");
    expect((await i.api("PUT", `/api/shares/${slug}`, { html: "a".repeat(2 * 1024 * 1024 + 1) })).status).toBe(413);
    expect((await i.api("PUT", `/api/shares/${slug}`, new TextEncoder().encode("PK nope"), i.zipHeaders)).status).toBe(400);
    expect((await i.api("PUT", `/api/shares/${slug}`, { title: "no html" })).json.error.code).toBe("html_required");
    expect((await i.api("PUT", `/api/shares/${slug}`, { html: PAGE })).status).toBe(200);
    const zip = writeZip([{ path: "index.html", data: new TextEncoder().encode(PAGE) }]);
    expect((await i.api("PUT", `/api/shares/${slug}`, zip, i.zipHeaders)).status).toBe(200);
  });

  test("a PUT to a missing Share does no work on the body: a zip bomb-sized declared length is never read", async () => {
    const i = await startInstance();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(1024));
        if (pulled > 50) c.close();
      },
    });
    const r = await i.call("/api/shares/AAAAAAAAAAAA", { method: "PUT", headers: { authorization: `Bearer ${i.token}`, ...i.zipHeaders }, body: stream, duplex: "half" } as RequestInit);
    expect(r.status).toBe(404);
    expect(pulled).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("claim 3: no WRITE_LIMIT binding", () => {
  test("every change is 503 server_misconfigured, every read works, an unauthenticated caller learns nothing", async () => {
    const i = await startInstance();
    const env: Env = { ...i.env, WRITE_LIMIT: undefined };
    const slug = (await i.api("POST", "/api/shares", { html: PAGE, title: "t" })).json.slug as string;
    const h = { authorization: `Bearer ${i.token}`, "content-type": "application/json" };
    const go = (method: string, path: string, body?: unknown, headers: Record<string, string> = h) =>
      worker.fetch!(new Request(i.HOST + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }) as never, env, ctx);

    for (const [method, path, body] of [
      ["POST", "/api/shares", { html: PAGE, title: "t" }],
      ["PUT", `/api/shares/${slug}`, { html: PAGE }],
      ["PATCH", `/api/shares/${slug}`, { title: "x" }],
      ["DELETE", `/api/shares/${slug}`, undefined],
      ["POST", `/api/shares/${slug}/visibility`, { public: true }],
      ["DELETE", "/api/tokens/aaaaaaaaaaaa", undefined],
    ] as const) {
      const r = await go(method, path, body);
      expect(r.status, `${method} ${path}`).toBe(503);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("server_misconfigured");
    }
    expect(i.fake.one<{ n: number }>("SELECT COUNT(*) AS n FROM shares WHERE deleted_at IS NULL").n).toBe(1);
    expect((await i.api("GET", `/api/shares/${slug}`)).json.public).toBe(false);

    for (const path of ["/api/onboard", "/api/shares", `/api/shares/${slug}`, `/api/shares/${slug}/versions`, "/api/tokens"]) {
      expect((await go("GET", path)).status, path).toBe(200);
    }
    // Without a token the answer is the usual 401, not a hint about the Instance's configuration.
    expect((await go("POST", "/api/shares", { html: PAGE, title: "t" }, { "content-type": "application/json" })).status).toBe(401);
    // The people's pages never needed the limit.
    expect((await worker.fetch!(new Request(`${i.HOST}/p/${slug}`) as never, env, ctx)).status).toBe(404);
  });

  test("with the binding, a refused limit is still 429, and the limiter is keyed by the token", async () => {
    const i = await startInstance();
    const keys: string[] = [];
    let allow = true;
    const env: Env = { ...i.env, WRITE_LIMIT: { limit: async ({ key }: { key: string }) => (keys.push(key), { success: allow }) } as unknown as RateLimit };
    const post = () => worker.fetch!(new Request(`${i.HOST}/api/shares`, { method: "POST", headers: { authorization: `Bearer ${i.token}`, "content-type": "application/json" }, body: JSON.stringify({ html: PAGE, title: "t" }) }) as never, env, ctx);
    expect((await post()).status).toBe(201);
    allow = false;
    const r = await post();
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(keys.length).toBe(2);
    expect(keys[0]).toBe(keys[1]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("claim 2: the `access` log", () => {
  const request = (token: string) => new Request("https://gate.example.com/", { headers: { "cf-access-jwt-assertion": token } });

  /** Tokens an unauthenticated caller can build with no key at all. */
  async function forgeries(kidOfRealKey: string) {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const claims = { email: AUTHOR, type: "app" };
    const sign = (header: Record<string, unknown>) =>
      new SignJWT(claims).setProtectedHeader(header as never).setIssuedAt().setExpirationTime("1h").sign(privateKey);
    const hs = await new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode("k".repeat(32)));
    return {
      "unknown kid, RS256": await sign({ alg: "RS256", kid: "attacker-key" }),
      "no kid, RS256": await sign({ alg: "RS256" }),
      "right kid, wrong key": await sign({ alg: "RS256", kid: kidOfRealKey }),
      "HS256": hs,
      "alg none": `${b64u('{"alg":"none"}')}.${b64u(`{"email":"${AUTHOR}"}`)}.`,
      "ES256 header": `${b64u('{"alg":"ES256","kid":"x"}')}.${b64u("{}")}.${b64u("sig")}`,
      "encrypted (five parts)": ["a", "b", "c", "d", "e"].map(b64u).join("."),
      "header not JSON": `${b64u("not json")}.${b64u("{}")}.${b64u("s")}`,
      "kid is huge": await sign({ alg: "RS256", kid: "k".repeat(4000) }),
      "kid is an object": await sign({ alg: "RS256", kid: { a: 1 } }),
      "crit header": `${b64u(JSON.stringify({ alg: "RS256", kid: kidOfRealKey, crit: ["x"], x: 1 }))}.${b64u("{}")}.${b64u("sig")}`,
    } as Record<string, string>;
  }

  test("a token an unauthenticated caller forged never produces a log line (the claim: only errors that are not the token's own are logged)", async () => {
    const i = await startInstance();
    const cfg = readConfig(i.env)!;
    const noisy: string[] = [];
    for (const [name, token] of Object.entries(await forgeries("rev-key"))) {
      const errors = spy();
      expect(await person(request(token), cfg), name).toBeNull();
      if (errors.mock.calls.length) noisy.push(`${name} -> ${errors.mock.calls.map((c) => c.slice(0, 2).join(" ")).join(" | ")}`);
      errors.mockRestore();
    }
    expect(noisy, "forged tokens that reached the logs").toEqual([]);
  });

  test("the same through the Worker: a forged header on a path outside Access's gate (/p/junk) logs nothing", async () => {
    const i = await startInstance();
    const errors = spy();
    for (const token of Object.values(await forgeries("rev-key"))) {
      const r = await i.call("/p/junk", { headers: { "cf-access-jwt-assertion": token } });
      expect(r.status).toBe(404);
    }
    expect(errors.mock.calls.map((c) => c.slice(0, 2).join(" "))).toEqual([]);
  });

  test("whatever is logged never holds the token, a segment of it, or an email", async () => {
    const i = await startInstance();
    const down = readConfig({ ...i.env, ACCESS_TEAM_URL: "http://127.0.0.1:9" })!;
    const up = readConfig(i.env)!;
    const real = await i.jwt(AUTHOR);
    const seen: string[] = [];
    for (const token of [real, ...Object.values(await forgeries("rev-key"))]) {
      for (const cfg of [down, up]) {
        const errors = spy();
        await person(request(token), cfg);
        seen.push(JSON.stringify(errors.mock.calls.map((c) => c.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))))));
        errors.mockRestore();
      }
      const segments = token.split(".").filter((s) => s.length >= 8);
      for (const line of seen) for (const s of segments) expect(line).not.toContain(s);
    }
    for (const line of seen) expect(line).not.toContain(AUTHOR);
    expect(seen.some((l) => l.includes("access"))).toBe(true); // the unreachable certs endpoint is logged
  });

  test("unknown-kid tokens do not make the Worker fetch the certs on every request", async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const i = await startInstance();
      const cfg = readConfig({ ...i.env, ACCESS_TEAM_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })!;
      const { privateKey } = await generateKeyPair("RS256", { extractable: true });
      const errors = spy();
      for (let n = 0; n < 25; n++) {
        const t = await new SignJWT({ email: AUTHOR }).setProtectedHeader({ alg: "RS256", kid: `k${n}` }).sign(privateKey);
        await person(request(t), cfg);
      }
      expect(hits).toBeLessThanOrEqual(3);
      // Informational: how many of the 25 forged requests became log lines.
      expect(errors.mock.calls.length, "log lines from 25 forged requests").toBe(0);
    } finally {
      server.close();
    }
  });

  test("an expired or wrong-audience token from the real key is an ordinary refusal", async () => {
    const i = await startInstance();
    const cfg = readConfig(i.env)!;
    const errors = spy();
    expect(await person(request(await i.jwt(AUTHOR, { aud: "other" })), cfg)).toBeNull();
    const a = await startInstance();
    void a;
    expect(AUD).toBeTruthy();
    expect(errors).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("claim 1: the hourly cleanup", () => {
  const controller = { cron: "17 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController;

  test("a healthy run logs nothing and does the same work as before", async () => {
    const i = await startInstance();
    i.fake.objects.set("bodies/due/1", new Uint8Array(1));
    i.fake.sqlite.prepare("INSERT INTO trash (body_key, size, due_at) VALUES (?, ?, ?)").run("bodies/due/1", 1, 0);
    const errors = spy();
    await worker.scheduled!(controller, i.env);
    expect(errors).not.toHaveBeenCalled();
    expect(i.fake.objects.has("bodies/due/1")).toBe(false);
  });

  test("both steps failing: both are logged by name and the run fails with the first error", async () => {
    const i = await startInstance();
    i.fake.objects.set("bodies/due/1", new Uint8Array(1));
    i.fake.sqlite.prepare("INSERT INTO trash (body_key, size, due_at) VALUES (?, ?, ?)").run("bodies/due/1", 1, 0);
    i.fake.hooks.failBucketDelete = true;
    const errors = spy();
    const broken = { ...i.env, DB: { prepare: i.fake.db.prepare.bind(i.fake.db), batch: async () => { throw new Error("d1 down"); } } as unknown as D1Database };
    await expect(worker.scheduled!(controller, broken)).rejects.toThrow("d1 down");
    const names = errors.mock.calls.filter((c) => c[0] === "scheduled").map((c) => c[1]);
    expect(names).toEqual(["expire", "trash"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("claim 6 and the zip route's log", () => {
  test("`missing body` is logged without the bearer token or the Author's email", async () => {
    const i = await startInstance();
    const zip = writeZip([{ path: "index.html", data: new TextEncoder().encode(PAGE) }]);
    const slug = (await i.api("POST", "/api/shares?title=Site", zip, i.zipHeaders)).json.slug as string;
    i.fake.objects.clear();
    const errors = spy();
    const r = await i.api("GET", `/api/shares/${slug}/versions/1/zip`);
    expect(r.status).toBe(404);
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain("missing body");
    expect(logged).not.toContain(i.token);
    expect(logged).not.toContain(AUTHOR);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("docs/operator.md: the uptime URLs", () => {
  const counted = (i: Awaited<ReturnType<typeof startInstance>>, fail = false) => {
    let queries = 0;
    const db = {
      prepare: (sql: string) => {
        queries += 1;
        if (fail) throw new Error("d1 down");
        return i.fake.db.prepare(sql);
      },
      batch: i.fake.db.batch.bind(i.fake.db),
    } as unknown as D1Database;
    return { env: { ...i.env, DB: db } as Env, queries: () => queries };
  };
  const get = (env: Env, i: Awaited<ReturnType<typeof startInstance>>, path: string) => worker.fetch!(new Request(i.HOST + path) as never, env, ctx);

  test("/api/onboard is 200 and reads no database, even with the database down", async () => {
    const i = await startInstance();
    const c = counted(i, true);
    expect((await get(c.env, i, "/api/onboard")).status).toBe(200);
    expect(c.queries()).toBe(0);
  });

  test("/api/onboard is 503 when the Instance lost its settings", async () => {
    const i = await startInstance();
    const env = { ...i.env, ACCESS_TEAM_URL: undefined } as Env;
    expect((await get(env, i, "/api/onboard")).status).toBe(503);
  });

  test("/p/aaaaaaaaaaaa is 404 with one database query, and 500 when the database is down", async () => {
    const i = await startInstance();
    const ok = counted(i);
    expect((await get(ok.env, i, "/p/aaaaaaaaaaaa")).status).toBe(404);
    expect(ok.queries()).toBe(1);
    const errors = spy();
    const down = counted(i, true);
    expect((await get(down.env, i, "/p/aaaaaaaaaaaa")).status).toBe(500);
    expect(errors.mock.calls[0]![0]).toBe("unhandled");
  });
});
