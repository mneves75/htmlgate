// Page-load benchmark in headless Chrome, the same way every run: one seeded Share of a fixed size, WARMUP loads,
// then RUNS measured loads per page; the verdict is each page's p95 load (navigation start to the load event,
// the Share's frame included) against BUDGET_MS.
//   pnpm run bench                     every page, against the real Worker under `wrangler dev` (local D1 and R2,
//                                      the stand-in Access certs from the tests)
//   pnpm run bench --live <url>        a deployed Instance's pages that need no sign-in (a Public Share's page and
//                                      body, not-found); needs HTMLGATE_TOKEN, and deletes its Share afterwards
//   pnpm run bench --site <url>        a deployed landing's two pages (the local run measures them too)
// Load on the host only slows pages down, so a pass on a busy host still counts; a page over budget while the
// 1-minute load average reached MAX_LOAD proves nothing either way. Exits 0 when every page's p95 is under
// BUDGET_MS, 1 when one is not on a quiet host, 2 when one is not but the host was busy.
import { execFile } from "node:child_process";
import { loadavg } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { importJWK, SignJWT } from "jose";
import { writeZip } from "../packages/cli/src/zip.ts";
import { SLUG } from "../src/ids.ts";
import { AUD, AUTHOR, settings, startCerts, startInstance, startSite } from "../test/global-setup.ts";

const run = promisify(execFile);
const BIN = join(process.cwd(), "node_modules/.bin/agent-browser");
const SESSION = `htmlgate-bench-${process.pid}`;
const DEV_BUDGET_MS = 50;
// CI runs on macos-15: 3 cores, Chrome and workerd on the same CPU as the pages they measure. The same page that
// loads in 20-30 ms on the 18-core dev machine lands near 2x there, which is the runner, not the page. CI therefore
// measures against a runner-class allowance: it still catches a real regression, and local and --live runs keep the
// dev-machine target. HTMLGATE_BENCH_BUDGET_MS overrides either.
const CI_BUDGET_MS = 150;
// An override is a person typing a number, so it is validated: without this, a typo becomes NaN, every `p95 >= NaN`
// comparison is false, and the page budget passes without measuring anything.
const override = Number(process.env.HTMLGATE_BENCH_BUDGET_MS ?? "");
const BUDGET_MS = Number.isFinite(override) && override > 0 ? override : process.env.CI === "1" ? CI_BUDGET_MS : DEV_BUDGET_MS;
const WARMUP = 10;
const MAX_LOAD = 9;
let peakLoad = 0;
const sampleLoad = () => (peakLoad = Math.max(peakLoad, loadavg()[0]!));
const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const RUNS = Number(arg("--runs") ?? 20);
const LIVE = arg("--live");
// A deployed Instance may sit behind a rate limiting rule as strict as 20 requests per 10 s per IP on /p/, /f/ and
// /api/ (docs/operator.md). Under --live each request holds the next one back GAP_MS, and a page load, its page and its
// framed body, holds it back twice that, so no 10 s holds more than 18 requests. Local runs do not wait.
const GAP_MS = LIVE ? Number(process.env.HTMLGATE_LIVE_GAP_MS ?? 600) : 0;
let next = 0;
async function pace(requests: number) {
  const wait = next - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  next = Date.now() + requests * GAP_MS;
}
/** fetch, paced like every other request a benchmark sends. */
async function send(url: string, init: RequestInit): Promise<Response> {
  await pace(1);
  return fetch(url, init);
}
const SITE = arg("--site");
const LANDING: [string, string, number][] = [["landing (pt-BR)", "/", 200], ["landing (en-US)", "/en/", 200]];

const ab = async (...args: string[]) => (await run(BIN, ["--session", SESSION, ...args], { timeout: 30_000 })).stdout.trim();

