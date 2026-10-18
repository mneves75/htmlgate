// Independent checks for "a domain Instance answers only at its domain; Instances keep no per-request logs".
// Written from the request, not from the implementation. Pure functions and static files only: no Worker starts.
// REVIEWER_SETUP lets a run point at a deliberately broken copy of scripts/setup.mjs (control runs).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

interface Config {
  workers_dev: boolean;
  routes?: { pattern: string; custom_domain: boolean }[];
  preview_urls: boolean;
  observability: {
    enabled: boolean;
    head_sampling_rate?: number;
    logs: { enabled: boolean; invocation_logs: boolean; head_sampling_rate?: number };
    traces?: { enabled: boolean };
  };
}
interface Setup {
  workerConfig: (inst: object, db: object, opts: { open: boolean; vars: Record<string, string> }) => Config;
  deploymentUrls: (inst: object, output: string) => string[];
}
const setupPath = process.env.REVIEWER_SETUP ? resolve(process.env.REVIEWER_SETUP) : resolve("scripts/setup.mjs");
const { workerConfig, deploymentUrls } = (await import(/* @vite-ignore */ setupPath)) as Setup;

const base = { name: "my-bin", author: "a@b.c", allowlist: ["a@b.c"], language: "en", expiryDays: 30 };
const withDomain = { ...base, domain: "html.example.com" };
const noDomain = { ...base, domain: undefined };
const db = { name: "my-bin-db", uuid: "u1" };

describe("hostnames", () => {
  for (const [label, inst] of [["with a domain", withDomain], ["without a domain", noDomain]] as const) {
    for (const open of [false, true]) {
      test(`${label}, open=${open}`, () => {
        const c = workerConfig(inst, db, { open, vars: {} });
        // workers.dev is on only for the gated deploy of an Instance that has no domain.
        expect(c.workers_dev).toBe(open && !inst.domain);
        // The domain route exists only on the gated deploy and only with a domain.
        if (open && inst.domain) expect(c.routes).toEqual([{ pattern: "html.example.com", custom_domain: true }]);
        else expect("routes" in c).toBe(false);
        // Version/Preview URLs stay off everywhere: they are a second public hostname.
        expect(c.preview_urls).toBe(false);
      });
    }
  }

  test("an Instance never answers on two hostnames", () => {
    for (const inst of [withDomain, noDomain]) {
      const c = workerConfig(inst, db, { open: true, vars: {} });
      const hostnames = (c.workers_dev ? 1 : 0) + (c.routes?.length ?? 0);
      expect(hostnames).toBe(1);
    }
  });
});

