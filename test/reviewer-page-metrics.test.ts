// Independent review of the landing's page counts (plan 016), written from the owner's requirements: every page a
// browser navigates to on htmlgate.com is counted once, nothing else is, and nothing about the visitor is stored.
// Unlike test/site-metrics.test.ts, the static files come from the real asset server under `wrangler dev`: the Worker
// runs here in process with an ASSETS binding that proxies to it, so countView sees the real trailing-slash redirects,
// conditional 304s and the 404 page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import worker from "../site/src/worker.ts";
import { startSite } from "./global-setup";

const ORIGIN = "https://htmlgate.com";
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

let site: { base: string; stop: () => Promise<void> };

beforeAll(async () => {
  site = await startSite();
});
afterAll(() => site?.stop());

/** The real asset server answers for the Worker's ASSETS binding; redirects come back as they are, not followed. */
const ASSETS = {
  fetch: (req: Request) => {
    const u = new URL(req.url);
    const headers: Record<string, string> = {};
    const inm = req.headers.get("if-none-match");
    if (inm) headers["if-none-match"] = inm;
    return fetch(`${site.base}${u.pathname}${u.search}`, { method: req.method, headers, redirect: "manual" });
  },
} as unknown as Fetcher;

function env(points: AnalyticsEngineDataPoint[], binding: "ok" | "missing" = "ok") {
  const PAGE_VIEWS: AnalyticsEngineDataset = { writeDataPoint: (p) => void points.push(p!) };
  return { ASSETS, SITE_ORIGIN: ORIGIN, APP_URL: "https://app.htmlgate.com/", ...(binding === "ok" ? { PAGE_VIEWS } : {}) };
}

/** A browser's top-level navigation, with what Cloudflare adds in front of the Worker. */
function navigation(path: string, headers: Record<string, string> = {}) {
  const req = new Request(`${ORIGIN}${path}`, {
    headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "user-agent": "Mozilla/5.0 (reviewer)", "cf-connecting-ip": "203.0.113.9", ...headers },
  });
  Object.defineProperty(req, "cf", { value: { country: "PT", colo: "LIS", asn: 64496 } });
  return req;
}

async function run(req: Request, binding: "ok" | "missing" = "ok") {
  const points: AnalyticsEngineDataPoint[] = [];
  // A missing binding is a misconfigured deploy, which the Env type rules out; the cast lets the test build one.
  const res = await worker.fetch(req, env(points, binding) as Parameters<typeof worker.fetch>[1]);
  return { res, points, body: await res.text() };
}

describe("every landing page counts once per navigation", () => {
  test.each(["/", "/en/", "/privacidade/", "/en/privacy/"])("%s writes one point naming the page", async (path) => {
    const { res, points } = await run(navigation(path));
    expect(res.status).toBe(200);
    expect(points).toEqual([{ indexes: [path], blobs: [path, "200", "PT", ""] }]);
  });

  test("a missing page counts once, as 404, and the address asked for is not stored anywhere in the point", async () => {
    const asked = "/reset-password?token=s3cret";
    const { res, points } = await run(navigation(asked));
    expect(res.status).toBe(404);
    expect(points).toHaveLength(1);
    expect(JSON.stringify(points[0])).not.toMatch(/reset|s3cret|token/);
    expect(points[0]!.indexes).toEqual(["404"]);
  });

  test("a revisit after the 5-minute cache (a conditional request answered 304) is still a view", async () => {
    const first = await run(navigation("/"));
    const etag = first.res.headers.get("etag");
    expect(etag).toBeTruthy();
    const { res, points } = await run(navigation("/", { "if-none-match": etag! }));
    expect(res.status).toBe(304);
    expect(points).toEqual([{ indexes: ["/"], blobs: ["/", "304", "PT", ""] }]);
  });

  test("the trailing-slash redirects write nothing: the navigation they lead to is what counts", async () => {
    for (const path of ["/en", "/privacidade", "/en/privacy", "/index.html", "/en/index.html"]) {
      const { res, points } = await run(navigation(path));
      expect(res.status, path).toBe(307);
      expect(points, path).toEqual([]);
    }
  });
});

