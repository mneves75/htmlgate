// Reviewer tests for the forked htmlgate CLI (packages/cli), written from the requirements in the change request:
// a token goes only where it was meant to, https only, no redirects, 30 s deadlines, login verifies before writing,
// atomic 0600 writes that refuse symlinks, env wins over saved, upsert refuses ambiguity, tokens never printed,
// upstream exit codes. Set REVIEWER_CLI to a built bin.js to run the same tests against a mutated CLI.
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { api, base, CLI as BUILT_CLI, mintToken, page } from "./helpers";

const CLI = process.env.REVIEWER_CLI ?? BUILT_CLI;
const TOKEN = "hg_" + "R".repeat(40);
const OTHER = "hg_" + "S".repeat(40);

interface Run { code: number; stdout: string; stderr: string; out: any; err: { code?: string; message?: string } | undefined }

function run(cwd: string, env: Record<string, string>, args: string[], opts: { input?: string; json?: boolean; umask0?: boolean; timeout?: number } = {}): Promise<Run> {
  const argv = [CLI, ...(opts.json === false ? [] : ["--output", "json"]), ...args];
  const [file, fileArgs] = opts.umask0 ? ["/bin/sh", ["-c", 'umask 0; exec "$@"', "sh", process.execPath, ...argv]] : [process.execPath, argv];
  return new Promise((resolve) => {
    const child = execFile(file as string, fileArgs as string[], { cwd, env: { PATH: process.env.PATH!, NO_COLOR: "1", ...env }, timeout: opts.timeout ?? 60_000 }, (e, stdout, stderr) => {
      let out: any;
      let err: Run["err"];
      try { out = stdout.trim() ? JSON.parse(stdout) : undefined; } catch {}
      try { err = JSON.parse(stderr.trim().split("\n")[0]!).error; } catch {}
      const code = e ? (typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : 1) : 0;
      resolve({ code, stdout, stderr, out, err });
    });
    child.stdin!.end(opts.input ?? "");
  });
}

interface Hit { method: string; url: string; auth: string | undefined; ua: string | undefined }
const servers: Server[] = [];
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const s = createServer((req, res) => {
    hits.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, ua: req.headers["user-agent"] });
    req.resume();
    handler(req, res);
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, hits };
}
const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const emptyList = (_req: IncomingMessage, res: ServerResponse) => json(res, 200, { data: [], pagination: { page: 1, page_size: 200, total: 0, total_pages: 1 } });
const fresh = (p: string) => mkdtempSync(join(tmpdir(), `reviewer-fork-${p}-`));
const mode = (p: string) => statSync(p).mode & 0o777;

afterAll(async () => {
  for (const s of servers) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
});

describe("an Instance address is https, or loopback, and nothing else", () => {
  test.each([
    ["http://example.com", "insecure_url"],
    ["http://127.0.0.1.example.com", "insecure_url"],
    ["http://localhost.example.com", "insecure_url"],
    ["http://127.0.0.1@example.com", "insecure_url"],
    ["ftp://example.com", "insecure_url"],
    ["file:///etc/passwd", "insecure_url"],
    ["http://user:pw@127.0.0.1:1", "invalid_arg"],
    ["https://example.com/api", "invalid_arg"],
    ["https://example.com?x=1", "invalid_arg"],
    ["https://example.com/#frag", "invalid_arg"],
    ["not a url", "invalid_arg"],
  ])("%s is refused as %s, before any request", async (url, code) => {
    const d = fresh("origin");
    const r = await run(d, { HOME: d, HTMLGATE_URL: url, HTMLGATE_TOKEN: TOKEN }, ["list"]);
    expect(r.err?.code).toBe(code);
    expect(r.code).toBe(code === "insecure_url" ? 8 : 7);
    const l = await run(d, { HOME: d }, ["login", url, "--token-stdin"], { input: TOKEN });
    expect(l.err?.code).toBe(code);
    expect(existsSync(join(d, ".htmlgate"))).toBe(false);
    expect(existsSync(store(d))).toBe(false);
  });

  test.each(["http://localhost:1", "http://127.0.0.1:1", "http://[::1]:1", "http://127.0.0.1:1/"])("loopback %s is allowed (the request is attempted)", async (url) => {
    const d = fresh("loop");
    const r = await run(d, { HOME: d, HTMLGATE_URL: url, HTMLGATE_TOKEN: TOKEN }, ["list"]);
    expect(r.err?.code).toBe("network_error");
    expect(r.code).toBe(8);
  });
});

