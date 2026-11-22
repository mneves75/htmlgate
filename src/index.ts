// Entry point. Routes are matched exactly: Access matches its public paths loosely (issue #18),
// so anything that is not one of these exact shapes gets the same not-found answer.
import { person } from "./access";
import { handleApi } from "./api";
import { readConfig, type Config, type Env, type Language } from "./config";
import { bytes, contentTypeFor, copyResponse, fail, readCapped, redirect, stream, text } from "./http";
import { POSITIVE, SLUG, newToken, randomHex, sha256Hex } from "./ids";
import ogPoster from "../site/public/media/htmlgate-15s.jpg";
import { SHARE_SANDBOX, HOME_SHARES, homePage, metricsPage, notFoundPage, tokensPage, viewerPage, type HomeNote, type PageResult, type Visitor } from "./pages";
import { CLEANUP_BATCH, Store } from "./store";
import { importTicketKey, openTicket, sealTicket, TICKET_TTL_MS } from "./ticket";
import { siteRequestPath } from "./zip";

async function html(status: number, page: PageResult | Promise<PageResult>): Promise<Response> {
  const p = await page;
  return text(status, p.body, "text/html; charset=utf-8", { "content-security-policy": p.csp });
}

const notFound = (lang: Language, opts: { signInPath?: string; home?: "author" | "viewer" } = {}) => html(404, notFoundPage(lang, opts));

const ROBOTS = "User-agent: *\nAllow: /p/\nDisallow: /\n";

