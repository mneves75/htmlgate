// The public landing (site/), served by its own Worker under `wrangler dev`, separate from every Instance:
// the Access application gates an Instance's Worker on every hostname, so the landing never lives there.
import { execFile } from "node:child_process";
import { request } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
// @ts-expect-error plain JavaScript module
import { checkAppGated, checkTarget, deployPlan } from "../scripts/site-deploy.mjs";
import { axeViolations } from "./a11y";
import { startSite } from "./global-setup";

const APP = "https://app.htmlgate.com/";
const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PAGES = [
  {
    path: "/", lang: "pt-BR", canonical: "https://htmlgate.com/", signIn: "Entrar", other: "/en/",
    title: "htmlgate: link privado para o HTML que o seu agente gera",
    description: "Um comando publica, um login protege. Na sua conta Cloudflare.",
    imageAlt: "Marca htmlgate e endereço htmlgate.com.",
  },
  {
    path: "/en/", lang: "en-US", canonical: "https://htmlgate.com/en/", signIn: "Sign in", other: "/",
    title: "htmlgate: private links for the HTML your agent makes",
    description: "One command publishes. One sign-in protects it. In your own Cloudflare account.",
    imageAlt: "htmlgate wordmark and htmlgate.com address.",
  },
];

// The privacy notice: one page per language, linked from both landings' footers.
const PRIVACY = [
  { path: "/privacidade/", lang: "pt-BR", canonical: "https://htmlgate.com/privacidade/", other: "/en/privacy/", home: "/" },
  { path: "/en/privacy/", lang: "en-US", canonical: "https://htmlgate.com/en/privacy/", other: "/privacidade/", home: "/en/" },
];

let site: { base: string; stop: () => Promise<void> };
let base: string;
let port: number;

/** One request with a chosen Host header, which fetch() cannot set. Redirects are not followed. */
function hit(path: string, opts: { host?: string; method?: string; userAgent?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: {
      ...(opts.host ? { host: opts.host } : {}),
      ...(opts.userAgent ? { "user-agent": opts.userAgent } : {}),
    } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  site = await startSite();
  base = site.base;
  port = Number(new URL(base).port);
});

afterAll(() => site?.stop());

