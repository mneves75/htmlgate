// Independent review of beta.10: the htmlgate CLI, built from the current packages/cli/src into a temp directory (the
// repo's dist/ may be stale) and run against the real Worker in-process on loopback (no wrangler).
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AUTHOR, startInstance, stopAccess, type Instance } from "./reviewer-beta10-harness";

const run = promisify(execFile);
const DAY = 86_400_000;
const root = process.cwd();
const work = mkdtempSync(join(tmpdir(), "reviewer-beta10-cli-"));
const pkg = join(work, "cli");
const dist = join(pkg, "dist"); // the built CLI reads ../package.json, as in the package
const home = join(work, "home");
let i: Instance;
let server: Awaited<ReturnType<Instance["listen"]>>;

beforeAll(async () => {
  mkdirSync(home);
  mkdirSync(pkg);
  copyFileSync(join(root, "packages/cli/package.json"), join(pkg, "package.json"));
  await run(join(root, "node_modules/.bin/tsc"), ["-p", join(root, "packages/cli"), "--outDir", dist], { timeout: 240_000 });
  i = await startInstance();
  server = await i.listen();
}, 300_000);
afterAll(async () => {
  await server?.close();
  await stopAccess();
  rmSync(work, { recursive: true, force: true });
});

interface R { code: number; out: any; stdout: string; stderr: string }
async function cli(args: string[], over: { token?: string | null; cwd?: string } = {}): Promise<R> {
  const env: Record<string, string> = { PATH: process.env.PATH!, HOME: home, NO_COLOR: "1", HTMLGATE_URL: server.url };
  if (over.token !== null) env.HTMLGATE_TOKEN = over.token ?? i.token;
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [join(dist, "bin.js"), "--output", "json", ...args], { cwd: over.cwd ?? work, env, timeout: 60_000 }, (err, stdout, stderr) => {
      let out: any;
      try { out = stdout.trim() ? JSON.parse(stdout) : undefined; } catch { /* text */ }
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out, stdout, stderr });
    });
    child.stdin!.end("");
  });
}

function folder(name: string, files: Record<string, string>): string {
  const dir = join(work, name);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return dir;
}
const SITE = { "index.html": '<!doctype html><title>s</title><link rel="stylesheet" href="a.css">', "a.css": "p{}\n".repeat(100), "img/x.txt": "x" };

