import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/global-setup.ts"],
    include: ["test/**/*.test.ts"],
    // One Instance serves every file; files run one after another so their writes do not interleave.
    fileParallelism: false,
    // Every test drives the real Worker under wrangler dev. On a shared host whose load swings from under 10
    // to over 900 (2026-10-09), single requests took seconds and plain tests hit 30 s with no assertion
    // failing. Timing is the benchmark's job (pnpm run bench); here a timeout should mean a hang.
    testTimeout: 90_000,
    hookTimeout: 120_000,
  },
});
