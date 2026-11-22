interface Env {
  ASSETS: Fetcher;
  SITE_ORIGIN: string;
  APP_URL: string;
  PAGE_VIEWS: AnalyticsEngineDataset;
}

const HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "cache-control": "public, max-age=300",
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return withHeaders(new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" } }));
    }
    const url = new URL(req.url);
    const site = new URL(env.SITE_ORIGIN);
    if (url.hostname === `www.${site.hostname}`) {
      const to = new URL(site.origin);
      to.pathname = url.pathname;
      to.search = url.search;
      return redirect(to.href, 301);
    }
    if (url.pathname === "/app" || url.pathname === "/app/") return redirect(env.APP_URL, 302);

    const res = withHeaders(await env.ASSETS.fetch(req));
    if (url.hostname !== site.hostname) res.headers.set("x-robots-tag", "noindex");
    else if (req.method === "GET") countView(req, url, res, site, env.PAGE_VIEWS);
    return res;
  },
} satisfies ExportedHandler<Env>;

function countView(req: Request, url: URL, res: Response, site: URL, dataset: AnalyticsEngineDataset): void {
  // Browsers send Sec-Purpose for speculative prefetch/prerender, which is not a real page view.
  if (req.headers.get("sec-fetch-dest") !== "document" || req.headers.has("sec-purpose")) return;
  if (!res.headers.get("content-type")?.startsWith("text/html")) return;
  try {
    const page = res.status === 404 ? "404" : url.pathname.slice(0, 96);
    const country = String(req.cf?.country ?? "");
    let from = "";
    try {
      from = new URL(req.headers.get("referer") ?? "").hostname.slice(0, 128);
    } catch {}
    if (from === site.hostname || from === `www.${site.hostname}`) from = "";
    dataset.writeDataPoint({ indexes: [page], blobs: [page, String(res.status), country, from] });
  } catch (e) {
    console.error("page count failed", e);
  }
}

function redirect(location: string, status: 301 | 302): Response {
  return withHeaders(new Response(null, { status, headers: { location } }));
}

function withHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(HEADERS)) out.headers.set(k, v);
  return out;
}
