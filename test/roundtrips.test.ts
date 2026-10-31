// Round trips to D1 on each route's critical path stay within docs/perf/budgets.json. From Brazil every sequential
// D1 wave costs about 170 ms (docs/perf/BASELINE.md), so one more wave on a route is a regression users feel.
// Counted on the real Worker in-process (scripts/perf/roundtrips.ts); no wrangler needed.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import { measureRoutes, waves, type Call } from "../scripts/perf/roundtrips";
import { stopAccess } from "./reviewer-beta10-harness";

const budgets = JSON.parse(readFileSync("docs/perf/budgets.json", "utf8")).passFail.d1WavesPerRoute as Record<string, unknown>;

afterAll(async () => {
  await stopAccess();
});

describe("the wave counter", () => {
  const c = (start: number, end: number): Call => ({ kind: "d1", what: "first", sql: [], start, end });
  test("counts overlapping calls as one wave and sequential ones apart", () => {
    expect(waves([])).toBe(0);
    expect(waves([c(0, 20), c(0, 21)])).toBe(1);
    expect(waves([c(0, 20), c(20, 40)])).toBe(2);
    expect(waves([c(0, 20), c(5, 25), c(30, 50)])).toBe(2);
    // A dependent chain stays three waves when an independent call spans it.
    expect(waves([c(0, 20), c(20, 40), c(40, 60), c(0, 55)])).toBe(3);
  });
});

describe("D1 round trips per route", () => {
  test("every route measured has a ceiling, and none is over it", async () => {
    const { rows } = await measureRoutes();
    const over: string[] = [];
    const unbudgeted: string[] = [];
    for (const r of rows) {
      const limit = budgets[r.key];
      if (typeof limit !== "number") {
        unbudgeted.push(r.key);
        continue;
      }
      if (r.d1Waves > limit) over.push(`${r.key}: ${r.d1Waves} waves, ceiling ${limit}\n  ${r.sql.join("\n  ")}`);
    }
    expect(unbudgeted).toEqual([]);
    expect(over).toEqual([]);
    // A Viewer's home reads nothing at all, not even in the background.
    const viewer = rows.find((r) => r.key === "GET / (Viewer)")!;
    expect({ critical: viewer.d1Calls, background: viewer.background }).toEqual({ critical: 0, background: 0 });
    const measured = new Set(rows.map((r) => r.key));
    const missing = Object.keys(budgets).filter((k) => k !== "note" && k !== "baseline" && !measured.has(k));
    expect(missing).toEqual([]);
  });
});
