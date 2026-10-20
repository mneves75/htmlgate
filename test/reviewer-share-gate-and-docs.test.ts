// Independent review of plan 011: the mutation list only renamed, the shipped documents say what they mean, and a
// case-insensitive scan finds no former name where the plan's Acceptance 1 says there is none.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const root = process.cwd();
type Entry = [name: string, file: string, anchor: string, replacement: string, test: string];

/** The mutation table of a mutate.mjs text, read as data (never imported, so nothing runs). */
function entries(source: string): Entry[] {
  const start = source.indexOf("const MUTATIONS = [");
  const end = source.indexOf("\n];", start);
  return new Function(`return ${source.slice(start + "const MUTATIONS = ".length, end + 3)}`)() as Entry[];
}
const rename = (s: string) => s.replace(/Drops/g, "Shares").replace(/Drop/g, "Share").replace(/drops/g, "shares").replace(/drop/g, "share").replace(/DROP_/g, "SHARE_").replace(/DROPS/g, "SHARES");

describe("scripts/mutate.mjs preserves the renamed base and every explicitly added control", () => {
  const history = readFileSync(join(root, "test/fixtures/pre-share-mutations.json"), "utf8");
  const before = JSON.parse(history) as Entry[];
  const after = entries(readFileSync(join(root, "scripts/mutate.mjs"), "utf8"));
  // The old Git-revision guard is replaced by formula/archive equality; six archive/metadata/receipt/artifact guards are added.
  const added: Entry[] = [
    ["Homebrew accepts a CLI version mismatch", "scripts/cli-install.mjs", "if (actual !== version) throw new Error(`CLI version mismatch:", "if (false) throw new Error(`CLI version mismatch:", "test/cli-brew.test.ts"],
    ["Homebrew installs without refreshing its tap", "scripts/cli-install.mjs", '    command("git", ["-C", repository, "fetch", "--tags", "--prune", "origin"]);', '', "test/cli-brew.test.ts"],
    ["Homebrew installs when brew is absent", "scripts/cli-install.mjs", "if (available.error || available.status !== 0) {", "if (false) {", "test/cli-brew.test.ts"],
    ["Homebrew installs without the release tag in its tap", "scripts/cli-install.mjs", '      command("git", ["-C", repository, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);', '', "test/cli-brew.test.ts"],
    ["Homebrew accepts a formula/archive candidate mismatch", "scripts/cli-install.mjs", "if (!archive.equals(expectedArchive) || source !== selectedSource || verified.version !== version) {", "if (false) {", "test/cli-brew.test.ts"],
  ["an Instance without its write limit takes changes", "src/api.ts", '    if (!env.WRITE_LIMIT) return fail(503, "server_misconfigured", "This Instance is missing its write limit. The Operator must run setup.");\n', "", "test/launch-audit.test.ts"],
  ["a request of fields alone may be as large as a page", "src/api.ts", "fieldsOnly ? MAX_FIELDS_BYTES : MAX_REQUEST_BYTES", "MAX_REQUEST_BYTES", "test/launch-audit.test.ts"],
  ["a failed purge stops the trash from being emptied", "src/index.ts", '        console.error("scheduled", name, e);\n        failures.push(e);', '        console.error("scheduled", name, e);\n        throw e;', "test/launch-audit.test.ts"],
  ["a sign-in failure logs the token", "src/access.ts", 'e instanceof Error ? e.message : "");', 'e instanceof Error ? e.message : "", token);', "test/launch-audit.test.ts"],
  ["setup deploys uncommitted source", "scripts/setup.mjs", "  if (dirty) throw new Error(", "  if (false) throw new Error(", "test/launch-audit.test.ts"],
  ["the visibility switch takes unknown fields", "src/api.ts", "Object.keys(body).length !== 1", "false", "test/redteam.test.ts"],
  ["the landing cannot play its own video", "site/src/worker.ts", `media-src 'self'; `, "", "test/site.test.ts"],
  ["ZIP publishing loses literal metadata keys","src/api.ts","const metadata: Record<string, string> = Object.create(null);","const metadata: Record<string, string> = {};","test/sites.test.ts"],
  ["ZIP publishing ignores an unknown prototype field","src/api.ts","const out: Record<string, unknown> = Object.create(null);","const out: Record<string, unknown> = {};","test/sites.test.ts"],
  ["setup skips ownership before remote writes","scripts/setup.mjs","const owned = checkOwnership(inst, db, listWorkers(cf), listApplications());","const owned = { worker: listWorkers(cf).find((w) => w.name === inst.name), app: listApplications().find((a) => a.name === `htmlgate: ${inst.name}`) };","test/setup-ownership.test.ts"],
  ["setup accepts a foreign Access destination","scripts/setup.mjs","throw new Error(\"Access application does not uniquely belong to this Instance's Worker.\");","void 0;","test/setup-ownership.test.ts"],
  ["setup ignores active storage bindings","scripts/setup.mjs","throw new Error(\"Active Worker bindings do not belong to this Instance.\");","void 0;","test/setup-ownership.test.ts"],
  ["setup inspects only one traffic-serving version","scripts/setup.mjs","for (const version of versions.filter((v) => v.percentage > 0)) {","for (const version of versions.filter((v) => v.percentage > 0).slice(0, 1)) {","test/setup-ownership.test.ts"],
  ["setup adopts an unmarked or open bootstrap","scripts/setup.mjs","throw new Error(\"Worker is not a marked closed htmlgate bootstrap; cannot establish Instance ownership.\");","void 0;","test/setup-ownership.test.ts"],
  ["setup omits the bootstrap marker","scripts/setup.mjs","vars: { ...vars, HTMLGATE_INSTANCE: inst.name },","vars,","test/setup-ownership.test.ts"],
  ["setup accepts an incomplete active deployment","scripts/setup.mjs","throw new Error(\"Missing or malformed active deployment; cannot establish Instance ownership.\");","void 0;","test/setup-ownership.test.ts"],
  ["setup reads only the first Access application page","scripts/setup.mjs","if (!batch.length) return all;","if (batch.length >= 0) return all.concat(batch);","test/setup-ownership.test.ts"],
  ["setup reuses a public managed bucket domain","scripts/setup.mjs","managed?.enabled !== false","false","test/setup-ownership.test.ts"],
  ["setup reuses public or unknown custom bucket domains","scripts/setup.mjs","!Array.isArray(custom?.domains) || custom.domains.some((d) => !d || d.enabled !== false)","false","test/setup-ownership.test.ts"],
  ["smoke accepts a cleartext Access redirect","scripts/smoke.mjs","to?.protocol === \"https:\"","true","test/reviewer-release-tools.test.ts"],
  ["smoke accepts Access text outside the team hostname","scripts/smoke.mjs","/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.cloudflareaccess\\.com$/.test(to.hostname)","true","test/reviewer-release-tools.test.ts"],
  ["smoke accepts credentials or a port in an Access redirect","scripts/smoke.mjs","&& !to.username && !to.password && !to.port","","test/reviewer-release-tools.test.ts"],
  ["smoke leaves fetch and body reads unbounded","scripts/smoke.mjs","return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });","return fetch(url, init);","test/reviewer-release-tools.test.ts"],
  ["the mutation reporter certifies mixed skipped controls","scripts/mutation-reporter.mjs","typeof t.name !== \"string\" || ![\"passed\", \"failed\"].includes(t.state)","typeof t.name !== \"string\" || ![\"passed\", \"failed\", \"skipped\"].includes(t.state)","test/mutation-reporter.test.ts"],
  ["setup creates a database before R2 safety discovery","scripts/setup.mjs","  step(\"finding or creating the R2 bucket\");","  if (freshDb) sh(WRANGLER, [\"d1\", \"create\", dbName]);\n  step(\"finding or creating the R2 bucket\");","test/setup-ownership.test.ts"],
  ["setup ignores malformed competing Access destinations","scripts/setup.mjs","if (!validDestinations) throw new Error(\"Malformed Access destinations; cannot establish Instance ownership.\");","if (false) throw new Error(\"Malformed Access destinations; cannot establish Instance ownership.\");","test/setup-ownership.test.ts"],
  ["setup reads only the first R2 bucket page","scripts/setup.mjs","if (!buckets.length) return all;","return all.concat(buckets);","test/setup-ownership.test.ts"],
  ["setup accepts non-advancing or duplicate R2 bucket names","scripts/setup.mjs","if (bucket.name <= after) throw new Error(\"R2 bucket names are ambiguous or not advancing.\");","if (false) throw new Error(\"R2 bucket names are ambiguous or not advancing.\");","test/setup-ownership.test.ts"],
  ["Homebrew accepts corrupted source archive bytes","scripts/cli-archive.mjs","if (digest(archive) !== metadata.sha256) throw new Error(","if (false) throw new Error(","test/cli-brew.test.ts"],
  ["Homebrew accepts stale source archive inputs","scripts/cli-archive.mjs","if (!archive.equals(buildArchive(join(root, \"packages/cli\")))) throw new Error(","if (false) throw new Error(","test/cli-brew.test.ts"],
  ["Homebrew accepts an old or unlinked rebuild receipt","scripts/cli-install.mjs","if (info?.full_name !== FORMULA || info.linked_keg !== expectedVersion ||\n        !Array.isArray(info.installed) || !info.installed.some((entry) => entry.version === expectedVersion)) {","if (false) {","test/cli-brew.test.ts"],
  ["Homebrew accepts stale installed artifact bytes","scripts/cli-install.mjs","        throw new Error(`Installed artifact mismatch: ${name}`);","","test/cli-brew.test.ts"],
  ["Homebrew accepts a release tag with different candidate inputs","scripts/cli-install.mjs","      command(\"git\", [\"-C\", repository, \"diff\", \"--exit-code\", `${tag}^{commit}`, \"--\",\n        \"Formula/htmlgate.rb\", `Formula/sources/${verified.archive}`, ...CLI_INPUTS.map((name) => `packages/cli/${name}`)]);","","test/cli-brew.test.ts"],
  ["Homebrew accepts duplicate formula metadata","scripts/cli-archive.mjs","if (lines.length !== 1 || declarations !== expected) throw new Error(","if (false) throw new Error(","test/cli-brew.test.ts"],
  ["setup accepts a project inside another Git checkout","scripts/setup.mjs","if (realpathSync(root) !== realpathSync(ROOT)) {","if (false) {","test/reviewer-launch-audit-docs.test.ts"],
    ["a Viewer reads the page counts","src/index.ts",'    // The Author only, like the token page: how often each of this Instance\'s Shares was opened.\n    if (!isAuthor) return lost();','    // The Author only, like the token page: how often each of this Instance\'s Shares was opened.',"test/metrics.test.ts"],
    ["raw bytes count as a view","src/index.ts",'  if (raw || res.status !== 200) return res;','  if (res.status !== 200) return res;',"test/metrics.test.ts"],
    ["a prefetch counts as a view","src/index.ts",'  if (req.headers.get("sec-fetch-dest") !== "document" || req.headers.has("sec-purpose")) return res;','  if (req.headers.get("sec-fetch-dest") !== "document") return res;',"test/metrics.test.ts"],
    ["a count outlives the Share it belongs to","src/store.ts",'        WHERE EXISTS (SELECT 1 FROM shares WHERE slug = ?1 AND ${live()})','        WHERE 1',"test/store-sites-expiry.test.ts"],
    ["a Gated Share's link unfurls too","src/pages.ts",'prefix === "p" && d.public === 1 && origin !== ""','origin !== ""',"test/social.test.ts"],
    ["the card image needs a sign-in","scripts/setup.mjs",', "/og.jpg"]',']',"test/social.test.ts"],
    ["an expired Share keeps its counts","src/store.ts",'      this.db.prepare(`DELETE FROM share_views WHERE slug IN (${due})`).bind(now, CLEANUP_BATCH),\n      this.db.prepare(`DELETE FROM versions WHERE slug IN (${due})`).bind(now, CLEANUP_BATCH),','      this.db.prepare(`DELETE FROM versions WHERE slug IN (${due})`).bind(now, CLEANUP_BATCH),\n      this.db.prepare(`DELETE FROM share_views WHERE slug IN (${due})`).bind(now, CLEANUP_BATCH),',"test/store-sites-expiry.test.ts"],
  ];
  const base = after.slice(0, before.length);

  test("229 controls: the immutable 182-entry base plus explicitly listed release controls", () => {
    expect(before).toHaveLength(182);
    expect(createHash("sha256").update(history).digest("hex")).toBe("659fa0b319ae9a82381cabfc7c993557f8231ebd0f2853e0300e51375aa9732e");
    expect(after).toHaveLength(before.length + added.length);
    expect(after.slice(before.length)).toEqual(added);
    base.forEach((e, i) => {
      expect(e[1], e[0]).toBe(before[i]![1]);
      expect(e[4], e[0]).toBe(before[i]![4]);
      expect(existsSync(join(root, e[1])), e[1]).toBe(true);
      expect(existsSync(join(root, e[4])), e[4]).toBe(true);
    });
    for (const e of added) {
      expect(existsSync(join(root, e[1])), e[1]).toBe(true);
      expect(existsSync(join(root, e[4])), e[4]).toBe(true);
    }
  });

  test("every anchor and replacement is the old one with the words renamed, but for nine listed entries; none became a no-op", () => {
    const differing = base.map((e, i) => [e, before[i]!] as const).filter(([a, b]) => JSON.stringify(a) !== JSON.stringify(b.map(rename)));
    // Words that are not our term: "drops the Share's other tags" (verb) and the /d/ -> /s/ path letter in four entries
    // and one that keeps the "d" prefix as an argument.
    expect(differing.map(([a]) => a[0])).toEqual([
      "a matched upsert drops the Share's other tags",
      "an expired ticket's navigation is not sent back through the gate",
      "every visitor sees the Erase control",
      "paths match loosely",
      "public paths serve Gated Shares",
      "a Share title on the home is not escaped",
      // The limit's condition lost its `&& env.WRITE_LIMIT` when a missing limit began to refuse changes.
      "no rate limit",
      // The landing gained a film section, so its CSP gained `media-src 'self'`.
      "the landing loses its CSP",
      // A second route now refuses a Viewer, so this anchor keeps the GET line that only the token route has.
      "a Viewer reaches the token page",
      // The page-view counter hangs off the same `if`, so removing the line left an orphan `else if` and the site
      // module failed to load; the replacement now keeps the branch and drops only the header.
      "the landing preview is indexable",
    ].sort((x, y) => after.findIndex((e) => e[0] === x) - after.findIndex((e) => e[0] === y)));
    for (const [a, b] of differing) {
      // The planted violation is the same one: the replacement still differs from the anchor, and the only change from
      // the old pair is the letter of the gated path prefix.
      expect(a[3], a[0]).not.toBe(a[2]);
      if (a[0] === "no rate limit") {
        // Still the same violation: the whole limit block is skipped.
        expect(a[2]).toContain('if (method !== "GET") {');
        expect(a[3]).toContain("if (false) {");
        continue;
      }
      if (a[0] === "the landing loses its CSP") {
        // Still the same violation: the whole header line is removed; the anchor only gained the video source.
        expect(a[3]).toBe("");
        expect(a[2]).toBe(rename(b[2]).replace("img-src 'self'; ", "img-src 'self'; media-src 'self'; "));
        continue;
      }
      if (a[0] === "a Viewer reaches the token page") {
        // Still the same violation: the author check is removed whole. The anchor now also carries the GET line, because
        // the metrics route refuses a Viewer with the same statement and an anchor must match once.
        const get = 'if (req.method === "GET" && path === "/tokens") return html(200, tokensPage(visitor, await store.listTokens(cfg.author)));';
        expect(a[2], a[0]).toBe(rename(b[2]) + "\n    " + get);
        expect(a[3], a[0]).toBe(get);
        continue;
      }
      expect(a[2].replaceAll('"s"', '"d"').replaceAll("/s/", "/d/").replaceAll("(s|p)", "(d|p)").replace("drops", "shares"), a[0]).toBe(rename(b[2]).replaceAll("shares the Share's", "shares the Share's"));
    }
  });

  test("a mutation never plants nothing: replacement differs from anchor in all entries", () => {
    for (const e of after) expect(e[3], e[0]).not.toBe(e[2]);
  });
});