describe("logging", () => {
  for (const inst of [withDomain, noDomain]) {
    for (const open of [false, true]) {
      test(`observability, domain=${!!inst.domain}, open=${open}`, () => {
        const o = workerConfig(inst, db, { open, vars: {} }).observability;
        expect(o.enabled).toBe(true); // the Worker's own error logs stay
        expect(o.logs.enabled).toBe(true);
        expect(o.logs.invocation_logs).toBe(false); // no record of every request
        expect(o.traces?.enabled).toBe(false); // traces record every request too
        expect(o.head_sampling_rate).toBeUndefined();
        expect(o.logs.head_sampling_rate).toBeUndefined();
      });
    }
  }

  test("Wrangler 4's own reader accepts the generated config and keeps the logging settings", async () => {
    const { unstable_readConfig } = await import("wrangler");
    const dir = mkdtempSync(join(tmpdir(), "htmlgate-rev-cfg-"));
    try {
      for (const inst of [withDomain, noDomain]) {
        const cfg = { ...workerConfig(inst, db, { open: true, vars: {} }), main: resolve("src/index.ts") };
        const file = join(dir, `${inst.domain ? "d" : "n"}.json`);
        writeFileSync(file, JSON.stringify(cfg));
        const read = unstable_readConfig({ config: file });
        expect(read.workers_dev).toBe(!inst.domain);
        expect(read.observability?.logs?.invocation_logs).toBe(false);
        expect(read.observability?.traces?.enabled).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the hostname setup checks", () => {
  const domainOut = "Total Upload: 10 KiB\nUploaded my-bin (3 sec)\nDeployed my-bin triggers (1 sec)\n  html.example.com (custom domain)\n  schedule: 17 * * * *\nCurrent Version ID: abc";
  const devOut = "Uploaded my-bin (3 sec)\nDeployed my-bin triggers (1 sec)\n  https://my-bin.acct.workers.dev\n  schedule: 17 * * * *";

  test("with a domain, a Wrangler output that holds no workers.dev URL is enough", () => {
    expect(deploymentUrls(withDomain, domainOut)).toEqual(["https://html.example.com"]);
  });
  test("with a domain, a mere mention of workers.dev (no URL) does not fail setup", () => {
    expect(deploymentUrls(withDomain, domainOut + "\nworkers.dev route disabled")).toEqual(["https://html.example.com"]);
  });
  test("with a domain, a printed workers.dev URL is refused and named", () => {
    expect(() => deploymentUrls(withDomain, devOut)).toThrow(/my-bin\.acct\.workers\.dev/);
  });
  test("without a domain, exactly the workers.dev URL", () => {
    expect(deploymentUrls(noDomain, devOut)).toEqual(["https://my-bin.acct.workers.dev"]);
  });
  test("without a domain and no URL printed, it refuses", () => {
    expect(() => deploymentUrls(noDomain, domainOut)).toThrow();
  });

  test("main() takes its hostnames from deploymentUrls and from nowhere else", () => {
    const src = readFileSync("scripts/setup.mjs", "utf8");
    const main = src.split("async function main()")[1]!;
    expect(main).toContain("deploymentUrls(inst, sh(WRANGLER");
    expect(main).not.toMatch(/\.workers\\\.dev/); // no second parse of Wrangler's output
    expect(main).toMatch(/for \(const u of urls\) results\.push\(await gated\(/);
  });
});

describe("mutations that ship with the change", () => {
  const lines = readFileSync("scripts/mutate.mjs", "utf8").split("\n").filter((l) => /^\s*\["(an Instance with a Custom Domain stays on workers\.dev|setup accepts a deploy that left workers\.dev on beside the domain|an Instance records every request|an Instance records traces)"/.test(l));
  const muts = lines.map((l) => new Function(`return ${l.trim().replace(/,$/, "")}`)() as string[]);

  test("there are four, each anchored exactly once", () => {
    expect(muts).toHaveLength(4);
    const src = readFileSync("scripts/setup.mjs", "utf8");
    for (const [name, file, from, to] of muts) {
      expect(file).toBe("scripts/setup.mjs");
      expect(src.split(from!).length - 1, name).toBe(1);
      expect(to).not.toBe(from);
    }
  });

  test("each planted source still compiles (otherwise the gate reports BROKEN)", () => {
    const src = readFileSync("scripts/setup.mjs", "utf8");
    const dir = mkdtempSync(join(tmpdir(), "htmlgate-rev-mut-"));
    try {
      muts.forEach(([, , from, to], i) => {
        const f = join(dir, `m${i}.mjs`);
        writeFileSync(f, src.replace(from!, () => to!));
        execFileSync(process.execPath, ["--check", f]);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("documents agree with the code", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  test("no document still says a domain Instance answers on workers.dev too", () => {
    for (const p of ["AGENTS.md", "README.md", "docs/operator.md", "docs/privacy.md"]) {
      const t = read(p);
      expect(t, p).not.toMatch(/and at its workers\.dev hostname/);
      expect(t, p).not.toMatch(/workers\.dev hostname stays reachable/);
      expect(t, p).not.toMatch(/deploys again with workers\.dev on, your `domain`/);
    }
    expect(read("docs/operator.md")).toMatch(/only there: its workers\.dev hostname is off/);
  });

  test("the landing keeps its own request logs and its own workers.dev preview", () => {
    expect(read("site/wrangler.jsonc")).toMatch(/"observability": \{ "enabled": true \}/);
    expect(read("site/wrangler.jsonc")).toMatch(/"workers_dev": true/);
    for (const p of ["site/public/en/privacy/index.html", "site/public/privacidade/index.html"]) {
      const site = read(p).split('id="site"')[1]!.split("</section>")[0]!;
      expect(site, p).toMatch(/3 (days|dias)/);
    }
  });

  test("both privacy notices were re-dated together", () => {
    const months = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
    const en = read("site/public/en/privacy/index.html").match(/Updated (\w+) (\d+), (\d{4})\./);
    const pt = read("site/public/privacidade/index.html").match(/Atualizada em (\d+) de (\S+) de (\d{4})\./);
    expect(en && pt).toBeTruthy();
    const enMonth = new Date(`${en![1]} 1, 2000`).getMonth();
    expect([pt![1], pt![2], pt![3]]).toEqual([en![2], months[enMonth], en![3]]);
  });

  test("the CHANGELOG records both changes", () => {
    const log = read("CHANGELOG.md");
    expect(log).toMatch(/An Instance with a Custom Domain answers only there/);
    expect(log).toMatch(/Instances keep no per-request logs by default/);
  });
});
