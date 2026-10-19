import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
// @ts-expect-error plain JavaScript module
import { installCli, releaseTag } from "../scripts/cli-install.mjs";
// @ts-expect-error plain JavaScript module
import { pinFormula, rewriteFormula } from "../scripts/cli-formula.mjs";
// @ts-expect-error plain JavaScript module
import { buildArchive, digest, formulaMetadata, tar, verifyArchive } from "../scripts/cli-archive.mjs";

const cli = JSON.parse(readFileSync("packages/cli/package.json", "utf8"));
const root = JSON.parse(readFileSync("package.json", "utf8"));
const source = readFileSync("Formula/htmlgate.rb", "utf8");
const lockfile = readFileSync("pnpm-lock.yaml", "utf8");
const tap = "mneves75/htmlgate";
const formula = `${tap}/htmlgate`;
const tag = releaseTag(cli.version);
const scratch = resolve(".scratch/implementation-evidence");
mkdirSync(scratch, { recursive: true });
const fixtureDirectories: string[] = [];
afterEach(() => {
  const failures: unknown[] = [];
  for (const dir of fixtureDirectories.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Failed to remove CLI fixture directories.");
});
const silent = () => {};
const files = (dir: string, prefix = ""): string[] => readdirSync(dir).sort().flatMap((name) => {
  const relative = prefix + name;
  return lstatSync(join(dir, name)).isDirectory() ? files(join(dir, name), relative + "/") : [relative];
});
function candidate() {
  const dir = mkdtempSync(join(scratch, "archive-fixture-"));
  fixtureDirectories.push(dir);
  mkdirSync(join(dir, "packages/cli"), { recursive: true });
  for (const name of ["src", "package.json", "tsconfig.json", "LICENSE", "README.md"]) {
    cpSync(resolve("packages/cli", name), join(dir, "packages/cli", name), { recursive: true });
  }
  mkdirSync(join(dir, "Formula"));
  writeFileSync(join(dir, "Formula/htmlgate.rb"), source);
  expect(pinFormula({ root: dir, log: silent }), "fixture packages without any Git tag").toBe(0);
  return dir;
}

describe("release tag conversion", () => {
  test.each([["0.1.0", "v0.1.0"], ["0.1.0-beta.1", "v0.1.0-beta1"], ["0.1.0-beta.13", "v0.1.0-beta13"], ["1.2.3", "v1.2.3"]])("%s becomes %s", (version, expected) => {
    expect(releaseTag(version)).toBe(expected);
  });
  test.each(["0.1.0-rc.1", "abc", "v0.1.0", "0.1", "0.1.0-beta13", "0.1.0\n"])("rejects %j", (version) => expect(() => releaseTag(version)).toThrow());
});

test("single-commit formula uses a content-addressed archive and a rebuild revision", () => {
  const metadata = formulaMetadata(source);
  const next = "b".repeat(64);
  expect(rewriteFormula(source, "0.1.0", next)).toBe(source.replaceAll(metadata.sha256, next).replace(/^  version .*$/m, '  version "0.1.0"'));
  expect(rewriteFormula(source, metadata.version, metadata.sha256)).toBe(source);
});

describe("deterministic CLI-root source archive", () => {
  test("exact approved current inputs, normalized metadata and no secret/build files", () => {
    const dir = candidate();
    const expected = ["LICENSE", "README.md", "package.json", "src/", ...files(join(dir, "packages/cli/src")).map((name) => "src/" + name), "tsconfig.json"].sort();
    const verified = verifyArchive(dir);
    expect(verified.bytes.length).toBeLessThan(100_000);
    const archive = join(dir, "Formula/sources", verified.archive);
    expect(tar(["-tf", archive]).toString().trim().split("\n").sort()).toEqual(expected);
    const out = join(dir, "extracted");
    mkdirSync(out);
    tar(["-xf", archive, "-C", out]);
    for (const name of expected.filter((name) => !name.endsWith("/"))) {
      expect(readFileSync(join(out, name)), name).toEqual(readFileSync(join(dir, "packages/cli", name)));
    }
    writeFileSync(join(dir, "packages/cli/.env"), "PRIVATE=not-a-real-secret");
    mkdirSync(join(dir, "packages/cli/dist"));
    writeFileSync(join(dir, "packages/cli/dist/stale.js"), "stale build");
    expect(buildArchive(join(dir, "packages/cli")).equals(verified.bytes)).toBe(true);
    for (const name of files(join(dir, "packages/cli/src"))) {
      utimesSync(join(dir, "packages/cli/src", name), 12345678, 12345678);
      chmodSync(join(dir, "packages/cli/src", name), 0o755);
    }
    expect(buildArchive(join(dir, "packages/cli")).equals(verified.bytes)).toBe(true);
    const before = readFileSync(join(dir, "Formula/htmlgate.rb"));
    expect(pinFormula({ root: dir, log: silent })).toBe(0);
    expect(readFileSync(join(dir, "Formula/htmlgate.rb"))).toEqual(before);
    expect(readFileSync(archive)).toEqual(verified.bytes);
  });
  test.each([["022", 0o022], ["027", 0o027], ["077", 0o077]])("the archive is byte-identical under the packaging process's umask %s", (_, mask) => {
    const dir = candidate();
    const committed = verifyArchive(dir).bytes;
    const previous = process.umask(mask);
    try {
      expect(buildArchive(join(dir, "packages/cli")).equals(committed)).toBe(true);
    } finally {
      process.umask(previous);
    }
  });
  test.each(["changed", "added", "omitted"])("a %s source input makes an existing archive stale", (mode) => {
    const dir = candidate();
    const input = join(dir, "packages/cli/src/bin.ts");
    if (mode === "changed") writeFileSync(input, readFileSync(input, "utf8") + "\n// changed input\n");
    if (mode === "added") writeFileSync(join(dir, "packages/cli/src/added.ts"), "export const added = 1;\n");
    if (mode === "omitted") renameSync(input, join(dir, "omitted.ts"));
    expect(() => verifyArchive(dir)).toThrow(/stale/);
    expect(pinFormula({ root: dir, log: silent })).toBe(0);
    expect(() => verifyArchive(dir)).not.toThrow();
  });
  test.each(["symlink", "directory symlink", "unsafe name", "unapproved input", "external config", "missing input"])("rejects %s instead of archiving it", (mode) => {
    const dir = candidate();
    const cliRoot = join(dir, "packages/cli");
    if (mode === "symlink") symlinkSync(join(cliRoot, "README.md"), join(cliRoot, "src/linked.ts"));
    if (mode === "directory symlink") symlinkSync(join(cliRoot, "src"), join(cliRoot, "src/linked"));
    if (mode === "unsafe name") writeFileSync(join(cliRoot, "src/bad\nname.ts"), "bad");
    if (mode === "unapproved input") writeFileSync(join(cliRoot, "src/private.env"), "bad");
    if (mode === "external config") writeFileSync(join(cliRoot, "tsconfig.json"), '{"extends":"../../tsconfig.json","include":["src"]}');
    if (mode === "missing input") renameSync(join(cliRoot, "LICENSE"), join(dir, "omitted-license"));
    expect(() => buildArchive(cliRoot)).toThrow(/symlink|Unsafe|Unapproved|standalone|ENOENT/);
  });
  test("a corrupted archive fails SHA-256 even when the filename is unchanged", () => {
    const dir = candidate();
    const metadata = verifyArchive(dir);
    writeFileSync(join(dir, "Formula/sources", metadata.archive), Buffer.from("tampered"));
    expect(() => verifyArchive(dir)).toThrow(/SHA-256/);
  });
  test.each(["url", "sha256", "version", "revision"])("rejects missing or duplicate top-level %s", (field) => {
    const line = source.match(new RegExp("^  " + field + " .*$", "m"))![0];
    expect(() => formulaMetadata(source.replace(line + "\n", ""))).toThrow(/exactly once/);
    expect(() => formulaMetadata(source + line + "\n")).toThrow(/exactly once/);
  });
  test.each(["url", "sha256", "version", "revision"])("rejects a noncanonical duplicate %s declaration", (field) => {
    const line = source.match(new RegExp("^  " + field + " .*$", "m"))![0];
    expect(() => formulaMetadata(source + "  " + line + "\n")).toThrow(/exactly once/);
  });
  test.each(["../escape.tar", "elsewhere.tar", "a".repeat(64) + ".tar/extra"])("rejects archive path %s", (path) => {
    const metadata = formulaMetadata(source);
    expect(() => formulaMetadata(source.replace(metadata.archive, path))).toThrow(/Malformed|filename/);
  });
  test("rejects malformed digests and a filename/checksum disagreement", () => {
    expect(() => rewriteFormula(source, "0.1.0", "abc")).toThrow(/64/);
    expect(() => formulaMetadata(source.replace(/^  sha256 .*$/m, '  sha256 "' + "f".repeat(64) + '"'))).toThrow(/filename/);
  });
});

describe("the Homebrew formula", () => {
  test("keeps metadata, CLI-root build and launcher behavior", () => {
    expect(source).toContain('depends_on "node"');
    expect(source).toContain('license "MIT"');
    // Homebrew hoists metafiles out of libexec into the keg root, so install them there and keep libexec to the build.
    expect(source).toContain('libexec.install "dist", "package.json"');
    expect(source).toContain('prefix.install "LICENSE", "README.md"');
    expect(source).toContain('exec "#{Formula["node"].opt_bin}/node" "#{libexec}/dist/bin.js" "$@"');
    expect(source).toContain('assert_equal version.to_s, shell_output("#{bin}/htmlgate --version").strip');
    expect(source).not.toContain('cd "packages/cli"');
    expect(root.scripts["cli:install"]).toBe("node scripts/cli-install.mjs");
    expect(root.scripts["cli:formula"]).toBe("node scripts/cli-formula.mjs");
    expect(source).toContain('desc "' + cli.description.replace(/\.$/, "") + '"');
    expect(source).toContain('homepage "' + cli.homepage + '"');
  });
  test.each([
    ["typescript", `https://registry.npmjs.org/typescript/-/typescript-${root.devDependencies.typescript}.tgz`, "typescript", "da2513f4b95176d6dde8b51aab7afe8a927656c9d277369793f77f7e59371c08"],
    ["types-node", `https://registry.npmjs.org/@types/node/-/node-${root.devDependencies["@types/node"]}.tgz`, "@types/node", "fd501fe34c262aa03bdff545d80c58f4ae3084fc426a5ae9e9448fe7a725e9cd"],
    ["undici-types", `https://registry.npmjs.org/undici-types/-/undici-types-${lockfile.match(/^  undici-types@([^:\s]+):$/m)?.[1]}.tgz`, "undici-types", "2abf595a86b87dd22951218848ec4ad89c018db0e656716dc04b8b2f9290a0f4"],
  ])("stages checksum-pinned %s without npm or npx", (name, url, destination, checksum) => {
    const resource = source.match(new RegExp(`resource "${name}" do\\n([\\s\\S]*?)\\n  end`))?.[1];
    expect(resource).toBeDefined();
    expect(resource).toContain(`url "${url}"`);
    expect(resource).toMatch(/sha256 "[a-f0-9]{64}"/);
    expect(resource).toContain(`sha256 "${checksum}"`);
    expect(source).toContain(`resource("${name}").stage(buildpath/"node_modules/${destination}")`);
    expect(source.indexOf(`resource("${name}").stage(`)).toBeLessThan(source.indexOf('system Formula["node"].opt_bin/"node", "node_modules/typescript/bin/tsc"'));
    expect(source).toContain('system Formula["node"].opt_bin/"node", "node_modules/typescript/bin/tsc", "-p", "."');
    expect(source).not.toMatch(/\b(?:npm|npx)\b(?!js)/);
  });
  test("stages the native TypeScript platform package for the build machine", () => {
    const ts = root.devDependencies.typescript;
    for (const [arch, checksum] of [
      ["arm64", "902e2fe1cf0799198ef902c6b8c310a450fef629a6baba41d45641ef75c04ebd"],
      ["x64", "eba158cb54050f723d5ff781438f33de5640054440bb4f2bd170cfe9bc2eb551"],
    ] as const) {
      const block = source.match(new RegExp(`resource "typescript-darwin-${arch}" do\\n([\\s\\S]*?)\\n    end`))?.[1];
      expect(block, arch).toBeDefined();
      expect(block, arch).toContain(`url "https://registry.npmjs.org/@typescript/typescript-darwin-${arch}/-/typescript-darwin-${arch}-${ts}.tgz"`);
      expect(block, arch).toContain(`sha256 "${checksum}"`);
    }
    expect(source).toContain('typescript_platform = "typescript-darwin-#{Hardware::CPU.arm? ? "arm64" : "x64"}"');
    expect(source).toContain('resource(typescript_platform).stage(buildpath/"node_modules/@typescript/#{typescript_platform}")');
    expect(source.indexOf('resource(typescript_platform).stage(')).toBeLessThan(source.indexOf('system Formula["node"].opt_bin/"node", "node_modules/typescript/bin/tsc"'));
  });
  test("documents the formula location and rejects unrelated source before staging or building", () => {
    expect(source.slice(0, source.indexOf('\n  url '))).toContain("must stay in the tap's Formula/ directory");
    expect(source).toMatch(/def install\n    odie "[^"]+" unless \(buildpath\/"package\.json"\)\.exist\?/);
  });
});


type Result = { status: number | null; stdout: string; stderr: string; error?: Error };
type Call = [string, string[]];
const ok = (stdout = ""): Result => ({ status: 0, stdout, stderr: "" });
const fail = (): Result => ({ status: 1, stdout: "", stderr: "controlled command failure" });
const key = ([bin, args]: Call) => [bin, ...args].join(" ");
function execute({ absent = false, tapped = false, installed = false, version = cli.version, failure = "",
  dirty = "", relation = "behind", mergedHead = "remote", paths = "", noPath = false, pathStatus = 0,
  receipt = cli.version + "_1", linked = cli.version + "_1", staleArtifact = "", staleTag = false,
  tapMismatch = false, tampered = false, formulaSource = "", readFailure = false } = {}) {
  const dir = candidate();
  const repository = join(dir, "tap");
  mkdirSync(repository);
  for (const name of ["Formula", "packages"]) cpSync(join(dir, name), join(repository, name), { recursive: true });
  const prefix = join(dir, "homebrew path");
  const installedPrefix = join(prefix, "Cellar/htmlgate", cli.version + "_1");
  const libexec = join(installedPrefix, "libexec");
  mkdirSync(libexec, { recursive: true });
  for (const name of ["dist", "package.json"]) cpSync(resolve("packages/cli", name), join(libexec, name), { recursive: true });
  for (const name of ["LICENSE", "README.md"]) cpSync(resolve("packages/cli", name), join(installedPrefix, name));
  mkdirSync(join(prefix, "bin"));
  const binary = join(prefix, "bin/htmlgate");
  const nodePrefix = dirname(dirname(process.execPath));
  // Homebrew points an installed script's shebang at the node it depends on, so the keg the installer inspects does too.
  const launcherScript = join(libexec, "dist/bin.js");
  writeFileSync(launcherScript, readFileSync(launcherScript, "utf8").replace(/^#!.*$/m, "#!" + join(nodePrefix, "bin/node")));
  writeFileSync(binary, '#!/bin/sh\nexec "' + join(nodePrefix, "bin/node") + '" "' + libexec + '/dist/bin.js" "$@"\n', { mode: 0o755 });
  if (staleArtifact) writeFileSync(join(["LICENSE", "README.md"].includes(staleArtifact) ? installedPrefix : libexec, staleArtifact), "stale artifact\n");
  if (tapMismatch) {
    writeFileSync(join(repository, "packages/cli/src/added.ts"), "export const added = 1;\n");
    expect(pinFormula({ root: repository, log: silent })).toBe(0);
  }
  if (tampered) {
    const meta = verifyArchive(repository);
    writeFileSync(join(repository, "Formula/sources", meta.archive), "tampered");
  }
  if (formulaSource) writeFileSync(join(repository, "Formula/htmlgate.rb"), formulaSource);
  if (readFailure) renameSync(join(repository, "Formula/htmlgate.rb"), join(repository, "Formula/missing.rb"));
  const calls: Call[] = [];
  const violations: string[] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  let merged = false;
  const run = (bin: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    calls.push([bin, args]);
    if (options.env.HOMEBREW_NO_AUTO_UPDATE !== "1") violations.push("automatic Homebrew update enabled");
    const operation = bin === "git" ? args.slice(2).join(" ") : args.join(" ");
    if (key([bin, args]) === failure || operation === failure) return fail();
    if (bin === "git") {
      expect(args.slice(0, 2)).toEqual(["-C", repository]);
      if (args[2] === "fetch") { expect(args.slice(2)).toEqual(["fetch", "--tags", "--prune", "origin"]); return ok(); }
      if (operation === "status --porcelain") return ok(dirty);
      if (operation === "rev-parse HEAD") return ok(relation === "equal" ? "remote" : merged ? mergedHead : "local");
      if (operation === "rev-parse origin/main") return ok("remote");
      if (operation === "merge-base --is-ancestor HEAD origin/main") return relation === "behind" ? ok() : fail();
      if (operation === "merge --ff-only origin/main") { merged = true; return ok(); }
      if (operation === "rev-parse --verify --quiet refs/tags/" + tag + "^{commit}") return ok("b".repeat(40));
      if (args[2] === "diff") {
        expect(args.slice(2)).toEqual(["diff", "--exit-code", tag + "^{commit}", "--", "Formula/htmlgate.rb",
          "Formula/sources/" + formulaMetadata(readFileSync(join(repository, "Formula/htmlgate.rb"), "utf8")).archive,
          "packages/cli/LICENSE", "packages/cli/README.md", "packages/cli/package.json", "packages/cli/src", "packages/cli/tsconfig.json"]);
        return staleTag ? fail() : ok();
      }
    }
    if (bin === "brew") {
      if (operation === "--version") return absent ? { ...fail(), error: new Error("ENOENT") } : ok("Homebrew 7");
      if (operation === "tap") return ok(tapped ? tap : "");
      if (operation === "tap " + tap + " https://github.com/mneves75/htmlgate.git") return ok();
      if (operation === "--repository " + tap) return ok(repository);
      if (operation === "list --formula --full-name") return ok(installed ? formula : "node");
      if (operation === (installed ? "upgrade " : "install ") + formula) return ok();
      // One formula, never `--installed`: that dumps every installed formula and cask and overflows the buffer.
      if (operation === "info --json=v2 " + formula) return ok(JSON.stringify({ formulae: [{ full_name: formula, linked_keg: linked, installed: [{ version: receipt }] }] }));
      if (operation === "--prefix") return ok(prefix);
      if (operation === "--prefix " + formula) return ok(installedPrefix);
      if (operation === "--prefix node") return ok(nodePrefix);
    }
    if (bin === "which") return { ...ok(noPath ? "" : paths || binary + "\n/old/npm/bin/htmlgate\n"), status: pathStatus };
    if (bin === binary && args[0] === "--version" && version !== cli.version) return ok(version);
    if (bin === process.execPath || bin === binary) return spawnSync(bin, args, options);
    violations.push("Unexpected command " + key([bin, args]));
    return fail();
  };
  const code = installCli({ root: dir, run, log: (s: string) => lines.push(s), error: (s: string) => errors.push(s) });
  expect(violations).toEqual([]);
  return { code, calls, out: lines.join("\n"), err: errors.join("\n"), binary, prefix, repository };
}

describe("the CLI Homebrew installer", () => {
  test("an untapped machine fast-forwards, installs and verifies real built artifacts and PATH", () => {
    const r = execute();
    expect(r.code, r.err).toBe(0);
    expect(r.calls.some(([bin, args]) => bin === r.binary && args[0] === "--help")).toBe(true);
    expect(r.out).toContain("installed " + cli.version + "; expected " + cli.version);
  });
  test("a tapped machine at origin/main upgrades and verifies", () => expect(execute({ tapped: true, installed: true, relation: "equal" }).code).toBe(0));
  test("absent brew stops immediately", () => {
    const r = execute({ absent: true });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Homebrew.*not available/);
    expect(r.calls).toEqual([["brew", ["--version"]]]);
  });
  test.each([" M Formula/htmlgate.rb\n", "?? extra.ts\n"])("a dirty tap %j is never discarded", (dirty) => {
    const r = execute({ dirty });
    expect(r.code).toBe(1); expect(r.err).toMatch(/not clean/); expect(r.err).toContain(r.repository);
    expect(r.calls.some(([, args]) => args.includes("--ff-only"))).toBe(false);
  });
  test.each(["ahead", "diverged"])("a %s tap stops without discarding commits", (relation) => {
    const r = execute({ relation }); expect(r.code).toBe(1); expect(r.err).toMatch(/not an ancestor/); expect(r.err).toContain(r.repository);
  });
  test("an unsuccessful fast-forward stops", () => {
    const r = execute({ mergedHead: "local" }); expect(r.code).toBe(1); expect(r.err).toMatch(/after fast-forward/);
  });
  test("unreadable or missing release tags stop before install", () => {
    const r = execute({ failure: "rev-parse --verify --quiet refs/tags/" + tag + "^{commit}" });
    expect(r.code).toBe(1); expect(r.err).toContain("Release tag " + tag);
    expect(r.calls.some(([, args]) => args[0] === "install" || args[0] === "upgrade")).toBe(false);
  });
  test("a stale release tag cannot bless a new formula/archive", () => {
    const r = execute({ staleTag: true }); expect(r.code).toBe(1); expect(r.err).toMatch(/tag.*candidate/i);
  });
  test("the tap archive must equal the selected candidate", () => {
    const r = execute({ tapMismatch: true }); expect(r.code).toBe(1); expect(r.err).toMatch(/archive.*candidate/i);
  });
  test("tampered archive stops before compilation or install", () => {
    const r = execute({ tampered: true }); expect(r.code).toBe(1); expect(r.err).toMatch(/SHA-256/);
    expect(r.calls.some(([bin, args]) => bin === process.execPath || args[0] === "install")).toBe(false);
  });
  test.each(["version", "revision", "duplicate"])("malformed formula %s stops before install", (field) => {
    const text = field === "version" ? source.replace(/^  version .*$/m, '  version "9.0.0"')
      : field === "revision" ? source.replace("  revision 1", "  revision 2") : source + '  version "0.1.0"\n';
    const r = execute({ formulaSource: text }); expect(r.code).toBe(1); expect(r.err).toMatch(/Formula|formula/);
  });
  test("a failed formula read stops", () => expect(execute({ readFailure: true }).code).toBe(1));
  test.each(["0.1.0", "0.1.0_2", "0.1.0-beta.13"])("a same-version or stale receipt %s is refused", (receipt) => {
    const r = execute({ receipt }); expect(r.code).toBe(1); expect(r.err).toMatch(/receipt/i);
  });
  test("an unlinked expected receipt is refused", () => {
    const r = execute({ linked: "0.1.0" }); expect(r.code).toBe(1); expect(r.err).toMatch(/receipt/i);
  });
  test.each(["dist/bin.js", "dist/api.js", "package.json"])("a stale installed %s fails despite a matching product version", (staleArtifact) => {
    const r = execute({ staleArtifact }); expect(r.code).toBe(1); expect(r.err).toContain(staleArtifact); expect(r.err).toMatch(/artifact/i);
  });
  test.each(["LICENSE", "README.md"])("a stale keg-root metafile %s fails despite a matching product version", (staleArtifact) => {
    const r = execute({ staleArtifact }); expect(r.code).toBe(1); expect(r.err).toContain(staleArtifact); expect(r.err).toMatch(/metafile/i);
  });
  test("a version mismatch stops before PATH", () => {
    const r = execute({ version: "0.1.0-beta.12" }); expect(r.code).toBe(1); expect(r.err).toMatch(/version mismatch/i);
  });
  test("a shadow CLI is refused even at the same version", () => {
    const r = execute({ paths: "/unrelated/bin/htmlgate\n" }); expect(r.code).toBe(1);
    expect(r.err).toContain("/unrelated/bin/htmlgate"); expect(r.err).toContain("npm uninstall -g @htmlgate/cli");
  });
  test.each([{ noPath: true }, { pathStatus: 1 }])("missing PATH fails (%j)", (options) => {
    const r = execute(options); expect(r.code).toBe(1); expect(r.err).toMatch(/Homebrew.*bin.*not on PATH/i);
  });
  test.each(["tap", "tap " + tap + " https://github.com/mneves75/htmlgate.git", "--repository " + tap,
    "fetch --tags --prune origin", "status --porcelain", "rev-parse HEAD", "rev-parse origin/main",
    "merge-base --is-ancestor HEAD origin/main", "merge --ff-only origin/main",
    "list --formula --full-name", "install " + formula, "upgrade " + formula,
    "info --json=v2 " + formula, "--prefix", "--prefix " + formula, "--prefix node",
  ])("failed %s stops immediately", (failure) => {
    const r = execute({ failure, installed: failure.startsWith("upgrade") });
    expect(r.code).toBe(1); expect(r.err).toContain("controlled command failure");
    expect(r.calls.at(-1)![1].join(" ")).toContain(failure);
  });
});

describe("installation documentation", () => {
  test.each(["README.md", "packages/cli/README.md"])("%s distinguishes Homebrew from the npm alternative", (file) => {
    const text = readFileSync(file, "utf8");
    expect(text).toContain("Homebrew is the install path on macOS.");
    expect(text).toContain("Do not install both the Homebrew and npm versions.");
    expect(text).toContain("For machines without Homebrew,");
    expect(text.indexOf("brew install")).toBeLessThan(text.indexOf("npm install -g ./packages/cli"));
    expect(text).toContain("npm uninstall -g @htmlgate/cli");
  });
});
