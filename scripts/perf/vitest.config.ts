// The perf counters (scripts/perf/*.perf.ts): the Worker in-process, no wrangler dev, so no global setup.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["scripts/perf/**/*.perf.ts"], testTimeout: 120_000 },
});
