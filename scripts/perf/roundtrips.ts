import worker from "../../src/index";
import { writeZip } from "../../packages/cli/src/zip";
import { AUTHOR, PAGE, startInstance, VIEWER } from "../../test/reviewer-beta10-harness";

const LATENCY_MS = 20;
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Call { kind: "d1" | "r2"; what: string; sql: string[]; start: number; end: number }
export interface RouteCount { key: string; route: string; status: number; d1Waves: number; d1Calls: number; r2Waves: number; background: number; sql: string[] }

type Stmt = { sql: string; bind: (...v: unknown[]) => Stmt; run: () => Promise<unknown>; all: () => Promise<unknown>; first: () => Promise<unknown> };
type RawDb = { prepare: (sql: string) => Stmt; batch: (s: Stmt[]) => Promise<unknown[]> };
type RawBucket = Record<string, (...a: unknown[]) => Promise<unknown>>;

function instrument(rawDb: RawDb, rawBucket: RawBucket, calls: Call[]) {
  const raw = new WeakMap<object, Stmt>();
  const timed = async <T>(kind: Call["kind"], what: string, sql: string[], f: () => Promise<T>): Promise<T> => {
    const c: Call = { kind, what, sql, start: performance.now(), end: NaN };
    calls.push(c);
    await sleep(LATENCY_MS);
    try {
      return await f();
    } finally {
      c.end = performance.now();
    }
  };
  const wrap = (s: Stmt): Stmt => {
    const w: Stmt = {
      sql: s.sql,
      bind: (...v) => wrap(s.bind(...v)),
      run: () => timed("d1", "run", [s.sql], () => s.run()),
      all: () => timed("d1", "all", [s.sql], () => s.all()),
      first: () => timed("d1", "first", [s.sql], () => s.first()),
    };
    raw.set(w, s);
    return w;
  };
  const db = {
    prepare: (sql: string) => wrap(rawDb.prepare(sql)),
    batch: (ss: Stmt[]) => timed("d1", "batch", ss.map((s) => s.sql), () => rawDb.batch(ss.map((s) => raw.get(s) ?? s))),
  };
  const bucket = Object.fromEntries(
    Object.keys(rawBucket).map((k) => [k, (...a: unknown[]) => timed("r2", k, [], () => rawBucket[k]!(...a))]),
  );
  return { db: db as unknown as D1Database, bucket: bucket as unknown as R2Bucket };
}

export function waves(calls: Call[]): number {
  const sorted = [...calls].sort((a, b) => a.start - b.start);
  const depth: number[] = [];
  for (const [i, c] of sorted.entries()) {
    let before = 0;
    for (let j = 0; j < i; j++) if (sorted[j]!.end <= c.start) before = Math.max(before, depth[j]!);
    depth.push(before + 1);
  }
  return Math.max(0, ...depth);
}

function must(ok: boolean, what: string) {
  if (!ok) throw new Error(`round-trip setup failed: ${what}`);
}

