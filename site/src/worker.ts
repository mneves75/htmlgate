// The public landing at htmlgate.com. It is not an Instance: it has no data, no sign-in and no Access
// application, and it runs in front of its static files only to redirect and to set headers in one place.
interface Env {
  ASSETS: Fetcher;
  /** The canonical origin, such as https://htmlgate.com. Only this host is indexable. */
  SITE_ORIGIN: string;
  /** Where "Sign in" and /app lead: the Instance at app.htmlgate.com. */
  APP_URL: string;
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
    return res;
  },
} satisfies ExportedHandler<Env>;

function redirect(location: string, status: 301 | 302): Response {
  return withHeaders(new Response(null, { status, headers: { location } }));
}

function withHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(HEADERS)) out.headers.set(k, v);
  return out;
}