describe("pages", () => {
  test.each(PAGES)("$path gives Twitterbot a localized large-image card and a public JPEG in its initial HTML", async (p) => {
    const userAgent = "Twitterbot/1.0";
    const r = await hit(p.path, { host: "htmlgate.com", userAgent });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/html/);
    expect(r.headers.location).toBeUndefined();
    expect(r.headers["x-robots-tag"]).toBeUndefined();
    expect(r.body).toContain(`<html lang="${p.lang}">`);
    expect(r.body).toContain(`<link rel="canonical" href="${p.canonical}">`);
    const meta = (name: string) => {
      const matches = [...r.body.matchAll(new RegExp(`<meta\\b(?=[^>]*\\b(?:name|property)="${name}")(?=[^>]*\\bcontent="([^"]*)")[^>]*>`, "g"))];
      expect(matches, `${p.path} ${name} must occur exactly once`).toHaveLength(1);
      return matches[0]![1]!;
    };
    const image = meta("og:image");
    expect(image).toBe("https://htmlgate.com/media/htmlgate-15s.jpg");
    expect(meta("og:image:type")).toBe("image/jpeg");
    expect(meta("og:image:width")).toBe("1600");
    expect(meta("og:image:height")).toBe("900");
    expect(meta("og:image:alt")).toBe(p.imageAlt);
    expect(meta("og:title")).toBe(p.title);
    expect(meta("og:description")).toBe(p.description);
    expect(meta("og:url")).toBe(p.canonical);
    expect(meta("twitter:card")).toBe("summary_large_image");
    expect(meta("twitter:title")).toBe(p.title);
    expect(meta("twitter:description")).toBe(p.description);
    expect(meta("twitter:image")).toBe(image);
    expect(meta("twitter:image:alt")).toBe(p.imageAlt);

    // Validate the advertised production URL above; fetch its path from this local Worker.
    const localImage = new URL(new URL(image).pathname, base);
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(localImage, { method, headers: { "user-agent": userAgent }, redirect: "manual" });
      expect(response.status, `${method} ${localImage.pathname}`).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(response.headers.get("content-type")).toMatch(/^image\/jpeg(?:;|$)/);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (method === "HEAD") {
        expect(bytes.length).toBe(0);
      } else {
        expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
        expect([...bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
        // Project image budget, not a claim about X's current limits.
        expect(bytes.length).toBeLessThan(5 * 1024 * 1024);
      }
    }
    const robots = await hit("/robots.txt", { host: "htmlgate.com", userAgent });
    expect(robots.status).toBe(200);
    expect(robots.body).toContain("Allow: /");
    expect(robots.body).not.toMatch(/Disallow: \/\s*$/m);
  });

  test.each(PAGES)("$path is the $lang page, with its canonical URL and both alternates", async (p) => {
    const r = await hit(p.path, { host: "htmlgate.com" });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/html/);
    expect(r.body).toContain(`<html lang="${p.lang}">`);
    expect(r.body).toContain(`<link rel="canonical" href="${p.canonical}">`);
    expect(r.body).toContain(`<link rel="alternate" hreflang="pt-BR" href="https://htmlgate.com/">`);
    expect(r.body).toContain(`<link rel="alternate" hreflang="en-US" href="https://htmlgate.com/en/">`);
    expect(r.body).toContain(`<link rel="alternate" hreflang="x-default" href="https://htmlgate.com/">`);
    // The other language is one visible link away, marked with its own language.
    expect(r.body).toMatch(new RegExp(`<a [^>]*href="${p.other.replace(/\//g, "\\/")}"[^>]*hreflang=`));
  });

  test.each(PAGES)("$path signs people in at app.htmlgate.com, and links nowhere else on htmlgate.com", async (p) => {
    const { body } = await hit(p.path);
    expect(body).toMatch(new RegExp(`<a [^>]*href="${APP}"[^>]*>${p.signIn}</a>`));
    const hosts = [...body.matchAll(/href="https:\/\/([^/"]+)/g)].map((m) => m[1]);
    for (const h of hosts.filter((h) => h!.endsWith("htmlgate.com"))) expect(["htmlgate.com", "app.htmlgate.com"]).toContain(h);
  });

  test.each(PAGES)("$path loads nothing from elsewhere and runs no script", async (p) => {
    const { body } = await hit(p.path);
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toMatch(/\son[a-z]+=/i);
    for (const m of body.matchAll(/<(?:link|img|source)\b[^>]*\s(?:src|href)="([^"]+)"/g)) {
      if (/rel="(?:canonical|alternate)"/.test(m[0])) continue;
      expect(m[1], m[0]).toMatch(/^\/(?!\/)/);
    }
  });

  test("both languages carry the same sections in the same order", async () => {
    const ids = (html: string) => [...html.matchAll(/<section [^>]*id="([^"]+)"/g)].map((m) => m[1]);
    const pt = ids((await hit("/")).body);
    expect(pt.length).toBeGreaterThanOrEqual(5);
    expect(ids((await hit("/en/")).body)).toEqual(pt);
  });

  test.each(PRIVACY)("$path is the $lang privacy notice, with its canonical URL, both alternates and the contact address", async (p) => {
    const r = await hit(p.path, { host: "htmlgate.com" });
    expect(r.status).toBe(200);
    expect(r.body).toContain(`<html lang="${p.lang}">`);
    expect(r.body).toContain(`<link rel="canonical" href="${p.canonical}">`);
    expect(r.body).toContain(`<link rel="alternate" hreflang="pt-BR" href="https://htmlgate.com/privacidade/">`);
    expect(r.body).toContain(`<link rel="alternate" hreflang="en-US" href="https://htmlgate.com/en/privacy/">`);
    expect(r.body).toMatch(new RegExp(`<a [^>]*href="${p.other.replace(/\//g, "\\/")}"[^>]*hreflang=`));
    expect(r.body).toContain('<a href="mailto:privacidade@htmlgate.com">privacidade@htmlgate.com</a>');
    expect(r.body).not.toMatch(/<script/i);
    expect(r.headers["content-security-policy"]).toBe(CSP);
    // The landing in the same language links to it from its footer.
    expect((await hit(p.home)).body).toMatch(new RegExp(`<footer>[\\s\\S]*href="${p.path.replace(/\//g, "\\/")}"[\\s\\S]*</footer>`));
  });

  test("both privacy notices carry the same sections in the same order, and the sitemap lists them", async () => {
    const ids = (html: string) => [...html.matchAll(/<section [^>]*id="([^"]+)"/g)].map((m) => m[1]);
    const pt = ids((await hit("/privacidade/")).body);
    expect(pt).toEqual(["site", "instances", "sharing", "rights", "contact"]);
    expect(ids((await hit("/en/privacy/")).body)).toEqual(pt);
    const sitemap = (await hit("/sitemap.xml")).body;
    for (const p of PRIVACY) expect(sitemap).toContain(`<loc>${p.canonical}</loc>`);
  });

  test("/en without its slash goes to /en/", async () => {
    const r = await hit("/en");
    expect(r.status).toBeGreaterThanOrEqual(301);
    expect(r.status).toBeLessThanOrEqual(308);
    expect(r.headers.location).toMatch(/\/en\/$/);
  });

  test("an unknown path is a 404 page, not the home page", async () => {
    const r = await hit("/nope");
    expect(r.status).toBe(404);
    expect(r.body).not.toContain('<link rel="canonical"');
  });
});

