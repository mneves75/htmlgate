import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript-classic";
import { expect, test } from "vitest";

const root = process.cwd();
const files = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
  const file = join(path, entry.name);
  return entry.isDirectory() ? files(file) : [file];
});
const obsolete = (line: string) =>
  /\/api\/drops|bad-drop|no-drop|name="drop"|\/d\/(?:<slug>|\$\{|[A-Za-z0-9]{12})|\bShare (?:it|them|this|that) when\b/i.test(line)
  || /\bDrops?\b|\b[A-Za-z0-9_$]*Drop[A-Za-z0-9_$]*\b/.test(line
    .replace(/\b(?:Dropping|Dropped)\b/g, "")
    .replace(/(^|[.!?]\s+)Drop (?:it|the file|that table)\b/g, "$1"));
const obsoleteIdentifiers = (source: string, file: string): string[] => {
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && !/^dropdown$/i.test(node.text)
      && (node.text.includes("Drop") || /^drop[A-Z]|[a-z]Drops?$|^drops?$/i.test(node.text))) hits.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
  return hits;
};

test("the term guard detects the former name and identifiers while allowing English verbs", () => {
  for (const value of ["Drop", "Drops", "createDrop", "DropRow", "recentDrops", '"createDrop"']) expect(obsolete(value), value).toBe(true);
  for (const value of ["createDrop", "DropRow", "recentDrops", "Dropping"]) {
    expect(obsoleteIdentifiers(`const ${value} = 1;`, "guard.ts"), value).toEqual([value]);
  }
  for (const value of ["Share", "Shares", "drop the file", "dropped that table", "drops the", "Dropping it", "Dropped that table", "DROP TABLE", "drop-shadow", "dropdown"]) {
    expect(obsolete(value), value).toBe(false);
  }
  expect(obsoleteIdentifiers('const share = "Dropping it"; // dropped that table', "guard.ts")).toEqual([]);
  for (const [old, current] of [
    ["/api/drops", "/api/shares"],
    ["bad-drop", "bad-share"],
    ["no-drop", "no-share"],
    ['name="drop"', 'name="share"'],
    ["/d/<slug>", "/s/<slug>"],
    ["/d/${slug}", "/s/${slug}"],
    ["/d/Ab12Cd34Ef56", "a/b/c/d/deep.txt"],
    ["Share it when", "Drop it when"],
    ["Share them when", "drop them when"],
    ["Share this when", "Drop the file when"],
    ["Share that when", "Drop that table when"],
  ] as const) {
    expect(obsolete(old), old).toBe(true);
    expect(obsolete(current), current).toBe(false);
    expect(obsolete(old.toUpperCase()), old.toUpperCase()).toBe(true);
  }
  for (const [old, current] of [
    ["dropSlug", "shareSlug"],
    ["recentDrop", "recentShare"],
    ["recentDrops", "recentShares"],
    ["drop", "share"],
    ["drops", "shares"],
  ] as const) {
    for (const value of [old, old.toLowerCase(), old.toUpperCase()]) {
      expect(obsoleteIdentifiers(`const ${value} = 1;`, "guard.ts"), value).toEqual([value]);
      expect(obsoleteIdentifiers(`const ${value} = 1;`, "guard.mjs"), value).toEqual([value]);
    }
    expect(obsoleteIdentifiers(`const ${current} = 1;`, "guard.mjs"), current).toEqual([]);
    expect(obsoleteIdentifiers(`const share = "${old}"; // ${old}`, "guard.ts"), old).toEqual([]);
  }
  for (const verb of ["Drop it", "Drop the file", "Drop that table"]) {
    expect(obsolete(`${verb} when ready.`), verb).toBe(false);
    expect(obsolete(`Nothing reads it. ${verb} when ready.`), verb).toBe(false);
    expect(obsolete(`A ${verb} when ready.`), verb).toBe(true);
  }
  expect(obsoleteIdentifiers("const dropdown = 1; // drop the file", "guard.mjs")).toEqual([]);
});

test("shipping source, pages and current documentation use Share throughout", () => {
  const paths = [
    ...["src", "packages/cli/src", "scripts", "site/public"].flatMap((dir) => files(join(root, dir))),
    ...["README.md", "PRODUCT.md", "AGENTS.md", "DESIGN.md", "docs/operator.md", "docs/privacy.md", "skills/htmlgate/SKILL.md", "GLOSSARY.md", "packages/cli/README.md", "package.json", "packages/cli/package.json", "wrangler.jsonc", "site/wrangler.jsonc"].map((file) => join(root, file)),
  ];
  const hits: string[] = [];
  for (const file of paths) {
    const name = relative(root, file);
    const source = readFileSync(file, "utf8");
    if (source.includes("\0")) continue;
    if (/\.(?:ts|mjs)$/.test(file)) {
      for (const identifier of obsoleteIdentifiers(source, file)) hits.push(`${name}:identifier:${identifier}`);
    }
    let shareEntry = false;
    for (const [index, line] of source.split("\n").entries()) {
      if (name === "GLOSSARY.md" && /^\*\*.+\*\*:$/.test(line)) shareEntry = line === "**Share**:";
      const checked = name === "GLOSSARY.md" && shareEntry && line.startsWith("_Avoid_:")
        ? line.replace("Drop (its name before 0.1)", "") : line;
      if (obsolete(checked)) hits.push(`${name}:${index + 1}:${line}`);
    }
  }
  expect(hits).toEqual([]);
});
