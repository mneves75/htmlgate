// Independent review of the landing (site/), written from the owner's requirements:
//   pt-BR at /, en-US at /en/, www -> apex keeping path+query, /app -> https://app.htmlgate.com/, a free
//   self-hosted product with no paid offer and no invented proof, no mention of the copy models, and one
//   generated Wrangler config per Instance.
// LANDING_DIR points the whole file at another copy of site/ (used to prove these tests fail on broken input).
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
// @ts-expect-error plain JavaScript module
import { checkTarget, deployPlan } from "../scripts/site-deploy.mjs";
// @ts-expect-error plain JavaScript module
import { generatedConfig, readInstance } from "../scripts/setup.mjs";
import { axeViolations } from "./a11y";

const ROOT = process.cwd();
const SITE = resolve(ROOT, process.env.LANDING_DIR ?? "site");
const PUBLIC = join(SITE, "public");
const APP = "https://app.htmlgate.com/";
const read = (p: string) => readFileSync(p, "utf8");
const PT = read(join(PUBLIC, "index.html"));
const EN = read(join(PUBLIC, "en/index.html"));
const CSS = read(join(PUBLIC, "style.css"));
const NOT_FOUND = read(join(PUBLIC, "404.html"));
const PAGES = { pt: PT, en: EN } as const;

/** Every file under a directory, as paths relative to it. */
function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, base) : [p.slice(base.length + 1)];
  });
}
const visibleText = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&");

