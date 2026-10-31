// The round-trip report: D1 and R2 waves per route and EXPLAIN QUERY PLAN per statement (scripts/perf/roundtrips.ts).
//
//   pnpm exec vitest run -c scripts/perf/vitest.config.ts       writes docs/perf/raw/d1-roundtrips.{json,md}
//   HTMLGATE_PERF_OUT=<dir> ...                                  writes there instead (a baseline/candidate pair)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { stopAccess } from "../../test/reviewer-beta10-harness";
import { measureRoutes } from "./roundtrips";

afterAll(async () => {
  await stopAccess();
});

test("round trips per route", async () => {
  const { latencyMs, sizes, rows, plans } = await measureRoutes();
  const dir = process.env.HTMLGATE_PERF_OUT ?? "docs/perf/raw";
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "d1-roundtrips.json"), JSON.stringify({ latencyMs, sizes, rows, plans }, null, 2) + "\n");
  const md = [
    `Simulated latency per call: ${latencyMs} ms. Table sizes: ${Object.entries(sizes).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    "",
    "| route | status | D1 waves (critical) | D1 calls (critical) | R2 waves (critical) | background calls |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.route} | ${r.status} | ${r.d1Waves} | ${r.d1Calls} | ${r.r2Waves} | ${r.background} |`),
    "",
    "| statement | plan |",
    "|---|---|",
    ...plans.map((p) => `| \`${p.sql.slice(0, 160).replace(/\|/g, "\\|")}${p.sql.length > 160 ? "…" : ""}\` | ${p.plan.replace(/\|/g, "\\|")} |`),
  ].join("\n");
  writeFileSync(join(dir, "d1-roundtrips.md"), md + "\n");
  console.log(md);
});