export async function measureRoutes() {
  const i = await startInstance({ ALLOWLIST: VIEWER });
  const pub = await i.api("POST", "/api/shares", { html: PAGE, title: "Public" });
  must(pub.status === 201, "publish");
  const pslug = pub.json.slug as string;
  must((await i.api("POST", `/api/shares/${pslug}/visibility`, { public: true })).status === 200, "make public");
  const gated = await i.api("POST", "/api/shares", { html: PAGE, title: "Gated" });
  must(gated.status === 201, "publish gated");
  const slug = gated.json.slug as string;
  for (let v = 0; v < 3; v++) must((await i.api("PUT", `/api/shares/${slug}`, { html: PAGE + v })).status === 200, "new Version");
  const site = await i.api("POST", "/api/shares?title=Site", writeZip([{ path: "index.html", data: enc.encode(PAGE) }, { path: "a.css", data: enc.encode("p{}") }]), i.zipHeaders);
  must(site.status === 201, "publish site");
  for (let k = 0; k < 40; k++) must((await i.api("POST", "/api/shares", { html: PAGE, title: `Filler ${k}` })).status === 201, "filler");
  for (let d = 0; d < 90; d++) {
    const day = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    i.fake.sqlite.prepare("INSERT INTO share_views (slug, day, views) VALUES (?, ?, ?), (?, ?, ?)").run(slug, day, 3, pslug, day, 5);
  }

  const calls: Call[] = [];
  const inst = instrument(i.fake.db as unknown as RawDb, i.fake.bucket as unknown as RawBucket, calls);
  i.env.DB = inst.db;
  i.env.BODIES = inst.bucket;

  const pending: Promise<unknown>[] = [];
  let answered = 0;
  async function call(path: string, init: RequestInit & { as?: string } = {}) {
    const { as, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (as) headers.set("cf-access-jwt-assertion", await i.jwt(as));
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await worker.fetch!(new Request(i.HOST + path, { ...rest, headers, redirect: "manual" }) as never, i.env, ctx);
    await res.arrayBuffer();
    answered = performance.now();
    while (pending.length) await Promise.allSettled(pending.splice(0));
    return res;
  }
  const api = (method: string, path: string, body?: unknown) =>
    call(path, { method, headers: { authorization: `Bearer ${i.token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });

  const NAV = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" };
  const routes: [string, string, () => Promise<Response>, number][] = [
    ["GET /", "GET / (Author home)", () => call("/", { as: AUTHOR, headers: NAV }), 200],
    ["GET / (Viewer)", "GET / (Viewer)", () => call("/", { as: VIEWER, headers: NAV }), 200],
    ["GET /metrics", "GET /metrics", () => call("/metrics", { as: AUTHOR, headers: NAV }), 200],
    ["GET /tokens", "GET /tokens", () => call("/tokens", { as: AUTHOR, headers: NAV }), 200],
    ["GET /s/<slug>", "GET /s/<slug> (Gated page)", () => call(`/s/${slug}`, { as: AUTHOR, headers: NAV }), 200],
    ["GET /s/<slug>/raw", "GET /s/<slug>/raw (Gated body)", () => call(`/s/${slug}/raw`, { as: AUTHOR }), 200],
    ["GET /p/<slug>", "GET /p/<slug> (Public page)", () => call(`/p/${pslug}`, { headers: NAV }), 200],
    ["GET /p/<slug>/raw", "GET /p/<slug>/raw (Public body)", () => call(`/p/${pslug}/raw`), 200],
    ["GET /p/<missing>", "GET /p/<missing> (not found)", () => call("/p/zzzzzzzzzzzz", { headers: NAV }), 404],
    ["GET /api/shares", "GET /api/shares (list)", () => api("GET", "/api/shares"), 200],
    ["GET /api/shares/<slug>", "GET /api/shares/<slug>", () => api("GET", `/api/shares/${slug}`), 200],
    ["GET /api/shares/<slug>/versions", "GET /api/shares/<slug>/versions", () => api("GET", `/api/shares/${slug}/versions`), 200],
    ["POST /api/shares", "POST /api/shares (publish html)", () => api("POST", "/api/shares", { html: PAGE, title: "New" }), 201],
    ["PUT /api/shares/<slug>", "PUT /api/shares/<slug> (new Version)", () => api("PUT", `/api/shares/${slug}`, { html: PAGE + "x" }), 200],
    ["PATCH /api/shares/<slug>", "PATCH /api/shares/<slug>", () => api("PATCH", `/api/shares/${slug}`, { title: "Renamed" }), 200],
    ["POST /api/shares/<slug>/visibility", "POST /api/shares/<slug>/visibility", () => api("POST", `/api/shares/${pslug}/visibility`, { public: true }), 200],
  ];

  const rows: RouteCount[] = [];
  const statements = new Set<string>();
  for (const [key, route, go, expected] of routes) {
    i.fake.sqlite.prepare("UPDATE tokens SET last_used_at = NULL").run();
    calls.length = 0;
    const res = await go();
    must(res.status === expected, `${route} answered ${res.status}, not ${expected}`);
    const critical = calls.filter((c) => c.end <= answered);
    const d1 = critical.filter((c) => c.kind === "d1");
    rows.push({
      key, route, status: res.status, d1Waves: waves(d1), d1Calls: d1.length, r2Waves: waves(critical.filter((c) => c.kind === "r2")),
      background: calls.length - critical.length, sql: d1.flatMap((c) => c.sql.map((s) => `${c.what}: ${s.replace(/\s+/g, " ").trim()}`)),
    });
    for (const c of calls) for (const s of c.sql) statements.add(s);
  }

  const plans = [...statements].map((sql) => {
    let plan: string;
    try {
      plan = (i.fake.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join("; ");
    } catch (e) {
      plan = `(not explained: ${(e as Error).message})`;
    }
    return { sql: sql.replace(/\s+/g, " ").trim(), plan };
  });
  const sizes = Object.fromEntries(["shares", "versions", "tokens", "trash", "share_views"].map((t) => [t, i.fake.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`).n]));
  return { latencyMs: LATENCY_MS, sizes, rows, plans };
}