describe("a redirect never carries the token anywhere", () => {
  test.each([301, 302, 303, 307, 308])("HTTP %i on a write and on a read: exit 8, code redirected, the target is never contacted", async (status) => {
    const target = await serve(emptyList);
    const origin = await serve((_req, res) => res.writeHead(status, { location: `${target.url}/api/shares` }).end());
    const d = fresh("redir");
    writeFileSync(join(d, "a.html"), page("x"));
    const env = { HOME: d, HTMLGATE_URL: origin.url, HTMLGATE_TOKEN: TOKEN };
    for (const args of [["list"], ["publish", "a.html", "--title", "t"], ["delete", "AAAAAAAAAAAA"], ["tokens", "list"]]) {
      const r = await run(d, env, args);
      expect(r.code, args.join(" ")).toBe(8);
      expect(r.err?.code, args.join(" ")).toBe("redirected");
    }
    expect(target.hits).toHaveLength(0);
  });
});

const store = (home: string) => join(home, ".config/htmlgate/credentials");
const saveStore = (home: string, instances: Record<string, string>) => {
  mkdirSync(join(home, ".config/htmlgate"), { recursive: true });
  writeFileSync(store(home), JSON.stringify({ instances: Object.fromEntries(Object.entries(instances).map(([o, t]) => [o, { token: t }])) }), { mode: 0o600 });
};

describe("which Instance receives which token", () => {
  test("a saved token is sent to its own Instance even when the address is written with a trailing slash", async () => {
    const s = await serve(emptyList);
    const d = fresh("slash");
    expect((await run(d, { HOME: d }, ["login", `${s.url}/`, "--token-stdin"], { input: TOKEN })).code).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(store(d), "utf8")).instances)).toEqual([s.url]);
    const r = await run(d, { HOME: d, HTMLGATE_URL: `${s.url}/` }, ["list"]);
    expect(r.code, r.stderr).toBe(0);
    expect(s.hits.at(-1)!.auth).toBe(`Bearer ${TOKEN}`);
  });

  test("$HTMLGATE_URL beats the project config, and with $HTMLGATE_URL, $HTMLGATE_TOKEN beats the store", async () => {
    const a = await serve(emptyList);
    const b = await serve(emptyList);
    const d = fresh("prec");
    saveStore(d, { [a.url]: TOKEN, [b.url]: OTHER });
    mkdirSync(join(d, ".htmlgate"));
    writeFileSync(join(d, ".htmlgate/config"), `api_url = "${a.url}"\n`);
    expect((await run(d, { HOME: d }, ["list"])).code).toBe(0);
    expect(a.hits.at(-1)!.auth).toBe(`Bearer ${TOKEN}`);
    expect((await run(d, { HOME: d, HTMLGATE_URL: b.url }, ["list"])).code).toBe(0);
    expect(b.hits.at(-1)!.auth).toBe(`Bearer ${OTHER}`);
    const third = "hg_" + "U".repeat(40);
    expect((await run(d, { HOME: d, HTMLGATE_URL: b.url, HTMLGATE_TOKEN: third }, ["list"])).code).toBe(0);
    expect(b.hits.at(-1)!.auth).toBe(`Bearer ${third}`);
  });

  test("a stored token for one Instance is never sent to a project's other Instance, nor to the same host on another port", async () => {
    const mine = await serve(emptyList);
    const theirs = await serve(emptyList);
    const d = fresh("global");
    saveStore(d, { [mine.url]: TOKEN });
    mkdirSync(join(d, "repo/.htmlgate"), { recursive: true });
    writeFileSync(join(d, "repo/.htmlgate/config"), `api_url = "${theirs.url}"\n`);
    const r = await run(join(d, "repo"), { HOME: d }, ["list"]);
    expect(r.code).toBe(2);
    expect(theirs.hits).toHaveLength(0);
  });

  // The Instance comes from the project's committed .htmlgate/config, which a cloned repository controls.
  test("$HTMLGATE_TOKEN without $HTMLGATE_URL is not sent to the Instance a cloned repository's .htmlgate/config names", async () => {
    const evil = await serve(emptyList);
    const d = fresh("exfil");
    mkdirSync(join(d, ".htmlgate"));
    writeFileSync(join(d, ".htmlgate/config"), `api_url = "${evil.url}"\n`);
    await run(d, { HOME: d, HTMLGATE_TOKEN: TOKEN }, ["list"]);
    await run(d, { HOME: d, HTMLGATE_TOKEN: TOKEN }, ["login"]);
    expect(evil.hits.filter((h) => h.auth)).toEqual([]);
  });

  test("a damaged store does not block a command that was given $HTMLGATE_URL and $HTMLGATE_TOKEN, and login will not overwrite it", async () => {
    const s = await serve(emptyList);
    const d = fresh("damaged");
    mkdirSync(join(d, ".config/htmlgate"), { recursive: true });
    writeFileSync(store(d), "not json");
    const r = await run(d, { HOME: d, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["list"]);
    expect(r.code, r.stderr).toBe(0);
    const l = await run(d, { HOME: d }, ["login", s.url, "--token-stdin"], { input: TOKEN });
    expect(l.code).not.toBe(0);
    expect(readFileSync(store(d), "utf8")).toBe("not json");
  });

  test(".htmlgate/config accepts valid TOML: a trailing comment, single quotes", async () => {
    for (const line of [(u: string) => `api_url = "${u}" # staging`, (u: string) => `api_url = '${u}'`]) {
      const s = await serve(emptyList);
      const d = fresh("toml");
      mkdirSync(join(d, ".htmlgate"));
      writeFileSync(join(d, ".htmlgate/config"), line(s.url) + "\n");
      saveStore(d, { [s.url]: TOKEN, "https://other.example": OTHER });
      const r = await run(d, { HOME: d }, ["list"]);
      expect(r.code, `${line(s.url)}: ${r.stderr}`).toBe(0);
    }
  });
});

