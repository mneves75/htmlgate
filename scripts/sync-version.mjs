#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const LANDING_VERSION_FILES = [
  "site/public/index.html",
  "site/public/en/index.html",
  "site/public/privacidade/index.html",
  "site/public/en/privacy/index.html",
  "site/public/404.html",
];

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-beta\.(?:0|[1-9]\d*))?$/;

export function checkVersionSync(root = ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = pkg.version;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    return { version: String(version), mismatches: [`package.json: invalid version "${version}"`] };
  }
  const mismatches = [];
  const cliPkg = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8"));
  if (cliPkg.version !== version) {
    mismatches.push(`packages/cli/package.json has "${cliPkg.version}", expected "${version}"`);
  }
  const srcVersion = readFileSync(join(root, "src/version.ts"), "utf8");
  const versionMatch = /export const VERSION = "([^"]+)";/.exec(srcVersion);
  if (versionMatch?.[1] !== version) {
    mismatches.push(`src/version.ts has "${versionMatch?.[1] ?? "missing"}", expected "${version}"`);
  }
  for (const rel of LANDING_VERSION_FILES) {
    const html = readFileSync(join(root, rel), "utf8");
    const spans = [...html.matchAll(/<span class="version">([^<]+)<\/span>/g)];
    if (spans.length !== 1 || spans[0][1] !== version) {
      mismatches.push(`${rel} has ${spans.length === 1 ? `"${spans[0][1]}"` : `${spans.length} version spans`}, expected "${version}"`);
    }
  }
  const formula = readFileSync(join(root, "Formula/htmlgate.rb"), "utf8");
  const formulaMatch = /^  version "([^"\r\n]+)"$/m.exec(formula);
  if (formulaMatch?.[1] !== version) {
    mismatches.push(`Formula/htmlgate.rb has "${formulaMatch?.[1] ?? "missing"}", expected "${version}"`);
  }
  return { version, mismatches };
}

export function syncVersion(root = ROOT, targetVersion) {
  const pkgPath = join(root, "package.json");
  const pkgText = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(pkgText);
  const version = targetVersion ?? pkg.version;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`Invalid version "${version}". Expected X.Y.Z or X.Y.Z-beta.N.`);
  }
  const plan = [];
  const stage = (rel, current, pattern, replacement, label) => {
    const matches = current.match(pattern);
    if (!matches || matches.length !== 1) {
      throw new Error(`${rel} must contain exactly one ${label} (found ${matches?.length ?? 0}).`);
    }
    const next = current.replace(pattern, replacement);
    plan.push({ rel, full: join(root, rel), current, next });
  };
  stage("package.json", pkgText, /"version":\s*"[^"]+"/g, `"version": "${version}"`, '"version" field');
  const cliText = readFileSync(join(root, "packages/cli/package.json"), "utf8");
  stage("packages/cli/package.json", cliText, /"version":\s*"[^"]+"/g, `"version": "${version}"`, '"version" field');
  const srcVersionText = readFileSync(join(root, "src/version.ts"), "utf8");
  stage("src/version.ts", srcVersionText, /export const VERSION = "[^"]+";/g, `export const VERSION = "${version}";`, "VERSION export");
  for (const rel of LANDING_VERSION_FILES) {
    const html = readFileSync(join(root, rel), "utf8");
    stage(rel, html, /<span class="version">[^<]+<\/span>/g, `<span class="version">${version}</span>`, '<span class="version"> tag');
  }
  const updated = [];
  for (const item of plan) {
    if (item.current !== item.next) {
      writeFileSync(item.full, item.next);
      updated.push(item.rel);
    }
  }
  return { version, updated };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--check")) {
    const { version, mismatches } = checkVersionSync(ROOT);
    if (mismatches.length) {
      for (const m of mismatches) console.error(`version-in-sync: ${m}. Fix: run \`pnpm run version:sync && pnpm run cli:formula\`.`);
      process.exit(1);
    }
    console.log(`Version ${version} is synchronized across all packages, pages and formula.`);
  } else {
    const target = args.find((a) => !a.startsWith("-"));
    const { version, updated } = syncVersion(ROOT, target);
    console.log(updated.length ? `Synced version ${version} to: ${updated.join(", ")}. Run \`pnpm run cli:formula\` next.` : `Version ${version} already synced.`);
  }
}
