#!/usr/bin/env node
// Sets up or updates an Instance on the Operator's own Cloudflare account. Safe to run again.
// Needs Wrangler and Cloudflare's `cf` CLI, both logged in to that account.
// Order (issue #18): domain check, database, migrations, deploy with workers.dev off, Access
// application, deploy with the custom domain on (or workers.dev, without one). The Worker is never reachable before its gate exists, and it
// refuses every gated request on its own if the gate is ever removed.
//
// Usage: pnpm run setup [--config instance.json] [--rotate-ticket-key]
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = join(ROOT, "node_modules/.bin/wrangler");
// /f/* holds a Gated site's files under tickets the Worker checks itself (plan 009): a Share's requests never carry the
// Access cookie, so Access must leave them to the Worker, as it does the API and Public Shares.
// /og.jpg is the card image a crawler fetches; without the bypass, Cloudflare Access answers the unfurl with a login
// redirect and every shared link loses its thumbnail.
const PUBLIC_PATHS = ["/api/*", "/p/*", "/f/*", "/og.jpg"];
// The hourly cleanup of expired Shares (plan 008).
export const CRONS = ["17 * * * *"];

/** The Wrangler config setup writes for one Instance. One file each, so Instances set up from one checkout never share it. */
export const generatedConfig = (inst) => join(ROOT, ".instance", `${inst.name}.wrangler.jsonc`);

export function readInstance(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`Cannot read ${path}: ${e.message}. Copy instance.example.json to instance.json and fill it in.`);
  }
  const email = /^[^\s@,]+@[^\s@,]+$/;
  if (typeof raw.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,52}$/.test(raw.name)) {
    throw new Error("name must be 1 to 53 lowercase letters, digits or '-', starting with a letter or digit.");
  }
  // The landing's Workers (scripts/site-deploy.mjs): an Instance by either name would replace the landing.
  if (raw.name === "htmlgate-site" || raw.name === "htmlgate-site-preview") {
    throw new Error(`name ${raw.name} belongs to the htmlgate landing's Worker. Pick another name.`);
  }
  if (typeof raw.authorEmail !== "string" || !email.test(raw.authorEmail)) throw new Error("authorEmail must be an email address.");
  if (!Array.isArray(raw.allowlist) || !raw.allowlist.every((e) => typeof e === "string" && email.test(e))) {
    throw new Error("allowlist must be a list of email addresses (it may be empty; the Author is always allowed).");
  }
  const hostname = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  const domain = typeof raw.domain === "string" ? raw.domain.trim().toLowerCase() : raw.domain;
  if (domain !== undefined && (typeof domain !== "string" || !hostname.test(domain) || domain.length > 253)) {
    throw new Error("domain must be a hostname such as html.example.com, without https:// or a path.");
  }
  // The language of the Instance's own pages; the Worker refuses any other value, so setup does too.
  const language = raw.language === undefined ? "en" : raw.language;
  if (language !== "en" && language !== "pt-BR") throw new Error('language must be "en" or "pt-BR" (default "en").');
  const expiryDays = raw.expiryDays === undefined ? 30 : raw.expiryDays;
  if (!Number.isSafeInteger(expiryDays) || expiryDays < 0 || expiryDays > 3650) {
    throw new Error("expiryDays must be a whole number of days from 0 (never) to 3650.");
  }
  const author = raw.authorEmail.trim().toLowerCase();
  const allowlist = [...new Set([author, ...raw.allowlist.map((e) => e.trim().toLowerCase())])];
  return { name: raw.name, author, allowlist, domain, language, expiryDays };
}

/** The settings the deployed Worker reads (src/config.ts). */
export const instanceVars = (inst, teamUrl, aud) => ({
  ACCESS_TEAM_URL: teamUrl, ACCESS_AUD: aud, AUTHOR_EMAIL: inst.author, ALLOWLIST: inst.allowlist.join(","), LANGUAGE: inst.language,
  EXPIRY_DAYS: String(inst.expiryDays),
});

