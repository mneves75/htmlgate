// Entry point. Routes are matched exactly: Access matches its public paths loosely (issue #18),
// so anything that is not one of these exact shapes gets the same not-found answer.
import { person } from "./access";
import { handleApi } from "./api";
import { readConfig, type Config, type Env, type Language } from "./config";
import { BASE, contentTypeFor, fail, readCapped, redirect, stream, text } from "./http";
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

/**
 * What a crawler may read. A Public Share is meant to be shared, and an unfurler (X, WhatsApp, LinkedIn) reads the
 * page and its card image before it can preview anything, so `/p/` is open to crawlers; every other path - the gated
 * pages, tokens, metrics, the API and ticket URLs - stays out. The pages carry `noindex`, so being readable is not
 * being listed.
 */
const ROBOTS = "User-agent: *\nAllow: /p/\nDisallow: /\n";

/** One Public Share's card image, and its type: a single poster for the whole Instance, bundled from the landing's
 * artwork. Not exported: this module's exports are the Worker's handlers. */
const CARD_IMAGE = /^\/p\/([A-Za-z0-9]{12})\/card\.jpg$/;
const OG_IMAGE_TYPE = "image/jpeg";
const VIEW = /^\/(s|p)\/([A-Za-z0-9]{12})(\/raw)?$/;
/** How many Shares the report lists: every one an Instance is likely to hold, and its own row count, not a page. */
const METRICS_SHARES = 500;
/** A UTC day, `YYYY-MM-DD`, offset from now: the window a report covers. */
const dayFrom = (ms: number, offsetDays: number) => new Date(ms + offsetDays * 86_400_000).toISOString().slice(0, 10);
// A site's files (plan 009): a Public Share's by slug and Version; a Gated Share's by ticket. Both sit outside Access.
const PUBLIC_FILE = /^\/p\/([A-Za-z0-9]{12})\/([1-9][0-9]{0,8})\/(.*)$/;
const TICKET_FILE = /^\/f\/([A-Za-z0-9_-]{40,1024})\/(.*)$/;
const MAX_FORM_BYTES = 4 * 1024;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let res: Response;
    try {
      res = await route(req, env, ctx);
    } catch (e) {
      // Never let an unexpected error fall through to a default page without our headers.
      console.error("unhandled", e);
      res = fail(500, "internal_error", "Something went wrong on this Instance.");
    }
    // A ticket in the URL never leaves in a Referer: every answer under /f/ says so, errors and redirects included.
    return new URL(req.url).pathname.startsWith("/f/") ? noReferrer(res) : res;
  },

  /**
   * On the Instance's Cron Triggers (`crons`, hourly by default; none when `crons` is []): purge expired Shares,
   * then delete due bodies. At most 3 purge batches (4 D1
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

/** Repeats a cleanup step while it does a full batch, at most `rounds` times. */
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
    // The card image for one Public Share, under the prefix Access already leaves to the Worker, so a crawler fetches it
    // with no session; a Gated or missing Share answers not-found, exactly like its page. Every Instance response is
    // `no-store` except this one, and the exception is deliberate: fixed bytes, no per-visitor data, and a crawler has
    // to be able to cache the card. It keeps BASE's hardening headers, nosniff included.
    const share = await new Store(env.DB, env.BODIES).viewableVersion(cfg.author, card[1]!, true, null);
    if (!share) return notFound(cfg.language, { signInPath: `/s/${card[1]}` });
    return new Response(ogPoster, {
      headers: { ...BASE, "content-type": OG_IMAGE_TYPE, "cache-control": "public, max-age=31536000, immutable" },
    });
  }


  if (path === "/api" || path.startsWith("/api/")) return handleApi(req, env, ctx, cfg, url);

  return handlePeople(req, env, ctx, cfg, url);
}

