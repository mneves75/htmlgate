import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["scripts/perf/**/*.perf.ts"], testTimeout: 120_000 },
});
