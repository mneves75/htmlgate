#!/usr/bin/env node
// Reads the counted pages from Workers Analytics Engine with the Operator's own `cf` login and stores the snapshot on
// the Instance, where /metrics shows it as an HTML report. A Worker writes Analytics Engine and cannot read it, so the
// read happens here, with a login that never reaches the Worker: nothing is stored on the Instance except the counts.
//
// Usage: pnpm run metrics:sync [--config <instance.json>] [--url <instance-url>] [--origin <site-url>]
//                              [--dataset <name>] [--days <n>] [--token <token>]
//   HTMLGATE_TOKEN  the Instance token, when --token is not given.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatedConfig, readInstance } from "./setup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CF = process.env.CF ?? "cf";

const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const fail = (message) => {
  console.error(`Metrics sync failed: ${message}`);
  process.exitCode = 1;
};

/** The Instance URL from --url, else from the config's domain, else from the generated wrangler config's workers.dev name. */
function instanceUrl() {
  const given = arg("--url");
  if (given) return new URL(given).origin;
  const config = resolve(ROOT, arg("--config") ?? "instance.json");
  const inst = readInstance(config);
  if (inst.domain) return `https://${inst.domain}`;
  const generated = readFileSync(generatedConfig(inst), "utf8");
  const name = /"name":\s*"([^"]+)"/.exec(generated)?.[1];
  if (!name) throw new Error(`${generated} names no Worker.`);
  return `https://${name}.workers.dev`;
}

/** The dataset's rows, read the same way README documents: one row per view, summed here. */
function readCounts({ dataset, days }) {
  const sql = `SELECT blob1 AS page, SUM(_sample_interval) AS views, MAX(timestamp) AS last_seen ` +
    `FROM ${dataset} WHERE timestamp > NOW() - INTERVAL '${days}' DAY GROUP BY page ORDER BY views DESC`;
  const out = execFileSync(CF, ["analytics_engine", "sql", "query", "--body", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(out);
  const rows = Array.isArray(parsed.data) ? parsed.data : [];
  return rows.map((row) => {
    // Analytics Engine prints a UTC timestamp without a zone; it is UTC.
    const seen = String(row.last_seen ?? "").replace(" ", "T");
    return { page: String(row.page ?? ""), views: Number(row.views ?? 0), last_seen: Date.parse(seen.endsWith("Z") ? seen : seen + "Z") };
  });
}

async function main() {
  const dataset = arg("--dataset") ?? "htmlgate_site_page_views";
  const origin = arg("--origin") ?? "https://htmlgate.com";
  const days = Number(arg("--days") ?? 30);
  if (!Number.isSafeInteger(days) || days < 1 || days > 90) return fail("--days must be from 1 to 90.");
  const token = arg("--token") ?? process.env.HTMLGATE_TOKEN;
  if (!token) return fail("no token: pass --token or set HTMLGATE_TOKEN to this Instance's token.");
  let url;
  try {
    url = instanceUrl();
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  const pages = readCounts({ dataset, days });
  const response = await fetch(`${url}/api/metrics`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ origin: new URL(origin).origin, generated_at: Date.now(), pages }),
  });
  const body = await response.text();
  if (!response.ok || response.status !== 200) return fail(`the Instance answered ${response.status}: ${body.slice(0, 300)}`);

  const width = Math.max(4, ...pages.map((p) => p.page.length));
  console.log(`${dataset}, last ${days} days → ${url}/metrics`);
  for (const p of pages) console.log(`  ${p.page.padEnd(width)}  ${String(p.views).padStart(5)} views`);
  if (!pages.length) console.log("  (no views yet: the counter needs a browser navigation)");
}

await main();