export function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" }, ...opts });
  } catch (e) {
    throw new Error(`${cmd} ${args.slice(0, 4).join(" ")} failed:\n${(e.stderr || e.stdout || e.message).toString().slice(0, 2000)}`);
  }
}

export const cf = (...args) => JSON.parse(sh("cf", args));

// `scripts` too: setup.mjs writes the deployed config, and the mutation gate plants violations there.
const DEPLOYED = ["src", "site", "migrations", "packages/cli/src", "scripts"];
const gitStatus = () => {
  const root = sh("git", ["rev-parse", "--show-toplevel"]).trim();
  if (realpathSync(root) !== realpathSync(ROOT)) {
    throw new Error("Git checkout root does not match this project. Use a Git clone or registered worktree rooted at the project directory.");
  }
  return sh("git", ["status", "--porcelain", "--untracked-files=all", "--", ...DEPLOYED]);
};

/** A deploy ships the working tree, so it must be what is committed: an interrupted `pnpm run mutate`, say, leaves a violation planted. */
export function checkCleanTree(status = gitStatus) {
  const dirty = status().trim();
  if (dirty) throw new Error(`These files have uncommitted changes. Commit or restore them, then deploy:\n${dirty}`);
}

/** Who Wrangler is logged in as. Logged out, `whoami --json` still prints its JSON but exits 1, so read stdout either way. */
export function wranglerWho(env = process.env) {
  let out;
  try {
    out = execFileSync(WRANGLER, ["whoami", "--json"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...env, CI: "1" } });
  } catch (e) {
    out = String(e.stdout ?? "");
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new Error("Wrangler could not say which account it is logged in to. Run `pnpm exec wrangler whoami` to see why.");
  }
}

/**
 * The one account both tools act on. Wrangler deploys the Worker and cf configures its Access application: on two
 * accounts the Worker would sit behind no gate of its own. cf gives no way to tell which of several accounts a
 * command uses, so its login must reach exactly one.
 */
export function checkSameAccount(wranglerWho, cfWho, env) {
  if (!wranglerWho?.loggedIn) throw new Error("Wrangler is not logged in. Run `pnpm exec wrangler login`.");
  if (!cfWho?.tokenValid) throw new Error("cf is not logged in. Run `cf auth login`.");
  const w = Array.isArray(wranglerWho.accounts) ? wranglerWho.accounts : [];
  const c = Array.isArray(cfWho.accounts) ? cfWho.accounts : [];
  let mine;
  if (env.CLOUDFLARE_ACCOUNT_ID) {
    mine = w.find((a) => a.id === env.CLOUDFLARE_ACCOUNT_ID);
    if (!mine && !w.length) throw new Error("Wrangler's login lists no accounts, so setup cannot check CLOUDFLARE_ACCOUNT_ID. Give its API token Account Settings: Read.");
    if (!mine) throw new Error("CLOUDFLARE_ACCOUNT_ID names an account Wrangler's login cannot reach.");
  } else if (w.length === 1) {
    mine = w[0];
  } else {
    throw new Error(w.length ? "Wrangler's login reaches several accounts. Set CLOUDFLARE_ACCOUNT_ID to the one for this Instance." : "Wrangler's login reaches no account.");
  }
  if (c.length !== 1) {
    throw new Error(c.length
      ? "cf's login reaches several accounts, and setup cannot tell which one cf would act on. Use a cf login or token scoped to one account (`cf auth create`, then `cf auth activate`)."
      : "cf's login reaches no account.");
  }
  if (c[0].id !== mine.id) throw new Error(`Wrangler would use the account "${mine.name}" and cf the account "${c[0].name}". Log both in to the same account.`);
  return mine.id;
}

/** The R2 bucket that holds the Instance's Share bodies. */
export const bodiesBucket = (inst) => `${inst.name}-bodies`;