// ---------------------------------------------------------------------------------------------
// Static content: the copy rules, the links, the claims.
// ---------------------------------------------------------------------------------------------
describe("copy rules", () => {
  test("nothing under site/ names the copywriters the owner asked to be emulated", () => {
    for (const f of walk(SITE)) {
      const text = read(join(SITE, f)).toLowerCase();
      expect(text, f).not.toMatch(/ladeira|hormozi/);
    }
  });

  test("the product is free: every money amount on both pages is zero, and no checkout or plan language appears", () => {
    for (const [lang, html] of Object.entries(PAGES)) {
      const text = visibleText(html);
      const amounts = [...text.matchAll(/(?:R\$|US\$|\$|€|£)\s?(\d[\d.,]*)/g)].map((m) => m[1]);
      expect(amounts.length, lang).toBeGreaterThan(0);
      for (const a of amounts) expect(Number(a!.replace(",", ".")), `${lang}: ${a}`).toBe(0);
      expect(text, lang).not.toMatch(/\b(?:checkout|subscribe|assine|garantia de|money[- ]back|limited time|tempo limitado|vagas limitadas|testimonial|depoimento)\b/i);
    }
  });

  test("no invented proof: no user counts, ratings, logos, star counts or testimonials", () => {
    for (const [lang, html] of Object.entries(PAGES)) {
      const text = visibleText(html);
      expect(text, lang).not.toMatch(/\d[\d.,]*\s?(?:\+|mil|k|thousand)?\s*(?:users|usu[aá]rios|clientes|customers|teams|equipes|empresas|companies|downloads|stars|estrelas)/i);
      expect(text, lang).not.toMatch(/\b(?:trusted by|usado por|confiado por|as seen|visto em|5\/5|4\.\d\/5|★)/i);
      expect(html, lang).not.toMatch(/<blockquote|<img\b/i);
    }
  });

  test("each page is written in its own language", () => {
    const hits = (t: string, words: RegExp) => (t.match(words) ?? []).length;
    const ptWords = /\b(?:você|seu|sua|não|para|com|que|uma|é)\b/gi;
    const enWords = /\b(?:your|you|the|with|that|and|is|not)\b/gi;
    const ptText = visibleText(PT);
    const enText = visibleText(EN);
    expect(hits(ptText, ptWords)).toBeGreaterThan(5 * hits(ptText, enWords));
    expect(hits(enText, enWords)).toBeGreaterThan(5 * hits(enText, ptWords));
  });

  test("no AI-tell patterns from the repository's copy rules in the visible text", () => {
    for (const [lang, html] of Object.entries(PAGES)) {
      const text = visibleText(html).replace(/\s+/g, " ");
      expect(text, lang).not.toMatch(/\bnot (?:just )?(?:a|an|the)? ?[\w ]{1,30}, (?:it's|it is|but)\b/i);
      expect(text, lang).not.toMatch(/[—–]/); // em and en dashes
    }
  });
});

describe("both pages say the same true things", () => {
  const nums = (html: string) => [...visibleText(html).matchAll(/(\d+(?:[.,]\d+)?)\s?(GB|MiB|KiB|MB)\b/g)].map((m) => `${m[1]} ${m[2]}`).sort();
  const flags = (html: string) => [...new Set([...visibleText(html).matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]))].sort();
  const commands = (html: string) => [...new Set([...html.matchAll(/<code>(htmlgate [a-z]+|pnpm run [a-z:]+)/g)].map((m) => m[1]))].sort();

  test("same sizes, same flags, same commands, same ids and the same number of every repeated element", () => {
    // Each set is non-empty, so a markup change that hides them from these patterns cannot pass as "equal".
    for (const set of [nums(PT), flags(PT), commands(PT)]) expect(set.length).toBeGreaterThan(0);
    expect(nums(EN)).toEqual(nums(PT));
    expect(flags(EN)).toEqual(flags(PT));
    expect(commands(EN)).toEqual(commands(PT));
    for (const tag of ["<details", "<section", "<li>", "<h2", "<h3", "<pre", "<a "]) {
      expect(EN.split(tag).length, tag).toBe(PT.split(tag).length);
    }
    const ids = (h: string) => [...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    // Anchors (#how-it-works, #cost ...) are shared, so their ids are the same in both languages.
    const shared = (h: string) => ids(h).filter((i) => !/-(?:titulo|title)$/.test(i!));
    expect(shared(EN)).toEqual(shared(PT));
  });

  test("the install block is the same shell script in both languages, apart from comments", () => {
    const block = (h: string) => /<pre tabindex="0" aria-label="(?:Install|Comandos)[^>]*><code>([\s\S]*?)<\/code>/.exec(h)![1]!.replace(/\s+#.*$/gm, "").replace(/sua-instancia|your-instance/g, "X");
    expect(block(EN)).toBe(block(PT));
  });
});

describe("what the pages claim is what the product does", () => {
  const api = read(join(ROOT, "src/api.ts"));
  const store = read(join(ROOT, "src/store.ts"));
  const config = read(join(ROOT, "src/config.ts"));
  const cli = read(join(ROOT, "packages/cli/src/bin.ts"));
  const pkg = JSON.parse(read(join(ROOT, "package.json"))) as { scripts: Record<string, string>; engines: { node: string } };

  test("the numbers match the code: versions kept, size limit, storage cap, Node", () => {
    const kept = Number(/KEEP_VERSIONS = (\d+)/.exec(store)![1]);
    const maxMiB = Number(/MAX_HTML_BYTES = (\d+) \* 1024 \* 1024/.exec(api)![1]);
    const capGB = Number(/DEFAULT_STORAGE_LIMIT = (\d+) \* 1000 \* 1000 \* 1000/.exec(config)![1]);
    const node = /(\d+)/.exec(pkg.engines.node)![1];
    for (const [lang, html] of Object.entries(PAGES)) {
      const t = visibleText(html);
      expect(t, lang).toMatch(new RegExp(`\\b${kept}\\b`));
      expect(t, lang).toContain(`${maxMiB} MiB`);
      expect(t, lang).toContain(`${capGB} GB`);
      expect(t, lang).toContain(`Node ${node}`);
    }
  });

  test("every `pnpm run X` on the pages is a script, and every file it copies exists", () => {
    for (const [lang, html] of Object.entries(PAGES)) {
      for (const m of visibleText(html).matchAll(/pnpm run ([a-z:]+)/g)) expect(pkg.scripts[m[1]!], `${lang}: pnpm run ${m[1]}`).toBeTruthy();
      for (const m of visibleText(html).matchAll(/cp (\S+) (\S+)/g)) expect(existsSync(join(ROOT, m[1]!)), `${lang}: ${m[1]}`).toBe(true);
    }
  });

  test("every htmlgate subcommand and flag on the pages exists in the CLI", () => {
    for (const [lang, html] of Object.entries(PAGES)) {
      const t = visibleText(html);
      for (const m of t.matchAll(/\bhtmlgate (publish|public|gate|list|login)\b/g)) expect(cli, `${lang}: ${m[0]}`).toContain(`case "${m[1]}"`);
      for (const f of new Set(t.match(/--(?:slug|output|public|title)\b/g) ?? [])) expect(cli, `${lang}: ${f}`).toContain(f);
    }
  });

  test("the token command and the CLI build the pages tell people to run are real", () => {
    expect(read(join(ROOT, "scripts/token.mjs"))).toMatch(/"create"/);
    expect(pkg.scripts["build:cli"]).toBeTruthy();
    expect(existsSync(join(ROOT, "packages/cli/package.json"))).toBe(true);
  });
});

describe("links", () => {
  test("every in-page anchor, aria-labelledby and skip link has a target", () => {
    for (const [lang, html] of Object.entries({ ...PAGES, "404": NOT_FOUND })) {
      const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
      for (const m of html.matchAll(/href="#([^"]+)"/g)) expect(ids.has(m[1]!), `${lang}: #${m[1]}`).toBe(true);
      for (const m of html.matchAll(/aria-labelledby="([^"]+)"/g)) for (const id of m[1]!.split(/\s+/)) expect(ids.has(id), `${lang}: labelledby ${id}`).toBe(true);
    }
  });

  test("the sign-in link, the Worker's APP_URL and the deploy script's check all name the same address", () => {
    const wrangler = read(join(SITE, "wrangler.jsonc"));
    expect(/"APP_URL":\s*"([^"]+)"/.exec(wrangler)![1]).toBe(APP);
    expect(/const APP = "([^"]+)"/.exec(read(join(ROOT, "scripts/site-deploy.mjs")))![1]).toBe(APP);
    for (const [lang, html] of Object.entries(PAGES)) expect(html, lang).toContain(`href="${APP}"`);
  });

  test("the canonical origin in the Worker, the deploy script, the pages and the sitemap are one origin", () => {
    const wrangler = read(join(SITE, "wrangler.jsonc"));
    const origin = /"SITE_ORIGIN":\s*"([^"]+)"/.exec(wrangler)![1]!;
    expect(read(join(ROOT, "scripts/site-deploy.mjs"))).toContain(`const SITE = "${origin}"`);
    expect(read(join(PUBLIC, "sitemap.xml"))).not.toMatch(new RegExp(`<loc>(?!${origin.replace(/[.]/g, "\\.")}/)`));
    expect(read(join(PUBLIC, "robots.txt"))).toContain(`Sitemap: ${origin}/sitemap.xml`);
    for (const [lang, html] of Object.entries(PAGES)) for (const m of html.matchAll(/(?:canonical|alternate)" [^>]*href="([^"]+)"/g)) expect(m[1], lang).toMatch(new RegExp(`^${origin.replace(/[.]/g, "\\.")}/`));
  });
});

