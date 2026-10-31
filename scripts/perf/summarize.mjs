// Recomputes the published edge summaries from raw samples, stratified by data center (colo), so a comparison never
// mixes colos: pooled medians across GIG and MAO move by tens of milliseconds for reasons that are not the code.
//
//   node scripts/perf/summarize.mjs docs/perf/raw/<run>.json [--colo GIG]
import { readFileSync } from "node:fs";
import { quantile } from "./edge.mjs";

const [file, flag, colo] = process.argv.slice(2);
if (!file || (flag !== undefined && (flag !== "--colo" || !colo))) {
  console.error("usage: node scripts/perf/summarize.mjs <run.json> [--colo <IATA>]");
  process.exit(2);
}
const run = JSON.parse(readFileSync(file, "utf8"));
const ms = (samples) => samples.filter((s) => !colo || s.colo === colo).map((s) => s.ttfb * 1000).sort((a, b) => a - b);
const f = (x) => (Number.isFinite(x) ? x.toFixed(1) : "-");
console.log(`| arm | path | colo | warm n | warm p25 / p50 / p75 ms | new conn n | new conn p50 ms |`);
console.log(`|---|---|---|---|---|---|---|`);
for (const r of run.results) {
  const w = ms(r.samples.warm);
  const c = ms(r.samples.cold);
  console.log(`| ${r.base.split(":")[0]} | ${r.path} | ${colo ?? "all"} | ${w.length} | ${f(quantile(w, 0.25))} / ${f(quantile(w, 0.5))} / ${f(quantile(w, 0.75))} | ${c.length} | ${f(quantile(c, 0.5))} |`);
}
