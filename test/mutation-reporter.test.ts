// The installed Vitest, not mocked reporter objects: assertion, hook and runtime outcomes differ.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

// The last column: what a BROKEN result must keep of the failing test, so the gate's log names the cause.
test.each([
  ["assertion", "test('control', () => expect(1).toBe(2))", "CAUGHT", null],
  ["green", "test('control', () => expect(1).toBe(1))", "MISSED", null],
  ["skipped", "test.skip('control', () => expect(1).toBe(2))", "BROKEN", null],
  ["mixed-skipped", "test.skip('missing control', () => expect(1).toBe(2)); test('assertion control', () => expect(1).toBe(2))", "BROKEN", null],
  ["pending", "test.todo('missing control'); test('assertion control', () => expect(1).toBe(2))", "BROKEN", null],
  ["timeout", "test('control', () => new Promise(() => {}), 20)", "BROKEN", /Test timed out in 20ms/],
  ["runtime", "test('control', () => { const d = undefined as unknown as { slug: number }; expect(d.slug).toBe(1) })", "BROKEN", /TypeError/],
  ["hook", "beforeAll(() => { throw new Error('hook failed') }); test('control', () => expect(1).toBe(1))", "BROKEN", null],
  ["unhandled", "test('control', () => { Promise.reject(new Error('unhandled')); expect(1).toBe(1) })", "BROKEN", null],
  ["close-signal", "test('control', () => expect(1).toBe(2))", "BROKEN", null],
  ["close-error", "test('control', () => expect(1).toBe(2))", "BROKEN", null],
] as const)("the real reporter classifies %s", async (name, body, expected, keeps) => {
  mkdirSync(join(process.cwd(), ".scratch"), { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), ".scratch/reporter-control-"));
  const file = relative(process.cwd(), join(dir, `${name}.test.ts`));
  const reportFile = join(dir, "result.json");
  const config = join(dir, "vitest.config.mjs");
  try {
    writeFileSync(join(process.cwd(), file), `import { beforeAll, expect, test } from 'vitest';\n${body};\n`);
    const setup = join(dir, "setup.mjs");
    const closing = name.startsWith("close-");
    if (closing) writeFileSync(setup, name === "close-error" ? "export default () => () => { throw new Error('late close failure') };" : "export default () => () => { process.kill(process.pid, 'SIGTERM') };");
    writeFileSync(config, `export default { test: { include: [${JSON.stringify(file)}], reporters: ['./scripts/mutation-reporter.mjs'], teardownTimeout: 1000, ${closing ? `globalSetup: [${JSON.stringify(setup)}]` : ""} } };\n`);
    const result = await new Promise<{ status: number | null; signal: string | null; stderr: string }>((resolve) => {
      execFile(process.execPath, [join(process.cwd(), "node_modules/vitest/vitest.mjs"), "run", "--config", config], {
        env: { ...process.env, HTMLGATE_MUTATION_REPORT: reportFile },
      }, (error, _stdout, stderr) => {
        resolve({ status: error ? (typeof error.code === "number" ? error.code : null) : 0, signal: error && typeof error.signal === "string" ? error.signal : null, stderr });
      });
    });
    const module: unknown = await import(pathToFileURL(join(process.cwd(), "scripts/mutation-reporter.mjs")).href);
    if (typeof module !== "object" || module === null || !("classifyMutation" in module) || typeof module.classifyMutation !== "function") throw new Error("missing classifier");
    const report: unknown = JSON.parse(readFileSync(reportFile, "utf8"));
    const verdict: unknown = module.classifyMutation(report, result.status, result.signal, file, result.stderr);
    expect(verdict).toMatchObject({ state: expected });
    if (keeps) {
      // The reason stays as it was: logs are searched for it.
      expect(verdict).toMatchObject({ reason: "test timeout or runtime failure, not an assertion", failed: [{ name: "control" }] });
      expect(JSON.stringify(verdict)).toMatch(keeps);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