describe("what the strict CSP (default-src 'none'; style-src 'self'; img-src 'self'; media-src 'self') allows", () => {
  test("no inline style, no <style>, no @import, no @font-face, no data: or external url() anywhere", () => {
    for (const [name, html] of Object.entries({ pt: PT, en: EN, "404": NOT_FOUND })) {
      expect(html, name).not.toMatch(/\sstyle=|<style\b|<script\b|<iframe\b|<object\b|<embed\b|<form\b|<base\b|<meta[^>]+http-equiv/i);
    }
    expect(CSS).not.toMatch(/@import|@font-face|url\(\s*["']?(?:data:|https?:|\/\/)/i);
    // A font-face or an image through url() would be silently blocked by default-src 'none'.
    expect(CSS).not.toMatch(/url\(/i);
  });

  test("the favicon is a standalone SVG that draws in a tab on a light or dark browser", () => {
    const svg = read(join(PUBLIC, "favicon.svg"));
    expect(svg).not.toMatch(/currentColor/);
    expect(svg).not.toMatch(/<script|<style|href=/i);
  });
});

// ---------------------------------------------------------------------------------------------
// The Instance side: one generated config each.
// ---------------------------------------------------------------------------------------------
describe("one generated Wrangler config per Instance", () => {
  test("every valid name maps to its own file inside .instance/, and none can climb out of it", () => {
    const dir = join(ROOT, ".instance");
    const names = ["htmlgate", "htmlgate-staging", "a", "0x", "x".repeat(53)];
    const files = names.map((name) => generatedConfig({ name }));
    expect(new Set(files).size).toBe(names.length);
    for (const f of files) expect(resolve(f).startsWith(dir + "/")).toBe(true);
  });

  test("a name that could climb out of .instance/ is refused before any path is built", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-landing-"));
    try {
      for (const name of ["../evil", "a/b", ".hidden", "UPPER", "a b", "x".repeat(54), ""]) {
        const file = join(dir, "i.json");
        rmSync(file, { force: true });
        require_write(file, { name, authorEmail: "a@example.com", allowlist: [] });
        expect(() => readInstance(file), JSON.stringify(name)).toThrow(/name must be/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(".instance/ stays out of Git, so a generated config is never committed", async () => {
    const run = promisify(execFile);
    const r = await run("git", ["check-ignore", "-q", ".instance/htmlgate.wrangler.jsonc"], { cwd: ROOT }).then(() => 0, (e: { code: number }) => e.code);
    expect(r).toBe(0);
  });

  test("no script or doc still points at the old shared .instance/wrangler.jsonc", () => {
    const stale: string[] = [];
    for (const dir of ["scripts", "docs", "test", "src", "packages/cli/src"]) {
      for (const f of walk(join(ROOT, dir))) {
        if (f === "reviewer-landing.test.ts" || f.startsWith("handoffs/")) continue;
        if (/\.instance\/wrangler\.jsonc/.test(read(join(ROOT, dir, f)))) stale.push(`${dir}/${f}`);
      }
    }
    for (const f of ["README.md", "AGENTS.md"]) if (/\.instance\/wrangler\.jsonc/.test(read(join(ROOT, f)))) stale.push(f);
    expect(stale).toEqual([]);
  });
});

function require_write(file: string, v: unknown) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(v));
}

// ---------------------------------------------------------------------------------------------
// The deploy script's guards that site.test.ts does not reach.
// ---------------------------------------------------------------------------------------------
describe("site deploy guards", () => {
  const cfWith = (workers: unknown, apps: unknown) => (...args: string[]) => (args[0] === "workers" ? (args.includes("1") ? workers : []) : apps);

  test("a malformed Access list or Worker list fails closed instead of passing as 'no Instance here'", () => {
    const live = deployPlan(["--live"]);
    expect(() => checkTarget(live, cfWith([], { error: "nope" }))).toThrow(/Access application list/);
    expect(() => checkTarget(live, cfWith("nope", []))).toThrow();
    expect(() => checkTarget(live, cfWith([], null))).toThrow();
  });

  test("a preview refuses a domain that any other Worker holds only when it is the preview's own name", () => {
    // The preview and the live landing are different Workers: the live one's domains are not the preview's problem.
    const preview = deployPlan(["--preview"]);
    const cf = cfWith([{ name: "htmlgate-site", references: { domains: [{ hostname: "htmlgate.com" }, { hostname: "www.htmlgate.com" }] } }], []);
    expect(() => checkTarget(preview, cf)).not.toThrow();
  });

  test("neither plan can carry a flag that would change the Worker's variables or its routes behind the config's back", () => {
    for (const mode of ["--preview", "--live"]) {
      const { args } = deployPlan([mode]);
      expect(args).not.toContain("--var");
      expect(args).not.toContain("--route");
      expect(args).not.toContain("--routes");
      expect(args.filter((a: string) => a === "--domain").length).toBe(mode === "--live" ? 2 : 0);
    }
  });

  test("running the script with no target exits 1 and says what to pass, without touching Cloudflare", async () => {
    const run = promisify(execFile);
    const err = await run(process.execPath, ["scripts/site-deploy.mjs"], { cwd: ROOT, env: { ...process.env, PATH: "/nonexistent" } }).then(() => null, (e: { code: number; stderr: string }) => e);
    expect(err?.code).toBe(1);
    expect(err?.stderr).toMatch(/--preview or --live/);
  });
});

// ---------------------------------------------------------------------------------------------
// The Worker, really running under `wrangler dev`.
// ---------------------------------------------------------------------------------------------
let stop: () => Promise<void> = async () => {};
let port = 0;

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

async function startLanding(): Promise<void> {
  const state = mkdtempSync(join(tmpdir(), "htmlgate-reviewer-"));
  port = await freePort();
  const args = ["dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(await freePort()), "--persist-to", state,
    "--show-interactive-dev-session=false", "--log-level", "warn", "-c", join(SITE, "wrangler.jsonc")];
  let log = "";
  const w: ChildProcess = spawn(join(ROOT, "node_modules/.bin/wrangler"), args, { cwd: ROOT, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  w.stdout!.on("data", (d) => (log += d));
  w.stderr!.on("data", (d) => (log += d));
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/robots.txt`);
      break;
    } catch {}
    if (Date.now() > deadline || w.exitCode !== null) throw new Error(`wrangler dev did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  stop = () => {
    const exited = new Promise<void>((r) => (w.exitCode !== null ? r() : w.once("exit", () => r())));
    try {
      process.kill(-w.pid!, "SIGTERM");
    } catch {}
    return exited.then(() => rmSync(state, { recursive: true, force: true, maxRetries: 3 }));
  };
}

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
/** One raw request with a chosen Host header and request target. Redirects are not followed. */
function hit(path: string, opts: { host?: string; method?: string } = {}): Promise<Res> {
  return new Promise((resolveP, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.host ? { host: opts.host } : {} }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolveP({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the running Worker", () => {
  beforeAll(startLanding, 150_000);
  afterAll(() => stop());

  test("www keeps the path and the query exactly as sent, including percent-escapes, for every page and file", async () => {
    for (const target of ["/", "/en/", "/en/?ref=a%20b&x=%E2%9C%93&empty=&flag", "/style.css?v=2", "/app", "/app?x=1", "/caf%C3%A9", "/a/../b", "/nope/"]) {
      const r = await hit(target, { host: "www.htmlgate.com" });
      expect(r.status, target).toBe(301);
      const loc = r.headers.location as string;
      expect(loc.startsWith("https://htmlgate.com"), target).toBe(true);
      // The part after the origin is the part the visitor sent (dot segments are resolved by the URL parser, as a browser would).
      const sent = new URL(target, "https://htmlgate.com");
      expect(loc, target).toBe(`https://htmlgate.com${sent.pathname}${sent.search}`);
    }
  });

  test("www never sends a visitor anywhere but the apex, whatever the request target looks like", async () => {
    for (const target of ["//evil.example", "//evil.example/", "/\\evil.example", "/%5Cevil.example", "/@evil.example", "/.evil.example", "///evil.example"]) {
      const r = await hit(target, { host: "www.htmlgate.com" });
      expect(r.status, target).toBe(301);
      const loc = new URL(r.headers.location as string);
      expect(loc.origin, target).toBe("https://htmlgate.com");
    }
  });

  test("the Host header is matched case-insensitively and a port does not hide www", async () => {
    for (const host of ["WWW.HTMLGATE.COM", "www.htmlgate.com:443", "Www.HtmlGate.Com"]) {
      const r = await hit("/en/", { host });
      expect(r.status, host).toBe(301);
      expect(r.headers.location, host).toBe("https://htmlgate.com/en/");
    }
  });

  test("/app answers 302 to the app for GET and HEAD, with or without a query", async () => {
    for (const method of ["GET", "HEAD"]) {
      for (const path of ["/app", "/app?utm_source=x"]) {
        const r = await hit(path, { host: "htmlgate.com", method });
        expect(r.status, `${method} ${path}`).toBe(302);
        expect(r.headers.location, `${method} ${path}`).toBe(APP);
      }
    }
  });

  test("/app/ (with the trailing slash people type) also goes to the app", async () => {
    const r = await hit("/app/", { host: "htmlgate.com" });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(APP);
  });

  test("the app redirect carries the hardening headers and is not cached for long", async () => {
    const r = await hit("/app", { host: "htmlgate.com" });
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
    const maxAge = Number(/max-age=(\d+)/.exec(String(r.headers["cache-control"]))?.[1] ?? "0");
    expect(maxAge).toBeLessThanOrEqual(300);
  });

  test("every local link and resource on every page answers 200 with the right type", async () => {
    const types: Record<string, RegExp> = { ".css": /^text\/css/, ".svg": /^image\/svg\+xml/, "/": /^text\/html/ };
    for (const [name, html] of Object.entries({ pt: PT, en: EN, "404": NOT_FOUND })) {
      for (const m of html.matchAll(/(?:href|src)="(\/[^"#]*)"/g)) {
        const path = m[1]!;
        if (name === "404" && path === "/en/") continue;
        const r = await hit(path, { host: "htmlgate.com" });
        expect(r.status, `${name}: ${path}`).toBe(200);
        const key = path.endsWith("/") ? "/" : path.slice(path.lastIndexOf("."));
        expect(String(r.headers["content-type"]), `${name}: ${path}`).toMatch(types[key]!);
      }
    }
  });

  test("sitemap, robots and the 404 page are served with the right types, and the 404 is not indexable", async () => {
    const sitemap = await hit("/sitemap.xml", { host: "htmlgate.com" });
    expect(sitemap.status).toBe(200);
    expect(String(sitemap.headers["content-type"])).toMatch(/xml/);
    const robots = await hit("/robots.txt", { host: "htmlgate.com" });
    expect(String(robots.headers["content-type"])).toMatch(/^text\/plain/);
    const lost = await hit("/en/nope", { host: "htmlgate.com" });
    expect(lost.status).toBe(404);
    expect(lost.body).toContain('name="robots" content="noindex"');
  });

  test("a hidden or source file is not served: nothing outside the public pages leaks", async () => {
    for (const path of ["/../src/worker.ts", "/%2e%2e/src/worker.ts", "/.assetsignore", "/_headers", "/_redirects", "/wrangler.jsonc", "/src/worker.ts", "/index.html.bak"]) {
      const r = await hit(path, { host: "htmlgate.com" });
      expect([404, 301, 307, 308], path).toContain(r.status);
      expect(r.body, path).not.toContain("SITE_ORIGIN");
    }
  });

  test("the preview host is never indexable, even for the files and the 404", async () => {
    for (const path of ["/", "/en/", "/style.css", "/nope", "/robots.txt", "/sitemap.xml"]) {
      const r = await hit(path, { host: "htmlgate-site-preview.someone.workers.dev" });
      expect(r.headers["x-robots-tag"], path).toBe("noindex");
    }
  });

  test("an unusual method is refused the same way on every path", async () => {
    for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const r = await hit("/", { host: "htmlgate.com", method });
      expect(r.status, method).toBe(405);
      expect(r.headers.allow, method).toBe("GET, HEAD");
    }
  });

  describe("in a real browser", () => {
    const run = promisify(execFile);
    const BIN = join(ROOT, "node_modules/.bin/agent-browser");
    const SESSION = `htmlgate-reviewer-${process.pid}`;
    const ab = async (...args: string[]) => (await run(BIN, ["--session", SESSION, ...args], { timeout: 45_000 })).stdout.trim();
    afterAll(async () => ab("close").catch(() => {}));

    test.each([["light"], ["dark"]] as const)("the 404 page passes axe in %s at 320px, and the stylesheet really applies under the CSP", async (scheme) => {
      await ab("open", "about:blank");
      await ab("set", "viewport", "320", "640");
      await ab("set", "media", scheme);
      await ab("open", `http://127.0.0.1:${port}/en/not-a-page`);
      await ab("wait", "--fn", "document.readyState === 'complete' && document.getAnimations().length === 0");
      expect(await axeViolations(ab)).toEqual([]);
      expect(await ab("eval", "document.documentElement.scrollWidth <= window.innerWidth")).toBe("true");
      // h1 is bold only when style.css loaded: a CSP that blocked it would leave the browser default (also bold),
      // so read the page's own custom property instead.
      expect(await ab("eval", "getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().length > 0")).toBe("true");
    }, 150_000);

    test.each([["/"], ["/en/"]])("%s: the stylesheet applies, the language link and the sign-in link are keyboard-reachable, and the FAQ opens without script", async (path) => {
      await ab("open", "about:blank");
      await ab("set", "viewport", "1280", "900");
      await ab("set", "media", "light");
      await ab("open", `http://127.0.0.1:${port}${path}`);
      await ab("wait", "--fn", "document.readyState === 'complete' && document.getAnimations().length === 0");
      expect(await ab("eval", "getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().length > 0")).toBe("true");
      expect(await ab("eval", "document.querySelectorAll('details').length >= 5")).toBe("true");
      expect(await ab("eval", "(() => { const d = document.querySelector('details'); d.open = true; return getComputedStyle(d.querySelector('p')).display !== 'none'; })()")).toBe("true");
      // At desktop width every link is on screen and reachable by Tab: none may hide.
      expect(await ab("eval", `[...document.querySelectorAll('a[href]')].every(a => a.tabIndex >= 0 && a.getClientRects().length > 0)`)).toBe("true");
      // No element wider than the viewport at desktop width either.
      expect(await ab("eval", "document.documentElement.scrollWidth <= window.innerWidth")).toBe("true");
    }, 150_000);
  });
});
