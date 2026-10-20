// The Operator's commands: setup's Access application, the instance file, and the token command. Decision: #15.
import { execFile } from "node:child_process";
import { createServer, type RequestListener } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
// @ts-expect-error plain JavaScript module
import { accessApp, checkDomain, checkSameAccount, deploymentUrls, gated, generatedConfig, instanceVars, isGateRedirect, listWorkers, r2NotEnabled, readInstance, workerConfig, wranglerWho } from "../scripts/setup.mjs";
import { AUTHOR, settings, startInstance, type Instance } from "./global-setup";

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), "htmlgate-op-"));
const file = (name: string, body: unknown) => {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
};

describe("the instance file", () => {
  test("names the Author and the Allowlist; the Author is always on it; emails are lowercased", () => {
    const inst = readInstance(file("ok.json", { name: "my-bin", authorEmail: "Me@Example.com", allowlist: ["A@b.c"] }));
    expect(inst).toEqual({ name: "my-bin", author: "me@example.com", allowlist: ["me@example.com", "a@b.c"], language: "en", expiryDays: 30 });
  });

  test("sets the Instance's language: English unless the file says pt-BR", () => {
    const base = { name: "ok", authorEmail: "a@b.c", allowlist: [] };
    expect(readInstance(file("en.json", base)).language).toBe("en");
    expect(readInstance(file("en2.json", { ...base, language: "en" })).language).toBe("en");
    expect(readInstance(file("pt.json", { ...base, language: "pt-BR" })).language).toBe("pt-BR");
    for (const language of ["pt", "pt-br", "fr", 1, null]) {
      expect(() => readInstance(file("lang.json", { ...base, language })), JSON.stringify(language)).toThrow(/language/);
    }
  });

  test("the deployed Worker gets every setting, the language included", () => {
    const inst = readInstance(file("vars.json", { name: "ok", authorEmail: "Me@Example.com", allowlist: ["a@b.c"], language: "pt-BR" }));
    expect(instanceVars(inst, "https://team.cloudflareaccess.com", "aud123")).toEqual({
      ACCESS_TEAM_URL: "https://team.cloudflareaccess.com", ACCESS_AUD: "aud123", AUTHOR_EMAIL: "me@example.com",
      ALLOWLIST: "me@example.com,a@b.c", LANGUAGE: "pt-BR", EXPIRY_DAYS: "30",
    });
  });

  test("expiryDays defaults to 30, 0 means never, and anything but 0 to 3650 whole days is refused", () => {
    const at = (expiryDays: unknown) => readInstance(file("expiry.json", { name: "ok", authorEmail: "a@b.c", allowlist: [], expiryDays }));
    expect(at(0).expiryDays).toBe(0);
    expect(at(3650).expiryDays).toBe(3650);
    for (const bad of [-1, 1.5, 3651, "30", null]) expect(() => at(bad)).toThrow(/expiryDays/);
  });

  test.each([
    [{ name: "My Bin", authorEmail: "a@b.c", allowlist: [] }, /name/],
    [{ name: "ok", authorEmail: "nope", allowlist: [] }, /authorEmail/],
    [{ name: "ok", authorEmail: "a@b.c", allowlist: ["*@b.c, x"] }, /allowlist/],
    [{ name: "ok", authorEmail: "a@b.c" }, /allowlist/],
  ])("refuses %j", (body, why) => {
    expect(() => readInstance(file("bad.json", body))).toThrow(why);
  });

  test.each(["https://html.example.com", "example", "html.example.com/x", ".example.com", "a_b.example.com", "html..example.com", 42])(
    "refuses the domain %j",
    (domain) => {
      expect(() => readInstance(file("bad.json", { name: "ok", authorEmail: "a@b.c", allowlist: [], domain }))).toThrow(/domain/);
    },
  );

  test.each([
    "html.example.com.",
    "*.example.com",
    "html.example.com:8443",
    "1.2.3.4",
    "localhost",
    "-a.example.com",
    "a-.example.com",
    "",
    "   ",
    null,
    ["html.example.com"],
    { host: "html.example.com" },
    "html.example.com\nx.example.com",
    "html.example.com?x=1",
    "user@html.example.com",
    `${"a".repeat(64)}.example.com`,
    `${"a.".repeat(127)}com`,
  ])("also refuses the domain %j", (domain) => {
    expect(() => readInstance(file("bad.json", { name: "ok", authorEmail: "a@b.c", allowlist: [], domain }))).toThrow(/domain/);
  });

  test.each([
    ["example.com", "example.com"],
    ["  Html.Example.COM  ", "html.example.com"],
    ["a.b.c.example.co.uk", "a.b.c.example.co.uk"],
    ["xn--caf-dma.example.com", "xn--caf-dma.example.com"],
    ["a".repeat(63) + ".example.com", "a".repeat(63) + ".example.com"],
  ])("accepts the domain %j as %j", (domain, expected) => {
    expect(readInstance(file("domain.json", { name: "ok", authorEmail: "a@b.c", allowlist: [], domain })).domain).toBe(expected);
  });

  test("a missing domain stays missing", () => {
    expect(readInstance(file("nodomain.json", { name: "ok", authorEmail: "a@b.c", allowlist: [] })).domain).toBeUndefined();
  });

  test("takes an optional domain, lowercased", () => {
    const inst = readInstance(file("domain.json", { name: "my-bin", authorEmail: "a@b.c", allowlist: [], domain: "HTML.Example.com" }));
    expect(inst.domain).toBe("html.example.com");
  });
});

