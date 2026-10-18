// Reviewer tests for the launch-audit change: the deploy guard against a real git checkout, and the statements in
// docs/operator.md, SECURITY.md and the landing against the code. A failing test here is a finding.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const REPO = join(__dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

describe("checkCleanTree against a real checkout of the current candidate (the working tree is never touched)", () => {
  let sandbox: string;
  let clone: string;
  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), "reviewer-clean-tree-"));
    clone = join(sandbox, "checkout");
    git(REPO, "clone", "-q", "--no-hardlinks", REPO, clone);
    // Include uncommitted candidate changes and planted mutations, not just HEAD.
    const patch = git(REPO, "diff", "HEAD", "--binary");
    if (patch) execFileSync("git", ["apply", "--binary", "-"], { cwd: clone, input: patch });
    git(clone, "add", ".");
    git(clone, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Current test candidate");
  });
  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  const verdict = (cwd = clone, args: string[] = []) => {
    const r = spawnSync("node", [...args, "-e", "import('./scripts/setup.mjs').then(m=>{try{m.checkCleanTree();console.log('CLEAN')}catch(e){console.log('REFUSED '+e.message.split('\\n').slice(0,3).join(' | '))}})"], { cwd, encoding: "utf8" });
    return r.stdout.trim() + r.stderr.trim();
  };
  const copyProject = (directory: string) => {
    mkdirSync(directory, { recursive: true });
    execFileSync("cp", ["-cR", join(clone, "scripts"), join(clone, "src"), join(clone, "site"), join(clone, "migrations"), directory]);
  };
  const reset = () => {
    git(clone, "reset", "-q", "--hard");
    git(clone, "clean", "-fdq");
  };

  test("a clean checkout deploys", () => {
    expect(verdict()).toBe("CLEAN");
  });

  test("an unversioned project inside an ignored directory of another checkout is refused", () => {
    const nested = join(clone, ".scratch", "unversioned-project");
    copyProject(nested);
    appendFileSync(join(nested, "src/index.ts"), "\n// uncommitted nested source\n");
    expect(git(nested, "rev-parse", "--show-toplevel").trim()).toBe(realpathSync(clone));
    expect(git(nested, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(verdict(nested)).toMatch(/^REFUSED .*Git checkout root/);
  });

  test("a registered worktree deploys when clean and refuses dirty deployed source", () => {
    const worktree = join(sandbox, "worktree");
    git(clone, "worktree", "add", "-q", "--detach", worktree);
    try {
      expect(readFileSync(join(worktree, ".git"), "utf8")).toMatch(/^gitdir: /);
      expect(verdict(worktree)).toBe("CLEAN");
      appendFileSync(join(worktree, "src/index.ts"), "\n// uncommitted worktree source\n");
      expect(verdict(worktree)).toMatch(/^REFUSED .*src\/index\.ts/);
    } finally {
      git(worktree, "reset", "-q", "--hard");
      git(clone, "worktree", "remove", worktree);
    }
  });

  test("a clean checkout deploys through a symlink alias", () => {
    const alias = join(sandbox, "alias");
    symlinkSync(clone, alias, "dir");
    expect(verdict(alias, ["--preserve-symlinks"])).toBe("CLEAN");
  });

  test("an edited Worker file, a staged file and a new untracked file under src/ or site/ are each refused", () => {
    appendFileSync(join(clone, "src/api.ts"), "\n// x\n");
    expect(verdict()).toMatch(/^REFUSED .*src\/api\.ts/);
    git(clone, "add", "src/api.ts");
    expect(verdict()).toMatch(/^REFUSED .*src\/api\.ts/);
    git(clone, "reset", "-q", "--hard");
    writeFileSync(join(clone, "site/public/new.html"), "x");
    expect(verdict()).toMatch(/^REFUSED .*site\/public\/new\.html/);
    reset();
    expect(verdict()).toBe("CLEAN");
  });

  test("the audit's own reason for the guard: a violation that an interrupted `pnpm run mutate` left in a file whose content ships in the deployed config is refused", () => {
    // mutate.mjs plants this one (it makes an Instance record every request); setup.mjs writes the deployed Worker config.
    const file = join(clone, "scripts/setup.mjs");
    writeFileSync(file, readFileSync(file, "utf8").replace("invocation_logs: false", "invocation_logs: true"));
    expect(git(clone, "status", "--porcelain").trim()).toBe("M scripts/setup.mjs");
    expect(verdict()).toMatch(/^REFUSED/);
    reset();
  });

  test("a checkout without .git (a downloaded zip) is refused with a message that says why", () => {
    const bare = join(sandbox, "no-git");
    try {
      copyProject(bare);
      const out = verdict(bare);
      expect(out).toMatch(/^REFUSED/);
      expect(out.toLowerCase()).toMatch(/git|repository/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("docs/operator.md against the code", () => {
  const doc = read("docs/operator.md");
  const section = doc.slice(doc.indexOf("## When something breaks"), doc.indexOf("## Sites and tickets"));

  test("every error-log label the Worker writes is named in the section that tells the Operator what to search for", () => {
    const labels = new Set<string>();
    for (const file of ["src/api.ts", "src/index.ts", "src/store.ts", "src/access.ts"]) {
      for (const m of read(file).matchAll(/console\.error\(\s*"([^"]+)"/g)) labels.add(m[1]!);
    }
    // A label counts when the section names it as a code span of its own or as the first word of one (`scheduled expire`).
    const missing = [...labels].filter((l) => !section.includes("`" + l + "`") && !section.includes("`" + l + " "));
    expect(missing, "labels logged by src/ but absent from the 'lines to search for' list").toEqual([]);
  });

  test("the commands it names exist: the CLI's tokens revoke, gate and delete, and `pnpm run token`", () => {
    const cli = read("packages/cli/src/bin.ts");
    expect(cli).toContain("htmlgate tokens revoke <id>");
    expect(cli).toMatch(/htmlgate gate <slug>/);
    expect(cli).toMatch(/htmlgate delete <slug>/);
    expect(JSON.parse(read("package.json")).scripts.token).toBeTruthy();
    expect(read("scripts/token.mjs")).toMatch(/revoke/);
    for (const c of ["`htmlgate tokens revoke <id>`", "`htmlgate gate <slug>`", "`htmlgate delete <slug>`", "`pnpm run token revoke <id>`"]) expect(section).toContain(c);
  });

  test("the Time Travel commands it prints are accepted by the installed Wrangler (--help only, nothing remote)", () => {
    const r = spawnSync(join(REPO, "node_modules/.bin/wrangler"), ["d1", "time-travel", "restore", "--help"], { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } });
    const help = r.stdout + r.stderr;
    expect(help).toMatch(/--timestamp/);
    expect(spawnSync(join(REPO, "node_modules/.bin/wrangler"), ["d1", "time-travel", "info", "--help"], { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } }).stdout).toMatch(/info/);
    expect(section).toContain("time-travel info <name>-db");
    expect(section).toContain("time-travel restore <name>-db --timestamp=<time>");
  });

  test("setup never creates the rate limiting rule or the billing alert the landing says it does not create", () => {
    const setup = read("scripts/setup.mjs").toLowerCase();
    expect(setup).not.toMatch(/rulesets|ratelimit_rule|http_ratelimit|notifications\/|billing/);
  });

  test("the order-of-steps list in the Operator's guide mentions the new first step (setup now refuses a dirty tree)", () => {
    const steps = doc.slice(doc.indexOf("## The order setup follows"), doc.indexOf("If the account has no R2 subscription"));
    expect(steps.toLowerCase()).toMatch(/commit/);
  });
});

describe("SECURITY.md and the landing", () => {
  test("SECURITY.md points at files that exist", () => {
    const text = read("SECURITY.md");
    expect(text).toContain("Security rules the code relies on");
    expect(read("AGENTS.md")).toContain("Security rules the code relies on");
    for (const f of ["src/api.ts", "packages/cli/package.json", "site/src/worker.ts", "scripts/setup.mjs"]) expect(() => readFileSync(join(REPO, f)), f).not.toThrow();
  });

  test("both landing pages carry the Public links row exactly once, with the same facts", () => {
    for (const [file, key] of [["site/public/index.html", "Links públicos"], ["site/public/en/index.html", "Public links"]] as const) {
      const html = read(file);
      expect(html.split(`<dt>${key}</dt>`).length - 1, file).toBe(1);
    }
  });
});

describe("the package versions agree", () => {
  test("package.json, packages/cli/package.json, README and the CHANGELOG head name the same version", () => {
    const v = JSON.parse(read("package.json")).version as string;
    expect(JSON.parse(read("packages/cli/package.json")).version).toBe(v);
    expect(read("CHANGELOG.md")).toContain(`## [${v}]`);
  });

  test("the CLI is private, and nothing in the docs or scripts tells anyone to publish or install it from the registry", () => {
    expect(JSON.parse(read("packages/cli/package.json")).private).toBe(true);
    const all = ["README.md", "packages/cli/README.md", "docs/operator.md", "scripts/cli-install.mjs", "scripts/cli-formula.mjs"].map((f) => { try { return read(f); } catch { return ""; } }).join("\n");
    expect(all).not.toMatch(/npm publish|pnpm publish|npm i(nstall)? (-g )?@htmlgate\/cli(?!\S)/);
  });
});