// `open: false` deploys a Worker that answers at no hostname; only the gated deploy opens it, at the domain if there is
// one and otherwise at workers.dev. With a domain, workers.dev stays off: it has no WAF and no Always Use HTTPS.
export function workerConfig(inst, db, { open, vars }) {
  return {
    name: inst.name,
    main: "../src/index.ts",
    compatibility_date: "2026-09-29",
    workers_dev: open && !inst.domain,
    ...(open && inst.domain ? { routes: [{ pattern: inst.domain, custom_domain: true }] } : {}),
    preview_urls: false,
    d1_databases: [{ binding: "DB", database_name: db.name, database_id: db.uuid, migrations_dir: "../migrations" }],
    r2_buckets: [{ binding: "BODIES", bucket_name: bodiesBucket(inst) }],
    ratelimits: [{ name: "WRITE_LIMIT", namespace_id: "1001", simple: { limit: 60, period: 60 } }],
    triggers: { crons: CRONS },
    // The same rule as wrangler.jsonc: the card image is bundled from the landing's poster.
    rules: [{ type: "Data", globs: ["**/*.jpg"], fallthrough: true }],
    // The Worker's own logs (only unexpected errors), but no record of every request and no traces (docs/privacy.md).
    observability: { enabled: true, logs: { enabled: true, invocation_logs: false }, traces: { enabled: false } },
    vars: { ...vars, HTMLGATE_INSTANCE: inst.name },
  };
}

/** The hostnames the gated deploy answers at, from instance.json and what `wrangler deploy` printed. */
export function deploymentUrls(inst, output) {
  const dev = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(output)?.[0];
  if (inst.domain) {
    if (dev) throw new Error(`Deployed, but Wrangler printed ${dev}: workers.dev is still on. Turn it off in the dashboard (Workers, ${inst.name}, Settings, Domains & Routes) and run setup again.`);
    return [`https://${inst.domain}`];
  }
  if (!dev) throw new Error("Deployed, but Wrangler printed no workers.dev URL.");
  return [dev];
}

function writeConfig(inst, db, opts) {
  const file = generatedConfig(inst);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "// Generated by scripts/setup.mjs. Do not edit; do not commit.\n" + JSON.stringify(workerConfig(inst, db, opts), null, 2) + "\n");
}

// cf pages silently, so read every page until an empty one. The cap stops a CLI that ignores --page.
export function listWorkers(cf) {
  const all = [];
  for (let page = 1; page <= 1000; page++) {
    const batch = cf("workers", "list", "--per-page", "100", "--page", String(page));
    if (!Array.isArray(batch)) throw new Error("cf returned no Worker list.");
    if (batch.length === 0) return all;
    all.push(...batch);
  }
  throw new Error("cf kept returning Workers past page 1000.");
}

// Access lists page silently too. A partial list cannot prove that a name or destination is free.
function listApplications() {
  const all = [];
  for (let page = 1; page <= 1000; page++) {
    const batch = cf("zero-trust", "access", "applications", "list", "--per-page", "1000", "--page", String(page));
    if (!Array.isArray(batch)) throw new Error("cf returned no Access application list.");
    if (!batch.length) return all;
    all.push(...batch);
  }
  throw new Error("cf kept returning Access applications past page 1000.");
}

// cf omits the cursor, so advance by name and require an empty terminal page.
function listBuckets() {
  const all = [];
  let after = "";
  for (let page = 1; page <= 1000; page++) {
    const buckets = cf("r2", "buckets", "list", "--per-page", "1000", "--order", "name", "--direction", "asc", ...(after ? ["--start-after", after] : []))?.buckets;
    if (!Array.isArray(buckets) || buckets.some((b) => !b || typeof b.name !== "string")) throw new Error("Malformed R2 bucket list.");
    if (!buckets.length) return all;
    for (const bucket of buckets) {
      if (bucket.name <= after) throw new Error("R2 bucket names are ambiguous or not advancing.");
      after = bucket.name;
    }
    all.push(...buckets);
  }
  throw new Error("cf kept returning R2 buckets past page 1000.");
}

