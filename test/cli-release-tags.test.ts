// Release-state enforcement stays separate from unconditional installer mutation controls.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
// @ts-expect-error plain JavaScript module
import { releaseTag } from "../scripts/cli-install.mjs";
// @ts-expect-error plain JavaScript module
import { CLI_INPUTS, formulaMetadata, verifyArchive } from "../scripts/cli-archive.mjs";

const cli = JSON.parse(readFileSync("packages/cli/package.json", "utf8"));
const source = readFileSync("Formula/htmlgate.rb", "utf8");
const tag = releaseTag(cli.version);
const metadata = formulaMetadata(source);
const formulaVersion = metadata.version;
const formulaTag = releaseTag(formulaVersion);
function releaseValidationDecision(ciSet: boolean, tagsReadable: boolean, packageTagExists: boolean): "enforce" | "skip" | "fail" {
  if (!tagsReadable) return ciSet ? "fail" : "skip";
  return packageTagExists ? "enforce" : "skip";
}
// show-ref exits nonzero for an empty tag set as well as an unreadable repository.
let tagsReadable = spawnSync("git", ["show-ref", "--tags"], { encoding: "utf8" }).status === 0;
const tagCommit = (name: string | undefined) => {
  if (!tagsReadable || !name) return undefined;
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${name}^{commit}`], { encoding: "utf8" });
  if (result.status !== 0 && result.status !== 1) tagsReadable = false;
  return result.status === 0 ? result.stdout.trim() : undefined;
};
const formulaCommit = tagCommit(formulaTag);
const packageCommit = tagCommit(tag);
const ciSet = process.env.CI !== undefined;
const formulaDecision = releaseValidationDecision(ciSet, tagsReadable && !!formulaCommit, true);
const packageDecision = releaseValidationDecision(ciSet, tagsReadable, !!packageCommit);
const tagsRequired = "Release validation needs the tags: checkout must use fetch-depth: 0 and fetch-tags: true (tag set or formula tag unavailable).";

describe("release validation tag policy", () => {
  test.each([
    [false, false, false, "skip"], [false, false, true, "skip"],
    [false, true, false, "skip"], [false, true, true, "enforce"],
    [true, false, false, "fail"], [true, false, true, "fail"],
    [true, true, false, "skip"], [true, true, true, "enforce"],
  ] as const)("CI=%s, tags readable=%s, package tag exists=%s: %s", (ci, readable, exists, expected) => {
    expect(releaseValidationDecision(ci, readable, exists)).toBe(expected);
  });
  test("release checkout fetches full history and tags together", () => {
    const workflow = readFileSync(".github/workflows/release-validation.yml", "utf8");
    const checkouts = workflow.split(/^      - /m).filter((step) => /^uses: actions\/checkout@/m.test(step));
    expect(checkouts).toHaveLength(1);
    const settings = checkouts[0]!.match(/^        with:\n((?:          .*\n)+)/m)?.[1];
    expect(settings).toMatch(/^          fetch-depth: 0$/m);
    expect(settings).toMatch(/^          fetch-tags: true$/m);
    expect(settings).toMatch(/^          persist-credentials: false$/m);
  });
});

test("current formula archive reproduces every approved current CLI input", () => {
  expect(() => verifyArchive(process.cwd())).not.toThrow();
  expect(metadata.version).toBe(cli.version);
  expect(metadata.revision).toBe(1);
});

function assertTaggedCandidate(name: string) {
  const taggedFormula = spawnSync("git", ["show", name + ":Formula/htmlgate.rb"], { encoding: "utf8" });
  expect(taggedFormula.status, name + " formula must be readable").toBe(0);
  expect(taggedFormula.stdout === source, name + " formula differs from selected candidate").toBe(true);
  const archivePath = "Formula/sources/" + metadata.archive;
  const taggedArchive = spawnSync("git", ["show", name + ":" + archivePath]);
  expect(taggedArchive.status, name + " archive must be readable").toBe(0);
  expect(taggedArchive.stdout, name + " archive differs from selected candidate").toEqual(readFileSync(archivePath));
  const inputs = spawnSync("git", ["diff", "--exit-code", name + "^{commit}", "--",
    ...CLI_INPUTS.map((entry: string) => "packages/cli/" + entry)], { encoding: "utf8" });
  expect(inputs.status, name + " CLI inputs differ from selected candidate").toBe(0);
}
test.skipIf(formulaDecision === "skip")("formula archive and CLI inputs equal the readable formula release tag", () => {
  expect(formulaDecision, tagsRequired).toBe("enforce");
  assertTaggedCandidate(formulaTag);
});
test.skipIf(packageDecision === "skip")("formula archive and CLI inputs equal the package release once tagged", () => {
  expect(packageDecision, tagsRequired).toBe("enforce");
  expect(formulaVersion).toBe(cli.version);
  expect(formulaTag).toBe(tag);
  assertTaggedCandidate(tag);
});
