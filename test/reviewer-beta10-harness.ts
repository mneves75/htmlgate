// Reviewer harness (beta.10): the real Worker (src/index.ts) run in-process, with no wrangler. Real SQLite with every
// migration and an in-memory R2 (test/fake-env.ts); a local JWKS server stands in for Access, so a person's sign-in is
// a genuinely signed Cf-Access-Jwt-Assertion that the Worker verifies as it would on the Instance.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import worker from "../src/index";
import type { Env } from "../src/config";
import { newToken, randomHex, sha256Hex } from "../src/ids";
import { Store } from "../src/store";
import { fakeEnv, type FakeStatement } from "./fake-env";

export const AUTHOR = "author@example.com";
export const VIEWER = "viewer@example.com";
export const AUD = "reviewer-aud";
export const TICKET_KEY = "k3Y9pQ2mZ8vL4nR7tW1xC5bH6jD0fG3sA9uE2iO8yUc"; // 43 chars, canonical (last char c: low bits 00)

let jwks: { server: Server; url: string; kid: string; key: CryptoKey } | undefined;
export async function startAccess() {
  if (jwks) return jwks;
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "rev-key", alg: "RS256", use: "sig" };
  const server = createServer((req, res) => {
    if (req.url === "/cdn-cgi/access/certs") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  jwks = { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, kid: "rev-key", key: privateKey };
  return jwks;
}
export async function stopAccess() {
  await new Promise<void>((r) => (jwks ? jwks.server.close(() => r()) : r()));
  jwks = undefined;
}

export type Vars = Partial<Pick<Env, "ALLOWLIST" | "EXPIRY_DAYS" | "TICKET_KEY" | "ACCESS_AUD" | "STORAGE_LIMIT_BYTES" | "LANGUAGE">>;

export async function startInstance(vars: Vars = {}, opts: Parameters<typeof fakeEnv>[0] = {}) {
  const access = await startAccess();
  const fake = fakeEnv(opts);
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  const env: Env = {
    DB: fake.db, BODIES: fake.bucket, WRITE_LIMIT: { limit: async () => ({ success: true }) } as RateLimit,
    ACCESS_TEAM_URL: access.url, ACCESS_AUD: AUD, AUTHOR_EMAIL: AUTHOR, ALLOWLIST: VIEWER, TICKET_KEY, ...vars,
  };
  const settle = async () => {
    while (pending.length) await Promise.allSettled(pending.splice(0));
  };
  const jwt = (email: string, over: { aud?: string } = {}) =>
    new SignJWT({ email, type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: access.kid })
      .setIssuer(access.url).setAudience([over.aud ?? AUD])
      .setIssuedAt().setNotBefore(Math.floor(Date.now() / 1000) - 5).setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .setSubject("sub-" + email)
      .sign(access.key);

  const HOST = "https://gate.example.com";
  /** One request to the Worker. `as` signs the request in as that person (the Access gate's header). */
  async function call(path: string, init: RequestInit & { as?: string; asAud?: string } = {}): Promise<Response> {
    const { as, asAud, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (as) headers.set("cf-access-jwt-assertion", await jwt(as, { aud: asAud }));
    const res = await worker.fetch!(new Request(HOST + path, { ...rest, headers, redirect: "manual" }) as never, env, ctx);
    await settle();
    return res;
  }

  const store = new Store(fake.db, fake.bucket);
  const token = newToken();
  await store.createToken(randomHex(6), AUTHOR, "reviewer", await sha256Hex(token), Date.now());

  /** The Publisher API with the Author's token. */
  async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { authorization: `Bearer ${token}`, ...headers };
    let payload: BodyInit | undefined;
    if (body instanceof Uint8Array) payload = body as unknown as BodyInit;
    else if (body !== undefined) {
      h["content-type"] ??= "application/json";
      payload = JSON.stringify(body);
    }
    const res = await call(path, { method, headers: h, body: payload });
    const text = await res.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  const zipHeaders = { "content-type": "application/zip" };

  /** Serves the Worker on loopback http, for the built CLI to talk to. */
  async function listen(): Promise<{ url: string; close: () => Promise<void>; seen: { method: string; url: string; headers: Record<string, string | string[] | undefined> }[] }> {
    const seen: { method: string; url: string; headers: Record<string, string | string[] | undefined> }[] = [];
    const server = createServer(async (rq, rs) => {
      const chunks: Buffer[] = [];
      for await (const c of rq) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(rq.headers)) if (typeof v === "string") headers.set(k, v);
      const method = rq.method ?? "GET";
      seen.push({ method, url: rq.url ?? "", headers: rq.headers });
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await worker.fetch!(new Request(origin + rq.url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks), redirect: "manual" }) as never, env, ctx);
      await settle();
      rs.writeHead(res.status, Object.fromEntries(res.headers));
      rs.end(Buffer.from(await res.arrayBuffer()));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())), seen };
  }

  /** Runs the hourly cleanup, counting the D1 statements and bucket deletes it makes. */
  async function cron(): Promise<{ d1: number; r2: number }> {
    let d1 = 0;
    let r2 = 0;
    const count = (s: FakeStatement): FakeStatement => ({
      ...s,
      bind: (...v) => count(s.bind(...v)),
      run: () => (d1++, s.run()),
      all: <T>() => (d1++, s.all<T>()),
      first: <T>() => (d1++, s.first<T>()),
    });
    const db = fake.db as unknown as { prepare: (sql: string) => FakeStatement; batch: (ss: FakeStatement[]) => Promise<unknown> };
    const bucket = fake.bucket as unknown as { delete: (k: string | string[]) => Promise<void> };
    const counted: Env = {
      ...env,
      DB: { prepare: (sql: string) => count(db.prepare(sql)), batch: (ss: FakeStatement[]) => db.batch(ss) } as unknown as D1Database,
      BODIES: { ...fake.bucket, delete: (k: string | string[]) => (r2++, bucket.delete(k)) } as unknown as R2Bucket,
    };
    await worker.scheduled!({ cron: "17 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, counted);
    return { d1, r2 };
  }

  return { env, fake, store, token, call, api, zipHeaders, jwt, listen, cron, settle, HOST };
}
export type Instance = Awaited<ReturnType<typeof startInstance>>;

export const PAGE = "<!doctype html><title>t</title><p>hello</p>";
