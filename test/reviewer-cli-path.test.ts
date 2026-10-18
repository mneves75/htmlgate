// Independent review of `htmlgate publish`'s file opening: every spelling of a path, sizes, special files.
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { htmlgate } from "./helpers";

const TOKEN = "hg_" + "T".repeat(40);
const servers: Server[] = [];
async function serve() {
  const hits: IncomingMessage[] = [];
  const bodies: string[] = [];
  const s = createServer((req, res) => {
    hits.push(req);
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      bodies.push(b);
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ slug: "S00000000001", title: "t", url: "x/s/1", public: false, metadata: {}, updated_at: 1, latest_version: 1 }));
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, hits, bodies };
}
afterAll(async () => { for (const s of servers) await new Promise<void>((r) => s.close(() => r())); });
const mk = (p: string) => mkdtempSync(join(p, "rev-"));
const pub = async (cwd: string, url: string, file: string) => htmlgate(cwd, { HOME: cwd, HTMLGATE_URL: url, HTMLGATE_TOKEN: TOKEN }, ["publish", file]);

describe("publish opens exactly the real file named", () => {
  test("ordinary spellings work: ./, sub/../, spaces, unicode, absolute", async () => {
    const s = await serve();
    const d = mk(tmpdir());
    mkdirSync(join(d, "sub dir"));
    writeFileSync(join(d, "sub dir", "relatório ✓.html"), "<p>ok</p>");
    writeFileSync(join(d, "page.html"), "<p>top</p>");
    for (const p of ["./page.html", "sub dir/../page.html", "sub dir/relatório ✓.html", join(d, "page.html")]) {
      const r = await pub(d, s.url, p);
      expect(r.code, p + " " + r.stderr).toBe(0);
    }
  });

  test("a cwd reached through a symlink still works with relative paths (the process cwd is the real one)", async () => {
    const s = await serve();
    const real = mk(tmpdir());
    writeFileSync(join(real, "page.html"), "<p>x</p>");
    const holder = mk(tmpdir());
    symlinkSync(real, join(holder, "link"));
    const r = await pub(join(holder, "link"), s.url, "page.html");
    expect(r.code, r.stderr).toBe(0);
  });

  test("paths spelled under /tmp work on macOS (documented exception) and a link inside /tmp is still refused", async () => {
    if (process.platform !== "darwin") return;
    const s = await serve();
    const d = mk("/tmp");
    writeFileSync(join(d, "page.html"), "<p>x</p>");
    expect((await pub(d, s.url, join(d, "page.html"))).code).toBe(0);
    writeFileSync(join(d, "real.html"), "<p>y</p>");
    symlinkSync(join(d, "real.html"), join(d, "alias.html"));
    expect((await pub(d, s.url, join(d, "alias.html"))).code).toBe(7);
  });

  test("a dangling link and a link to a directory are refused and nothing is sent", async () => {
    const s = await serve();
    const d = mk(tmpdir());
    symlinkSync(join(d, "nowhere"), join(d, "dangling.html"));
    mkdirSync(join(d, "realdir"));
    symlinkSync(join(d, "realdir"), join(d, "dirlink.html"));
    expect([4, 7]).toContain((await pub(d, s.url, "dangling.html")).code);
    expect([4, 7]).toContain((await pub(d, s.url, "dirlink.html")).code);
    expect(s.hits).toHaveLength(0);
  });

  test("a link in the middle of a deep path is refused, whichever component it is", async () => {
    const s = await serve();
    const d = mk(tmpdir());
    const out = mk(tmpdir());
    mkdirSync(join(out, "c"));
    writeFileSync(join(out, "c", "page.html"), "<p>secret</p>");
    mkdirSync(join(d, "a"));
    symlinkSync(out, join(d, "a", "b"));
    expect((await pub(d, s.url, "a/b/c/page.html")).code).toBe(7);
    expect(s.hits).toHaveLength(0);
  });

  test("a file of exactly 2 MiB publishes; one byte more is exit 6 and nothing is sent", async () => {
    const s = await serve();
    const d = mk(tmpdir());
    writeFileSync(join(d, "max.html"), "a".repeat(2 * 1024 * 1024));
    writeFileSync(join(d, "over.html"), "a".repeat(2 * 1024 * 1024 + 1));
    expect((await pub(d, s.url, "max.html")).code).toBe(0);
    const hits = s.hits.length;
    expect((await pub(d, s.url, "over.html")).code).toBe(6);
    expect(s.hits.length).toBe(hits);
  });

  test("a directory is a site: without an index.html at its top it is refused, exit 7", async () => {
    const s = await serve();
    const d = mk(tmpdir());
    mkdirSync(join(d, "sub"));
    expect((await pub(d, s.url, "sub")).code).toBe(7);
    expect((await pub(d, s.url, "sub/")).code).toBe(7);
  });

  test("an unreadable file is reported as such, not as 'No such file'", async () => {
    if (process.getuid?.() === 0) return;
    const s = await serve();
    const d = mk(tmpdir());
    writeFileSync(join(d, "secret.html"), "x");
    chmodSync(join(d, "secret.html"), 0o000);
    const r = await pub(d, s.url, "secret.html");
    expect(r.code).not.toBe(0);
    expect(r.stderr).not.toMatch(/No such file/);
  });
});
