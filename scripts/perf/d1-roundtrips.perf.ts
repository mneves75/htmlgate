// D1 and R2 round trips on each route's critical path, counted on the real Worker (src/index.ts) run in-process over
// real SQLite with every migration (test/fake-env.ts). Each D1 call (a statement or a batch) and each R2 call waits a
// fixed LATENCY_MS before it runs, the way every call from a Brazilian data center waits for a database in North
// America; calls that overlap form one wave. A route's critical path is the waves that finish before its response:
// work sent with ctx.waitUntil is counted apart, as background. Every statement is also run through EXPLAIN QUERY
// PLAN against the same database. These are counters, not timings: valid locally (docs/perf/PLAN.md).
//
//   pnpm exec vitest run -c scripts/perf/vitest.config.ts       writes docs/perf/raw/d1-roundtrips.{json,md}
import { writeFileSync } from "node:fs";
import { afterAll, expect, test } from "vitest";
import { writeZip } from "../../packages/cli/src/zip";
import { AUTHOR, PAGE, startInstance, stopAccess, VIEWER } from "../../test/reviewer-beta10-harness";

const LATENCY_MS = 20;
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Call { kind: "d1" | "r2"; what: string; sql: string[]; start: number; end: number }

type Stmt = { sql: string; bind: (...v: unknown[]) => Stmt; run: () => Promise<unknown>; all: () => Promise<unknown>; first: () => Promise<unknown> };
type RawDb = { prepare: (sql: string) => Stmt; batch: (s: Stmt[]) => Promise<unknown[]> };

function instrument(rawDb: RawDb, rawBucket: Record<string, (...a: unknown[]) => Promise<unknown>>, calls: Call[]) {
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
    ["get", "put", "list", "delete", "head"].filter((k) => k in rawBucket).map((k) => [k, (...a: unknown[]) => timed("r2", k, [], () => rawBucket[k]!(...a))]),
  );
  return { db: db as unknown as D1Database, bucket: bucket as unknown as R2Bucket };
}

/** Waves: calls are taken by start time; one that starts after every call of the current wave ended opens the next. */
export function waves(calls: Call[]): number {
  let n = 0;
  let open = -Infinity;
  for (const c of [...calls].sort((a, b) => a.start - b.start)) {
    if (c.start >= open) {
      n++;
      open = c.end;
    } else open = Math.max(open, c.end);
  }
  return n;
}

const rows: { route: string; status: number; d1Waves: number; d1Calls: number; r2Waves: number; background: number; sql: string[] }[] = [];
const statements = new Set<string>();

afterAll(async () => {
  await stopAccess();
});

