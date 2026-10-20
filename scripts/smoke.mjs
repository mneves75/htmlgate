#!/usr/bin/env node
// Live checks against a deployed Instance (issue #17). Needs a token in HTMLGATE_TOKEN.
// It publishes test Shares that expire within minutes, and soft-deletes them at the end; the hourly cleanup then
// deletes their bodies.
// Usage: HTMLGATE_TOKEN=hg_... pnpm run smoke https://<the Instance's domain, or name.subdomain.workers.dev without one>
import { writeZip } from "../packages/cli/src/zip.ts";
const base = (process.argv[2] ?? "").replace(/\/+$/, "");
const token = process.env.HTMLGATE_TOKEN;
if (!/^https:\/\/[a-z0-9.-]+$/.test(base) || !token) {
  console.error("Usage: HTMLGATE_TOKEN=hg_... pnpm run smoke https://<instance-host>");
  process.exit(2);
}

const SANDBOX = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'";
const results = [];
const created = [];

async function check(name, fn) {
  try {
    await fn();
    results.push(["PASS", name]);
  } catch (e) {
    results.push(["FAIL", `${name}: ${e.message}`]);
  }
}

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

// A rate limiting rule as strict as 20 requests per 10 s per IP on /p/, /f/ and /api/ (docs/operator.md) refuses
// requests sent back to back, so every request waits until GAP_MS after the previous one.
const GAP_MS = Number(process.env.HTMLGATE_LIVE_GAP_MS ?? 600);
let last = 0;
async function paced(url, init) {
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
}

