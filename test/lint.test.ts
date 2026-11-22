import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
// @ts-expect-error plain JavaScript module
import { lintRepo, lintSource } from "../scripts/lint.mjs";
// @ts-expect-error plain JavaScript module
import { checkVersionSync, syncVersion } from "../scripts/sync-version.mjs";

describe("repository structural lint", () => {
  test("passes cleanly on the current repository", () => {
    expect(lintRepo(process.cwd())).toEqual([]);
  });

  test("no-raw-response catches commit d6794f6 (card image calling new Response outside src/http.ts) and unwrapped landing responses", () => {
    const hits = lintSource("src/index.ts", 'export function card(b: Uint8Array) { return new Response(b, { headers: { "content-type": "image/jpeg" } }); }');
    expect(hits.map((h: { rule: string }) => h.rule)).toContain("no-raw-response");
    expect(hits[0].message).toContain("./http");

    const siteHits = lintSource("site/src/worker.ts", 'export default { async fetch() { return new Response("Method not allowed\\n", { status: 405 }); } };');
    expect(siteHits.map((h: { rule: string }) => h.rule)).toContain("no-raw-response");
    expect(siteHits[0].message).toContain("withHeaders");
  });

  test("no-unsafe-fetch catches missing redirect/signal at call sites and inside bench.send() and smoke.paced()", () => {
    const missingRedirect = lintSource("scripts/smoke.mjs", 'async function x() { return paced("https://a.example/zip", { headers: { authorization: "Bearer t" } }); }');
    expect(missingRedirect.map((h: { rule: string }) => h.rule)).toContain("no-unsafe-fetch");
    expect(missingRedirect[0].message).toContain('redirect: "manual"');

    const missingSignal = lintSource("packages/cli/src/api.ts", 'async function x() { return fetch("https://a.example", { redirect: "manual" }); }');
    expect(missingSignal.map((h: { rule: string }) => h.rule)).toContain("no-unsafe-fetch");
    expect(missingSignal[0].message).toContain("signal");

    const droppedBenchInit = lintSource("scripts/bench.ts", "async function send(url: string, init: RequestInit) { return fetch(url); }");
    expect(droppedBenchInit.map((h: { rule: string }) => h.rule)).toContain("no-unsafe-fetch");

    const replacedBenchInit = lintSource("scripts/bench.ts", "async function send(url: string, init: RequestInit) { return fetch(url, {}); }");
    expect(replacedBenchInit.map((h: { rule: string }) => h.rule)).toContain("no-unsafe-fetch");

    const droppedSmokeDeadline = lintSource("scripts/smoke.mjs", "async function paced(url, init) { return fetch(url, { ...init }); }");
    expect(droppedSmokeDeadline.map((h: { rule: string }) => h.rule)).toContain("no-unsafe-fetch");
    expect(droppedSmokeDeadline[0].message).toContain("signal");

    const undefinedSmokeDeadline = lintSource("scripts/smoke.mjs", "async function paced(url, init) { return fetch(url, { ...init, signal: undefined }); }");
    expect(undefinedSmokeDeadline.map((h: { rule: string }) => h.rule)).toContain("no-unsafe-fetch");
  });

  test("no-unpaginated-cf-list catches direct cf applications/workers/buckets list outside scripts/setup.mjs helpers", () => {
    const hits = lintSource("scripts/site-deploy.mjs", 'export function checkTarget(cf) { return cf("zero-trust", "access", "applications", "list", "--per-page", "1000"); }');
    expect(hits.map((h: { rule: string }) => h.rule)).toContain("no-unpaginated-cf-list");
    expect(hits[0].message).toContain("listApplications");
  });

  test("no-cf-destructive-without-force catches cf delete and revoke-tokens omitting --force", () => {
    const hits = lintSource("scripts/token.mjs", 'function r(id) { return cf("zero-trust", "access", "applications", "revoke-tokens", id); }');
    expect(hits.map((h: { rule: string }) => h.rule)).toContain("no-cf-destructive-without-force");
    expect(hits[0].message).toContain("--force");
  });

  test("no-brew-info-installed catches commit a2a2ffc (brew info --installed buffer overflow)", () => {
    const hits = lintSource("scripts/cli-install.mjs", 'const r = command("brew", ["info", "--json=v2", "--installed", FORMULA]);');
    expect(hits.map((h: { rule: string }) => h.rule)).toContain("no-brew-info-installed");
    expect(hits[0].message).toContain("single formula");
  });

  test("no-unvalidated-env-number catches commit c66b143 (raw Number(process.env.X) becoming NaN)", () => {
    const hits = lintSource("scripts/smoke.mjs", "const GAP_MS = Number(process.env.HTMLGATE_LIVE_GAP_MS ?? 600);");
    expect(hits.map((h: { rule: string }) => h.rule)).toContain("no-unvalidated-env-number");
    expect(hits[0].message).toContain("Number.isFinite");
  });

  test("no-access-identity-bypass catches ctx.access and unverified Access headers (issue #18)", () => {
    const hits = lintSource("src/index.ts", 'export function who(req: Request, ctx: { access?: string }) { return ctx.access ?? req.headers.get("cf-access-authenticated-user-email"); }');
    expect(hits.filter((h: { rule: string }) => h.rule === "no-access-identity-bypass")).toHaveLength(2);
    expect(hits[0].message).toContain("src/access.ts");
  });

  test("no-any-or-ts-suppression catches explicit any and @ts-ignore in source", () => {
    const hits = lintSource("src/api.ts", "// @ts-ignore\nexport function f(x: any) { return x; }");
    expect(hits.filter((h: { rule: string }) => h.rule === "no-any-or-ts-suppression")).toHaveLength(2);
  });

  test("no-proto-pollutable-dict catches {} in queryFields and parseMetadata", () => {
    const apiHits = lintSource("src/api.ts", "function queryFields() { const metadata: Record<string, string> = {}; return metadata; }");
    expect(apiHits.map((h: { rule: string }) => h.rule)).toContain("no-proto-pollutable-dict");
    expect(apiHits[0].message).toContain("Object.create(null)");

    const cliHits = lintSource("packages/cli/src/files.ts", "export function parseMetadata() { const out: Record<string, string> = {}; return out; }");
    expect(cliHits.map((h: { rule: string }) => h.rule)).toContain("no-proto-pollutable-dict");
  });

  test("version-in-sync catches drift across packages, pages and formula, and syncVersion fixes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "htmlgate-ver-sync-"));
    try {
      for (const rel of [
        "package.json",
        "packages/cli/package.json",
        "src/version.ts",
        "Formula/htmlgate.rb",
        "site/public/index.html",
        "site/public/en/index.html",
        "site/public/privacidade/index.html",
        "site/public/en/privacy/index.html",
        "site/public/404.html",
      ]) {
        cpSync(join(process.cwd(), rel), join(dir, rel), { recursive: true });
      }
      expect(checkVersionSync(dir).mismatches).toEqual([]);
      writeFileSync(join(dir, "site/public/404.html"), readFileSync(join(dir, "site/public/404.html"), "utf8").replace(/<span class="version">[^<]+<\/span>/, '<span class="version">0.0.0</span>'));
      const drifted = checkVersionSync(dir);
      expect(drifted.mismatches).toHaveLength(1);
      expect(drifted.mismatches[0]).toContain("site/public/404.html");
      syncVersion(dir);
      expect(checkVersionSync(dir).mismatches).toEqual([]);

      const beforePkg = readFileSync(join(dir, "package.json"), "utf8");
      writeFileSync(join(dir, "site/public/404.html"), "<!doctype html><html><body>no span</body></html>");
      expect(() => syncVersion(dir, "9.9.9")).toThrow(/site\/public\/404\.html/);
      expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(beforePkg);

      cpSync(join(process.cwd(), "site/public/404.html"), join(dir, "site/public/404.html"));
      writeFileSync(join(dir, "packages/cli/package.json"), '{ "version": "0.1.0", broken');
      expect(() => syncVersion(dir, "9.9.9")).toThrow();
      expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(beforePkg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
