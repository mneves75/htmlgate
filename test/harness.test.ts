// The test harness itself: every run starts Workers with a fresh local state on disk, and a mutation
// run starts hundreds. Each must leave nothing behind, or the runs fill the disk.
import { existsSync } from "node:fs";
import { inject, test, expect } from "vitest";
import { settings, startInstance, startSite } from "./global-setup";

test("stopping an Instance removes its local state directory", async () => {
  const inst = await startInstance(settings(inject("teamUrl")));
  expect(existsSync(inst.state)).toBe(true);
  await inst.stop();
  await inst.stop();
  expect(existsSync(inst.state)).toBe(false);
}, 120_000);

test("stopping the landing removes its local state directory", async () => {
  const site = await startSite();
  expect(existsSync(site.state)).toBe(true);
  await site.stop();
  await site.stop();
  expect(existsSync(site.state)).toBe(false);
}, 120_000);