const get = (path, init = {}) => paced(base + path, { redirect: "manual", ...init });
async function api(method, path, body) {
  const res = await paced(base + path, {
    method,
    redirect: "manual",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "htmlgate-smoke" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}
const page = (s) => `<!doctype html><title>smoke</title><p>${s}</p>`;

/** Records a created Share for cleanup, only when its slug is one: the cleanup puts it in a URL with the token. */
function own(slug) {
  must(typeof slug === "string" && /^[A-Za-z0-9]{12}$/.test(slug), "publish: invalid slug in the created Share response");
  created.push(slug);
}

// Smoke Shares expire soon, so the cleanup deletes their bodies instead of a soft delete keeping them.
const soon = () => Date.now() + 10 * 60 * 1000;

async function publish(html = page("smoke")) {
  const r = await api("POST", "/api/shares", { html, title: "smoke test", metadata: { smoke: "1" }, expires_at: soon() });
  must(r.status === 201, `publish answered ${r.status} ${JSON.stringify(r.json)}`);
  own(r.json?.slug);
  return r.json;
}

try {
  await check("a signed-out request to a gated route is sent to the Access sign-in", async () => {
    for (const p of ["/", "/s/AAAAAAAAAAAA", "/s/AAAAAAAAAAAA/raw", "/tokens"]) {
      const r = await get(p);
      const location = r.headers.get("location");
      const to = location && URL.canParse(location) ? new URL(location) : undefined;
      must(r.status === 302 && to?.protocol === "https:" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(to.hostname)
        && !to.username && !to.password && !to.port, `${p} answered ${r.status}`);
    }
  });

  await check("the API without a token answers 401 with the error envelope", async () => {
    const r = await get("/api/shares");
    must(r.status === 401, `answered ${r.status}`);
    must((await r.json()).error.code === "unauthorized", "wrong code");
  });

  // Never with the token. The Worker refuses the API over http (403) and sends a page to https (301); with the zone's
  // Always Use HTTPS on, Cloudflare answers 301 for both before the Worker runs.
  await check("plain http serves nothing: a page goes to https, the API is refused or goes to https", async () => {
    const insecure = base.replace(/^https:/, "http:");
    for (const p of ["/p/AAAAAAAAAAAA", "/api/shares"]) {
      const r = await paced(insecure + p, { redirect: "manual" });
      const to = r.headers.get("location");
      const upgraded = r.status === 301 && to === base + p;
      must(upgraded || (p === "/api/shares" && r.status === 403), `${p} over http answered ${r.status}${to ? ` to ${to}` : ""}`);
    }
  });

  let gated;
  await check("publishing makes a gated Share at a /s/ URL", async () => {
    gated = await publish();
    must(gated.public === false && gated.url === `${base}/s/${gated.slug}`, JSON.stringify(gated));
  });

  await check("on /p/, a Gated Share answers exactly like a missing one, even with a forged Access header", async () => {
    const a = await get(`/p/${gated.slug}`, { headers: { "cf-access-jwt-assertion": "a.b.c" } });
    const b = await get("/p/ZZZZZZZZZZZZ");
    const ta = (await a.text()).replaceAll(gated.slug, "S");
    const tb = (await b.text()).replaceAll("ZZZZZZZZZZZZ", "S");
    must(a.status === 404 && b.status === 404, `${a.status} ${b.status}`);
    must(ta === tb, "bodies differ");
    must(a.headers.get("content-security-policy") === b.headers.get("content-security-policy"), "CSP differs");
  });

  // A crawler has no session, so an unfurl of a Public Share fetches the card image without one. It lives under /p/,
  // which the Access application leaves public: if that ever changes, every shared link loses its thumbnail while the
  // pages themselves still answer.
  await check("a card image answers a crawler only while the Share is public", async () => {
    must((await paced(base + `/p/${gated.slug}/card.jpg`, { headers: { "user-agent": "Twitterbot/1.0" } })).status === 404, "a gated Share served its image");
    must((await api("POST", `/api/shares/${gated.slug}/visibility`, { public: true })).status === 200, "visibility on failed");
    try {
      const r = await paced(base + `/p/${gated.slug}/card.jpg`, { redirect: "manual", headers: { "user-agent": "Twitterbot/1.0" } });
      must(r.status === 200, `a public Share answered ${r.status}`);
      must((r.headers.get("content-type") ?? "") === "image/jpeg", `content-type ${r.headers.get("content-type")}`);
      must((await r.arrayBuffer()).byteLength > 1024, "the body is not the poster");
    } finally {
      await api("POST", `/api/shares/${gated.slug}/visibility`, { public: false });
    }
  });

  await check("making a Share public opens /p/ with the isolation headers, and gating it again closes it on the next request", async () => {
    must((await api("POST", `/api/shares/${gated.slug}/visibility`, { public: true })).status === 200, "visibility on failed");
    const v = await get(`/p/${gated.slug}`);
    must(v.status === 200, `viewer answered ${v.status}`);
    const raw = await get(`/p/${gated.slug}/raw`);
    must(raw.status === 200, `raw answered ${raw.status}`);
    must(raw.headers.get("content-security-policy") === SANDBOX, `CSP was ${raw.headers.get("content-security-policy")}`);
    must(raw.headers.get("cache-control") === "no-store", `cache-control was ${raw.headers.get("cache-control")}`);
    must(raw.headers.get("x-content-type-options") === "nosniff", "no nosniff");
    must(raw.headers.get("cross-origin-resource-policy") === "same-origin", "no CORP");
    must((await raw.text()) === page("smoke"), "raw body differs");
    must((await get(`/P/${gated.slug}`)).status === 404, "upper-case path was served");
    must((await api("POST", `/api/shares/${gated.slug}/visibility`, { public: false })).status === 200, "visibility off failed");
    must((await get(`/p/${gated.slug}`)).status === 404, "still served after gating again");
    must((await get(`/p/${gated.slug}/raw`)).status === 404, "raw still served after gating again");
  });

  await check("a Share published without a date expires the Instance's default number of days on, and a date can be set", async () => {
    const onboard = await (await get("/api/onboard")).json();
    const days = onboard.expiry?.default_days;
    must(Number.isInteger(days), `onboard has no expiry default: ${JSON.stringify(onboard.expiry)}`);
    const r = await api("POST", "/api/shares", { html: page("default expiry"), title: "smoke test", metadata: { smoke: "1" } });
    must(r.status === 201, `publish answered ${r.status}`);
    own(r.json?.slug);
    const expected = days === 0 ? null : Date.now() + days * 86_400_000;
    must(expected === null ? r.json.expires_at === null : Math.abs(r.json.expires_at - expected) < 120_000, `expires_at ${r.json.expires_at}, expected about ${expected}`);
    const set = await api("PATCH", `/api/shares/${r.json.slug}`, { expires_at: soon() });
    must(set.status === 200 && Math.abs(set.json.expires_at - soon()) < 120_000, `PATCH expires_at answered ${set.status}`);
  });

  await check("a site publishes from a zip and its Public files carry the sandbox and no-referrer", async () => {
    const enc = new TextEncoder();
    const zip = writeZip([
      { path: "index.html", data: enc.encode('<!doctype html><title>smoke site</title><link rel="stylesheet" href="css/s.css"><p>site</p>') },
      { path: "css/s.css", data: enc.encode("p{color:rgb(1,2,3)}") },
    ]);
    const res = await paced(`${base}/api/shares?title=smoke%20site&metadata.smoke=1&expires_at=${soon()}`, {
      method: "POST", redirect: "manual", body: zip,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/zip", "user-agent": "htmlgate-smoke" },
    });
    const d = await res.json();
    must(res.status === 201, `site publish answered ${res.status} ${JSON.stringify(d)}`);
    own(d?.slug);
    must((await get(`/p/${d.slug}/1/`)).status === 404, "a Gated site's files were served on /p/");
    must((await api("POST", `/api/shares/${d.slug}/visibility`, { public: true })).status === 200, "visibility on failed");
    const css = await get(`/p/${d.slug}/1/css/s.css`);
    must(css.status === 200 && (await css.text()) === "p{color:rgb(1,2,3)}", `stylesheet answered ${css.status}`);
    must(css.headers.get("content-security-policy") === SANDBOX, `CSP was ${css.headers.get("content-security-policy")}`);
    must(css.headers.get("referrer-policy") === "no-referrer", "no no-referrer");
    must(css.headers.get("cache-control") === "no-store", "not no-store");
    const raw = await get(`/p/${d.slug}/raw`);
    must(raw.status === 303 && raw.headers.get("location") === `/p/${d.slug}/1/`, `raw answered ${raw.status} to ${raw.headers.get("location")}`);
    const back = await paced(`${base}/api/shares/${d.slug}/versions/1/zip`, { headers: { authorization: `Bearer ${token}` } });
    must(back.status === 200 && Buffer.from(await back.arrayBuffer()).equals(Buffer.from(zip)), `zip download answered ${back.status}`);
  });

  await check("a ticket path reaches the Worker, not Access, and a bad ticket is a plain not-found", async () => {
    const r = await get("/f/" + "A".repeat(64) + "/");
    must(r.status === 404, `answered ${r.status} to ${r.headers.get("location")}`);
    must(r.headers.get("referrer-policy") === "no-referrer", "no no-referrer");
  });

  await check("a 2 MiB body is stored in R2 and read back whole", async () => {
    const shell = page("");
    const html = shell.replace("<p></p>", "<p>" + "x".repeat(2 * 1024 * 1024 - shell.length) + "</p>");
    const d = await publish(html);
    const v = await api("GET", `/api/shares/${d.slug}/versions/1`);
    must(v.status === 200 && v.json.size === 2 * 1024 * 1024 && v.json.html === html, `read back ${v.status} size ${v.json?.size}`);
    const over = await api("POST", "/api/shares", { html: html + "x", title: "too big" });
    must(over.status === 413 && over.json.error.code === "html_too_large", `over-size answered ${over.status}`);
  });

} finally {
  for (const slug of created) {
    await check(`cleanup ${slug}`, async () => {
      const r = await api("DELETE", `/api/shares/${slug}`);
      must(r.status === 204, `HTTP ${r.status}`);
    });
  }
}

for (const [state, name] of results) console.log(`${state}  ${name}`);
const failed = results.filter(([s]) => s === "FAIL").length;
console.log(failed ? `\n${failed} of ${results.length} checks failed.` : `\nAll ${results.length} live checks passed on ${base}.`);
process.exit(failed ? 1 : 0);