describe("the shipped documents do not change an English verb into the term", () => {
  test("docs/operator.md tells the Operator to drop the legacy table, not to 'Share it'", () => {
    const text = readFileSync(join(root, "docs/operator.md"), "utf8");
    expect(text.includes("Nothing reads it. Share it when you no longer need them"), "operator.md says 'Share it' where the verb 'Drop it' stood").toBe(false);
    expect(text).toContain("DROP TABLE versions_d1_legacy");
  });

  test("no sentence in a shipped document starts with 'Share it', 'Share them' or 'Share this' as an instruction about a table or file", () => {
    for (const f of ["README.md", "docs/operator.md", "docs/privacy.md", "DESIGN.md", "skills/htmlgate/SKILL.md", "packages/cli/README.md"]) {
      const text = readFileSync(join(root, f), "utf8");
      expect(/(^|[.:] )Share (it|them|this|that) when/m.test(text), f).toBe(false);
    }
  });
});

const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
describe("a case-insensitive scan of what ships", () => {
  const shipped = [
    ...["src", "packages/cli/src", "scripts", "site/public", "skills", "migrations"].flatMap((d) => walk(join(root, d))),
    ...["README.md", "GLOSSARY.md", "DESIGN.md", "AGENTS.md", "PRODUCT.md", "docs/operator.md", "docs/privacy.md", "packages/cli/README.md", "packages/cli/package.json", "package.json", "wrangler.jsonc"].map((f) => join(root, f)),
  ].filter((f) => !/migrations\/000[1-4]/.test(f) && !/0005_shares\.sql$/.test(f));
  // SQL DROP, English verbs and the explicit "its name before 0.1" note are not our term.
  const allowed = (line: string) => /DROP (TABLE|INDEX)|\bdrops? (the|a|it|them|whatever|that|this)\b|\bdropped\b|\bdropping\b|Drop \(its name before 0\.1\)|drops a ground-colored|drops the Share's other tags|drops the table|\bDrop it\b|\.drop\(/i.test(line) && !/\bdrops?_?(by|slug)|\/api\/drops|\/d\//i.test(line);

  test("no former name (any case) remains in the files Acceptance 1 lists, plus PRODUCT.md, AGENTS.md and the CLI package metadata", () => {
    const hits: string[] = [];
    for (const f of shipped) {
      const text = readFileSync(f, "utf8");
      if (text.includes("\0")) continue;
      text.split("\n").forEach((line, i) => {
        if (/drop/i.test(line) && !allowed(line)) hits.push(`${relative(root, f)}:${i + 1}: ${line.trim().slice(0, 110)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