/** A database name alone is not ownership. Inspect the active deployment, including gradual rollouts. */
function checkOwnership(inst, db, workers, apps) {
  const named = (items, name, what) => {
    if (items.some((item) => !item || typeof item.name !== "string" || !item.name || typeof item.id !== "string" || !item.id)
      || new Set(items.map((item) => item.id)).size !== items.length) throw new Error(`Malformed or ambiguous ${what} list; cannot establish Instance ownership.`);
    const matches = items.filter((item) => item.name === name);
    if (matches.length > 1) throw new Error(`Ambiguous ${what} ownership for ${inst.name}.`);
    return matches[0];
  };
  const worker = named(workers, inst.name, "Worker");
  const app = named(apps, `htmlgate: ${inst.name}`, "Access application");
  const validDestinations = apps.every((a) => !Object.hasOwn(a, "destinations") || (Array.isArray(a.destinations) && a.destinations.every((d) => {
    if (!d || typeof d !== "object" || Array.isArray(d)) return false;
    if (d.type === "worker" || d.type === "preview_worker") return typeof d.worker_id === "string" && d.worker_id.trim().length > 0;
    if (Object.hasOwn(d, "worker_id")) return false;
    if (d.type === undefined || d.type === "public") return d.uri === undefined || typeof d.uri === "string";
    return ["private", "via_mcp_server_portal", "all_workers", "all_preview_workers"].includes(d.type);
  })));
  if (!validDestinations) throw new Error("Malformed Access destinations; cannot establish Instance ownership.");
  if (!worker) {
    if (app) throw new Error("An Access application exists without its Worker; cannot establish Instance ownership.");
    return { worker, app };
  }
  if (!db?.uuid) throw new Error(`Worker ${inst.name} exists without this Instance's database; pick another name.`);
  // Exact Worker destinations override account-wide policies; preview-only destinations have their own scope.
  const attached = apps.filter((a) => Array.isArray(a.destinations) && a.destinations.some((d) => d?.type === "worker" && d.worker_id === worker.id));
  if (app) {
    if (app.type !== "self_hosted" || !Array.isArray(app.destinations) || app.destinations.length !== 1
      || app.destinations[0]?.type !== "worker" || app.destinations[0].worker_id !== worker.id
      || attached.length !== 1 || attached[0].id !== app.id) throw new Error("Access application does not uniquely belong to this Instance's Worker.");
  } else if (attached.length) throw new Error("Another Access application owns this Worker.");

  const active = cf("workers", "deployments", "list", "--worker", inst.name, "--page", "1", "--per-page", "1");
  const versions = active?.deployments?.[0]?.versions;
  if (!Array.isArray(active?.deployments) || active.deployments.length !== 1 || !Array.isArray(versions) || !versions.length
    || versions.some((v) => !v || typeof v.version_id !== "string" || !v.version_id || typeof v.percentage !== "number" || !Number.isFinite(v.percentage) || v.percentage < 0 || v.percentage > 100)
    || new Set(versions.map((v) => v.version_id)).size !== versions.length
    || Math.abs(versions.reduce((total, v) => total + v.percentage, 0) - 100) > 0.000001) throw new Error("Missing or malformed active deployment; cannot establish Instance ownership.");
  for (const version of versions.filter((v) => v.percentage > 0)) {
    const detail = JSON.parse(sh(WRANGLER, ["versions", "view", version.version_id, "--name", inst.name, "--json"]));
    const bindings = detail?.resources?.bindings;
    if (!Array.isArray(bindings) || bindings.some((b) => !b || typeof b.name !== "string" || typeof b.type !== "string")) throw new Error("Missing or malformed active Worker bindings.");
    const one = (name) => {
      const matches = bindings.filter((b) => b.name === name);
      return matches.length === 1 ? matches[0] : undefined;
    };
    const database = one("DB");
    const bodies = one("BODIES");
    if (database?.type !== "d1" || database.id !== db.uuid || bodies?.type !== "r2_bucket" || bodies.bucket_name !== bodiesBucket(inst)) throw new Error("Active Worker bindings do not belong to this Instance.");
    if (!app) {
      const marker = one("HTMLGATE_INSTANCE");
      if (marker?.type !== "plain_text" || marker.text !== inst.name
        || bindings.some((b) => ["ACCESS_TEAM_URL", "ACCESS_AUD", "AUTHOR_EMAIL", "ALLOWLIST"].includes(b.name))) throw new Error("Worker is not a marked closed htmlgate bootstrap; cannot establish Instance ownership.");
    }
  }
  return { worker, app };
}