/** A Share of the kind the Instance is for: a self-contained report with inline styles, about 40 KB. */
function sampleShare(): string {
  const rows = Array.from({ length: 300 }, (_, i) => `<tr><td>${i}</td><td>item ${i}</td><td>${(i * 37) % 1000}</td><td>ok</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Report</title><style>body{font:16px system-ui;margin:2rem}table{border-collapse:collapse}td{padding:4px 8px;border:1px solid #ccc}</style></head><body><h1>Weekly report</h1><p>${"Lorem ipsum dolor sit amet. ".repeat(40)}</p><table>${rows}</table></body></html>`;
}

/** The created Share's slug, checked: the cleanup later puts it in a URL. */
async function createdSlug(r: Response, what: string): Promise<string> {
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status}`);
  const value: unknown = await r.json();
  if (typeof value !== "object" || value === null || !("slug" in value) || typeof value.slug !== "string" || !SLUG.test(value.slug)) {
    throw new Error(`${what}: invalid slug in the created Share response`);
  }
  return value.slug;
}

/** The sample Share as a site: its index page and the stylesheet it loads, from a zip. */
function sampleSite(): Uint8Array {
  const html = sampleShare().replace(/<style>[^<]*<\/style>/, '<link rel="stylesheet" href="css/report.css">');
  const css = "body{font:16px system-ui;margin:2rem}table{border-collapse:collapse}td{padding:4px 8px;border:1px solid #ccc}";
  return writeZip([{ path: "index.html", data: new TextEncoder().encode(html) }, { path: "css/report.css", data: new TextEncoder().encode(css) }]);
}

/** Publishes the sample site as a Public Share and returns its slug. */
async function publishSite(base: string, token: string): Promise<string> {
  const headers = { authorization: `Bearer ${token}` };
  const r = await send(`${base}/api/shares?title=Weekly%20report`, { method: "POST", headers: { ...headers, "content-type": "application/zip" }, redirect: "manual", body: sampleSite() });
  const slug = await createdSlug(r, "publish site");
  const v = await send(`${base}/api/shares/${slug}/visibility`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, redirect: "manual", body: JSON.stringify({ public: true }) });
  if (!v.ok) throw new Error(`visibility: HTTP ${v.status}`);
  return slug;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

/** Publishes the sample Share with an API token and returns its slug. */
async function publish(base: string, token: string, makePublic: boolean, created: (slug: string) => void = () => {}): Promise<string> {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const r = await send(`${base}/api/shares`, { method: "POST", headers, redirect: "manual", body: JSON.stringify({ html: sampleShare(), title: "Weekly report" }) });
  const slug = await createdSlug(r, "publish");
  created(slug);
  if (makePublic) {
    const v = await send(`${base}/api/shares/${slug}/visibility`, { method: "POST", headers, redirect: "manual", body: JSON.stringify({ public: true }) });
    if (!v.ok) throw new Error(`visibility: HTTP ${v.status}`);
  }
  return slug;
}

/**
 * Loads each page WARMUP + RUNS times and prints one line per page. Returns how many are over budget; a page that
 * answers another status than it should is an error, whatever the load: a fast error page is not a fast page.
 */
async function measure(base: string, pages: [string, string, number][], headers: Record<string, string>, where: string): Promise<number> {
  await ab("open", "about:blank");
  if (Object.keys(headers).length) await ab("set", "headers", JSON.stringify(headers));
  const nav = async (path: string) => {
    await pace(2);
    await ab("open", base + path);
    const t: unknown = JSON.parse(JSON.parse(await ab("eval", "JSON.stringify(performance.getEntriesByType('navigation')[0])")));
    if (typeof t !== "object" || t === null ||
        !("responseStart" in t) || typeof t.responseStart !== "number" ||
        !("loadEventEnd" in t) || typeof t.loadEventEnd !== "number" ||
        !("responseStatus" in t) || typeof t.responseStatus !== "number" ||
        !("startTime" in t) || typeof t.startTime !== "number" ||
        ![t.responseStart, t.loadEventEnd, t.startTime].every(Number.isFinite) ||
        t.startTime < 0 || t.responseStart < t.startTime || t.loadEventEnd <= t.startTime || t.loadEventEnd < t.responseStart ||
        !Number.isInteger(t.responseStatus) || t.responseStatus < 100 || t.responseStatus > 599) {
      throw new Error(`${path}: invalid or incomplete navigation timing: nothing to measure.`);
    }
    return { ttfb: t.responseStart - t.startTime, load: t.loadEventEnd - t.startTime, status: t.responseStatus };
  };
  const rows: string[] = [];
  let over = 0;
  for (const [name, path, expected] of pages) {
    sampleLoad();
    for (let i = 0; i < WARMUP; i++) await nav(path);
    const ttfb: number[] = [];
    const load: number[] = [];
    let status = 0;
    for (let i = 0; i < RUNS; i++) {
      const m = await nav(path);
      if (m.status !== expected) throw new Error(`${name} (${path}) answered ${m.status}, not ${expected}: nothing to measure.`);
      ttfb.push(m.ttfb);
      load.push(m.load);
      status = m.status;
    }
    const p95 = pct(load, 95);
    if (p95 >= BUDGET_MS) over++;
    rows.push(`${name.padEnd(32)} ${String(status).padEnd(4)} ttfb p50 ${pct(ttfb, 50).toFixed(1).padStart(6)}  load p50 ${pct(load, 50).toFixed(1).padStart(6)}  p95 ${p95.toFixed(1).padStart(6)} ms${p95 >= BUDGET_MS ? "  OVER" : ""}`);
  }
  sampleLoad();
  console.log(`htmlgate page loads, ${RUNS} runs after ${WARMUP} warm-up, headless Chrome, ${where}, peak 1-minute load ${peakLoad.toFixed(1)}, budget ${BUDGET_MS} ms p95\n`);
  console.log(rows.join("\n"));
  return over;
}

async function local(): Promise<number> {
  const over = await instancePages();
  // Started only now, so it never shares the host with the Instance being measured.
  const site = await startSite();
  try {
    return over + (await measure(site.base, LANDING, {}, "the landing under wrangler dev --local"));
  } finally {
    await site.stop();
  }
}

async function instancePages(): Promise<number> {
  const certs = await startCerts();
  const instance = await startInstance(settings(certs.teamUrl));
  try {
    const key = await importJWK(certs.priv, "RS256");
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({ email: AUTHOR, type: "app" }).setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(certs.teamUrl).setAudience([AUD]).setIssuedAt(now).setNotBefore(now - 5).setExpirationTime(now + 3600).sign(key);
    const base = instance.base;
    const page = await send(`${base}/tokens`, {
      method: "POST",
      headers: { "cf-access-jwt-assertion": jwt, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
      body: "name=bench",
    });
    const token = /<code id="new-token">(hg_[A-Za-z0-9]{40})<\/code>/.exec(await page.text())?.[1];
    if (!token) throw new Error(`no token from the token page (HTTP ${page.status})`);
    const gated = await publish(base, token, false);
    const open = await publish(base, token, true);
    const site = await publishSite(base, token);
    // The Author's home lists up to 50 Shares: measure it full, and let the metrics report count them.
    for (let i = 0; i < 48; i++) await publish(base, token, false);
    return await measure(base, [
      ["home", "/", 200],
      ["tokens", "/tokens", 200],
      ["metrics", "/metrics", 200],
      ["viewer (gated, with its frame)", `/s/${gated}`, 200],
      ["raw (gated)", `/s/${gated}/raw`, 200],
      ["viewer (public, with its frame)", `/p/${open}`, 200],
      ["raw (public)", `/p/${open}/raw`, 200],
      ["site (public, index and stylesheet)", `/p/${site}/1/`, 200],
      ["not found", "/s/AAAAAAAAAAAA", 404],
    ], { "cf-access-jwt-assertion": jwt }, "wrangler dev --local");
  } finally {
    await instance.stop();
    await certs.close();
  }
}

async function live(url: string): Promise<number> {
  const target = new URL(url);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))) {
    throw new Error("--live requires HTTPS or loopback HTTP.");
  }
  if (target.username || target.password || target.search || target.hash || target.pathname !== "/") {
    throw new Error("--live requires an Instance origin without credentials, path, query or fragment.");
  }
  const base = target.origin;
  const token = process.env.HTMLGATE_TOKEN;
  if (!token) throw new Error("--live needs a token for that Instance in HTMLGATE_TOKEN.");
  let created: string | undefined;
  try {
    const slug = await publish(base, token, true, (slug) => { created = slug; });
    return await measure(base, [
      ["viewer (public, with its frame)", `/p/${slug}`, 200],
      ["raw (public)", `/p/${slug}/raw`, 200],
      ["not found", "/p/AAAAAAAAAAAA", 404],
    ], {}, base);
  } finally {
    if (created) {
      const removed = await send(`${base}/api/shares/${created}`, { method: "DELETE", redirect: "manual", headers: { authorization: `Bearer ${token}` } });
      if (removed.status !== 204) throw new Error(`cleanup ${created}: HTTP ${removed.status}`);
    }
  }
}

async function main() {
  try {
    const site = SITE && new URL(SITE).origin;
    const over = LIVE ? await live(LIVE) : site ? await measure(site, LANDING, {}, site) : await local();
    if (!over) {
      console.log(`\nEvery page loads under ${BUDGET_MS} ms (p95).`);
      process.exitCode = 0;
    } else if (peakLoad >= MAX_LOAD) {
      console.log(`\n${over} page(s) at or over ${BUDGET_MS} ms (p95), but the host was busy (load ${peakLoad.toFixed(1)}, ${MAX_LOAD} or more): no verdict. Run it again on a quieter host.`);
      process.exitCode = 2;
    } else {
      console.log(`\n${over} page(s) at or over ${BUDGET_MS} ms (p95).`);
      process.exitCode = 1;
    }
  } finally {
    await ab("close").catch(() => {});
  }
}

await main();
