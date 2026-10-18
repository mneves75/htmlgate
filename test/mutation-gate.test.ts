// Execute the actual mutator with disposable process/filesystem controls: runner failures
// must never certify a security violation, and every path must restore the planted source.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript-classic";
import { expect, test } from "vitest";

const root = process.cwd();
const loadScript = (file: string, require: (name: string) => unknown, process: unknown, console: unknown) => {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2024 },
  }).outputText;
  runInNewContext(code, { module, exports: module.exports, require, process, console, Buffer, setImmediate });
  return module.exports;
};

async function mutationRun(outcome: string, check = false) {
  const files = new Map<string, string>();
  const lines: string[] = [];
  let exit = -1;
  let builds = 0;
  let sequence = 0;
  const stopped = {};
  let finished!: () => void;
  const done = new Promise<void>((r) => { finished = r; });
  // A real exit stops the script where it stands. The stand-in throws to do the same while the script loads; once
  // the run is under way its exit is the script's last statement, and a throw there would only be an unhandled rejection.
  let loading = true;
  const handlers = new Map<string, () => void>();
  const fs = {
    readFileSync: (file: string) => files.get(file) ?? readFileSync(join(root, file), "utf8"),
    writeFileSync: (file: string, value: string) => files.set(file, value),
    mkdtempSync: () => `/tmp/mutation-control-${++sequence}`,
    rmSync: (dir: string) => { for (const key of files.keys()) if (key.startsWith(dir + "/")) files.delete(key); },
  };
  const require = (name: string): unknown => {
    if (name === "node:fs") return fs;
    if (name === "node:os") return { tmpdir: () => "/tmp" };
    if (name === "node:path") return { join };
    if (name === "./mutation-reporter.mjs") return loadScript("scripts/mutation-reporter.mjs", require, {}, {});
    if (name === "node:child_process") return {
      execFileSync: (file: string, _args: string[], options: { env?: Record<string, string> }) => {
        if (!file.endsWith("tsc")) throw new Error("unexpected synchronous command");
        builds++; return Buffer.from("");
      },
      spawnSync: (_file: string, _args: string[], options: { env?: Record<string, string> }) => {
        const path = options.env?.HTMLGATE_MUTATION_REPORT;
        const errors = ["assertion", "teardown", "late-close"].includes(outcome) ? [{ name: "AssertionError", message: "expected sandbox" }]
          : outcome === "timeout" ? [{ name: "Error", message: "Test timed out in 30000ms" }] : [];
        if (outcome === "interrupt") handlers.get("SIGINT")?.();
        if (path && outcome !== "missing" && outcome !== "signal" && outcome !== "interrupt") fs.writeFileSync(path, outcome === "malformed" ? "bad JSON" : JSON.stringify({
          reason: outcome === "green" ? "passed" : "failed", errors: outcome === "unhandled" ? [{ name: "Error", message: "unhandled" }] : [],
          modules: [{ name: "test/viewer.test.ts", state: outcome === "green" ? "passed" : "failed", errors: [], suites: [], tests: [
            { name: "the Share sandbox", state: outcome === "green" ? "passed" : "failed", errors },
          ] }],
        }));
        const teardown = options.env?.HTMLGATE_MUTATION_TEARDOWN;
        if (teardown && outcome !== "teardown") fs.writeFileSync(teardown, "complete");
        return { status: outcome === "green" ? 0 : outcome === "signal" || outcome === "interrupt" ? null : 1, signal: outcome === "signal" ? "SIGKILL" : outcome === "interrupt" ? "SIGINT" : null, stderr: outcome === "late-close" ? "error during close" : "" };
      },
    };
    throw new Error(`Unexpected import: ${name}`);
  };
  try { loadScript("scripts/mutate.mjs", require, {
    argv: ["node", "scripts/mutate.mjs", "--only", "shares lose the sandbox header", ...(check ? ["--check"] : [])], env: {},
    exit: (code: number) => { exit = code; finished(); if (loading) throw stopped; },
    on: (signal: string, handler: () => void) => void handlers.set(signal, handler),
    set exitCode(code: number) { exit = code; },
  }, { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) });
  } catch (error) { if (error !== stopped) throw error; } finally { loading = false; }
  // The run ends in a later turn; its exit throws inside the script's own promise, which the script reports.
  await done;
  return { exit, lines: lines.join("\n"), builds, files, handlers };
}

test.each(["timeout", "missing", "malformed", "unhandled", "signal", "teardown", "late-close"])("a %s runner failure is BROKEN, never caught", async (failure) => {
  const r = await mutationRun(failure);
  expect(r.exit).toBe(1);
  expect(r.lines).toContain("BROKEN");
  expect(r.lines).not.toContain("CAUGHT");
  expect(r.files.get("src/index.ts")).toBe(readFileSync(join(root, "src/index.ts"), "utf8"));
  expect(r.builds).toBe(1);
});

test("a real assertion is caught with its test name, while green is missed", async () => {
  const caught = await mutationRun("assertion");
  expect(caught.exit).toBe(0);
  expect(caught.lines).toContain("CAUGHT");
  expect(caught.lines).toContain("the Share sandbox");
  const missed = await mutationRun("green");
  expect(missed.exit).toBe(1);
  expect(missed.lines).toContain("MISSED");
});

test("anchor preflight never plants source or starts a runner", async () => {
  const r = await mutationRun("assertion", true);
  expect(r.exit).toBe(0);
  expect(r.lines).toContain("Verified 1 unique mutation anchors");
  expect(r.files.size).toBe(0);
  expect(r.builds).toBe(0);
});

test("an interrupt restores the planted source, rebuilds the CLI and exits 130", async () => {
  const r = await mutationRun("interrupt");
  expect([...r.handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
  expect(r.files.get("src/index.ts")).toBe(readFileSync(join(root, "src/index.ts"), "utf8"));
  expect(r.builds).toBe(1);
  expect(r.lines).toContain("Interrupted");
  expect(r.lines).not.toContain("CAUGHT");
  expect(r.exit).toBe(130);
});

test("installer mutation controls cannot be made conditional on release tags", () => {
  const installer = readFileSync(join(root, "test/cli-brew.test.ts"), "utf8");
  expect(installer).not.toMatch(/\b(?:test|it|describe)\.(?:skip|skipIf|runIf|todo)\b/);
  const tags = readFileSync(join(root, "test/cli-release-tags.test.ts"), "utf8");
  expect(tags).toContain('test.skipIf(formulaDecision === "skip")');
  expect(tags).toContain('test.skipIf(packageDecision === "skip")');
  const mutator = readFileSync(join(root, "scripts/mutate.mjs"), "utf8");
  expect(mutator).not.toContain('"test/cli-release-tags.test.ts"');
});