describe("the domain check setup runs before it writes anything", () => {
  const inst = { name: "my-bin", author: "a@b.c", allowlist: ["a@b.c"], domain: "html.example.com" };
  const zone = { id: "z1", name: "example.com", status: "active" };
  const worker = (name: string, ...hosts: [string, string][]) => ({ name, references: { domains: hosts.map(([id, hostname]) => ({ id, hostname })) } });
  // A stand-in for the cf CLI: answers the three reads the check makes and records every call.
  const fakeCf = ({ zones = [zone], workers = [] as unknown[], records = [] as unknown[] } = {}) => {
    const calls: string[][] = [];
    const cf = (...args: string[]) => {
      calls.push(args);
      if (args[0] === "zones") return zones.filter((z) => z.name === args[args.indexOf("--name") + 1]);
      if (args[0] === "workers") return args[args.indexOf("--page") + 1] === "1" ? workers : [];
      if (args[0] === "dns") return records;
      throw new Error(`unexpected cf ${args.join(" ")}`);
    };
    return { cf, calls };
  };

  test("an Instance without a domain makes no calls", () => {
    const { cf, calls } = fakeCf();
    checkDomain({ ...inst, domain: undefined }, cf);
    expect(calls).toEqual([]);
  });

  test("an unused hostname in an active zone passes, and the check only reads", () => {
    const { cf, calls } = fakeCf({ workers: [worker("my-bin")] });
    expect(() => checkDomain(inst, cf)).not.toThrow();
    expect(calls.every((c) => c.includes("list"))).toBe(true);
    expect(calls.find((c) => c[0] === "dns")).toEqual(["dns", "records", "list", "-z", "z1", "--name", "html.example.com", "--per-page", "100"]);
  });

  test("a rerun passes when the domain is already this Worker's", () => {
    const records = [{ type: "AAAA", meta: { origin_worker_id: "d1", read_only: true } }];
    const { cf } = fakeCf({ workers: [worker("my-bin", ["d1", "html.example.com"])], records });
    expect(() => checkDomain(inst, cf)).not.toThrow();
  });

  test("mail records on the domain (Email Routing's MX and TXT) never block it", () => {
    const records = [{ type: "AAAA", meta: { origin_worker_id: "d1", read_only: true } }, { type: "MX", meta: {} }, { type: "TXT", meta: {} }];
    const { cf } = fakeCf({ workers: [worker("my-bin", ["d1", "html.example.com"])], records });
    expect(() => checkDomain(inst, cf)).not.toThrow();
    expect(() => checkDomain(inst, fakeCf({ workers: [worker("my-bin")], records: [{ type: "MX", meta: {} }] }).cf)).not.toThrow();
  });

  test("reads every page of Workers: the owner may be past the first", () => {
    const pages = [[worker("a")], [worker("my-bin", ["d1", "html.example.com"])], []];
    const calls: string[] = [];
    const cf = (...args: string[]) => {
      if (args[0] !== "workers") throw new Error("unexpected");
      const page = Number(args[args.indexOf("--page") + 1]);
      calls.push(String(page));
      return pages[page - 1] ?? [];
    };
    expect(listWorkers(cf).map((w: { name: string }) => w.name)).toEqual(["a", "my-bin"]);
    expect(calls).toEqual(["1", "2", "3"]);
  });

  test("the zone is the longest suffix on a label boundary, and the apex can be the domain", () => {
    const { cf, calls } = fakeCf({ zones: [{ id: "z0", name: "ample.com", status: "active" }, zone, { id: "z2", name: "html.example.com", status: "active" }] });
    checkDomain(inst, cf);
    expect(calls.find((c) => c[0] === "dns")?.[4]).toBe("z2");
    const apex = fakeCf({ zones: [{ id: "z0", name: "ample.com", status: "active" }] });
    expect(() => checkDomain(inst, apex.cf)).toThrow(/no active zone/);
  });

  test.each([
    ["no zone on the account covers it", { zones: [] }, /no active zone/],
    ["its zone is not active", { zones: [{ ...zone, status: "pending" }] }, /no active zone/],
    ["another Worker serves it", { workers: [worker("my-bin"), worker("other", ["d9", "html.example.com"])] }, /Worker other/],
    ["it has a plain DNS record", { records: [{ type: "CNAME", meta: {} }] }, /CNAME record/],
    ["it has a plain address record beside mail records", { records: [{ type: "MX", meta: {} }, { type: "A", meta: {} }] }, /A record/],
    ["it has a Worker record this Worker does not own", { workers: [worker("my-bin")], records: [{ type: "AAAA", meta: { origin_worker_id: "d9", read_only: true } }] }, /AAAA record/],
    ["the Worker list is not a list", { workers: { error: "nope" } as unknown as unknown[] }, /Worker list/],
    ["the DNS answer is not a list", { records: { error: "nope" } as unknown as unknown[] }, /DNS record list/],
  ])("refuses when %s", (_why, fixtures, message) => {
    const { cf } = fakeCf(fixtures as Parameters<typeof fakeCf>[0]);
    expect(() => checkDomain(inst, cf)).toThrow(message);
  });
});

