import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI_INPUTS = ["LICENSE", "README.md", "package.json", "src", "tsconfig.json"];
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function temporaryBuild() {
  const scratch = join(ROOT, ".scratch");
  mkdirSync(scratch, { recursive: true });
  return mkdtempSync(join(scratch, "cli-archive-"));
}

export function tar(args) {
  const result = spawnSync("/usr/bin/tar", args, { env: { ...process.env, COPYFILE_DISABLE: "1" }, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Source archive tar failed: ${result.error?.message || result.stderr?.toString()}`);
  return result.stdout;
}

export function buildArchive(cliRoot = join(ROOT, "packages/cli")) {
  const staging = temporaryBuild();
  try {
    if (!lstatSync(cliRoot).isDirectory() || lstatSync(cliRoot).isSymbolicLink()) throw new Error("Unsafe CLI source root.");
    const paths = [];
    const copy = (name) => {
      if (!name.split("/").every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))) throw new Error(`Unsafe source path: ${name}`);
      const input = join(cliRoot, name);
      const stat = lstatSync(input);
      if (stat.isSymbolicLink()) throw new Error(`Source symlink is forbidden: ${name}`);
      if (stat.isDirectory()) {
        if (name !== "src" && !name.startsWith("src/")) throw new Error(`Unapproved source directory: ${name}`);
        mkdirSync(join(staging, name));
        for (const child of readdirSync(input).sort()) copy(`${name}/${child}`);
        chmodSync(join(staging, name), 0o755);
      } else if (stat.isFile()) {
        if (name.startsWith("src/") && !name.endsWith(".ts")) throw new Error(`Unapproved source input: ${name}`);
        writeFileSync(join(staging, name), readFileSync(input), { mode: 0o644 });
        chmodSync(join(staging, name), 0o644); // the umask masks writeFileSync's mode, and the mode is in the archive
      } else {
        throw new Error(`Unsupported source type: ${name}`);
      }
      utimesSync(join(staging, name), 0, 0);
      paths.push(name);
    };
    for (const name of CLI_INPUTS) copy(name);
    const config = JSON.parse(readFileSync(join(staging, "tsconfig.json"), "utf8"));
    if (config.extends || JSON.stringify(config.include) !== '["src"]' || config.files || config.references) {
      throw new Error("CLI tsconfig must use only the approved standalone src inputs.");
    }
    // ustar has no host-specific extended metadata; the explicit list includes every src entry.
    return tar(["-cf", "-", "--format", "ustar", "--uid", "0", "--gid", "0", "--uname", "", "--gname", "",
      "--no-recursion", "-C", staging, ...paths.sort()]);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function formulaMetadata(source) {
  const field = (name, pattern) => {
    const lines = source.match(new RegExp(`^  ${name}[^\\S\\r\\n]+.*$`, "gm")) || [];
    const declarations = (source.match(new RegExp(`^[ \\t]*${name}[ \\t]+.*$`, "gm")) || []).length;
    const expected = ["url", "sha256"].includes(name) ? (source.match(/^[ \t]*resource "[^"\n]+" do$/gm) || []).length + 1 : 1;
    if (lines.length !== 1 || declarations !== expected) throw new Error(`Formula ${name} must be found exactly once.`);
    const match = lines[0].match(pattern);
    if (!match) throw new Error(`Malformed formula ${name}.`);
    return match[1];
  };
  const sha256 = field("sha256", /^  sha256 "([a-f0-9]{64})"$/);
  const archive = field("url", /^  url "file:\/\/#\{Pathname\(__FILE__\)\.realpath\.dirname\}\/sources\/([a-f0-9]{64}\.tar)"$/);
  const version = field("version", /^  version "([^"\r\n]+)"$/);
  const revision = field("revision", /^  revision (1)$/);
  if (archive !== `${sha256}.tar`) throw new Error("Formula archive filename does not match sha256.");
  return { sha256, archive, version, revision: Number(revision) };
}

export function verifyArchive(root, source = readFileSync(join(root, "Formula/htmlgate.rb"), "utf8")) {
  const metadata = formulaMetadata(source);
  const archive = readFileSync(join(root, "Formula/sources", metadata.archive));
  if (digest(archive) !== metadata.sha256) throw new Error("Source archive SHA-256 mismatch.");
  if (!archive.equals(buildArchive(join(root, "packages/cli")))) throw new Error("Source archive is stale: approved CLI inputs differ.");
  return { ...metadata, bytes: archive };
}