const CARD_IMAGE = /^\/p\/([A-Za-z0-9]{12})\/card\.jpg$/;
const OG_IMAGE_TYPE = "image/jpeg";
const VIEW = /^\/(s|p)\/([A-Za-z0-9]{12})(\/raw)?$/;
const METRICS_SHARES = 500;
const dayFrom = (ms: number, offsetDays: number) => new Date(ms + offsetDays * 86_400_000).toISOString().slice(0, 10);
const PUBLIC_FILE = /^\/p\/([A-Za-z0-9]{12})\/([1-9][0-9]{0,8})\/(.*)$/;
const TICKET_FILE = /^\/f\/([A-Za-z0-9_-]{40,1024})\/(.*)$/;
const MAX_FORM_BYTES = 4 * 1024;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let res: Response;
    try {
      res = await route(req, env, ctx);
    } catch (e) {
      console.error("unhandled", e);
      res = fail(500, "internal_error", "Something went wrong on this Instance.");
    }
    return new URL(req.url).pathname.startsWith("/f/") ? noReferrer(res) : res;
  },

  /**
   * Hourly (wrangler.jsonc triggers): purge expired Shares, then delete due bodies. At most 3 purge batches (4 D1
   * queries each) and 10 trash rounds (2 each): 32 queries, under Workers Free's 50 per invocation. What is left
   * waits for the next hour. Each step runs whatever the other did, and a failure is logged by name before the run
   * fails: an Instance logs errors only, so an unlogged failure would show up first as a full storage cap.
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const store = new Store(env.DB, env.BODIES);
    const steps: [string, () => Promise<void>][] = [
      ["expire", () => drain(() => store.expire(Date.now()), 3)],
      ["trash", () => drain(() => store.emptyTrash(), 10)],
    ];
    const failures: unknown[] = [];
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (e) {
        console.error("scheduled", name, e);
        failures.push(e);
      }
    }
    if (failures.length) throw failures[0];
  },
} satisfies ExportedHandler<Env>;

async function drain(step: () => Promise<number>, rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if ((await step()) < CLEANUP_BATCH) return;
  }
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  const insecure = cleartext(req, url);
  if (insecure) return insecure;

  if (path === "/robots.txt" && req.method === "GET") return text(200, ROBOTS, "text/plain; charset=utf-8");

  const cfg = readConfig(env);
  if (!cfg) return fail(503, "server_misconfigured", "This Instance is missing its settings. The Operator must run setup.");

  const card = CARD_IMAGE.exec(path);
  if (card && (req.method === "GET" || req.method === "HEAD")) {
    const share = await new Store(env.DB, env.BODIES).viewableVersion(cfg.author, card[1]!, true, null);
    if (!share) return notFound(cfg.language, { signInPath: `/s/${card[1]}` });
    return bytes(ogPoster, OG_IMAGE_TYPE, { "cache-control": "public, max-age=31536000, immutable" });
  }


  if (path === "/api" || path.startsWith("/api/")) return handleApi(req, env, ctx, cfg, url);

  return handlePeople(req, env, ctx, cfg, url);
}

async function handlePeople(req: Request, env: Env, ctx: ExecutionContext, cfg: Config, url: URL): Promise<Response> {
  const path = url.pathname;
  const view = VIEW.exec(path);
  if (view && view[1] === "p") {
    if (req.method !== "GET") return notFound(cfg.language, { signInPath: `/s/${view[2]}` });
    const res = await serveShare(env, cfg, url, "p", view[2]!, !!view[3], null);
    return res === null ? notFound(cfg.language, { signInPath: `/s/${view[2]}` }) : counted(req, env, ctx, view[2]!, !!view[3], res);
  }
  const pub = PUBLIC_FILE.exec(path);
  if (pub) {
    if (req.method !== "GET") return notFound(cfg.language, { signInPath: `/s/${pub[1]}` });
    return (await serveSiteFile(env, cfg, pub[1]!, Number(pub[2]), pub[3]!, true)) ?? notFound(cfg.language, { signInPath: `/s/${pub[1]}` });
  }
  const ticket = TICKET_FILE.exec(path);
  if (ticket) return req.method === "GET" ? await serveTicketFile(req, env, cfg, ticket[1]!, ticket[2]!) : await notFound(cfg.language);
  if (path.startsWith("/f/")) return notFound(cfg.language);

  const who = await person(req, cfg);
  if (!who) return notFound(cfg.language, { home: "viewer" });
  const isAuthor = who === cfg.author;
  const visitor: Visitor = { email: who, isAuthor, origin: url.origin, lang: cfg.language };
  const store = new Store(env.DB, env.BODIES);
  const lost = () => notFound(cfg.language, { home: isAuthor ? "author" : "viewer" });

  if (path === "/" && req.method === "GET") {
    const erased = url.searchParams.get("erased");
    const asked = isAuthor && erased !== null && SLUG.test(erased);
    const [target, shares, views] = await Promise.all([
      asked ? store.eraseTarget(cfg.author, erased) : null,
      isAuthor ? store.recentShares(cfg.author, HOME_SHARES) : null,
      isAuthor ? store.viewsBySlug(dayFrom(Date.now(), -30)) : undefined,
    ]);
    return html(200, homePage(visitor, shares, asked && !target ? { erased } : undefined, views));
  }

  if (view && req.method === "GET") {
    const res = await serveShare(env, cfg, url, "s", view[2]!, !!view[3], who);
    return res === null ? lost() : counted(req, env, ctx, view[2]!, !!view[3], res);
  }

  if (path === "/erase") {
    if (!isAuthor || req.method !== "POST") return lost();
    const again = async (status: number, note: HomeNote) => html(status, homePage(visitor, await store.recentShares(cfg.author, HOME_SHARES), note));
    if (!sameOrigin(req, url)) return again(403, { error: "refused" });
    const form = await readCapped(req, MAX_FORM_BYTES);
    if (form === null) return again(413, { error: "too-large" });
    const fields = new URLSearchParams(form);
    const slug = shareSlug(fields.get("share") ?? "");
    if (slug === null) return again(400, { error: "bad-share" });
    const target = await store.eraseTarget(cfg.author, slug);
    if (!target) return again(404, { error: "no-share" });
    if (fields.get("confirm") !== "1") return again(200, { confirm: { slug, title: target.title } });
    if (!(await store.eraseShare(cfg.author, slug))) return again(404, { error: "no-share" });
    ctx.waitUntil(store.eraseBodies(slug, target.keys).catch((e) => console.error("erase cleanup", e)));
    return redirect(`/?erased=${slug}`);
  }

  if (path === "/metrics") {
    if (!isAuthor) return lost();
    if (req.method !== "GET") return lost();
    const [recent, views] = await Promise.all([store.recentShares(cfg.author, METRICS_SHARES), store.viewsBySlug(dayFrom(Date.now(), -30))]);
    return html(200, metricsPage(visitor, recent.shares, views));
  }

  if (path === "/tokens" || path.startsWith("/tokens/")) {
    if (!isAuthor) return lost();
    if (req.method === "GET" && path === "/tokens") return html(200, tokensPage(visitor, await store.listTokens(cfg.author)));
    if (req.method !== "POST") return lost();
    if (!sameOrigin(req, url)) return html(403, tokensPage(visitor, await store.listTokens(cfg.author), undefined, "refused"));
    if (path === "/tokens") {
      const raw = await readCapped(req, MAX_FORM_BYTES);
      if (raw === null) return html(413, tokensPage(visitor, await store.listTokens(cfg.author), undefined, "too-large"));
      const name = (new URLSearchParams(raw).get("name") ?? "").trim();
      if (!name || name.length > 64 || /(?![\u200c\u200d])[\p{Cc}\p{Cf}]/u.test(name)) {
        return html(400, tokensPage(visitor, await store.listTokens(cfg.author), undefined, "bad-name"));
      }
      const token = newToken();
      await store.createToken(randomHex(6), cfg.author, name, await sha256Hex(token), Date.now());
      return html(200, tokensPage(visitor, await store.listTokens(cfg.author), { name, token }));
    }
    const m = /^\/tokens\/([0-9a-f]{12})\/revoke$/.exec(path);
    if (m) {
      await store.revokeToken(cfg.author, m[1]!, Date.now());
      return redirect("/tokens");
    }
  }

  return lost();
}

const SHARE_INPUT = /^(?:(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s]+)?\/[sp]\/)?([A-Za-z0-9]{12})(?:\/raw)?\/?(?:[?#]\S*)?$/;
const shareSlug = (input: string): string | null => SHARE_INPUT.exec(input.trim())?.[1] ?? null;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function cleartext(req: Request, url: URL): Response | null {
  if (url.protocol !== "http:" || LOOPBACK.has(url.hostname)) return null;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/") || (req.method !== "GET" && req.method !== "HEAD")) {
    return fail(403, "https_required", "This Instance answers API requests and changes over https only.");
  }
  // To the default https port: Cloudflare's other plain http ports (8080, 8880, ...) are not https ports.
  const secure = new URL(url);
  secure.protocol = "https:";
  secure.port = "";
  return redirect(secure.href, 301);
}

/**
 * A change made with the person's sign-in must come from this Instance's own page.
 * Browsers set Sec-Fetch-Site and no page can forge it, so it decides when present: a Share runs in an
 * opaque origin and its requests are "cross-site". Without it, the Origin must be exactly ours.
 */