describe("login verifies first and writes safely", () => {
  test("a refused token (401) saves nothing and leaves every stored entry byte for byte", async () => {
    const good = await serve(emptyList);
    const bad = await serve((_req, res) => json(res, 401, { error: { code: "unauthorized", message: "no" } }));
    const d = fresh("verify");
    expect((await run(d, { HOME: d }, ["login", good.url, "--token-stdin"], { input: TOKEN })).code).toBe(0);
    const before = readFileSync(store(d), "utf8");
    const r = await run(d, { HOME: d }, ["login", bad.url, "--token-stdin"], { input: OTHER });
    expect(r.code).toBe(2);
    expect(readFileSync(store(d), "utf8")).toBe(before);
    // The verification request is the only thing sent, and only to the Instance named.
    expect(bad.hits.map((h) => h.url)).toEqual(["/api/shares?pageSize=1&sortBy=updated_at"]);
  });

  test("login sends the token to the address it was given and nowhere else", async () => {
    const s = await serve(emptyList);
    const d = fresh("only");
    await run(d, { HOME: d }, ["login", s.url, "--token-stdin"], { input: `${TOKEN}\n` });
    expect(s.hits.map((h) => h.auth)).toEqual([`Bearer ${TOKEN}`]);
  });

  test("a token with the wrong shape is refused before any request", async () => {
    const s = await serve(emptyList);
    const d = fresh("shape");
    for (const t of ["", "hg_short", "hg_" + "R".repeat(41), "xx_" + "R".repeat(40), "hg_" + "R".repeat(39) + "-"]) {
      const r = await run(d, { HOME: d }, ["login", s.url, "--token-stdin"], { input: t });
      expect(r.code, JSON.stringify(t)).toBe(2);
    }
    expect(s.hits).toHaveLength(0);
  });

  test("the store: 0600 even under umask 0, replaced (not edited), a loose htmlgate directory tightened to 0700, no temp files left", async () => {
    const s = await serve(emptyList);
    const d = fresh("perm");
    mkdirSync(join(d, ".config/htmlgate"), { recursive: true, mode: 0o755 });
    chmodSync(join(d, ".config/htmlgate"), 0o755);
    writeFileSync(store(d), JSON.stringify({ instances: { "https://other.example": { token: OTHER } } }), { mode: 0o644 });
    chmodSync(store(d), 0o644);
    const r = await run(d, { HOME: d }, ["login", s.url, "--token-stdin"], { input: TOKEN, umask0: true });
    expect(r.code, r.stderr).toBe(0);
    expect(mode(store(d))).toBe(0o600);
    expect(mode(join(d, ".config/htmlgate")) & 0o077).toBe(0);
    expect(JSON.parse(readFileSync(store(d), "utf8")).instances).toEqual({ "https://other.example": { token: OTHER }, [s.url]: { token: TOKEN } });
    expect(readdirSync(join(d, ".config/htmlgate"))).toEqual(["credentials"]);
  });

  test("login refuses a symlinked store: exit 7, nothing written through it, no request made", async () => {
    const s = await serve(emptyList);
    const d = fresh("link");
    const away = fresh("away");
    mkdirSync(join(d, ".config/htmlgate"), { recursive: true });
    symlinkSync(join(away, "cred"), store(d));
    const r = await run(d, { HOME: d }, ["login", s.url, "--token-stdin"], { input: TOKEN });
    expect(r.code, r.stderr).toBe(7);
    expect(r.err?.code).toBe("unsafe_path");
    expect(readdirSync(away)).toEqual([]);
    expect(s.hits).toHaveLength(0);
  });

  test("a symlinked store that points at an existing file leaves that file alone", async () => {
    const s = await serve(emptyList);
    const d = fresh("link2");
    const away = fresh("away2");
    writeFileSync(join(away, "cred"), "precious");
    mkdirSync(join(d, ".config/htmlgate"), { recursive: true });
    symlinkSync(join(away, "cred"), store(d));
    expect((await run(d, { HOME: d }, ["login", s.url, "--token-stdin"], { input: TOKEN })).code).toBe(7);
    expect(readFileSync(join(away, "cred"), "utf8")).toBe("precious");
  });

  test("login with a regular file where the htmlgate config directory should be fails with a typed error before asking the Instance", async () => {
    const s = await serve(emptyList);
    const d = fresh("filedir");
    mkdirSync(join(d, ".config"));
    writeFileSync(join(d, ".config/htmlgate"), "x");
    const r = await run(d, { HOME: d }, ["login", s.url, "--token-stdin"], { input: TOKEN });
    expect(r.err?.code).toBe("unsafe_path");
    expect(r.code).toBe(7);
    expect(s.hits).toHaveLength(0);
  });

  test("logout removes only the named Instance, says so when there was none, and needs no network", async () => {
    const d = fresh("logout");
    expect((await run(d, { HOME: d }, ["logout", "https://nowhere.example"])).out).toEqual({ removed: false, api_url: "https://nowhere.example" });
    saveStore(d, { "https://a.example": TOKEN, "https://b.example": OTHER });
    expect((await run(d, { HOME: d }, ["logout", "https://a.example"])).out).toEqual({ removed: true, api_url: "https://a.example" });
    expect(JSON.parse(readFileSync(store(d), "utf8")).instances).toEqual({ "https://b.example": { token: OTHER } });
  });
});

