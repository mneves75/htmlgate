// The CLI stands on its own (plan 010): nothing it ships names the project it started from. Its LICENSE keeps the
// original MIT notice, because the licence requires it in every copy; that file is the one exception.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const cli = join(process.cwd(), "packages/cli");

test("no file the CLI ships, besides its LICENSE, mentions htmlbin", () => {
  const files = ["README.md", "package.json", ...readdirSync(join(cli, "src")).map((f) => join("src", f))];
  const mentions = files.filter((f) => /htmlbin|utsengar|8b4d631/i.test(readFileSync(join(cli, f), "utf8")));
  expect(mentions).toEqual([]);
  expect(readFileSync(join(cli, "LICENSE"), "utf8")).toMatch(/Permission is hereby granted/);
});

test("tokens are hg_ tokens everywhere the CLI reads or hides them", () => {
  const src = readdirSync(join(cli, "src")).map((f) => readFileSync(join(cli, "src", f), "utf8")).join("\n");
  expect(src).not.toMatch(/hb_/);
  expect(src).toMatch(/hg_\[A-Za-z0-9\]\{40\}/);
});