function sameOrigin(req: Request, url: URL): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  return req.headers.get("origin") === url.origin;
}

const RAW_HEADERS = {
  "content-security-policy": `sandbox ${SHARE_SANDBOX}; frame-ancestors 'self'`,
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
};

// A site's files (plan 009). The document loading them runs in an opaque origin, so every load is cross-origin; the URL
// itself is the permission (a ticket, or a Public Share's), so letting any origin read the answer grants nothing more.
// The sandbox is on every file, so an HTML or SVG file opened on its own is sandboxed too.
const SITE_HEADERS = {
  "content-security-policy": `sandbox ${SHARE_SANDBOX}; frame-ancestors 'self'`,
  "cross-origin-resource-policy": "cross-origin",
  "access-control-allow-origin": "*",
  "referrer-policy": "no-referrer",
};

function noReferrer(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("referrer-policy", "no-referrer");
  return copyResponse(res, headers);
}

async function siteUrl(cfg: Config, slug: string, n: number, who: string | null): Promise<string | null> {
  if (who === null) return `/p/${slug}/${n}/`;
  const key = await importTicketKey(cfg.ticketKey);
  if (!key) return null;
  return `/f/${await sealTicket(key, cfg.aud, { slug, n, email: who, exp: Date.now() + TICKET_TTL_MS })}/`;
}