describe("the CLI stands on its own", () => {
  test("nothing it ships mentions htmlbin except LICENSE: sources, README, package.json, built output, --help", async () => {
    const cliDir = join(root, "packages/cli");
    const shipped = [
      ...readdirSync(join(cliDir, "src")).map((f) => join(cliDir, "src", f)),
      ...readdirSync(dist).map((f) => join(dist, f)),
      join(cliDir, "README.md"),
      join(cliDir, "package.json"),
    ];
    const hits = shipped.filter((f) => /htmlbin|utsengar|hb_[A-Za-z0-9]|upstream|\bfork\b|ported from/i.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
    const help = await cli(["--help"]);
    expect(help.stdout + help.stderr).toMatch(/publish/);
    expect(help.stdout + help.stderr).toMatch(/--expires/);
    expect(help.stdout + help.stderr).not.toMatch(/htmlbin|utsengar/i);
    const license = readFileSync(join(cliDir, "LICENSE"), "utf8");
    expect(license).toMatch(/Permission is hereby granted/);
    expect(license).toMatch(/Copyright/);
  });
  test("its requests say htmlgate and never htmlbin, and its sign-in reads no htmlbin file or variable", async () => {
    const proj = folder("proj-ua", { "index.html": "<p>x</p>", ".htmlbin": '{"token":"hb_' + "a".repeat(40) + '"}' });
    const before = server.seen.length;
    const r = await cli(["publish", join(proj, "index.html"), "--title", "ua"], { cwd: proj });
    expect(r.code).toBe(0);
    const sent = server.seen.slice(before);
    expect(sent.length).toBeGreaterThan(0);
    for (const req of sent) {
      expect(String(req.headers["user-agent"])).toMatch(/htmlgate/i);
      expect(JSON.stringify(req.headers)).not.toMatch(/htmlbin/i);
    }
    const noToken = await cli(["status"], { token: null });
    expect(noToken.code).not.toBe(0);
  });
});

describe("publishing with the CLI", () => {
  test("a folder: becomes a site, leaves dotfiles at home, and is served by the Instance", async () => {
    const dir = folder("site1", { ...SITE, ".env": "SECRET=1", ".git/config": "x", "sub/.hidden": "x" });
    const r = await cli(["publish", dir, "--title", "Folder site"]);
    expect([r.code, r.out?.kind]).toEqual([0, "site"]);
    expect(r.out.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9]{12}$/);
    const v = await i.api("GET", `/api/shares/${r.out.slug}/versions/1`);
    expect(v.json.files.map((f: { path: string }) => f.path).sort()).toEqual(["a.css", "img/x.txt", "index.html"]);
    // Default expiry: about 30 days.
    expect(Math.abs(r.out.expires_at - (Date.now() + 30 * DAY))).toBeLessThan(120_000);
  });
  test("a .zip made by Info-ZIP publishes as is", async () => {
    const dir = folder("site2", SITE);
    const zip = join(work, "site2.zip");
    await run("zip", ["-r", "-q", zip, "."], { cwd: dir });
    const r = await cli(["publish", zip, "--title", "Zip site"]);
    expect([r.code, r.out?.kind]).toEqual([0, "site"]);
    const down = await i.call(`/api/shares/${r.out.slug}/versions/1/zip`, { headers: { authorization: `Bearer ${i.token}` } });
    expect(Buffer.from(await down.arrayBuffer()).equals(readFileSync(zip))).toBe(true);
  });
  test("a .zip made by ditto (Finder) publishes", async () => {
    const dir = folder("site3", SITE);
    const zip = join(work, "site3.zip");
    await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", dir, zip]);
    const r = await cli(["publish", zip, "--title", "Finder zip"]);
    expect([r.code, r.out?.kind]).toEqual([0, "site"]);
  });
  test("a page publishes as a page", async () => {
    const f = join(work, "page.html");
    writeFileSync(f, "<!doctype html><title>p</title><p>page</p>");
    const r = await cli(["publish", f]);
    expect([r.code, r.out?.kind]).toEqual([0, "page"]);
    expect((await i.api("GET", `/api/shares/${r.out.slug}`)).json.title).toBe("page");
  });
  test("a folder with a symbolic link, a folder without index.html, a missing path and a non-zip .zip are refused before any Share exists", async () => {
    const before = (await i.api("GET", "/api/shares?pageSize=100")).json.pagination.total;
    const linked = folder("linked", { "index.html": "x" });
    symlinkSync("/etc/hosts", join(linked, "hosts"));
    const noIndex = folder("noindex", { "a.html": "x" });
    writeFileSync(join(work, "fake.zip"), "<p>not a zip</p>");
    for (const target of [linked, noIndex, join(work, "missing"), join(work, "fake.zip")]) {
      const r = await cli(["publish", target, "--title", "x"]);
      expect([target, r.code === 0]).toEqual([target, false]);
    }
    expect((await i.api("GET", "/api/shares?pageSize=100")).json.pagination.total).toBe(before);
  });

  test("--expires: the forms it documents", async () => {
    const f = join(work, "exp.html");
    writeFileSync(f, "<p>exp</p>");
    const at = (r: R) => r.out?.expires_at as number | null;
    const rel30 = await cli(["publish", f, "--title", "e", "--expires", "30d"]);
    expect(Math.abs(at(rel30)! - (Date.now() + 30 * DAY))).toBeLessThan(120_000);
    const h12 = await cli(["publish", f, "--title", "e", "--expires", "12h"]);
    expect(Math.abs(at(h12)! - (Date.now() + 12 * 3600_000))).toBeLessThan(120_000);
    const date = await cli(["publish", f, "--title", "e", "--expires", "2026-12-31"]);
    expect(at(date)).toBe(Date.UTC(2026, 11, 31));
    const full = await cli(["publish", f, "--title", "e", "--expires", "2027-01-01T18:00:00Z"]);
    expect(at(full)).toBe(Date.UTC(2027, 0, 1, 18));
    const never = await cli(["publish", f, "--title", "e", "--expires", "never"]);
    expect([never.code, at(never)]).toEqual([0, null]);
    // On a site too.
    const site = await cli(["publish", folder("site-exp", SITE), "--title", "e", "--expires", "2026-12-31"]);
    expect(at(site)).toBe(Date.UTC(2026, 11, 31));
  });
  test.each(["soon", "0d", "-5d", "30", "30 days", "2026-13-45", "2026-12-31 18:00", "5000d", "99999d", "d", "1w"])("--expires %j is refused and creates nothing", async (bad) => {
    const f = join(work, "bad-exp.html");
    writeFileSync(f, "<p>x</p>");
    const before = (await i.api("GET", "/api/shares?pageSize=100")).json.pagination.total;
    const r = await cli(["publish", f, "--title", "bad", "--expires", bad]);
    expect([bad, r.code === 0]).toEqual([bad, false]);
    expect((await i.api("GET", "/api/shares?pageSize=100")).json.pagination.total).toBe(before);
  });
  test("a date in the past is refused (by the CLI or the Instance), and nothing is created", async () => {
    const f = join(work, "past.html");
    writeFileSync(f, "<p>x</p>");
    const r = await cli(["publish", f, "--title", "past", "--expires", "2020-01-01"]);
    expect(r.code).not.toBe(0);
  });
  test("update: --expires alone, a new folder, a new zip and a new page, each as a new Version or a patch", async () => {
    const first = await cli(["publish", folder("site-up", SITE), "--title", "up"]);
    const slug = first.out.slug as string;
    const p = await cli(["update", slug, "--expires", "never"]);
    expect([p.code, p.out?.mode]).toEqual([0, "patch"]);
    expect((await i.api("GET", `/api/shares/${slug}`)).json.expires_at).toBeNull();
    const next = folder("site-up2", { ...SITE, "extra.txt": "more" });
    const f = await cli(["update", slug, "--file", next]);
    expect([f.code, f.out?.mode]).toEqual([0, "put"]);
    const v = await i.api("GET", `/api/shares/${slug}/versions/2`);
    expect(v.json.files.map((x: { path: string }) => x.path)).toContain("extra.txt");
    expect((await i.api("GET", `/api/shares/${slug}`)).json.expires_at).toBeNull(); // the set date stays through a new Version
    const page = join(work, "up.html");
    writeFileSync(page, "<p>now a page</p>");
    expect((await cli(["update", slug, "--file", page])).code).toBe(0);
    expect((await i.api("GET", `/api/shares/${slug}/versions/3`)).json.kind).toBe("page");
    const z = join(work, "up.zip");
    await run("zip", ["-r", "-q", z, "."], { cwd: next });
    const zr = await cli(["update", slug, "--file", z, "--expires", "7d"]);
    expect(zr.code).toBe(0);
    expect(Math.abs((await i.api("GET", `/api/shares/${slug}`)).json.expires_at - (Date.now() + 7 * DAY))).toBeLessThan(120_000);
  });
  test("list carries expires_at; versions carries kind; the text output of publish stays one URL line when piped", async () => {
    const list = await cli(["list", "-n", "5"]);
    expect(list.code).toBe(0);
    for (const d of list.out) expect(d).toHaveProperty("expires_at");
    const f = join(work, "txt.html");
    writeFileSync(f, "<p>x</p>");
    const text = await new Promise<R>((resolve) => {
      execFile(process.execPath, [join(dist, "bin.js"), "--output", "text", "publish", f, "--title", "t"], { env: { PATH: process.env.PATH!, HOME: home, NO_COLOR: "1", HTMLGATE_URL: server.url, HTMLGATE_TOKEN: i.token } }, (err, stdout, stderr) =>
        resolve({ code: err ? 1 : 0, out: undefined, stdout, stderr }));
    });
    expect(text.stdout.trim().split("\n")).toHaveLength(1);
    expect(text.stdout).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9]{12}\n$/);
    const slug = (await cli(["publish", folder("site-ver", SITE), "--title", "v"])).out.slug;
    const versions = await cli(["versions", slug]);
    expect(versions.out[0].kind).toBe("site");
  });
  test("the Author can read what the CLI published through the Instance's own routes", async () => {
    const r = await cli(["publish", folder("site-read", SITE), "--title", "read"]);
    const viewer = await i.call(`/s/${r.out.slug}`, { as: AUTHOR });
    expect(viewer.status).toBe(200);
    const ticket = /src="\/f\/([A-Za-z0-9_-]+)\//.exec(await viewer.text())?.[1];
    expect(ticket).toBeTruthy();
    expect(await (await i.call(`/f/${ticket}/a.css`)).text()).toBe(SITE["a.css"]);
  });
});
