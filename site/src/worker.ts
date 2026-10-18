// The public landing at htmlgate.com. It is not an Instance: it has no data, no sign-in and no Access
// application, and it runs in front of its static files only to redirect and to set headers in one place.
interface Env {
  ASSETS: Fetcher;
  /** The canonical origin, such as https://htmlgate.com. Only this host is indexable. */
  SITE_ORIGIN: string;
  /** Where "Sign in" and /app lead: the Instance at app.htmlgate.com. */
  APP_URL: string;
  /** Page counts in Workers Analytics Engine: one point per page a browser opens, with no cookie and no IP. */
  PAGE_VIEWS: AnalyticsEngineDataset;
}

const HEADERS: Record<string, string> = {
  // The pages run no script and load only their own stylesheet, images and video.
  "content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  // Every htmlgate.com hostname is a Workers Custom Domain on HTTPS, so subdomains are covered too.
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
    // Fixed destinations only: the visitor's path and query are set on a URL whose host is ours, so a path
    // such as //evil.example/x stays a path and can never become the host.
    if (url.hostname === `www.${site.hostname}`) {
      const to = new URL(site.origin);
      to.pathname = url.pathname;
      to.search = url.search;
      return redirect(to.href, 301);
    }
    // Temporary: browsers keep a 301 for good, and the app's address may still change.
    if (url.pathname === "/app" || url.pathname === "/app/") return redirect(env.APP_URL, 302);

    const res = withHeaders(await env.ASSETS.fetch(req));
    if (url.hostname !== site.hostname) res.headers.set("x-robots-tag", "noindex");
    else if (req.method === "GET") countView(req, url, res, site, env.PAGE_VIEWS);
    return res;
  },
} satisfies ExportedHandler<Env>;

/**
 * Counts a page a browser opened: the page (a missing one only as "404", never the address asked for), the status,
 * the country Cloudflare gives and the referring site's hostname. Only real navigations count: a browser marks them
 * `Sec-Fetch-Dest: document`, and a prefetch or prerender `Sec-Purpose`. A failure here never reaches the visitor.
 */
function countView(req: Request, url: URL, res: Response, site: URL, dataset: AnalyticsEngineDataset): void {
  if (req.headers.get("sec-fetch-dest") !== "document" || req.headers.has("sec-purpose")) return;
  if (!res.headers.get("content-type")?.startsWith("text/html")) return;
  try {
    const page = res.status === 404 ? "404" : url.pathname.slice(0, 96);
    const country = String((req.cf as { country?: unknown } | undefined)?.country ?? "");
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