describe("the hidden prompt", () => {
  const python = (() => { try { execFileSync("python3", ["-I", "-c", "import pty"]); return true; } catch { return false; } })();
  const driver = `
import os, pty, select, sys, time
mode, cli, node, home, url, tok = sys.argv[1:7]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(home); os.execve(node, [node, cli, "login", url], {"PATH": os.environ["PATH"], "HOME": home})
out = b""
def drain(t):
    global out
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: out += os.read(fd, 4096)
            except OSError: return
drain(1.5)
os.write(fd, (tok + "\\r").encode() if mode == "ok" else tok[:8].encode())
if mode != "ok": time.sleep(0.3); os.write(fd, b"\\x03")
drain(2)
_, st = os.waitpid(pid, 0)
print(os.WEXITSTATUS(st)); sys.stdout.write(out.decode(errors="replace"))
`;
  test.skipIf(!python)("a terminal gets a prompt that does not echo the token; the token is verified and saved; Ctrl-C saves nothing and exits 130", async () => {
    const s = await serve(emptyList);
    for (const m of ["ok", "cancel"]) {
      const d = fresh("tty");
      // Async: the stand-in server lives in this process and must keep answering while the driver runs.
      const { stdout: out } = await promisify(execFile)("python3", ["-I", "-c", driver, m, CLI, process.execPath, d, s.url, TOKEN], { encoding: "utf8", timeout: 30_000 });
      const [code, ...rest] = out.split("\n");
      expect(rest.join("\n")).not.toContain(TOKEN.slice(3, 12));
      if (m === "ok") {
        expect(code).toBe("0");
        expect(JSON.parse(readFileSync(store(d), "utf8")).instances[s.url].token).toBe(TOKEN);
      } else {
        expect(code).toBe("130");
        expect(existsSync(store(d))).toBe(false);
      }
    }
  });
});

