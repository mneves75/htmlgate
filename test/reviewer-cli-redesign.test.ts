// Independent review of the redesigned credential store and Instance selection (packages/cli), written from the
// stated requirements. Tests that began as defect reports now guard the fixes.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { api, base, CLI as BUILT_CLI, mintToken, page, type CliResult } from "./helpers";

// REVIEWER_CLI points the same tests at a mutated build of the CLI.
const CLI = process.env.REVIEWER_CLI ?? BUILT_CLI;
function htmlgate(cwd: string, env: Record<string, string>, args: string[], input?: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, "--output", "json", ...args], { cwd, env: { PATH: process.env.PATH!, NO_COLOR: "1", ...env } }, (err, stdout, stderr) => {
      let out: any;
      try { out = stdout.trim() ? JSON.parse(stdout) : undefined; } catch {}
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out, stdout, stderr });
    });
    child.stdin!.end(input ?? "");
  });
}

const TOKEN = "hg_" + "A".repeat(40);
const OTHER = "hg_" + "B".repeat(40);
const fresh = (p: string) => mkdtempSync(join(tmpdir(), `reviewer-redesign-${p}-`));
const storePath = (home: string) => join(home, ".config/htmlgate/credentials");
const saveStore = (home: string, instances: Record<string, string>) => {
  mkdirSync(join(home, ".config/htmlgate"), { recursive: true });
  writeFileSync(storePath(home), JSON.stringify({ instances: Object.fromEntries(Object.entries(instances).map(([o, token]) => [o, { token }])) }));
};

const servers: Server[] = [];
/** A stand-in Instance that answers every list request and records the Authorization header of each request. */
async function stub(host = "127.0.0.1") {
  const auths: (string | undefined)[] = [];
  const s = createServer((req, res) => {
    auths.push(req.headers.authorization);
    req.resume();
    res.writeHead(200, { "content-type": "application/json" }).end('{"data":[],"pagination":{"page":1,"page_size":200,"total":0,"total_pages":1}}');
  });
  await new Promise<void>((r) => s.listen(0, host, r));
  servers.push(s);
  return { port: (s.address() as { port: number }).port, auths, url: `http://127.0.0.1:${(s.address() as { port: number }).port}` };
}
afterAll(async () => {
  for (const s of servers) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
});

describe("the store's lock file", () => {
  test("a login leaves exactly the credentials file behind: no lock, no temp file", async () => {
    const s = await stub();
    const d = fresh("clean");
    const r = await htmlgate(d, { HOME: d }, ["login", s.url, "--token-stdin"], TOKEN);
    expect(r.code, r.stderr).toBe(0);
    expect(readdirSync(join(d, ".config/htmlgate"))).toEqual(["credentials"]);
  });

  test("a lock left by a crashed login more than 30 s ago is taken over", async () => {
    const s = await stub();
    const d = fresh("stale");
    saveStore(d, { "https://other.example": OTHER });
    const lock = storePath(d) + ".lock";
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const r = await htmlgate(d, { HOME: d }, ["login", s.url, "--token-stdin"], TOKEN);
    expect(r.code, r.stderr).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(storePath(d), "utf8")).instances).sort()).toEqual([s.url, "https://other.example"].sort());
    expect(existsSync(lock)).toBe(false);
  });

  test("a fresh lock held by someone else is waited for, then reported (exit 7), and neither the lock nor the store is touched", async () => {
    const s = await stub();
    const d = fresh("held");
    saveStore(d, { "https://other.example": OTHER });
    const before = readFileSync(storePath(d), "utf8");
    const lock = storePath(d) + ".lock";
    writeFileSync(lock, "");
    const started = Date.now();
    const r = await htmlgate(d, { HOME: d }, ["login", s.url, "--token-stdin"], TOKEN);
    expect(r.code, r.stderr).toBe(7);
    expect(Date.now() - started).toBeGreaterThan(4_000);
    expect(readFileSync(storePath(d), "utf8")).toBe(before);
    expect(existsSync(lock)).toBe(true);
  });
});