// Wrangler runs here without a terminal, so it would replace an existing DNS record or move another
// Worker's Custom Domain without asking. This refuses any domain the Instance does not already own,
// before setup writes anything. `cf` is injected so the tests can stand in for the CLI.
// A Custom Domain's records are address records pointing at its Worker, so only an address record on the
// hostname can be replaced by it or stand in its way; mail records (MX, TXT, such as Email Routing's) stay beside it.
const ADDRESS_TYPES = new Set(["A", "AAAA", "CNAME"]);

export function checkDomain(inst, cf) {
  const { domain } = inst;
  if (!domain) return;
  // Every answer must be a list: anything else fails closed with a clear message.
  const list = (what, ...args) => {
    const out = cf(...args);
    if (!Array.isArray(out)) throw new Error(`cf returned no ${what} list; cannot check domain ${domain}.`);
    return out;
  };
  const labels = domain.split(".");
  let zone;
  for (let i = 0; i < labels.length - 1 && !zone; i++) {
    const name = labels.slice(i).join(".");
    zone = list("zone", "zones", "list", "--name", name).find((z) => z.name === name && z.status === "active");
  }
  if (!zone) throw new Error(`domain ${domain}: no active zone on this Cloudflare account covers it. Add the zone first.`);

  // A Worker's Custom Domain ids are the `origin_worker_id` of the DNS records it manages.
  const workers = listWorkers(cf);
  const customDomains = (w) => (w.references?.domains ?? []).filter((d) => d.hostname === domain);
  const other = workers.find((w) => w.name !== inst.name && customDomains(w).length > 0);
  if (other) throw new Error(`domain ${domain} is a Custom Domain of the Worker ${other.name}. Setup will not move it.`);
  const ourDomainIds = new Set(workers.filter((w) => w.name === inst.name).flatMap(customDomains).map((d) => d.id));

  const records = list("DNS record", "dns", "records", "list", "-z", zone.id, "--name", domain, "--per-page", "100");
  const foreign = records.find((r) => ADDRESS_TYPES.has(r.type) && !ourDomainIds.has(r.meta?.origin_worker_id));
  if (foreign) throw new Error(`domain ${domain} has a ${foreign.type} record that setup would replace. Remove it or pick another hostname.`);
}

/** True when a signed-out request to `host` was sent to this team's sign-in for this Access application. */
export function isGateRedirect(status, location, { teamUrl, aud, host }) {
  if (status !== 302 || !location || !URL.canParse(location)) return false;
  const to = new URL(location);
  if (to.origin !== teamUrl) return false;
  if (to.searchParams.get("kid") !== aud) return false;
  return to.pathname === `/cdn-cgi/access/login/${host}`;
}