describe("errors keep upstream's exit codes", () => {
  test.each([
    [401, "unauthorized", 2],
    [403, "forbidden", 3],
    [404, "not_found", 4],
    [404, "version_not_found", 4],
    [429, "rate_limited", 5],
    [507, "quota_exceeded", 5],
    [413, "html_too_large", 6],
    [400, "title_too_long", 6],
    [400, "description_too_long", 6],
    [400, "invalid_arg", 7],
    [400, "invalid_json", 7],
    [400, "html_required", 7],
    [400, "title_required", 7],
    [400, "metadata_only_on_patch", 7],
    [503, "server_misconfigured", 8],
    // The Worker's catch-all (src/index.ts:27) answers 500 internal_error. The README says exit 8 is "a server error".
    [500, "internal_error", 8],
  ])("HTTP %i %s exits %i", async (status, code, exit) => {
    const s = await serve((_req, res) => json(res, status, { error: { code, message: "m" } }));
    const d = fresh("codes");
    const r = await run(d, { HOME: d, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["list"]);
    expect(r.code).toBe(exit);
  });

  test("a server that sends headers and then stalls ends in a network error (exit 8) at the 30 s deadline, not 'unknown'", async () => {
    const s = await serve((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"data":['); });
    const d = fresh("stall");
    const t0 = Date.now();
    const r = await run(d, { HOME: d, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["list"], { timeout: 45_000 });
    expect(Date.now() - t0).toBeGreaterThan(25_000);
    expect(Date.now() - t0).toBeLessThan(40_000);
    expect(r.err?.code).toBe("network_error");
    expect(r.code).toBe(8);
  }, 55_000);

  test("a server that never answers ends in exit 8 at the same deadline", async () => {
    const s = await serve(() => {});
    const d = fresh("silent");
    const t0 = Date.now();
    const r = await run(d, { HOME: d, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["list"], { timeout: 45_000 });
    expect(Date.now() - t0).toBeLessThan(40_000);
    expect(r.code).toBe(8);
  }, 55_000);

  test("usage: no command exits 7 with the help on stderr; --help and --version exit 0 on stdout; bad --output exits 7", async () => {
    const d = fresh("usage");
    const none = await run(d, { HOME: d }, [], { json: false });
    expect(none.code).toBe(7);
    expect(none.stderr).toContain("Usage:");
    const noneJson = await run(d, { HOME: d }, []);
    expect(noneJson.code).toBe(7);
    expect(noneJson.err?.code).toBe("invalid_arg");
    const help = await run(d, { HOME: d }, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("htmlgate tokens revoke <id>");
    const v = await run(d, { HOME: d }, ["--version"]);
    expect(v.stdout.trim()).toBe(JSON.parse(readFileSync(join(process.cwd(), "packages/cli/package.json"), "utf8")).version);
    expect((await run(d, { HOME: d }, ["list", "--output", "xml"])).code).toBe(7);
    expect((await run(d, { HOME: d }, ["list", "--nope"])).code).toBe(7);
    expect((await run(d, { HOME: d }, ["publish"])).code).toBe(7);
    expect((await run(d, { HOME: d }, ["list", "-n", "0"])).code).toBe(7);
    expect((await run(d, { HOME: d }, ["list", "-n", "x"])).code).toBe(7);
  });

  test("a coding agent's environment makes JSON the default, --output text overrides it, and the User-Agent names the agent", async () => {
    const s = await serve(emptyList);
    const d = fresh("agent");
    const env = { HOME: d, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN };
    const viaAgent = await run(d, { ...env, CLAUDECODE: "1" }, ["list"], { json: false });
    expect(JSON.parse(viaAgent.stdout)).toEqual([]);
    expect(s.hits.at(-1)!.ua).toMatch(/^@htmlgate\/cli\/\S+ \(node v\d+\.[^;]+; \w+ \w+; agent claude-code\)$/);
    const text = await run(d, { ...env, CLAUDECODE: "1" }, ["--output", "text", "list"], { json: false });
    expect(text.stdout).toBe("(no shares)\n");
    const plain = await run(d, env, ["list"], { json: false });
    expect(plain.stdout).toBe("(no shares)\n");
    expect(s.hits.at(-1)!.ua).not.toContain("agent");
  });
});

describe("a token is never printed", () => {
  test.each([
    ["a token pasted as the Instance address", ["login", TOKEN]],
    ["as the command", [TOKEN]],
    ["as a file name", ["publish", TOKEN]],
    ["as a slug the server echoes back", ["url", TOKEN]],
    ["in a metadata filter the server echoes back", ["list", "--metadata", `k=${TOKEN}`]],
    ["as a token id", ["tokens", "revoke", TOKEN]],
  ])("%s, in JSON and in text mode", async (_name, args) => {
    const s = await serve((req, res) => json(res, 404, { error: { code: "not_found", message: `nothing at ${decodeURIComponent(req.url!)}`, details: { echo: TOKEN } } }));
    const d = fresh("redact");
    const env = { HOME: d, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN };
    for (const asJson of [true, false]) {
      const r = await run(d, env, args, { json: asJson });
      expect(r.stdout + r.stderr, args.join(" ")).not.toContain(TOKEN);
      expect(r.stdout + r.stderr).not.toContain("RRRRRRRR");
    }
  });

  test("a Share title that looks like a token is masked in list output, and a real token in a URL userinfo is never echoed", async () => {
    const s = await serve((_req, res) => json(res, 200, { data: [{ slug: "AAAAAAAAAAAA", title: TOKEN, url: "x", public: false, metadata: {}, updated_at: 1 }], pagination: { total: 1, total_pages: 1 } }));
    const d = fresh("title");
    const r = await run(d, { HOME: d, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["list"]);
    expect(r.stdout).not.toContain(TOKEN);
    const u = await run(d, { HOME: d, HTMLGATE_URL: `https://${TOKEN}@example.com`, HTMLGATE_TOKEN: TOKEN }, ["list"]);
    expect(u.stdout + u.stderr).not.toContain(TOKEN);
  });

  test("login's output never contains the token, and login writes nothing into the project", async () => {
    const s = await serve(emptyList);
    const d = fresh("loginout");
    const r = await run(d, { HOME: d }, ["login", s.url, "--token-stdin"], { input: TOKEN });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    expect(readdirSync(d)).toEqual([".config"]);
  });
});

describe("upsert", () => {
  test("more matches than one page of the lookup holds is still ambiguous: exit 7, nothing is written", async () => {
    const shares = Array.from({ length: 10 }, (_, i) => ({ slug: `S${String(i).padStart(11, "0")}`, title: "t", url: "x", public: false, metadata: {}, updated_at: 1 }));
    const s = await serve((req, res) => (req.method === "GET" ? json(res, 200, { data: shares, pagination: { total: 12, total_pages: 2 } }) : json(res, 500, { error: { code: "invalid_arg", message: "should not be called" } })));
    const d = fresh("amb");
    writeFileSync(join(d, "a.html"), page("a"));
    const r = await run(d, { HOME: d, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN }, ["publish", "a.html", "--upsert", "--metadata", "k=v"]);
    expect(r.code).toBe(7);
    expect(r.err?.code).toBe("ambiguous_upsert");
    expect(r.err?.message).toContain("12");
    expect(s.hits.filter((h) => h.method !== "GET")).toEqual([]);
  });

  test("--upsert without --metadata, and --slug with --upsert, are refused before any request", async () => {
    const s = await serve(emptyList);
    const d = fresh("upsarg");
    writeFileSync(join(d, "a.html"), page("a"));
    const env = { HOME: d, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: TOKEN };
    expect((await run(d, env, ["publish", "a.html", "--upsert"])).code).toBe(7);
    expect((await run(d, env, ["publish", "a.html", "--upsert", "--slug", "AAAAAAAAAAAA", "--metadata", "a=b"])).code).toBe(7);
    expect(s.hits).toHaveLength(0);
  });
});

describe("against a real Instance", () => {
  let dir: string;
  let token: string;
  const cli = (...args: string[]) => run(dir, { HOME: dir, HTMLGATE_URL: base, HTMLGATE_TOKEN: token }, args);
  beforeAll(async () => {
    token = await mintToken("reviewer-fork");
    dir = fresh("real");
    writeFileSync(join(dir, "a.html"), page("alpha"));
  });

  test("the 2 MiB cap is on bytes: exactly 2 MiB publishes, one byte more exits 6 without a request", async () => {
    const head = "<!doctype html><title>t</title><p>";
    const tail = "</p>";
    const fill = (n: number) => head + "x".repeat(n - head.length - tail.length) + tail;
    writeFileSync(join(dir, "exact.html"), fill(2 * 1024 * 1024));
    writeFileSync(join(dir, "over.html"), fill(2 * 1024 * 1024 + 1));
    const ok = await cli("publish", "exact.html", "--title", "exact");
    expect(ok.code, ok.stderr).toBe(0);
    const total = async () => (await api(token)("GET", "/api/shares?pageSize=1")).json.pagination.total;
    const before = await total();
    expect((await cli("publish", "over.html", "--title", "over")).code).toBe(6);
    expect(await total()).toBe(before);
  });

  test("multi-byte text survives the round trip, and an '=' inside a metadata value is kept", async () => {
    const html = "<!doctype html><title>é</title><p>é☃😀</p>";
    writeFileSync(join(dir, "u.html"), html);
    const t = "eq-" + Math.random().toString(36).slice(2, 8);
    const pub = await cli("publish", "u.html", "--title", "ünï", "--metadata", `k=${t}=x=y`);
    expect(pub.code, pub.stderr).toBe(0);
    const call = api(token);
    expect((await call("GET", `/api/shares/${pub.out.slug}/versions/1`)).json.html).toBe(html);
    expect((await call("GET", `/api/shares/${pub.out.slug}`)).json).toMatchObject({ title: "ünï", metadata: { k: `${t}=x=y` } });
    expect((await cli("list", "--metadata", `k=${t}=x=y`)).out.map((d: any) => d.slug)).toEqual([pub.out.slug]);
  });

  test("field limits: a 201-character title exits 6, 11 metadata keys exit 7 before a request, a bad key exits 7", async () => {
    const total = async () => (await api(token)("GET", "/api/shares?pageSize=1")).json.pagination.total;
    const before = await total();
    expect((await cli("publish", "a.html", "--title", "t".repeat(201))).code).toBe(6);
    const many = Array.from({ length: 11 }, (_, i) => ["--metadata", `k${i}=v`]).flat();
    expect((await cli("publish", "a.html", "--title", "m", ...many)).code).toBe(7);
    expect((await cli("publish", "a.html", "--title", "m", "--metadata", "a b=1")).code).toBe(7);
    expect(await total()).toBe(before);
  });

  test("versions and public/gate answer 4 for a Share that does not exist; public is idempotent", async () => {
    expect((await cli("versions", "AAAAAAAAAAAA")).code).toBe(4);
    expect((await cli("gate", "AAAAAAAAAAAA")).code).toBe(4);
    const { out } = await cli("publish", "a.html", "--title", "idem");
    expect((await cli("public", out.slug)).out.public).toBe(true);
    expect((await cli("public", out.slug)).out.public).toBe(true);
    expect((await cli("gate", out.slug)).out.public).toBe(false);
    expect((await cli("gate", out.slug)).out.public).toBe(false);
  });

  test("a token can revoke itself through the CLI; its next request exits 2 and the revoke is not repeatable", async () => {
    const mine = await mintToken("reviewer-self");
    const own = (...args: string[]) => run(dir, { HOME: dir, HTMLGATE_URL: base, HTMLGATE_TOKEN: mine }, args);
    const id = (await own("tokens", "list")).out.find((t: any) => t.name === "reviewer-self").id;
    expect((await own("tokens", "revoke", id)).out).toEqual({ revoked: true, id });
    expect((await own("list")).code).toBe(2);
    expect((await cli("tokens", "revoke", id)).code).toBe(4);
  });

  test("text output of versions and tokens list is a table with its header; list on a pipe is tab separated", async () => {
    const { out } = await cli("publish", "a.html", "--title", "tbl");
    const text = (...args: string[]) => run(dir, { HOME: dir, HTMLGATE_URL: base, HTMLGATE_TOKEN: token }, args, { json: false });
    expect((await text("versions", out.slug)).stdout).toMatch(/^VERSION\s+KIND\s+SIZE\s+CREATED\s+TOKEN\nv1\s+page\s+\d+ B\s+\d{4}-\d\d-\d\d \d\d:\d\d\s+reviewer-fork\n$/);
    expect((await text("tokens", "list")).stdout).toMatch(/^ID\s+NAME\s+STATE\s+LAST USED\n/);
    expect((await text("list", "-n", "1")).stdout).toMatch(/^\S{12}\t\d{4}-\d\d-\d\dT[^\t]+\t[^\t]*\t\S+\n$/);
  });
});
