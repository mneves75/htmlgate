// The htmlgate CLI (packages/cli) against a local Instance: every command, login and which token it uses.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { api, base, htmlgate, mintToken, page } from "./helpers";

let dir: string;
let token: string;
const env = () => ({ HOME: dir, HTMLGATE_URL: base, HTMLGATE_TOKEN: token });
const cli = (...args: string[]) => htmlgate(dir, env(), args);
const fresh = (prefix: string) => mkdtempSync(join(tmpdir(), `htmlgate-cli-${prefix}-`));

beforeAll(async () => {
  token = await mintToken("cli");
  dir = fresh("main");
  writeFileSync(join(dir, "page.html"), page("from the CLI"));
  writeFileSync(join(dir, "page2.html"), page("second"));
});

describe("the htmlgate CLI against an Instance", () => {
  test("publish, update, url, list, upsert and delete", async () => {
    const pub = await cli("publish", "page.html", "--title", "CLI page", "--metadata", "pr=42");
    expect(pub.code, pub.stderr).toBe(0);
    const slug: string = pub.out.slug;
    expect(pub.out.url).toBe(`${base}/s/${slug}`);

    const call = api(token);
    expect((await call("GET", `/api/shares/${slug}/versions/1`)).json.html).toBe(page("from the CLI"));
    expect((await call("GET", `/api/shares/${slug}`)).json.public).toBe(false);

    const upd = await cli("update", slug, "--file", "page2.html");
    expect(upd.code, upd.stderr).toBe(0);
    expect(upd.out.mode).toBe("put");
    expect((await call("GET", `/api/shares/${slug}`)).json.latest_version).toBe(2);

    const ren = await cli("update", slug, "--title", "Renamed");
    expect(ren.code, ren.stderr).toBe(0);
    expect((await call("GET", `/api/shares/${slug}`)).json).toMatchObject({ title: "Renamed", latest_version: 2 });

    expect((await cli("url", slug)).out).toMatchObject({ url: `${base}/s/${slug}`, slug });
    expect(JSON.stringify((await cli("list", "--metadata", "pr=42")).out)).toContain(slug);

    const ups = await cli("publish", "page.html", "--title", "CLI page", "--upsert", "--metadata", "pr=42");
    expect(ups.code, ups.stderr).toBe(0);
    expect(ups.out).toMatchObject({ slug, matched: true });
    expect((await call("GET", `/api/shares/${slug}`)).json.latest_version).toBe(3);

    const other = await cli("publish", "page.html", "--title", "Other", "--upsert", "--metadata", "pr=43");
    expect(other.code, other.stderr).toBe(0);
    expect(other.out.slug).not.toBe(slug);

    expect((await cli("delete", slug)).out).toMatchObject({ deleted: true, slug });
    expect((await call("GET", `/api/shares/${slug}`)).status).toBe(404);
  });

  test("the title defaults to the file name, and text output prints the URL", async () => {
    const r = await cli("publish", "page2.html");
    expect((await api(token)("GET", `/api/shares/${r.out.slug}`)).json.title).toBe("page2");
    const { execFileSync } = await import("node:child_process");
    const text = execFileSync(process.execPath, [join(process.cwd(), "packages/cli/dist/bin.js"), "url", r.out.slug], { cwd: dir, env: { PATH: process.env.PATH!, ...env() }, encoding: "utf8" });
    expect(text).toBe(`${base}/s/${r.out.slug}\n`);
  });

  test("public and gate move the gate; list --public and --gated filter by it; url follows it", async () => {
    const t = "pg-" + Math.random().toString(36).slice(2, 8);
    const { out } = await cli("publish", "page.html", "--title", "G", "--metadata", `t=${t}`);
    const pub = await cli("public", out.slug);
    expect(pub.code, pub.stderr).toBe(0);
    expect(pub.out).toMatchObject({ slug: out.slug, public: true, url: `${base}/p/${out.slug}` });
    expect((await fetch(`${base}/p/${out.slug}`)).status).toBe(200);
    expect((await cli("url", out.slug)).out.url).toBe(`${base}/p/${out.slug}`);
    expect(JSON.stringify((await cli("list", "--public", "--metadata", `t=${t}`)).out)).toContain(out.slug);
    expect(JSON.stringify((await cli("list", "--gated", "--metadata", `t=${t}`)).out)).not.toContain(out.slug);

    const gate = await cli("gate", out.slug);
    expect(gate.out).toMatchObject({ public: false, url: `${base}/s/${out.slug}` });
    expect((await fetch(`${base}/p/${out.slug}`)).status).toBe(404);
    expect(JSON.stringify((await cli("list", "--gated", "--metadata", `t=${t}`)).out)).toContain(out.slug);
    expect((await cli("list", "--public", "--gated")).code).toBe(7);
    expect((await cli("public", "AAAAAAAAAAAA")).code).toBe(4);
  });

  test("versions lists the kept Versions and the token that wrote each", async () => {
    const { out } = await cli("publish", "page.html", "--title", "V");
    await cli("update", out.slug, "--file", "page2.html");
    const v = await cli("versions", out.slug);
    expect(v.code, v.stderr).toBe(0);
    expect(v.out.map((x: any) => x.n)).toEqual([2, 1]);
    expect(v.out[0].token.name).toBe("cli");
  });

  test("tokens list shows no secret; tokens revoke stops that token on its next request", async () => {
    const victim = await mintToken("cli-victim");
    const list = await cli("tokens", "list");
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).not.toMatch(/hg_[A-Za-z0-9]{40}/);
    const id: string = list.out.find((t: any) => t.name === "cli-victim").id;
    expect((await api(victim)("GET", "/api/shares")).status).toBe(200);
    expect((await cli("tokens", "revoke", id)).out).toMatchObject({ revoked: true, id });
    expect((await api(victim)("GET", "/api/shares")).status).toBe(401);
    expect((await cli("tokens", "revoke", id)).code).toBe(4);
    expect((await cli("tokens", "revoke", "not-an-id")).code).toBe(7);
  });

  test("upsert refuses when more than one Share matches, and changes neither", async () => {
    const t = "amb-" + Math.random().toString(36).slice(2, 8);
    const call = api(token);
    const a = (await call("POST", "/api/shares", { html: page("a"), title: "A", metadata: { t } })).json.slug;
    const b = (await call("POST", "/api/shares", { html: page("b"), title: "B", metadata: { t } })).json.slug;
    const r = await cli("publish", "page.html", "--title", "X", "--upsert", "--metadata", `t=${t}`);
    expect(r.code).toBe(7);
    expect(r.stderr).toContain(a);
    expect(r.stderr).toContain(b);
    for (const s of [a, b]) expect((await call("GET", `/api/shares/${s}`)).json.latest_version).toBe(1);
  });

  test("errors keep the exit codes: over 2 MiB exits 6 before sending, a missing Share 4, bad arguments 7, a revoked token 2", async () => {
    writeFileSync(join(dir, "big.html"), page("x".repeat(2 * 1024 * 1024 + 10)));
    const before = (await api(token)("GET", "/api/shares?pageSize=1")).json.pagination.total;
    expect((await cli("publish", "big.html", "--title", "big")).code).toBe(6);
    expect((await api(token)("GET", "/api/shares?pageSize=1")).json.pagination.total).toBe(before);
    expect((await cli("publish", "missing.html")).code).toBe(4);
    expect((await cli("update", "AAAAAAAAAAAA", "--title", "x")).code).toBe(4);
    expect((await cli("publish", "page.html", "--metadata", "novalue")).code).toBe(7);
    expect((await cli("frobnicate")).code).toBe(7);
    expect((await cli("update", "AAAAAAAAAAAA", "--metadata", "a=b", "--clear-metadata")).code).toBe(7);
    const own = await mintToken("cli-revoked");
    const id = (await api(token)("GET", "/api/tokens")).json.data.find((t: any) => t.name === "cli-revoked").id;
    await api(token)("DELETE", `/api/tokens/${id}`);
    const r = await htmlgate(dir, { HOME: dir, HTMLGATE_URL: base, HTMLGATE_TOKEN: own }, ["list"]);
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).not.toContain(own);
  });
});

