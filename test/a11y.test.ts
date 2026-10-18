// The axe audit must never read a failed or malformed audit as "no violations".
import { expect, test } from "vitest";
import { axeViolations } from "./a11y";

const report = (violations: unknown, count: unknown = Array.isArray(violations) ? violations.length : 0) =>
  JSON.stringify({ success: true, data: { counts: { violations: count }, violations } });

test("a clean audit has no violations, and a dirty one names each rule and node", async () => {
  expect(await axeViolations(async () => report([]))).toEqual([]);
  expect(await axeViolations(async () => report([{ id: "image-alt", nodes: [{ target: ["img"] }] }]))).toEqual([{ id: "image-alt", nodes: ['["img"]'] }]);
});

test.each([
  ["an error envelope", JSON.stringify({ success: false, error: "audit failed" })],
  ["no violations list", JSON.stringify({ success: true, data: {} })],
  ["a count that disagrees with the list", report([], 2)],
  ["no JSON at all", "Error: browser closed"],
])("%s is an error, never a pass", async (_, out) => {
  await expect(axeViolations(async () => out)).rejects.toThrow(/axe/);
});

test("a command that fails without a report is an error", async () => {
  await expect(axeViolations(async () => Promise.reject(Object.assign(new Error("exit 1"), { stdout: "" })))).rejects.toThrow(/axe/);
});