async function handlePeople(req: Request, env: Env, ctx: ExecutionContext, cfg: Config, url: URL): Promise<Response> {
  const path = url.pathname;
  const view = VIEW.exec(path);
  if (view && view[1] === "p") {
    // Public paths sit outside the Access gate, so they serve Public Shares only, to anyone.
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
  // Behind the gate, not-found offers the way home to everyone: the page must not tell someone off the
  // Allowlist apart from a Viewer (only the Author's label differs).
  if (!who) return notFound(cfg.language, { home: "viewer" });
  const isAuthor = who === cfg.author;
  const visitor: Visitor = { email: who, isAuthor, origin: url.origin, lang: cfg.language };
  const store = new Store(env.DB, env.BODIES);
  // The same page whatever the reason; the Author's way home is labelled for the Author.
  const lost = () => notFound(cfg.language, { home: isAuthor ? "author" : "viewer" });

  // Only the Author's home lists Shares: a Viewer's never reads them.
  if (path === "/" && req.method === "GET") {
    const erased = url.searchParams.get("erased");
    // The note only for a Share that is gone: a link cannot make the home say a live Share was erased.
    const note = isAuthor && erased !== null && SLUG.test(erased) && !(await store.eraseTarget(cfg.author, erased)) ? { erased } : undefined;
    return html(200, homePage(visitor, isAuthor ? await store.recentShares(cfg.author, HOME_SHARES) : null, note, isAuthor ? await store.viewsBySlug(dayFrom(Date.now(), -30)) : undefined));
  }

  if (view && req.method === "GET") {
    const res = await serveShare(env, cfg, url, "s", view[2]!, !!view[3], who);
    return res === null ? lost() : counted(req, env, ctx, view[2]!, !!view[3], res);
  }

  // Erasing a Share for good (deleted or not): the Author only, from this Instance's own page, like the token form.
  if (path === "/erase") {
    if (!isAuthor || req.method !== "POST") return lost();
    const again = async (status: number, note: HomeNote) => html(status, homePage(visitor, await store.recentShares(cfg.author, HOME_SHARES), note));
    if (!sameOrigin(req, url)) return again(403, { error: "refused" });
    // The form holds a few short fields; anything larger is refused before it is read.
    const form = await readCapped(req, MAX_FORM_BYTES);
    if (form === null) return again(413, { error: "too-large" });
    const fields = new URLSearchParams(form);
    const slug = shareSlug(fields.get("share") ?? "");
    if (slug === null) return again(400, { error: "bad-share" });
    const target = await store.eraseTarget(cfg.author, slug);
    if (!target) return again(404, { error: "no-share" });
    // From the home's form the Author first sees which Share the link names; on the Share's page, its question is that step.
    if (fields.get("confirm") !== "1") return again(200, { confirm: { slug, title: target.title } });
    if (!(await store.eraseShare(cfg.author, slug))) return again(404, { error: "no-share" });
    // The Share's own bodies go while the answer goes out; a failure, or a body published meanwhile, waits for the hourly cleanup.
    ctx.waitUntil(store.eraseBodies(slug, target.keys).catch((e) => console.error("erase cleanup", e)));
    return redirect(`/?erased=${slug}`);
  }

  if (path === "/metrics") {
    // The Author only, like the token page: how often each of this Instance's Shares was opened.
    if (!isAuthor) return lost();
    if (req.method !== "GET") return lost();
    return html(200, metricsPage(visitor, (await store.recentShares(cfg.author, METRICS_SHARES)).shares, await store.viewsBySlug(dayFrom(Date.now(), -30))));
  }

  if (path === "/tokens" || path.startsWith("/tokens/")) {
    if (!isAuthor) return lost();
    if (req.method === "GET" && path === "/tokens") return html(200, tokensPage(visitor, await store.listTokens(cfg.author)));
    if (req.method !== "POST") return lost();
    if (!sameOrigin(req, url)) return html(403, tokensPage(visitor, await store.listTokens(cfg.author), undefined, "refused"));
    if (path === "/tokens") {
      // The form holds one short field; anything larger is refused before it is read.
      const raw = await readCapped(req, MAX_FORM_BYTES);
      if (raw === null) return html(413, tokensPage(visitor, await store.listTokens(cfg.author), undefined, "too-large"));
      const name = (new URLSearchParams(raw).get("name") ?? "").trim();
      // Names are printed in terminals (the CLI, the token command): no control, bidi or zero-width characters,
      // except the zero-width (non-)joiner that emoji sequences and scripts such as Persian need.
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

// What the Author may paste to name a Share: its slug, or its link on either path (the raw link too).
const SHARE_INPUT = /^(?:(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s]+)?\/[sp]\/)?([A-Za-z0-9]{12})(?:\/raw)?\/?(?:[?#]\S*)?$/;
const shareSlug = (input: string): string | null => SHARE_INPUT.exec(input.trim())?.[1] ?? null;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Plain http reaches the Worker when the zone does not force https. Nothing is served in clear: an API request or a
 * change is refused, so a token sent in clear fails instead of working, and a page visit goes to https. Loopback
 * stays http for `wrangler dev`, as in the CLI and ACCESS_TEAM_URL.
 */
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
  // A Share's links and requests never tell other sites which Share they came from.
  "referrer-policy": "no-referrer",
};

// A site's files (plan 009). The document loading them runs in an opaque origin, so every load is cross-origin; the URL
// itself is the permission (a ticket, or a Public Share's), so letting any origin read the answer grants nothing more.
// The sandbox is on every file, so an HTML or SVG file opened on its own is sandboxed too.
const SITE_HEADERS = {
  "content-security-policy": `sandbox ${SHARE_SANDBOX}; frame-ancestors 'self'`,
  "cross-origin-resource-policy": "cross-origin",
  "access-control-allow-origin": "*",
  // A ticket in the URL never leaves in a Referer by default.
  "referrer-policy": "no-referrer",
};

/** The same answer with no-referrer, for every answer under /f/ (see fetch). */
function noReferrer(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("referrer-policy", "no-referrer");
  return new Response(res.body, { status: res.status, headers });
}

/**
 * Where a site Version opens: under a Public Share's own path, or, for a signed-in person, under a ticket sealed for
 * them. A ticket is issued only here, after the Worker verified the person's Access token.
 */
async function siteUrl(cfg: Config, slug: string, n: number, who: string | null): Promise<string | null> {
  if (who === null) return `/p/${slug}/${n}/`;
  const key = await importTicketKey(cfg.ticketKey);
  if (!key) return null;
  return `/f/${await sealTicket(key, cfg.aud, { slug, n, email: who, exp: Date.now() + TICKET_TTL_MS })}/`;
}

/**
 * The viewer page or the raw HTML of a Share, or null when the asker may not see it. `who` is the signed-in person
 * (null on a public path). State is read on every request, so gating a Share again holds from the next one.
 */
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
  // Only the Author, behind the gate, may erase: never on a public path, which needs no sign-in.
  const erase = prefix === "s" && who === cfg.author;
  return html(200, viewerPage(cfg.language, found.share, prefix, n, found.kept, found.share.latest_version, frame, erase, url.origin));
}

/**
 * Counts one opening of a Share's page, in the background, when a browser navigated to it: never for raw bytes, a
 * prefetch or a Share the page did not find. A failed write is logged and never reaches the reader.
 */
function counted(req: Request, env: Env, ctx: ExecutionContext, slug: string, raw: boolean, res: Response): Response {
  if (raw || res.status !== 200) return res;
  if (req.headers.get("sec-fetch-dest") !== "document" || req.headers.has("sec-purpose")) return res;
  const store = new Store(env.DB, env.BODIES);
  ctx.waitUntil(store.countView(slug, dayFrom(Date.now(), 0)).catch((e) => console.error("view count", e)));
  return res;
}

/** One file of a viewable site Version, or null. The path is decoded and checked by the zip's own rules. */
async function serveSiteFile(env: Env, cfg: Config, slug: string, n: number, rest: string, publicOnly: boolean): Promise<Response | null> {
  const path = siteRequestPath(rest);
  if (path === null) return null;
  const store = new Store(env.DB, env.BODIES);
  const file = await store.siteFile(cfg.author, slug, publicOnly, n, path);
  if (!file) return null;
  const bytes = await store.siteBytes(file);
  return bytes === null ? null : stream(bytes, contentTypeFor(path), SITE_HEADERS);
}

/**
 * A Gated site's file, by ticket. Each request checks the seal, the hour, that the person it was issued to is still on
 * the Allowlist, and (in the store) that the Share is live and the Version kept. A navigation with an authentic but
 * expired ticket goes back through the gate to the Share's page; anything else wrong is the same not-found.
 */
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