describe("nothing about the visitor is stored", () => {
  test("the point carries no IP, User-Agent, query string, colo or ASN, only the page, status, country and referring host", async () => {
    const { points } = await run(navigation("/en/?utm_source=mail&email=a@b.test", { referer: "https://news.example.com/item?id=42&u=alice" }));
    expect(points).toEqual([{ indexes: ["/en/"], blobs: ["/en/", "200", "PT", "news.example.com"] }]);
    const flat = JSON.stringify(points);
    for (const secret of ["203.0.113.9", "Mozilla", "utm_source", "a@b.test", "LIS", "64496", "item?id", "alice"]) expect(flat).not.toContain(secret);
  });
});

describe("what is not a browser opening a page writes nothing", () => {
  test.each([
    ["a fetch without Fetch Metadata (curl, most crawlers)", new Request(`${ORIGIN}/`)],
    ["a subresource (iframe)", navigation("/", { "sec-fetch-dest": "iframe" })],
    ["a Chrome prefetch", navigation("/en/", { "sec-purpose": "prefetch" })],
    ["a Chrome prerender", navigation("/en/", { "sec-purpose": "prefetch;prerender" })],
    ["HEAD", new Request(`${ORIGIN}/`, { method: "HEAD", headers: { "sec-fetch-dest": "document" } })],
    ["the stylesheet", navigation("/style.css", { "sec-fetch-dest": "style" })],
    ["the sitemap", navigation("/sitemap.xml")],
    ["the www host (a redirect)", new Request("https://www.htmlgate.com/", { headers: { "sec-fetch-dest": "document" } })],
    ["a workers.dev preview", new Request("https://htmlgate-site.someone.workers.dev/", { headers: { "sec-fetch-dest": "document" } })],
    ["the /app redirect", navigation("/app")],
  ])("%s", async (_name, req) => {
    const { points } = await run(req);
    expect(points).toEqual([]);
  });
});

describe("counting never touches the response", () => {
  test("with the binding missing (a misconfigured deploy), the page and its headers are unchanged", async () => {
    const control = await run(navigation("/"));
    const { res, body } = await run(navigation("/"), "missing");
    expect(res.status).toBe(200);
    expect(body).toBe(control.body);
    for (const h of ["content-security-policy", "strict-transport-security", "x-content-type-options", "referrer-policy", "cache-control"]) {
      expect(res.headers.get(h), h).toBe(control.res.headers.get(h));
    }
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("config and notices agree with the code", () => {
  test("wrangler.jsonc binds PAGE_VIEWS to the dataset the README query reads", () => {
    const cfg = read("site/wrangler.jsonc");
    expect(cfg).toMatch(/"analytics_engine_datasets":\s*\[\s*\{\s*"binding":\s*"PAGE_VIEWS",\s*"dataset":\s*"htmlgate_site_page_views"\s*\}\s*\]/);
    expect(read("site/src/worker.ts")).toMatch(/PAGE_VIEWS: AnalyticsEngineDataset/);
    expect(read("README.md")).toMatch(/FROM htmlgate_site_page_views/);
  });

  test.each([
    ["site/public/en/privacy/index.html", ["the time", "the page", "whether it was found", "the country", "the name of the site the link came from", "no IP address", "3 months", "no cookie banner"]],
    ["site/public/privacidade/index.html", ["o horário", "a página", "se ela foi encontrada", "o país", "o nome do site de onde veio o link", "não registra endereço IP", "3 meses", "aviso de cookies"]],
  ])("%s names each stored field, the retention and why there is no banner, and still runs no script", (file, phrases) => {
    const html = read(file);
    for (const p of phrases) expect(html, p).toContain(p);
    expect(html).not.toMatch(/no analytics|ferramentas de análise/);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
});
