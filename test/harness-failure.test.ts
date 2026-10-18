import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import setup, { settings, startInstance, startSite } from "./global-setup";
import type { TestProject } from "vitest/node";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFileSync: vi.fn(), spawn: vi.fn(),
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, mkdtempSync: vi.fn(fs.mkdtempSync) };
});
vi.mock("node:http", async (original) => {
  const http = await original<typeof import("node:http")>();
  return { ...http, createServer: vi.fn(http.createServer) };
});

beforeEach(() => {
  vi.mocked(execFileSync).mockReset();
  vi.mocked(spawn).mockReset();
  vi.mocked(mkdtempSync).mockClear();
  vi.mocked(createServer).mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of vi.mocked(mkdtempSync).mock.results) {
    if (r.type === "return") rmSync(r.value, { recursive: true, force: true });
  }
  for (const r of vi.mocked(createServer).mock.results) {
    if (r.type === "return" && r.value.listening) {
      r.value.closeAllConnections();
      await new Promise<void>((resolve) => r.value.close(() => resolve()));
    }
  }
});

const state = () => vi.mocked(mkdtempSync).mock.results[0]!.value as string;

test("a failed migration removes its disposable state", async () => {
  vi.mocked(execFileSync).mockImplementation(() => { throw new Error("migration failed"); });
  await expect(startInstance(settings("http://127.0.0.1:1"))).rejects.toThrow("migration failed");
  expect(existsSync(state())).toBe(false);
});

test("global setup closes its cert server when the Instance cannot start", async () => {
  vi.mocked(execFileSync).mockImplementation((_file, args) => {
    if (args?.includes("migrations")) throw new Error("migration failed");
    return Buffer.from("");
  });
  await expect(setup({ provide: vi.fn() } as unknown as TestProject)).rejects.toThrow("migration failed");
  const servers = vi.mocked(createServer).mock.results.filter((r) => r.type === "return").map((r) => r.value);
  expect(servers.length).toBeGreaterThan(0);
  expect(servers.every((s) => !s.listening)).toBe(true);
});

test("a failed spawn removes the landing's disposable state", async () => {
  vi.mocked(spawn).mockImplementation(() => { throw new Error("spawn failed"); });
  await expect(startSite()).rejects.toThrow("spawn failed");
  expect(existsSync(state())).toBe(false);
});

test("an asynchronous spawn error removes state and its exit listener", async () => {
  const worker = Object.assign(new ChildProcess(), { stdout: new PassThrough(), stderr: new PassThrough() });
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => worker.emit("error", new Error("spawn failed asynchronously")));
    return worker;
  });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("not ready"));
  const listeners = process.listenerCount("exit");
  await expect(startSite()).rejects.toThrow("spawn failed asynchronously");
  expect(existsSync(state())).toBe(false);
  expect(process.listenerCount("exit")).toBe(listeners);
});

test.each(["exit", "timeout"])("a Worker startup %s removes state and its exit listener", async (failure) => {
  const worker = Object.assign(new ChildProcess(), {
    pid: 2147483647, stdout: new PassThrough(), stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValue(worker);
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    if (failure === "exit") Object.defineProperty(worker, "exitCode", { value: 1 });
    else clock.mockReturnValue(now + 91_000);
    throw new Error("not ready");
  });
  const listeners = process.listenerCount("exit");
  await expect(startSite()).rejects.toThrow("wrangler dev did not start");
  expect(kill).toHaveBeenCalledWith(-worker.pid!, "SIGKILL");
  expect(existsSync(state())).toBe(false);
  expect(process.listenerCount("exit")).toBe(listeners);
});
