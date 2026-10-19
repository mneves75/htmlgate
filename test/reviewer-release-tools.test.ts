// Execute the actual scripts with disposable fetch/browser controls, without starting a Worker or Chrome.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "htmlgate-release-controls-"));
const preload = join(dir, "controls.mjs");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Failure modes: unsafe token destination, redirect, malformed slug, failed visibility,
// failed measurement, failed DELETE, and a later cleanup failing after an earlier one did.
writeFileSync(preload, String.raw`
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const scenario = process.env.RELEASE_CONTROL;
const fixtures = new Map();
let next = 0;
let navigation = "";
let evaluations = 0;
let rawEvaluations = 0;
let stalled = false;
childProcess.execFile = (_bin, args, _opts, callback) => {
  const command = args[2];
  if (command === "open") {
    navigation = args[3];
    console.log("CONTROL " + JSON.stringify({ open: args[3], at: Date.now() }));
  }
  if (scenario === "measurement" && command === "eval") return callback(new Error("measurement failed"));
  const responseStatus = navigation.endsWith("AAAAAAAAAAAA") ? 404 : 200;
  const timing = { responseStart: 1, loadEventEnd: 2, responseStatus, startTime: 0 };
  // The response starts at navigation start, so only the load-event check can refuse this one.
  if (scenario === "incomplete-load") Object.assign(timing, { responseStart: 0, loadEventEnd: 0 });
  if (scenario === "missing-load") delete timing.loadEventEnd;
  if (scenario === "nonfinite-load") timing.loadEventEnd = Infinity;
  if (scenario === "unordered-timing") timing.responseStart = 3;
  if (scenario === "negative-start") timing.startTime = -1;
  if (scenario === "invalid-warmup-status" && command === "eval" && ++evaluations <= 3) timing.responseStatus = 0;
  // Chrome's first top-level loads of a sandboxed document in a session take about 40 ms more, for some seven loads;
  // "slow-page" is slow on every load. The warm-up must absorb the first and never hide the second.
  if (command === "eval" && navigation.endsWith("/raw")) {
    rawEvaluations++;
    if ((scenario === "cold-sandbox" && rawEvaluations <= 7) || scenario === "slow-page") timing.loadEventEnd = 60;
  }
  callback(null, command === "eval" ? JSON.stringify(JSON.stringify(timing)) : "", "");
};
childProcess.execFile[Symbol.for("nodejs.util.promisify.custom")] = (...args) => new Promise((resolve, reject) => {
  childProcess.execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
});
syncBuiltinESMExports();
const json = (body, status = 200) => Response.json(body, { status });
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(url);
  const path = target.pathname;
  const method = init.method ?? "GET";
  const authenticated = Boolean(init.headers?.authorization);
  console.log("CONTROL " + JSON.stringify({ path, method, authenticated, redirect: init.redirect ?? "follow", scheme: target.protocol, at: Date.now() }));
  if (!stalled && path === "/" && scenario === "hang-fetch") {
    stalled = true;
    const pending = (fail) => {
      const timer = setTimeout(() => fail(new Error("provider never completed")), 60_000);
      init.signal?.addEventListener("abort", () => { clearTimeout(timer); fail(init.signal.reason); }, { once: true });
    };
    return new Promise((_resolve, reject) => pending(reject));
  }
  if (!stalled && path === "/api/shares" && !authenticated && scenario === "hang-body") {
    stalled = true;
    return new Response(new ReadableStream({ start(controller) {
      const timer = setTimeout(() => controller.error(new Error("body never completed")), 60_000);
      init.signal?.addEventListener("abort", () => { clearTimeout(timer); controller.error(init.signal.reason); }, { once: true });
    } }), { status: 401 });
  }
  // Plain http as the Worker answers it; the "cleartext" control serves it like https instead.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if (target.protocol === "http:" && !loopback && scenario !== "cleartext") {
    if (path.startsWith("/api/")) return json({ error: { code: "https_required" } }, 403);
    return new Response(null, { status: 301, headers: { location: "https://" + target.hostname + path + target.search } });
  }
  if (authenticated && scenario === "redirect") {
    if (!init.redirect || init.redirect === "follow") {
      console.log("CONTROL " + JSON.stringify({ path: "/redirect-target", method, authenticated: true }));
    } else if (init.redirect === "error") throw new Error("redirect refused");
    return new Response(null, { status: 302, headers: { location: "https://other.example/redirect-target" } });
  }
  if (path === "/api/onboard") return json({ expiry: { default_days: 30 } });
  if (path === "/api/shares" && authenticated && method === "POST") {
    if (init.headers?.["content-type"] === "application/zip") {
      const slug = scenario === "slug" ? "../not-owned" : "ABCDEFGHIJK" + (++next);
      fixtures.set(slug, { zip: new Uint8Array(init.body), public: false });
      return json({ slug, public: false, url: target.origin + "/s/" + slug, expires_at: Number(target.searchParams.get("expires_at")) }, 201);
    }
    const body = JSON.parse(init.body);
    if (body.html.length > 2 * 1024 * 1024) return json({ error: { code: "html_too_large" } }, 413);
    const slug = scenario === "slug" ? "../not-owned" : "ABCDEFGHIJK" + (++next);
    fixtures.set(slug, { html: body.html, public: false });
    return json({ slug, public: false, url: target.origin + "/s/" + slug, expires_at: body.expires_at ?? Date.now() + 30 * 86_400_000 }, 201);
  }
  if (method === "PATCH") return json({ expires_at: JSON.parse(init.body).expires_at });
  if (path.endsWith("/versions/1/zip")) return new Response(fixtures.get(path.split("/")[3]).zip);
  if (path.startsWith("/f/")) return new Response("missing", { status: 404, headers: { "referrer-policy": "no-referrer" } });
  const file = /^\/p\/([^/]+)\/1\/(.*)$/.exec(path);
  if (file) {
    if (!fixtures.get(file[1])?.public) return new Response("missing", { status: 404 });
    return new Response(file[2] === "css/s.css" ? "p{color:rgb(1,2,3)}" : "site", { headers: {
      "content-security-policy": "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'",
      "cache-control": "no-store", "referrer-policy": "no-referrer",
    }});
  }
  const site = path.startsWith("/p/") && path.endsWith("/raw") && fixtures.get(path.split("/")[2]);
  if (site && site.zip && site.public) return new Response(null, { status: 303, headers: { location: "/p/" + path.split("/")[2] + "/1/" } });
  if (method === "DELETE") return new Response(null, { status: scenario === "delete" ? 503 : 204 });
  if (path.endsWith("/visibility")) {
    if (scenario === "visibility") return json({}, 503);
    const slug = path.split("/")[3];
    fixtures.get(slug).public = JSON.parse(init.body).public;
    return json({});
  }
  if (path.endsWith("/versions/1")) {
    const d = fixtures.get(path.split("/")[3]);
    return json({ html: d.html, size: d.html.length });
  }
  if (path === "/api/shares") return json({ error: { code: "unauthorized" } }, 401);
  if (path === "/" || path === "/tokens" || path.startsWith("/s/")) {
    const redirects = {
      "gate-path": "https://evil.example/team.cloudflareaccess.com/login",
      "gate-query": "https://evil.example/?next=https://team.cloudflareaccess.com/login",
      "gate-suffix": "https://team.cloudflareaccess.com.evil.example/login",
      "gate-http": "http://team.cloudflareaccess.com/login",
      "gate-credentials": "https://user:password@team.cloudflareaccess.com/login",
      "gate-port": "https://team.cloudflareaccess.com:8443/login",
      "gate-nested": "https://nested.team.cloudflareaccess.com/login",
      "gate-malformed": "not a URL",
    };
    return new Response(null, { status: 302, headers: { location: redirects[scenario] ?? "https://team.cloudflareaccess.com/login" } });
  }
  const d = path.startsWith("/p/") && fixtures.get(path.split("/")[2]);
  if (d && d.public) return new Response(path.endsWith("/raw") ? d.html : "viewer", { headers: {
    "content-security-policy": "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'",
    "cache-control": "no-store", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin",
  }});
  return new Response("missing", { status: 404 });
};
`);