describe("the gate check", () => {
  const team = "https://team.cloudflareaccess.com";
  const gate = { teamUrl: team, aud: "aud1", host: "html.example.com" };
  const login = (origin: string, kid: string, host = "html.example.com") => `${origin}/cdn-cgi/access/login/${host}?kid=${kid}&redirect_url=%2F`;

  test("accepts a redirect to this team's sign-in for this application and hostname", () => {
    expect(isGateRedirect(302, login(team, "aud1"), gate)).toBe(true);
  });

  test.each([
    ["another application", 302, login(team, "aud2")],
    ["a look-alike team origin", 302, login("https://team.cloudflareaccess.com.evil.example", "aud1")],
    ["another hostname's sign-in", 302, login(team, "aud1", "other.example.com")],
    ["no redirect", 200, login(team, "aud1")],
    ["no location", 302, null],
    ["a broken location", 302, "::not a url"],
  ])("refuses %s", (_why, status, location) => {
    expect(isGateRedirect(status, location, gate)).toBe(false);
  });
});

describe("the gate check against a live hostname", () => {
  const team = "https://team.example.com";
  const servers: { close: () => void }[] = [];
  afterAll(() => servers.forEach((s) => s.close()));
  const serve = async (handler: RequestListener) => {
    const server = createServer(handler);
    servers.push({ close: () => server.close() });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    return `http://127.0.0.1:${port}`;
  };
  const signIn = (host: string) => `${team}/cdn-cgi/access/login/${host}?kid=aud1`;
  // A check that never gives up fails here by assertion ("hung") instead of hanging until the test timeout.
  const bounded = async <T>(check: Promise<T>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([check, new Promise<"hung">((r) => { timer = setTimeout(() => r("hung"), 5000); })]);
    } finally {
      clearTimeout(timer);
    }
  };

  test("passes a hostname that sends people to sign in, asks Publishers for a token and leaves /f/ to the Worker", async () => {
    const url = await serve((req, res) => {
      if (req.url === "/") res.writeHead(302, { location: signIn(req.headers.host!) }).end();
      else if (req.url!.startsWith("/f/")) res.writeHead(404).end();
      else res.writeHead(401).end();
    });
    expect(await gated(url, { teamUrl: team, aud: "aud1" }, { budgetMs: 2000, pauseMs: 50 })).toBe(true);
  });

  test("fails when Access, not the Worker, answers a ticket path", async () => {
    const url = await serve((req, res) => {
      if (req.url === "/" || req.url!.startsWith("/f/")) res.writeHead(302, { location: signIn(req.headers.host!) }).end();
      else res.writeHead(401).end();
    });
    expect(await bounded(gated(url, { teamUrl: team, aud: "aud1" }, { budgetMs: 300, pauseMs: 50 }))).toBe(false);
  });

  test("fails when the API answers with a redirect instead of a 401", async () => {
    const url = await serve((req, res) => {
      if (req.url === "/") res.writeHead(302, { location: signIn(req.headers.host!) }).end();
      else if (req.url === "/api/shares") res.writeHead(302, { location: "/elsewhere" }).end();
      // /f/ reaches the Worker, so only the API's redirect can fail this check.
      else if (req.url!.startsWith("/f/")) res.writeHead(404).end();
      else res.writeHead(401).end();
    });
    expect(await bounded(gated(url, { teamUrl: team, aud: "aud1" }, { budgetMs: 300, pauseMs: 50 }))).toBe(false);
  });

  test("gives up on a hostname that never answers, within its budget", async () => {
    const url = await serve(() => {});
    const started = Date.now();
    expect(await bounded(gated(url, { teamUrl: team, aud: "aud1" }, { budgetMs: 500, pauseMs: 50 }))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("the account check: Wrangler and cf must act on one and the same account", () => {
  const A = { id: "a".repeat(32), name: "Personal" };
  const B = { id: "b".repeat(32), name: "Work" };
  const wr = (...accounts: unknown[]) => ({ loggedIn: true, accounts });
  const cfw = (...accounts: unknown[]) => ({ tokenValid: true, accounts });

  test("one shared account passes and is returned", () => {
    expect(checkSameAccount(wr(A), cfw(A), {})).toBe(A.id);
  });

  test("two different accounts are refused, naming both", () => {
    expect(() => checkSameAccount(wr(A), cfw(B), {})).toThrow(/Personal.*Work|Work.*Personal/);
  });

  test("Wrangler with several accounts needs CLOUDFLARE_ACCOUNT_ID, and the one named must be cf's", () => {
    expect(() => checkSameAccount(wr(A, B), cfw(A), {})).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    expect(checkSameAccount(wr(A, B), cfw(A), { CLOUDFLARE_ACCOUNT_ID: A.id })).toBe(A.id);
    expect(() => checkSameAccount(wr(A, B), cfw(A), { CLOUDFLARE_ACCOUNT_ID: B.id })).toThrow();
    expect(() => checkSameAccount(wr(A), cfw(A), { CLOUDFLARE_ACCOUNT_ID: B.id })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });

  test("cf reaching several accounts is refused, because which one it acts on cannot be told", () => {
    expect(() => checkSameAccount(wr(A), cfw(A, B), {})).toThrow(/one account/);
  });

  test("a tool that is not logged in, or reports no account, is refused", () => {
    expect(() => checkSameAccount({ loggedIn: false, accounts: [A] }, cfw(A), {})).toThrow(/wrangler login/);
    expect(() => checkSameAccount(wr(A), { tokenValid: false, accounts: [A] }, {})).toThrow(/cf auth login/);
    expect(() => checkSameAccount(wr(), cfw(A), {})).toThrow();
    expect(() => checkSameAccount(wr(A), cfw(), {})).toThrow();
  });

  test("a logged-out Wrangler, which exits 1, gets the login hint rather than a generic failure", () => {
    const { CLOUDFLARE_API_TOKEN: _t, CLOUDFLARE_ACCOUNT_ID: _a, ...env } = process.env;
    const who = wranglerWho({ ...env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "htmlgate-nologin-")) });
    expect(who).toEqual({ loggedIn: false });
    expect(() => checkSameAccount(who, cfw(A), {})).toThrow(/wrangler login/);
  });

  test("a scoped token that cannot list accounts says which permission it lacks", () => {
    expect(() => checkSameAccount(wr(), cfw(A), { CLOUDFLARE_ACCOUNT_ID: A.id })).toThrow(/Account Settings: Read/);
  });
});

describe("setup's order", () => {
  test("checks that both tools share one account before its first write", async () => {
    const { readFileSync } = await import("node:fs");
    const main = readFileSync("scripts/setup.mjs", "utf8").split("async function main()")[1]!;
    const check = main.indexOf("checkSameAccount(");
    const firstWrite = Math.min(...['"create"', '"deploy"', '"apply"'].map((w) => main.indexOf(w)).filter((i) => i >= 0));
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(firstWrite);
  });


  test("checks the domain before its first write", async () => {
    const { readFileSync } = await import("node:fs");
    const main = readFileSync("scripts/setup.mjs", "utf8").split("async function main()")[1]!;
    const check = main.indexOf("checkDomain(inst, cf);");
    const firstWrite = Math.min(...['"create"', '"deploy"', '"apply"'].map((w) => main.indexOf(w)).filter((i) => i >= 0));
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(firstWrite);
  });
});

describe("the Worker config setup deploys", () => {
  const inst = { name: "my-bin", author: "a@b.c", allowlist: ["a@b.c"], domain: "html.example.com" };
  const db = { name: "my-bin-db", uuid: "u1" };

  test("the generated bootstrap marker alone cannot open any gated route", async () => {
    const config = workerConfig(inst, db, { open: false, vars: {} });
    const instance = await startInstance(config.vars);
    try {
      for (const path of ["/", "/tokens", "/s/AAAAAAAAAAAA", "/s/AAAAAAAAAAAA/raw"]) {
        const response = await fetch(instance.base + path, { headers: { "cf-access-jwt-assertion": "forged" } });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: { code: "server_misconfigured" } });
      }
    } finally { await instance.stop(); }
  });

  test("the first deploy answers nowhere: no workers.dev and no custom domain", () => {
    const c = workerConfig(inst, db, { open: false, vars: {} });
    expect(c.workers_dev).toBe(false);
    expect(c.routes).toBeUndefined();
    expect(c.vars).toEqual({ HTMLGATE_INSTANCE: inst.name });
  });

  // workers.dev has no WAF and no Always Use HTTPS: with a domain it would be the way around both.
  test("the gated deploy with a domain answers only there: workers.dev stays off", () => {
    const c = workerConfig(inst, db, { open: true, vars: {} });
    expect(c.workers_dev).toBe(false);
    expect(c.routes).toEqual([{ pattern: "html.example.com", custom_domain: true }]);
  });

  test("the gated deploy without a domain answers at workers.dev, its one hostname", () => {
    const c = workerConfig({ ...inst, domain: undefined }, db, { open: true, vars: {} });
    expect(c.workers_dev).toBe(true);
    expect(c.routes).toBeUndefined();
  });

  test("every deploy keeps the Worker's own error logs, but no per-request logs and no traces", () => {
    for (const domain of [inst.domain, undefined]) {
      for (const open of [false, true]) {
        expect(workerConfig({ ...inst, domain }, db, { open, vars: {} }).observability).toEqual({
          enabled: true, logs: { enabled: true, invocation_logs: false }, traces: { enabled: false },
        });
      }
    }
  });

  test("the first deploy has no routes key at all, with or without a domain", () => {
    expect("routes" in workerConfig(inst, db, { open: false, vars: {} })).toBe(false);
    expect("routes" in workerConfig({ ...inst, domain: undefined }, db, { open: false, vars: {} })).toBe(false);
  });

  test("opening adds the domain without losing the settings or the closed-preview flag", () => {
    const vars = { ACCESS_AUD: "aud" };
    const c = workerConfig(inst, db, { open: true, vars });
    expect(c.vars).toEqual({ ...vars, HTMLGATE_INSTANCE: inst.name });
    expect(c.preview_urls).toBe(false);
    expect(c.d1_databases[0].database_id).toBe("u1");
  });

  test("every deploy runs the hourly cleanup of expired Shares", () => {
    for (const open of [false, true]) expect(workerConfig(inst, db, { open, vars: {} }).triggers).toEqual({ crons: ["17 * * * *"] });
  });

  test("every deploy binds the Instance's own R2 bucket for Share bodies", () => {
    for (const open of [false, true]) {
      expect(workerConfig(inst, db, { open, vars: {} }).r2_buckets).toEqual([{ binding: "BODIES", bucket_name: "my-bin-bodies" }]);
    }
  });

  test("without a domain there are no routes", () => {
    expect(workerConfig({ ...inst, domain: undefined }, db, { open: true, vars: {} }).routes).toBeUndefined();
  });
});

describe("the hostname setup checks the gate on", () => {
  const inst = { name: "my-bin", author: "a@b.c", allowlist: ["a@b.c"], domain: "html.example.com" };
  const printed = "Deployed my-bin triggers\n  https://my-bin.acct.workers.dev\n  schedule: 17 * * * *";

  test("with a domain, only the domain", () => {
    expect(deploymentUrls(inst, "Deployed my-bin triggers\n  html.example.com (custom domain)")).toEqual(["https://html.example.com"]);
  });

  test("with a domain, a workers.dev URL in Wrangler's output means it is still on: setup refuses", () => {
    expect(() => deploymentUrls(inst, printed)).toThrow(/workers\.dev is still on/);
  });

  test("without a domain, the workers.dev URL Wrangler printed", () => {
    expect(deploymentUrls({ ...inst, domain: undefined }, printed)).toEqual(["https://my-bin.acct.workers.dev"]);
  });

  test("the privacy notice and docs say what setup logs: an Instance's errors, not every request", async () => {
    const { readFileSync } = await import("node:fs");
    const instances = (path: string) => readFileSync(path, "utf8").split('id="instances"')[1]!.split("</section>")[0]!;
    const en = instances("site/public/en/privacy/index.html");
    const pt = instances("site/public/privacidade/index.html");
    expect(en).not.toMatch(/records each request/);
    expect(en).toMatch(/only the Instance's unexpected errors/);
    expect(pt).not.toMatch(/registra cada pedido/);
    expect(pt).toMatch(/só os erros inesperados da Instância/);
    expect(readFileSync("docs/privacy.md", "utf8")).toMatch(/per-request invocation logs and traces off/);
  });

  test("without a domain and no workers.dev URL printed, it refuses rather than check nothing", () => {
    expect(() => deploymentUrls({ ...inst, domain: undefined }, "Deployed my-bin")).toThrow(/printed no workers\.dev URL/);
  });
});

test("setup names R2's 'not enabled' answer, and only that, as a missing subscription", () => {
  expect(r2NotEnabled("wrangler r2 bucket create failed: Please enable R2 through the Cloudflare Dashboard. [code: 10042]")).toBe(true);
  expect(r2NotEnabled("cf r2 buckets list failed: Authentication error [code: 10000]")).toBe(false);
});

describe("the Access application setup creates", () => {
  const app = accessApp({ name: "my-bin", author: "me@example.com", allowlist: ["me@example.com", "a@b.c"] }, "w123");

  test("the deployed config keeps the rule that bundles the card poster", () => {
    // Without it, `wrangler deploy` builds the Worker without the image module and the card points at nothing.
    const config = workerConfig({ name: "my-bin", author: "me@example.com", allowlist: ["me@example.com"] }, { name: "my-bin-db", uuid: "00000000-0000-0000-0000-000000000000" }, { open: true, vars: {} });
    expect(config.rules).toEqual([{ type: "Data", globs: ["**/media/*.jpg"], fallthrough: true }]);
  });

  test("gates the Worker everywhere except the API and the public prefixes", () => {
    expect(app.destinations).toEqual([{
      type: "worker", worker_id: "w123",
      overrides: [
        { behavior: "public", path_pattern: "/api/*" }, { behavior: "public", path_pattern: "/p/*" },
        { behavior: "public", path_pattern: "/f/*" },
      ],
    }]);
  });

  test("admits named emails only: no Everyone, no domain, no login method", () => {
    expect(app.policies).toHaveLength(1);
    expect(app.policies[0].decision).toBe("allow");
    expect(app.policies[0].include).toEqual([{ email: { email: "me@example.com" } }, { email: { email: "a@b.c" } }]);
    expect(JSON.stringify(app)).not.toMatch(/everyone|email_domain|login_method/);
  });

  test("a sign-in cookie that other sites cannot make the browser send, and no script can read", () => {
    expect(app.same_site_cookie_attribute).toBe("lax");
    expect(app.http_only_cookie_attribute).toBe(true);
  });
});

describe("the token command", () => {
  let inst: Instance;
  // Started in a hook, with the hooks' longer timeout: on a busy host, starting wrangler dev alone can take 30 s.
  beforeAll(async () => {
    inst = await startInstance(settings(inject("teamUrl")));
  });
  afterAll(() => inst?.stop());

  // Each token command starts Wrangler against the local D1, which takes seconds per call on a busy host.
  test("creates a working token, lists it without the secret, and revokes it", async () => {
    const cfg = file("instance.json", { name: "local", authorEmail: AUTHOR, allowlist: [] });
    const tok = (...a: string[]) => run("node", ["scripts/token.mjs", ...a, "--config", cfg, "--local", "--persist-to", inst.state]);

    const { stdout } = await tok("create", "ci laptop");
    const token = stdout.trim();
    expect(token).toMatch(/^hg_[A-Za-z0-9]{40}$/);
    const use = () => fetch(`${inst.base}/api/shares`, { headers: { authorization: `Bearer ${token}` } });
    expect((await use()).status).toBe(200);

    const listed = (await tok("list")).stdout;
    expect(listed).toContain("ci laptop");
    expect(listed).not.toContain(token);
    const id = /^([0-9a-f]{12})/m.exec(listed)![1]!;
    await tok("revoke", id);
    expect((await use()).status).toBe(401);
  }, 120_000);

  test("list prints a stored name without its control or bidi characters, one line per token", async () => {
    const cfg = file("instance.json", { name: "local", authorEmail: AUTHOR, allowlist: [] });
    // A name stored with an OSC 52 clipboard write, a newline and a bidi override, as an older form allowed.
    const name = "'pub' || char(27) || ']52;c;UFdORUQ=' || char(7) || char(10) || 'forged' || char(8238) || 'x'";
    await run(join(process.cwd(), "node_modules/.bin/wrangler"), ["d1", "execute", "htmlgate-dev", "--local", "--persist-to", inst.state, "--command",
      `INSERT INTO tokens (id, author, name, digest, created_at) VALUES ('0123456789ab', '${AUTHOR}', ${name}, 'x', 1)`], { env: { ...process.env, CI: "1" } });
    const listed = (await run("node", ["scripts/token.mjs", "list", "--config", cfg, "--local", "--persist-to", inst.state])).stdout;
    const line = listed.split("\n").find((l) => l.startsWith("0123456789ab"))!;
    expect(line).toContain("pub");
    expect(line).toContain("forged");
    expect(listed).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
  }, 120_000);

  test("a token issued to a different Author is refused, as if the Author changed", async () => {
    const cfg = file("other.json", { name: "local", authorEmail: "someone-else@example.com", allowlist: [] });
    const { stdout } = await run("node", ["scripts/token.mjs", "create", "foreign", "--config", cfg, "--local", "--persist-to", inst.state]);
    const r = await fetch(`${inst.base}/api/shares`, { headers: { authorization: `Bearer ${stdout.trim()}` } });
    expect(r.status).toBe(401);
  });

  test("refuses a name that could break out of the SQL", async () => {
    const cfg = file("instance2.json", { name: "local", authorEmail: AUTHOR, allowlist: [] });
    await expect(run("node", ["scripts/token.mjs", "create", "x'); DROP TABLE tokens; --", "--config", cfg, "--local", "--persist-to", dir])).rejects.toThrow(/name/);
  });
});

describe("each Instance's generated config", () => {
  test.each(["htmlgate-site", "htmlgate-site-preview"])("an Instance may not be named %s, the landing's own Worker", (name) => {
    const cfg = file(`reserved-${name}.json`, { name, authorEmail: AUTHOR, allowlist: [] });
    expect(() => readInstance(cfg)).toThrow(/landing/);
  });

  // Staging and production run setup from one checkout: one shared generated file would let the
  // token command act on whichever Instance was set up last.
  test("is a file of its own, named after the Instance", () => {
    const a = generatedConfig({ name: "htmlgate-staging" });
    const b = generatedConfig({ name: "htmlgate" });
    expect(a).toBe(join(process.cwd(), ".instance", "htmlgate-staging.wrangler.jsonc"));
    expect(b).toBe(join(process.cwd(), ".instance", "htmlgate.wrangler.jsonc"));
  });

  test("the token command refuses an Instance never set up, even when another one was", async () => {
    const other = generatedConfig({ name: "htmlgate-test-other" });
    mkdirSync(join(process.cwd(), ".instance"), { recursive: true });
    writeFileSync(other, "{}\n");
    try {
      const cfg = file("never-set-up.json", { name: "htmlgate-test-never", authorEmail: AUTHOR, allowlist: [] });
      const err = await run("node", ["scripts/token.mjs", "list", "--config", cfg]).then(() => null, (e: { stderr: string }) => e.stderr);
      expect(err).toContain("htmlgate-test-never.wrangler.jsonc");
      expect(err).toContain(`pnpm run setup --config ${cfg}`);
    } finally {
      rmSync(other, { force: true });
    }
  });
});