async function serveShare(env: Env, cfg: Config, url: URL, prefix: "s" | "p", slug: string, raw: boolean, who: string | null): Promise<Response | null> {
  if (!SLUG.test(slug)) return null;
  const v = url.searchParams.get("v");
  if (v !== null && !POSITIVE.test(v)) return null;
  const store = new Store(env.DB, env.BODIES);
  const publicOnly = prefix === "p";
  if (raw) {
    const version = await store.viewableVersion(cfg.author, slug, publicOnly, v === null ? null : Number(v));
    if (!version) return null;
    if (version.kind === "site") {
      const to = await siteUrl(cfg, slug, version.n, who);
      return to === null ? null : redirect(to);
    }
    const body = await store.body(version.body_key);
    if (body === null) console.error("missing body", version.body_key);
    return body === null ? null : text(200, body, "text/html; charset=utf-8", RAW_HEADERS);
  }
  const found = await store.viewableWithVersions(cfg.author, slug, publicOnly);
  if (!found) return null;
  const n = v === null ? found.share.latest_version : Number(v);
  if (!found.kept.includes(n)) return null;
  const frame = found.kinds.get(n) === "site" ? await siteUrl(cfg, slug, n, who) : undefined;
  if (frame === null) return null;
  const erase = prefix === "s" && who === cfg.author;
  return html(200, viewerPage(cfg.language, found.share, prefix, n, found.kept, found.share.latest_version, frame, erase, url.origin));
}

function counted(req: Request, env: Env, ctx: ExecutionContext, slug: string, raw: boolean, res: Response): Response {
  if (raw || res.status !== 200) return res;
  if (req.headers.get("sec-fetch-dest") !== "document" || req.headers.has("sec-purpose")) return res;
  const limit = env.VIEW_LIMIT;
  if (!limit) return res;
  const store = new Store(env.DB, env.BODIES);
  const key = `${network(req.headers.get("cf-connecting-ip") ?? "")} ${slug}`;
  ctx.waitUntil((async () => {
    if (!(await limit.limit({ key })).success) return;
    await store.countView(slug, dayFrom(Date.now(), 0));
  })().catch((e) => console.error("view count", e)));
  return res;
}

/**
 * The network an address belongs to, for the view limit: an IPv4 address itself, an IPv6 address's /64, the block a
 * single subscriber is handed (RFC 6177), so rotating addresses inside it counts as one visitor.
 */
function network(address: string): string {
  if (!address.includes(":")) return address;
  const [head = "", tail] = address.split("::");
  const groups = (part: string) => (part ? part.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : []);
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const all = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return all.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":") + "::/64";
}

async function serveSiteFile(env: Env, cfg: Config, slug: string, n: number, rest: string, publicOnly: boolean): Promise<Response | null> {
  const path = siteRequestPath(rest);
  if (path === null) return null;
  const store = new Store(env.DB, env.BODIES);
  const file = await store.siteFile(cfg.author, slug, publicOnly, n, path);
  if (!file) return null;
  const bytes = await store.siteBytes(file);
  return bytes === null ? null : stream(bytes, contentTypeFor(path), SITE_HEADERS);
}

async function serveTicketFile(req: Request, env: Env, cfg: Config, sealed: string, rest: string): Promise<Response> {
  const key = await importTicketKey(cfg.ticketKey);
  if (!key) return fail(503, "server_misconfigured", "This Instance's ticket key is malformed. The Operator must run setup.");
  const t = await openTicket(key, cfg.aud, sealed);
  if (!t || !cfg.allowlist.has(t.email)) return notFound(cfg.language);
  if (t.exp <= Date.now()) {
    const navigating = req.headers.get("sec-fetch-mode") === "navigate" && req.headers.get("sec-fetch-dest") === "document";
    return navigating ? redirect(`/s/${t.slug}`) : notFound(cfg.language);
  }
  return (await serveSiteFile(env, cfg, t.slug, t.n, rest, false)) ?? notFound(cfg.language);
}
