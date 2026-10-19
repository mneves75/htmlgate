#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArchive, digest, formulaMetadata } from "./cli-archive.mjs";
import { releaseTag } from "./cli-install.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function rewriteFormula(source, version, sha256) {
  releaseTag(version);
  formulaMetadata(source);
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Archive SHA-256 must be 64 lowercase hex characters.");
  return source.replace(/^  url .*$/m, `  url "file://#{Pathname(__FILE__).realpath.dirname}/sources/${sha256}.tar"`)
    .replace(/^  sha256 .*$/m, `  sha256 "${sha256}"`)
    .replace(/^  version .*$/m, `  version "${version}"`);
}

export function pinFormula({ root = ROOT, log = console.log, error = console.error } = {}) {
  try {
    const { version } = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8"));
    const archive = buildArchive(join(root, "packages/cli"));
    const sha256 = digest(archive);
    const formula = join(root, "Formula/htmlgate.rb");
    const source = readFileSync(formula, "utf8");
    const pinned = rewriteFormula(source, version, sha256);
    const sources = join(root, "Formula/sources");
    mkdirSync(sources, { recursive: true });
    writeFileSync(join(sources, `${sha256}.tar`), archive);
    // The tap carries one source archive: the one this formula references. A superseded archive is dead weight a reader
    // may mistake for the live input, and an older tag still installs from its own tree, not from this directory.
    for (const name of readdirSync(sources)) {
      if (name.endsWith(".tar") && name !== `${sha256}.tar`) rmSync(join(sources, name));
    }
    if (pinned !== source) writeFileSync(formula, pinned);
    log(`Formula source ${sha256}.tar, version ${version}_1; ${pinned === source ? "unchanged" : "updated"}.`);
    return 0;
  } catch (e) {
    error(`Formula packaging failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = pinFormula();
}