describe("transport", () => {
  test("pages, redirects and the 404 all tell browsers to use HTTPS for a year, subdomains included", async () => {
    for (const [path, host, status] of [["/", "htmlgate.com", 200], ["/", "www.htmlgate.com", 301], ["/nope", "htmlgate.com", 404]] as const) {
      const r = await hit(path, { host });
      expect(r.status, `${host}${path}`).toBe(status);
      expect(r.headers["strict-transport-security"], `${host}${path}`).toBe("max-age=31536000; includeSubDomains");
    }
  });
});

describe("redirects", () => {
  test("/app goes to app.htmlgate.com, temporarily, and forwards nothing the visitor sent", async () => {
    // 302: browsers keep a 301 for good, and the app's address may still change.
    for (const path of ["/app", "/app/", "/app?next=https://evil.example/"]) {
      const r = await hit(path, { host: "htmlgate.com" });
      expect(r.status).toBe(302);
      expect(r.headers.location).toBe(APP);
    }
    expect((await hit("/app/anything")).status).toBe(404);
  });

  test("www.htmlgate.com goes to htmlgate.com, keeping the path and query, for pages and files alike", async () => {
    for (const [path, to] of [["/en/?ref=x", "/en/?ref=x"], ["/style.css", "/style.css"], ["/", "/"]]) {
      for (const method of ["GET", "HEAD"]) {
        const r = await hit(path!, { host: "www.htmlgate.com", method });
        expect(r.status, `${method} ${path}`).toBe(301);
        expect(r.headers.location, `${method} ${path}`).toBe(`https://htmlgate.com${to}`);
      }
    }
  });

  test("a www path that looks like another host stays a path on htmlgate.com", async () => {
    for (const path of ["//evil.example/x", "/%2F%2Fevil.example/x", "/\\evil.example/x", "//evil.example/%2E%2E/"]) {
      const r = await hit(path, { host: "www.htmlgate.com" });
      expect(r.status, path).toBe(301);
      expect(new URL(r.headers.location as string).host, path).toBe("htmlgate.com");
    }
  });

  test("another host is never redirected to itself or elsewhere", async () => {
    for (const host of ["www.evil.example", "evil.example", "www.htmlgate.com.evil.example"]) {
      const r = await hit("/", { host });
      expect(r.status, host).toBe(200);
      expect(r.headers.location, host).toBeUndefined();
    }
  });

  test("a change request is refused, not redirected or served", async () => {
    for (const [path, host] of [["/", "htmlgate.com"], ["/app", "htmlgate.com"], ["/", "www.htmlgate.com"]] as const) {
      const r = await hit(path, { host, method: "POST" });
      expect(r.status, `${host}${path}`).toBe(405);
      expect(r.headers.allow).toBe("GET, HEAD");
    }
  });
});

describe("headers", () => {
  test.each([
    ["/", "GET"], ["/en/", "GET"], ["/style.css", "GET"], ["/nope", "GET"], ["/robots.txt", "GET"], ["/", "HEAD"], ["/app", "GET"], ["/", "POST"],
  ])("%s (%s) carries the strict CSP and the hardening headers", async (path, method) => {
    const r = await hit(path, { host: "htmlgate.com", method });
    expect(r.headers["content-security-policy"]).toBe(CSP);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    // The landing is public and the same for everyone: cacheable, unlike an Instance's no-store pages.
    expect(r.headers["cache-control"]).toBe("public, max-age=300");
  });

  test("the canonical host is indexable, and every other host (the workers.dev preview) is not", async () => {
    expect((await hit("/", { host: "htmlgate.com" })).headers["x-robots-tag"]).toBeUndefined();
    expect((await hit("/", { host: "htmlgate-site.example.workers.dev" })).headers["x-robots-tag"]).toBe("noindex");
    const robots = await hit("/robots.txt", { host: "htmlgate.com" });
    expect(robots.body).toContain("Allow: /");
    expect(robots.body).not.toMatch(/Disallow: \/\s*$/m);
    expect(robots.body).toContain("Sitemap: https://htmlgate.com/sitemap.xml");
    const sitemap = (await hit("/sitemap.xml")).body;
    expect(sitemap).toContain("<loc>https://htmlgate.com/</loc>");
    expect(sitemap).toContain("<loc>https://htmlgate.com/en/</loc>");
  });
});

