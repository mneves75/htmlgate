// The landing's page counts: one Analytics Engine data point per page a browser navigates to, written by the
// Worker. The landing's Worker runs here in process, with its static files and the dataset faked, because
// Analytics Engine data can only be read back from Cloudflare.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import worker from "../site/src/worker.ts";

const ORIGIN = "https://htmlgate.com";

function env(points: AnalyticsEngineDataPoint[], opts: { throws?: boolean } = {}) {
  const ASSETS = {
    fetch: async (req: Request) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith(".css")) return new Response("body{}", { headers: { "content-type": "text/css" } });
      const found = ["/", "/en/", "/privacidade/", "/en/privacy/"].includes(path);
      return new Response("<!doctype html>", { status: found ? 200 : 404, headers: { "content-type": "text/html; charset=utf-8" } });
    },
  } as unknown as Fetcher;
  const PAGE_VIEWS: AnalyticsEngineDataset = {
    writeDataPoint: (p) => {
      if (opts.throws) throw new Error("dataset unavailable");
      points.push(p!);
    },
  };
  return { ASSETS, PAGE_VIEWS, SITE_ORIGIN: ORIGIN, APP_URL: "https://app.htmlgate.com/" };
}

/** A browser's top-level navigation, as Chrome, Firefox and Safari send it. */
function visit(url: string, headers: Record<string, string> = {}, method = "GET") {
  const req = new Request(url, { method, headers: { "sec-fetch-dest": "document", "user-agent": "Mozilla/5.0 Test", ...headers } });
  // Cloudflare adds the visitor's country and IP; neither may reach the data point except the country.
  Object.defineProperty(req, "cf", { value: { country: "BR" } });
  return req;
}

async function run(req: Request, opts: { throws?: boolean } = {}) {
  const points: AnalyticsEngineDataPoint[] = [];
  const res = await worker.fetch(req, env(points, opts));
  return { res, points };
}

test("a visit to a page writes one point: the page, its status, the country and the referring site", async () => {
  const { res, points } = await run(visit(`${ORIGIN}/en/?utm_source=x&email=a@b.test`, { referer: "https://news.example.com/item?id=1", "cf-connecting-ip": "203.0.113.9" }));
  expect(res.status).toBe(200);
  expect(points).toEqual([{ indexes: ["/en/"], blobs: ["/en/", "200", "BR", "news.example.com"] }]);
});

test("a missing page counts as 404 without recording the address asked for", async () => {
  const { res, points } = await run(visit(`${ORIGIN}/wp-admin/a@b.test`));
  expect(res.status).toBe(404);
  expect(points).toEqual([{ indexes: ["404"], blobs: ["404", "404", "BR", ""] }]);
});

test("links within the site and from www record no referring site", async () => {
  for (const referer of [`${ORIGIN}/`, "https://www.htmlgate.com/"]) {
    const { points } = await run(visit(`${ORIGIN}/privacidade/`, { referer }));
    expect(points[0]!.blobs![3]).toBe("");
  }
});

test.each([
  ["a stylesheet", visit(`${ORIGIN}/style.css`, { "sec-fetch-dest": "style" })],
  ["a HEAD request", visit(`${ORIGIN}/`, {}, "HEAD")],
  ["a request that is not a navigation (a crawler or curl)", new Request(`${ORIGIN}/`)],
  ["a prefetch", visit(`${ORIGIN}/`, { "sec-purpose": "prefetch" })],
  ["a preview hostname", visit("https://htmlgate-site.example.workers.dev/")],
  ["the www redirect", visit("https://www.htmlgate.com/")],
])("%s writes no point", async (_name, req) => {
  const { points } = await run(req);
  expect(points).toEqual([]);
});

test("a failing dataset never breaks the page", async () => {
  const { res } = await run(visit(`${ORIGIN}/`), { throws: true });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
});

// The counts are what the privacy notice discloses; the notice must keep saying so, in both languages.
test.each([
  ["site/public/en/privacy/index.html", "counts each page a browser opens", "no IP address", "3 months"],
  ["site/public/privacidade/index.html", "conta cada página que um navegador abre", "não guarda endereço IP", "3 meses"],
])("%s discloses the page counts", (file, ...phrases) => {
  const html = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  for (const phrase of phrases) expect(html).toContain(phrase);
  expect(html).not.toMatch(/no analytics|ferramentas de análise/);
});