describe("tokens live only in the user's store", () => {
  test("a token written into the project's .htmlgate/config, and the old .htmlbin files and variables, are never used", async () => {
    const s = await stub();
    const d = fresh("legacy");
    mkdirSync(join(d, ".htmlgate"));
    writeFileSync(join(d, ".htmlgate/config"), `api_url = "${s.url}"\ntoken = "${TOKEN}"\n`);
    writeFileSync(join(d, ".htmlgate/token"), TOKEN);
    mkdirSync(join(d, ".htmlbin"));
    writeFileSync(join(d, ".htmlbin/token"), TOKEN);
    writeFileSync(join(d, ".htmlbin/config"), `api_url = "${s.url}"\n`);
    const r = await htmlgate(d, { HOME: d, HTMLBIN_TOKEN: TOKEN, HTMLBIN_URL: s.url }, ["list"]);
    expect(r.code, r.stderr).toBe(2);
    expect(s.auths).toEqual([]);
  });

  test("$HTMLGATE_TOKEN with surrounding whitespace works; a malformed one exits 2 before any request", async () => {
    const s = await stub();
    const d = fresh("envtoken");
    const ok = await htmlgate(d, { HOME: d, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: `  ${TOKEN}\n` }, ["list"]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(s.auths).toEqual([`Bearer ${TOKEN}`]);
    const bad = await htmlgate(d, { HOME: d, HTMLGATE_URL: s.url, HTMLGATE_TOKEN: "hg_short" }, ["list"]);
    expect(bad.code).toBe(2);
    expect(s.auths).toHaveLength(1);
  });

  test("logout with several Instances stored and none chosen exits 2 and removes nothing", async () => {
    const d = fresh("logout-many");
    saveStore(d, { "https://a.example": TOKEN, "https://b.example": OTHER });
    const before = readFileSync(storePath(d), "utf8");
    const r = await htmlgate(d, { HOME: d }, ["logout"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("https://a.example");
    expect(r.stderr).toContain("https://b.example");
    expect(readFileSync(storePath(d), "utf8")).toBe(before);
  });

  test("an empty or non-object store is damaged: it is refused, not treated as empty, and login leaves it alone", async () => {
    const s = await stub();
    for (const text of ["", "[]", '{"instances": []}', '{"instances": {"https://a.example": "tok"}}', "null"]) {
      const d = fresh("damaged");
      mkdirSync(join(d, ".config/htmlgate"), { recursive: true });
      writeFileSync(storePath(d), text);
      const l = await htmlgate(d, { HOME: d }, ["login", s.url, "--token-stdin"], TOKEN);
      expect(l.code, `login over ${JSON.stringify(text)}`).toBe(7);
      expect(readFileSync(storePath(d), "utf8")).toBe(text);
      const st = await htmlgate(d, { HOME: d, HTMLGATE_URL: s.url }, ["status"]);
      expect(st.code, `status over ${JSON.stringify(text)}`).toBe(7);
    }
    expect(s.auths).toEqual([]);
  });

  test("a 0700 directory and 0600 file stay that way across a second login and a logout", async () => {
    const s = await stub();
    const d = fresh("modes");
    for (const args of [["login", s.url, "--token-stdin"], ["login", s.url, "--token-stdin"], ["logout", s.url]]) {
      const r = await htmlgate(d, { HOME: d }, args, TOKEN);
      expect(r.code, r.stderr).toBe(0);
      expect(statSync(storePath(d)).mode & 0o777).toBe(0o600);
      expect(statSync(join(d, ".config/htmlgate")).mode & 0o777).toBe(0o700);
    }
  });
});

describe("the stored origin is trusted as written", () => {
  // The store is a hand-editable file. Every other route to an Instance goes through instanceOrigin, which refuses
  // plain http beyond loopback; a stored key skips it (packages/cli/src/config.ts, selectInstance and resolve).
  test("a stored http://0.0.0.0 origin (not on the loopback list, yet reachable locally) gets no token, the same as $HTMLGATE_URL for it", async () => {
    const s = await stub("0.0.0.0");
    const origin = `http://0.0.0.0:${s.port}`;
    const d = fresh("storehttp");
    const viaEnv = await htmlgate(d, { HOME: d, HTMLGATE_URL: origin, HTMLGATE_TOKEN: TOKEN }, ["list"]);
    expect(viaEnv.code).toBe(8);
    expect(s.auths).toEqual([]);
    saveStore(d, { [origin]: TOKEN });
    const viaStore = await htmlgate(d, { HOME: d }, ["list"]);
    expect(s.auths, "the token went out over plain http").toEqual([]);
    // A stored key that is not a valid origin makes the store damaged (unsafe_path, exit 7), like any other damage.
    expect(viaStore.code).toBe(7);
  });
});

describe("errors found while parsing arguments ignore --output json", () => {
  test("a usage error with --output json is a JSON error on stderr, like every other error", async () => {
    const d = fresh("usage");
    for (const args of [["bogus"], ["publish", "x.html", "--title"], ["list", "--nope"]]) {
      const r = await htmlgate(d, { HOME: d }, args);
      expect(r.code).toBe(7);
      const first = r.stderr.trim().split("\n")[0]!;
      expect(() => JSON.parse(first), `stderr for ${args.join(" ")}: ${first}`).not.toThrow();
    }
  });
});

describe("tokens needs a sign-in before it checks its own arguments", () => {
  test("an unknown tokens subcommand, or a malformed id, is a usage error (7) even when not signed in", async () => {
    const d = fresh("tokens-args");
    expect((await htmlgate(d, { HOME: d }, ["tokens", "bogus"])).code).toBe(7);
    expect((await htmlgate(d, { HOME: d }, ["tokens", "revoke", "not-an-id"])).code).toBe(7);
    expect((await htmlgate(d, { HOME: d }, ["tokens"])).code).toBe(7);
  });
});

describe("against a real Instance", () => {
  let token: string;
  let dir: string;
  const env = () => ({ HOME: dir, HTMLGATE_URL: base, HTMLGATE_TOKEN: token });
  const cli = (...args: string[]) => htmlgate(dir, env(), args);
  beforeAll(async () => {
    token = await mintToken("reviewer-redesign");
    dir = fresh("real");
    writeFileSync(join(dir, "a.html"), page("one"));
    writeFileSync(join(dir, "b.html"), page("two"));
  });

  test("login against the real Instance saves a token that then works with no environment at all; status says where it came from", async () => {
    const d = fresh("real-login");
    const l = await htmlgate(d, { HOME: d }, ["login", base, "--token-stdin"], token + "\n");
    expect(l.code, l.stderr).toBe(0);
    const st = await htmlgate(d, { HOME: d }, ["status"]);
    expect(st.code, st.stderr).toBe(0);
    expect(st.out).toEqual({ api_url: base, instance_from: "credentials", token_from: "credentials" });
    expect(st.stdout).not.toContain(token);
    // After `logout` the same command is refused offline.
    expect((await htmlgate(d, { HOME: d }, ["logout"])).out).toEqual({ removed: true, api_url: base });
    expect((await htmlgate(d, { HOME: d }, ["status"])).code).toBe(2);
  });

  test("a matched upsert keeps the Share's description as well as its title and tags; --slug keeps description and title", async () => {
    const p = await cli("publish", "a.html", "--title", "Keep me", "--description", "kept description", "--metadata", "rv=redesign", "--metadata", "env=x");
    expect(p.code, p.stderr).toBe(0);
    const up = await cli("publish", "b.html", "--upsert", "--metadata", "rv=redesign");
    expect(up.out).toMatchObject({ slug: p.out.slug, matched: true });
    const bySlug = await cli("publish", "a.html", "--slug", p.out.slug);
    expect(bySlug.code, bySlug.stderr).toBe(0);
    const got = await api(token)("GET", `/api/shares/${p.out.slug}`);
    expect(got.json).toMatchObject({ title: "Keep me", description: "kept description", latest_version: 3, public: false, metadata: { rv: "redesign", env: "x" } });
    await cli("delete", p.out.slug);
  });

  test("tokens revoke of a prefix of a real id is refused before any request", async () => {
    const list = await cli("tokens", "list");
    const id: string = list.out[0].id;
    expect((await cli("tokens", "revoke", id.slice(0, 8))).code).toBe(7);
    expect((await cli("tokens", "list")).out.find((t: any) => t.id === id).revoked_at).toBeNull();
  });
});
