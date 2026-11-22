import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
// @ts-expect-error plain JavaScript module
import { workerConfig } from "../scripts/setup.mjs";

const base = { name: "my-bin", author: "a@b.c", allowlist: ["a@b.c"], language: "en", expiryDays: 30 };
const withDomain = { ...base, domain: "html.example.com" };
const noDomain = { ...base, domain: undefined };
const db = { name: "my-bin-db", uuid: "u1" };

describe("Wrangler schema and privacy notice parity", () => {
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

  test("the landing keeps its own request logs and its own workers.dev preview", () => {
    expect(readFileSync("site/wrangler.jsonc", "utf8")).toMatch(/"observability": \{ "enabled": true \}/);
    expect(readFileSync("site/wrangler.jsonc", "utf8")).toMatch(/"workers_dev": true/);
    for (const p of ["site/public/en/privacy/index.html", "site/public/privacidade/index.html"]) {
      const site = readFileSync(p, "utf8").split('id="site"')[1]!.split("</section>")[0]!;
      expect(site, p).toMatch(/3 (days|dias)/);
    }
  });

  test("main() takes its hostnames from deploymentUrls and probes every URL through gated()", () => {
    const src = readFileSync("scripts/setup.mjs", "utf8");
    const main = src.split("async function main()")[1]!;
    expect(main).toContain("deploymentUrls(inst, sh(WRANGLER");
    expect(main).not.toMatch(/\.workers\\\.dev/);
    expect(main).toMatch(/for \(const u of urls\) results\.push\(await gated\(/);
  });

  test("both privacy notices were re-dated together", () => {
    const months = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
    const en = readFileSync("site/public/en/privacy/index.html", "utf8").match(/Updated (\w+) (\d+), (\d{4})\./);
    const pt = readFileSync("site/public/privacidade/index.html", "utf8").match(/Atualizada em (\d+) de (\S+) de (\d{4})\./);
    expect(en && pt).toBeTruthy();
    const enMonth = new Date(`${en![1]} 1, 2000`).getMonth();
    expect([pt![1], pt![2], pt![3]]).toEqual([en![2], months[enMonth], en![3]]);
  });
});
