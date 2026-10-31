// L2 edge timings: user-perceived TTFB per URL from where this runs, the way a visitor's browser meets it.
// Each URL is fetched N times on a new connection (DNS, TCP, TLS and the first byte: one curl per request) and
// N times on one warm connection (one curl reusing its connection). Cache status comes from `cf-cache-status`
// and the data center from `cf-ray`, both written by Cloudflare, never by the Worker.
//
//   node scripts/perf/edge.mjs --base https://htmlgate.com --paths /,/en/ [--n 30] [--gap 300] [--out file.json]
//   node scripts/perf/edge.mjs --base A --base B ...    interleaves A and B request by request (ABAB);
//                                                       the same URL twice is the A/A noise run
//
// Traffic is tagged (User-Agent htmlgate-perf/1), paced (--gap ms between requests) and capped (--cap, default 1500):
// the run stops before the cap rather than send more. It sends GET only, never a write, and no Sec-Fetch-Dest, so
// the landing's page counts never see it. Needs curl 7.84 or later (%header{} write-out).
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
const UA = "htmlgate-perf/1 (+https://github.com/mneves75/htmlgate/tree/main/scripts/perf)";
const FORMAT = '%{json}\\n%header{cf-cache-status}|%header{cf-ray}|%header{age}\\n';

function args(argv) {
  const out = { bases: [], paths: [], n: 30, gap: 300, cap: 1500, out: undefined };
  for (let i = 0; i < argv.length; i += 2) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (v === undefined) throw new Error(`${k} needs a value`);
    if (k === "--base") out.bases.push(v.replace(/\/$/, ""));
    else if (k === "--paths") out.paths.push(...v.split(","));
    else if (k === "--n") out.n = positive(k, v);
    else if (k === "--gap") out.gap = Number(v);
    else if (k === "--cap") out.cap = positive(k, v);
    else if (k === "--out") out.out = v;
    else throw new Error(`unknown option ${k}`);
  }
  if (!out.bases.length || !out.paths.length) throw new Error("say --base and --paths");
  return out;
}
function positive(name, v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, not ${v}`);
  return n;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One curl process: `urls` on one connection when there are several. Returns one sample per URL. */
async function curl(urls) {
  const a = ["-sS", "-A", UA, "-H", "accept-encoding: br, gzip", "-o", "/dev/null", "-w", FORMAT];
  for (const [i, u] of urls.entries()) a.push(...(i ? ["--next", "-sS", "-A", UA, "-H", "accept-encoding: br, gzip", "-o", "/dev/null", "-w", FORMAT] : []), u);
  const { stdout } = await run("curl", a, { maxBuffer: 1 << 24 });
  const lines = stdout.trim().split("\n");
  const samples = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const j = JSON.parse(lines[i]);
    const [cache, ray, age] = lines[i + 1].split("|");
    samples.push({
      url: j.url_effective, status: j.http_code, http: j.http_version, connects: j.num_connects,
      dns: j.time_namelookup, connect: j.time_connect, tls: j.time_appconnect, ttfb: j.time_starttransfer, total: j.time_total,
      bytes: j.size_download, cache: cache || null, colo: ray?.split("-")[1] ?? null, age: age ? Number(age) : null,
    });
  }
  return samples;
}

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
}
export function summarize(samples) {
  const ms = samples.map((s) => s.ttfb * 1000).sort((a, b) => a - b);
  const count = (key) => Object.entries(samples.reduce((m, s) => ((m[s[key] ?? "-"] = (m[s[key] ?? "-"] ?? 0) + 1), m), {})).map(([k, v]) => `${k}:${v}`).join(" ");
  return { n: ms.length, p50: quantile(ms, 0.5), p95: quantile(ms, 0.95), iqr: quantile(ms, 0.75) - quantile(ms, 0.25), cache: count("cache"), colo: count("colo"), http: count("http"), status: count("status") };
}

async function main() {
  const o = args(process.argv.slice(2));
  let sent = 0;
  const take = (k) => {
    if (sent + k > o.cap) throw new Error(`request cap ${o.cap} reached after ${sent}; raise --cap deliberately`);
    sent += k;
  };
  const results = [];
  const started = new Date().toISOString();
  for (const path of o.paths) {
    const byBase = Object.fromEntries(o.bases.map((b, i) => [`${i}:${b}`, { cold: [], warm: [] }]));
    // New connections, interleaved base by base.
    for (let r = 0; r < o.n; r++) {
      for (const [i, b] of o.bases.entries()) {
        take(1);
        byBase[`${i}:${b}`].cold.push(...(await curl([b + path])));
        await sleep(o.gap);
      }
    }
    // One warm connection per base: the first request opens it and is dropped, the next N are measured.
    // Bases alternate in blocks of 5 so neither always runs first.
    for (let block = 0; block * 5 < o.n; block++) {
      for (const [i, b] of (block % 2 ? [...o.bases.entries()].reverse() : [...o.bases.entries()])) {
        const k = Math.min(5, o.n - block * 5);
        take(k + 1);
        const s = await curl(Array(k + 1).fill(b + path));
        byBase[`${i}:${b}`].warm.push(...s.slice(1));
        await sleep(o.gap * (k + 1));
      }
    }
    for (const [key, v] of Object.entries(byBase)) {
      const reused = v.warm.filter((s) => s.connects === 0).length;
      results.push({ base: key, path, cold: summarize(v.cold), warm: { ...summarize(v.warm), reused }, samples: v });
    }
  }
  const report = { started, finished: new Date().toISOString(), ua: UA, requests: sent, gapMs: o.gap, n: o.n, curl: (await run("curl", ["--version"])).stdout.split("\n")[0], results };
  if (o.out) writeFileSync(o.out, JSON.stringify(report, null, 2) + "\n");
  const f = (x) => x.toFixed(0);
  console.log("| base | path | new conn p50 / p95 / IQR ms | warm p50 / p95 / IQR ms | warm reused | cache (warm) | colos | http |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    console.log(`| ${r.base} | ${r.path} | ${f(r.cold.p50)} / ${f(r.cold.p95)} / ${f(r.cold.iqr)} | ${f(r.warm.p50)} / ${f(r.warm.p95)} / ${f(r.warm.iqr)} | ${r.warm.reused}/${r.warm.n} | ${r.warm.cache} | ${r.cold.colo} | ${r.cold.http} |`);
  }
  console.log(`requests sent: ${sent}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`edge: ${e.message}`);
    process.exit(1);
  });
}