test("round trips per route", async () => {
  const i = await startInstance({ ALLOWLIST: VIEWER });
  // A realistic shape for one Author: Gated and Public pages, a site, Versions, views over 90 days.
  const pub = await i.api("POST", "/api/shares", { html: PAGE, title: "Public" });
  expect(pub.status).toBe(201);
  expect((await i.api("POST", `/api/shares/${pub.json.slug}/visibility`, { public: true })).status).toBeLessThan(300);
  const gated = await i.api("POST", "/api/shares", { html: PAGE, title: "Gated" });
  expect(gated.status).toBe(201);
  for (let v = 0; v < 3; v++) expect((await i.api("PUT", `/api/shares/${gated.json.slug}`, { html: PAGE + v })).status).toBe(200);
  const site = await i.api("POST", "/api/shares?title=Site", writeZip([{ path: "index.html", data: enc.encode(PAGE) }, { path: "a.css", data: enc.encode("p{}") }]), i.zipHeaders);
  expect(site.status).toBe(201);
  for (let k = 0; k < 40; k++) expect((await i.api("POST", "/api/shares", { html: PAGE, title: `Filler ${k}` })).status).toBe(201);
  const slug = gated.json.slug as string;
  const pslug = pub.json.slug as string;
  for (let d = 0; d < 90; d++) {
    const day = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    i.fake.sqlite.prepare("INSERT INTO share_views (slug, day, views) VALUES (?, ?, ?), (?, ?, ?)").run(slug, day, 3, pslug, day, 5);
  }

  const calls: Call[] = [];
  const inst = instrument(i.fake.db as unknown as RawDb, i.fake.bucket as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>, calls);
  i.env.DB = inst.db;
  i.env.BODIES = inst.bucket;

  const NAV = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" };
  const routes: [string, () => Promise<{ status: number }>, (() => Promise<unknown>)?][] = [
    ["GET / (Author home)", () => call("/", { as: AUTHOR, headers: NAV })],
    ["GET / (Viewer)", () => call("/", { as: VIEWER, headers: NAV })],
    ["GET /metrics", () => call("/metrics", { as: AUTHOR, headers: NAV })],
    ["GET /tokens", () => call("/tokens", { as: AUTHOR, headers: NAV })],
    ["GET /s/<slug> (Gated page)", () => call(`/s/${slug}`, { as: AUTHOR, headers: NAV })],
    ["GET /s/<slug>/raw (Gated body)", () => call(`/s/${slug}/raw`, { as: AUTHOR })],
    ["GET /p/<slug> (Public page)", () => call(`/p/${pslug}`, { headers: NAV })],
    ["GET /p/<slug>/raw (Public body)", () => call(`/p/${pslug}/raw`)],
    ["GET /p/<missing> (not found)", () => call("/p/zzzzzzzzzzzz", { headers: NAV })],
    ["GET /api/shares (list)", () => api("GET", "/api/shares")],
    ["GET /api/shares/<slug>", () => api("GET", `/api/shares/${slug}`)],
    ["GET /api/shares/<slug>/versions", () => api("GET", `/api/shares/${slug}/versions`)],
    ["POST /api/shares (publish html)", () => api("POST", "/api/shares", { html: PAGE, title: "New" })],
    ["PUT /api/shares/<slug> (new Version)", () => api("PUT", `/api/shares/${slug}`, { html: PAGE + "x" })],
    ["PATCH /api/shares/<slug>", () => api("PATCH", `/api/shares/${slug}`, { title: "Renamed" })],
    ["POST /api/shares/<slug>/visibility", () => api("POST", `/api/shares/${pslug}/visibility`, { public: true })],
  ];

  // `call` and `api` from the harness settle background work before they return; this measures the response itself.
  let answered = 0;
  async function call(path: string, init: RequestInit & { as?: string } = {}) {
    const headers = new Headers(init.headers);
    if (init.as) headers.set("cf-access-jwt-assertion", await i.jwt(init.as));
    const { as: _as, ...rest } = init;
    const worker = (await import("../../src/index")).default;
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await worker.fetch!(new Request(i.HOST + path, { ...rest, headers, redirect: "manual" }) as never, i.env, ctx);
    await res.arrayBuffer();
    answered = performance.now();
    while (pending.length) await Promise.allSettled(pending.splice(0));
    return res;
  }
  const pending: Promise<unknown>[] = [];
  async function api(method: string, path: string, body?: unknown) {
    return call(path, { method, headers: { authorization: `Bearer ${i.token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  }

  for (const [route, go] of routes) {
    // Both tokens' last use is recorded at most once a minute; a fresh minute for each route keeps the count honest.
    i.fake.sqlite.prepare("UPDATE tokens SET last_used_at = NULL").run();
    calls.length = 0;
    const res = await go();
    const critical = calls.filter((c) => c.end <= answered);
    const d1 = critical.filter((c) => c.kind === "d1");
    rows.push({
      route, status: res.status, d1Waves: waves(d1), d1Calls: d1.length, r2Waves: waves(critical.filter((c) => c.kind === "r2")),
      background: calls.length - critical.length, sql: d1.flatMap((c) => c.sql.map((s) => `${c.what}: ${s.replace(/\s+/g, " ").trim()}`)),
    });
    for (const c of calls) for (const s of c.sql) statements.add(s);
    expect(res.status).toBeLessThan(500);
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

  writeFileSync("docs/perf/raw/d1-roundtrips.json", JSON.stringify({ latencyMs: LATENCY_MS, sizes, rows, plans }, null, 2) + "\n");
  const md = [
    `Simulated latency per call: ${LATENCY_MS} ms. Table sizes: ${Object.entries(sizes).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    "",
    "| route | status | D1 waves (critical) | D1 calls (critical) | R2 waves (critical) | background calls |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.route} | ${r.status} | ${r.d1Waves} | ${r.d1Calls} | ${r.r2Waves} | ${r.background} |`),
    "",
    "| statement | plan |",
    "|---|---|",
    ...plans.map((p) => `| \`${p.sql.slice(0, 160).replace(/\|/g, "\\|")}${p.sql.length > 160 ? "…" : ""}\` | ${p.plan.replace(/\|/g, "\\|")} |`),
  ].join("\n");
  writeFileSync("docs/perf/raw/d1-roundtrips.md", md + "\n");
  console.log(md);
});