describe("in a real browser", () => {
  const run = promisify(execFile);
  const BIN = join(process.cwd(), "node_modules/.bin/agent-browser");
  const SESSION = `htmlgate-site-${process.pid}`;
  const ab = async (...args: string[]) => (await run(BIN, ["--session", SESSION, ...args], { timeout: 30_000 })).stdout.trim();

  afterAll(async () => ab("close").catch(() => {}));

  const violations = async () => (await axeViolations(ab)).map((v) => `${v.id} ${v.nodes.join(" ")}`);

  test.each([
    ["light", 1280, 900], ["dark", 1280, 900], ["light", 375, 812], ["dark", 375, 812], ["light", 320, 640], ["dark", 320, 640],
  ] as const)("%s at %ipx: both pages pass axe for WCAG 2.2 AA and never scroll sideways", async (scheme, w, h) => {
    await ab("open", "about:blank");
    await ab("set", "viewport", String(w), String(h));
    await ab("set", "media", scheme);
    for (const p of [...PAGES, ...PRIVACY]) {
      await ab("open", `${base}${p.path}`);
      await ab("wait", "--fn", "document.readyState === 'complete' && document.getAnimations().length === 0");
      expect(await violations(), `${p.path} ${scheme} ${w}`).toEqual([]);
      expect(await ab("eval", "document.documentElement.scrollWidth <= window.innerWidth"), `${p.path} overflow at ${w}`).toBe("true");
      // The first Tab shows the skip link, which must not cover another control (axe target-size).
      await ab("press", "Tab");
      expect(await ab("eval", "document.activeElement.classList.contains('skip')"), `${p.path} first Tab`).toBe("true");
      expect(await violations(), `${p.path} ${scheme} ${w} skip link shown`).toEqual([]);
    }
  }, 180_000);
});

describe("deploying the landing", () => {
  test("a preview is its own Worker on workers.dev and never touches a domain", () => {
    const p = deployPlan(["--preview"]);
    expect(p.name).toBe("htmlgate-site-preview");
    expect(p.domains).toEqual([]);
    expect(p.args).toEqual(["deploy", "-c", "site/wrangler.jsonc", "--name", "htmlgate-site-preview"]);
  });

  test("live always attaches htmlgate.com and www together, so no deploy can drop one of them", () => {
    const p = deployPlan(["--live"]);
    expect(p.name).toBe("htmlgate-site");
    expect(p.domains).toEqual(["htmlgate.com", "www.htmlgate.com"]);
    expect(p.args).toEqual(["deploy", "-c", "site/wrangler.jsonc", "--name", "htmlgate-site", "--domain", "htmlgate.com", "--domain", "www.htmlgate.com"]);
  });

  /** A stand-in for the cf CLI: one page of Workers, then an empty one, and the Access applications. */
  const cfWith = (workers: unknown[], apps: unknown[] = []) => (...args: string[]) =>
    args[0] === "workers" ? (args.includes("1") ? workers : []) : apps;

  test("a deploy refuses a Worker that is an Instance, and a preview refuses one that serves a domain", () => {
    const preview = deployPlan(["--preview"]);
    const live = deployPlan(["--live"]);
    expect(() => checkTarget(preview, cfWith([]))).not.toThrow();
    expect(() => checkTarget(live, cfWith([{ name: "htmlgate-site", references: { domains: [{ hostname: "htmlgate.com" }] } }]))).not.toThrow();
    expect(() => checkTarget(preview, cfWith([{ name: "htmlgate-site-preview", references: { domains: [{ hostname: "htmlgate.com" }] } }]))).toThrow(/Custom Domain/);
    expect(() => checkTarget(preview, cfWith([{ name: "htmlgate-site-preview" }], [{ name: "htmlgate: htmlgate-site-preview" }]))).toThrow(/Instance/);
    expect(() => checkTarget(live, cfWith([{ name: "htmlgate-site" }], [{ name: "htmlgate: htmlgate-site" }]))).toThrow(/Instance/);
  });

  test("going live needs app.htmlgate.com to answer behind its sign-in, so no visitor lands on a dead link", async () => {
    const answer = (status: number, location?: string) => async () => new Response(null, { status, headers: location ? { location } : {} });
    await expect(checkAppGated(answer(302, "https://team.cloudflareaccess.com/cdn-cgi/access/login/app.htmlgate.com?kid=x"))).resolves.toBeUndefined();
    await expect(checkAppGated(answer(200))).rejects.toThrow(/app.htmlgate.com/);
    await expect(checkAppGated(answer(302, "https://evil.example/cloudflareaccess.com"))).rejects.toThrow(/app.htmlgate.com/);
    await expect(checkAppGated(async () => { throw new Error("getaddrinfo ENOTFOUND"); })).rejects.toThrow(/app.htmlgate.com/);
  });

  test.each([[[]], [["--preview", "--live"]], [["--prod"]]])("refuses %j: the target must be named, once", (argv) => {
    expect(() => deployPlan(argv)).toThrow(/--preview or --live/);
  });
});