// Polls because a freshly enabled workers.dev route answers 404 for a few seconds (issue #18), and a
// new custom domain needs its DNS record and certificate first. Every request ends by the deadline,
// so one hostname never takes longer than its budget plus one pause.
export async function gated(url, gate, { budgetMs = 180_000, pauseMs = 2000 } = {}) {
  const until = Date.now() + budgetMs;
  let home, api, files, ok = false;
  // A ticket path with no valid ticket must reach the Worker (its 404), not Access's sign-in.
  const done = () => ok && api.status === 401 && files.status === 404;
  for (let i = 0; !done(); i++) {
    if (i) await new Promise((r) => setTimeout(r, pauseMs));
    const left = until - Date.now();
    if (left <= 0) break;
    try {
      const signal = AbortSignal.timeout(Math.min(10_000, left));
      home = await fetch(url + "/", { redirect: "manual", signal });
      api = await fetch(url + "/api/shares", { redirect: "manual", signal });
      files = await fetch(url + "/f/" + "A".repeat(64) + "/", { redirect: "manual", signal });
    } catch {
      ok = false;
      continue;
    }
    ok = isGateRedirect(home.status, home.headers.get("location"), { ...gate, host: new URL(url).host });
  }
  console.log(`  ${url}: ${done() ? "ok" : "NOT GATED"}: / answers ${home?.status ?? "nothing"}; /api/shares answers ${api?.status ?? "nothing"} (401 expected); /f/ answers ${files?.status ?? "nothing"} (404 expected)`);
  return done();
}

export function accessApp(inst, workerId) {
  return {
    type: "self_hosted",
    name: `htmlgate: ${inst.name}`,
    session_duration: "24h",
    // Cloudflare's default is SameSite=None: another site could make a signed-in browser send the cookie. Lax still
    // goes with a top-level link to a Share. The token page's Fetch Metadata check stays the deciding defence.
    same_site_cookie_attribute: "lax",
    http_only_cookie_attribute: true,
    app_launcher_visible: false,
    destinations: [{ type: "worker", worker_id: workerId, overrides: PUBLIC_PATHS.map((p) => ({ behavior: "public", path_pattern: p })) }],
    // Named people only. Never a domain, a login method or Everyone: an empty list would admit nobody.
    policies: [{ name: `htmlgate: ${inst.name} allowlist`, decision: "allow", include: inst.allowlist.map((email) => ({ email: { email } })) }],
  };
}

/** The text after `wrangler`'s failure that names Cloudflare's "R2 is not enabled" answer. */
export const r2NotEnabled = (message) => /\b10042\b|enable R2/i.test(message);

/**
 * The Worker secret that seals tickets (plan 009): 32 random bytes, made here and handed to Wrangler on stdin, never
 * printed or written to disk. Kept on later runs, so open tickets stay valid; `--rotate-ticket-key` replaces it, which
 * ends every ticket at once.
 */
function ensureTicketKey(config, rotate) {
  const names = JSON.parse(sh(WRANGLER, ["secret", "list", "-c", config, "--format", "json"])).map((s) => s.name);
  if (names.includes("TICKET_KEY") && !rotate) return "kept";
  execFileSync(WRANGLER, ["secret", "put", "TICKET_KEY", "-c", config], {
    cwd: ROOT, input: randomBytes(32).toString("base64url"), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CI: "1" },
  });
  return names.includes("TICKET_KEY") ? "replaced" : "created";
}