interface Request { path: string; method: string; authenticated: boolean; redirect?: string; scheme?: string; open?: string; at: number }
// The tools pace themselves under the zone rate rule (docs/operator.md); the controls turn that off unless they test it.
async function execute(tool: "bench" | "smoke", scenario = "pass", url = "https://instance.example", paced = false, budget = "50") {
  const args = tool === "bench" ? ["scripts/bench.ts", "--live", url, "--runs", "1"] : ["scripts/smoke.mjs", url];
  const child = spawn(process.execPath, ["--import", preload, ...args], {
    ...(scenario.startsWith("hang-") ? { timeout: 25_000 } : {}),
    // Pin the budget: these controls assert on the verdict's wording and outcome, so they must measure the same
    // number on the 18-core dev machine (50 ms) and on CI's 3-core runner (150 ms).
    env: { ...process.env, HTMLGATE_TOKEN: "hg_disposable-control", RELEASE_CONTROL: scenario, HTMLGATE_BENCH_BUDGET_MS: budget, ...(paced ? {} : { HTMLGATE_LIVE_GAP_MS: "0" }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => { out += chunk; });
  child.stderr.on("data", (chunk: Buffer) => { err += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const requests = out.split("\n").filter((line) => line.startsWith("CONTROL "))
    .map((line) => JSON.parse(line.slice(8)) as Request);
  expect(out + err).not.toContain("hg_disposable-control");
  return { code, out, err, requests };
}

test.each(["https://instance.example", "http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"])(
  "benchmark accepts %s and deletes its fixture", async (url) => {
    const result = await execute("bench", "pass", url);
    expect(result.code, result.err).toBe(0);
    expect(result.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual(["/api/shares/ABCDEFGHIJK1"]);
  },
);

test.each([
  "http://remote.example", "http://127.0.0.1.remote.example", "ftp://instance.example", "https://user:password@instance.example",
  "https://instance.example/a-path", "https://instance.example/?query=1", "https://instance.example/#fragment",
])(
  "benchmark rejects %s before any fetch", async (url) => {
    const result = await execute("bench", "pass", url);
    expect(result.code).not.toBe(0);
    expect(result.requests).toEqual([]);
  },
);

test.each(["incomplete-load", "missing-load", "nonfinite-load", "unordered-timing", "negative-start", "invalid-warmup-status"])(
  "benchmark refuses %s navigation data before any speed verdict", async (scenario) => {
    const result = await execute("bench", scenario);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/invalid or incomplete navigation timing/);
    expect(result.out).not.toContain("Every page loads");
    expect(result.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual(["/api/shares/ABCDEFGHIJK1"]);
  },
);

test("benchmark warms each page up past a browser's slow first sandboxed loads", async () => {
  const result = await execute("bench", "cold-sandbox");
  expect(result.code, result.out + result.err).toBe(0);
  expect(result.out).toContain("Every page loads under 50 ms");
});

test("an invalid budget override falls back instead of passing without measuring", async () => {
  // NaN made every `p95 >= NaN` false, so a typo silently disabled the page budget.
  for (const budget of ["abc", "0", "-5"]) {
    const result = await execute("bench", "slow-page", "https://instance.example", false, budget);
    expect(result.code, `${budget}: ${result.out}${result.err}`).not.toBe(0);
    expect(result.out).toMatch(/raw \(public\).*OVER/);
    expect(result.out).toContain("budget 50 ms p95");
  }
});

test("benchmark still fails a page that is slow on every load", async () => {
  const result = await execute("bench", "slow-page");
  expect(result.code).not.toBe(0);
  expect(result.out).toMatch(/raw \(public\).*OVER/);
  expect(result.out).not.toContain("Every page loads");
});

test.each(["visibility", "measurement"])("benchmark cleans its created fixture after failed %s", async (failure) => {
  const result = await execute("bench", failure);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain(failure);
  expect(result.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual(["/api/shares/ABCDEFGHIJK1"]);
});

test.each(["bench", "smoke"] as const)("%s cannot pass when own fixture cleanup fails", async (tool) => {
  const result = await execute(tool, "delete");
  expect(result.code).toBe(1);
  expect(result.out + result.err).toMatch(/cleanup.*503/);
  expect(result.requests.filter((r) => r.method === "DELETE")).toHaveLength(tool === "bench" ? 1 : 4);
  expect(result.out).not.toMatch(/Every page loads|All \d+ live checks passed/);
});

test("smoke's positive control passes and cleans both fixtures", async () => {
  const result = await execute("smoke");
  expect(result.code, result.out + result.err).toBe(0);
  expect(result.requests.filter((r) => r.method === "DELETE").map((r) => r.path))
    .toEqual(["/api/shares/ABCDEFGHIJK1", "/api/shares/ABCDEFGHIJK2", "/api/shares/ABCDEFGHIJK3", "/api/shares/ABCDEFGHIJK4"]);
});

test.each(["gate-path", "gate-query", "gate-suffix", "gate-http", "gate-credentials", "gate-port", "gate-nested", "gate-malformed"])("smoke refuses the spoofed Access redirect %s", async (scenario) => {
  const r = await execute("smoke", scenario);
  expect(r.code, r.out + r.err).toBe(1);
  expect(r.out).toContain("FAIL  a signed-out request to a gated route");
  expect(r.requests.filter(v => v.method === "DELETE")).toHaveLength(4);
  expect(r.out).not.toMatch(/All \d+ live checks passed/);
});

test.each(["hang-fetch", "hang-body"])("smoke bounds %s and still completes cleanup", async (scenario) => {
  const start = Date.now();
  const r = await execute("smoke", scenario);
  expect(r.code, "the command must finish itself, before the fixture's process timeout").toBe(1);
  expect(Date.now() - start).toBeLessThan(20_000);
  expect(r.out).toMatch(/FAIL .*timeout|FAIL .*aborted/i);
  expect(r.requests.filter(v => v.method === "DELETE")).toHaveLength(4);
});

test("smoke checks plain http and never sends its token there", async () => {
  const result = await execute("smoke");
  expect(result.code, result.out + result.err).toBe(0);
  expect(result.out).toContain("PASS  plain http serves nothing");
  expect(result.requests.filter((r) => r.scheme === "http:").map((r) => r.path)).toEqual(["/p/AAAAAAAAAAAA", "/api/shares"]);
  expect(result.requests.filter((r) => r.authenticated).every((r) => r.scheme === "https:")).toBe(true);
});

test("smoke fails on an Instance that answers plain http", async () => {
  const result = await execute("smoke", "cleartext");
  expect(result.code).toBe(1);
  expect(result.out).toMatch(/FAIL  plain http serves nothing.*\/p\/AAAAAAAAAAAA over http answered 404/);
  expect(result.requests.filter((r) => r.method === "DELETE").map((r) => r.path))
    .toEqual(["/api/shares/ABCDEFGHIJK1", "/api/shares/ABCDEFGHIJK2", "/api/shares/ABCDEFGHIJK3", "/api/shares/ABCDEFGHIJK4"]);
});

test("smoke still cleans its fixtures after visibility fails", async () => {
  const result = await execute("smoke", "visibility");
  expect(result.code).toBe(1);
  expect(result.out).toContain("visibility on failed");
  expect(result.requests.filter((r) => r.method === "DELETE").map((r) => r.path))
    .toEqual(["/api/shares/ABCDEFGHIJK1", "/api/shares/ABCDEFGHIJK2", "/api/shares/ABCDEFGHIJK3", "/api/shares/ABCDEFGHIJK4"]);
});

test.each(["bench", "smoke"] as const)("%s refuses authenticated redirects", async (tool) => {
  const result = await execute(tool, "redirect");
  expect(result.code).not.toBe(0);
  const authenticated = result.requests.filter((r) => r.authenticated);
  expect(authenticated.length).toBeGreaterThan(0);
  expect(authenticated.every((r) => r.redirect === "manual" || r.redirect === "error")).toBe(true);
  expect(authenticated.some((r) => r.path === "/redirect-target")).toBe(false);
});

test.each(["bench", "smoke"] as const)("%s never cleans a malformed created slug", async (tool) => {
  const result = await execute(tool, "slug");
  expect(result.code).not.toBe(0);
  expect(result.out + result.err).toMatch(/invalid slug/i);
  expect(result.requests.some((r) => r.method === "DELETE")).toBe(false);
});

// A rate rule may allow as few as 20 requests per 10 s per IP on /p/, /f/ and /api/ (docs/operator.md). Unpaced, smoke sends its
// requests back to back and bench --live loads each page 30 times in seconds; both would be refused partway.
const gaps = (times: number[]) => times.slice(1).map((t, i) => t - times[i]!);

test("smoke keeps its requests at least 600 ms apart by default, so 20 per 10 s is never reached", async () => {
  const result = await execute("smoke", "pass", "https://instance.example", true);
  expect(result.code, result.out + result.err).toBe(0);
  const times = result.requests.filter((r) => r.path !== undefined).map((r) => r.at);
  expect(times.length).toBeGreaterThan(10);
  expect(Math.min(...gaps(times))).toBeGreaterThanOrEqual(595);
});

test("bench --live holds every request 600 ms after an API request and 1.2 s after a page load, its two requests", async () => {
  const result = await execute("bench", "pass", "https://instance.example", true);
  expect(result.code, result.out + result.err).toBe(0);
  const sent = result.requests.filter((r) => r.path !== undefined || r.open?.startsWith("https://instance.example/"));
  expect(sent.filter((r) => r.open).length).toBeGreaterThan(5);
  expect(sent.filter((r) => r.method === "POST").length).toBeGreaterThan(1);
  expect(sent.at(-1)?.method).toBe("DELETE");
  const tooSoon = sent.slice(1).filter((r, i) => r.at - sent[i]!.at < (sent[i]!.open ? 1195 : 595));
  expect(tooSoon).toEqual([]);
});
