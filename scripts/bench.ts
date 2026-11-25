import { execFile } from "node:child_process";
import { loadavg } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { importJWK, SignJWT } from "jose";
import { writeZip } from "../packages/cli/src/zip.ts";
import { SLUG } from "../src/ids.ts";
import { HOME_SHARES } from "../src/pages.ts";
import { AUD, AUTHOR, settings, startCerts, startInstance, startSite } from "../test/global-setup.ts";

const run = promisify(execFile);
const BIN = join(process.cwd(), "node_modules/.bin/agent-browser");
const SESSION = `htmlgate-bench-${process.pid}`;
const DEV_BUDGET_MS = 50;
const CI_BUDGET_MS = 150;
function parseFinite(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}
const BUDGET_MS = parseFinite(process.env.HTMLGATE_BENCH_BUDGET_MS, process.env.CI === "1" ? CI_BUDGET_MS : DEV_BUDGET_MS, Number.MIN_VALUE);
const WARMUP = 10;
const MAX_LOAD = 9;
let peakLoad = 0;
const sampleLoad = () => (peakLoad = Math.max(peakLoad, loadavg()[0]!));
const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const RUNS = Math.floor(parseFinite(arg("--runs"), 20, 1));
const LIVE = arg("--live");
const GAP_MS = LIVE ? parseFinite(process.env.HTMLGATE_LIVE_GAP_MS, 600, 0) : 0;
let next = 0;
async function pace(requests: number) {
  const wait = next - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  next = Date.now() + requests * GAP_MS;
}
async function send(url: string, init: RequestInit): Promise<Response> {
  await pace(1);
  return fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
}
const SITE = arg("--site");
const LANDING: [string, string, number][] = [["landing (pt-BR)", "/", 200], ["landing (en-US)", "/en/", 200]];

const { HTMLGATE_TOKEN: _t, CLOUDFLARE_API_TOKEN: _c, ...BROWSER_ENV } = process.env;
const ab = async (...args: string[]) => (await run(BIN, ["--session", SESSION, ...args], { timeout: 30_000, env: BROWSER_ENV })).stdout.trim();

function sampleShare(): string {
  const rows = Array.from({ length: 300 }, (_, i) => `<tr><td>${i}</td><td>item ${i}</td><td>${(i * 37) % 1000}</td><td>ok</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Report</title><style>body{font:16px system-ui;margin:2rem}table{border-collapse:collapse}td{padding:4px 8px;border:1px solid #ccc}</style></head><body><h1>Weekly report</h1><p>${"Lorem ipsum dolor sit amet. ".repeat(40)}</p><table>${rows}</table></body></html>`;
}

async function createdSlug(r: Response, what: string): Promise<string> {
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status}`);
  const value: unknown = await r.json();
  if (typeof value !== "object" || value === null || !("slug" in value) || typeof value.slug !== "string" || !SLUG.test(value.slug)) {
    throw new Error(`${what}: invalid slug in the created Share response`);
  }
  return value.slug;
}

function sampleSite(): Uint8Array {
  const html = sampleShare().replace(/<style>[^<]*<\/style>/, '<link rel="stylesheet" href="css/report.css">');
  const css = "body{font:16px system-ui;margin:2rem}table{border-collapse:collapse}td{padding:4px 8px;border:1px solid #ccc}";
  return writeZip([{ path: "index.html", data: new TextEncoder().encode(html) }, { path: "css/report.css", data: new TextEncoder().encode(css) }]);
}

async function publishSite(base: string, token: string, makePublic: boolean): Promise<string> {
  const headers = { authorization: `Bearer ${token}` };
  const r = await send(`${base}/api/shares?title=Weekly%20report`, { method: "POST", headers: { ...headers, "content-type": "application/zip" }, redirect: "manual", body: sampleSite() });
  const slug = await createdSlug(r, "publish site");
  if (makePublic) await makeSharePublic(base, token, slug);
  return slug;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

async function publish(base: string, token: string, makePublic: boolean, created: (slug: string) => void = () => {}, expiresAt?: number): Promise<string> {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const r = await send(`${base}/api/shares`, { method: "POST", headers, redirect: "manual", body: JSON.stringify({ html: sampleShare(), title: "Weekly report", ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}) }) });
  const slug = await createdSlug(r, "publish");
  created(slug);
  if (makePublic) await makeSharePublic(base, token, slug);
  return slug;
}

async function makeSharePublic(base: string, token: string, slug: string): Promise<void> {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const response = await send(`${base}/api/shares/${slug}/visibility`, {
    method: "POST", headers, redirect: "manual", body: JSON.stringify({ public: true }),
  });
  if (!response.ok) throw new Error(`visibility: HTTP ${response.status}`);
}

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
      redirect: "manual",
      headers: { "cf-access-jwt-assertion": jwt, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
      body: "name=bench",
    });
    const token = /<code id="new-token">(hg_[A-Za-z0-9]{40})<\/code>/.exec(await page.text())?.[1];
    if (!token) throw new Error(`no token from the token page (HTTP ${page.status})`);
    const gated = await publish(base, token, false);
    const open = await publish(base, token, true);
    const site = await publishSite(base, token, true);
    const gatedSite = await publishSite(base, token, false);
    for (let i = 0; i < HOME_SHARES - 4; i++) await publish(base, token, false);
    return await measure(base, [
      ["home", "/", 200],
      ["tokens", "/tokens", 200],
      ["metrics", "/metrics", 200],
      ["viewer (gated, with its frame)", `/s/${gated}`, 200],
      ["raw (gated)", `/s/${gated}/raw`, 200],
      ["viewer (public, with its frame)", `/p/${open}`, 200],
      ["raw (public)", `/p/${open}/raw`, 200],
      ["site (public, index and stylesheet)", `/p/${site}/1/`, 200],
      ["site (gated, viewer and stylesheet)", `/s/${gatedSite}`, 200],
      ["not found", "/s/AAAAAAAAAAAA", 404],
    ], { "cf-access-jwt-assertion": jwt }, "wrangler dev --local");
  } finally {
    await instance.stop();
    await certs.close();
  }
}

function parseOrigin(url: string, flag: string): string {
  const target = new URL(url);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))) {
    throw new Error(`${flag} requires HTTPS or loopback HTTP.`);
  }
  if (target.username || target.password || target.search || target.hash || target.pathname !== "/") {
    throw new Error(`${flag} requires an origin without credentials, path, query or fragment.`);
  }
  return target.origin;
}

async function live(url: string): Promise<number> {
  const base = parseOrigin(url, "--live");
  const token = process.env.HTMLGATE_TOKEN;
  if (!token) throw new Error("--live needs a token for that Instance in HTMLGATE_TOKEN.");
  let created: string | undefined;
  try {
    const slug = await publish(base, token, true, (slug) => { created = slug; }, Date.now() + 10 * 60 * 1000);
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
    const site = SITE && parseOrigin(SITE, "--site");
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