async function main() {
  const at = process.argv.indexOf("--config");
  const inst = readInstance(resolve(ROOT, at > 0 ? process.argv[at + 1] : "instance.json"));
  const step = (s) => console.log(`- ${s}`);

  step("checking that the source is committed");
  checkCleanTree();
  step("checking the Cloudflare logins");
  checkSameAccount(wranglerWho(), cf("auth", "whoami"), process.env);

  const org = cf("zero-trust", "organizations", "list");
  const authDomain = (Array.isArray(org) ? org[0] : org)?.auth_domain;
  if (!authDomain) throw new Error("This account has no Zero Trust organization. Create one in the dashboard (Zero Trust), then run setup again.");
  const teamUrl = `https://${authDomain}`;

  if (inst.domain) {
    step(`checking that ${inst.domain} is free or already this Instance's`);
    checkDomain(inst, cf);
  }

  step("finding or creating the database");
  const dbName = `${inst.name}-db`;
  const findDb = () => {
    const list = JSON.parse(sh(WRANGLER, ["d1", "list", "--json"]));
    if (!Array.isArray(list) || list.some((d) => !d || typeof d.name !== "string" || typeof d.uuid !== "string" || !d.uuid)) throw new Error("Malformed database list.");
    const matches = list.filter((d) => d.name === dbName);
    if (matches.length > 1) throw new Error("Ambiguous Instance database name.");
    return matches[0];
  };
  let db = findDb();
  const freshDb = !db;
  step("checking existing Instance ownership before any remote write");
  const owned = checkOwnership(inst, db, listWorkers(cf), listApplications());

  // Share bodies live in R2. An account without an R2 subscription gets error 10042 here.
  step("finding or creating the R2 bucket");
  const bucket = bodiesBucket(inst);
  try {
    const buckets = listBuckets();
    const matches = buckets.filter((b) => b.name === bucket);
    if (matches.length > 1) throw new Error("Ambiguous R2 bucket name.");
    if (matches.length) {
      const managed = cf("r2", "buckets", "domains", "managed", "list", "--bucket-name", bucket);
      const custom = cf("r2", "buckets", "domains", "custom", "list", "--bucket-name", bucket);
      if (managed?.enabled !== false || !Array.isArray(custom?.domains) || custom.domains.some((d) => !d || d.enabled !== false)) throw new Error("The reused R2 bucket is public or its privacy is unknown. Disable every public domain before setup.");
    }
    if (freshDb) {
      sh(WRANGLER, ["d1", "create", dbName]);
      db = findDb();
    }
    if (!db?.uuid) throw new Error(`Could not find the database ${dbName} after creating it.`);
    db = { name: dbName, uuid: db.uuid };
    if (!matches.length) sh(WRANGLER, ["r2", "bucket", "create", bucket]);
  } catch (e) {
    if (!r2NotEnabled(e.message)) throw e;
    throw new Error("R2 is not enabled on this account. In the Cloudflare dashboard open Storage & databases, R2, Overview, and "
      + "complete the checkout to add the R2 subscription (it includes a free monthly allowance), then run setup again.");
  }

  step("applying migrations");
  const config = generatedConfig(inst);
  writeConfig(inst, db, { open: false, vars: {} });
  sh(WRANGLER, ["d1", "migrations", "apply", dbName, "--remote", "-c", config]);

  const findWorker = () => listWorkers(cf).find((w) => w.name === inst.name);
  const existing = owned.app;
  let worker = owned.worker;
  if (!existing || !worker) {
    // First setup: deploy unreachable (workers.dev off) and without its gate settings, so it refuses
    // everything, then create the gate, then open the route. An update skips this and never goes dark.
    step("first deploy, with workers.dev off");
    sh(WRANGLER, ["deploy", "-c", config]);
    worker = findWorker();
  }
  if (!worker?.id) throw new Error(`Could not find the Worker ${inst.name} after deploying it.`);

  step("checking the ticket key");
  console.log(`  ${ensureTicketKey(config, process.argv.includes("--rotate-ticket-key"))}`);

  step(existing ? "updating the Access application" : "creating the Access application");
  const body = JSON.stringify(accessApp(inst, worker.id));
  const app = existing
    ? cf("zero-trust", "access", "applications", "update", existing.id, "--body", body)
    : cf("zero-trust", "access", "applications", "create", "--body", body);
  if (!app.aud) throw new Error("The Access application has no audience tag.");

  step(inst.domain ? `deploying with ${inst.domain} on and workers.dev off` : "deploying with workers.dev on");
  writeConfig(inst, db, {
    open: true,
    vars: instanceVars(inst, teamUrl, app.aud),
  });
  const urls = deploymentUrls(inst, sh(WRANGLER, ["deploy", "-c", config]));

  step("checking the gate");
  const results = [];
  for (const u of urls) results.push(await gated(u, { teamUrl, aud: app.aud }));
  if (results.includes(false)) {
    throw new Error("The Instance is not behind its gate yet. Access, DNS and certificates can take a while; run setup again. It refuses gated requests on its own meanwhile.");
  }
  console.log(`\nInstance ready: ${urls.at(-1)}\nNext: pnpm run token create <name> for your first Publisher.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`setup failed: ${e.message}`);
    process.exit(1);
  });
}
