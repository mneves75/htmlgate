// Reviewer test for claim 7: "an interrupt restores source and exits 130" (scripts/mutate.mjs).
// test/mutation-gate.test.ts calls the signal handler from inside a mocked spawnSync, which real Node never does. Here the
// real script runs as a real process in a throwaway directory (a copy of the script, the real src/api.ts as the file it
// plants into, and a fake `vitest` that takes two seconds and writes a valid CAUGHT report), and a real signal is sent.
// Nothing in the repository is planted or touched.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const REPO = join(__dirname, "..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-mutate-"));
  dirs.push(dir);
  for (const d of ["scripts", "src", "node_modules/.bin"]) mkdirSync(join(dir, d), { recursive: true });
  copyFileSync(join(REPO, "scripts/mutate.mjs"), join(dir, "scripts/mutate.mjs"));
  copyFileSync(join(REPO, "scripts/mutation-reporter.mjs"), join(dir, "scripts/mutation-reporter.mjs"));
  copyFileSync(join(REPO, "src/api.ts"), join(dir, "src/api.ts"));
  writeFileSync(join(dir, "node_modules/.bin/tsc"), "#!/bin/sh\nexit 0\n");
  // Fake vitest: log whether src/api.ts is planted, take two seconds, then report an assertion failure (a CAUGHT).
  writeFileSync(
    join(dir, "node_modules/.bin/vitest"),
    `#!/usr/bin/env node
const fs = require("fs");
const planted = fs.readFileSync("src/api.ts", "utf8") !== fs.readFileSync(process.env.ORIGINAL, "utf8");
fs.appendFileSync("runs.log", process.argv[3] + " planted=" + planted + "\\n");
setTimeout(() => {
  fs.writeFileSync(process.env.HTMLGATE_MUTATION_REPORT, JSON.stringify({ reason: "failed", errors: [], modules: [{ name: process.argv[3], state: "failed", errors: [], suites: [],
    tests: [{ name: "t", state: "failed", errors: [{ name: "AssertionError", message: "x" }] }] }] }));
  fs.writeFileSync(process.env.HTMLGATE_MUTATION_TEARDOWN, "complete");
  process.exit(1);
}, 2000);
`,
  );
  chmodSync(join(dir, "node_modules/.bin/vitest"), 0o755);
  chmodSync(join(dir, "node_modules/.bin/tsc"), 0o755);
  return dir;
}

async function run(signal: NodeJS.Signals, target: "parent" | "group") {
  const dir = fixture();
  const original = join(dir, "original-api.ts");
  copyFileSync(join(dir, "src/api.ts"), original);
  // `--only limit` selects two mutations, both in src/api.ts.
  const child = spawn("node", ["scripts/mutate.mjs", "--only", "limit"], { cwd: dir, detached: true, env: { ...process.env, ORIGINAL: original }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.on("exit", (code, sig) => r({ code, signal: sig })));
  // Wait until the first violation is planted (the fake vitest logged its start), then interrupt.
  for (let n = 0; n < 100 && !existsSync(join(dir, "runs.log")); n++) await new Promise((r) => setTimeout(r, 50));
  expect(readFileSync(join(dir, "runs.log"), "utf8")).toContain("planted=true");
  const started = Date.now();
  process.kill(target === "group" ? -child.pid! : child.pid!, signal);
  const result = await exited;
  console.log(`${signal} to ${target}: exit ${result.code}/${result.signal} after ${Date.now() - started} ms; output: ${JSON.stringify(out.slice(0, 400))}`);
  return {
    ...result, out, elapsed: Date.now() - started,
    restored: readFileSync(join(dir, "src/api.ts"), "utf8") === readFileSync(original, "utf8"),
    runs: readFileSync(join(dir, "runs.log"), "utf8").trim().split("\n"),
  };
}

describe("scripts/mutate.mjs when a real signal arrives", () => {
  test("Ctrl-C (SIGINT to the whole process group, as a terminal sends it): source restored, 'Interrupted', exit 130, nothing else planted", async () => {
    const r = await run("SIGINT", "group");
    expect(r.restored).toBe(true);
    expect(r.runs.length).toBe(1);
    expect(r.out).toContain("Interrupted");
    expect(r.code).toBe(130);
  }, 30_000);

  test("SIGTERM to the script alone (a kill, a CI cancel): source restored, 'Interrupted', exit 130, the second mutation is never planted", async () => {
    const r = await run("SIGTERM", "parent");
    expect(r.restored).toBe(true);
    expect(r.runs.length).toBe(1);
    expect(r.out).toContain("Interrupted");
    expect(r.code).toBe(130);
  }, 30_000);
});
