// The staging runbook and the crons field in docs/operator.md (review R3 of #24: OPS-04, SPEC-06).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const doc = readFileSync(join(import.meta.dirname, "..", "docs", "operator.md"), "utf8");
const runbook = doc.slice(doc.indexOf("To turn the staging cron off"), doc.indexOf("## Day to day"));
const cronsItem = doc.split("\n").find((line) => line.startsWith("- `crons` is optional")) ?? "";

describe("docs/operator.md staging runbook", () => {
  test("defines <staging name> as the staging instance file's name and forbids production's", () => {
    expect(runbook).toMatch(/`<staging name>` is the `name` (field )?(in|of) the staging instance file/);
    expect(runbook).toMatch(/[Nn]ever (use )?(the )?production(['’]s)? name/);
  });

  test("takes the rollback version id from deployments list of that same Worker", () => {
    expect(runbook).toMatch(/wrangler deployments list --name <staging name> --json/);
    expect(runbook).toMatch(/wrangler rollback <previous version id> --name <staging name>/);
    expect(runbook).toMatch(/version id must come from the same `deployments list --name <staging name>`/);
  });
});

describe("docs/operator.md crons field", () => {
  test("says L-n (an offset from the last day) is refused", () => {
    expect(cronsItem).toMatch(/`L-n`[^.]*refused|refuse[sd]?[^.]*`L-n`/);
  });
});
