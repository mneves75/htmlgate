#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_INPUTS, tar, temporaryBuild, verifyArchive } from "./cli-archive.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TAP = "mneves75/htmlgate";
const REPOSITORY = "https://github.com/mneves75/htmlgate.git";
const FORMULA = `${TAP}/htmlgate`;

export function releaseTag(version) {
  const match = typeof version === "string" && /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-beta\.(0|[1-9]\d*))?$/.exec(version);
  if (!match || match[0] !== version) throw new Error(`Unsupported CLI version: ${version}`);
  return `v${match[1]}${match[2] === undefined ? "" : `-beta${match[2]}`}`;
}

export function installCli({ root = ROOT, run = spawnSync, read = readFileSync, log = console.log, error = console.error } = {}) {
  const step = (s) => log(`- ${s}`);
  // Install, upgrade and tap can otherwise trigger Homebrew's global automatic update.
  const options = { cwd: root, encoding: "utf8", stdio: "pipe", env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1" } };
  const command = (bin, args) => {
    const result = run(bin, args, options);
    if (result.error || result.status !== 0) {
      throw new Error(`${[bin, ...args].join(" ")} failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
    }
    return result.stdout.trim();
  };
  const absolutePath = (args) => {
    const value = command("brew", args);
    if (!isAbsolute(value) || /[\r\n]/.test(value)) throw new Error(`brew ${args.join(" ")} returned no absolute path.`);
    return value;
  };

  try {
    step("checking Homebrew");
    const available = run("brew", ["--version"], options);
    if (available.error || available.status !== 0) {
      throw new Error("Homebrew is not available. Install Homebrew and ensure brew is on PATH, then run pnpm run cli:install again.");
    }
    const { version } = JSON.parse(read(join(root, "packages/cli/package.json"), "utf8"));
    const tag = releaseTag(version);
    step(`checking tap ${TAP}`);
    if (!command("brew", ["tap"]).split(/\r?\n/).includes(TAP)) {
      step(`tapping ${TAP}`);
      command("brew", ["tap", TAP, REPOSITORY]);
    }
    step(`refreshing tap ${TAP}`);
    const repository = absolutePath(["--repository", TAP]);
    command("git", ["-C", repository, "fetch", "--tags", "--prune", "origin"]);
    const inspect = `Inspect the tap at ${repository}; no local edits or commits will be discarded.`;
    if (command("git", ["-C", repository, "status", "--porcelain"])) {
      throw new Error(`Tap is not clean. ${inspect}`);
    }
    const head = command("git", ["-C", repository, "rev-parse", "HEAD"]);
    const remote = command("git", ["-C", repository, "rev-parse", "origin/main"]);
    if (head !== remote) {
      const ancestor = run("git", ["-C", repository, "merge-base", "--is-ancestor", "HEAD", "origin/main"], options);
      if (ancestor.error || ancestor.status !== 0) {
        throw new Error(`Tap HEAD is not an ancestor of origin/main: ${ancestor.error?.message || ancestor.stderr?.trim() || `exit ${ancestor.status}`}. ${inspect}`);
      }
      command("git", ["-C", repository, "merge", "--ff-only", "origin/main"]);
      if (command("git", ["-C", repository, "rev-parse", "HEAD"]) !== remote) {
        throw new Error(`Tap HEAD does not equal origin/main after fast-forward. ${inspect}`);
      }
    }

    step(`checking release tag ${tag} in tap ${TAP}`);
    try {
      command("git", ["-C", repository, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
    } catch (e) {
      throw new Error(`Release tag ${tag} is unavailable in tap ${TAP}: ${e instanceof Error ? e.message : String(e)}`);
    }

    const formulaPath = join(repository, "Formula/htmlgate.rb");
    const source = read(formulaPath, "utf8");
    const selectedSource = read(join(root, "Formula/htmlgate.rb"), "utf8");
    const selected = verifyArchive(root, selectedSource);
    const verified = verifyArchive(repository, source);
    const archive = verified.bytes;
    const expectedArchive = selected.bytes;
    if (!archive.equals(expectedArchive) || source !== selectedSource || verified.version !== version) {
      throw new Error(`Formula/archive at ${formulaPath} differs from the selected candidate ${tag} (${version}).`);
    }
    try {
      command("git", ["-C", repository, "diff", "--exit-code", `${tag}^{commit}`, "--",
        "Formula/htmlgate.rb", `Formula/sources/${verified.archive}`, ...CLI_INPUTS.map((name) => `packages/cli/${name}`)]);
    } catch (e) {
      throw new Error(`Release tag ${tag} differs from the selected formula/archive/source candidate: ${e.message}`);
    }

    step(`checking installed formula ${FORMULA}`);
    const installed = command("brew", ["list", "--formula", "--full-name"]).split(/\r?\n/).includes(FORMULA);
    const action = installed ? "upgrade" : "install";
    step(`${installed ? "upgrading" : "installing"} ${FORMULA}`);
    command("brew", [action, FORMULA]);

    step("checking the installed rebuild receipt and artifacts");
    const receipt = JSON.parse(command("brew", ["info", "--json=v2", "--installed", FORMULA]));
    const expectedVersion = `${version}_${verified.revision}`;
    const info = receipt?.formulae?.length === 1 ? receipt.formulae[0] : undefined;
    if (info?.full_name !== FORMULA || info.linked_keg !== expectedVersion ||
        !Array.isArray(info.installed) || !info.installed.some((entry) => entry.version === expectedVersion)) {
      throw new Error(`Homebrew receipt mismatch: expected linked ${FORMULA} ${expectedVersion}.`);
    }
    const installedPrefix = realpathSync(absolutePath(["--prefix", FORMULA]));
    const build = temporaryBuild();
    try {
      tar(["-xf", join(repository, "Formula/sources", verified.archive), "-C", build]);
      command(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", build,
        "--typeRoots", join(ROOT, "node_modules/@types")]);
      const fileList = (directory, prefix = "") => readdirSync(directory).sort().flatMap((name) => {
        const relative = prefix + name;
        const stat = lstatSync(join(directory, name));
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Unsafe installed artifact: ${relative}`);
        return stat.isDirectory() ? fileList(join(directory, name), relative + "/") : [relative];
      });
      const expectedFiles = ["LICENSE", "README.md", "package.json", ...fileList(join(build, "dist"), "dist/")].sort();
      const libexec = join(installedPrefix, "libexec");
      const actualFiles = fileList(libexec);
      if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) throw new Error("Installed artifact file set mismatch.");
      for (const name of expectedFiles) {
        if (!readFileSync(join(libexec, name)).equals(readFileSync(join(build, name)))) throw new Error(`Installed artifact mismatch: ${name}`);
      }
    } finally {
      rmSync(build, { recursive: true, force: true });
    }

    step("checking the installed CLI version");
    const prefix = absolutePath(["--prefix"]);
    const nodePrefix = absolutePath(["--prefix", "node"]);
    const launcher = `#!/bin/sh\nexec "${join(nodePrefix, "bin/node")}" "${join(installedPrefix, "libexec/dist/bin.js")}" "$@"\n`;
    if (readFileSync(join(prefix, "bin/htmlgate"), "utf8") !== launcher) throw new Error("Installed artifact mismatch: htmlgate launcher.");
    const actual = command(join(prefix, "bin/htmlgate"), ["--version"]);
    step(`installed ${actual}; expected ${version}`);
    if (actual !== version) throw new Error(`CLI version mismatch: installed ${actual}; expected ${version}.`);
    if (!command(join(prefix, "bin/htmlgate"), ["--help"]).includes("htmlgate publish")) throw new Error("Installed CLI help is unavailable.");

    step("checking htmlgate on PATH");
    const paths = run("which", ["-a", "htmlgate"], options);
    const first = paths.stdout?.trim().split(/\r?\n/)[0];
    if (paths.error || paths.status !== 0 || !first) throw new Error(`Homebrew's bin directory ${join(prefix, "bin")} is not on PATH; no htmlgate executable found. Add it to PATH, then run pnpm run cli:install again.`);
    if (first !== join(prefix, "bin/htmlgate")) {
      throw new Error(`${first} shadows Homebrew's htmlgate on PATH; expected ${join(prefix, "bin/htmlgate")} first. Put Homebrew's bin first on PATH, or remove a shadowing npm installation with npm uninstall -g @htmlgate/cli, then run pnpm run cli:install again.`);
    }
    return 0;
  } catch (e) {
    error(`CLI install failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = installCli();
}
