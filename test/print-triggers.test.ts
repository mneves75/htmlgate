// Printing an Instance's triggers is local and read-only; it does not deploy anything.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
// @ts-expect-error plain JavaScript module
import { generatedConfig } from "../scripts/setup.mjs";

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), "htmlgate-print-triggers-"));
const script = join(process.cwd(), "scripts/print-triggers.mjs");
const base = { name: "print-triggers-test", authorEmail: "a@b.c", allowlist: [] };
const file = (name: string, body: unknown) => {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
};
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("print-triggers", () => {
  test("prints only the explicit empty triggers and a newline", async () => {
    const config = file("empty.json", { ...base, crons: [] });
    const result = await run(process.execPath, [script, "--config", config]);
    expect(result.stdout).toBe('{"crons":[]}\n');
    expect(result.stderr).toBe("");
  });

  test("prints only the default triggers and a newline when crons are omitted", async () => {
    const config = file("default.json", base);
    const result = await run(process.execPath, [script, "--config", config]);
    expect(result.stdout).toBe('{"crons":["17 * * * *"]}\n');
    expect(result.stderr).toBe("");
  });

  test("refuses invalid crons on stderr with exit 1 and no stdout", async () => {
    const config = file("invalid.json", { ...base, crons: ["99 * * * *"] });
    await expect(run(process.execPath, [script, "--config", config])).rejects.toMatchObject({
      code: 1, stdout: "", stderr: expect.stringMatching(/crons/),
    });
  });

  test("requires --config on stderr with exit 1 and no stdout", async () => {
    await expect(run(process.execPath, [script])).rejects.toMatchObject({
      code: 1, stdout: "", stderr: expect.stringMatching(/--config/),
    });
  });

  test("reports an unreadable config on stderr with exit 1 and no stdout", async () => {
    await expect(run(process.execPath, [script, "--config", join(dir, "missing.json")])).rejects.toMatchObject({
      code: 1, stdout: "", stderr: expect.stringMatching(/Cannot read/),
    });
  });

  test("does not create the Instance's generated Wrangler config", async () => {
    const inst = { ...base, name: `htmlgate-print-${randomUUID()}`, crons: [] };
    const generated = generatedConfig(inst);
    expect(existsSync(generated)).toBe(false);
    const config = file("read-only.json", inst);
    const result = await run(process.execPath, [script, "--config", config]);
    expect(existsSync(generated)).toBe(false);
    expect(result.stdout).toBe('{"crons":[]}\n');
    expect(result.stderr).toBe("");
  });

  test("succeeds with an empty PATH and poisoned network environment", async () => {
    const config = file("offline.json", { ...base, crons: [] });
    const result = await run(process.execPath, [script, "--config", config], {
      env: { PATH: "", HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1" },
    });
    expect(result.stdout).toBe('{"crons":[]}\n');
    expect(result.stderr).toBe("");
  });
});