describe("login, logout, status and which token a command uses", () => {
  const store = (home: string) => join(home, ".config/htmlgate/credentials");
  const readStore = (home: string) => JSON.parse(readFileSync(store(home), "utf8"));

  /** A stand-in Instance that answers every list request and records each request's Authorization header. */
  async function stub() {
    const auths: (string | undefined)[] = [];
    const s = createServer((req, res) => {
      auths.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "application/json" }).end('{"data":[],"pagination":{"page":1,"page_size":200,"total":0,"total_pages":1}}');
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
    return { url, auths, close: () => new Promise<void>((r) => s.close(() => r())) };
  }

  test("login --token-stdin checks the token, then saves it for that origin in the user's 0600 store, and never touches the project", async () => {
    const d = fresh("login");
    const r = await htmlgate(d, { HOME: d }, ["login", base, "--token-stdin"], token + "\n");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(token);
    expect(readStore(d)).toEqual({ instances: { [base]: { token } } });
    expect(statSync(store(d)).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, ".config/htmlgate")).mode & 0o077).toBe(0);
    expect(existsSync(join(d, ".htmlgate"))).toBe(false);
    // The only Instance signed in to is the default anywhere.
    expect((await htmlgate(fresh("elsewhere"), { HOME: d }, ["list", "-n", "1"])).code).toBe(0);

    const st = await htmlgate(d, { HOME: d }, ["status"]);
    expect(st.code, st.stderr).toBe(0);
    expect(st.out).toEqual({ api_url: base, instance_from: "credentials", token_from: "credentials" });
    expect(st.stdout + st.stderr).not.toContain(token);

    const out = await htmlgate(d, { HOME: d }, ["logout"]);
    expect(out.out).toEqual({ removed: true, api_url: base });
    expect(readStore(d)).toEqual({ instances: {} });
    expect((await htmlgate(d, { HOME: d }, ["list"])).code).toBe(2);
    expect((await htmlgate(d, { HOME: d }, ["status"])).code).toBe(2);
  });

  test("login takes the token from $HTMLGATE_TOKEN and the URL from $HTMLGATE_URL", async () => {
    const d = fresh("envlogin");
    const r = await htmlgate(d, { HOME: d, HTMLGATE_URL: base, HTMLGATE_TOKEN: token }, ["login"]);
    expect(r.code, r.stderr).toBe(0);
    expect(readStore(d).instances[base].token).toBe(token);
  });

  test("login uses $HTMLGATE_TOKEN only when $HTMLGATE_URL names the same Instance it signs in to", async () => {
    const other = await stub();
    try {
      const d = fresh("loginenv");
      // A CI token for this Instance must not be sent to, or saved under, another one.
      const r = await htmlgate(d, { HOME: d, HTMLGATE_URL: base, HTMLGATE_TOKEN: token }, ["login", other.url]);
      expect(r.code).toBe(2);
      expect(other.auths).toEqual([]);
      const alone = await htmlgate(d, { HOME: d, HTMLGATE_TOKEN: token }, ["login", other.url]);
      expect(alone.code).toBe(2);
      expect(other.auths).toEqual([]);
      expect(existsSync(store(d))).toBe(false);
    } finally {
      await other.close();
    }
  });

  test("an empty api_url in the project config is an error, not a silent fall-back to another Instance", async () => {
    const d = fresh("emptyurl");
    expect((await htmlgate(d, { HOME: d }, ["login", base, "--token-stdin"], token)).code).toBe(0);
    mkdirSync(join(d, ".htmlgate"));
    writeFileSync(join(d, ".htmlgate/config"), 'api_url = ""\n');
    expect((await htmlgate(d, { HOME: d }, ["list"])).code).toBe(7);
  });

  test("login never takes its URL from a project's .htmlgate/config, so a cloned repository cannot collect the token", async () => {
    const evil = await stub();
    try {
      const d = fresh("loginproj");
      mkdirSync(join(d, ".htmlgate"));
      writeFileSync(join(d, ".htmlgate/config"), `api_url = "${evil.url}"\n`);
      const r = await htmlgate(d, { HOME: d }, ["login", "--token-stdin"], token);
      expect(r.code).toBe(7);
      expect(evil.auths).toEqual([]);
      expect(existsSync(store(d))).toBe(false);
    } finally {
      await evil.close();
    }
  });

  test("a refused or malformed token changes nothing in the store, and without a token source login exits 2", async () => {
    const d = fresh("bad");
    const wrong = "hg_" + "A".repeat(40);
    expect((await htmlgate(d, { HOME: d }, ["login", base, "--token-stdin"], wrong)).code).toBe(2);
    expect(existsSync(store(d))).toBe(false);
    expect((await htmlgate(d, { HOME: d }, ["login", base, "--token-stdin"], "not-a-token")).code).toBe(2);
    expect((await htmlgate(d, { HOME: d }, ["login", base])).code).toBe(2); // no TTY, no variable, no stdin flag

    expect((await htmlgate(d, { HOME: d }, ["login", base, "--token-stdin"], token)).code).toBe(0);
    const before = readFileSync(store(d), "utf8");
    expect((await htmlgate(d, { HOME: d }, ["login", base, "--token-stdin"], wrong)).code).toBe(2);
    expect(readFileSync(store(d), "utf8")).toBe(before);
  });

  test("two Instances in one store: each token goes only to its own origin, and with no choice made the CLI refuses", async () => {
    const other = await stub();
    const otherToken = "hg_" + "O".repeat(40);
    try {
      const d = fresh("two");
      expect((await htmlgate(d, { HOME: d }, ["login", base, "--token-stdin"], token)).code).toBe(0);
      expect((await htmlgate(d, { HOME: d }, ["login", other.url, "--token-stdin"], otherToken)).code).toBe(0);
      expect(Object.keys(readStore(d).instances).sort()).toEqual([base, other.url].sort());

      const none = await htmlgate(d, { HOME: d }, ["list"]);
      expect(none.code).toBe(2);
      expect(none.stderr).toContain(other.url);
      const before = other.auths.length;

      mkdirSync(join(d, ".htmlgate"));
      writeFileSync(join(d, ".htmlgate/config"), `api_url = "${base}"\n`);
      expect((await htmlgate(d, { HOME: d }, ["list", "-n", "1"])).code).toBe(0);
      expect(other.auths.length).toBe(before);

      writeFileSync(join(d, ".htmlgate/config"), `api_url = "${other.url}"\n`);
      expect((await htmlgate(d, { HOME: d }, ["list"])).code).toBe(0);
      expect(other.auths.at(-1)).toBe(`Bearer ${otherToken}`);
      expect(other.auths).not.toContain(`Bearer ${token}`);

      expect((await htmlgate(d, { HOME: d }, ["logout", other.url])).out).toEqual({ removed: true, api_url: other.url });
      expect(Object.keys(readStore(d).instances)).toEqual([base]);
    } finally {
      await other.close();
    }
  });

  test("$HTMLGATE_TOKEN is used only with $HTMLGATE_URL, where it wins over the store", async () => {
    const evil = await stub();
    try {
      const d = fresh("envtok");
      expect((await htmlgate(d, { HOME: d }, ["login", base, "--token-stdin"], token)).code).toBe(0);
      mkdirSync(join(d, ".htmlgate"));
      writeFileSync(join(d, ".htmlgate/config"), `api_url = "${evil.url}"\n`);
      const r = await htmlgate(d, { HOME: d, HTMLGATE_TOKEN: token }, ["list"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("HTMLGATE_URL");
      expect(evil.auths).toEqual([]);

      const wins = await htmlgate(d, { HOME: d, HTMLGATE_URL: base, HTMLGATE_TOKEN: "hg_" + "B".repeat(40) }, ["list"]);
      expect(wins.code).toBe(2);
      expect(wins.stderr).toContain("unauthorized");
      const st = await htmlgate(d, { HOME: d, HTMLGATE_URL: base, HTMLGATE_TOKEN: token }, ["status"]);
      expect(st.out).toEqual({ api_url: base, instance_from: "HTMLGATE_URL", token_from: "HTMLGATE_TOKEN" });
    } finally {
      await evil.close();
    }
  });

  test("$XDG_CONFIG_HOME holds the store when absolute, is ignored when relative, and may be a symlink", async () => {
    const d = fresh("xdg");
    const xdg = fresh("xdgdir");
    expect((await htmlgate(d, { HOME: d, XDG_CONFIG_HOME: xdg }, ["login", base, "--token-stdin"], token)).code).toBe(0);
    expect(existsSync(join(xdg, "htmlgate/credentials"))).toBe(true);
    expect(existsSync(store(d))).toBe(false);

    const rel = fresh("xdgrel");
    expect((await htmlgate(rel, { HOME: rel, XDG_CONFIG_HOME: "conf" }, ["login", base, "--token-stdin"], token)).code).toBe(0);
    expect(existsSync(join(rel, "conf"))).toBe(false);
    expect(existsSync(store(rel))).toBe(true);

    const real = fresh("xdgreal");
    const linkHome = fresh("xdglink");
    symlinkSync(real, join(linkHome, "cfg"));
    expect((await htmlgate(linkHome, { HOME: linkHome, XDG_CONFIG_HOME: join(linkHome, "cfg") }, ["login", base, "--token-stdin"], token)).code).toBe(0);
    expect(existsSync(join(real, "htmlgate/credentials"))).toBe(true);
  });

  test("login refuses to write the store through a symlink, and asks the Instance nothing", async () => {
    const d = fresh("link");
    const target = join(fresh("target"), "elsewhere");
    mkdirSync(join(d, ".config/htmlgate"), { recursive: true });
    symlinkSync(target, store(d));
    const r = await htmlgate(d, { HOME: d }, ["login", base, "--token-stdin"], token);
    expect(r.code).toBe(7);
    expect(existsSync(target)).toBe(false);
  });

  test("two logins at once to different Instances keep both tokens", async () => {
    const other = await stub();
    try {
      const d = fresh("race");
      const runs = await Promise.all([
        htmlgate(d, { HOME: d }, ["login", base, "--token-stdin"], token),
        htmlgate(d, { HOME: d }, ["login", other.url, "--token-stdin"], "hg_" + "C".repeat(40)),
      ]);
      expect(runs.map((r) => r.code)).toEqual([0, 0]);
      expect(Object.keys(readStore(d).instances).sort()).toEqual([base, other.url].sort());
    } finally {
      await other.close();
    }
  });

  test("a matched upsert adds a Version and keeps every tag the Share already had", async () => {
    const t = "keep-" + Math.random().toString(36).slice(2, 8);
    const call = api(token);
    const slug = (await call("POST", "/api/shares", { html: page("a"), title: "K", metadata: { t, status: "draft" } })).json.slug;
    const r = await cli("publish", "page.html", "--title", "K", "--upsert", "--metadata", `t=${t}`);
    expect(r.out).toMatchObject({ slug, matched: true });
    expect((await call("GET", `/api/shares/${slug}`)).json).toMatchObject({ latest_version: 2, metadata: { t, status: "draft" } });
  });

  test("publish --slug without --title keeps the Share's title", async () => {
    const call = api(token);
    const slug = (await call("POST", "/api/shares", { html: page("a"), title: "Kept title" })).json.slug;
    expect((await cli("publish", "page.html", "--slug", slug)).code).toBe(0);
    expect((await call("GET", `/api/shares/${slug}`)).json).toMatchObject({ title: "Kept title", latest_version: 2 });
  });

  test("a matched upsert without --title keeps the Share's title; with --title it changes it", async () => {
    const t = "title-" + Math.random().toString(36).slice(2, 8);
    const call = api(token);
    const slug = (await call("POST", "/api/shares", { html: page("a"), title: "Chosen title", metadata: { t } })).json.slug;
    expect((await cli("publish", "page.html", "--upsert", "--metadata", `t=${t}`)).out.slug).toBe(slug);
    expect((await call("GET", `/api/shares/${slug}`)).json.title).toBe("Chosen title");
    await cli("publish", "page.html", "--upsert", "--title", "New title", "--metadata", `t=${t}`);
    expect((await call("GET", `/api/shares/${slug}`)).json.title).toBe("New title");
  });
});
